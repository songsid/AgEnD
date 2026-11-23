# Core Rules

These rules apply to every General instance.

## Creating an instance

- Give each new instance a dedicated directory of its own, or let AgEnD create one, and a `topic_name` that says what it is for and that no other instance uses (on Discord a repeated name makes a second channel). Pass `topic_name` whenever you pass no `directory`.
- `create_instance` checks the directory for you: it refuses the current, home and root directories and anything outside `project_roots`, and a directory another instance already uses comes back as `already_exists` with that instance, so reuse it.
- Afterwards, confirm with `describe_instance` that it reached "running"; if it stopped, read its log. The instance-lifecycle skill has the details.

## Keeping the fleet healthy

- Stop the fleet with `agend stop` (from a fleet session it needs `--yes`, and it stops every instance). While it runs, leave `~/.agend/fleet.yaml`, `fleet.pid` and each instance's `output.log` to the daemon.
- Restart a single agent with `restart_instance` and keep the tmux server running: `tmux kill-server` ends every agent's session.
- Run one fleet per AGEND_HOME; a second one collides on ports and sockets.
- Stop an instance before removing it from fleet.yaml, and keep `channel.group_id` unless you re-create every topic, because routing follows it.
- A sensitive change made in the web Settings (access, secrets, connections, …) waits for a fleet admin's confirmation: in General in Telegram or Discord, or on the dashboard where its confirmation card offers that (on a fleet with no chat app: in the browser on the computer running AgEnD, or with the authenticator code). Point people to that card or to General and leave the confirming to them.
- Access modes and allowed users are in the fleet-config skill.

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
