# Core Rules

These rules apply to every General instance.

## Creating an instance

- Give each new instance a dedicated directory of its own, or let AgEnD create one, and a `topic_name` that says what it is for and that no other instance uses (on Discord a repeated name makes a second channel). Pass `topic_name` whenever you pass no `directory`.
- `create_instance` checks the directory for you: it refuses the current, home and root directories and anything outside `project_roots`, and a directory another instance already uses comes back as `already_exists` with that instance, so reuse it.
- Afterwards, confirm with `describe_instance` that it reached "running"; if it stopped, read its log. The instance-lifecycle skill has the details.

## Keeping the fleet healthy

- Stop the fleet with `agend stop` (from a fleet session it needs `--yes`, and it stops every instance). While it runs, keep `~/.agend/fleet.yaml` and `fleet.pid` in place (edit fleet.yaml as the fleet-config skill describes: validate, then reload) and leave each instance's `output.log` to the daemon.
- Restart a single agent with `restart_instance` and keep the tmux server running: `tmux kill-server` ends every agent's session.
- Run one fleet per AGEND_HOME; a second one collides on ports and sockets.
- Stop an instance before removing it from fleet.yaml, and keep `channel.group_id` unless you re-create every topic, because routing follows it.
- A sensitive change made in the web Settings (access, secrets, connections, …) waits for a fleet admin's confirmation: in General in Telegram or Discord, or on the dashboard where its confirmation card offers that (on a fleet with no chat app: in the browser on the computer running AgEnD, or with the authenticator code). Point people to that card or to General and leave the confirming to them.
- Access modes and allowed users are in the fleet-config skill.

## Memory & Knowledge Management

Your own soul.md is covered by the **Memory** section of your fleet instructions. As General, also keep the shared layers lean:

1. **Fleet decisions** — short shared rules (roles, workflow rules, shared to-dos). They are resent with every request, so keep each to a few lines and link to the details; architecture notes and bug history belong in soul.md or a skill.
2. **Skills** — reusable workflows, loaded on demand from your backend's skills directory: `.kiro/skills/` (kiro), `.claude/skills/` (claude-code), `.agents/skills/` (codex, opencode, muse, antigravity), `.grok/skills/` (grok). Create `<skills directory>/<name>/SKILL.md` once the user agrees to a proposed skill. Bundled skills (`src/general-knowledge/skills/`) hold only what every instance of a role needs.
