import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listSaved } from "./opencli.mjs";
import { freezeMedia } from "./media.mjs";
import { transcribeMedia } from "./transcribe.mjs";
import { recognizeImages } from "./ocr.mjs";
import { extractKnowledge, suggestSubcategory, classifyByKeywords, EXTRACTOR_VERSION } from "./knowledge.mjs";
import { writeObsidianNote, cleanNoteTitle } from "./obsidian.mjs";
import { runSemanticConsensus, llmJson } from "./consensus.mjs";
import { updateConsensusDoc } from "./consensus-doc.mjs";
import { loadCategoryTree, saveCategoryTree, registerVideo, listAllSubcategoryCandidates, normalizeMajorCategory } from "./classify.mjs";
import { resolveVaultLayout } from "./vault.mjs";
import { root as repoRoot } from "./config.mjs";

const execFileAsync = promisify(execFile);

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export async function discover(config, store, { includePlayUrl = false, limit = config.discoveryLimit } = {}) {
  const rows = await listSaved({ limit, includePlayUrl });
  for (const row of rows) store.upsertDiscovered(row);
  return rows;
}

export async function ingestFavorites(config, store, { file = "", maxItems = 0 } = {}) {
  const limit = Math.max(1, Math.min(maxItems || config.collectorMaxItems, 10000));
  let inputFile = String(file || "").trim();
  if (!inputFile) {
    inputFile = path.join(config.stateDir, "api-collection.json");
    const collector = path.join(repoRoot, "scripts", "collect-favorites.py");
    await execFileAsync(config.pythonCommand, [
      collector, "collect",
      "--max-items", String(limit),
      "--output", inputFile,
    ]);
  }
  if (!fs.existsSync(inputFile)) throw new Error(`collection file not found: ${inputFile}`);
  const payload = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  const items = Array.isArray(payload) ? payload : payload.items;
  if (!Array.isArray(items)) throw new Error("collection payload must be an array or an object containing items");
  // 收藏夹采集输出顶层带 collects_id/collects_name，合并进每条视频以便入库溯源与强制大类
  const folderId = String(payload?.collects_id || "");
  const folderName = String(payload?.collects_name || "").trim();
  let inserted = 0;
  // 收藏列表是按收藏时间倒序返回的：列表里的位置（0=最前=最新收藏）才是"最新收藏"的唯一可靠依据，
  // 入库时间只精确到毫秒且整批几乎相同，靠它排序等于随机。
  const batchAt = String(payload?.batch_at || new Date().toISOString());
  items.forEach((item, index) => {
    store.upsertDiscovered({
      ...item,
      collects_id: folderId || item.collects_id,
      collects_name: folderName || item.collects_name,
      list_rank: index,
      collect_batch: batchAt,
    });
    inserted += 1;
  });
  return { inserted, input: inputFile, collects_id: folderId, collects_name: folderName, counts: store.counts() };
}

export function writeDailyReport(config, store, { date = "" } = {}) {
  const day = String(date || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`invalid report date: ${day}`);
  const layout = resolveVaultLayout(config);
  const reportDir = path.join(layout.root, "日报");
  fs.mkdirSync(reportDir, { recursive: true });
  const rows = store.listWrittenOn(day);
  const lines = [
    "---",
    `date: "${day}"`,
    "source: \"collection\"",
    `new_count: ${rows.length}`,
    "---",
    "",
    `# ${day} 抖音收藏日报`,
    "",
    rows.length > 0 ? `今日新增 ${rows.length} 条。` : "今日没有新增条目。",
    "",
  ];
  if (rows.length > 0) {
    lines.push("## 新增笔记", "");
    for (const row of rows) {
      const noteName = row.note_path ? path.basename(row.note_path, path.extname(row.note_path)) : row.aweme_id;
      const author = row.author ? ` - ${row.author}` : "";
      const title = String(row.title || row.aweme_id).replace(/\|/gu, "/");
      lines.push(`- [[${noteName}|${title}]]${author} ([原链接](${row.source_url}))`);
    }
    lines.push("");
  }
  const target = path.join(reportDir, `${day}-收藏日报.md`);
  fs.writeFileSync(target, lines.join("\n"), "utf8");
  return { date: day, count: rows.length, path: target };
}

export async function freeze(config, store, { limit = 1, awemeId = "" } = {}) {
  const candidates = awemeId
    ? [store.get(awemeId)].filter(Boolean)
    : store.list({ limit: 100000 }).filter(row => {
      if (row.status === "written") return false;
      if (!row.play_url) return false;
      return !row.media_path || !fs.existsSync(row.media_path);
    });
  const results = [];
  for (const row of candidates.slice(0, limit)) {
    try {
      const artifact = await freezeMedia(row, config);
      store.markMediaFrozen(row.aweme_id, artifact);
      results.push({ aweme_id: row.aweme_id, status: "media_frozen", ...artifact });
    } catch (error) {
      store.markFailed(row.aweme_id, error?.message || error, "discovered");
      results.push({ aweme_id: row.aweme_id, status: "failed", error: String(error?.message || error) });
    }
  }
  return results;
}

