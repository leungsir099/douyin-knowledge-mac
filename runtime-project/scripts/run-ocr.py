import json
import sys
from pathlib import Path

def main():
    image_paths = [Path(p).resolve() for p in sys.argv[1:]]
    if not image_paths:
        print(json.dumps({"text": "", "segments": []}, ensure_ascii=False))
        return
    try:
        from rapidocr_onnxruntime import RapidOCR
        engine = RapidOCR()
    except ImportError:
        # 兜底：如果依赖还没装，先返回空，后续安装依赖后自动生效
        print(json.dumps({"text": "", "segments": [], "error": "ocr dependency missing"}, ensure_ascii=False))
        return
    all_text = []
    segments = []
    for img_path in image_paths:
        result, _ = engine(str(img_path))
        if not result:
            continue
        page_text = []
        for line in result:
            text = str(line[1]).strip()
            confidence = float(line[2])
            if text:
                page_text.append(text)
                segments.append({"text": text, "confidence": confidence, "image": str(img_path)})
        if page_text:
            all_text.append("\n".join(page_text))
    print(json.dumps({
        "text": "\n\n".join(all_text),
        "segments": segments,
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
