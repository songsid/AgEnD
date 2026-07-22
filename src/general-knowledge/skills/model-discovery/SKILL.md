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
| **grok** | `grok-4.5`, `grok-4.3`, `grok-code`, `grok-build-0.1` | grok default |

**To discover available models for a backend, run the CLI's model listing command:**
- `agy models` — lists all available models for antigravity
- `opencode models` — lists all available models for opencode
- `codex` — check config.toml

**Important for antigravity (agy):**
- `agy models` shows names like `Gemini 3.5 Flash (Medium)` — the parenthetical suffix (Medium/High/Low/Thinking) is the **effort level**, NOT part of the model name.
- When setting model in fleet.yaml, use only the base name WITHOUT the effort suffix.
- Example: `agy models` shows `Gemini 3.5 Flash (Medium)` → set `model: "Gemini 3.5 Flash"`
- Example: `agy models` shows `Claude Opus 4.6 (Thinking)` → set `model: "Claude Opus 4.6"`

**Important:** Model names vary by backend. Always check the actual CLI output rather than guessing names.

Example fleet.yaml:
```yaml
defaults:
  backend: kiro-cli
  model: claude-sonnet-4-20250514

instances:
  heavy-task:
    model: claude-opus-4-20250514
```
