import argparse
import json
import pathlib
from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--title", required=True)
    parser.add_argument("--description", required=True)
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--meta", default="{}")
    args = parser.parse_args()

    pathlib.Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    doc = Document()
    # 设置默认中文字体
    doc.styles['Normal'].font.name = '微软雅黑'
    doc.styles['Normal']._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')
    doc.styles['Normal'].font.size = Pt(11)

    # 标题
    head = doc.add_heading(args.title, level=0)
    for run in head.runs:
        run.font.name = '微软雅黑'
        run._element.rPr.rFonts.set(qn('w:eastAsia'), '微软雅黑')

    # 元信息
    meta = json.loads(args.meta)
    p = doc.add_paragraph()
    for k, v in meta.items():
        run = p.add_run(f"{k}: {v}\n")
        run.font.size = Pt(9)

    # 原文案
    doc.add_heading("原文案", level=1)
    doc.add_paragraph(args.description)

    # 转录内容
    doc.add_heading("字幕/转录内容", level=1)
    for para in args.transcript.split("\n"):
        if para.strip():
            doc.add_paragraph(para)

    doc.save(args.output)
    print(json.dumps({"path": args.output}, ensure_ascii=False))

if __name__ == "__main__":
    main()
