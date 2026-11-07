import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { sha256File, downloadMedia } from "./media.mjs";
import { root } from "./config.mjs";

function run(command, args, timeoutMs = 3600000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("transcription timed out")); }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`transcription exited with ${code}: ${stderr.replace(/\s+/gu, " ").trim().slice(-1000)}`));
    });
  });
}

export function validateTranscript(transcript, mediaDurationSeconds) {
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  if (!segments.length || !String(transcript?.text || "").trim()) {
    throw new Error("transcription produced no usable text segments");
  }
  const duration = Number(transcript?.duration || 0);
  if (!(duration > 0)) throw new Error("transcription duration is missing");
  if (mediaDurationSeconds > 0 && Math.abs(duration - mediaDurationSeconds) > Math.max(3, mediaDurationSeconds * 0.05)) {
    throw new Error("transcription duration differs from the frozen media");
  }
  const lastEnd = Math.max(...segments.map(segment => Number(segment.end || 0)));
  if (lastEnd < Math.min(duration, mediaDurationSeconds || duration) * 0.5) {
    throw new Error("transcription does not cover enough of the media timeline");
  }
}

const MIRROR_ENDPOINT = "https://hf-mirror.com";
const OFFICIAL_ENDPOINT = "https://huggingface.co";

// 下载源尝试顺序：设置页选的那个优先，另一个兜底。
// 国内直连 huggingface.co 基本不通，镜像挂了也得能切回官方，所以两个都留。
export function endpointOrder(configured) {
  const preferred = /^https:\/\/[^\s]+$/iu.test(String(configured || "").trim())
    ? String(configured).trim().replace(/\/+$/u, "")
    : MIRROR_ENDPOINT;
  const fallback = preferred.includes("hf-mirror") ? OFFICIAL_ENDPOINT : MIRROR_ENDPOINT;
  return [preferred, fallback];
}

// 模型路径缓存：模型一次校验通过后不再重复读取 464MB 做 SHA256
// （每个视频转录都会调一次 ensureModel，不缓存会白等几十秒）
let cachedModelPath = "";

