#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, root } from "./config.mjs";
import { StateStore } from "./state.mjs";
import { discover, extract, freeze, ingestFavorites, migrateNoteNames, pruneMedia, reclassifyLocal, reclassifyWritten, sync, transcribe, write, writeDailyReport } from "./workflow.mjs";
import { classifyByKeywords } from "./knowledge.mjs";
import { runConsensus, runSemanticConsensus } from "./consensus.mjs";
import { readConsensusDoc, updateConsensusDoc } from "./consensus-doc.mjs";
import { diagnose } from "./diagnose.mjs";
import { publicConfiguration, updateConfiguration } from "./configure.mjs";
import { schedulerAction } from "./scheduler.mjs";
import { initializeVault, resolveVaultLayout } from "./vault.mjs";
import { writeObsidianNote } from "./obsidian.mjs";
import { buildMajorCard, listMajorCards, readMajorCard } from "./knowledge-card.mjs";
import {
  creatorAnalysisRequests,
  creatorStatus,
  creatorSynthesisRequest,
  ingestCreatorSynthesis,
  ingestCreatorVideoAnalysis,
  prepareCreator,
  resolveCreatorInput,
} from "./creator-workflow.mjs";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

function has(name) {
  return process.argv.includes(name);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 查询系统空闲秒数（Windows: GetLastInputInfo 经 PowerShell 探针；macOS: ioreg HIDIdleTime），失败返回 -1。 */
async function getIdleSeconds() {
  try {
    if (process.platform === "darwin") {
      // ioreg 的 HIDIdleTime 单位是纳秒
      const res = spawnSync("/usr/sbin/ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8", timeout: 15000 });
      if (res.status !== 0) return -1;
      const match = String(res.stdout || "").match(/"HIDIdleTime"\s*=\s*(\d+)/u);
      if (!match) return -1;
      return Math.floor(Number(match[1]) / 1e9);
    }
    const script = path.join(root, "scripts", "get-idle-seconds.ps1");
    const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", timeout: 15000 });
    if (res.status !== 0) return -1;
    const sec = Number(String(res.stdout || "").trim());
    return Number.isFinite(sec) ? sec : -1;
  } catch {
    return -1;
  }
}

/**
 * 暂停检查（每条视频处理前调用）：var\pause.flag 存在则进入等待，
 * 直到用户 resume 删除标志，或（配置了 pauseAutoResumeMinutes>0）系统空闲超过设定分钟数自动继续。
 */
async function checkPauseBeforeNext(config, writeProgress) {
  const flagFile = path.join(config.stateDir, "pause.flag");
  while (fs.existsSync(flagFile)) {
    writeProgress({ stage: "paused", pausedAt: new Date().toISOString() });
    const autoMin = Number(config.pauseAutoResumeMinutes || 0);
    if (autoMin > 0) {
      const idleSec = await getIdleSeconds();
      if (idleSec >= autoMin * 60) {
        try { fs.rmSync(flagFile, { force: true }); } catch {}
        process.stdout.write(`${JSON.stringify({ notice: `system idle ${idleSec}s >= ${autoMin}min; auto-resumed from pause` })}\n`);
        return;
      }
    }
    await sleep(20000);
  }
}

/** 从抖音链接解析视频 ID：支持 /video/N、/note/N、以及 v.douyin.com 短链（跟随重定向取最终 URL 再提取）。返回 { id, canonical, error? } 或 null。 */
async function resolveDouyinVideoId(rawUrl) {
  let url = String(rawUrl || "").trim();
  if (!url) return null;
  const pick = (u) => {
    const m = u.match(/\/(?:video|note)\/(\d{5,})/);
    if (m) return { id: m[1], canonical: `https://www.douyin.com/video/${m[1]}` };
    // fallback：只从路径部分抓 15 位以上数字，避免误抓 query 参数里的时间戳
    const pathOnly = u.split("?")[0].split("#")[0];
    const m2 = pathOnly.match(/(\d{15,})/);
    if (m2) return { id: m2[1], canonical: `https://www.douyin.com/video/${m2[1]}` };
    return null;
  };
  const direct = pick(url);
  if (direct) return direct;
  // 短链：跟随重定向，用完整 Chrome UA 绕开抖音反爬
  const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    const finalUrl = res.url || url;
    const viaRedirect = pick(finalUrl);
    if (viaRedirect) return viaRedirect;
    // 重定向后仍没匹配到：尝试从返回的 HTML 里提取视频 ID（抖音分享页会把 ID 嵌在页面里）
    const html = await res.text();
    const m3 = html.match(/\/(?:video|note)\/(\d{5,})/) || html.match(/"awemeId"\s*:\s*"(\d{5,})"/) || html.match(/modal_id=(\d{5,})/);
    if (m3) return { id: m3[1], canonical: `https://www.douyin.com/video/${m3[1]}` };
    return { id: null, canonical: "", error: `短链重定向后未找到视频ID（status ${res.status}）` };
  } catch (e) {
    return { id: null, canonical: "", error: `短链请求失败：${e.message}` };
  }
}

/**
 * 智能划重点：调用 LLM 在 Markdown 原文基础上给重点词加 **加粗**，绝不增删/改写文字。
 * 返回加粗后的 Markdown；若模型不可用或返回异常则抛错（由调用方决定是否写回）。
 */
