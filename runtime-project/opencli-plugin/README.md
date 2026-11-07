# opencli-plugin-douyin-saved

Adds a read-only `opencli douyin saved` command. It reuses the browser login
session managed by OpenCLI and never persists cookies, raw page state, or
signed media URLs.

The command captures Douyin's already-signed saved-video responses while the
web page loads and scrolls. It merges all pages by `aweme_id`, checks the
captured IDs against the rendered saved-video list, and does not use the
unrelated `/aweme/favorite/` endpoint.

## Install

```powershell
opencli plugin install file://<PROJECT_ROOT>/opencli-plugin
```

## Run

```powershell
opencli douyin saved --limit 20 -f json
```

For a live coverage check against the logged-in web page:

```powershell
npm run verify:saved
```

`--include-play-url true` is intended only for a local workflow that captures
stdout without logging it. The returned signed URL is transient and must not be
written to state files or Obsidian notes.
