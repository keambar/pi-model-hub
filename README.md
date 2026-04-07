# pi-model-hub

Manage LLM model providers from multiple local JSON files and optional remote URLs for [pi-coding-agent](https://github.com/badlogic/pi-mono).

Model parameters (context window, output limit, cost, input modalities) are auto-filled from [models.dev](https://models.dev) — no manual spec needed for common models.

## Quick Start

```bash
pi install pi-model-hub
```

Zero external dependencies. Loads automatically on next session.

## Usage

`/hub` opens an overlay panel to manage providers:

```
──────────────────────────────────────────────────────────────────
 Model Hub  3 files · 5 providers · 2 remote
──────────────────────────────────────────────────────────────────
 ▸ [✓] claude-corp        2 models  corporate               ·
   [✓] openai-corp        3 models  corporate               ·
   [○] ollama-local       5 models  ollama-local
──────────────────────────────────────────────────────────────────
 ↑↓ navigate  ·  enter detail  ·  space toggle  ·  s sync  ·  r reload  ·  q close
──────────────────────────────────────────────────────────────────
```

| Key | Action |
|-----|--------|
| `↑/↓` or `k/j` | Navigate providers |
| `Enter` | Open detail view for selected provider |
| `Space` | Toggle provider on/off (session-scoped) |
| `s` | Sync all remote sources + refresh models.dev cache |
| `r` | Reload all source files from disk |
| `q` / `Esc` | Close panel |

### Detail View

Press `Enter` on any provider to see its full configuration:

- Enabled status, source file, `baseUrl`, `api`
- All models with resolved parameters: `contextWindow`, `maxTokens`, `reasoning`, `input`, `cost`
- Each parameter is tagged `[user]` (explicitly set in your config) or `[provider]` (auto-filled from models.dev, showing which provider the data came from)
- `↑/↓` or `j/k` to scroll, `Esc` / `q` / `Backspace` to return to list

## Source Files

Providers are defined in `~/.pi/agent/sources/*.json`:

```jsonc
// ~/.pi/agent/sources/corporate.json
{
  "providers": {
    "corp-proxy": {
      "baseUrl": "https://proxy.corp.com/v1",
      "apiKey": "CORP_ANTHROPIC_KEY",
      "api": "anthropic-messages",
      "models": [
        { "id": "claude-sonnet-4-5-20250929" }
      ]
    }
  }
}
```

`contextWindow`, `maxTokens`, `cost`, `reasoning`, and `input` are auto-filled from models.dev for known model IDs. Any field you specify explicitly overrides the auto-filled value.

One file = one or more providers. Files are loaded in alphabetical order. A provider with the same name as a built-in pi provider replaces it.

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `baseUrl` | yes (if models defined) | API endpoint |
| `apiKey` | no | API key or env var name (e.g. `"MY_API_KEY"`) |
| `api` | yes | One of the pi-supported API identifiers |
| `headers` | no | Extra HTTP headers |
| `authHeader` | no | Use `Authorization: Bearer` header instead of default |
| `models[].id` | yes | Model ID as used by the API |
| `models[].name` | no | Display name (auto-filled from models.dev) |
| `models[].contextWindow` | no | Max context tokens (auto-filled) |
| `models[].maxTokens` | no | Max output tokens (auto-filled) |
| `models[].cost` | no | `{ input, output, cacheRead, cacheWrite }` per 1M tokens (auto-filled) |
| `models[].reasoning` | no | Whether model supports extended reasoning (auto-filled) |
| `models[].input` | no | `["text"]` or `["text", "image"]` (auto-filled) |

`apiKey` follows the same resolution logic as pi's `models.json`: if the value matches an environment variable name, that variable's value is used; otherwise it is treated as a literal string.

## Reserved Files

The following files in `~/.pi/agent/sources/` are reserved and never loaded as provider configs:

| File | Purpose |
|------|---------|
| `_remote.json` | Remote URL sync configuration |
| `_config.json` | Global extension settings |
| `_models-dev-cache.json` | Auto-managed models.dev cache (do not edit) |

## Remote Sync

```jsonc
// ~/.pi/agent/sources/_remote.json
{
  "corporate.json": {
    "url": "https://internal.corp.com/providers.json",
    "ttl": 3600
  }
}
```

`s` in `/hub` fetches all declared URLs and writes the results to disk. The file on disk is always the active config. If a fetch fails and a local file already exists, the existing file is kept. The remote file must return `{ "providers": { ... } }` format.

`ttl` is in seconds (default: `3600`). On `session_start`, any file older than its TTL is refreshed in the background — after the session goes idle, so it does not interrupt an active run.

## Model Parameter Auto-fill

On session start, the extension fetches and caches model data from [models.dev](https://models.dev) (`~/.pi/agent/sources/_models-dev-cache.json`, TTL 24h). When loading a source file, any model with missing parameters is enriched from this cache.

When the same model ID appears in multiple providers in models.dev (e.g. `claude-sonnet-4-5-20250929` is listed under `anthropic`, `302ai`, `helicone`, etc.), the data from the highest-priority provider is used.

**Default priority:**

```
anthropic → openai → google → deepseek → moonshotai → zai →
minimax → xai → meta → openrouter → (rest)
```

Override in `_config.json`:

```jsonc
// ~/.pi/agent/sources/_config.json
{
  "modelSourcePriority": ["deepseek", "anthropic", "openai"],
  "modelsDevTtl": 43200
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `modelSourcePriority` | see above | Provider priority for model parameter lookup |
| `modelsDevTtl` | `86400` | models.dev cache TTL in seconds |

## Team Configuration

Point `_remote.json` at an internal URL to distribute provider configs across a team:

```jsonc
// ~/.pi/agent/sources/_remote.json
{
  "team.json": {
    "url": "https://internal.corp.com/pi-providers.json",
    "ttl": 3600
  }
}
```

The hosted file uses the same `{ "providers": { ... } }` format. Infrastructure team manages the file; developers sync with `s` in `/hub` or automatically on session start.

## How It Works

1. **Startup**: scan `~/.pi/agent/sources/*.json` (excluding reserved files), register providers via `pi.registerProvider()`
2. **session_start**: background-refresh stale remote sources and models.dev cache (waits for idle session)
3. **`/hub`**: overlay panel for toggle, sync, reload
4. **Reload**: re-reads all source files and rebuilds the models.dev lookup

## Uninstall

```bash
pi uninstall pi-model-hub
```

## License

MIT
