# kiro-cli 2.34.0: legacy vs TUI (V2) vs V3 — what AgEnD could use

Survey for board card M-2020, 2026-10-26. Decision 67ddcabc applies: legacy keeps full support. A feature that is new on tui or V3 needs a legacy fallback, or the PR says why there can't be one.

## How this was established

- **Live panes.** All three engines were run on kiro-cli 2.34.0 in the offline rig from `tests/fixtures/kiro-2.34.0-audit/`:
  - a scratch HOME, `unshare -rn`, a private tmux socket `-L k234`, and no account;
  - legacy and tui on the mock chat response; V3 on `KIRO_MOCK_ACP`.
- **Command lists were read off the panes:**
  - legacy: `/help --legacy` and the `/experiment` menu;
  - tui: the `/` palette, walked to the end (38 commands);
  - V3: the `/` palette (41 commands).
- **Static reads** of 2.34.0's `tui.js` and the `kiro-cli-chat` binary decided the engine gates:
  - `kasOnly` / `localOnly` command flags;
  - the `/spawn isn't available in V3` refusal;
  - `userInput` / `mcpElicitation` registered only on the KAS client;
  - `--cloud` / `--repo` "V3/KAS only" in `chat --help`.
- **Caveats on the V3 column:**
  - Some V3 features are behind server-side feature flags. That is marked "flag" in the evidence column. Offline, `/goal` and `/workflows` did not appear in V3's palette, although tui.js has them.
  - Every ✅ for V3 means kiro ships it. Whether a given account has it on is decided server-side.

## Capability matrix

