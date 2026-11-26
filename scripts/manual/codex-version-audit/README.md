# codex version audit rig

Checks a new codex-cli release against what AgEnD reads from codex panes, before the host is upgraded (codex version
policy: real e2e plus history-prone surfaces). Everything runs on a scratch install, scratch homes and a private tmux
socket. There is no account: turns go to a local mock of the Responses API, and the sign-in screen is reached with an
empty home.

## What it needs

- `AUDIT`: a scratch root. Each version is installed there with npm, never into the host's `~/.codex/packages`:
  `npm install --prefix "$AUDIT/codex-X.Y.Z" @openai/codex@X.Y.Z`
- `PORT`: the mock's port, one per version when two versions run side by side.
- Every name belongs to one run, the version plus a short hash of the audit root: the tmux socket `cx<ver>-<ns>`, and
  the homes `$HOME/.cxa<ver><ns>` and `$HOME/.cxs<ver><ns>` (`rig.sh <ver> paths` prints them). Two audits of the same
  version never share a server, a session, a home or a mock. `mock` refuses to go on if another run holds its port.
  Homes sit under `$HOME`, because codex refuses helper binaries under /tmp and its socket path must fit SUN_LEN.
  Delete them when done. The sign-in screen used a separate empty home that was set up by hand.
- `AUDIT_HOME_PARENT` may select a short, audit-owned directory for those two homes instead of `$HOME`.
  Keep the full instance socket path short enough for `SUN_LEN`; the host home and its login stay untouched.

## Steps

`rig.sh <VERSION> <step>`:
- `mock`: start the mock.
- `mode ok|slow|near|usage|e401|e500|capacity`: set what the next turn gets back.
- `launch <name> [resume|fresh] [trust|untrusted] [nudge] [WxH] [workdir]`: AgEnD's production `writeConfig` +
  `buildCommand` (`gen-cmd.ts`).
- `clone <name> <from>`: a second codex on the same command, which shows the thread-lock screen.
- `raw <name> <inst> <workdir> <args…>`: a hand-written command line, e.g. `resume --last` for the working-directory
  picker.
- `cap <scenario> <secs>`: write every changed frame, polled every 25 ms.
- `send`, `key`: type into the pane.
- `kill`: kill an app-server process.
- `stop`: kill the private tmux server.

`pass1.sh` runs the turn sequence: launch, ok, slow (busy), near-limit, usage limit, 401, 500, capacity,
`/compact <args>`, quit, then the production resume. `pass2.sh` covers the dialogs: folder trust (git and plain
dirs), and the rate-limit picker with AgEnD's nudge flag removed, at 150x45 and 80x24, then Escape.

`classify.ts summary <dirs…>` (or `each <dirs…>`) runs the production CodexBackend predicates over the frames: ready,
busy, deliverable, stable-idle, the resume-loading transient, runtime and startup dialogs, and error patterns.

`status-layout.sh <VERSION>` captures two multi-item status orders at 150, 80 and 50 columns with production flags,
then a labelled workspace lab at 150, 110 and 95 columns (F6 focuses its sidebar, F7 returns to the main composer).
The lab alone removes `--no-alt-screen`: production disables the owned transcript and therefore workspace focus.
Use its own `AUDIT` root, inside the same loopback-only isolation; it stores plain frames and a final ANSI frame per
state. It sends no model question. `AUDIT_HOME_PARENT` can keep its short homes inside the audit's owned directory.

The opt-in `AGEND_CODEX_E2E=1` suite can use a mock too: set `AGEND_CODEX_E2E_MOCK_PORT` to its loopback port and
`AGEND_CODEX_E2E_AUTH` to an audit-owned inert auth fixture. Mock mode refuses to fall back to the operator's login.
`AGEND_CODEX_E2E_ROOT` selects a short owned parent for its temporary homes. Run this inside the loopback-only namespace,
with the exact scratch binary on `PATH`; the ordinary real-account mode retains its existing opt-in requirements.

## When codex starts AgEnD's MCP server

Codex 0.172.0 added lazy startup for stdio MCP servers (`mcp_lazy_stdio_startup`, on by default). AgEnD's daemon learns of
an agent from its MCP server's `mcp_ready`, so a server that started only on the first tool call would leave a launched
agent unknown to it. `GEN_MCP=<script>` makes `gen-cmd.ts` register one stdio server the way AgEnD registers its own
(`GEN_MCP_MARK` is handed to it as `STUB_MARK`). `stub-mcp.mjs` is that server: it answers the MCP handshake and logs
each start, request and exit.

