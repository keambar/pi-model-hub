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

```
──────────────────────────────────────────────────────────────────
 claude-corp ✓ enabled
  source: corporate.json · remote
  baseUrl: https://proxy.corp.com/v1
  api: anthropic-messages
──────────────────────────────────────────────────────────────────
  [1] claude-sonnet-4-5-20250929
  name            Claude Sonnet 4.5            [anthropic:claude-sonnet-4-5-20250929 via id]
  context         200,000                      [anthropic:claude-sonnet-4-5-20250929 via id]
  maxTokens       16,384                       [anthropic:claude-sonnet-4-5-20250929 via id]
  reasoning       no                           [anthropic:claude-sonnet-4-5-20250929 via id]
  input           text, image                  [anthropic:claude-sonnet-4-5-20250929 via id]
  cost/1M         in:$3  out:$15  cR:$0.3  cW:$3.75   [anthropic:claude-sonnet-4-5-20250929 via id]

  [2] claude-opus-4-5
  name            Claude Opus 4.5              [anthropic:claude-opus-4-5 via id]
  context         200,000                      [user]
  maxTokens       32,000                       [user]
  reasoning       yes                          [anthropic:claude-opus-4-5 via id]
  input           text, image                  [anthropic:claude-opus-4-5 via id]
  cost/1M         in:$5  out:$25               [user]
──────────────────────────────────────────────────────────────────
  [user] source  [provider:id via match] models.dev
  esc/q back  ·  ↑↓ scroll
```

- `[user]` — value explicitly set in your source file
- `[provider:id via match]` — auto-filled from models.dev (shows provider, catalog ID, and match strategy)
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
| `models[].modelsDevId` | no | Canonical models.dev model ID to use when the API ID is an alias or gateway-prefixed ID |
| `models[].modelsDevProvider` | no | models.dev provider to use when several providers publish the same model ID; requires `modelsDevId` |
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

Model IDs sent to your API are preserved. For API gateways that prefix or alias model IDs, the resolver tries, in order: explicit `modelsDevProvider` + `modelsDevId`, explicit `modelsDevId`, exact `id`, exact `name`, gateway suffix after `--`, then a conservative normalized alias such as `DeepSeek V4 Flash` ↔ `deepseek-v4-flash` when it is unambiguous.

When the same model ID appears in multiple providers in models.dev (e.g. `claude-sonnet-4-5-20250929` is listed under `anthropic`, `302ai`, `helicone`, etc.), the data from the highest-priority provider is used.

**Default priority:**

```
anthropic → openai → google → deepseek → moonshotai → zhipuai → zai →
minimax → xai → meta → openrouter → (rest)
```

Use per-model overrides when priority alone is not enough. For example, GLM-5.2 is published by both API-price and coding/free-plan providers; this keeps the gateway API ID while selecting ZhipuAI API pricing from models.dev:

```jsonc
{
  "id": "llm-gateway--glm-5.2",
  "modelsDevId": "glm-5.2",
  "modelsDevProvider": "zhipuai"
}
```

Override the global priority in `_config.json`:

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