async function highlightNote(config, md) {
  // 划重点是纯大模型任务：没 Key 时直接给出可执行的提示，而不是让 fetch 报 401/ENOTFOUND
  if (!config.llmApiKey || !config.llmModel) {
    throw new Error("智能划重点需要 AI Key：请到「设置 → AI 接口」填写 API Key 与模型名后重试");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.llmApiKey}` },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0.2,
        messages: [
          { role: "system", content: "你是文本重点标注助手。只添加 Markdown 加粗标记，绝不增删或改写任何文字，不改变标题层级、列表、链接、代码块与时间戳等结构。" },
          { role: "user", content: `请在不改动任何文字、不增删内容、不改变标题层级/列表/链接/代码块/时间戳的前提下，只对重要名词、核心概念、关键数字与结论用 **加粗** 标记重点（宁缺毋滥，每段落 1-3 处）。直接返回处理后的完整 Markdown：\n\n${md}` },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`LLM 返回 ${response.status}`);
    const payload = await response.json();
    return String(payload?.choices?.[0]?.message?.content || "").replace(/^```(?:markdown)?\s*|\s*```$/giu, "");
  } finally {
    clearTimeout(timer);
  }
}

/** 新增收藏列表（discovered_at ≈ 新增收藏时间）倒序输出，供桌面"新增收藏·核对与补充"页展示。 */
async function listNewArrivals(store, { since = "", days = 0, limit = 100 } = {}) {
  let isoSince = "";
  if (since) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`invalid --since: ${since}`);
    isoSince = new Date(Date.parse(`${since}T00:00:00+08:00`)).toISOString();
  } else if (days > 0) {
    isoSince = new Date(Date.now() - days * 86400 * 1000).toISOString();
  }
  const rows = store.listNewArrivals(isoSince, limit);
  return {
    since: isoSince || null,
    count: rows.length,
    items: rows.map((r) => ({
      aweme_id: r.aweme_id,
      title: String(r.title || ""),
      status: r.status,
      discovered_at: r.discovered_at,
      source_url: r.source_url,
      category: r.category || "",
      group: r.group || "",
      subcategory: r.subcategory || "",
      note_path: r.note_path || "",
      last_error: r.last_error || "",
      // 只保了转录原文的低信息量笔记（extractor_version 由兜底逻辑写入）
      low_substance: String(r.extractor_version || "") === "low-substance-fallback",
    })),
  };
}

/** 批量模式下自动"地址保鲜"：运行超时或连续 403 快失败时，重新采集并导入刷新 play_url。 */
async function refreshPlayUrls(config, store, { reason = "" } = {}) {
  const start = Date.now();
  process.stdout.write(`${JSON.stringify({ notice: "refreshing play_urls", reason })}\n`);
  let ok = false;
  try {
    const collect = spawnSync(config.pythonCommand, ["scripts/collect-favorites.py", "collect"], {
      cwd: root,
      encoding: "utf8",
      timeout: 180000,
    });
    const out = String(collect.stdout || "");
    const parsed = JSON.parse(out);
    ok = parsed?.status === "ok" && (parsed?.count || 0) > 0;
    if (!ok) throw new Error(`collect not ok: ${out.slice(0, 200)}`);
    const file = path.join(config.stateDir, "api-collection.json");
    await ingestFavorites(config, store, { file });
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ notice: "play_url refresh FAILED", error: String(error?.message || error).slice(0, 300) })}\n`);
    return { ok: false, elapsedSec: Math.round((Date.now() - start) / 1000), error: String(error?.message || error).slice(0, 300) };
  }
  return { ok: true, elapsedSec: Math.round((Date.now() - start) / 1000), reason };
}

const command = process.argv[2] || "status";
const config = loadConfig(option("--config"));
const store = new StateStore(config.databaseFile);

/** 网络类失败（断网/超时/连接重置）：等待网络恢复后重试，可无限等。 */
function isNetworkError(message) {
  const text = String(message || "");
  const hints = [
    "fetch failed", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH",
    "timed out", "timeout", "network", "socket hang up", "SIGTERM",
  ];
  return hints.some(hint => text.includes(hint));
}

/** 服务端类失败（地址过期 403、限流 429/5xx、风控 Blocked）：短等重试，次数超限则跳过本轮，等下次采集刷新后自然补上。 */
function isServerError(message) {
  const text = String(message || "");
  const hints = [
    "Blocked", "HTTP 403", "HTTP 404", "HTTP 429", "HTTP 500", "HTTP 502", "HTTP 503",
    "play_url", "precondition", "stream download", "download failed",
  ];
  return hints.some(hint => text.includes(hint));
}

/** 解析跳过原因（items.last_error）。四类：content / permanent / retry / date / window / other。 */
function parseSkipReason(raw) {
  const text = String(raw || "").trim();
  if (!text) return { kind: "other", text: "原因未记录" };
  if (text.startsWith("contentType=")) {
    return { kind: "content", contentType: text.slice("contentType=".length), text: "内容类型跳过" };
  }
  const staged = text.match(/^(permanent-failed|retry-failed):\s*([A-Za-z_]+)\s*:\s*([\s\S]*)$/);
  if (staged) {
    return {
      kind: staged[1] === "permanent-failed" ? "permanent" : "retry",
      stage: staged[2],
      text: String(staged[3] || "").trim().slice(0, 200) || "未提供错误信息",
    };
  }
  if (text.startsWith("before-start-date")) return { kind: "date", text: "早于起始日期，已归档" };
  if (text.startsWith("before-incremental-window")) return { kind: "window", text: "早于增量窗口，已归档" };
  return { kind: "other", text: text.slice(0, 200) };
}

const STAGE_LABEL = {
  discovered: "采集",
  media_frozen: "下载/语音",
  transcribed: "转录",
  extracted: "AI 提炼",
  written: "写笔记",
};

/**
 * 把流水线的英文技术报错翻译成用户能看懂的中文。
 * 止损看板是给人看的，不是运行日志——所以这里优先用固定词典（不花钱、稳定），
 * 词典没覆盖的再由主进程调 AI 补译（结果缓存在 var/reason-zh-cache.json）。
 */
const REASON_ZH_RULES = [
  [/^transcription produced no usable text segments/i, "视频里没识别出可用的人声（可能没有配音、只有背景音乐或纯环境音），转不出文字，没法整理"],
  [/^transcription does not cover enough of the media timeline/i, "语音只覆盖了视频的一小部分，能提取的内容太少，放弃整理"],
  [/^transcription created no transcript file/i, "语音转文字中途没产出结果文件，转录失败"],
  [/^transcription duration differs from the frozen media/i, "转录时长和视频时长对不上（视频可能不完整）"],
  [/^transcription duration is missing/i, "转录结果里没有时长信息，无法校验"],
  [/^transcript artifact is missing/i, "转录结果文件丢了，需要重新转一遍"],
  [/^transcript hash does not match its manifest/i, "转录结果校验不一致（文件被改动或不完整）"],
  [/^media artifact is missing/i, "本地还没准备好视频文件（下载/冻结这一步没完成）"],
  [/^media download returned no response/i, "视频下载没有响应（链接失效或网络被拦）"],
  [/^media download exceeds maximum size/i, "视频文件超过大小上限，为省空间已放弃"],
  [/^downloaded media is unexpectedly small/i, "下载到的文件异常小，等于没下下来"],
  [/^media must contain complete video streams/i, "视频文件不完整（缺视频流/被截断）"],
  [/^media probe is incomplete/i, "读不出视频信息，文件可能已损坏"],
  [/^media duration differs from the saved-video metadata/i, "下载到的时长和平台记录不一致（可能只下到片段）"],
  [/^media redirect limit exceeded/i, "下载跳转次数过多，链接异常"],
  [/^media URL (resolved to a non-public address|host must be public)/i, "视频地址指向内网，出于安全已拦截"],
  [/^media URL must be credential-free/i, "视频地址带登录凭证，出于安全已拦截"],
  [/^another sync is already running/i, "已经有一次处理在跑，这次跳过"],
  [/^OpenAI-compatible extraction requires/i, "没配置 AI 接口（缺 API Key 或模型名），无法提炼"],
  [/^cloud transcript extraction is disabled/i, "没有开启云端转写，本地又转不出文字"],
  [/^knowledge missing/i, "AI 没有产出知识内容"],
  [/^knowledge field .* is empty/i, "AI 提炼出来的结果是空的（视频信息量太少）"],
  [/^empty classification suggestion/i, "AI 没给出分类建议"],
  [/^unsupported knowledge schema version/i, "知识文件版本和当前程序不兼容"],
  [/^note file missing/i, "笔记文件丢失"],
  [/^collection payload must be an array/i, "采集回来的数据格式异常"],
  [/^(fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|socket hang up)/i, "网络中断/超时，等网络恢复后可以重试"],
  [/^HTTP (403|404)/i, "视频地址已失效（403/404），平台的临时链接过期了"],
  [/^HTTP (429|5\d\d)/i, "平台限流或服务异常，稍后重试"],
];

