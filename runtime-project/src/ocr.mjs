import path from "node:path";
import { spawn } from "node:child_process";
import { root as repoRoot } from "./config.mjs";

function runOcrPython(pythonCommand, imagePaths) {
  const script = path.join(repoRoot, "scripts", "run-ocr.py");
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, [script, ...imagePaths], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("OCR timed out"));
    }, 120000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`OCR exited with ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.replace(/^\uFEFF/u, "")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function recognizeImages(item, config) {
  const imagePaths = item.image_paths || item.image_urls || [];
  if (!imagePaths.length) throw new Error("no images to recognize");
  const result = await runOcrPython(config.pythonCommand, imagePaths);
  return {
    path: path.join(config.stateDir, `ocr-${item.aweme_id}.json`),
    text: result.text || "",
    segments: result.segments || [],
    engine: "rapidocr",
  };
}
