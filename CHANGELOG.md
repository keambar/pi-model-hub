# Changelog

## [Unreleased]

## [0.1.2] — 2026-05-24

### Fixed
- Preserve model `thinkingLevelMap` when loading source providers, enabling model-specific thinking levels such as `xhigh`.
- Merge provider-level `compat` into each generated model `compat` instead of emitting unsupported provider-level `compat`.

## [0.1.0] — 2026-04-06

### Added
- Multi-source provider loading from `~/.pi/agent/sources/*.json`
- Remote URL sync via `_remote.json` (`url`, `ttl` per file)
- Background refresh of stale remote sources on session start (waits for idle)
- `/hub` overlay panel: navigate, toggle, sync, reload, status feedback
- Keyboard navigation: `↑/↓`/`j/k`, `Space` toggle, `s` sync, `r` reload, `q`/`Esc` close
- Toggle state preserved across reload (session-scoped; clears on restart)
- Model parameter auto-fill from [models.dev](https://models.dev): `contextWindow`, `maxTokens`, `cost`, `reasoning`, `input`
- models.dev cache at `_models-dev-cache.json` with configurable TTL (default 24h)
- Configurable provider priority for model parameter lookup via `_config.json`
- Default priority: `anthropic → openai → google → deepseek → mistral → xai → cohere → meta → groq → cerebras → fireworks-ai`
- Reserved files (`_remote.json`, `_config.json`, `_models-dev-cache.json`) excluded from provider loading
- Explicit sync (`s`) also refreshes models.dev cache