`mcp-start.sh <VERSION>` (inside `netns.sh`, with `AUDIT`, `PORT` and `MARK` set) runs a fresh launch, two turns,
quit, a production resume launch and a turn, and prints the log. It checks on the pane that each turn reached codex.
On 0.171.0 and 0.172.0 alike, the server starts and lists its tools within about 1.5 s of each launch, before any turn,
and stays up through the turns until quit. An in-place rebuild (the one case 0.172.0 may defer) isn't exercised: the
mock lists no models, so a `/model` switch is refused. Codex 0.172.0 defers only servers that are not `required`, when it rebuilds its
server set in the same process with a tool catalog already cached. A launch has no earlier set, so it never defers.

## Codex 0.164.0

The [0.163.0 → 0.164.0 audit](../../../tests/fixtures/codex-audit-0164/README.md) captures startup, errors, resume,
onboarding and permission/queued-input surfaces in loopback-only namespaces. The mock's `approval` mode adds an
explicit escalation request to the inert shell probe; use approval-on flags to capture the human dialog. No backend
change was needed. The precheck's unhinted reset-timeout string already exists in both versions.

## Codex 0.165.0

The [0.164.0 → 0.165.0 audit](../../../tests/fixtures/codex-audit-0165/README.md) reran `pass1.sh` + `pass2.sh` on both
versions and the real-CLI e2e. `pass1.sh` gained a `notfound` step (mock mode: a 404 `model_not_found`), for #56445: 0.165
shows the provider's message instead of retrying. No backend change was needed.

## Codex 0.166.0

