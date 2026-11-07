#!/usr/bin/env node
/**
 * test-skip-rules.mjs —— 检查「自动跳过内容类型」是否真的按勾选生效。
 *
 * 判定逻辑完全复刻 workflow.mjs 的 sync 分支：
 *   contentType → typeMap → skipKey → 在 skipCategories 里？ → knowledgeHasSubstance？
 *   勾选 && 无实质 → skipped；勾选 && 有实质 → 仍然写笔记（kept_despite_skip）
 *
 * 用法：
 *   node --no-warnings scripts/test-skip-rules.mjs              # 用库里已有的 AI 判定结果复算
 *   node --no-warnings scripts/test-skip-rules.mjs --json       # 只输出 JSON
 *   node --no-warnings scripts/test-skip-rules.mjs --explain    # 额外打印每条为何保留/跳过
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { StateStore } from "../src/state.mjs";

const hasFlag = (name) => process.argv.includes(name);
const config = loadConfig();
const store = new StateStore(config.databaseFile);

// 与 workflow.mjs 保持一致
const TYPE_MAP = {
  ad: "ad",
  shortdrama: "shortdrama",
  funny: "funny",
  music: "music",
  dance: "dance",
  performance: "dance",
  visual: "silent-no-info",
  "food-show": "mukbang",
};

const LABELS = {
  ad: "广告/推广带货",
  shortdrama: "短剧/连载短剧",
  music: "纯音乐/唱歌/演奏",
  dance: "舞蹈/才艺表演",
  funny: "搞笑段子/无干货娱乐",
  mukbang: "纯吃播/无教程美食",
  "silent-no-info": "纯风景/萌宠无文字画面",
};

// 与 workflow.mjs 保持一致：这几类勾了就不看有没有干货，一律跳过
const FORCE_SKIP_TYPES = new Set(["shortdrama", "music", "dance", "funny"]);

function knowledgeHasSubstance(data) {
  const keyIdeas = Array.isArray(data?.keyIdeas) ? data.keyIdeas.length : 0;
  const actions = Array.isArray(data?.actions) ? data.actions.length : 0;
  const summary = String(data?.summary || "").trim().length;
  const thesis = String(data?.thesis || "").trim().length;
  return keyIdeas >= 2 || actions >= 2 || (summary >= 60 && thesis >= 10);
}

const skipArg = (() => {
  const index = process.argv.indexOf("--assume");
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : "";
})();
// --assume music,visual,mukbang 仅用于验证判定分支，不改真实配置
const skip = skipArg
  ? skipArg.split(",").map((value) => value.trim()).filter(Boolean)
  : (Array.isArray(config.skipCategories) ? config.skipCategories : []);

// --selftest：库里没有某些类型的样本时，用构造数据验证判定分支是否真的能跳
if (hasFlag("--selftest")) {
  const cases = [
    { name: "纯音乐/唱歌（无要点）", contentType: "music", keyIdeas: [], actions: [], summary: "一段翻唱。", thesis: "翻唱" },
    { name: "纯风景画面（转录为空）", contentType: "visual", keyIdeas: [], actions: [], summary: "", thesis: "" },
    { name: "纯吃播（只展示吃）", contentType: "food-show", keyIdeas: [], actions: [], summary: "展示吃东西的过程，没有做法。", thesis: "吃播" },
    { name: "短剧（有剧情要点）", contentType: "shortdrama", keyIdeas: new Array(5).fill({}), actions: [], summary: "剧情梗概", thesis: "短剧剧情" },
    { name: "广告（有卖点罗列）", contentType: "ad", keyIdeas: new Array(3).fill({}), actions: [], summary: "产品卖点", thesis: "推广" },
  ];
  console.log("【规则自检（构造样本，不依赖真实视频）】");
  for (const item of cases) {
    const skipKey = TYPE_MAP[item.contentType] || "";
    const checked = Boolean(skipKey && skip.includes(skipKey));
    const substance = knowledgeHasSubstance(item);
    const force = checked && FORCE_SKIP_TYPES.has(skipKey);
    const verdict = !checked
      ? "正常生成笔记（未勾选该类型）"
      : (force ? "✅ 会被跳过（勾选即跳）" : (substance ? "保留写笔记（有实质内容，保护规则）" : "✅ 会被跳过（无实质内容）"));
    console.log(`· ${item.name}  →  ${verdict}`);
  }
  console.log("");
}

const rows = [];
for (const item of store.list({ limit: 100000 })) {
  const kPath = item.knowledge_path || path.join(config.knowledgeDir, String(item.aweme_id), "knowledge.json");
  if (!fs.existsSync(kPath)) continue;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(kPath, "utf8"));
  } catch {
    continue;
  }
  const contentType = String(data.contentType || "normal");
  const skipKey = TYPE_MAP[contentType] || "";
  const checked = Boolean(skipKey && skip.includes(skipKey));
  const substance = knowledgeHasSubstance(data);
  const keyIdeas = (data.keyIdeas || []).length;
  const actions = (data.actions || []).length;
  const force = checked && FORCE_SKIP_TYPES.has(skipKey);
  const expect = checked ? ((force || !substance) ? "skip" : "kept") : "normal";
  const actual = item.status;
  const consistent = expect === "skip"
    ? actual === "skipped"
    : (actual === "written" || actual === "extracted");
  rows.push({
    aweme_id: item.aweme_id,
    title: String(item.title || "").slice(0, 30),
    contentType,
    skipKey,
    checked,
    substance,
    force,
    keyIdeas,
    actions,
    expect,
    actual,
    consistent,
  });
}

const checkedKeys = skip.map((key) => `${key}(${LABELS[key] || "?"})`);
const checkedRows = rows.filter((row) => row.checked);
const mismatch = rows.filter((row) => !row.consistent);

if (hasFlag("--json")) {
  console.log(JSON.stringify({ skipCategories: skip, rows, mismatch: mismatch.length }, null, 2));
  process.exit(0);
}

console.log(`已勾选的跳过类型：${checkedKeys.length ? checkedKeys.join("、") : "（无）"}`);
console.log(`扫描到 ${rows.length} 条已有 AI 判定结果的视频\n`);

if (checkedRows.length) {
  console.log("【命中勾选类型的视频】");
  for (const row of checkedRows) {
    const judged = row.expect === "skip" ? (row.force ? "跳过（勾选即跳）" : "跳过（无实质内容）") : "保留写笔记";
    console.log(`· ${row.title}`);
    console.log(`   AI 判型=${row.contentType}  勾选=${row.checked ? "是" : "否"}  要点${row.keyIdeas}条/步骤${row.actions}条  → 判定=${judged}  实际状态=${row.actual}`);
    if (hasFlag("--explain")) {
      console.log(`   → ${row.force
        ? "内容型类型，勾选后一律跳过（不看有没有要点）"
        : (row.substance
          ? `有实质内容（要点 ${row.keyIdeas} 条 / 步骤 ${row.actions} 条），按「有干货不跳过」的保护规则保留`
          : "无实质内容，按勾选应当跳过")}`);
    }
  }
  console.log("");
} else {
  console.log("【命中勾选类型的视频】库里暂时没有该类视频的 AI 判定结果\n");
}

console.log("【全部类型分布】");
const dist = {};
for (const row of rows) dist[row.contentType] = (dist[row.contentType] || 0) + 1;
console.log(JSON.stringify(dist));

console.log(`\n判定与实际状态${mismatch.length ? "不一致" : "全部一致"}：${mismatch.length} 条（不一致通常是规则调整前就已生成的历史笔记，不影响新视频）`);
for (const row of mismatch) {
  console.log(`  ✗ ${row.title} 期望=${row.expect} 实际=${row.actual}`);
}

// 无勾选类型时，说明一下哪些类型"本来会被跳"但没勾
const wouldSkip = rows.filter((row) => row.skipKey && !row.checked && !row.substance);
if (wouldSkip.length) {
  console.log(`\n另有 ${wouldSkip.length} 条无实质内容的视频，因为你没勾选对应类型，正常生成了笔记`);
}
