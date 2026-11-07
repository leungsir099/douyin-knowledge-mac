# Operations

## Prerequisites

Use Windows 10/11 x64 with terminal access and Chrome or Edge. Ensure Git is available to acquire the repository. `bootstrap.ps1` checks or installs the locked Node.js, Python, and Microsoft Visual C++ runtimes, then creates project-local dependencies. The default local transcription and extraction path needs no API key.

## Bootstrap

```powershell
.\bootstrap.ps1 -Profile simple -VaultPath "C:\Users\USER\Documents" -VaultFolder "Douyin Knowledge" -ScheduleMinutes 60 -NonInteractive
.\bootstrap.ps1 -Profile personal-inbox -VaultPath "D:\MyVault" -VaultFolder "Inbox\Douyin" -ScheduleMinutes 60 -NonInteractive
```

Add `-InstallCodexSkill` only for Codex. Never add `-InstallSchedule` during bootstrap.

## Login and deterministic acceptance

```powershell
.\setup-browser-bridge.ps1
.\login.ps1
.\accept-one.ps1
```

For an existing item:

```powershell
.\accept-one.ps1 -AwemeId <ID>
```

## Status, sync, and retry

```powershell
node .\src\cli.mjs status --limit 20
node .\src\cli.mjs sync --limit 1
node .\src\cli.mjs retry --aweme-id <ID>
node .\src\cli.mjs sync --aweme-id <ID>
npm run security-scan
```

## Schedule

After fresh user approval:

```powershell
node .\src\cli.mjs schedule status
node .\src\cli.mjs schedule install
node .\src\cli.mjs schedule status
```

Rollback:

```powershell
node .\src\cli.mjs schedule uninstall
```

Installation refuses to overwrite an existing task.

## Lifecycle

```powershell
.\backup.ps1
.\upgrade.ps1 -Ref <RELEASE_TAG> -ExpectedCommit <40_HEX_COMMIT>
.\uninstall.ps1
```

`uninstall.ps1` preserves `config.json`, workflow state, and the configured knowledge base. `-RemoveRuntime` removes only validated reinstallable project-local `.venv`, `.bootstrap-tools`, `node_modules`, and `var/runtime` directories; it does not remove media, transcripts, SQLite state, or the Vault.
