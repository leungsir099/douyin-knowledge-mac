---
name: douyin-obsidian-sync
description: Set up and operate the Windows Douyin-saved-video to Markdown/Obsidian workflow from a GitHub repository or local checkout. Use when an AI-capable Windows user wants to install missing prerequisites, create a simple knowledge base or write to an existing Vault Inbox, log in to Douyin themselves, validate one real favorite, sync incrementally, diagnose failures, or manage backup, upgrade, scheduling, and uninstall.
---

# Douyin Obsidian Sync

Use the repository's deterministic workflow. Keep this Skill thin: never reproduce collection, download, transcription, extraction, SQLite state, or Markdown logic here.

## Expected environment

- Windows 10/11 x64 with a terminal-capable AI Agent.
- The user is comfortable approving normal developer tools and following browser instructions; a completely empty machine is not required.
- Ensure Git, Node.js `>=22.13`, Python 3.12, Microsoft Visual C++ x64 Runtime, and Chrome or Edge are available. `bootstrap.ps1` installs the locked Node, Python, and VC++ runtimes when they are missing and creates project-local npm/Python environments.
- No API key or paid service is required for the default local workflow.

## Set up

1. Clone the GitHub URL supplied by the user, or use their existing checkout. If they supplied a tag or commit, verify it; otherwise do not invent a release requirement.
2. Ask only for the installation location, `simple` or `personal-inbox`, Vault path, relative folder, and desired sync interval.
3. Explain that bootstrap may install the prerequisites above, then run `bootstrap.ps1` without `-InstallSchedule`.
4. Run `setup-browser-bridge.ps1`. Explain the extension permissions and ask the user to load the verified unpacked extension into a dedicated Chrome/Edge profile.
5. Run `login.ps1` and pause while the user signs in or scans the QR code themselves.
6. Run `accept-one.ps1`; require `ok: true` and a real item at `written`.
7. Show the result and ask separately whether to install the scheduled task. Install it only after an explicit yes.

## Profiles

- `simple`: create `Inbox`, `Knowledge`, `Sources`, `Attachments`, and `README.md` under a portable Markdown knowledge base.
- `personal-inbox`: write into a relative Inbox inside an existing Vault. Never embed private paths or personal knowledge rules in the public repository.

## Operate

Run commands from the repository root. Read [references/operations.md](references/operations.md) for exact setup, status, sync, retry, validation, backup, upgrade, scheduling, and uninstall commands.

## Protect the user

- The user handles login. Never request, read, print, copy, export, or persist password, QR contents, Cookie, Token, browser storage, request signatures, or transient media URLs.
- Keep original media and complete transcripts in the workflow state directory, outside the Vault.
- Keep local extraction as the default. Require explicit consent before any transcript text is sent to a cloud model.
- Preserve manually edited notes and stop on overwrite refusal.
- Never publish a repository, article, or video without separate user approval.
