# codex version audit rig

Checks a new codex-cli release against what AgEnD reads from codex panes, before the host is upgraded (codex version
policy: real e2e plus history-prone surfaces). Everything runs on a scratch install, scratch homes and a private tmux
socket. There is no account: turns go to a local mock of the Responses API, and the sign-in screen is reached with an
empty home.

## What it needs

- `AUDIT`: a scratch root. Each version is installed there with npm, never into the host's `~/.codex/packages`:
  `npm install --prefix "$AUDIT/codex-X.Y.Z" @openai/codex@X.Y.Z`
- `PORT`: the mock's port, one per version when two versions run side by side.
- Homes go under `$HOME/.cxa<ver>`, `$HOME/.cxs<ver>` (and `.cxl<ver>` for the sign-in screen). Codex refuses helper
  binaries under /tmp, and its socket path must fit SUN_LEN. Delete these homes when done.

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