async function ensureModel(config) {
  if (cachedModelPath && fs.existsSync(cachedModelPath)) return cachedModelPath;
  if (path.isAbsolute(config.whisperModel) && fs.existsSync(config.whisperModel)) {
    cachedModelPath = config.whisperModel;
    return config.whisperModel;
  }
  const isWindows = process.platform === "win32";
  // 跨平台：Windows 用 PowerShell 版，macOS 用等价的 node 版（逻辑一致：sha256 校验 + .part + 重试）
  const script = path.join(root, "scripts", isWindows ? "ensure-whisper-model.ps1" : "ensure-whisper-model.mjs");
  const modelBundleDirectory = String(process.env.DOK_MODEL_BUNDLE_DIR || "").trim();
  // 打包版 PATH 可能不含 System32，用系统默认绝对路径兜底
  const defaultPowershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const powershell = process.env.DOK_POWERSHELL || (fs.existsSync(defaultPowershell) ? defaultPowershell : "powershell.exe");
  const endpoints = endpointOrder(config.hfEndpoint);
  let lastError = null;
  for (const [index, endpoint] of endpoints.entries()) {
    if (index > 0) {
      process.stderr.write(`[model] 下载源 ${endpoints[index - 1]} 失败，改试 ${endpoint}…\n`);
    } else {
      process.stderr.write(`[model] 检查/下载转录模型，下载源 ${endpoint}…\n`);
    }
    try {
      const stdout = isWindows
        ? await run(powershell, [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy", "Bypass",
          "-File", script,
          "-ProjectRoot", root,
          "-StateDir", config.stateDir,
          "-Endpoint", endpoint,
          ...(modelBundleDirectory ? ["-BundleDirectory", modelBundleDirectory] : []),
        ], 6 * 60 * 60 * 1000)
        : await run(process.execPath, [
          script,
          "--project-root", root,
          "--state-dir", config.stateDir,
          "--endpoint", endpoint,
          ...(modelBundleDirectory ? ["--bundle-dir", modelBundleDirectory] : []),
        ], 6 * 60 * 60 * 1000);
      const modelPath = stdout.trim().split(/\r?\n/u).at(-1);
      if (!modelPath || !fs.existsSync(modelPath)) throw new Error("模型下载后没有生成模型目录");
      cachedModelPath = modelPath;
      return modelPath;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `转录模型下载失败（已尝试 ${endpoints.join(" / ")}）：${String(lastError?.message || lastError).slice(-400)}。`
    + "可到「设置 → 转录模型」点「重新检测并下载模型」，或把软件安装目录加入杀毒软件白名单后重试。"
  );
}

export async function transcribeMedia(item, config) {
  if (!fs.existsSync(config.pythonCommand)) {
    throw new Error(`project Python environment is missing: ${config.pythonCommand}`);
  }
  const outputDir = path.join(config.transcriptDir, String(item.aweme_id));
  fs.mkdirSync(outputDir, { recursive: true });
  const transcriptFile = path.join(outputDir, "transcript.json");
  // 优先使用平台内置字幕，不跑Whisper
  if (config.preferBuiltinSubtitle && item.builtin_subtitle_url) {
    const subtitleTarget = path.join(outputDir, "builtin-subtitle.json");
    await downloadMedia(item.builtin_subtitle_url, subtitleTarget, { maxBytes: 20 * 1024 * 1024 });
    const rawSubtitle = JSON.parse(fs.readFileSync(subtitleTarget, "utf8").replace(/^\uFEFF/u, ""));
    const utterances = rawSubtitle.utterances || rawSubtitle.body || [];
    const segments = utterances.map(u => ({
      start: Number(u.start_time || u.start || 0) / 1000,
      end: Number(u.end_time || u.end || 0) / 1000,
      text: String(u.text || u.words || "").trim(),
    })).filter(s => s.text);
    const text = segments.map(s => s.text).join("\n");
    const transcript = {
      duration: Number(item.media_duration_seconds || item.duration || 0),
      text,
      segments,
      source: "builtin-subtitle",
    };
    fs.writeFileSync(transcriptFile, JSON.stringify(transcript, null, 2), "utf8");
    const sha256 = sha256File(transcriptFile);
    return {
      path: transcriptFile,
      sha256,
      durationSeconds: transcript.duration,
      segmentCount: segments.length,
      wordCount: text.length,
      resumed: false,
    };
  }
  const modelPath = await ensureModel(config);
  // 超时按音频时长动态计算：2 小时长视频在 CPU 上转录可能超过 1 小时，
  // 固定 1 小时会把正常任务误杀（本机实测出现过 3602s 超时失败）
  const mediaDurationSec = Number(item.media_duration_seconds || item.duration_seconds || item.duration || 0);
  const transcribeTimeoutMs = Math.max(
    60 * 60 * 1000,
    Math.round(mediaDurationSec * 3000) + 30 * 60 * 1000,
  );
  const stdout = await run(config.pythonCommand, [
    path.join(root, "python", "transcribe.py"),
    "--input", item.media_path,
    "--output-dir", outputDir,
    "--model", modelPath,
    "--model-lock", config.whisperModelLock,
    "--language", config.language,
    "--model-cache", config.modelCacheDir,
    ...(config.hfEndpoint ? ["--hf-endpoint", config.hfEndpoint] : []),
  ], transcribeTimeoutMs);
  const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
  // 注意：transcriptFile 已在函数开头声明过，这里不能再 const 一次，
  // 否则同作用域重复声明会让整个模块语法错误、整条转录流水线直接加载失败
  if (!fs.existsSync(transcriptFile)) throw new Error("transcription created no transcript file");
  const transcript = JSON.parse(fs.readFileSync(transcriptFile, "utf8").replace(/^\uFEFF/u, ""));
  validateTranscript(transcript, Number(item.media_duration_seconds || item.duration_seconds || 0));
  const sha256 = sha256File(transcriptFile);
  if (result.transcriptSha256 && result.transcriptSha256 !== sha256) {
    throw new Error("transcript hash does not match its manifest");
  }
  return {
    path: transcriptFile,
    sha256,
    durationSeconds: Number(transcript.duration || 0),
    segmentCount: transcript.segments.length,
    wordCount: Array.isArray(transcript.words) ? transcript.words.length : 0,
    resumed: result.resumed === true,
  };
}
