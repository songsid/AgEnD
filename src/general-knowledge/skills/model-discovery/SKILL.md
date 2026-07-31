---
name: model-discovery
description: Set and discover models — pass-through to the CLI, no AgEnD allowlist gate
---

## How to set a model

- fleet.yaml: `defaults.model` or per-instance `model`
- **Pass-through:** AgEnD no longer blocks unknown model ids — it may **warn**, then still pass the string to the CLI
- **CLI is source of truth** — if the model is invalid, the backend CLI errors (fix the name there)

## Discover real names

| Backend | How |
|---------|-----|
| kiro-cli | In pane: `/model` (gpt-*, deepseek-*, minimax-*, glm-*, qwen* supported) |
| claude-code | `sonnet` / `opus` / `haiku` / `opusplan` / aliases |
| codex | pane `/model` or docs (`gpt-*`, `o*`) |
| grok | `grok models` |
| antigravity | `agy models` — set **base name only** (drop `(Medium)` / `(Thinking)` effort suffix) |
| opencode | `opencode models` |

```yaml
defaults:
  backend: kiro-cli
  model: claude-sonnet-4-20250514
```
