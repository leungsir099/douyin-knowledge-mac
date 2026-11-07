# 操作命令

## 环境依赖

使用 Windows 10/11 x64、可运行 PowerShell 的终端 AI，以及 Chrome 或 Edge。使用 Git 获取仓库。`bootstrap.ps1` 会检查或安装锁定的 Node.js、Python 和 Microsoft Visual C++ Runtime，并创建项目本地依赖。默认本地转录和知识提取不需要 API Key。

## 初始化

简单知识库：

```powershell
.\bootstrap.ps1 -Profile simple -VaultPath "$env:USERPROFILE\Documents" -VaultFolder "Douyin Knowledge" -ScheduleMinutes 60 -NonInteractive
```

写入现有 Vault Inbox：

```powershell
.\bootstrap.ps1 -Profile personal-inbox -VaultPath "D:\MyVault" -VaultFolder "Inbox\Douyin" -ScheduleMinutes 60 -NonInteractive
```

只有 Codex 需要安装本地 Skill 时才添加 `-InstallCodexSkill`。初始化阶段不要添加 `-InstallSchedule`。

## 浏览器与真实验收

```powershell
.\setup-browser-bridge.ps1
.\login.ps1
.\accept-one.ps1
```

验收指定收藏：

```powershell
.\accept-one.ps1 -AwemeId <抖音视频ID>
```

## 状态、同步和重试

```powershell
node .\src\cli.mjs status --limit 20
node .\src\cli.mjs sync --limit 1
node .\src\cli.mjs retry --aweme-id <抖音视频ID>
node .\src\cli.mjs sync --aweme-id <抖音视频ID>
npm run security-scan
```

## 定时任务

真实收藏验收通过并再次获得用户明确同意后：

```powershell
node .\src\cli.mjs schedule status
node .\src\cli.mjs schedule install
node .\src\cli.mjs schedule status
```

卸载定时任务：

```powershell
node .\src\cli.mjs schedule uninstall
```

安装命令不会覆盖已有的同名任务。

## 生命周期

```powershell
.\diagnose.ps1
.\backup.ps1
.\upgrade.ps1 -Ref <标签或分支> -ExpectedCommit <40位提交哈希>
.\uninstall.ps1
```

`uninstall.ps1` 默认保留 `config.json`、工作流状态和用户知识库。`-RemoveRuntime` 只删除可重新安装的项目本地运行环境，不删除媒体、转录、SQLite 状态或 Vault。
