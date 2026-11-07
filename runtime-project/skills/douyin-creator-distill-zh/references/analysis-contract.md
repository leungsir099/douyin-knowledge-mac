# 蒸馏合同

## 单条视频

读取 `*.analysis-request.json` 中的 `video`、`transcript.segments` 和 `outputContract`。输出单个 JSON 对象，不要 Markdown 代码围栏。

```json
{
  "schemaVersion": 1,
  "awemeId": "请求中的作品 ID",
  "coreArgument": "用因果链或步骤链概括整条视频的核心论证",
  "viewpoints": [
    {
      "claim": "博主的观点",
      "kind": "explicit",
      "reasoning": "博主如何从前提走到该观点",
      "confidence": "high",
      "citations": [
        {
          "startSeconds": 3.2,
          "endSeconds": 12.5,
          "excerpt": "对应转录原文"
        }
      ]
    }
  ],
  "argumentation": [
    {
      "type": "cause-effect",
      "summary": "论证方式说明",
      "premise": "前提",
      "conclusion": "结论",
      "citations": []
    }
  ],
  "contentStructure": [
    {
      "stage": "hook",
      "startSeconds": 0,
      "endSeconds": 8,
      "purpose": "这一段承担的内容功能",
      "summary": "这一段讲了什么"
    }
  ],
  "verificationNeeds": [
    {
      "claim": "需要核实的说法",
      "reason": "为什么不能直接视为事实",
      "citations": []
    }
  ],
  "tags": ["主题标签"]
}
```

规则：

- `kind` 只能是 `explicit` 或 `cross-segment-inference`。
- `argumentation.type` 使用请求给出的枚举。
- `contentStructure.stage` 使用请求给出的枚举。
- 所有引用时间必须落在真实视频时长内，`endSeconds` 必须大于 `startSeconds`。
- 引用原文应短而完整，不能虚构转录中不存在的句子。
- 至少输出一个观点、一个论证方式和一个内容结构段。

## 跨视频综合

读取 `creator-synthesis-request.json`。输出：

```json
{
  "schemaVersion": 1,
  "creatorSecUid": "请求中的 sec_uid",
  "summary": "只基于当前样本的总体概览",
  "recurringViewpoints": [],
  "argumentPatterns": [],
  "contentStructurePatterns": [],
  "topicMap": [],
  "contradictionsAndEvolution": [],
  "limitations": []
}
```

前四类模式的每项结构：

```json
{
  "name": "模式名称",
  "description": "模式说明、适用条件和边界",
  "confidence": "medium",
  "videoRefs": [
    {
      "awemeId": "请求中存在的作品 ID",
      "note": "该视频如何支持此模式"
    }
  ]
}
```

`contradictionsAndEvolution` 每项包含 `description` 和 `videoRefs`。只在多条视频确实提供支持时写“反复出现”“常用”或“演变”；样本不足时写入 `limitations`。