function explainReason(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  // 已经是中文的（部分错误信息本来就是中文），直接用
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw;
  for (const [re, zh] of REASON_ZH_RULES) {
    if (re.test(raw)) return zh;
  }
  return "";
}

/** 读主进程写入的 AI 补译缓存（var/reason-zh-cache.json），词典没覆盖的报错也能显示中文。 */
function loadReasonZhCache(dir) {
  try {
    const file = path.join(dir, "reason-zh-cache.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/**
 * 写当天的「失败视频清单-YYYY-MM-DD.md」到 project/var，供「止损看板」下半部分展示。
 * 之前只有读取端（main.js 的 failures:list）没有任何写入端，导致界面上永远显示"还没有失败清单文件"。
 */
function writeFailReport(store, config) {
  try {
    const dir = path.dirname(config.databaseFile);
    const nowD = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ymd = `${nowD.getFullYear()}-${pad(nowD.getMonth() + 1)}-${pad(nowD.getDate())}`;
    const since = new Date(Date.parse(`${ymd}T00:00:00+08:00`)).toISOString();
    const rows = store.db.prepare(`
      SELECT aweme_id, title, author, status, last_error, resume_status, source_url, updated_at
      FROM items
      WHERE status IN ('failed','skipped') AND updated_at >= ?
      ORDER BY status DESC, updated_at DESC
    `).all(since);
    const failed = rows.filter(row => row.status === "failed");
    const skipped = rows.filter(row => row.status === "skipped");
    const zhCache = loadReasonZhCache(dir);
    const zhOf = (text) => explainReason(text) || zhCache[String(text || "").trim()] || "";
    const lines = [
      `# 失败视频清单 ${ymd}`,
      "",
      `生成时间：${nowD.toLocaleString("zh-CN")}　·　处理失败 **${failed.length}** 条　·　已跳过 **${skipped.length}** 条`,
      "",
      "> 处理失败：卡在某一步，下次「开始处理」会自动重试（网络类可续跑）。",
      "> 已跳过：不会再自动处理，可在「止损看板 → 被跳过的视频」里补笔记或重新处理。",
      "",
      `## 处理失败（${failed.length}）`,
      "",
    ];
    if (!failed.length) lines.push("- 无", "");
    for (const row of failed) {
      const rawMsg = String(row.last_error || "未记录");
      const zh = zhOf(rawMsg);
      lines.push(`- **${row.title || row.aweme_id}**${row.author ? `　@${row.author}` : ""}`);
      lines.push(`  - 卡在：${STAGE_LABEL[row.resume_status] || row.resume_status || "未知"}　原因：${zh || rawMsg.slice(0, 200)}`);
      if (zh) lines.push(`  - 原文：${rawMsg.slice(0, 200)}`);
      if (row.source_url) lines.push(`  - 原视频：${row.source_url}`);
    }
    lines.push("", `## 已跳过（${skipped.length}）`, "");
    if (!skipped.length) lines.push("- 无", "");
    for (const row of skipped) {
      const reason = parseSkipReason(row.last_error);
      let label;
      if (reason.kind === "content") label = `内容类型跳过（${reason.contentType}）`;
      else if (reason.kind === "permanent") label = `无法处理 · ${STAGE_LABEL[reason.stage] || reason.stage}`;
      else if (reason.kind === "retry") label = `重试仍失败 · ${STAGE_LABEL[reason.stage] || reason.stage}`;
      else label = reason.text;
      const zh = reason.kind === "content" ? "" : zhOf(reason.text);
      lines.push(`- **${row.title || row.aweme_id}**${row.author ? `　@${row.author}` : ""}`);
      lines.push(`  - ${label}${zh ? `　原因：${zh}` : (reason.kind === "content" ? "" : `　原因：${reason.text}`)}`);
      if (zh && reason.kind !== "content") lines.push(`  - 原文：${reason.text}`);
      if (row.source_url) lines.push(`  - 原视频：${row.source_url}`);
    }
    lines.push("");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `失败视频清单-${ymd}.md`), lines.join("\n"), "utf8");
    return true;
  } catch (error) {
    process.stderr.write(`[fail-report] 写失败清单失败: ${String(error?.message || error)}\n`);
    return false;
  }
}

try {
  if (command === "creator") {
    const action = process.argv[3] || "status";
    if (action === "resolve") {
      const candidates = await resolveCreatorInput(option("--input"), { limit: Number(option("--limit", "8")) });
      process.stdout.write(`${JSON.stringify({ candidates, requires_confirmation: candidates.length !== 1 }, null, 2)}\n`);
    } else if (action === "prepare") {
      const result = await prepareCreator(config, store, {
        secUid: option("--sec-uid"),
        limit: Number(option("--limit", "30")),
        sourceInput: option("--source-input"),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (action === "requests") {
      const requests = creatorAnalysisRequests(config, store, {
        secUid: option("--sec-uid"),
        limit: Number(option("--limit", "100")),
      });
      process.stdout.write(`${JSON.stringify({ requests }, null, 2)}\n`);
    } else if (action === "ingest-video") {
      const result = ingestCreatorVideoAnalysis(config, store, {
        secUid: option("--sec-uid"),
        awemeId: option("--aweme-id"),
        analysisFile: option("--file"),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (action === "synthesis-request") {
      const result = creatorSynthesisRequest(config, store, { secUid: option("--sec-uid") });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (action === "ingest-synthesis") {
      const result = ingestCreatorSynthesis(config, store, {
        secUid: option("--sec-uid"),
        synthesisFile: option("--file"),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (action === "status") {
      process.stdout.write(`${JSON.stringify(creatorStatus(store, { secUid: option("--sec-uid") }), null, 2)}\n`);
    } else {
      throw new Error(`unknown creator action: ${action}`);
    }
  } else if (command === "consensus") {
    if (option("--semantic") === "true") {
      const item = store.get(option("--aweme-id"));
      const result = await runSemanticConsensus(config, store, item);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const result = await runConsensus(config, store, { awemeId: option("--aweme-id") });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } else if (command === "consensus-doc") {
    const result = has("--read")
      ? readConsensusDoc(config, store, { category: option("--category"), subcategory: option("--subcategory"), group: option("--group") })
      : await updateConsensusDoc(config, store, { awemeId: option("--aweme-id"), category: option("--category"), subcategory: option("--subcategory"), group: option("--group") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "prune") {
    const result = pruneMedia(config, store);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "reclassify") {
    const result = await reclassifyWritten(config, store, {
      limit: Number(option("--limit", "100")),
      grouped: has("--grouped"),
      awemeId: option("--aweme-id"),
    });
    process.stdout.write(`${JSON.stringify({ processed: result, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "rename") {
    const result = migrateNoteNames(config, store, { limit: Number(option("--limit", "500")) });
    process.stdout.write(`${JSON.stringify({ ...result, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "ingest") {
    const result = await ingestFavorites(config, store, {
      file: option("--file"),
      maxItems: Number(option("--max-items", "0")),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "report") {
    const result = writeDailyReport(config, store, { date: option("--date") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "discover") {
    const rows = await discover(config, store, { limit: Number(option("--limit", config.discoveryLimit)) });
    process.stdout.write(`${JSON.stringify({ discovered: rows.length, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "freeze") {
    const rows = await freeze(config, store, {
      limit: Number(option("--limit", "1")),
      awemeId: option("--aweme-id"),
    });
    process.stdout.write(`${JSON.stringify({ processed: rows, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "transcribe") {
    const rows = await transcribe(config, store, {
      limit: Number(option("--limit", "1")),
      awemeId: option("--aweme-id"),
    });
    process.stdout.write(`${JSON.stringify({ processed: rows, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "extract") {
    const rows = await extract(config, store, {
      limit: Number(option("--limit", "1")),
      awemeId: option("--aweme-id"),
    });
    process.stdout.write(`${JSON.stringify({ processed: rows, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "write") {
    const rows = await write(config, store, {
      limit: Number(option("--limit", "1")),
      awemeId: option("--aweme-id"),
    });
    process.stdout.write(`${JSON.stringify({ processed: rows, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "sync") {
    const newest = Number(option("--newest", "0"));
    const pending = Number(option("--pending", "0"));
    if (newest > 0 || pending > 0) {
      const stopAt = Number(option("--stop-at", "0"));
      const scopeLimit = newest > 0 ? newest : pending;
      const targetWritten = stopAt > 0 ? stopAt : 0;
      const processed = [];
      let processedCount = 0; // 已处理视频数（--pending/--newest 的总名额上限控制）
      const affectedSubcategories = new Set();
      const waitMs = Number(option("--wait", "90000"));
      const retryCap = Number(option("--retries", "0"));
      const skipped = new Set();
      const refreshIntervalMs = Number(option("--refresh-minutes", "90")) * 60 * 1000;
      let batchStartedAt = Date.now();
      let fastFailStreak = 0;
      let attempts = 0;
      // 实时进度文件（供桌面应用流水线页显示"本次运行进度"）：{running, done, total, percent}
      const progressFile = option("--progress-file", "");
      let plannedTotal = 0;
      let progressDone = 0;
      const writeProgress = (extra = {}) => {
        if (!progressFile) return;
        const percent = plannedTotal > 0 ? Math.min(100, Math.round((progressDone / plannedTotal) * 100)) : 100;
        try {
          fs.writeFileSync(progressFile, JSON.stringify({ running: true, done: progressDone, total: plannedTotal, percent, updatedAt: new Date().toISOString(), ...extra }));
        } catch {}
      };
      while (true) {
        // --pending/--newest 的语义是「总共处理 N 条就停」，而非每轮 N 条无限续跑。
        // 之前缺少总名额控制，导致「处理 1 条」会一直往后处理到所有待处理清空。
        if (scopeLimit > 0 && processedCount >= scopeLimit) break;
        const elapsedMs = Date.now() - batchStartedAt;
        if (elapsedMs >= refreshIntervalMs || fastFailStreak >= 5) {
          const refresh = await refreshPlayUrls(config, store, {
            reason: elapsedMs >= refreshIntervalMs ? `elapsed ${Math.round(elapsedMs / 60000)}min` : `fast-fail streak ${fastFailStreak}`,
          });
          batchStartedAt = Date.now();
          fastFailStreak = 0;
        }
        let candidates;
        if (pending > 0) {
          const sinceDays = Number(option("--since-days", "0"));
          const sinceDate = option("--since-date", ""); // YYYY-MM-DD：discovered_at >= 该日 00:00（本地，自然日窗口）
          const untilDate = option("--until-date", ""); // YYYY-MM-DD：discovered_at < 该日 00:00（本地）
          const startDate = option("--start-date", ""); // YYYY-MM-DD：只处理【新增收藏/首次采集（discovered_at）在该日（含）之后】的视频，更早的永久跳过（抖音不提供精确收藏时刻，以首次采集时间近似）
          const retrySince = option("--retry-since", ""); // YYYY-MM-DD：把该日 00:00（本地）之后失败的条目纳入候选（次日重试）
          const collectsId = option("--collects-id", ""); // 只处理指定抖音收藏夹（collects_id）内的视频；空=全部收藏视频
          let untilIso = "";
          if (untilDate) {
            untilIso = new Date(Date.parse(`${untilDate}T00:00:00+08:00`)).toISOString();
          } else {
            const nextDay = new Date(Date.now() + 24 * 3600 * 1000);
            untilIso = new Date(`${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, "0")}-${String(nextDay.getDate()).padStart(2, "0")}T00:00:00+08:00`).toISOString();
          }
          let sinceIso = "";
          if (sinceDate) {
            sinceIso = new Date(Date.parse(`${sinceDate}T00:00:00+08:00`)).toISOString();
          } else if (sinceDays > 0) {
            sinceIso = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
          }
          // 按数量快照窗口（--count-window 且已配置）：候选严格锁定在设置时固定的 [sinceIso, untilIso)，后续新收藏不计入
          if (has("--count-window") && config.countWindow) {
            sinceIso = config.countWindow.sinceIso;
            untilIso = config.countWindow.untilIso;
          }
          const retryUpdatedSinceIso = retrySince
            ? new Date(Date.parse(`${retrySince}T00:00:00+08:00`)).toISOString()
            : "";
          // 起始日期语义 = 按新增收藏/首次采集时间（discovered_at）永久打标，由 configure --start-date 完成（此处防御性兜底）
          if (startDate) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error(`invalid --start-date: ${startDate}`);
            const startIso = new Date(Date.parse(`${startDate}T00:00:00+08:00`)).toISOString();
            const marked = store.skipBeforeDiscoveredAt(startIso, "before-start-date");
            if (marked > 0) process.stdout.write(`${JSON.stringify({ notice: `marked ${marked} items collected before start-date as skipped`, startDate })}\n`);
          }
          candidates = store.listPending({
            sinceDiscovered: sinceIso,
            untilDiscovered: untilIso,
            retryUpdatedSince: retryUpdatedSinceIso,
            collectsId,
            limit: scopeLimit > 0 ? Math.max(1, scopeLimit - processedCount) : scopeLimit,
            // recent=最新收藏优先（手动"处理 N 条"用）；oldest=按发布时间从早到晚（定时任务清积压用）
            order: option("--order", "oldest") === "recent" ? "recent" : "oldest",
          });
          // --fill-older：窗口内不够 N 条时，用"窗口之前仍没处理"的旧条目补齐名额。
          // 定时任务专用，解决"某天新增超过 500 条 / 电脑关机几天"导致旧条目永远落在窗口外被漏掉的问题。
          if (has("--fill-older") && candidates.length < scopeLimit) {
            const picked = new Set(candidates.map(row => row.aweme_id));
            const older = store.listPending({
              retryUpdatedSince: retryUpdatedSinceIso,
              collectsId,
              limit: scopeLimit + picked.size,
              order: "oldest",
            }).filter(row => !picked.has(row.aweme_id) && !skipped.has(row.aweme_id)
              && (!sinceIso || String(row.discovered_at || "") < sinceIso));
            const take = older.slice(0, scopeLimit - candidates.length);
            if (take.length) {
              candidates = candidates.concat(take);
              process.stdout.write(`${JSON.stringify({ notice: `窗口内只有 ${picked.size} 条，另补 ${take.length} 条更早未处理的，避免漏` })}\n`);
            }
          }
        } else {
          candidates = store.listNewest({ limit: scopeLimit > 0 ? Math.max(1, scopeLimit - processedCount) : scopeLimit }).filter(row => row.status !== "written" && row.status !== "skipped");
        }
        candidates = candidates.filter(row => !skipped.has(row.aweme_id));
        // --dry-run：只打印这一轮会挑哪些视频，不真正下载/转录，用于排障和验证排序
        if (has("--dry-run")) {
          process.stdout.write(`${JSON.stringify({
            dryRun: true,
            count: candidates.length,
            order: option("--order", "oldest"),
            sinceDate: option("--since-date", ""),
            untilDate: option("--until-date", ""),
            items: candidates.map(row => ({
              aweme_id: row.aweme_id,
              title: String(row.title || ""),
              published: row.create_time ? new Date(Number(row.create_time) * 1000).toISOString().slice(0, 10) : "",
              discovered_at: row.discovered_at,
              status: row.status,
            })),
          }, null, 2)}\n`);
          break;
        }
        if (!candidates.length) {
          // 按数量快照窗口处理完后自动清除，回到按时间/全部模式，避免新收藏永远不进窗口
          if (has("--count-window") && config.countWindow) {
            updateConfiguration(config.configFile, { countWindow: null });
            process.stdout.write(`${JSON.stringify({ notice: "count-window finished: snapshot cleared, back to normal mode" })}\n`);
          }
          writeProgress({ stage: "done" });
          break;
        }
        if (!plannedTotal) { plannedTotal = candidates.length; writeProgress({ stage: "sync" }); }
        if (targetWritten > 0) {
          const scopeWritten = store.listNewest({ limit: scopeLimit }).filter(row => row.status === "written").length;
          if (scopeWritten >= targetWritten) break;
        }
        const batch = candidates.slice(0, 10);
        const batchResults = [];
        let batchSuccess = 0;
        let retryableFailed = 0;
        const serverTries = new Map();
        for (const row of batch) {
          // 暂停检查：每处理完一条、下一条开始前检查暂停标志（当前条一旦开始会跑完，暂停约延迟一条视频的时长）
          await checkPauseBeforeNext(config, writeProgress);
          const startedAt = new Date().toISOString();
          process.stdout.write(`${JSON.stringify({ event: "start", aweme_id: row.aweme_id, title: String(row.title || "").slice(0, 40), t: startedAt })}\n`);
          const rows = await sync(config, store, { awemeId: row.aweme_id, skipConsensusDoc: true });
          const endAt = new Date().toISOString();
          const statuses = rows.map(r => r.status);
          process.stdout.write(`${JSON.stringify({ event: "done", aweme_id: row.aweme_id, statuses, durationSec: Math.round((new Date(endAt) - new Date(startedAt)) / 1000), t: endAt })}\n`);
          batchResults.push(...rows);
          const item = store.get(row.aweme_id);
          if (item?.category && item?.subcategory && item.subcategory !== "未分类") {
            affectedSubcategories.add(`${item.category}\u241F${item.group || ""}\u241F${item.subcategory}`);
          }
          batchSuccess += rows.filter(r => r.status === "written").length;
          for (const r of rows) {
            if (r.status !== "failed") continue;
            const expiredLike = /403|expired|forbidden/i.test(String(r.error || ""));
            fastFailStreak = expiredLike ? fastFailStreak + 1 : 0;
            if (isNetworkError(r.error)) {
              retryableFailed += 1;
            } else if (isServerError(r.error)) {
              const tries = (serverTries.get(row.aweme_id) || 0) + 1;
              serverTries.set(row.aweme_id, tries);
              if (tries >= 3) skipped.add(row.aweme_id);
              else retryableFailed += 1;
            } else {
              skipped.add(row.aweme_id);
            }
          }
        }
        processed.push(...batchResults);
        processedCount += batch.length;
        progressDone += batchResults.length;
        writeProgress({ stage: "sync" });
        if (retryableFailed > 0 && retryableFailed >= batchSuccess && batch.length > 0) {
          attempts += 1;
          const capHit = retryCap > 0 && attempts >= retryCap;
          const notice = capHit ? "retry cap reached; pausing batch" : "network/risk likely; waiting before retry";
          process.stdout.write(`${JSON.stringify({ notice, attempts, retryableFailed, batchSuccess, skippedNow: skipped.size })}\n`);
          if (capHit) break;
          await new Promise(resolve => setTimeout(resolve, waitMs));
        } else {
          attempts = 0;
        }
      }
      const docs = [];
      for (const key of affectedSubcategories) {
        const [cat, group, sub] = key.split("\u241F");
        docs.push(await updateConsensusDoc(config, store, { category: cat, group, subcategory: sub }).catch(error => ({ category: cat, group, subcategory: sub, error: String(error?.message || error) })));
      }
      if (progressFile) {
        try {
          fs.writeFileSync(progressFile, JSON.stringify({ running: false, done: progressDone, total: plannedTotal, percent: 100, finishedAt: new Date().toISOString() }));
        } catch {}
      }
      writeFailReport(store, config);
      process.stdout.write(`${JSON.stringify({ processed, consensusDocs: docs, counts: store.counts() }, null, 2)}\n`);
    } else {
      const rows = await sync(config, store, {
        limit: Number(option("--limit", "1")),
        awemeId: option("--aweme-id"),
      });
      writeFailReport(store, config);
      process.stdout.write(`${JSON.stringify({ processed: rows, counts: store.counts() }, null, 2)}\n`);
    }
  } else if (command === "retry") {
    const sinceUpdated = option("--since-updated", ""); // YYYY-MM-DD：只重试该日 00:00（本地）之后失败的条目
    const sinceIso = sinceUpdated
      ? new Date(Date.parse(`${sinceUpdated}T00:00:00+08:00`)).toISOString()
      : "";
    const retried = store.retryFailed(option("--aweme-id"), sinceIso);
    process.stdout.write(`${JSON.stringify({ retried, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "diagnose") {
    const result = await diagnose(config, store, { live: option("--live", "false") === "true" });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
  } else if (command === "configure") {
    if (!has("--show")) {
      updateConfiguration(config.configFile, {
        profile: option("--profile"),
        vaultPath: option("--vault"),
        vaultFolder: option("--folder"),
        whisperModel: option("--whisper-model"),
        whisperModelLabel: option("--whisper-model-label"),
        extractorProvider: option("--extractor"),
        cloudTranscriptOptIn: option("--cloud-transcript"),
        scheduleMinutes: option("--schedule-minutes"),
        startDate: has("--start-date") ? option("--start-date") : undefined,
      });
      // 按数量快照窗口：--count-window <正整数> = 从目前往后数 N 条（最新 N 条收藏），后续新收藏不计入；--count-window "" 清除（回到按时间/全部模式）
      if (has("--count-window")) {
        const raw = option("--count-window", "");
        if (raw === "") {
          updateConfiguration(config.configFile, { countWindow: null });
          process.stdout.write(`${JSON.stringify({ notice: "count-window cleared（回到按时间/全部模式）" })}\n`);
        } else {
          const n = Number(raw);
          if (!Number.isInteger(n) || n <= 0) throw new Error(`--count-window 需要正整数条数，或空字符串清除，收到：${raw}`);
          const { count, sinceIso, untilIso: windowUntil } = store.latestWindow(n);
          if (!sinceIso) {
            // 库里一条待处理都没有（已全部处理完 / 全被判跳过）：清空窗口，不要用"知识库还没有视频"误报
            updateConfiguration(config.configFile, { countWindow: null });
            process.stdout.write(`${JSON.stringify({ notice: "没有待处理的收藏，数量窗口未设置（已清空）" })}\n`);
          } else {
            // 上界必须用 latestWindow 给出的区间（这 N 条自身的 discovered_at），不能用 now：
            // 用 now 会把"后续才入库、但在收藏列表里更靠后（更老）"的条目也圈进窗口。
            const untilIso = windowUntil || new Date().toISOString();
            updateConfiguration(config.configFile, { countWindow: { limit: n, sinceIso, untilIso } });
            process.stdout.write(`${JSON.stringify({ notice: "count-window applied（按数量快照：从目前往后数 N 条，后续新收藏不计入）", limit: n, snapshotCount: count, sinceIso, untilIso })}\n`);
          }
        }
      }
      // 起始日期改动联动处理：先恢复所有旧打标（before-start-date / before-incremental-window），再按新日期重新打标。
      // 口径：起始日期 = 只处理【首次采集/新增收藏（discovered_at）在该日期（含）之后】的视频；更早的永久跳过。
      // 抖音接口不提供精确"收藏时刻"，以本机首次采集时间（discovered_at，即收藏列表中新出现该视频的时刻）近似收藏时间。
      if (has("--start-date")) {
        const newStart = option("--start-date", "");
        const restored = store.restoreByReason("before-start-date") + store.restoreByReason("before-incremental-window");
        let marked = 0;
        if (newStart) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(newStart)) throw new Error(`invalid start-date: ${newStart}`);
          const isoCutoff = new Date(Date.parse(`${newStart}T00:00:00+08:00`)).toISOString();
          marked = store.skipBeforeDiscoveredAt(isoCutoff, "before-start-date");
        }
        process.stdout.write(`${JSON.stringify({ notice: "start-date applied（按新增收藏/首次采集时间 discovered_at）", startDate: newStart, restored, marked })}\n`);
      }
    }
    const configured = loadConfig(config.configFile);
    const vault = configured.vaultPath
      ? (has("--show") ? resolveVaultLayout(configured) : initializeVault(configured))
      : null;
    process.stdout.write(`${JSON.stringify({ ...publicConfiguration(configured), vault }, null, 2)}\n`);
  } else if (command === "schedule") {
    const action = process.argv[3] || "status";
    const options = { dailyTime: option("--daily") };
    process.stdout.write(`${JSON.stringify(schedulerAction(config, action, options), null, 2)}\n`);
  } else if (command === "skipped") {
    // 被跳过的条目（四类：内容类型误判 / 永久失败 / 重试失败 / 早于起始日期）。
    // --list 列出；--restore id1,id2 用已提取的知识文件直接补出笔记，不重复花 AI 费用；
    // --retry id1,id2 非内容类型的跳过放回队列重新处理。
    const restoreArg = option("--restore", "");
    const retryArg = option("--retry", "");
    if (restoreArg) {
      const ids = String(restoreArg).split(",").map(item => item.trim()).filter(Boolean);
      const restored = [];
      for (const id of ids) {
        const item = store.restoreSkipped(id);
        if (!item) {
          restored.push({ aweme_id: id, ok: false, error: "条目不存在或不是被内容类型跳过的" });
          continue;
        }
        try {
          const note = writeObsidianNote(item, config);
          let meta = { category: "未分类", subcategory: "", group: "" };
          try {
            const knowledge = JSON.parse(fs.readFileSync(item.knowledge_path, "utf8"));
            meta = {
              category: knowledge.category || "未分类",
              subcategory: knowledge.subcategory || "",
              group: knowledge.group || "",
            };
          } catch {}
          store.markWritten(item.aweme_id, note, meta.category, meta.subcategory, meta.group);
          restored.push({ aweme_id: id, ok: true, note_path: note.path, title: item.title || "" });
        } catch (error) {
          restored.push({ aweme_id: id, ok: false, error: String(error?.message || error).slice(0, 300) });
        }
      }
      process.stdout.write(`${JSON.stringify({ ok: true, restored })}\n`);
    } else if (retryArg) {
      const ids = String(retryArg).split(",").map(item => item.trim()).filter(Boolean);
      const retried = [];
      for (const id of ids) {
        const item = store.retrySkipped(id);
        if (!item) retried.push({ aweme_id: id, ok: false, error: "条目不存在或已不是跳过状态" });
        else retried.push({ aweme_id: id, ok: true, status: item.status, title: item.title || "" });
      }
      process.stdout.write(`${JSON.stringify({ ok: true, retried })}\n`);
    } else {
      const limit = Number(option("--limit", "300")) || 300;
      const zhCache = loadReasonZhCache(path.dirname(config.databaseFile));
      const rows = store.listSkipped(limit).map(row => {
        const reason = parseSkipReason(row.last_error);
        const zh = reason.kind === "content" ? "" : (explainReason(reason.text) || zhCache[reason.text] || "");
        return {
          aweme_id: row.aweme_id,
          title: row.title || "",
          author: row.author || "",
          contentType: reason.contentType || "",
          reasonKind: reason.kind,
          reasonStage: reason.stage || "",
          reasonText: reason.text,
          reasonZh: zh,
          discovered_at: row.discovered_at || "",
          updated_at: row.updated_at || "",
          source_url: row.source_url || "",
          // 知识文件还在 → 能一键补笔记；不在了 → 需要恢复后重新处理（会重新下载/转录/AI 提取）
          canRestoreFromCache: Boolean(row.knowledge_path && fs.existsSync(row.knowledge_path)),
        };
      });
      const counts = {};
      for (const r of rows) counts[r.reasonKind] = (counts[r.reasonKind] || 0) + 1;
      process.stdout.write(`${JSON.stringify({ ok: true, items: rows, total: rows.length, counts }, null, 2)}\n`);
    }
  } else if (command === "failreport") {
    // 重新生成当天「失败视频清单-YYYY-MM-DD.md」（止损看板下半部分的数据源）
    const written = writeFailReport(store, config);
    process.stdout.write(`${JSON.stringify({ ok: written, counts: store.counts() })}\n`);
  } else if (command === "notes") {
    // 最近生成的笔记（按生成时间倒序），供"知识库 → 最新生成"视图使用
    const limit = Math.max(1, Math.min(Number(option("--recent", "80")) || 80, 500));
    const rows = store.db.prepare(`
      SELECT aweme_id, title, author, category, "group", subcategory, note_path, updated_at
      FROM items
      WHERE status='written' AND note_path IS NOT NULL AND note_path <> ''
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      items: rows
        .filter(row => row.note_path && fs.existsSync(row.note_path))
        .map(row => ({
          aweme_id: row.aweme_id,
          title: String(row.title || ""),
          author: String(row.author || ""),
          category: String(row.category || ""),
          group: String(row.group || ""),
          subcategory: String(row.subcategory || ""),
          note_path: row.note_path,
          updated_at: row.updated_at,
        })),
    }, null, 2)}\n`);
  } else if (command === "highlight") {
    const file = option("--file", "");
    const awemeId = option("--aweme-id", "");
    let mdPath = file;
    if (!mdPath && awemeId) {
      const row = store.get(awemeId);
      if (!row || !row.note_path) throw new Error("该视频没有关联的笔记文件");
      mdPath = row.note_path;
    }
    if (!mdPath || !fs.existsSync(mdPath)) throw new Error("找不到笔记文件：" + mdPath);
    const original = fs.readFileSync(mdPath, "utf8");
    const highlighted = await highlightNote(config, original);
    // 保险：去掉 ** 与所有空白后，若与原文不一致，说明模型改动了文字，拒绝写回以保护笔记
    const norm = (s) => String(s).replace(/\*\*/g, "").replace(/\s+/g, "");
    if (norm(highlighted) !== norm(original)) {
      throw new Error("模型改动了原文内容，已放弃写入以保护笔记（可在 LLM 配置稳定后重试）");
    }
    fs.writeFileSync(mdPath, highlighted);
    process.stdout.write(JSON.stringify({ ok: true, file: mdPath, length: highlighted.length }, null, 2) + "\n");
  } else if (command === "reclassify-local") {
    // 用本地关键词分类修正历史笔记（不调用 LLM）：把「其他 / 未分类」重算成具体大类，并移动到对应目录
    const limit = Number(option("--limit", "1000")) || 1000;
    const awemeId = option("--aweme-id", "");
    const dryRun = has("--dry-run");
    const results = reclassifyLocal(config, store, { limit, dryRun, awemeId });
    process.stdout.write(JSON.stringify({
      ok: true,
      dryRun,
      total: results.length,
      changed: results.filter(r => r.changed).length,
      failed: results.filter(r => r.error).length,
      results,
    }, null, 2) + "\n");
  } else if (command === "status") {
    const awemeId = option("--aweme-id");
    const sinceDate = option("--since-date", ""); // YYYY-MM-DD：只统计该日（含）之后【新增收藏/首次采集（discovered_at）】的视频，供总览窗口进度（抖音不提供精确收藏时刻，以首次采集时间近似）
    let counts = store.counts();
    let windowInfo = null;
    if (has("--count-window") && config.countWindow) {
      // 按数量快照窗口进度：窗口 = 设置时固定 [sinceIso, untilIso)，后续新收藏不计入
      counts = store.countsBetween(config.countWindow.sinceIso, config.countWindow.untilIso);
      windowInfo = { mode: "count", limit: config.countWindow.limit, sinceIso: config.countWindow.sinceIso, untilIso: config.countWindow.untilIso };
    } else if (sinceDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) throw new Error(`invalid --since-date: ${sinceDate}`);
      const isoCutoff = new Date(Date.parse(`${sinceDate}T00:00:00+08:00`)).toISOString();
      counts = store.countsSinceDiscovered(isoCutoff);
      windowInfo = { mode: "time", sinceDate };
    }
    const items = awemeId
      ? [store.get(awemeId)].filter(Boolean)
      : store.list({ limit: Number(option("--limit", "20")) });
    // 每日定时任务今日候选（口径与 run-sync.ps1 一致）：昨日新增（discovered_at 窗口 [昨天00:00, 明天00:00)） + 3 天内失败重试
    // 仅在全库模式（无 --count-window / --since-date）下计算，供桌面"每日任务待处理"显示，数值随日期变化
    let dailyWindow = null;
    if (!has("--count-window") && !sinceDate) {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const dayStart = (offset) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, 0, 0, 0);
      const dailyCands = store.listPending({
        sinceDiscovered: dayStart(-1).toISOString(),
        untilDiscovered: dayStart(1).toISOString(),
        retryUpdatedSince: dayStart(-3).toISOString(),
        limit: 100000,
      });
      dailyWindow = {
        mode: "daily-incremental",
        sinceDate: `${dayStart(-1).getFullYear()}-${pad(dayStart(-1).getMonth() + 1)}-${pad(dayStart(-1).getDate())}`,
        retrySinceDate: `${dayStart(-3).getFullYear()}-${pad(dayStart(-3).getMonth() + 1)}-${pad(dayStart(-3).getDate())}`,
        total: dailyCands.length,
      };
    }
    const paused = fs.existsSync(path.join(config.stateDir, "pause.flag"));
    process.stdout.write(`${JSON.stringify({ counts, sinceDate, windowInfo, dailyWindow, paused, pauseAutoResumeMinutes: Number(config.pauseAutoResumeMinutes || 0), items }, null, 2)}\n`);
  } else if (command === "newarrivals") {
    const result = await listNewArrivals(store, {
      since: option("--since", ""),
      days: Number(option("--days", "0")),
      limit: Number(option("--limit", "100")),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "add") {
    const urls = String(option("--url", "")).split(/[\s,;，；]+/).map(s => s.trim()).filter(Boolean);
    const title = option("--title", "");
    if (!urls.length) throw new Error("add 需要 --url <抖音视频链接>（可多个，空格/逗号/分号分隔）");
    const results = [];
    for (const raw of urls) {
      const info = await resolveDouyinVideoId(raw);
      if (!info || !info.id) {
        const errMsg = (info && info.error) ? info.error : "无法解析抖音视频链接（支持 /video/N、/note/N、v.douyin.com 短链）";
        results.push({ url: raw, ok: false, error: errMsg });
        continue;
      }
      const inserted = store.addManually({ awemeId: info.id, sourceUrl: info.canonical, title });
      results.push({ aweme_id: info.id, ok: true, url: info.canonical, ...inserted });
    }
    process.stdout.write(`${JSON.stringify({ results, counts: store.counts() }, null, 2)}\n`);
  } else if (command === "knowledge-card") {
    const major = option("--major");
    const minVideos = Number(option("--min-videos", "50"));
    if (has("--list")) {
      process.stdout.write(`${JSON.stringify(listMajorCards(config, store), null, 2)}\n`);
    } else if (has("--read")) {
      const target = option("--major");
      process.stdout.write(`${JSON.stringify(readMajorCard(config, target), null, 2)}\n`);
    } else if (major) {
      const result = await buildMajorCard(config, store, major, { minVideos });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const items = listMajorCards(config, store);
      const results = [];
      for (const entry of items) {
        const result = await buildMajorCard(config, store, entry.major, { minVideos });
        results.push(result);
      }
      process.stdout.write(`${JSON.stringify({ processed: results.length, results }, null, 2)}\n`);
    }
  } else if (command === "pause") {
    // 写入暂停标志：正在/将要运行的 sync 批量循环会在每条视频处理完、下一条开始前停下等待
    const flagFile = path.join(config.stateDir, "pause.flag");
    const already = fs.existsSync(flagFile);
    if (!already) {
      fs.writeFileSync(flagFile, JSON.stringify({ reason: option("--reason", "user"), requestedAt: new Date().toISOString() }));
    }
    process.stdout.write(`${JSON.stringify({ paused: true, notice: already ? "already paused（已处于暂停状态）" : "paused（已写入暂停标志；任务会在当前视频处理完后停在下一条之前，resume 后自动继续）", flagFile })}\n`);
  } else if (command === "resume") {
    // 删除暂停标志：等待中的 sync 循环在下次检查时自动继续
    const flagFile = path.join(config.stateDir, "pause.flag");
    const existed = fs.existsSync(flagFile);
    if (existed) fs.rmSync(flagFile, { force: true });
    process.stdout.write(`${JSON.stringify({ paused: false, notice: existed ? "resumed（已清除暂停标志，任务将自动继续）" : "not paused（当前没有暂停标志）", flagFile })}\n`);
  } else if (command === "cleanup") {
    // 清理临时媒体：删除 var\media 下的残留 mp4（下载过但未删除的文件）
    // 若 sync 正在运行则拒绝，避免删到正在使用的文件
    const mediaDir = config.mediaDir;
    const lockFile = path.join(config.stateDir, "sync.lock");
    let running = false;
    try {
      if (fs.existsSync(lockFile)) {
        const lk = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        try { process.kill(Number(lk.pid), 0); running = true; } catch {}
      }
    } catch {}
    if (running) {
      process.stdout.write(`${JSON.stringify({ blocked: true, notice: "检测到同步任务正在运行，请先暂停（pause）或等任务结束后再清理，避免删到正在使用的视频文件" })}\n`);
    } else {
      let removed = 0;
      let bytesFreed = 0;
      if (fs.existsSync(mediaDir)) {
        for (const name of fs.readdirSync(mediaDir)) {
          const p = path.join(mediaDir, name);
          try {
            const st = fs.statSync(p);
            if (st.isFile()) { bytesFreed += st.size; fs.rmSync(p, { force: true }); removed += 1; }
          } catch {}
        }
      }
      process.stdout.write(`${JSON.stringify({ ok: true, removed, bytesFreed, mediaDir })}\n`);
    }
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} finally {
  store.close();
}