The [0.165.0 → 0.166.0 audit](../../../tests/fixtures/codex-audit-0166/README.md) reran `pass1.sh` + `pass2.sh` on both
versions under `unshare -rn` (no network). `pass1.sh` gained the workspace-limit prompts (mock `wscredits` / `wsspend`,
#2847) and their Escape. The real-CLI e2e was not run: codex's TUI bootstrap reads the account API, and the audit makes no
real-account calls without the user's OK. No backend change was needed for 0.166. A pre-existing bug the audit found,
`--full-auto` refused by every supported codex, is fixed separately (#2886).

## Every audit: the in-session model switch (M-3175)

AgEnD switches a running codex's model and effort with `/model [NAME] --reasoning=LEVEL` instead of a restart, for a codex
whose running binary is 0.164.0 or later (`src/backend/codex-model-switch.ts`). Before a new version is marked audited,
check that the line still does that and is still answered in the same two places:

1. Launch an instance (`launch b fresh`), then run
   `AGEND_HOME=$AH SOCK=… INST=$RUN/inst-b WORKDIR=$RUN/b-work WIN=b npx tsx model-switch.mts <cases>` with
   `MODEL:EFFORT` (both), `:EFFORT` (the effort alone), `MODEL:` (the model alone) and an unknown model, first before any
   turn (no rollout yet: the verdict comes from the pane), then after one turn (from the rollout).
   `AGEND_HOME` must be the rig's `AH`: the script refuses the host's.
2. Expect `"outcome":"switched"` for each valid case, with `"via":"rollout"` once the session has a rollout (its
   `thread_settings_applied` names exactly what was asked), and `"mismatch"` with codex's `■ …` refusal for the unknown model.
3. Run one turn with `BODY_LOG` set on the mock: the request's `model` and `reasoning.effort` are the switched ones.
4. On the previous version too, if it is older than 0.164.0: `"typed":false`, `"reason":"version"`, the pane unchanged
   and no mock request (0.163.0 sends the line to the model as a prompt).

Any change to the answer line (`• Model changed to MODEL EFFORT for this session only`), the refusal row (`■ …`), the
rollout record, or the `/model` arguments is a detector change: update `codex-model-switch.ts` and its fixtures
(`tests/fixtures/codex-0169-model-switch`).

## A package without codex-code-mode-host (#2357)

`companion-missing.sh <package-dir> <label> [toolexec|tool|toolshell]` launches a codex package layout through
AgEnD's production `writeConfig` + `buildCommand`. That is the directory holding `codex-package.json` and `bin/codex`,
unpacked in scratch. The launch turns on code mode (`[features] code_mode`, `code_mode_host`, `code_mode_only`, through
`gen-cmd.ts`'s `GEN_EXTRA_TOML`) and runs in a private tmux server inside `unshare -rn`. The mock's tool modes answer
the first turn with one tool call, then text:
- `toolexec`: the code-mode `exec` tool;
- `tool`: AgEnD's MCP `reply`;
- `toolshell`: `exec_command`.

Delete `bin/codex-code-mode-host` from a hard-linked copy of the package to reproduce the incident. Captures and what
they show are in `tests/fixtures/codex-0.163.0-companion-missing/SOURCES.md`.

## Process readiness and missed kill scans (#2320)

The namespace test's fake emits `ready` from user code after its **final** exec. It then checks both cmdline and
`CODEX_HOME` before invoking `kill`. A matching cmdline alone is insufficient: Linux's
[`create_elf_tables`](https://github.com/torvalds/linux/blob/v6.6/fs/binfmt_elf.c#L314-L344) publishes the argument
boundaries before it finishes the environment boundaries. `/proc/<pid>/cmdline` can therefore name the new
executable while `/proc/<pid>/environ` is still empty. The held-final-exec test widens this missing-identity interval
without relying on kernel scheduling. It preserves the foreign-run control and verifies the owned child exits.

To observe the actual kernel window, run `python3 scripts/manual/codex-version-audit/repro-exec-readiness.py`.
It starts only owned fake sleeps with a scratch HOME and a large, inert environment; it kills and reaps them all.
Its count is observational, not a CI pass threshold. No Codex binary, account, tmux or fleet is used.

If `kill` selects no process, stderr now records the pgrep candidate PIDs and each candidate's `CODEX_HOME`
(or `<unset>` / `<unavailable>`), without dumping other environment variables. A miss stays a no-op: the rig
never broadens the namespace predicate or retries a paste/turn. Namespace comparison uses a literal path prefix.

## codex 0.162.0 (2026-10-09, host on 0.160.0)

Both versions ran side by side (ports 18762 and 18760). The 0.162.0 frames were compared with the 0.160.0 frames
from the same run.

- **Same reading on every frame:** idle, busy, turn-idle, the resume-loading transient (still held), resumed,
  usage-limit / 401 / 500 / capacity error lines, `/compact <args>`, the folder-trust prompt (git dir) and no prompt
  (plain dir), the rate-limit picker (Escape rule, at both widths) and its dismissal, and the sign-in screen.
  Fixtures: `tests/fixtures/codex-audit-0162/`.
- **Changed, and needed rule changes:**
  - Control keys are now labelled `^c` on Linux (`key_hint.rs` MODIFIER_LABELS; `⌃c` on macOS). This broke the
    thread-lock hold (no match at all) and the resume working-directory picker hold. Fixed in #1443/#1444.
  - The Luna Reserve picker lists the server's buttons. This happens in every version; it was seen live on 0.160.0
    as `1. Upgrade / 2. Reset usage / 3. Continue with Luna Reserve`. Fixed in #1439/#1440.
- **State DB:** the `threads` columns are unchanged. 0.162.0 adds sqlx migration 59 ("thread attachment reverse
  lookup"). 0.160.0 still starts on, and resumes threads from, a home that 0.162.0 has migrated, so rolling back is
  safe.
- **Real e2e** (`AGEND_CODEX_E2E=1`, `vitest.config.codex-e2e.ts`, login symlinked, no turn): 7/7 on 0.162.0 and
  7/7 on 0.160.0.
- **Not reachable here:** the app-server reconnect panes. AgEnD's `-c` overrides make codex run embedded ("Running
  without the shared background server"), so there is no separate process to kill. Their strings ("Reconnecting to
  server…", "Reconnect failed — check the endpoint, then relaunch") are unchanged in the 0.162.0 source. The update
  picker is turned off by AgEnD's config; its strings are also unchanged in the source.

## Codex 0.167.0

The [0.166.0 → 0.167.0 audit](../../../tests/fixtures/codex-audit-0167/README.md) reran `pass1.sh` + `pass2.sh` on both
versions under `unshare -rn`, and captured the sign-in screens from an empty home. One backend change was needed:
0.167's startup folder-trust screen pairs `2. Back to Agent Command Center` with `esc back`, and AgEnD's auto-trust now
accepts that pair too. A rig note: the passes do not stop when `gen-cmd.ts` fails, for example in a checkout without
`node_modules`. Check that `cap/` holds the scenarios before reading `classify.ts`.

## Codex 0.169.0

The [0.167.2 → 0.169.0 audit](../../../tests/fixtures/codex-audit-0169/README.md) reran `pass1.sh` + `pass2.sh` on both
versions under `unshare -rn` and captured the sign-in screens from an empty home. One detector change was needed:
0.169's resume-loading screen shows `  ? for shortcuts` under the composer, which `codexUnboxedResumeLoading` now allows.
Also checked from source: `codex exec`'s new project-trust gate (AgEnD passes its MCP server with `-c`, so it is
unaffected) and the 0.168 429 reconnect status (`Server is busy, reconnecting n/m`, read by nothing in AgEnD).

`signin.sh <VERSION>` captures only the empty-profile method menus, with a positive target check before opening
“Sign in another way”; it never chooses an account login. `rollback.sh <NEW> <OLD>` writes one mock turn with NEW,
then uses the production exact-session resume command and the same owned home with OLD. Run both inside the
loopback-only namespace, with separate AUDIT roots and no imported account.

## Codex 0.171.0

The [0.170.0 → 0.171.0 audit](../../../tests/fixtures/codex-audit-0171/README.md) reran `pass1.sh`, `pass2.sh`,
`status-layout.sh`, `signin.sh`, `rollback.sh`, the model-switch cases and the real-CLI e2e on both versions. No backend
change was needed. 0.171 makes the workspace TUI default-on, but it still needs the owned transcript, which
production's `--no-alt-screen` rules out.

Run every pass through `netns.sh <script> [args…]`. A bare `unshare -rn` leaves `lo` down, so codex never reaches the
mock: every turn shows `Reconnecting... waiting for network`, and the captures look plausible but contain no real
error frames. `netns.sh` raises `lo` as mapped root, maps back to the caller's uid and refuses to run with a
non-loopback route.

## M-3804: policy recourse is not context exhaustion

On Codex 0.169.0 the exact title “You can choose a rewrite to start a new chat with your earlier context” belongs to
[the policy-recourse picker](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/tui/src/chatwidget/safety_recourse.rs).
It requires matching policy-error and moderation metadata; it is not the context-limit/compaction branch.
[Selecting a suggestion](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/tui/src/app/safety_recourse.rs)
forks before the failed turn and submits generated text as a new user turn. That text is not a replacement agent role.
Both Nov26 incidents record `cyber_policy`; the morning failed at 07:13 before the 07:21 fork.
The afternoon’s 436,298 input tokens in a 475k window happened before its policy refusal,
but that correlation does not make the menu a context-full prompt. No private rollout or generated suggestion is published.

AgEnD holds this exact live picker for a person. It never automatically selects or dismisses it, starts a fresh thread,
enables Daybreak or retries the refused request. The existing human-only remote-card path keeps the CLI’s own options as
answer buttons: only the person’s explicit selection is keyed into the verified current pane; changed options invalidate old buttons. Needs you gives a plain reason, the agent and bounded claimed-task context.
The dispatcher's existing liveness sweep reports the policy reason after the configured prompt threshold (default 10min),
with its normal startup grace, persistent dedupe and recovery handling. No new timer or automatic recovery is added.

Context management is separate. `model_auto_compact_token_limit` controls the token threshold, and
`model_auto_compact_token_limit_scope` selects total active context or body after a carried prefix. The pinned
[model implementation](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/protocol/src/openai_models.rs)
clamps the limit to 90% of the context window. The
[turn loop](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/session/turn.rs)
can compact again when the threshold is reached; there is no demonstrated “one compaction then rewrite menu” rule.
Leave model defaults in place; lowering the threshold is a context tradeoff, not a way to pre-answer a policy refusal.
This fix changes no compaction configuration. The localized picker help derives rewrite counts from the actual options and explains
that a rewrite narrows the request in a new chat, while Give feedback does not continue work. A primary human-only
handoff action queues an agent/task policy notice for the dispatcher (or local Needs-you for a person dispatcher),
without answering the pane or reassigning the card. Durable liveness markers deduplicate repost/restart and the later
10-minute sweep. A rejected notice is not marked handed off. The original native options remain separately selectable.

Scratch reproduction: install `@openai/codex@0.169.0` into an owned `$AUDIT/codex-0.169.0` npm prefix, then run
`AUDIT=<owned scratch root> bash scripts/manual/codex-policy-recourse/rig.sh`.
It uses the existing production launch generator with an account-free loopback provider, scratch homes and private tmux
in a network namespace; mock modes `cyber-recourse`/`bio-recourse` emit inert synthetic suggestions. No suggestion is selected.
The [evidence README](../../../docs/evidence/codex-policy-recourse-m3804/README.md) distinguishes native terminal proof,
injected real-dashboard captures and the prior generic-projection comparison.