export async function transcribe(config, store, { limit = 1, awemeId = "" } = {}) {
  const candidates = awemeId
    ? [store.get(awemeId)].filter(Boolean)
    : store.list({ status: "media_frozen", limit });
  const results = [];
  for (const item of candidates.slice(0, limit)) {
    try {
      if (!item.media_path || !fs.existsSync(item.media_path)) {
        throw new Error("media artifact is missing; freeze the item first");
      }
      const artifact = await transcribeMedia(item, config);
      store.markTranscribed(item.aweme_id, artifact);
      results.push({ aweme_id: item.aweme_id, status: "transcribed", ...artifact });
    } catch (error) {
      store.markFailed(item.aweme_id, error?.message || error, "media_frozen");
      results.push({ aweme_id: item.aweme_id, status: "failed", error: String(error?.message || error) });
    }
  }
  return results;
}

export async function extract(config, store, { limit = 1, awemeId = "" } = {}) {
  const candidates = awemeId ? [store.get(awemeId)].filter(Boolean) : store.list({ status: "transcribed", limit });
  const results = [];
  for (const item of candidates.slice(0, limit)) {
    try {
      const artifact = await extractKnowledge(item, config);
      store.markExtracted(item.aweme_id, artifact);
      results.push({ aweme_id: item.aweme_id, status: "extracted", ...artifact });
    } catch (error) {
      store.markFailed(item.aweme_id, error?.message || error, "transcribed");
      results.push({ aweme_id: item.aweme_id, status: "failed", error: String(error?.message || error) });
    }
  }
  return results;
}

export async function write(config, store, { limit = 1, awemeId = "" } = {}) {
  const candidates = awemeId ? [store.get(awemeId)].filter(Boolean) : store.list({ status: "extracted", limit });
  const results = [];
  for (const item of candidates.slice(0, limit)) {
    try {
      const artifact = writeObsidianNote(item, config);
      const meta = knowledgeMeta(item);
      store.markWritten(item.aweme_id, artifact, meta.category, meta.subcategory, meta.group);
      registerNoteInTree(config, item, meta);
      const mediaRemoved = deleteMediaIfConfigured(config, item);
      results.push({ aweme_id: item.aweme_id, status: "written", ...artifact, media_removed: mediaRemoved });
    } catch (error) {
      store.markFailed(item.aweme_id, error?.message || error, "extracted");
      results.push({ aweme_id: item.aweme_id, status: "failed", error: String(error?.message || error) });
    }
  }
  return results;
}

function knowledgeMeta(item) {
  try {
    if (!item?.knowledge_path || !fs.existsSync(item.knowledge_path)) return { category: "", group: "", subcategory: "", sampleText: "" };
    const knowledge = JSON.parse(fs.readFileSync(item.knowledge_path, "utf8"));
    return {
      category: String(knowledge.category || ""),
      group: String(knowledge.group || ""),
      subcategory: String(knowledge.subcategory || ""),
      sampleText: String(knowledge.thesis || knowledge.summary || "").slice(0, 120),
    };
  } catch {
    return { category: "", group: "", subcategory: "", sampleText: "" };
  }
}

function registerNoteInTree(config, item, meta = knowledgeMeta(item)) {
  if (!config.classifyDynamicSubcategories) return;
  const tree = loadCategoryTree(config);
  registerVideo(config, tree, { major: meta.category, group: meta.group, sub: meta.subcategory, awemeId: item.aweme_id, sampleText: meta.sampleText, forcedMajor: item.collects_name || "" });
  saveCategoryTree(config, tree);
}

export function deleteMediaIfConfigured(config, item) {
  const mediaPath = item?.media_path;
  if (!mediaPath || !fs.existsSync(mediaPath)) return false;
  // 开启永久保留：移动到用户指定路径，不删除
  if (config.keepOriginalVideos && config.customMediaSavePath) {
    try {
      const authorFolder = cleanNoteTitle(item.author || "未知作者", "");
      const targetDir = path.join(config.customMediaSavePath, authorFolder);
      fs.mkdirSync(targetDir, { recursive: true });
      const ext = path.extname(mediaPath);
      const baseName = cleanNoteTitle(item.title, item.aweme_id);
      const target = path.join(targetDir, `${baseName}${ext}`);
      fs.renameSync(mediaPath, target);
      return true;
    } catch {
      return false;
    }
  }
  if (!config.deleteMediaAfterWrite) return false;
  try {
    fs.rmSync(mediaPath, { force: true });
    return true;
  } catch {
    // best-effort cleanup; a locked file should not fail the pipeline
  }
  return false;
}

export function pruneMedia(config, store) {
  const rows = store.list({ limit: 100000 });
  let removed = 0;
  let bytesFreed = 0;
  for (const row of rows) {
    if (row.status === "written" && row.media_path && fs.existsSync(row.media_path)) {
      try {
        const size = fs.statSync(row.media_path).size;
        fs.rmSync(row.media_path, { force: true });
        removed += 1;
        bytesFreed += size;
      } catch {
        // best-effort cleanup
      }
    }
  }
  return { removed, bytesFreed, counts: store.counts() };
}

