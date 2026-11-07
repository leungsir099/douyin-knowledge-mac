import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listAllSubcategoryCandidates, loadCategoryTree, normalizeMajorCategory } from "./classify.mjs";
import { llmJson, friendlyAIError, recordApiUsage } from "./consensus.mjs";

export const KNOWLEDGE_SCHEMA_VERSION = 1;
export const EXTRACTOR_VERSION = "1.0.3";

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  try {
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function clean(value, max = 600) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, max);
}

function timestamp(seconds) {
  const value = Math.max(0, Math.round(Number(seconds || 0)));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function joinWindow(segments, startIndex, maxCharacters = 130) {
  let text = "";
  let end = Number(segments[startIndex]?.end || 0);
  for (let index = startIndex; index < segments.length; index += 1) {
    const next = clean(segments[index]?.text, 240);
    if (!next) continue;
    if (text && text.length + next.length > maxCharacters) break;
    text += next;
    end = Number(segments[index]?.end || end);
  }
  return { text, end };
}

function uniqueStrings(values, limit = 12) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = clean(value, 80);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

// 本地抽取降级时的关键词粗分类：根据标题+转录命中 16 大类关键词，给出尽量贴切的大类；
// 命中多个时取命中数最多者，全部未命中则归「其他」。仅在未接入 LLM 提取器（local-extractive）时兜底使用，
// 避免所有本地抽取笔记都被丢进「其他 / 未分类」。
const LOCAL_CATEGORY_KEYWORDS = [
  { cat: "旅游出行", words: ["旅行", "旅游", "攻略", "徒步", "景点", "出行", "自驾", "秘境", "风景", "打卡", "宝藏地", "民宿", "路线", "雪山", "村落", "草原", "vlog", "旅拍", "周边游", "游玩", "逛吃", "一日游"] },
  { cat: "美食", words: ["美食", "食谱", "做法", "教程", "探店", "好吃", "餐厅", "烘焙", "做饭", "食材", "甜点", "小吃", "菜谱", "下饭", "酸汤", "蒜香", "下饭菜"] },
  { cat: "AI与科技", words: ["人工智能", "大模型", "智能体", "机器人", "科技", "数码", "算法", "代码", "编程", "机器学习", "深度学习"] },
  { cat: "工具软件", words: ["软件", "工具", "插件", "快捷键", "效率", "系统", "设置", "路由器", "ipv6", "应用", "电脑", "windows"] },
  { cat: "健身与健康", words: ["健身", "运动", "减肥", "跑步", "瑜伽", "健康", "拉伸", "增肌", "饮食", "睡眠", "游泳", "羽毛球"] },
  { cat: "财经与投资", words: ["理财", "基金", "股票", "投资", "赚钱", "副业", "存款", "保险", "黄金", "指数", "纳斯达克", "标普"] },
  { cat: "教育学习", words: ["学习", "考试", "读书", "笔记", "英语", "考研", "课程", "教学", "知识点", "讲解"] },
  { cat: "生活技巧", words: ["生活", "技巧", "收纳", "省钱", "好物", "防水", "实用", "日常", "妙招", "家居", "清洁", "手机", "推荐"] },
  { cat: "情感心理", words: ["情感", "心理", "恋爱", "婚姻", "关系", "情绪", "治愈"] },
  { cat: "穿搭与时尚", words: ["穿搭", "时尚", "妆容", "美妆", "发型"] },
  { cat: "影视娱乐", words: ["电影", "电视剧", "综艺", "明星", "剧情", "演员", "翻唱", "原创剧集", "剧集"] },
  { cat: "游戏", words: ["游戏", "手游", "主机", "steam", "原神"] },
  { cat: "自媒体与运营", words: ["自媒体", "运营", "账号", "涨粉", "剪辑", "获客", "流量", "口播", "个人ip", "变现"] },
  { cat: "职场与成长", words: ["职场", "工作", "面试", "沟通", "管理"] },
];

export function classifyByKeywords(text, extra = "") {
  // text 通常是标题（权重 3，最能代表主题）；extra 是正文/摘要（权重 1），避免长文本里
  // 某个词偶然出现多次就把整篇带偏（例："射覆游戏"摘要里出现两次"生活物品"会被误判生活技巧）。
  const head = String(text || "").toLowerCase();
  const body = String(extra || "").toLowerCase();
  if (!head.trim() && !body.trim()) return "其他";
  let best = "其他", bestScore = 0;
  for (const { cat, words } of LOCAL_CATEGORY_KEYWORDS) {
    let score = 0;
    for (const w of words) {
      const lw = w.toLowerCase();
      if (head.includes(lw)) score += 3;
      else if (body.includes(lw)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best;
}

function localExtract(item, transcript) {
  const segments = transcript.segments.filter(segment => clean(segment.text));
  const duration = Number(transcript.duration || segments.at(-1)?.end || 0);
  const marker = /第[一二三四五六七八九十\d]+步|关键|核心|误区|本质|所以|不是.*而是|具体/u;
  const selected = [];
  const candidateIndexes = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => marker.test(clean(segment.text)))
    .map(({ index }) => index);
  const anchors = uniqueStrings([
    "0",
    ...candidateIndexes.map(String),
    String(Math.max(0, Math.floor(segments.length / 2))),
    String(Math.max(0, segments.length - 4)),
  ], 7).map(Number).sort((a, b) => a - b);
  for (const index of anchors) {
    const window = joinWindow(segments, index);
    if (!window.text || selected.some(entry => entry.detail.includes(window.text.slice(0, 24)))) continue;
    selected.push({
      timestampSeconds: Number(segments[index].start || 0),
      timestamp: timestamp(segments[index].start),
      title: clean(window.text, 30),
      detail: clean(window.text, 180),
      sourceExcerpt: clean(window.text, 120),
    });
  }
  const actionIndexes = segments
    .map((segment, index) => ({ text: clean(segment.text), index }))
    .filter(entry => /第[一二三四五六七八九十\d]+步|你要做|具体怎么做/u.test(entry.text));
  const actions = actionIndexes.slice(0, 6).map(({ index }) => {
    const window = joinWindow(segments, index, 170);
    return {
      timestampSeconds: Number(segments[index].start || 0),
      timestamp: timestamp(segments[index].start),
      action: clean(window.text, 180),
      completionSignal: "已形成一个可复查的具体产物或观察结果。",
    };
  });
  if (!actions.length) {
    actions.push({
      timestampSeconds: Number(segments[0].start || 0),
      timestamp: timestamp(segments[0].start),
      action: `根据视频观点，先完成一次小范围实践：${clean(selected[0]?.detail || transcript.text, 120)}`,
      completionSignal: "实践结果、遇到的问题和下一步调整已被记录。",
    });
  }
  const hashTags = [...String(item.title || "").matchAll(/#([^#\s]+)/gu)].map(match => match[1]);
  const concepts = ["AI", "自媒体", "口播", "内容", "用户", "账号", "知识", "剪辑", "个人IP", "获客", "运营"]
    .filter(word => String(transcript.text || "").includes(word) || String(item.title || "").includes(word));
  const claims = segments.filter(segment => /大多数|一定|真正|赚到|提升|降低|最好|必须|百分之|\d+%/u.test(clean(segment.text))).slice(0, 6);
  const conclusion = joinWindow(segments, Math.max(0, segments.length - 5), 160).text;
  const titleThesis = clean(String(item.title || "").split("#")[0].replace(/@\S+/gu, ""), 180);
  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    thesis: clean(titleThesis.length >= 8 ? titleThesis : (conclusion || selected[0]?.detail || item.title), 180),
    summary: clean(selected.slice(0, 4).map(entry => entry.detail).join("；"), 700),
    keyIdeas: selected.slice(0, 7),
    actions,
    limitations: [
      "该笔记由自动转录与提取生成，专有名词和同音词可能存在识别误差。",
      "视频中的经验性判断代表创作者观点，未自动视为已验证事实。",
    ],
    verificationNeeds: claims.map(segment => ({
      timestampSeconds: Number(segment.start || 0),
      timestamp: timestamp(segment.start),
      claim: clean(segment.text, 180),
      reason: "包含概括性、效果性或商业结果判断，需要结合外部证据验证。",
    })),
    tags: uniqueStrings(["抖音收藏", "待实践", ...hashTags, ...concepts], 12),
    relatedConcepts: uniqueStrings(concepts, 10),
    group: "",
    // 本地抽取没有 LLM 分类能力，用关键词粗分大类；接入 LLM 提取器后此处会被 openAiExtract 覆盖。
    category: classifyByKeywords(item.title || "", transcript?.text || ""),
    contentType: "normal",
  };
}

function transcriptForPrompt(transcript) {
  return transcript.segments
    .map(segment => `[${timestamp(segment.start)}] ${clean(segment.text, 500)}`)
    .join("\n");
}

async function openAiExtract(item, transcript, config, allSubcategoryCandidates = [], forcedMajor = "") {
  if (!config.cloudTranscriptOptIn) {
    throw new Error("cloud transcript extraction is disabled; set cloudTranscriptOptIn=true explicitly");
  }
  if (!config.llmApiKey || !config.llmModel) {
    throw new Error("OpenAI-compatible extraction requires DOK_LLM_API_KEY and DOK_LLM_MODEL");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  const forced = String(forcedMajor || "").trim();
  const categoryRules = [];
  if (forced) {
    // 收藏夹模式：收藏夹标题就是最大父类，AI 只在它下面规划 group（主题父类）/ subcategory（具体子类）
    categoryRules.push(`category 必须等于「${forced}」（本视频来自抖音收藏夹「${forced}」，该收藏夹就是最大类目），只输出这一个类目名，不要改成任何候选类目名。`);
  } else {
    categoryRules.push("category 必须从下列候选类目中选一个最贴切的，只能输出一个类目名，不要自造：AI与科技、编程开发、工具软件、自媒体与运营、职场与成长、财经与投资、生活技巧、美食、健身与健康、穿搭与时尚、教育学习、影视娱乐、游戏、旅游出行、情感心理、其他。");
    // 大类优先原则：不要图省事丢「其他」，只有所有大类都完全不沾边时才允许用「其他」
    categoryRules.push("「其他」是最后兜底，不是省事选项：只要有任何一个大类能大致涵盖内容，就必须选那个大类，不能选「其他」。例如传统/桌面/棋牌类游戏归「游戏」，手工/收纳/生活妙招归「生活技巧」，历史文化讲解归「教育学习」，民间技艺/民俗归「教育学习」或「生活技巧」。只有当内容确实无法归入以上任何一个大类时，才输出「其他」。");
  }
  if (allSubcategoryCandidates.length) {
    categoryRules.push("group 是主题父类（4-16 字，具体到主题领域，如：AI与剪辑、Codex、基金、徒步攻略、咖啡测评）。它是同类具体子类的归类容器。若下面候选列表里已有主题相同或相近的父类，group 必须沿用那个父类的名字；只有找不到任何相近父类时才新建。同一地点/同一工具/同一主题的不同叫法必须归入同一父类（如“达芬奇AI景深对焦”“AI剪辑省Token”都属于父类“AI与剪辑”；“Codex安装使用”“Codex代剪”都属于父类“Codex”；“纳斯达克”“标普500”都属于父类“基金”）。拿不准时优先归入已有父类，不要轻易新建。");
    categoryRules.push("group 和 subcategory 必须是不同粒度、不能同名：group 是宏观主题领域，subcategory 是该父类下的具体内容。预置父类规则（同类必须归入）：AI与科技 下的剪辑/生成/编辑/复刻/拉片/景深/省Token/PPT/视频美学等视频制作类 → 父类「AI与剪辑」，任何 Codex 相关 → 父类「Codex」，AI 生成网页 → 父类「AI网页生成」，AI 情感类 → 父类「AI情感助手」；财经与投资 下的定投/指数/基金/ETF/纳斯达克/标普500/黄金 → 父类「基金」，具体子类按标的划分（讲纳斯达克 → 纳斯达克，讲标普500 → 标普500）。");
    categoryRules.push("subcategory 是该视频在父类下的具体内容小类（如：达芬奇AI景深对焦、AI剪辑省Token、Codex安装、纳斯达克、标普500、云南旅游攻略）。若已有同父类下存在主题明显相同的子类，必须沿用那个子类的名字；否则新建一个简洁的具体子类名（2-14 字），不要包含作者名。");
    categoryRules.push("下面列出知识库里已存在的全部分类（格式：大类/父类/子类）：");
    categoryRules.push(allSubcategoryCandidates.join("\n"));
  } else {
    categoryRules.push("group 是主题父类（4-16 字，具体到主题领域，如：AI与剪辑、Codex、基金、徒步攻略）。");
    categoryRules.push("subcategory 是该视频在父类下的具体内容小类（如：达芬奇AI景深对焦、AI剪辑省Token、纳斯达克、云南旅游攻略），自建简洁的具体子类名（2-14 字），不要包含作者名。");
  }
  categoryRules.push("subcategoryReason 用 10-30 字说明为何归入该父类/子类（或为何新建）。");
  categoryRules.push("contentType 只允许九个值之一，判断视频类型：ad=广告/带货推广（挂车、引导购买、品牌宣传）；shortdrama=短剧/剧情演绎（有角色扮演和情节）；funny=搞笑段子/纯娱乐（无知识密度）；music=音乐类（唱歌、乐器演奏、纯音乐、MV、音乐现场，只有歌声/音乐没有讲解知识）；dance=舞蹈类（跳舞、舞蹈表演，只有舞蹈动作没有讲解知识）；performance=才艺表演（魔术、杂技、模仿、cosplay 等纯表演，没有讲解知识）；visual=纯画面内容（萌宠、风景大片、城市夜景、自然奇观等没有讲解的画面流，转录里没有可提炼的知识）；food-show=吃播/纯吃喝展示（大胃王、咀嚼声、只展示吃的过程，没有做法步骤也没有探店信息）；normal=正常的知识/经验/观点分享，包括美食制作教程（有做法步骤、食材用量、技巧讲解）、探店测评（有店铺信息、口味评价）、食谱分享等有信息量的内容。拿不准时优先选 normal。");
  const prompt = [
    "将下面的中文视频转录提炼为结构化知识。只依据转录，不补造事实。",
    "返回单个 JSON 对象，不要 Markdown。字段必须是：thesis, summary, keyIdeas, actions, limitations, verificationNeeds, tags, relatedConcepts, category, group, subcategory, subcategoryReason, contentType。",
    "keyIdeas 每项：timestampSeconds, timestamp, title, detail, sourceExcerpt。actions 每项：timestampSeconds, timestamp, action, completionSignal。",
    "verificationNeeds 每项：timestampSeconds, timestamp, claim, reason。时间戳必须来自输入。limitations/tags/relatedConcepts 是字符串数组。",
    "【重点标注】在 thesis、summary、keyIdeas 的 detail 等叙述性文本中，用 **加粗** 标记核心概念、重要专有名词、关键数字与结论（每个文本字段 2-5 处，宁缺毋滥，不要整段或全句加粗，也不要加粗连接词/虚词），帮助用户快速抓取重点。",
    ...categoryRules,
    `标题：${clean(item.title, 300)}`,
    `作者：${clean(item.author, 100)}`,
    "转录：",
    transcriptForPrompt(transcript),
  ].join("\n");
  let response;
  try {
    response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "你是严谨的知识提取器。保留来源时间戳，区分观点、行动和待核实主张。" },
          { role: "user", content: prompt },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(friendlyAIError(response.status, await response.text().catch(() => "")));
  const payload = await response.json();
  recordApiUsage(config, payload);
  const content = String(payload?.choices?.[0]?.message?.content || "").replace(/^```(?:json)?\s*|\s*```$/gu, "");
  const result = parseJsonResponse(content);
  result.schemaVersion = KNOWLEDGE_SCHEMA_VERSION;
  return result;
}

/**
 * 模型偶尔会在 JSON 后面补一段说明（或前后加 ``` 围栏），直接 JSON.parse 会报
 * "Unexpected non-whitespace character after JSON"。这里先直解，失败再截最外层花括号重试。
 */
function parseJsonResponse(content) {
  const trimmed = String(content || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(sliced);
    } catch {}
  }
  throw new Error(`AI 返回内容不是合法 JSON：${trimmed.slice(0, 120)}`);
}

function requireString(value, label, max = 4000) {
  if (!clean(value, max)) throw new Error(`knowledge field ${label} is empty`);
}

function validateTimedEntries(entries, label, duration, requiredFields, allowEmpty = false) {
  // 短剧、翻唱、风景 vlog 这类内容本来就没有"可执行行动"，AI 返回空数组是合理的，
  // 早期这里一律抛错会把整条笔记判失败，所以 actions 允许为空。
  if (!Array.isArray(entries)) {
    if (allowEmpty) return [];
    throw new Error(`knowledge field ${label} is empty`);
  }
  if (!entries.length) {
    if (allowEmpty) return [];
    throw new Error(`knowledge field ${label} is empty`);
  }
  for (const [index, entry] of entries.entries()) {
    let seconds = Number(entry?.timestampSeconds);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`${label}[${index}] has an invalid timestamp`);
    // 模型偶尔给出超过视频时长的秒数，直接截断到时长（容错），避免整条笔记作废
    if (seconds > duration) seconds = Math.max(0, duration);
    entry.timestampSeconds = seconds;
    entry.timestamp = timestamp(seconds);
    for (const field of requiredFields) requireString(entry?.[field], `${label}[${index}].${field}`);
  }
  return entries;
}

export function validateKnowledge(knowledge, duration, forcedMajor = "") {
  if (Number(knowledge?.schemaVersion) !== KNOWLEDGE_SCHEMA_VERSION) throw new Error("unsupported knowledge schema version");
  requireString(knowledge.thesis, "thesis", 500);
  requireString(knowledge.summary, "summary", 4000);
  knowledge.keyIdeas = validateTimedEntries(knowledge.keyIdeas, "keyIdeas", duration, ["title", "detail", "sourceExcerpt"]);
  // 影视/音乐/风景类内容常常没有"可执行步骤"，这里允许为空，不让整条笔记作废
  knowledge.actions = validateTimedEntries(knowledge.actions, "actions", duration, ["action", "completionSignal"], true);
  if (!Array.isArray(knowledge.limitations) || !knowledge.limitations.length) throw new Error("knowledge field limitations is empty");
  if (!Array.isArray(knowledge.verificationNeeds)) throw new Error("knowledge field verificationNeeds must be an array");
  for (const [index, entry] of knowledge.verificationNeeds.entries()) {
    let seconds = Number(entry?.timestampSeconds);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`verificationNeeds[${index}] has an invalid timestamp`);
    if (seconds > duration) seconds = Math.max(0, duration);
    entry.timestampSeconds = seconds;
    entry.timestamp = timestamp(seconds);
    requireString(entry.claim, `verificationNeeds[${index}].claim`);
    requireString(entry.reason, `verificationNeeds[${index}].reason`);
  }
  knowledge.tags = uniqueStrings(knowledge.tags || [], 20);
  knowledge.relatedConcepts = uniqueStrings(knowledge.relatedConcepts || [], 20);
  // 收藏夹模式：category 直接用收藏夹标题（最大父类），不归一化到 16 大类
  knowledge.category = String(forcedMajor || "").trim() || normalizeMajorCategory(knowledge.category);
  knowledge.group = clean(knowledge.group, 40) || "";
  // 有大类但没细分时统一落「综合」（避免出现"美食/未分类"这种自相矛盾的显示）；大类都没分出来才是「未分类」
  knowledge.subcategory = clean(knowledge.subcategory, 40) || (knowledge.category && knowledge.category !== "其他" ? "综合" : "未分类");
  knowledge.subcategoryReason = clean(knowledge.subcategoryReason, 60);
  return knowledge;
}

export async function extractKnowledge(item, config, { forcedMajor = "" } = {}) {  if (!item.transcript_path || !fs.existsSync(item.transcript_path)) throw new Error("transcript artifact is missing");
  const transcript = JSON.parse(fs.readFileSync(item.transcript_path, "utf8").replace(/^\uFEFF/u, ""));
  const provider = config.extractorProvider === "openai" ? "openai-compatible" : "local-extractive";
  const label = provider === "openai-compatible" ? `${provider}/${config.llmModel}` : provider;
  const outputDir = path.join(config.knowledgeDir, String(item.aweme_id));
  const outputFile = path.join(outputDir, "knowledge.json");
  const manifestFile = path.join(outputDir, "knowledge-manifest.json");
  const forced = String(forcedMajor || item.collects_name || "").trim();
  if (fs.existsSync(outputFile) && fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.transcriptSha256 === item.transcript_sha256 && manifest.extractor === label && manifest.version === EXTRACTOR_VERSION) {
      const cached = validateKnowledge(JSON.parse(fs.readFileSync(outputFile, "utf8")), Number(transcript.duration || 0), forced);
      const sha256 = sha256Text(`${JSON.stringify(cached, null, 2)}\n`);
      if (sha256 === manifest.knowledgeSha256) return { path: outputFile, sha256, provider: label, version: EXTRACTOR_VERSION, resumed: true };
    }
  }
  const extracted = provider === "openai-compatible"
    ? await openAiExtract(item, transcript, config, listAllSubcategoryCandidates(loadCategoryTree(config)).filter((c) => !String(c).startsWith("其他/")), forced)
    : localExtract(item, transcript);
  const knowledge = validateKnowledge({
    ...extracted,
    provenance: {
      awemeId: String(item.aweme_id),
      canonicalUrl: `https://www.douyin.com/video/${item.aweme_id}`,
      mediaSha256: String(item.media_sha256 || ""),
      transcriptSha256: String(item.transcript_sha256 || ""),
      extractor: label,
      extractorVersion: EXTRACTOR_VERSION,
    },
  }, Number(transcript.duration || 0), forced);
  const content = `${JSON.stringify(knowledge, null, 2)}\n`;
  const sha256 = sha256Text(content);
  atomicWrite(outputFile, content);
  atomicWrite(manifestFile, `${JSON.stringify({
    schemaVersion: 1,
    transcriptSha256: item.transcript_sha256,
    extractor: label,
    version: EXTRACTOR_VERSION,
    knowledgeSha256: sha256,
  }, null, 2)}\n`);
  return { path: outputFile, sha256, provider: label, version: EXTRACTOR_VERSION, resumed: false };
}

/**
 * 为已提取的 knowledge 判定（或新建）子类，供存量笔记 reclassify 使用。
 * 返回 { category, subcategory, subcategoryReason }，全部经过归一化。
 */
export async function suggestSubcategory(config, knowledge) {
  const candidates = listAllSubcategoryCandidates(loadCategoryTree(config));
  const overview = [
    `标题：${clean(knowledge?.thesis || "", 200)}`,
    `摘要：${clean(knowledge?.summary || "", 400)}`,
    ...(knowledge?.keyIdeas || []).slice(0, 6).map(idea => `- ${clean(idea?.title, 40)}：${clean(idea?.detail, 120)}`),
  ].join("\n");
  const system = [
    "你是严谨的知识库分类器。根据视频的标题/摘要/要点，决定它归入哪个大类与子类。",
    "只依据给定文本判断，不臆造主题。",
  ].join("\n");
  const rules = candidates.length
    ? [
      "若视频主题与某个已有子类（格式：大类/子类）明显相同，category 和 subcategory 必须沿用该大类与该子类的名字（不要改名）。",
      "若找不到明显相同的已有子类，category 从候选大类中选最贴切的一个，subcategory 自建简洁新名（4-12 字，具体到主题，如“云南旅游攻略”“AI剪辑”，不要包含作者名）。",
      `现有子类：\n${candidates.join("\n")}`,
    ]
    : ["category 从候选大类中选最贴切的一个，subcategory 自建简洁新名（4-12 字，具体到主题，如“云南旅游攻略”“AI剪辑”，不要包含作者名）。"];
  const user = [
    overview,
    ...rules,
    "候选大类：AI与科技、编程开发、工具软件、自媒体与运营、职场与成长、财经与投资、生活技巧、美食、健身与健康、穿搭与时尚、教育学习、影视娱乐、游戏、旅游出行、情感心理、其他。",
    '返回 JSON：{"category":"大类","subcategory":"子类名","subcategoryReason":"10-20字理由"}',
  ].join("\n\n");
  const payload = await llmJson(config, system, user);
  return {
    category: normalizeMajorCategory(payload?.category),
    subcategory: clean(payload?.subcategory, 40) || "未分类",
    subcategoryReason: clean(payload?.subcategoryReason, 60),
  };
}
