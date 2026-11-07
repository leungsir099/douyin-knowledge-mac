#!/usr/bin/env node
/**
 * vault 路径一致性自检。
 *
 * 背景：本项目有多处代码需要拼「知识库根目录」(vaultPath/Knowledge)，
 * 但 vaultPath 可能只是父目录，真实笔记在 vaultPath/vaultFolder/Knowledge。
 * 历史上出现过 3 次「只改了一处、漏了另一处」导致功能报“子类目录不存在”。
 *
 * 本脚本扫描所有源码，找出「直接用 vaultPath 拼 Knowledge」但没有经过
 * vaultBaseDir / vaultKnowledgeDir / resolveVaultLayout / layout.root 的位置。
 * 每次改动路径相关代码后运行：
 *   node scripts/check-vault-paths.mjs <源码目录...>
 */
import fs from "node:fs";
import path from "node:path";

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error("用法: node scripts/check-vault-paths.mjs <源码目录...>");
  process.exit(2);
}

// 这些写法已正确处理 vaultFolder / 统一布局解析
const SAFE = [
  /resolveVaultLayout/,
  /vaultBaseDir/,
  /vaultKnowledgeDir/,
  /vaultBaseForUi/,
  /layout\.root/,
  /\/\/ vault 根/,
];
// 内部实现，忽略
const IGNORE_FILES = [/src\/vault\.mjs$/];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js|cjs)$/u.test(e.name)) out.push(p);
  }
  return out;
}

const risky = [];
for (const root of roots) {
  for (const file of walk(path.resolve(root))) {
    if (IGNORE_FILES.some((re) => re.test(file))) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/u);
    lines.forEach((line, i) => {
      if (!/"Knowledge"/u.test(line)) return;
      if (!/path\.join\(/u.test(line) && !/\[[^\]]*"Knowledge"/u.test(line)) return;
      // 相对路径（如 filePath/relPath 传给 IPC，由主进程用 vaultBaseDir 拼接）不是隐患
      if (/\b(filePath|relPath)\b/u.test(line)) return;
      // 允许变量来自前 3 行内已解析好的 vault 根（如 layout.root）
      const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
      if (SAFE.some((re) => re.test(context))) return;
      risky.push({ file, line: i + 1, text: line.trim() });
    });
  }
}

if (!risky.length) {
  console.log("✅ 未发现 vault 路径硬编码隐患");
  process.exit(0);
}
console.log(`⚠️  发现 ${risky.length} 处疑似漏用 vaultFolder 的路径拼接：`);
for (const r of risky) console.log(`  ${r.file}:${r.line}\n    ${r.text}`);
process.exit(1);
