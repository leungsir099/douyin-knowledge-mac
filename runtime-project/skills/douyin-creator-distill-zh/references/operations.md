# 操作命令

从仓库根目录运行。

## 安装与登录

```powershell
.\bootstrap.ps1 -Profile simple -VaultPath "$env:USERPROFILE\Documents" -VaultFolder "Douyin Creator Knowledge" -NonInteractive
.\setup-browser-bridge.ps1
.\login.ps1
```

写入现有 Vault 时使用 `personal-inbox`，并把 `VaultPath` 与 `VaultFolder` 改成用户选择的路径。不要安装定时任务。

## 识别博主

```powershell
node .\src\cli.mjs creator resolve --input "<主页链接、sec_uid、抖音号或名称>" --limit 8
```

如果返回多个候选，必须让用户确认 `sec_uid`。

## 准备默认 30 条视频

```powershell
node .\src\cli.mjs creator prepare --sec-uid "<确认的sec_uid>" --limit 30 --source-input "<用户原始输入>"
node .\src\cli.mjs creator requests --sec-uid "<确认的sec_uid>"
```

## 接收单条分析

```powershell
node .\src\cli.mjs creator ingest-video --sec-uid "<sec_uid>" --aweme-id "<作品ID>" --file "<analysis-response.json>"
```

## 综合蒸馏并写入 Obsidian

```powershell
node .\src\cli.mjs creator synthesis-request --sec-uid "<sec_uid>"
node .\src\cli.mjs creator ingest-synthesis --sec-uid "<sec_uid>" --file "<creator-synthesis-response.json>"
node .\src\cli.mjs creator status --sec-uid "<sec_uid>"
```

## 诊断

```powershell
.\diagnose.ps1
npm run security-scan
```
