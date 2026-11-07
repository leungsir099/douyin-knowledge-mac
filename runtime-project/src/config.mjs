import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProfile, normalizeVaultFolder } from "./vault.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(configPath = "") {
  const file = path.resolve(configPath || process.env.DOK_CONFIG || path.join(root, "config.json"));
  let input = {};
  if (fs.existsSync(file)) {
    input = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
  }
  const stateDir = resolveFromRoot(input.stateDir || "var");
  return {
    configFile: file,
    stateDir,
    databaseFile: path.join(stateDir, "state.sqlite3"),
    mediaDir: path.join(stateDir, "media"),
    transcriptDir: path.join(stateDir, "transcripts"),
    knowledgeDir: path.join(stateDir, "knowledge"),
    creatorKnowledgeDir: path.join(stateDir, "creator-knowledge"),
    profile: normalizeProfile(input.profile),
    vaultPath: input.vaultPath ? resolveFromRoot(input.vaultPath) : "",
    vaultFolder: normalizeVaultFolder(input.vaultFolder),
    discoveryLimit: normalizeInteger(input.discoveryLimit, 50, 1, 200),
    collectorMaxItems: normalizeInteger(input.collectorMaxItems, 1000, 1, 10000),
    deleteMediaAfterWrite: input.keepOriginalVideos === true ? false : input.deleteMediaAfterWrite !== false,
    keepOriginalVideos: input.keepOriginalVideos === true,
    customMediaSavePath: input.customMediaSavePath ? String(input.customMediaSavePath) : "",
    skipCategories: Array.isArray(input.skipCategories) ? input.skipCategories : [],
    pauseAutoResumeMinutes: normalizeInteger(input.pauseAutoResumeMinutes, 0, 0, 600),
    consensusThreshold: Number.isFinite(Number(input.consensusThreshold)) ? Math.max(0, Math.min(1, Number(input.consensusThreshold))) : 0.35,
    consensusMatchLimit: normalizeInteger(input.consensusMatchLimit, 100, 10, 500),
    consensusSemantic: input.consensusSemantic !== false,
    consensusSemanticHistoryLimit: normalizeInteger(input.consensusSemanticHistoryLimit, 30, 5, 100),
    classifyDynamicSubcategories: input.classifyDynamicSubcategories !== false,
    // 打包版：Windows 用内置 venv（project/.venv/Scripts/python.exe）；
    // macOS 用内置 runtime python（dok-runtime/python/bin/python3，位于 project 的兄弟目录）
    pythonCommand: path.resolve(root, String(input.pythonCommand || (process.platform === "win32"
      ? path.join(".venv", "Scripts", "python.exe")
      : path.join("..", "python", "bin", "python3")))),
    mediaProbeScript: resolveFromRoot(input.mediaProbeScript || path.join("python", "probe_media.py")),
    modelCacheDir: path.join(stateDir, "models"),
    whisperModelTier: ["small", "medium", "large-v3"].includes(input.whisperModelTier) ? input.whisperModelTier : "small",
    whisperModel: input.whisperModel || {
      "small": "Systran/faster-whisper-small",
      "medium": "Systran/faster-whisper-medium",
      "large-v3": "Systran/faster-whisper-large-v3",
    }[["small", "medium", "large-v3"].includes(input.whisperModelTier) ? input.whisperModelTier : "small"],
    whisperModelLock: resolveFromRoot(input.whisperModelLock || path.join("models", `faster-whisper-${["small", "medium", "large-v3"].includes(input.whisperModelTier) ? input.whisperModelTier : "small"}.lock.json`)),
    whisperModelLabel: String(input.whisperModelLabel || `faster-whisper/${["small", "medium", "large-v3"].includes(input.whisperModelTier) ? input.whisperModelTier : "small"}`),
    hfEndpoint: String(process.env.DOK_HF_ENDPOINT || ""),
    language: ["auto","zh","en","ja","ko","yue","fr","es","de","ru"].includes(input.language) ? input.language : "zh",
    // 提取器选择：填了 API Key + 模型名就默认走 AI 提炼（这也是设置页对用户的承诺："填 Key 才能跑 AI 提炼"）。
    // 旧实现无论有没有 Key 都默认 "local"，导致用户配好 DeepSeek 后仍在用本地规则抽取 —— 笔记没有分类、也没有 AI 总结。
    // 想强制离线可显式设置 extractorProvider="local"。
    extractorProvider: (() => {
      const raw = String(input.extractorProvider || "").toLowerCase();
      if (raw === "local") return "local";
      const key = String(process.env.DOK_LLM_API_KEY || process.env.OPENAI_API_KEY || input.llmApiKey || "");
      const model = String(process.env.DOK_LLM_MODEL || process.env.OPENAI_MODEL || input.llmModel || "");
      return key && model ? "openai" : "local";
    })(),
    // 云端转录开关：显式 false 才拒绝；显式 true 或已配 Key（说明用户就是要用云端 AI）都放行
    cloudTranscriptOptIn: input.cloudTranscriptOptIn === false
      ? false
      : (input.cloudTranscriptOptIn === true || Boolean(String(process.env.DOK_LLM_API_KEY || process.env.OPENAI_API_KEY || input.llmApiKey || ""))),
    llmBaseUrl: String(process.env.DOK_LLM_BASE_URL || process.env.OPENAI_BASE_URL || input.llmBaseUrl || "https://api.openai.com/v1").replace(/\/+$/u, ""),
    llmApiKey: String(process.env.DOK_LLM_API_KEY || process.env.OPENAI_API_KEY || input.llmApiKey || ""),
    llmModel: String(process.env.DOK_LLM_MODEL || process.env.OPENAI_MODEL || input.llmModel || ""),
    schedulerTaskName: String(input.schedulerTaskName || "Douyin Obsidian Knowledge"),
    scheduleMinutes: normalizeInteger(input.scheduleMinutes, 60, 5, 1440),
    startDate: String(input.startDate || ""),
    countWindow: input.countWindow && typeof input.countWindow === "object" ? input.countWindow : null,
    processingMode: ["knowledge", "plaintext"].includes(input.processingMode) ? input.processingMode : "knowledge",
    plaintextFolderName: String(input.plaintextFolderName || "纯转录文档").trim() || "纯转录文档",
    // 内容太少、AI 没能提炼的视频：笔记单独存放，避免和正式知识笔记混在一起
    lowSubstanceFolderName: String(input.lowSubstanceFolderName || "低信息量笔记").trim() || "低信息量笔记",
    plaintextOutputFormat: ["md", "docx"].includes(input.plaintextOutputFormat) ? input.plaintextOutputFormat : "docx",
    wordFolderName: String(input.wordFolderName || "纯转录Word文档").trim() || "纯转录Word文档",
    preferBuiltinSubtitle: input.preferBuiltinSubtitle !== false,
    whisperModelTier: ["small", "medium", "large-v3"].includes(input.whisperModelTier) ? input.whisperModelTier : "small",
    enableBgmRecognition: input.enableBgmRecognition === true,
  };
}

function resolveFromRoot(value) {
  const text = String(value);
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(root, text);
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}
