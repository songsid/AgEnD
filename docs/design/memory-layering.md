# Memory layering

An agent in the fleet has three places to keep what it knows. They differ in
who shares them, when they reach the agent, and how much context they cost.
The guidance agents themselves receive is in
[`src/general-knowledge/steering/core-rules.md`](../../src/general-knowledge/steering/core-rules.md)
("Memory & Knowledge Management").

| Layer | Stored in | Shared with | Reaches the agent |
|---|---|---|---|
| Fleet decisions | SQLite, `decisions` table ([`src/scheduler/db.ts`](../../src/scheduler/db.ts)) | Every instance it is relevant to | Snapshot in the system instructions; `list_decisions` for the rest |
| `soul.md` | The instance's workspace root | Nobody: one per instance | Only when the agent (or its CLI) reads it; AgEnD does not inject it |
| Skills | The backend's skill directory in the workspace | Bundled skills: every instance of a role. Own skills: that workspace | On demand, by the CLI's own skill mechanism |

## Fleet decisions

- Written with `post_decision` (scope `project` or `fleet`, optional
  `ttl_days`; permanent by default), changed with `update_decision`, read with
  `list_decisions`.
- **Snapshot at fleet start, not per turn.** When the fleet starts,
  `FleetManager` reads all active decisions (fleet scope first, newest first),
  keeps the first 20 and passes them to the daemons (`AGEND_DECISIONS`,
  `src/fleet-manager.ts`). Each daemon keeps only the relevant ones: any
  decision of its own project, plus fleet-scoped decisions that are global or
  belong to the same project family; a General keeps every fleet-scoped
  decision (`selectRelevantDecisions`, `src/daemon.ts`). The instructions then list at
  most 15, title plus first sentence (`src/instructions.ts`). A decision
  posted later is visible through `list_decisions` but is not in the
  instructions until the fleet restarts.
- Because the snapshot is resent with every API call, keep decisions short:
  role basics, cross-instance rules, TODO lists. Architecture notes and bug
  history do not belong here.

## soul.md

- A per-instance runtime file in the workspace (for example
  `~/.agend/workspaces/<name>/soul.md`), never in this repository; `soul.md` is
  in `.gitignore`.
- Holds the long-form memory: architecture, decisions taken, history. The
  core rules tell agents not to create it unless the user asks, and to
  suggest updating it after multi-step work that produced new knowledge.

## Skills

- AgEnD publishes **bundled skills** from `src/general-knowledge/skills/`. Each
  `SKILL.md` declares `roles: [general, worker]` (or one of them); a General
  gets the `general` ones and a fleet-topic worker the `worker` ones.
  ClassicBot instances get none (`syncRoleSkills`, `src/fleet-manager.ts`).
- The directory depends on the backend (`SKILLS_DIR_SEGMENTS`):
  `.claude/skills` (claude-code), `.kiro/skills` (kiro-cli), `.grok/skills`
  (grok), `.agents/skills` (codex, opencode, muse, antigravity). Backends not
  in that map get no skills.
- Published skills are tracked in `.agend-managed-skills.json` in that
  directory. A skill the user wrote there is never overwritten, even if a
  later bundle reuses its name.
- Workflow worth reusing goes into a skill in the workspace's skill directory,
  after the user agrees. Add to the bundled set only what every instance of
  that role needs.