/** 存量 written 笔记迁移到 大类/子类 目录：判定子类 → 重写 knowledge.json → 移动笔记 → 登记分类树。 */
/** 三级分类建议：给定知识摘要，判断 大类/主题父类/具体子类。 */
async function suggestGroupedCategory(config, knowledge, candidates) {
  const prompt = [
    "根据下面视频的知识摘要，把它归入最合适的分类（三级：大类/主题父类/具体子类）。",
    "大类优先原则：「其他」是最后兜底，不是省事选项。只要有任何一个大类能大致涵盖内容，就必须选那个大类（例：传统/桌面/棋牌/猜谜类游戏 → 大类「游戏」；手工/收纳/生活妙招 → 「生活技巧」；历史文化/民俗/民间技艺讲解 → 「教育学习」）。只有确实无法归入任何大类时才用「其他」。",
    "概念：group=主题父类，是宏观的主题领域（4-16 字，如：AI与剪辑、Codex、基金、徒步攻略、AI网页生成）；subcategory=具体子类，是该父类下的具体内容（2-14 字，如：达芬奇AI景深对焦、AI剪辑省Token、纳斯达克、标普500、云南旅游攻略）。group 和 subcategory 必须是不同粒度、不能同名。",
    "归并规则：若候选列表里已有主题相同或相近的父类/子类，必须沿用其名字；同地点/同工具/同标的的不同叫法视为同一类（如“广西戈见山”与“河池戈见”同为“戈见山徒步攻略”）；拿不准时优先归入已有类，不要轻易新建。",
    "预置主题父类规则（用于旧式两级分类的归并，同类必须归入）:",
    "- AI与科技 下：剪辑/生成/编辑/复刻/拉片/景深/省Token/换景换角/PPT生成/视频美学 等视频制作类 → 父类「AI与剪辑」；任何 Codex 相关（安装、代剪、制作网站、自动剪辑工作台、开发）→ 父类「Codex」；AI 生成网页/3D网页 → 父类「AI网页生成」；AI 情感分析/聊天回复/军师 → 父类「AI情感助手」；其他 AI 类按主题自建父类。",
    "- 财经与投资 下：定投/指数/基金/ETF/纳斯达克/标普500/黄金/宽基 → 父类「基金」，具体子类按标的划分（讲纳斯达克 → 纳斯达克，讲标普500 → 标普500，讲黄金 → 黄金）；储蓄/资产配置/经济周期/境外取现 → 按内容自建父类。",
    "候选列表可能是三级（大类/父类/子类）或两级（大类/旧子类）。两级时，“旧子类”是具体内容名，不能直接当父类——你需按上面规则为它找到或新建宏观主题父类。",
    "返回单个 JSON 对象：{ category, group, subcategory, subcategoryReason }。",
    `现有分类（大类/父类/子类）：\n${candidates.join("\n")}`,
    `标题：${String(knowledge?.title || "")}`,
    `摘要：${String(knowledge?.thesis || "").slice(0, 300)}`,
    `要点：${String(knowledge?.summary || "").slice(0, 300)}`,
    `标签：${(knowledge?.tags || []).join("、")}`,
  ].join("\n");
  const payload = await llmJson(config, "你是严谨的知识分类专家。", prompt, { timeoutMs: 90000 });
  return {
    category: String(payload?.category || ""),
    group: String(payload?.group || ""),
    subcategory: String(payload?.subcategory || ""),
    subcategoryReason: String(payload?.subcategoryReason || ""),
  };
}

export async function reclassifyWritten(config, store, { limit = 100, grouped = false, awemeId = "" } = {}) {
  const rows = awemeId
    ? [store.get(awemeId)].filter(Boolean)
    : store.list({ limit: 100000 }).filter(row => row.status === "written");
  const tree = loadCategoryTree(config);
  // 「其他」下的类目是兜底残留，不能作为归并目标 —— 否则 AI 会看到"已有分类"就一路沿用「其他」，
  // 永远跳不出兜底大类（实测射覆游戏反复被归到「其他/传统文化游戏」）。
  const candidates = listAllSubcategoryCandidates(tree).filter((c) => !String(c).startsWith("其他/"));
  const results = [];
  for (const item of rows.slice(0, limit)) {
    try {
      if (!item.knowledge_path || !fs.existsSync(item.knowledge_path)) throw new Error("knowledge missing");
      const knowledge = JSON.parse(fs.readFileSync(item.knowledge_path, "utf8"));
      if (grouped) {
        const suggestion = await suggestGroupedCategory(config, { ...knowledge, title: item.title }, candidates);
        if (!suggestion.category && !suggestion.subcategory) throw new Error("empty classification suggestion");
        knowledge.category = normalizeMajorCategory(suggestion.category) || knowledge.category;
        knowledge.group = suggestion.group;
        knowledge.subcategory = suggestion.subcategory || knowledge.subcategory;
        knowledge.subcategoryReason = suggestion.subcategoryReason;
      } else if (!knowledge.subcategory || knowledge.subcategory === "未分类") {
        const suggestion = await suggestSubcategory(config, knowledge);
        knowledge.category = suggestion.category;
        knowledge.group = "";
        knowledge.subcategory = suggestion.subcategory;
        knowledge.subcategoryReason = suggestion.subcategoryReason;
      }
      const content = `${JSON.stringify(knowledge, null, 2)}\n`;
      const sha256 = sha256Text(content);
      fs.writeFileSync(item.knowledge_path, content, "utf8");
      const manifestFile = item.knowledge_path.replace(/knowledge\.json$/u, "knowledge-manifest.json");
      if (fs.existsSync(manifestFile)) {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        manifest.version = EXTRACTOR_VERSION;
        manifest.knowledgeSha256 = sha256;
        fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      }
      const note = writeObsidianNote(item, config);
      if (path.normalize(note.path).toLowerCase() !== path.normalize(item.note_path || "").toLowerCase()) {
        // migrate: remove the old note file after the new one is written
        // Windows 大小写不敏感：必须规范化后比较，否则"旧名与新名只有大小写差异"时会误删新文件
        try { if (item.note_path && fs.existsSync(item.note_path)) fs.rmSync(item.note_path, { force: true }); } catch {}
      }
      store.markWritten(item.aweme_id, note, knowledge.category, knowledge.subcategory, knowledge.group || "");
      registerNoteInTree(config, item, { category: knowledge.category, group: knowledge.group || "", subcategory: knowledge.subcategory, sampleText: String(knowledge.thesis || knowledge.summary || "").slice(0, 120) });
      results.push({ aweme_id: item.aweme_id, status: "written", note_path: note.path, category: knowledge.category, group: knowledge.group || "", subcategory: knowledge.subcategory, migrated: note.path !== item.note_path });
    } catch (error) {
      results.push({ aweme_id: item.aweme_id, status: "failed", error: String(error?.message || error) });
    }
  }
  return results;
}

