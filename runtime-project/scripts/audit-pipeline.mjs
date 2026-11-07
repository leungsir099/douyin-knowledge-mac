/**
 * 全链路体检：生成笔记 → AI 提炼 → AI 分类 → 知识图谱 → 划重点 → 蒸馏
 * 只读，不改任何文件。
 *   node scripts/audit-pipeline.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { resolveVaultLayout } from "../src/vault.mjs";
import { StateStore } from "../src/state.mjs";

const config = loadConfig();
const store = new StateStore(config.databaseFile);
const rows = store.list({ limit: 100000 });
const written = rows.filter((r) => r.status === "written");

const out = [];
const p = (s = "") => out.push(s);

p(`状态分布：${JSON.stringify(store.counts())}`);
p("");

/* ---------- 1. 笔记文件 & AI 提炼 ---------- */
let missingFile = 0;
const extractorDist = {};
const noCategory = [];
const noGroup = [];
const boldStats = [];
const linkStats = [];
const kinds = {};

for (const r of written) {
  const f = r.note_path;
  if (!f || !fs.existsSync(f)) {
    missingFile += 1;
    continue;
  }
  const text = fs.readFileSync(f, "utf8");
  const ex = (text.match(/^extractor:\s*(.+)$/m) || [])[1]?.trim() || "(none)";
  extractorDist[ex] = (extractorDist[ex] || 0) + 1;
  kinds[r.category || "(空)"] = (kinds[r.category || "(空)"] || 0) + 1;

  if (!r.category || r.category === "其他" || r.category === "未分类") {
    noCategory.push({ title: r.title, category: r.category });
  }
  if (!r.group || r.group === "综合" || r.group === "未分类") {
    noGroup.push({ title: r.title, group: r.group, sub: r.subcategory });
  }
  // 重点加粗：正文里 **加粗** 的处数（排除 frontmatter）
  const body = text.replace(/^---[\s\S]*?\n---\n/u, "");
  const bolds = (body.match(/\*\*[^*\n]{1,40}\*\*/g) || []).length;
  // 双链
  const links = (body.match(/\[\[[^\]]+\]\]/g) || []).length;
  boldStats.push({ title: String(r.title).slice(0, 20), bolds, extractor: ex });
  linkStats.push({ title: String(r.title).slice(0, 20), links });
}

p(`【AI 提炼】已生成笔记 ${written.length} 篇，笔记文件缺失 ${missingFile} 篇`);
p(`  提炼来源：${JSON.stringify(extractorDist, null, 0)}`);
const aiCount = Object.entries(extractorDist)
  .filter(([k]) => k.startsWith("openai-compatible"))
  .reduce((a, [, v]) => a + v, 0);
p(`  → AI 提炼占比：${aiCount}/${written.length - missingFile}`);
p("");

p(`【AI 分类】大类分布：${JSON.stringify(kinds)}`);
p(`  大类缺失/落「其他」：${noCategory.length} 篇`);
for (const x of noCategory.slice(0, 10)) p(`    - ${x.title} → ${x.category || "(空)"}`);
p(`  无父类(group)/落「综合」：${noGroup.length} 篇`);
for (const x of noGroup.slice(0, 10)) p(`    - ${x.title} → group=${x.group || "(空)"} sub=${x.sub}`);
p("");

/* ---------- 2. 划重点 ---------- */
const zeroBold = boldStats.filter((b) => b.bolds === 0);
p(`【划重点】正文加粗：${boldStats.filter((b) => b.bolds > 0).length}/${boldStats.length} 篇有加粗，${zeroBold.length} 篇 0 处`);
if (boldStats.length) {
  const avg = (boldStats.reduce((a, b) => a + b.bolds, 0) / boldStats.length).toFixed(1);
  p(`  平均 ${avg} 处/篇，范围 ${Math.min(...boldStats.map((b) => b.bolds))}–${Math.max(...boldStats.map((b) => b.bolds))}`);
}
for (const x of zeroBold.slice(0, 8)) p(`    - 0 处：${x.title}（${x.extractor}）`);
p("");

