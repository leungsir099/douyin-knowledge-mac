#!/usr/bin/env node
/**
 * reprocess-ai.mjs —— 用当前配置的 AI（如 DeepSeek）重新提炼已有笔记。
 *
 * 只重跑「提炼 + 写库」两步，复用已有 transcript.json，不重新下载/转录。
 * 每条都会：备份旧 md 与 knowledge.json → 删旧 md → 删 knowledge 缓存 → extract → write。
 * extract 失败会回滚旧 md，不会把笔记弄丢。
 *
 * 用法：
 *   node scripts/reprocess-ai.mjs                 # 全部已写笔记
 *   node scripts/reprocess-ai.mjs --limit 3       # 只处理前 3 条
 *   node scripts/reprocess-ai.mjs --aweme-id 123  # 只处理指定视频
 *   node scripts/reprocess-ai.mjs --dry-run       # 只打印计划，不动文件
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { StateStore } from "../src/state.mjs";
import { extract, write } from "../src/workflow.mjs";

const option = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};
const hasFlag = (name) => process.argv.includes(name);

const config = loadConfig(option("--config"));
const store = new StateStore(config.databaseFile);
const limit = Number(option("--limit", "0"));
const onlyAweme = option("--aweme-id");
const dryRun = hasFlag("--dry-run");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupDir = path.join(config.stateDir, "backups", `reprocess-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });

// --include-failed：连上次提炼失败（但笔记文件还在）的条目一起救回来
const includeFailed = hasFlag("--include-failed");
let rows = store.list({ limit: 100000 }).filter((row) => {
  if (row.status === "written") return true;
  return includeFailed && row.status === "failed" && row.note_path && fs.existsSync(row.note_path);
});
if (onlyAweme) rows = rows.filter((row) => row.aweme_id === onlyAweme);
if (limit > 0) rows = rows.slice(0, limit);

const log = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

log({
  event: "start",
  provider: config.extractorProvider,
  model: config.llmModel,
  total: rows.length,
  backupDir,
  dryRun,
});

let ok = 0;
let failed = 0;
let skipped = 0;
for (const [index, row] of rows.entries()) {
  const item = store.get(row.aweme_id) || row;
  const label = `[${index + 1}/${rows.length}] ${String(item.title || "").slice(0, 34)}`;
  const knowledgeFile = item.knowledge_path || path.join(config.knowledgeDir, String(item.aweme_id), "knowledge.json");
  const manifestFile = path.join(path.dirname(knowledgeFile), "knowledge-manifest.json");
  const noteFile = item.note_path || "";

  if (dryRun) {
    log({ event: "plan", label, aweme_id: item.aweme_id, noteFile, knowledgeFile });
    continue;
  }

  // 已经是当前 AI 提炼过的跳过，避免重复花 API 费用（--force 可强制重跑）
  if (!hasFlag("--force") && config.extractorProvider === "openai" && fs.existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      if (String(manifest.extractor || "") === `openai-compatible/${config.llmModel}`) {
        skipped += 1;
        log({ event: "skip", label, aweme_id: item.aweme_id, reason: `已由 ${manifest.extractor} 提炼` });
        continue;
      }
    } catch {}
  }

  // ---- 1. 备份 ----
  const itemBackup = path.join(backupDir, String(item.aweme_id));
  fs.mkdirSync(itemBackup, { recursive: true });
  if (noteFile && fs.existsSync(noteFile)) {
    fs.copyFileSync(noteFile, path.join(itemBackup, path.basename(noteFile)));
  }
  if (fs.existsSync(knowledgeFile)) {
    fs.copyFileSync(knowledgeFile, path.join(itemBackup, "knowledge.json"));
  }
  const backupNote = noteFile && fs.existsSync(noteFile) ? fs.readFileSync(noteFile, "utf8") : "";

  // ---- 2. 删旧产物，逼 AI 重算（extract 有缓存，不删会直接复用本地规则结果）----
  try {
    if (noteFile && fs.existsSync(noteFile)) fs.unlinkSync(noteFile);
    if (fs.existsSync(knowledgeFile)) fs.unlinkSync(knowledgeFile);
    if (fs.existsSync(manifestFile)) fs.unlinkSync(manifestFile);
  } catch (error) {
    failed += 1;
    log({ event: "error", label, aweme_id: item.aweme_id, stage: "cleanup", error: String(error?.message || error) });
    continue;
  }

  // ---- 3. AI 提炼 ----
  let extracted;
  const extractStart = Date.now();
  try {
    [extracted] = await extract(config, store, { limit: 1, awemeId: item.aweme_id });
  } catch (error) {
    extracted = { status: "failed", error: String(error?.message || error) };
  }
  if (!extracted || extracted.status !== "extracted") {
    failed += 1;
    // 回滚：把旧笔记写回去，避免内容丢失
    let restored = false;
    if (backupNote && noteFile) {
      try {
        fs.mkdirSync(path.dirname(noteFile), { recursive: true });
        fs.writeFileSync(noteFile, backupNote);
        restored = true;
      } catch {}
    }
    // extract 失败会把状态改成 failed，这里恢复成 written，否则这条会从「已生成」列表里消失
    if (restored) {
      try {
        store.markWritten(item.aweme_id, { path: noteFile, sha256: item.note_sha256 }, item.category, item.subcategory, item.group);
      } catch {}
    }
    const k = fs.existsSync(path.join(itemBackup, "knowledge.json"))
      ? fs.readFileSync(path.join(itemBackup, "knowledge.json"), "utf8")
      : "";
    if (k) {
      try {
        fs.mkdirSync(path.dirname(knowledgeFile), { recursive: true });
        fs.writeFileSync(knowledgeFile, k);
      } catch {}
    }
    log({ event: "failed", label, aweme_id: item.aweme_id, stage: "extract", error: extracted?.error || "unknown" });
    continue;
  }

  // ---- 4. 写笔记 ----
  let written;
  try {
    [written] = await write(config, store, { limit: 1, awemeId: item.aweme_id });
  } catch (error) {
    written = { status: "failed", error: String(error?.message || error) };
  }
  if (!written || written.status !== "written") {
    failed += 1;
    log({ event: "failed", label, aweme_id: item.aweme_id, stage: "write", error: written?.error || "unknown" });
    continue;
  }

  ok += 1;
  const latest = store.get(item.aweme_id) || {};
  let preview = {};
  try {
    const k = JSON.parse(fs.readFileSync(knowledgeFile, "utf8"));
    preview = {
      category: k.category,
      group: k.group,
      subcategory: k.subcategory,
      thesis: String(k.thesis || "").slice(0, 60),
      tags: (k.tags || []).slice(0, 5),
      keyIdeas: (k.keyIdeas || []).length,
      actions: (k.actions || []).length,
      boldMarks: (JSON.stringify(k).match(/\*\*/g) || []).length / 2,
    };
  } catch {}
  log({
    event: "done",
    label,
    aweme_id: item.aweme_id,
    seconds: Math.round((Date.now() - extractStart) / 1000),
    note: written.path || latest.note_path,
    oldNote: noteFile,
    ...preview,
  });
}

log({ event: "summary", ok, failed, skipped, backupDir });