function noteFrontmatterAwemeId(file) {
  try {
    const content = fs.readFileSync(file, "utf8");
    const match = /^aweme_id:\s*"([^"]+)"/mu.exec(content) || /^aweme_id:\s*(\S+)/mu.exec(content);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

/** 把已有笔记的文件名从 aweme_id 改成视频标题（重名时加短 ID 后缀），并同步更新日报里的双链引用。 */
/**
 * 用本地关键词分类（不调用 LLM）重新给已生成笔记归类。
 * 用途：本地抽取器（local-extractive）早期不产出 category，导致历史笔记全落「其他 / 未分类」。
 * 行为：只处理 category 为空/「其他」或 subcategory 为空/「未分类」的笔记；重算后重写 knowledge.json、
 * 重新落盘到对应分类目录、删掉旧位置的 md，并同步数据库。默认 dryRun，只有传 dryRun=false 才真正写盘。
 */
export function reclassifyLocal(config, store, { limit = 1000, dryRun = true, awemeId = "" } = {}) {
  const rows = awemeId
    ? [store.get(awemeId)].filter(Boolean)
    : store.list({ limit: 100000 }).filter(row => row.status === "written");
  const results = [];
  for (const item of rows.slice(0, limit)) {
    const row = { aweme_id: item.aweme_id, title: String(item.title || "").slice(0, 40), before: item.category || "", after: "", note_path: item.note_path || "", changed: false };
    try {
      if (!item.knowledge_path || !fs.existsSync(item.knowledge_path)) throw new Error("knowledge missing");
      const knowledge = JSON.parse(fs.readFileSync(item.knowledge_path, "utf8"));
      // 已有明确分类（非「其他」且 subcategory 非「未分类」）的跳过，避免覆盖用户/AI 已经分好的结果
      const catNow = String(knowledge.category || "").trim();
      const subNow = String(knowledge.subcategory || "").trim();
      if (catNow && catNow !== "其他" && subNow && subNow !== "未分类") {
        row.after = catNow;
        row.note_path = item.note_path || "";
        results.push(row);
        continue;
      }
      const body = [knowledge.thesis, knowledge.summary, (knowledge.tags || []).join(" "), (knowledge.relatedConcepts || []).join(" ")].filter(Boolean).join(" ");
      const category = classifyByKeywords(item.title || "", body);
      row.after = category;
      if (category === catNow && subNow === "未分类") { results.push(row); continue; }
      if (dryRun) { row.changed = true; results.push(row); continue; }
      knowledge.category = category;
      knowledge.group = "";
      if (!subNow || subNow === "未分类") knowledge.subcategory = category === "其他" ? "未分类" : "综合";
      const content = `${JSON.stringify(knowledge, null, 2)}\n`;
      fs.writeFileSync(item.knowledge_path, content, "utf8");
      const manifestFile = item.knowledge_path.replace(/knowledge\.json$/u, "knowledge-manifest.json");
      if (fs.existsSync(manifestFile)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
          manifest.knowledgeSha256 = sha256Text(content);
          fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        } catch {}
      }
      const note = writeObsidianNote(item, config);
      if (item.note_path && path.normalize(note.path).toLowerCase() !== path.normalize(item.note_path).toLowerCase()) {
        try { if (fs.existsSync(item.note_path)) fs.rmSync(item.note_path, { force: true }); } catch {}
      }
      store.markWritten(item.aweme_id, note, knowledge.category, knowledge.subcategory, knowledge.group || "");
      registerNoteInTree(config, item, { category: knowledge.category, group: knowledge.group || "", subcategory: knowledge.subcategory, sampleText: String(knowledge.thesis || knowledge.summary || "").slice(0, 120) });
      row.changed = true;
      row.note_path = note.path;
      row.subcategory = knowledge.subcategory;
      results.push(row);
    } catch (error) {
      row.error = String(error?.message || error);
      results.push(row);
    }
  }
  return results;
}

