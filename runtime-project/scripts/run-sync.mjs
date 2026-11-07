#!/usr/bin/env node
// 跨平台定时同步入口（macOS launchd / Windows 计划任务通用，替代 run-sync.ps1）。
// 逻辑与 PowerShell 版一致：找内置 node → 读桌面应用设置里的 LLM 配置 → 锁检查 →
// ingest + sync + report → 失败重试一次 → AI 诊断。日志写 var/logs/scheduler.log。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const logDirectory = path.join(projectRoot, "var", "logs");
fs.mkdirSync(logDirectory, { recursive: true });
const logFile = path.join(logDirectory, "scheduler.log");

function stamp() {
  // 本地时区 ISO，和 PowerShell 的 Get-Date -Format o 对齐
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function log(line) {
  try {
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
  } catch {
    // 日志失败不影响主流程
  }
}

function localDateString(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const startedAt = stamp();
log(`${startedAt} START run-sync.mjs`);

// 1) 找 node：优先内置运行时（打包版），其次 PATH
function resolveNode() {
  const nodeName = process.platform === "win32" ? "node.exe" : path.join("bin", "node");
  const bundled = path.join(path.dirname(projectRoot), "node", nodeName);
  if (fs.existsSync(bundled)) return bundled;
  const cmd = spawnSync(process.platform === "win32" ? "where" : "which", ["node"], { encoding: "utf8" });
  const found = String(cmd.stdout || "").split(/\r?\n/u).map((s) => s.trim()).find(Boolean);
  return found || "";
}

const nodePath = resolveNode();
if (!nodePath) {
  log(`${stamp()} FAILED: node not found (no bundled runtime, no PATH entry)`);
  process.exit(1);
}
const verOut = String(spawnSync(nodePath, ["--version"], { encoding: "utf8" }).stdout || "").trim();
const major = Number((verOut.match(/v(\d+)/u) || [])[1] || 0);
if (major < 22) {
  log(`${stamp()} FAILED: node version too old ${verOut} (need >= 22), path ${nodePath}`);
  process.exit(1);
}

// 2) AI 配置：环境变量优先；否则从桌面应用设置读取
const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
if (!env.DOK_LLM_API_KEY) {
  try {
    const settingsFile = path.join(os.homedir(), ".douyin-knowledge-app", "settings.json");
    if (fs.existsSync(settingsFile)) {
      const s = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      if (s.llmApiKey) env.DOK_LLM_API_KEY = String(s.llmApiKey);
      if (s.llmBaseUrl) env.DOK_LLM_BASE_URL = String(s.llmBaseUrl);
      if (s.llmModel) env.DOK_LLM_MODEL = String(s.llmModel);
    }
  } catch { /* 设置文件损坏时继续，后面会 WARN */ }
}
if (!env.DOK_LLM_API_KEY) {
  log(`${stamp()} WARN: no DOK_LLM_API_KEY (env or app settings); AI extraction/diagnosis will be unavailable`);
}

const cliPath = path.join(projectRoot, "src", "cli.mjs");
const progressFile = path.join(projectRoot, "var", "sync-progress.json");
const lockFile = path.join(projectRoot, "var", "sync.lock");
const stateDir = path.join(projectRoot, "var");

function runCli(args, timeoutMs = 6 * 60 * 60 * 1000) {
  const result = spawnSync(nodePath, ["--no-warnings", cliPath, ...args], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) throw new Error(`cli.mjs ${args.join(" ")} failed (rc=${result.status}): ${output.slice(-2000)}`);
  return output;
}

function writeProgress(payload) {
  try {
    fs.writeFileSync(progressFile, JSON.stringify(payload), "utf8");
  } catch { /* ignore */ }
}

// 3) 锁检查：同步进程已在跑就跳过；死锁或超过 6 小时的锁视为过期清掉
let lockStale = false;
if (fs.existsSync(lockFile)) {
  try {
    const lk = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    let alive = false;
    try { process.kill(Number(lk.pid), 0); alive = true; } catch { alive = false; }
    let ageHours = 0;
    try { ageHours = (Date.now() - Date.parse(lk.startedAt)) / 3600000; } catch { ageHours = 0; }
    if (!alive || ageHours > 6) lockStale = true;
  } catch {
    lockStale = true;
  }
}
if (fs.existsSync(lockFile) && !lockStale) {
  writeProgress({ running: false, skipped: true, done: 0, total: 0, percent: 0, updatedAt: stamp() });
  log(`${stamp()} SKIPPED: another sync is already running (lock exists)`);
  process.exit(0);
}
if (fs.existsSync(lockFile)) {
  log(`${stamp()} STALE-LOCK-CLEARED: removed leftover lock (pid dead or >6h old)`);
  fs.rmSync(lockFile, { force: true });
}

// 4) 主流程：失败自动重试一次
const today = localDateString(0);
const yesterday = localDateString(-1);
const tomorrow = localDateString(1);
const retrySince = localDateString(-3);

let startDate = "";
const configFile = path.join(projectRoot, "config.json");
if (fs.existsSync(configFile)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/u, ""));
    if (cfg.startDate) startDate = String(cfg.startDate);
  } catch { startDate = ""; }
}

const syncArgs = ["sync", "--pending", "500", "--retry-since", retrySince, "--until-date", tomorrow, "--fill-older", "--progress-file", progressFile];
syncArgs.push("--since-date", startDate || yesterday);

let attempt = 1;
let errMsg = "";
let ingestOut = "";
let syncOut = "";
let reportOut = "";
while (attempt <= 2) {
  try {
    writeProgress({ running: true, stage: "collect-ingest", done: 0, total: 0, percent: 0, updatedAt: stamp() });
    ingestOut = runCli(["ingest"]);
    syncOut = runCli(syncArgs);
    reportOut = runCli(["report"]);
    log(`${stamp()} OK\n--- ingest ---\n${ingestOut}\n--- syncNew(${syncArgs.join(" ")}) ---\n${syncOut}\n--- report ---\n${reportOut}`);
    process.exit(0);
  } catch (error) {
    errMsg = String(error?.message || error);
    if (attempt < 2) {
      log(`${stamp()} RETRY-1: first attempt failed (${errMsg}); retrying in 30s`);
      await new Promise((resolve) => setTimeout(resolve, 30000));
    }
    attempt += 1;
  }
}

log(`${stamp()} FAILED ${errMsg}`);
// 5) AI 诊断：失败上下文交给 DeepSeek，输出简短结论（不阻塞主流程）
try {
  const ctxFile = path.join(projectRoot, "var", "logs", "scheduler-fail-context.txt");
  const ctxLines = [`time: ${stamp()}`, `error: ${errMsg}`, "attempts: 2"];
  if (ingestOut) ctxLines.push(`--- ingest output ---\n${ingestOut}`);
  if (syncOut) ctxLines.push(`--- sync output ---\n${syncOut}`);
  if (reportOut) ctxLines.push(`--- report output ---\n${reportOut}`);
  fs.writeFileSync(ctxFile, ctxLines.join("\n"), "utf8");
  const diag = spawnSync(nodePath, ["--no-warnings", path.join(projectRoot, "scripts", "ai-diagnose.mjs"), "--context", ctxFile], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
  });
  log(`${stamp()} AI-DIAGNOSIS: ${String(diag.stdout || diag.stderr || "").trim()}`);
} catch (error) {
  log(`${stamp()} AI-DIAGNOSIS FAILED ${String(error?.message || error)}`);
}
process.exit(1);
