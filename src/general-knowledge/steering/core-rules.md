# Core Rules

> **These rules are mandatory for all general instances.**

## Instance Creation Safety

When creating a new instance with `create_instance`:

**Pre-checks (mandatory):**
1. **Check for duplicate working directory** — Run `list_instances` and verify no existing instance uses the same `working_directory`. Two instances sharing a directory causes file conflicts and race conditions.
2. **Verify the directory exists** — If specifying a directory, confirm it exists on disk before calling create.
3. **Use unique names** — The instance name is derived from `topic_name` or `basename(directory)`. Avoid generic names like "dev" or "test" that may collide.

**Post-checks (mandatory):**
4. **Confirm topic/channel creation** — After `create_instance` returns, verify the response includes a valid `topic_id`. This confirms the Discord channel or Telegram topic was actually created.
5. **Verify instance is running** — Use `describe_instance` to confirm the new instance reached "running" status. If it shows "stopped" or errors, check the output log.

**Common mistakes to avoid:**
- Do NOT create an instance pointing to another instance's worktree path
- Do NOT reuse a `topic_name` that already exists (Discord will create a duplicate channel)
- Do NOT omit `topic_name` when `directory` is not provided — it will error

## What NOT to Do (Dangerous Operations)

- **Don't delete `~/.agend/fleet.yaml`** while fleet is running
- **Don't delete `~/.agend/fleet.pid`** manually — use `agend fleet stop`
- **Don't kill tmux server** (`tmux kill-server`) — kills all agent sessions
- **Don't edit instance output.log** — it's actively written by the daemon
- **Don't run two fleet processes** on the same AGEND_HOME — port/socket conflicts
- **Don't change `channel.group_id`** without re-creating all topics — routing breaks
- **Don't remove an instance from fleet.yaml** that has active work — stop it first

## Access Mode Reference

fleet.yaml `channel.access.mode` valid values:

| Mode | Behavior |
|------|----------|
| `locked` | Only `allowed_users` can interact (default) |
| `pairing` | Users can request access via `/pair` command |
| `open` | All users can interact, no restrictions |

Example:
```yaml
channel:
  access:
    mode: open          # everyone can use
    # mode: locked      # whitelist only (add allowed_users)
    # mode: pairing     # users self-register via /pair
    allowed_users: [123456789]  # only needed for locked/pairing
```

**When to use each:**
- `locked` — production, private bot, security-sensitive
- `pairing` — semi-open, users request access with admin approval
- `open` — public demo, shared team bot, testing

## Dangerous Working Directories

NEVER create an instance with these working_directory values:
- `.` or `./` (current directory — pollutes global .kiro config)
- `~` or `/root` or `/home/user` (home directory)
- `/` (root filesystem)

These will cause kiro-cli to write MCP config to the global ~/.kiro/ instead of the instance workspace, breaking ALL instances.

Always use a dedicated subdirectory like `/home/user/projects/my-project` or let AgEnD auto-create workspace.


## Memory & Knowledge Management

Use layered memory to minimize context usage:

1. **Fleet Decision** — short, shared rules only (role, workflow rules, TODOs). Keep concise (~20 lines guideline). If it exceeds this, consider whether the details belong in soul.md instead.
2. **soul.md** (workspace root) — full memory: architecture, decisions, history. Loaded as steering.
   - If soul.md doesn't exist, do NOT create one unprompted. Only create when the user explicitly asks.
3. **Skills** (`.kiro/skills/`) — reusable workflows. On-demand loading.

Rules:
- Keep Fleet Decisions minimal. Move details to soul.md.
- Each instance maintains its own soul.md (not shared).
- Good workflows → **propose** converting to a skill. Create in `.kiro/skills/<name>/SKILL.md` only after user approval.
- Global skills (`src/general-knowledge/skills/`) only for knowledge ALL instances need.
- Never put architecture details or bug history in Fleet Decisions.
- After completing a **multi-step task that introduced new architectural knowledge or a reusable process**, suggest updating soul.md. Do NOT ask after routine tasks (reviews, single-file fixes, Q&A).