export function migrateNoteNames(config, store, { limit = 500 } = {}) {
  const rows = store.list({ limit: 100000 }).filter(row => row.status === "written");
  const layout = resolveVaultLayout(config);
  const results = [];
  const linkRenames = [];
  for (const item of rows.slice(0, limit)) {
    try {
      if (!item.note_path || !fs.existsSync(item.note_path)) throw new Error("note file missing");
      const knowledge = item.knowledge_path && fs.existsSync(item.knowledge_path)
        ? JSON.parse(fs.readFileSync(item.knowledge_path, "utf8"))
        : {};
      const category = safeCategoryName(knowledge.category);
      const subcategory = safeCategoryName(knowledge.subcategory);
      const directory = category === "未分类" || !layout.knowledge
        ? layout.inbox
        : subcategory === "未分类"
          ? path.join(layout.knowledge, category)
          : path.join(layout.knowledge, category, subcategory);
      const baseName = cleanNoteTitle(item.title, item.aweme_id);
      let target = path.join(directory, `${baseName}.md`);
      if (target !== item.note_path && fs.existsSync(target)) {
        const existingAweme = noteFrontmatterAwemeId(target);
        if (existingAweme && existingAweme !== item.aweme_id) {
          target = path.join(directory, `${baseName}-${String(item.aweme_id).slice(-8)}.md`);
        }
      }
      if (target === item.note_path) {
        results.push({ aweme_id: item.aweme_id, status: "unchanged", note_path: target });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(item.note_path, target);
      fs.rmSync(item.note_path, { force: true });
      store.updateNotePath(item.aweme_id, target);
      const oldBase = path.basename(item.note_path, path.extname(item.note_path));
      const newBase = path.basename(target, path.extname(target));
      if (oldBase !== newBase) linkRenames.push({ oldBase, newBase });
      results.push({ aweme_id: item.aweme_id, status: "renamed", note_path: target });
    } catch (error) {
      results.push({ aweme_id: item.aweme_id, status: "failed", error: String(error?.message || error) });
    }
  }
  let reportsUpdated = 0;
  if (linkRenames.length && layout.root) {
    const reportDir = path.join(layout.root, "日报");
    if (fs.existsSync(reportDir)) {
      for (const file of fs.readdirSync(reportDir)) {
        if (!file.endsWith(".md")) continue;
        const reportPath = path.join(reportDir, file);
        let content = fs.readFileSync(reportPath, "utf8");
        let changed = false;
        for (const { oldBase, newBase } of linkRenames) {
          const pattern = new RegExp(`\\[\\[\\s*${escapeRegExp(oldBase)}\\b`, "gu");
          if (pattern.test(content)) {
            content = content.replace(pattern, `[[${newBase}`);
            changed = true;
          }
        }
        if (changed) {
          fs.writeFileSync(reportPath, content, "utf8");
          reportsUpdated += 1;
        }
      }
    }
  }
  return { results, reportsUpdated, renamed: results.filter(r => r.status === "renamed").length };
}

function safeCategoryName(value) {
  return String(value || "").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "").trim().slice(0, 40) || "未分类";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 网络类失败（断网/超时/连接重置）：不视为永久失败，保留重试机会。 */
export function isNetworkFailure(message) {
  const text = String(message || "");
  return ["fetch failed", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH",
    "timed out", "timeout", "network", "socket hang up", "SIGTERM"].some(hint => text.includes(hint));
}

/** 视频本身无料导致的永久失败：转录覆盖不足、无可用字幕、知识提取为空。重试结果不变，首次失败即放弃。 */
export function isPermanentFailure(message) {
  const text = String(message || "");
  return /transcription does not cover enough of the media timeline/.test(text)
    || /transcription produced no usable text segments/.test(text)
    || /knowledge field \S+ is empty/.test(text);
}

/** 转录文本"无重点"预筛：整段极短，或去除闲聊/招呼词后没有实质内容 → 直接跳过，不调云端模型。 */
export function transcriptHasSubstance(transcriptPath) {
  let text = "";
  try {
    const t = JSON.parse(fs.readFileSync(transcriptPath, "utf8").replace(/^\uFEFF/u, ""));
    text = Array.isArray(t.segments) ? t.segments.map(s => s.text || "").join(" ") : String(t.text || "");
  } catch {
    return true; // 读不到按有料处理，交给下游报错
  }
  const compact = String(text).replace(/\s+/gu, "");
  if (compact.length < 60) return false;
  const stripped = compact.replace(/(哈+|嘿+|嘻+|呵+|吼+|嗯+|啊+|哦+|呢+|呀+|吧+|嘛+|哟+|啦+|哈喽|你好|美女|帅哥|早安|晚安|再见)+/gu, "");
  return stripped.length >= 30;
}

import { spawn } from "node:child_process";
function writePlaintextNote(item, config, transcriptArtifact) {
  const layout = resolveVaultLayout(config);
  const transcript = JSON.parse(fs.readFileSync(transcriptArtifact.path, "utf8").replace(/^\uFEFF/u, ""));
  const baseName = cleanNoteTitle(item.title, item.aweme_id);
  // 按作者建子文件夹，保持分类结构
  const authorFolder = cleanNoteTitle(item.author || "未知作者", "");
  let target;
  if (config.plaintextOutputFormat === "docx") {
    fs.mkdirSync(path.join(layout.wordDocs, authorFolder), { recursive: true });
    target = path.join(layout.wordDocs, authorFolder, `${baseName}.docx`);
    const meta = {
      来源链接: item.source_url,
      作者: item.author,
      类型: item.is_image ? "图文" : "视频",
      转录来源: transcript.source || "Whisper",
    };
    const args = [
      path.join(root, "scripts", "write-docx.py"),
      "--title", item.title,
      "--description", item.description || item.title,
      "--transcript", transcript.text,
      "--output", target,
      "--meta", JSON.stringify(meta),
    ];
    // 同步调用Python生成Word
    const result = require("child_process").spawnSync(config.pythonCommand, args, {encoding: "utf8"});
    if (result.status !== 0) throw new Error(result.stderr);
  } else {
    fs.mkdirSync(path.join(layout.plaintext, authorFolder), { recursive: true });
    target = path.join(layout.plaintext, authorFolder, `${baseName}.md`);
    const lines = [
      "---",
      `aweme_id: "${item.aweme_id}"`,
      `source_url: "${item.source_url}"`,
      `author: "${item.author}"`,
      `type: "${item.is_image ? "image" : "video"}"`,
      `transcript_source: "${transcript.source || "whisper"}"`,
      `created_at: "${new Date().toISOString()}"`,
      "---",
      "",
      `# ${item.title}`,
      "",
      "## 原文案",
      "",
      item.description || item.title,
      "",
      "## 字幕/识别内容",
      "",
      transcript.text,
      "",
    ];
    fs.writeFileSync(target, lines.join("\n"), "utf8");
  }
  return { path: target, resumed: false };
}

/**
 * 判断 AI 提取结果是否"有实质内容"。
 * 用途：用户勾选了"跳过某类型"时，避免 AI 把有干货的内容（典型：美食教程被判成吃播）静默丢掉。
 * 纯吃喝展示/纯画面流通常没有要点也没有步骤，仍会被正常跳过。
 */
/**
 * 「勾了就一律跳过」的内容型类型：短剧 / 音乐 / 才艺(dance) / 搞笑。
 * 剧情和歌词天然能撑起 keyIdeas，若也走 hasSubstance 保护，这几个勾选项等于永不生效。
 * 广告、吃播、纯风景不在此列 —— 它们容易与教程/探店混淆，仍保留「有干货就保留」的保护。
 */
const FORCE_SKIP_TYPES = new Set(["shortdrama", "music", "dance", "funny"]);

export function knowledgeHasSubstance(data) {  const keyIdeas = Array.isArray(data?.keyIdeas) ? data.keyIdeas.length : 0;
  const actions = Array.isArray(data?.actions) ? data.actions.length : 0;
  const summary = String(data?.summary || "").trim().length;
  const thesis = String(data?.thesis || "").trim().length;
  return keyIdeas >= 2 || actions >= 2 || (summary >= 60 && thesis >= 10);
}

/**
 * 低信息量兜底：内容过少 / AI 提取不出摘要时，不丢视频，直接落一篇"只保留转录原文"的笔记。
 * 不调用云端模型，所以不花 AI 费用；笔记里能看到原话，后续想补也可手动重跑。
 */
export function writeLowSubstanceNote(item, config, store, transcriptArtifact) {
  let text = "";
  try {
    const transcript = JSON.parse(fs.readFileSync(transcriptArtifact.path, "utf8").replace(/^\uFEFF/u, ""));
    text = Array.isArray(transcript.segments) && transcript.segments.length
      ? transcript.segments.map(segment => segment.text || "").join(" ")
      : String(transcript.text || "");
  } catch {}
  const spoken = String(text).replace(/\s+/gu, " ").trim();
  const summary = (spoken || String(item.description || "").trim() || "该视频没有可用的语音或文字内容").slice(0, 800);
  const knowledge = {
    thesis: String(item.title || item.description || "低信息量内容").slice(0, 120),
    summary,
    keyIdeas: [],
    actions: [],
    limitations: ["视频内容过少（或几乎没有有效语音），未做 AI 提炼，只保留了转录原文"],
    verificationNeeds: [],
    relatedConcepts: [],
    tags: ["低信息量", "仅转录"],
    category: "低信息量",
    subcategory: "未分类",
    group: "未分类",
    contentType: "normal",
    lowSubstance: true,
  };
  fs.mkdirSync(config.knowledgeDir, { recursive: true });
  const knowledgePath = path.join(config.knowledgeDir, `${item.aweme_id}.json`);
  const serialized = JSON.stringify(knowledge, null, 2);
  fs.writeFileSync(knowledgePath, serialized, "utf8");
  store.markExtracted(item.aweme_id, {
    path: knowledgePath,
    sha256: sha256Text(serialized),
    provider: "local",
    version: "low-substance-fallback",
  });
  const fresh = store.get(item.aweme_id);
  const note = writeObsidianNote(fresh, config);
  const meta = knowledgeMeta(fresh);
  store.markWritten(fresh.aweme_id, note, meta.category, meta.subcategory, meta.group);
  return { note, meta };
}

export async function sync(config, store, { limit = 1, awemeId = "", skipConsensusDoc = false } = {}) {
  const release = acquireSyncLock(config.stateDir);
  try {
    let rows = [];
    if (awemeId) {
      const item = store.get(awemeId);
      if (item) rows = [item];
    } else {
      rows = await discover(config, store, { includePlayUrl: true, limit: config.discoveryLimit });
      rows = rows.filter(row => !["written", "skipped"].includes(store.get(row.aweme_id)?.status)).slice(0, limit);
    }
    const results = [];
    for (const row of rows) {
      let stage = "discovered";
      // 转录产物可能要在 catch 里用来兜底落笔记，所以在 try 外声明
      let fallbackTranscript = null;
      try {
        let item = store.get(row.aweme_id);
        if (!item.media_path || !fs.existsSync(item.media_path)) {
          const artifact = await freezeMedia(row, config);
          store.markMediaFrozen(row.aweme_id, artifact);
          // 没有可用媒体地址时，直接用现有文案作为转录内容，不报错
          if (artifact.skipped) {
            const tmpTranscriptPath = path.join(config.transcriptDir, `${row.aweme_id}-empty.json`);
            fs.writeFileSync(tmpTranscriptPath, JSON.stringify({
              text: `${row.title || ""}\n${row.description || ""}`,
              segments: [],
              engine: "empty-media",
            }));
            transcriptArtifact = {
              path: tmpTranscriptPath,
              text: `${row.title || ""}\n${row.description || ""}`,
              segments: [],
              engine: "empty-media",
            };
            store.markTranscribed(row.aweme_id, transcriptArtifact);
            stage = "transcribed";
            item = store.get(row.aweme_id);
            // 直接走后续笔记生成流程
            const knowledgeArtifact = await extractKnowledge(item, config);
            store.markExtracted(item.aweme_id, knowledgeArtifact);
            stage = "extracted";
            item = store.get(row.aweme_id);
            const note = writeObsidianNote(item, config);
            store.markWritten(item.aweme_id, note, "未分类", "", "");
            results.push({ aweme_id: item.aweme_id, status: "written", note_path: note.path, no_media: true });
            continue;
          }
        }
        stage = "media_frozen";
        item = store.get(row.aweme_id);
        let transcriptArtifact;
        if (item.is_image) {
          const ocrResult = await recognizeImages(item, config);
          transcriptArtifact = {
            path: ocrResult.path,
            text: ocrResult.text,
            segments: ocrResult.segments,
            engine: ocrResult.engine,
          };
        } else {
          transcriptArtifact = await transcribeMedia(item, config);
        }
        store.markTranscribed(item.aweme_id, transcriptArtifact);
        fallbackTranscript = transcriptArtifact;
        stage = "transcribed";
        item = store.get(row.aweme_id);
        // 字幕无重点：不再强制跳过，只要用户没勾选对应跳过类型，就继续用现有文案生成简单文档
        const hasNoSubstance = !transcriptHasSubstance(transcriptArtifact.path);
        // 纯文档模式：直接输出纯转录文档，哪怕内容少也不跳过，不走AI提炼分类
        if (config.processingMode === "plaintext") {
          const note = writePlaintextNote(item, config, transcriptArtifact);
          store.markWritten(item.aweme_id, note, "纯转录文档", "", "");
          const mediaRemoved = deleteMediaIfConfigured(config, item);
          results.push({ aweme_id: item.aweme_id, status: "written", note_path: note.path, plaintext: true, media_removed: mediaRemoved, empty_transcript: hasNoSubstance });
          continue;
        }
        // 内容过少（整段极短 / 几乎没有效文字）：不调 AI（省费用），直接把转录原文落成一篇简单笔记，
        // 而不是交给 AI 提炼后因"字段为空"被判 permanent-failed 跳过 —— 那样用户会觉得视频丢了。
        if (hasNoSubstance) {
          const fallback = writeLowSubstanceNote(item, config, store, transcriptArtifact);
          const mediaRemoved = deleteMediaIfConfigured(config, store.get(item.aweme_id));
          results.push({
            aweme_id: item.aweme_id,
            status: "written",
            note_path: fallback.note.path,
            low_substance: true,
            note_reason: "转录内容过少，已保留原文未做 AI 提炼",
            media_removed: mediaRemoved,
          });
          continue;
        }
        const knowledgeArtifact = await extractKnowledge(item, config);
        store.markExtracted(item.aweme_id, knowledgeArtifact);
        stage = "extracted";
        item = store.get(row.aweme_id);
        const knowledgeData = JSON.parse(fs.readFileSync(knowledgeArtifact.path, "utf8"));
        const contentType = String(knowledgeData.contentType || "normal");
        const typeMap = {
          "ad": "ad",
          "shortdrama": "shortdrama",
          "funny": "funny",
          "music": "music",
          "dance": "dance",
          "performance": "dance",
          "visual": "silent-no-info",
          "food-show": "mukbang",
        };
        const skipKey = typeMap[contentType];
        const skipEnabled = Boolean(skipKey && (config.skipCategories || []).includes(skipKey));
        // 内容型类型（短剧/音乐/才艺/搞笑）：勾了就无条件跳过。
        // 剧情和歌词天然能提炼出"要点"，如果也走下面的 hasSubstance 保护，
        // 这几个选项永远命不中 —— 用户勾了「跳过短剧」结果一条都没跳。
        const forceSkip = skipEnabled && FORCE_SKIP_TYPES.has(skipKey);
        // 广告/吃播/纯风景保留保护：AI 经常把美食教程、探店判成吃播（food-show），
        // 一旦直接跳过用户会觉得视频"丢了"。有干货就照常写笔记。
        const hasSubstance = knowledgeHasSubstance(knowledgeData);
        const keptDespiteSkip = skipEnabled && !forceSkip && hasSubstance;
        if (skipEnabled && (forceSkip || !hasSubstance)) {
          store.markSkipped(item.aweme_id, `contentType=${contentType}`);
          if (item.media_path && fs.existsSync(item.media_path)) {
            try { fs.rmSync(item.media_path, { force: true }); } catch {}
          }
          results.push({ aweme_id: item.aweme_id, status: "skipped", contentType, forced: forceSkip });
          continue;
        }
        if (keptDespiteSkip) {
          process.stdout.write(`${JSON.stringify({ notice: "内容被判为可跳过类型但有实质内容，已保留生成笔记", aweme_id: item.aweme_id, contentType })}\n`);
        }
        const note = writeObsidianNote(item, config);
        const meta = knowledgeMeta(item);
        store.markWritten(item.aweme_id, note, meta.category, meta.subcategory, meta.group);
        registerNoteInTree(config, item, meta);
        const mediaRemoved = deleteMediaIfConfigured(config, item);
        const consensusResult = config.consensusSemantic
          ? await runSemanticConsensus(config, store, store.get(row.aweme_id)).catch(error => ({ matched: 0, notesUpdated: 0, error: String(error?.message || error) }))
          : null;
        const consensusDoc = !skipConsensusDoc
          ? await updateConsensusDoc(config, store, { awemeId: item.aweme_id }).catch(error => ({ error: String(error?.message || error) }))
          : null;
        results.push({ aweme_id: item.aweme_id, status: "written", note_path: note.path, resumed: note.resumed, media_removed: mediaRemoved, consensus: consensusResult, consensusDoc, kept_despite_skip: keptDespiteSkip });
      } catch (error) {
        const message = error?.message || String(error);
        // AI 提炼"提取不出东西"（字段为空）时不要丢视频：用已有转录兜底落一篇低信息量笔记
        if (stage === "extracted" && fallbackTranscript && /knowledge field \S+ is empty/i.test(message)) {
          try {
            const fallback = writeLowSubstanceNote(store.get(row.aweme_id), config, store, fallbackTranscript);
            results.push({
              aweme_id: row.aweme_id,
              status: "written",
              note_path: fallback.note.path,
              low_substance: true,
              note_reason: "AI 未能提取出摘要，已保留转录原文",
            });
            continue;
          } catch (fallbackError) {
            process.stderr.write(`[low-substance] 兜底落笔记失败 ${row.aweme_id}: ${String(fallbackError?.message || fallbackError)}\n`);
          }
        }
        const wasFailed = store.get(row.aweme_id)?.status === "failed";
        const permanent = isPermanentFailure(message);
        if (permanent || (wasFailed && !isNetworkFailure(message))) {
          // 视频本身无料（覆盖不足/无字幕/提取为空）首次即放弃；或上次已失败、本次重试仍失败（且非网络类）放弃。
          // 两类都不再进入后续任何自动候选，避免无效重试循环。
          store.markSkipped(row.aweme_id, `${permanent ? "permanent-failed" : "retry-failed"}:${stage}: ${message.slice(0, 120)}`);
          results.push({ aweme_id: row.aweme_id, status: "skipped", retryFailed: !permanent, stage, error: message });
        } else {
          // 首次失败，或网络类失败（断网续跑 / 次日网络恢复后仍可重试）
          store.markFailed(row.aweme_id, message, stage);
          results.push({ aweme_id: row.aweme_id, status: "failed", stage, error: message });
        }
      }
    }
    return results;
  } finally {
    release();
  }
}

export function acquireSyncLock(stateDir, staleAfterMs = 6 * 60 * 60 * 1000) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "sync.lock");
  try {
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    const age = Date.now() - Date.parse(existing.startedAt || 0);
    let processAlive = false;
    try {
      process.kill(Number(existing.pid), 0);
      processAlive = true;
    } catch {}
    if (!processAlive || age > staleAfterMs) fs.rmSync(file, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") fs.rmSync(file, { force: true });
  }
  let descriptor;
  try {
    descriptor = fs.openSync(file, "wx");
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("another sync is already running");
    throw error;
  }
  return () => {
    try { fs.closeSync(descriptor); } catch {}
    fs.rmSync(file, { force: true });
  };
}
