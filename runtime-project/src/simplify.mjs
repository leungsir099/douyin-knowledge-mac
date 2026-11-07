/**
 * 简繁统一：把笔记文本里的繁体字转为简体。
 *
 * 用 opencc-js（纯 JS，含词典，无需外部进程）。只转汉字，保留 Markdown 结构；
 * 标点按现有笔记的规范统一（『』→‘’，「」→“”），与历史笔记保持一致。
 * 任何异常都回退原文，绝不能因为转换失败而丢笔记。
 */
import OpenCC from "opencc-js";

let converter = null;
try {
  converter = OpenCC.Converter({ from: "t", to: "cn" });
} catch {
  converter = null;
}

// 代码块/行内代码里的内容保持原样（避免改坏代码或命令）
function splitProtected(text) {
  const parts = [];
  let pos = 0;
  const fenceRe = /```[\s\S]*?```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > pos) parts.push({ code: false, text: text.slice(pos, m.index) });
    parts.push({ code: true, text: m[0] });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) parts.push({ code: false, text: text.slice(pos) });
  return parts;
}

function convertPlain(chunk) {
  if (!converter) return chunk;
  let out = converter(chunk);
  // 与历史笔记统一引号风格
  out = out
    .replaceAll("『", "‘").replaceAll("』", "’")
    .replaceAll("「", "“").replaceAll("」", "”");
  return out;
}

// 非代码块片段里，再保护行内代码 `...`，它们可能是命令/变量名，不应被转换
function convertWithInlineCode(chunk) {
  const parts = [];
  let pos = 0;
  const re = /`[^`\n]+`/g;
  let m;
  while ((m = re.exec(chunk)) !== null) {
    if (m.index > pos) parts.push({ code: false, text: chunk.slice(pos, m.index) });
    parts.push({ code: true, text: m[0] });
    pos = m.index + m[0].length;
  }
  if (pos < chunk.length) parts.push({ code: false, text: chunk.slice(pos) });
  return parts.map((part) => (part.code ? part.text : convertPlain(part.text))).join("");
}

export function toSimplified(text) {
  const input = String(text || "");
  if (!input || !converter) return input;
  try {
    return splitProtected(input)
      .map((part) => (part.code ? part.text : convertWithInlineCode(part.text)))
      .join("");
  } catch {
    return input;
  }
}

export function hasTraditional(text) {
  const input = String(text || "");
  if (!input || !converter) return false;
  try {
    return splitProtected(input).some((part) => !part.code && converter(part.text) !== part.text);
  } catch {
    return false;
  }
}
