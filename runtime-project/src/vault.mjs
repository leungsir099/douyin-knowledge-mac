import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const simpleTemplateRoot = path.join(projectRoot, "templates", "simple-vault");

function copyMissingTree(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyMissingTree(sourcePath, destinationPath);
    } else if (!fs.existsSync(destinationPath)) {
      fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    }
  }
}

export function normalizeProfile(value) {
  const profile = String(value || "simple").trim().toLowerCase();
  if (!["simple", "personal-inbox"].includes(profile)) {
    throw new Error("profile must be simple or personal-inbox");
  }
  return profile;
}

export function normalizeVaultFolder(value) {
  const folder = String(value || "Douyin Knowledge").trim();
  if (!folder) throw new Error("vaultFolder must not be empty");
  if (path.isAbsolute(folder)) throw new Error("vaultFolder must be relative to vaultPath");
  const normalized = path.normalize(folder);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("vaultFolder must stay within vaultPath");
  }
  return normalized;
}

export function resolveVaultLayout(config) {
  if (!config.vaultPath) throw new Error("vaultPath is not configured");
  const profile = normalizeProfile(config.profile);
  const vaultFolder = normalizeVaultFolder(config.vaultFolder);
  const base = path.resolve(config.vaultPath);
  // vaultPath 本身就以 vaultFolder 结尾时不要再拼一层：
  // 用户把库路径填成 D:\知识库\Douyin Knowledge 时，旧逻辑会生成
  // D:\知识库\Douyin Knowledge\Douyin Knowledge\...，笔记就"找不到"了
  const duplicated = path.basename(base).toLowerCase() === String(vaultFolder).toLowerCase();
  const root = duplicated ? base : path.join(base, vaultFolder);
  return {
    profile,
    root,
    inbox: profile === "simple" ? path.join(root, "Inbox") : root,
    knowledge: profile === "simple" ? path.join(root, "Knowledge") : "",
    sources: profile === "simple" ? path.join(root, "Sources") : "",
    attachments: profile === "simple" ? path.join(root, "Attachments") : "",
    plaintext: path.join(root, config.plaintextFolderName),
    wordDocs: path.join(root, config.wordFolderName),
    // 低信息量（只保留转录原文）的笔记单独一个文件夹
    lowSubstance: path.join(root, config.lowSubstanceFolderName || "低信息量笔记"),
  };
}

export function initializeVault(config) {
  const layout = resolveVaultLayout(config);
  if (layout.profile === "simple") copyMissingTree(simpleTemplateRoot, layout.root);
  else fs.mkdirSync(layout.root, { recursive: true });
  fs.mkdirSync(layout.inbox, { recursive: true });
  return layout;
}
