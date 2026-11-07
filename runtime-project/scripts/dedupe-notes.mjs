#!/usr/bin/env node
/**
 * dedupe-notes.mjs —— 清理「同一视频存在多份 md」的历史残留。
 *
 * 只用数据库里 note_path 指向的那份作准，同一 aweme_id 的其它文件视为旧版本，
 * 移动到 _dedupe_backup_<时间戳>/ 下（不删除，可回滚），并保持相对目录结构。
 *
 * 用法：
 *   node scripts/dedupe-notes.mjs --dry-run
 *   node scripts/dedupe-notes.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { resolveVaultLayout } from "../src/vault.mjs";
import { StateStore } from "../src/state.mjs";

const option = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};
const dryRun = process.argv.includes("--dry-run");

const config = loadConfig(option("--config"));
const store = new StateStore(config.databaseFile);
// 用统一的 vault 布局解析（vaultPath 可能只是父目录，笔记在 vaultPath/vaultFolder/Knowledge）
const vault = resolveVaultLayout(config).root;
const root = path.join(vault, "Knowledge");

const rows = store.list({ limit: 100000 }).filter((row) => row.note_path && row.status === "written");
const canonical = new Map(rows.map((row) => [String(row.aweme_id), path.resolve(String(row.note_path))]));

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupRoot = path.join(vault, `_dedupe_backup_${stamp}`);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

const files = fs.existsSync(root) ? walk(root) : [];
let moved = 0;
for (const file of files) {
  const head = fs.readFileSync(file, "utf8").slice(0, 600);
  const match = head.match(/aweme_id:\s*"?(\d+)"?/u);
  if (!match) continue;
  const awemeId = match[1];
  const target = canonical.get(awemeId);
  if (!target) continue; // 不属于当前已生成集合（历史笔记），不动
  if (path.resolve(file) === target) continue;

  const rel = path.relative(vault, file);
  const dest = path.join(backupRoot, rel);
  console.log(JSON.stringify({ event: "move", aweme_id: awemeId, from: rel, to: path.relative(vault, dest) }));
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file, dest);
    // 顺手清掉因此变空的目录（最多往上 3 层）
    let dir = path.dirname(file);
    for (let i = 0; i < 3; i += 1) {
      try {
        if (fs.readdirSync(dir).length) break;
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      } catch {
        break;
      }
    }
  }
  moved += 1;
}

console.log(JSON.stringify({ event: "summary", checked: files.length, moved, backupRoot, dryRun }));
