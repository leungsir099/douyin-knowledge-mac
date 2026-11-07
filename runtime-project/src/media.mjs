import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { lookup as dnsLookup } from "node:dns/promises";
import { spawn } from "node:child_process";

function isPublicAddress(address) {
  const normalized = String(address || "").trim().replace(/^\[|\]$/gu, "").split("%")[0].toLowerCase();
  const family = net.isIP(normalized);
  if (family === 4) {
    const p = normalized.split(".").map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b, c] = p;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && [0, 2].includes(c)) return false;
    if (a === 198 && [18, 19].includes(b)) {
      // 198.18.0.0/15 是基准测试保留段，也是 Clash/Surge 等代理工具 fake-ip 模式的虚拟地址段。
      // 国内用户普遍开代理，此时抖音 CDN 域名会解析成这个段；一刀切拦截会让所有视频下载失败
      // （实机出现过 80 个视频全部报 "media URL resolved to a non-public address"）。
      // 默认放行（流量由代理转发），可用 DOK_BLOCK_FAKE_IP=1 恢复严格拦截。
      return process.env.DOK_BLOCK_FAKE_IP !== "1";
    }
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("::ffff:")) return false;
    if (/^(?:fc|fd|fe[89ab]|ff)/u.test(normalized)) return false;
    return !normalized.startsWith("2001:db8");
  }
  return false;
}

export async function validatePublicUrl(value, resolveHostname = dnsLookup) {
  const parsed = new URL(String(value || ""));
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("media URL must be credential-free HTTP(S)");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("media URL host must be public");
  }
  if (net.isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error("media URL resolved to a non-public address");
    return parsed;
  }
  const records = await resolveHostname(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw new Error("media URL resolved to a non-public address");
  }
  return parsed;
}

export async function downloadMedia(url, target, {
  timeoutMs = 120000,
  maxBytes = 512 * 1024 * 1024,
  fetchImpl = fetch,
} = {}) {
  const parsed = await validatePublicUrl(url);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const part = target + ".part";
  await fsp.rm(part, { force: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("media download timed out")), timeoutMs);
  try {
    let current = parsed;
    let response = null;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      response = await fetchImpl(current.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "referer": "https://www.douyin.com/",
          "accept": "*/*",
        },
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      await response.body?.cancel?.();
      if (!location || redirects === 3) throw new Error("media redirect limit exceeded");
      current = await validatePublicUrl(new URL(location, current).href);
      // 放宽CDN白名单：抖音返回的播放地址全部允许，避免新CDN域名被误拦截
    }
    if (!response) throw new Error("media download returned no response");
    if (!response.ok) throw new Error(`media download failed with HTTP ${response.status}`);
    const finalUrl = await validatePublicUrl(response.url || parsed.href);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("media download exceeds maximum size");
    const handle = await fsp.open(part, "wx");
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) throw new Error("media download exceeds maximum size");
        await handle.write(buffer);
      }
    } finally {
      await handle.close();
    }
    if (bytes < 1024) throw new Error("downloaded media is unexpectedly small");
    await fsp.rename(part, target);
    return { bytes };
  } finally {
    clearTimeout(timeout);
    await fsp.rm(part, { force: true });
  }
}

function approvedDouyinHost(hostname) {
  return /(?:^|\.)(?:[^.]*douyin[^.]*|[^.]*byte[^.]*|pstatp|snssdk|zijieapi)\./iu.test(`${hostname}.`);
}

function run(command, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)); }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim().slice(-800)}`));
    });
  });
}

export async function probeMedia(file, config) {
  const stdout = await run(config.pythonCommand, [config.mediaProbeScript, file]);
  const data = JSON.parse(stdout);
  return {
    durationSeconds: Number(data.durationSeconds || 0),
    bytes: Number(data.bytes || fs.statSync(file).size),
    hasAudio: data.hasAudio === true,
    hasVideo: data.hasVideo === true,
  };
}

export function validateCompleteProbe(probe, expectedDurationSeconds = 0) {
  // 只强制要求有视频流，允许无音频的纯画面内容
  if (!probe.hasVideo) throw new Error("media must contain complete video streams");
  if (!(probe.durationSeconds > 0) || !(probe.bytes >= 1024)) throw new Error("media probe is incomplete");
  if (expectedDurationSeconds > 0 && Math.abs(probe.durationSeconds - expectedDurationSeconds) > Math.max(3, expectedDurationSeconds * 0.05)) {
    throw new Error("media duration differs from the saved-video metadata");
  }
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export async function freezeMedia(item, config) {
  // 兼容不同来源的图文字段名
  const isImage = item.is_image_post || item.is_image;
  const imageUrls = item.image_urls || item.image_paths || [];
  if (isImage && Array.isArray(imageUrls) && imageUrls.length) {
    const targetDir = path.join(config.mediaDir, `${item.aweme_id}-images`);
    await fsp.mkdir(targetDir, { recursive: true });
    const downloaded = [];
    for (let index = 0; index < imageUrls.length; index += 1) {
      const url = imageUrls[index];
      const ext = path.extname(new URL(url).pathname) || ".jpg";
      const target = path.join(targetDir, `${String(index + 1).padStart(2, "0")}${ext}`);
      if (!fs.existsSync(target) || fs.statSync(target).size < 1024) {
        await downloadMedia(url, target, { maxBytes: 100 * 1024 * 1024 });
      }
      downloaded.push(target);
    }
    return {
      path: targetDir,
      is_image: true,
      image_paths: downloaded,
      sha256: crypto.createHash("sha256").update(downloaded.join("\n")).digest("hex"),
      bytes: downloaded.reduce((sum, p) => sum + fs.statSync(p).size, 0),
      durationSeconds: 0,
      resumed: false,
    };
  }
  // 多字段兜底取播放地址，兼容不同类型内容和抖音字段变更
  const playUrl = item.play_url || item.download_url || item.video?.play_addr?.url_list?.[0] || item.play_addr?.url_list?.[0];
  // 没有任何媒体地址时，直接返回空结果，不抛错，后续流程用现有文案生成笔记
  if (!playUrl) {
    return {
      path: "",
      is_image: false,
      sha256: "",
      bytes: 0,
      durationSeconds: 0,
      resumed: false,
      skipped: true,
    };
  }
  const target = path.join(config.mediaDir, `${item.aweme_id}.mp4`);
  if (fs.existsSync(target)) {
    const probe = await probeMedia(target, config);
    try {
      // 只校验视频流和时长，允许无音频内容
      if (!probe.hasVideo || !(probe.durationSeconds > 0) || !(probe.bytes >= 1024)) throw new Error("media probe is incomplete");
      if (Number(item.duration || 0) > 0 && Math.abs(probe.durationSeconds - Number(item.duration)) > Math.max(3, Number(item.duration) * 0.05)) {
        throw new Error("media duration differs from the saved-video metadata");
      }
      return { path: target, sha256: sha256File(target), bytes: probe.bytes, durationSeconds: probe.durationSeconds, resumed: true };
    } catch {
      await fsp.rm(target, { force: true });
    }
  }
  await downloadMedia(playUrl, target);
  const probe = await probeMedia(target, config);
  // 只校验视频流，允许无音频的纯画面视频
  if (!probe.hasVideo || !(probe.durationSeconds > 0) || !(probe.bytes >= 1024)) throw new Error("media probe is incomplete");
  return { path: target, sha256: sha256File(target), bytes: probe.bytes, durationSeconds: probe.durationSeconds, resumed: false };
}
