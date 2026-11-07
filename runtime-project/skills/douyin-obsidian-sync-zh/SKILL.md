---
name: douyin-obsidian-sync-zh
description: 在 Windows 上安装、配置和运行“抖音收藏视频转 Markdown/Obsidian 知识库”工作流。适用于用户提供 GitHub 仓库或本地项目，需要 AI 检查并安装缺失依赖、创建简单知识库或写入现有 Vault Inbox、引导用户自行登录抖音、验收一条真实收藏、执行增量同步、诊断、备份、升级、定时任务或卸载的场景。
---

# 抖音收藏转知识库

调用仓库中的确定性工作流。保持本 Skill 足够薄：不要在 Skill 中重新实现收藏采集、视频下载、转录、知识提取、SQLite 状态机或 Markdown 写入逻辑。

## 适用环境

- Windows 10/11 x64，并且 AI Agent 可以使用终端。
- 用户已经具备基本的 AI 和开发工具使用经验；不要求机器是完全空白环境。
- 确保 Git、Node.js `>=22.13`、Python 3.12、Microsoft Visual C++ x64 Runtime，以及 Chrome 或 Edge 可用。缺失 Node、Python 或 VC++ Runtime 时，`bootstrap.ps1` 会安装仓库锁定的版本，并创建项目自己的 npm/Python 环境。
- 默认使用本地转录和本地知识提取，不需要 API Key 或付费服务。

## 安装与配置

1. 克隆用户提供的 GitHub 地址，或者使用用户现有的项目目录。如果用户明确提供 tag 或 commit，进行校验；否则不要自行增加必须使用 Release 的限制。
2. 只询问安装位置、`simple` 或 `personal-inbox`、Vault 路径、Vault 内相对目录和同步间隔。
3. 说明 bootstrap 可能安装上述开发依赖，然后执行 `bootstrap.ps1`，不要传入 `-InstallSchedule`。
4. 执行 `setup-browser-bridge.ps1`。说明浏览器扩展权限，让用户把已校验的解压扩展加载到专用 Chrome/Edge profile。
5. 执行 `login.ps1`，暂停并让用户自己登录或扫码。
6. 用户确认登录后执行 `accept-one.ps1`；只有返回 `ok: true` 且真实收藏达到 `written` 才算通过。
7. 展示验收结果，并单独询问是否安装定时任务。只有用户明确同意后才能安装。

## 知识库模式

- `simple`：创建 `Inbox`、`Knowledge`、`Sources`、`Attachments` 和 `README.md`，形成简单 Markdown 知识库。
- `personal-inbox`：写入现有 Vault 内的相对 Inbox。不要把用户私人路径、知识内容或个人规则提交到公共仓库。

## 日常操作

从仓库根目录执行命令。需要安装、状态、同步、重试、验收、备份、升级、定时任务或卸载命令时，读取 [references/operations.md](references/operations.md)。

## 保护用户

- 登录始终由用户完成。不要请求、读取、打印、复制、导出或保存密码、二维码内容、Cookie、Token、浏览器 storage、请求签名或瞬时媒体 URL。
- 原始媒体和完整转录保存在工作流状态目录，不进入 Vault。
- 默认保持本地提取。把转录文字发送给云端模型前必须获得用户明确同意。
- 不要覆盖用户手工修改过的笔记；遇到覆盖拒绝时停止并说明。
- 未经用户单独确认，不得公开 GitHub 仓库、飞书文章或视频。
