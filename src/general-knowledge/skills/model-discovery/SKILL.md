---
name: model-discovery
description: Choose and discover models — when to omit, per-backend defaults, pass-through
roles: [general, worker]
---

## Omit the model unless you have a reason

Precedence: **explicit arg > `fleet.defaults.model` > CLI/account default**

Omitting is the default answer. It inherits the fleet default, or the CLI's own —
which is the account's current best model and stays right as the vendor ships new
ones. A model you pin today is a model someone has to un-pin later.

Pass a model only when: the user named one, the instance needs a *specific*
capability (cheap/fast vs deep reasoning), or the backend needs one to behave
(see kiro below).

## Per-backend default behaviour

| Backend | Omit `model` means | Notes |
|---|---|---|
| kiro-cli | account default | **`model: auto`** lets kiro pick per turn — usually what you want |
| claude-code | account default | ids are aliases: `sonnet`, `opus`, `haiku`, `opusplan`, `default` |
| codex | account default | |
| grok | account default | |
| antigravity | account default | |
| opencode | provider default | ids are **`provider/model`**, e.g. `opencode/big-pickle` |

## Discover real names

**Use the `list_models` tool** — it reads the fleet's probe cache (refreshed every
24h) and falls back to a live probe:

- `list_models({ backend: "kiro-cli" })` → the account catalog
- `list_models({ instance_name: "x" })` → read through **that instance's** config

Check `scope` in the reply. An instance on a custom provider can offer a
different catalog than the account (a Codex instance with `provider: glm` reads
its own catalog), so `scope: "instance"` is authoritative for that instance and
`scope: "global"` is only the account-wide list. `source` tells you `cache` /
`live` / `fallback`.

An empty list is **not** a failure — see pass-through below.

Underlying commands, if you need them by hand:

| Backend | Command |
|---|---|
| kiro-cli | `kiro-cli --list-models` |
| grok | `grok models` |
| opencode | `opencode models` |
| antigravity | `agy models` |
| codex | **no command** — the CLI writes `models_cache.json` in its CODEX_HOME |
| claude-code | fixed alias set (no command) |

## Setting one on create_instance

- No specific need → **omit `model`**
- Kiro, want per-turn selection → `model: "auto"`
- Custom provider → pass the **full id** and set `backend_options`, e.g.
  `backend: "codex"`, `backend_options: { codex: { provider: "glm" } }`
- opencode → always `provider/model`, never a bare model name

## Two traps

**antigravity: keep the effort suffix.** The suffix is part of the selectable id,
not decoration — `gemini-3.6-flash-medium` and `gemini-3.6-flash-low` are
different models. Take the id from `list_models`, not the display label the TUI
shows (`Gemini 3.5 Flash (Medium)`).

**Pass-through: AgEnD does not gate model names.** An unknown id is warned about,
then handed to the CLI anyway. So a name missing from `list_models` may still be
valid, and a typo fails *in the CLI at launch*, not at config time — if an
instance won't start after a model change, suspect the name first.