| Capability | legacy | tui | V3 | Evidence |
|---|:-:|:-:|:-:|---|
| `/model`, `/effort` | ✅ | ✅ | ✅ | all three lists |
| `/agent` switch | ✅ | ✅ | ✅ | all three lists |
| `/context` (files, token use) | ✅ | ✅ | ✅ | all three lists |
| `/compact` | ✅ | ✅ | ✅ | all three lists; AgEnD reads the result on legacy/tui only (`compactPaneUi`) |
| `/usage` (billing, credits) | ✅ | ✅ | ✅ | all three lists |
| `/tools`, `/mcp`, `/hooks`, `/prompts` | ✅ | ✅ | ✅ | all three lists |
| `/plan` (plan agent / mode) | ✅ | ✅ | ✅ | all three lists |
| `/knowledge` | ✅ | ✅ | ✅ | legacy: `/experiment` Knowledge, off by default |
| `/code` (LSP code intelligence) | ✅ | ✅ | ✅ | all three lists |
| `/chat` save / load / new | ✅ | ✅ | ✅ | all three lists |
| `/editor`, `/reply` ($EDITOR) | ✅ | ✅ | ✅ | all three lists; they take over the pane |
| `/paste` (clipboard image) | ✅ | ✅ | ✅ | all three lists |
| `/lite` (Lite UI) | ✅ | ✅ | ✅ | all three lists |
| `/todos` | ✅ | ❌ | ❌ | legacy list + `/experiment` Todo Lists; not in the tui or V3 palette |
| `/experiment` (Thinking, Checkpoint, Delegate…) | ✅ | ❌ | ❌ | legacy only |
| `/issue`, `/logdump` | ✅ | ❌ | ❌ | legacy list only |
| `/tangent` (isolated side conversation) | ✅ | ❌ | ✅ | legacy: `/experiment` Tangent Mode + Ctrl+T; tui: `kasOnly`; V3 list |
| `/rewind` (fork at an earlier turn) | ❌ | ✅ | ✅ | tui + V3 lists; legacy has `/experiment` Checkpoint instead (files, not turns) |
| `/goal` (goal with validation criteria) | ❌ | ✅ | ✅ | tui list; V3 behind flag `workflows` |
| `/spawn`, `/switch` (spawned agent sessions) | ❌ | ✅ | ❌ | tui list; V3 refuses "/spawn isn't available in V3" |
| `/guide` (guide agent) | ❌ | ✅ | ❌ | tui list; legacy's `/help` switches to a help agent instead |
| `/session-id` | ❌ | ✅ | ✅ | tui + V3 lists |
| `/title` (terminal title) | ❌ | ✅ | ✅ | tui + V3 lists |
| `/transcript` ($PAGER), `/copy` | ❌ | ✅ | ✅ | tui + V3 lists; takes over the pane |
| `/fullscreen`, `/kvim` (Neovim), `/settings` | ❌ | ✅ | ✅ | tui + V3 lists |
| `/verbosity` | ❌ | ✅ | ❌ | tui list; not in the V3 palette (offline) |
| `/memories` (repo-scoped memory) | ❌ | ❌ | ✅ | V3 list; tui.js `kasOnly`, flag `memory` |
| `/sessions` dashboard | ❌ | ❌ | ✅ | V3 list; tui says "available on the V3" |
| `/spec` (spec mode, spec tasks) | ❌ | ❌ | ✅ | V3 list; `--mode spec` |
| `/sandbox` (local sandbox) | ❌ | ❌ | ✅ | V3 list; tui.js requires kas |
| `/autonomous` | ❌ | ❌ | ✅ | V3 list; flag `remote_sandbox` / `local_sandbox` |
| `/powers`, `/config`, `/upgrade-agent` | ❌ | ❌ | ✅ | V3 list |
| `/workflow*` | ❌ | ❌ | ✅ | tui.js `kasOnly`, flag `workflows`; not in the offline V3 palette |
| Cloud sessions (`--cloud`, `--repo`) | ❌ | ❌ | ✅ | `chat --help`: "V3/KAS only" |
| Steer a running turn, as AgEnD drives it | ❌ | ✅ | ✅ | composer "Type to steer"; AgEnD steers tui on 2.27.1/2.28.0/2.34.0 and V3 on 2.27.1 (`KIRO_STEER_VERIFIED`) and never on legacy. Whether legacy can steer natively is **unverified**: it has no steer command in `/help --legacy`, but kiro's embedded doc index has a "mid-turn-steering" page |
| Queue the next message (Ctrl+S) | ❌ | ✅ | ✅ | "Ctrl+S to queue" on the busy composer |
| `!cmd` shell escape | ✅ | ✅ | ✅ | tui/V3 run it in a PTY and forward keys; "can't be queued" |
| Agent's question card (`question_request`) | ❌ | ❌ | ✅ | #2592; only the KAS client registers `userInput` |
| MCP elicitation card | ❌ | ❌ | ✅ | #2587; v1/v2 answer `elicitation/create` with -32601 |
| "Trust this workspace?" | ❌ | ❌ | ✅ | #2345; `--trust-workspace` "V3 only" |
| Trust-all-tools warning at launch | ❌ | ✅ | ✅ | captured on tui and V3 ("No, exit / Yes, I accept / …"); legacy prints a notice instead |
| Per-capability approval scopes, trust classifier | ❌ | ❌ | ✅ | tui.js `kasScope`, `trust_classifier_enforce` |
| Subagents (agent-side) | ✅ | ✅ | ✅ | legacy `use_subagent` tool (`/experiment` Delegate being replaced); tui/V3 subagent panel |
| `--resume`, `--resume-id`, `--list-sessions` | ✅ | ✅ | ✅ | `chat --help`; the stores differ per engine (#2617) |

## What AgEnD already does, per engine

- **Launch.** Every engine is pinned on every launch (`--legacy-ui --agent-engine=v1`, `--tui --agent-engine=v2`, `--v3`). Moving between engines is one-way and admin-confirmed (`migrate_kiro_instance`, #2618). New instances default to tui (#2621).
- **Transcripts** are read from the engine's own store, by the pinned id (#2617).
- **Steer** on tui (2.27.1, 2.28.0, 2.34.0) and V3 (2.27.1 only).
- **Busy insert** on tui on 2.34.0 (#2678, 9252bcee): a message for a busy kiro TUI goes into its box within seconds, as on claude and codex.
- **Held for a person:**
  - the model picker: on legacy, and on tui since #2674 (a0ea8449), which captured the real 2.34.0 tui picker ("Select model: type to search") and holds both title forms. The model-unavailable outage picker is still captured under legacy only;
  - trust prompts;
  - V3 workspace trust;
  - V3 question and MCP cards. #2675 posts these to the chat to be answered: #2677 is merged, and #2680 is in review.
- **`/compact`:** its result is read on legacy and tui, not on V3.

## Candidate features

Value is for the person running the fleet. Effort: S is under a day, M is about one PR with captures, L is several PRs or a design.

| # | Feature | Engines | Value | Effort | Risk | Legacy fallback |
|---|---|---|---|---|---|---|
| 1 | **Read `/compact`'s result on V3** too, so the Compact quick action reports done or failed | V3 | Medium: today V3 compactions are unconfirmed | S | low (capture V3's line) | already works |
| 2 | **Steer verified for V3 on 2.34.0** (B4), so V3 instances can be steered mid-turn | V3 | High once instances move to V3 | S–M | needs one real-account capture (D5) | not available: legacy waits for idle, as today |
| 3 | **The remaining model-picker holds** (B6): V3's picker, and the tui outage picker. The tui `/model` picker is held since #2674 | V3, tui (outage only) | High (safety) | S–M | needs a real outage or mock capture | already covered |
| 4 | **Full-screen takeover guard**: while `/transcript` ($PAGER), `/editor`, `/reply`, `/kvim` or `/fullscreen` owns the pane, hold deliveries and show "waiting at its terminal" | all (`/editor`, `/reply` exist on legacy too) | Medium: a paste into $PAGER or vi is lost, or worse | M | the shapes vary by $PAGER and $EDITOR; key off kiro's own rows | the same guard covers legacy's `/editor` and `/reply` |
| 5 | **`/session-id` as identity proof** after a launch or resume, instead of inferring the session from files | tui, V3 | Medium: makes resume-by-id (#2617) checkable | S | low; read-only command | legacy keeps the sqlite lookup |
| 6 | **`/rewind` from the chat** ("undo the last turn") | tui, V3 | Medium | M | high: it forks into a new session, so the identity changes and the transcript pin must move (as #2617 did) | none; legacy's Checkpoint restores files, not turns. Say so in the UI |
| 7 | **`/tangent` from the chat** ("ask aside" without polluting context) | legacy (experiment), V3 | Low–medium | M | medium: legacy needs `chat.enableTangentMode`, and the tangent's replies must be routed | legacy: enable the experiment per instance |
| 8 | **`/memories` and `/sessions` on the web** for a V3 instance | V3 | Low–medium | M | medium: kiro's own dashboard UI is full-screen; read its files instead | none (V3-only data) |
| 9 | **`/goal` as a task-board link**: set a goal from a board card, and show "Goal Paused" or done | tui, V3 (flag) | Medium | M–L | medium: flag-gated on V3; its pane text has to be captured | none: the board card stays the record |
| 10 | **`/title` = instance name** at launch, so a person attaching to tmux sees which instance they are in | tui, V3 | Low | S | low | legacy: tmux window name, as today |
| 11 | **V3 sandbox status** on the dashboard (`/sandbox`), with a warning when tools are being refused by it | V3 | Medium for V3 safety | M | medium: offline, the sandbox stopped every launch until confirmed | none: legacy and tui have no sandbox |
| 12 | **Usage from `/usage`** for engines whose usage files AgEnD can't read | all | Low: AgEnD already scans kiro usage (`kiro-usage-scan.ts`) | M | parsing a full-screen panel | already covered |

Not recommended: `/spawn` and `/switch` (tui only, refused on V3). They start agent sessions inside one pane, which AgEnD's one-session-per-instance model can't track. `/autonomous` and cloud sessions (`--cloud`) change where the work runs, outside AgEnD's pane, so they need their own design first.

## Gaps under tui (and V3) compared with legacy

1. **Interactive prompts from the agent's own shell commands (sudo, ssh passwords).** Under tui the agent's commands run detached, with no tty (#2598 B7, #1110). A `sudo` needing a password hangs the tool call instead of painting `[sudo] password for …` in the pane, so AgEnD's interactive-prompt detector has nothing to see. Legacy paints the prompt in the pane, and AgEnD tells a person. This is D7 on #2598: instances that need sudo should stay on legacy, or use passwordless sudo for the specific commands.
2. **`!cmd` takes over input.** On tui and V3, a `!` command runs in a PTY and forwards keystrokes until it exits, and it can't be queued. A delivery pasted meanwhile goes into the command. AgEnD has no hold for this yet; it belongs to candidate 4.
3. **Fewer submission proofs.** Legacy has the bottom-ready gate and the stranded-input proof. Tui relies on output silence plus the busy row (#2598 B5): no known failure, but less assurance.
4. **Holds not yet captured off legacy:** the model-unavailable outage picker on tui, and V3's model picker (#2598 B6, candidate 3). The tui `/model` picker itself is held since #2674.
5. **Legacy-only commands with no tui/V3 equivalent:** `/todos`, `/experiment` (Thinking, Checkpoint, Delegate), `/issue`, `/logdump`. None of them is used by AgEnD today.
6. **V3-only prompts.** Workspace trust, question cards, MCP input and approval scope pages never appear on tui. Code must not assume V3's handling on tui, and tui must not wait for them.

## Pane strings worth pinning (tui/V3)

These are AgEnD's parse targets if the candidates above are built:
- "Type to steer" / "Ctrl+S to queue" (composer mode);
- "Kiro is working · Ns";
- "Shell escape commands can't be queued";
- "/spawn isn't available in V3";
- "Session dashboard is available on the V3";
- "Exited with status N" / "[exit code: N]" (`!` commands);
- "Goal Paused".