/* ---------- 3. 知识图谱（复刻 vault:graph 逻辑） ---------- */
// 用统一的 vault 布局解析（vaultPath 可能只是父目录，笔记在 vaultPath/vaultFolder/Knowledge）
const vaultRoot = path.join(resolveVaultLayout(config).root, "Knowledge");
let nodes = 0;
let edges = 0;
let dangling = 0;
const titleIndex = new Set();
if (fs.existsSync(vaultRoot)) {
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (f.name.toLowerCase().endsWith(".md")) {
        nodes += 1;
        titleIndex.add(f.name.replace(/\.md$/i, ""));
      }
    }
  };
  walk(vaultRoot);
  const walk2 = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk2(full);
      else if (f.name.toLowerCase().endsWith(".md")) {
        const content = fs.readFileSync(full, "utf8");
        const re = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
        let m;
        while ((m = re.exec(content)) !== null) {
          const t = m[1].trim();
          if (titleIndex.has(t)) edges += 1;
          else dangling += 1;
        }
      }
    }
  };
  walk2(vaultRoot);
}
p(`【知识图谱】Knowledge 下 ${nodes} 篇笔记，能连成边的双链 ${edges} 条，指向不存在笔记的悬空双链 ${dangling} 条`);
p(`  平均每篇 ${nodes ? (edges / nodes).toFixed(2) : 0} 条边`);
p("");

/* ---------- 4. 蒸馏前置条件 ---------- */
const settingsFile = path.join(process.env.USERPROFILE || process.env.HOME || "", ".douyin-knowledge-app", "settings.json");
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
} catch {}
const cangjie = settings.cangjiePath || "";
p(`【AI 蒸馏】仓颉路径：${cangjie || "(未设置)"} → SKILL.md ${fs.existsSync(path.join(cangjie, "SKILL.md")) ? "存在" : "缺失"}`);
p(`  methodology/ ${fs.existsSync(path.join(cangjie, "methodology")) ? "存在" : "缺失"}；extractors/ ${fs.existsSync(path.join(cangjie, "extractors")) ? "存在" : "缺失"}；templates/ ${fs.existsSync(path.join(cangjie, "templates")) ? "存在" : "缺失"}`);
const distillOut = settings.distillOutputDir || "";
p(`  输出目录：${distillOut || "(未设置)"} → ${distillOut && fs.existsSync(distillOut) ? "存在" : "不存在（首次蒸馏会自动创建）"}`);
let skillCount = 0;
try {
  if (distillOut && fs.existsSync(distillOut)) {
    skillCount = fs.readdirSync(distillOut, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("douyin-distill-")).length;
  }
} catch {}
p(`  已蒸馏技能：${skillCount} 个`);
// 可蒸馏的子类（≥1 篇笔记）
const subs = [];
if (fs.existsSync(vaultRoot)) {
  for (const major of fs.readdirSync(vaultRoot, { withFileTypes: true })) {
    if (!major.isDirectory()) continue;
    for (const group of fs.readdirSync(path.join(vaultRoot, major.name), { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      for (const sub of fs.readdirSync(path.join(vaultRoot, major.name, group.name), { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const d = path.join(vaultRoot, major.name, group.name, sub.name);
        const n = fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith(".md")).length;
        if (n > 0) subs.push({ path: `${major.name}/${group.name}/${sub.name}`, n });
      }
    }
  }
}
subs.sort((a, b) => a.n - b.n);
p(`  可蒸馏子类 ${subs.length} 个；最小的 5 个：${subs.slice(0, 5).map((s) => `${s.path}(${s.n}篇)`).join(" | ")}`);
p("");

/* ---------- 5. Key 配置 ---------- */
p(`【Key 与开关】extractorProvider=${config.extractorProvider}，模型=${config.llmModel || "(空)"}，Key=${config.llmApiKey ? "已配置" : "未配置"}，cloudTranscriptOptIn=${config.cloudTranscriptOptIn}`);

console.log(out.join("\n"));
