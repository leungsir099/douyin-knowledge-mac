#!/usr/bin/env node
// 跨平台 Whisper 模型下载（macOS / Windows 通用，替代 ensure-whisper-model.ps1）。
// 逻辑与 PowerShell 版一致：读 models/*.lock.json，按 sha256 + 字节数校验，.part 临时文件 + 重试，
// 优先从内置 bundle 目录复制，否则从 hf 镜像下载。最后一行输出模型目录路径。
// 下载用 Node 原生 https 模块（比 fetch/undici 稳），支持 Range 断点续传，避免大文件重下。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";
import http from "node:http";
import { pipeline } from "node:stream/promises";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const projectRoot = path.resolve(arg("--project-root"));
const stateDir = path.resolve(arg("--state-dir"));
const bundleDirectory = arg("--bundle-dir") ? path.resolve(arg("--bundle-dir")) : "";
const endpoint = String(arg("--endpoint", "https://hf-mirror.com")).trim().replace(/\/+$/u, "");

if (!/^https:\/\/[A-Za-z0-9._-]+(\.[A-Za-z0-9._-]+)*(:\d+)?$/u.test(endpoint)) {
  throw new Error(`Unsafe model endpoint: ${endpoint}`);
}

const lockPath = path.join(projectRoot, "models", "faster-whisper-small.lock.json");
if (!fs.existsSync(lockPath)) throw new Error(`Whisper model lock is missing: ${lockPath}`);
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const repoId = String(lock.repoId || "");
const revision = String(lock.revision || "");
if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(repoId)) throw new Error("Unsafe model repository ID in lock file.");
if (!/^[0-9a-fA-F]{40}$/u.test(revision)) throw new Error("Model revision must be an immutable 40-character commit.");
const files = Object.entries(lock.files || {});
if (files.length === 0) throw new Error("Model lock contains no files.");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verified(file, expectedSize, expectedSha) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size !== expectedSize) return false;
    return (await sha256File(file)).toLowerCase() === expectedSha.toLowerCase();
  } catch {
    return false;
  }
}

function verifiedSync(file, expectedSize, expectedSha) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size !== expectedSize) return false;
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toLowerCase() === expectedSha.toLowerCase();
  } catch {
    return false;
  }
}

// 原生 https GET，跟重定向；返回可读流
function httpGet(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("too many redirects"));
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, {
      headers: { "User-Agent": "dok-model-downloader/1.0", ...headers },
      timeout: 120000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpGet(next, headers, redirects + 1));
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error("network timeout")));
    req.on("error", reject);
  });
}

async function downloadFile(url, destination, expectedSize, expectedSha) {
  const partial = `${destination}.part`;
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      // 断点续传：已有 .part 就带 Range 请求，避免 400+MB 文件网络抖动后从头重下
      let start = 0;
      try { start = fs.existsSync(partial) ? fs.statSync(partial).size : 0; } catch { start = 0; }
      if (start > expectedSize) { fs.rmSync(partial, { force: true }); start = 0; }
      if (start === expectedSize) { fs.renameSync(partial, destination); return; }
      const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
      const res = await httpGet(url, headers);
      if (res.statusCode === 416) {
        res.resume();
        fs.rmSync(partial, { force: true });
        throw new Error("range not satisfiable, restart from zero");
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode} for ${url}`);
      }
      const out = fs.createWriteStream(partial, { flags: start > 0 ? "a" : "w" });
      await pipeline(res, out);
      if (!(await verified(partial, expectedSize, expectedSha))) {
        fs.rmSync(partial, { force: true });
        throw new Error("Downloaded model file failed size or SHA-256 verification.");
      }
      fs.renameSync(partial, destination);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        const waitMs = 2 ** attempt * 1000;
        process.stderr.write(`[model] 下载失败（${error.message}），${Math.round(waitMs / 1000)}s 后重试 ${attempt + 1}/5…\n`);
        await sleep(waitMs);
      }
    }
  }
  throw new Error(`Unable to download and verify ${path.basename(destination)} after 5 attempts: ${lastError && lastError.message}`);
}

function copyVerified(source, destination, expectedSize, expectedSha) {
  const partial = `${destination}.part`;
  fs.rmSync(partial, { force: true });
  try {
    fs.copyFileSync(source, partial);
    if (!verifiedSync(partial, expectedSize, expectedSha)) throw new Error("Copied model file failed size or SHA-256 verification.");
    fs.renameSync(partial, destination);
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

if (bundleDirectory) {
  if (!fs.existsSync(bundleDirectory) || !fs.statSync(bundleDirectory).isDirectory()) {
    throw new Error(`Whisper model bundle directory is missing: ${bundleDirectory}`);
  }
  for (const [filename, entry] of files) {
    if (!filename || path.basename(filename) !== filename) throw new Error("Unsafe model filename in lock file.");
    if (!verifiedSync(path.join(bundleDirectory, filename), Number(entry.bytes), String(entry.sha256))) {
      throw new Error(`Whisper model bundle file failed size or SHA-256 verification: ${filename}`);
    }
  }
}

const modelDir = path.join(stateDir, "models", repoId.replace("/", "--"), revision);
fs.mkdirSync(modelDir, { recursive: true });

for (const [filename, entry] of files) {
  if (!filename || path.basename(filename) !== filename) throw new Error("Unsafe model filename in lock file.");
  const size = Number(entry.bytes);
  const sha = String(entry.sha256 || "");
  if (!/^[0-9a-fA-F]{64}$/u.test(sha) || !(size > 0)) throw new Error("Invalid model size or SHA-256 in lock file.");
  const destination = path.join(modelDir, filename);
  if (await verified(destination, size, sha)) continue;
  process.stderr.write(`[model] ${filename} (${(size / 1048576).toFixed(1)} MB)…\n`);
  if (bundleDirectory) {
    copyVerified(path.join(bundleDirectory, filename), destination, size, sha);
  } else {
    const url = `${endpoint}/${repoId}/resolve/${revision}/${encodeURIComponent(filename)}?download=true`;
    await downloadFile(url, destination, size, sha);
  }
}

process.stdout.write(`${modelDir}\n`);
