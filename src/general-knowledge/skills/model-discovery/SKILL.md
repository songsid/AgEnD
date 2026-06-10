---
name: model-discovery
description: List available models per backend, configure model in fleet.yaml
---

## Model Names by Backend

Models are specified in fleet.yaml `defaults.model` or per-instance `model` field.

| Backend | How to list models | Default |
|---------|-------------------|---------|
| **kiro-cli** | In tmux: send `/model` + Enter → read model list → Esc to close | auto (latest) |
| **claude-code** | `sonnet`, `opus`, `haiku`, `opusplan`, `best`, `sonnet[1m]`, `opus[1m]` | sonnet |
| **antigravity** | Run `agy models` to see available models | Gemini 3.5 Flash (Medium) |
| **codex** | `gpt-4o`, `o3`, `o4-mini` | gpt-4o |
| **opencode** | `opencode models` | depends on provider |

**To discover available models for a backend, run the CLI's model listing command:**
- `agy models` — lists all available models for antigravity
- `opencode models` — lists all available models for opencode
- `codex` — check config.toml

**Important:** Model names vary by backend. Always check the actual CLI output rather than guessing names. For antigravity, use the exact display name shown by `agy models` (e.g. "Gemini 3.5 Flash (High)").

Example fleet.yaml:
```yaml
defaults:
  backend: kiro-cli
  model: claude-sonnet-4-20250514

instances:
  heavy-task:
    model: claude-opus-4-20250514
```
