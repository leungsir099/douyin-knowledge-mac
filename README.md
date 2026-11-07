# 抖音知识库 · macOS 版

把抖音收藏自动整理成本地 Obsidian 知识库的桌面应用，**macOS (Apple Silicon) 移植版**。

> 本项目是 [jinmm1233/douyin-knowledge-vault](https://github.com/jinmm1233/douyin-knowledge-vault) （MIT 开源）的 macOS 移植版本。
> 上游官方只发布 Windows 版，本仓库基于其开源源码重新构建 macOS 版，并修复了跨平台适配中的若干问题。
> **非官方版本**，与上游作者无关。

---

## 下载安装

前往 [Releases](../../releases) 下载：

| 文件 | 说明 |
|---|---|
| `抖音知识库-1.1.2-mac-arm64.dmg` | **推荐**。双击挂载，把应用拖到「应用程序」 |
| `抖音知识库-1.1.2-mac-arm64.zip` | 备用。解压后拖到「应用程序」 |

**系统要求**：Apple Silicon（M1 / M2 / M3 / M4），macOS 12+。不支持 Intel Mac。

### 首次打开

本应用未做 Apple 开发者签名（无证书），首次打开需要手动允许：

1. 在「应用程序」里 **右键点击「抖音知识库」→ 打开 → 再点「打开」**
2. 如果提示"无法验证开发者"：系统设置 → 隐私与安全性 → 下拉到底 → 「仍要打开」
3. 或使用终端清除隔离标记：

```bash
xattr -dr com.apple.quarantine "/Applications/抖音知识库.app"
```

### 首次使用

1. 设置里选择处理方式（按时间 / 按数量 / 全部）
2. 填入自己的 DeepSeek（或 OpenAI 兼容）API Key
3. 点「开始处理收藏」，扫码登录抖音
4. 转录模型（464MB）已内置在安装包中，无需另外下载

---

## 功能

与 Windows 版功能一致：

- 抖音收藏采集 → 音视频下载 → 本地 Whisper 转录 → AI 提炼 → Obsidian Markdown 归档
- 智能划重点、知识卡片、知识图谱、仓颉蒸馏、AI 问答、周报
- 8 款皮肤、液态玻璃 UI
- 暂停/继续/强制停止，止损看板
- 定时同步（macOS LaunchAgent）

内置运行时：Node 22.23.1 / Python 3.12.10（faster-whisper + ctranslate2）/ FFmpeg 6.0 / Chromium 1169

---

## 相对上游源码的改动

本移植版修复的问题（均已用真实数据验证）：

| 文件 | 改动 |
|---|---|
| `main.js` | 运行时路径按平台（`node/bin/node`、`python/bin/python3`）；内置 Chromium 用 `chrome-mac`；系统浏览器探测 macOS 路径；进程树 kill；定时任务改走 CLI；`cangjiePath` 覆盖；手动同步实时写进度；运行中时旧诊断标「上次运行」 |
| `cangjie-runner.js` | **修复蒸馏黑屏级 bug**：内部第二处硬编码 `vaultPath/Knowledge`（漏 vaultFolder 一层），导致点「开始蒸馏」必报「子类目录不存在或为空」 |
| `src/vault.mjs` 相关调用 | 蒸馏/搜索/图谱/周报/笔记打开等路径统一按 `vaultFolder` 解析 |
| `scripts/audit-pipeline.mjs`<br>`scripts/dedupe-notes.mjs` | 同类路径问题修复（改用 `resolveVaultLayout`） |
| `src/scheduler.mjs` | 新增 macOS launchd 实现（install/status/run/enable/disable/uninstall） |
| `src/transcribe.mjs` | 模型下载跨平台（Node 版，sha256 校验 + Range 断点续传）；超时按音频时长动态计算；模型校验缓存 |
| `src/cli.mjs` | 空闲检测改用 `ioreg HIDIdleTime` |
| `src/config.mjs` | `pythonCommand` 平台默认值 |
| `src/opencli.mjs` | 内置 Chromium 查找跨平台 |
| `src/media.mjs` | **放行代理 fake-ip 段（198.18.0.0/15）**：国内用户开 Clash/Surge 代理时，抖音 CDN 域名解析到该段，原逻辑判为"非公网"直接拦截，导致视频全部下载失败 |
| `src/simplify.mjs`（新增） | 笔记简繁统一：写笔记时自动繁体转简体（opencc-js），保护代码块/行内代码 |
| `scripts/ensure-whisper-model.mjs`（新增） | PowerShell 版模型下载脚本的 Node 移植 |
| `scripts/run-sync.mjs`（新增） | run-sync.ps1 的 Node 移植（launchd 调用） |
| `package.json` | 增加 electron-builder mac/arm64/dmg 配置 |

---

## 从源码构建

需要 macOS + Node 22 + Xcode Command Line Tools。

```bash
# 1. 安装依赖
cd app && npm install

# 2. 准备内置运行时（dok-runtime 目录）
#    - node/       : Node 22.x darwin-arm64
#    - python/     : python-build-standalone 3.12 (aarch64-apple-darwin) + pip 依赖
#    - ffmpeg, ffprobe : darwin-arm64 静态构建
#    - ms-playwright/chromium-1169/chrome-mac/ : Playwright 的 mac Chromium
#    - project/    : 本仓库 runtime-project/ 的内容
#    - cangjie/    : 上游仓颉技能目录
#    - var/models  : faster-whisper-small 模型（可选，首次使用会自动下载）

# 3. 打包
npx electron-builder --mac --dir --arm64 --config.electronDist=node_modules/electron/dist

# 4. 签名（无证书可用 ad-hoc）
codesign --force --deep --sign - "release/mac-arm64/抖音知识库.app"

# 5. 制作 dmg
hdiutil create -volname "抖音知识库" -srcfolder release-stage -ov -format UDZO 输出.dmg
```

目录说明：
- `app/`：Electron 应用层源码（`main.js`、`preload.js`、`renderer/`、`assets/`、`cangjie-runner.js`）
- `runtime-project/`：内置 CLI 项目源码（转录、AI 提炼、知识卡片、仓颉等）

---

## 已知限制

1. **未签名 / 未公证**：首次打开需手动允许（见上）
2. **仅 Apple Silicon**：Intel Mac 需另行编译 x64
3. **自动更新不可用**：上游无 macOS 更新包，建议在设置中关闭自动更新检查
4. 定时同步依赖 launchd，首次加载可能需在系统设置中授权

---

## 数据位置

- 应用配置：`~/.douyin-knowledge-app/settings.json`
- 浏览器登录态：`~/.douyin-knowledge/browser-profile`
- 处理数据：`/Applications/抖音知识库.app/Contents/Resources/dok-runtime/project/var/`
- 定时任务：`~/Library/LaunchAgents/com.douyin.knowledge.sync.plist`

---

## 致谢

- 上游项目：[jinmm1233/douyin-knowledge-vault](https://github.com/jinmm1233/douyin-knowledge-vault)（MIT License）
- 运行时组件：Electron、Node.js、Python、faster-whisper、ctranslate2、FFmpeg、Playwright、opencc-js

## License

MIT License，详见 [LICENSE](LICENSE)。原始版权归上游作者所有。
