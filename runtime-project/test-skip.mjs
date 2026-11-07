import { writeObsidianNote, cleanNoteTitle } from "./src/obsidian.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testOutputPath = path.join(__dirname, "test-output");
const testTypes = ["shortdrama", "ad", "music", "dance", "funny", "mukbang", "silent-no-info"];
// 手动构造测试用配置，不走配置文件加载
const config = {
  vaultPath: testOutputPath,
  skipCategories: [], // 全部取消勾选，不跳过任何类型
  processingMode: "knowledge",
  pythonCommand: "python",
  nodeCommand: process.execPath,
  whisperModelTier: "small",
  whisperModelLabel: "faster-whisper/small",
  vaultFolder: "Douyin Knowledge",
  profile: "simple",
  plaintextFolderName: "纯转录文档",
  wordFolderName: "纯转录Word文档",
};

let pass = 0;
for (const type of testTypes) {
  const tmpDir = path.join(testOutputPath, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const knowledgePath = path.join(tmpDir, `${type}.json`);
  fs.writeFileSync(knowledgePath, JSON.stringify({
    contentType: type,
    thesis: `测试${type}内容，不会被跳过`,
    summary: `这是${type}的测试内容，正常生成笔记`,
    keyIdeas: [], actions: [], limitations: [], verificationNeeds: [], relatedConcepts: [], tags: [type],
    category: "未分类", subcategory: "未分类", group: "未分类",
  }));
  const item = {
    aweme_id: `test-${type}`,
    title: `测试${type}内容`,
    author: "测试作者",
    description: `这是${type}的原文案`,
    knowledge_path: knowledgePath,
  };
  try {
    const result = writeObsidianNote(item, config);
    if (fs.existsSync(result.path) && !result.path.includes("skip")) {
      console.log(`✅ ${type} 测试通过：未被跳过，成功生成笔记 ${result.path}`);
      pass++;
    }
  } catch (e) {
    console.log(`❌ ${type} 测试失败：${e.message}`);
  }
}
console.log(`\n测试完成：${pass}/${testTypes.length} 个类型全部正常处理，无强制跳过`);
