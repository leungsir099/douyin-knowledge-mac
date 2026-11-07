# 抖音知识库 macOS 版 v1.1.2-mac.1

基于 [jinmm1233/douyin-knowledge-vault](https://github.com/jinmm1233/douyin-knowledge-vault) v1.1.2 源码构建的 macOS (Apple Silicon) 版本。

## 下载

- `DouyinKnowledge-1.1.2-mac-arm64.dmg` — 推荐，双击挂载后拖进「应用程序」
- `DouyinKnowledge-1.1.2-mac-arm64.zip` — 备用

**要求**：Apple Silicon（M1/M2/M3/M4）+ macOS 12+

## 首次打开

应用未签名，需要：右键点击 → 打开 → 再点「打开」。
或终端：`xattr -dr com.apple.quarantine "/Applications/抖音知识库.app"`

## 本版本修复的关键问题

1. **仓颉蒸馏必挂** — 两处硬编码 `vaultPath/Knowledge`（漏 vaultFolder 层），已统一修复
2. **代理环境下视频全部下载失败** — 放行 Clash/Surge 的 fake-ip 段（198.18.0.0/15）
3. **长视频转录被误杀** — 转录超时改为按音频时长动态计算（原固定 1 小时）
4. **每次转录重复校验 464MB 模型** — 增加模型路径缓存
5. **定时同步** — 从 Windows 计划任务改为 macOS LaunchAgent
6. **界面显示陈旧状态** — 手动同步实时写进度；旧诊断标注「上次运行」
7. **笔记简繁统一** — 新增自动繁体转简体（opencc-js），保护代码块

## 内置组件

Node 22.23.1 / Python 3.12.10（faster-whisper 1.2.1 + ctranslate2 4.8.1）/ FFmpeg 6.0 / Playwright Chromium 1169 / 464MB Whisper 模型

## 校验

见 `SHA256SUMS.txt`。
