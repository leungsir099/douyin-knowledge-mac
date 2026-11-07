---
name: douyin-creator-distill-zh
description: 在 Windows 上把指定抖音博主的公开视频蒸馏为本地 Markdown/Obsidian 知识库。适用于用户提供博主完整或短链接、sec_uid、抖音号或名称，希望 AI 识别并确认博主、采集默认最新 30 条作品、本地转录、提取博主观点、论证方式和内容结构，并生成可追溯本地知识库的场景。不得把该流程扩展成观点碰撞、选题、写稿、模仿口吻或复制博主人设。
---

# 抖音博主知识蒸馏

调用仓库中的确定性工作流核心。保持本 Skill 足够薄：不要重新实现博主搜索、作品分页、下载、转录、SQLite 状态、合同校验、哈希或 Obsidian 写入。

## 固定产品边界

只完成：

```text
博主主页链接 / sec_uid / 抖音号 / 名称
→ 确认博主
→ 蒸馏公开视频中的观点、论证方式和内容结构
→ 写入本地 Obsidian 知识库
```

不要进行观点碰撞、保存用户观点、自动选题、生成提纲或写稿。不要模仿原句、案例、人设、口吻、镜头或个人风格。

## 执行流程

1. 确保用户已安装仓库依赖并完成浏览器桥配置。需要安装命令时读取 [references/operations.md](references/operations.md)。
2. 运行 `creator resolve`。名称或抖音号可能返回多个候选；展示候选并让用户确认 exact `sec_uid`，确认前不要下载视频。
3. 询问 Vault 位置和样本数量。默认最新 30 条，允许 1–100 条；第一版不安装定时任务。
4. 用户自行在专用 Chrome/Edge profile 登录抖音。不要读取、打印、复制或保存登录信息。
5. 运行 `creator prepare`。该命令负责作品分页、增量去重、媒体冻结、本地 faster-whisper 转录和分析请求生成。
6. 对每个 `analysis-request.json`，读取请求并严格按 [references/analysis-contract.md](references/analysis-contract.md) 生成同目录的 `analysis-response.json`，再运行 `creator ingest-video`。不要直接写 Vault。
7. 所有目标视频完成后运行 `creator synthesis-request`，读取综合请求并生成 `creator-synthesis-response.json`，再运行 `creator ingest-synthesis`。
8. 展示生成的 `Creators/<博主>/README.md` 和 `Videos/` 路径、成功/失败数量与样本边界。

## 分析原则

- 只依据本地转录和视频元数据，不补造博主观点。
- 区分博主明确表达与 AI 跨片段推断；推断必须降置信度并保留时间码。
- 把经验、效果、收入、平台规律和普遍命令放入待核实内容，不能当作事实背书。
- 综合蒸馏必须引用具体视频；只出现一次的内容不能写成“长期稳定观点”。
- 转录不清楚时保留不确定性，不根据常识擅自修正关键结论。

## 保护用户与来源

- 用户自己登录或扫码。不要请求、读取、打印、复制、导出或保存 Cookie、Token、二维码内容、浏览器 storage、请求签名或瞬时媒体 URL。
- 原始媒体、完整转录和分析请求保存在工作流状态目录，不进入 Vault。
- Vault 只保存观点、论证方式、内容结构、待核实项、来源时间码和哈希。
- 不覆盖用户手工修改过的知识笔记；核心拒绝覆盖时停止并说明。
- 未经用户明确确认，不公开仓库、知识库、飞书文章或视频。
