---
name: session-management
description: Session stores, forking, and auth-pause recovery
roles: [general, worker]
---

## Auth failure (auto-pause)

When AgEnD sees `auth_error` it **pauses** that instance (`pausePending` sticky):
- One notification **per backend** (not per instance) — log in once, same-backend peers recover.
- Auth is **per-user global** across backends: claude-code, codex, kiro, grok, opencode, antigravity.
- Messages while paused stay in the **queue** — do not re-send.
- After the user re-auths: `wake` / normal wake clears `pausePending`.

## Where sessions live

| | kiro-cli | claude-code |
|---|---|---|
| Store | `~/.kiro/sessions/cli/<uuid>.json` | `~/.claude/projects/<path-encoded>/*.jsonl` |
| Reload | `/chat load <file>` | `--continue` / `--resume <id>` |

`<path-encoded>` = absolute cwd with `/` → `-`.

## Fork (source must be idle)

- **kiro:** `/chat save name.json -f` → `create_instance` → copy workspace file → `/chat load name.json`
- **claude-code:** copy newest `*.jsonl` into target's encoded project dir → start (uses `--continue`)
- Prefer `replace_instance` when the whole session is poisoned (see instance-lifecycle)
