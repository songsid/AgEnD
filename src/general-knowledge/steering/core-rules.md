# Core Rules

> **These rules are mandatory for all general instances.**

## Instance Creation Safety

When creating a new instance with `create_instance`:

**Pre-checks (mandatory):**
1. **Check for duplicate working directory** — Run `list_instances` and verify no existing instance uses the same `working_directory`. Two instances sharing a directory causes file conflicts and race conditions.
2. **Verify the directory exists** — If specifying a directory, confirm it exists on disk before calling create. When the fleet sets `project_roots`, it must also be inside one of them, or create is refused.
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
- **Don't delete `~/.agend/fleet.pid`** manually — use `agend stop` (from a fleet session it needs `--yes`, and it stops every instance)
- **Don't kill tmux server** (`tmux kill-server`) — kills all agent sessions
- **Don't edit instance output.log** — it's actively written by the daemon
- **Don't run two fleet processes** on the same AGEND_HOME — port/socket conflicts
- **Don't change `channel.group_id`** without re-creating all topics — routing breaks
- **Don't remove an instance from fleet.yaml** that has active work — stop it first
- **Don't try to get around a Settings confirmation** — a sensitive change made in the web Settings (access, secrets, connections, …) waits for a fleet admin to confirm it: in General in Telegram or Discord, or on the dashboard where its confirmation card offers that (on a fleet with no chat app: in the browser on the computer running AgEnD, or with the authenticator code). Point people to that card or to General — never to a command to type

## Access Mode Reference

fleet.yaml `channel.access.mode` valid values:

| Mode | Behavior |
|------|----------|
| `locked` | Only the effective allowlist can interact |
| `pairing` | Legacy alias for allowlist-only access; no access codes |
| `open` | All users can interact, no restrictions |

Example:
```yaml
channel:
  access:
    mode: open          # everyone can use
    # mode: locked      # whitelist only (add allowed_users)
    # mode: pairing     # legacy allowlist-only alias
    allowed_users: [123456789]  # only needed for locked/pairing
```

**When to use each:**
- `locked` — production, private bot, security-sensitive
- `pairing` — old configuration alias for allowlist-only access; use `locked` for new configuration
- `open` — public demo, shared team bot, testing

Add allowed users in Settings → Chat & connections → Chat connections → the bot → Allowed users (primary bot), using the existing confirmation. Runtime/Hub pairing is separate.

## Dangerous Working Directories

NEVER create an instance with these working_directory values:
- `.` or `./` (current directory — pollutes global .kiro config)
- `~` or `/root` or `/home/user` (home directory)
- `/` (root filesystem)

These will cause kiro-cli to write MCP config to the global ~/.kiro/ instead of the instance workspace, breaking ALL instances.

Always use a dedicated subdirectory like `/home/user/projects/my-project` or let AgEnD auto-create workspace.


## Memory & Knowledge Management

Keep what you know in three layers:

1. **Fleet decisions** — short shared rules (roles, workflow rules, shared to-dos). They are resent with every request, so keep each to a few lines and link to the details.
2. **soul.md** (workspace root, optional) — your own long-form memory, one per instance. AgEnD does not load it: read it when you pick up work it covers and after a restart or compaction.
3. **Skills** — reusable workflows, loaded on demand from your backend's skills directory: `.kiro/skills/` (kiro), `.claude/skills/` (claude-code), `.agents/skills/` (codex, opencode, muse, antigravity), `.grok/skills/` (grok).

**soul.md has three parts:**
- **Current state** — work in progress, open to-dos, and the decisions in force, each with its reason. Rewrite this part so it always describes now; move each finished item to the history index.
- **Rules** — each written as the action to take, with its reason ("Run the tests before pushing: CI is slow").
- **History index** — one line per finished piece of work and where to look (PR, commit, file or card).

Keep it around 30 KB: it is read in full each time, so every line costs context, and outdated cautions make an agent hesitate over things that no longer apply. Past that, shorten history lines, drop rules that no longer apply, and move procedures into skills.

**Update soul.md** after a multi-step task that taught you something reusable (an architecture fact, a procedure, a decision and its reason) and before a compaction. Routine work (a review, a one-file fix, an answered question) needs no update.

**No soul.md yet?** After the first such task, ask the user once with `reply` and two buttons ("Create soul.md" / "No thanks"). On yes, create it with the three parts. On no, write `soul.declined` (date and answer) in the workspace root and carry on without it; that file means the question is answered for good. Create soul.md whenever the user asks for it.

**Skills and decisions:** propose a skill when a workflow proves reusable, and create `<skills directory>/<name>/SKILL.md` once the user agrees. Bundled skills (`src/general-knowledge/skills/`) hold only what every instance of a role needs. Architecture details and bug history go in soul.md or a skill; a Fleet decision holds just the rule.
