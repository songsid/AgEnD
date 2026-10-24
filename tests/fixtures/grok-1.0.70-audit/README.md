# grok 1.0.70 audit against 1.0.67 (2026-10-24, upstream watch)

The baseline is 1.0.67, the last version audited live (`tests/fixtures/grok-1.0.67-audit`), and the same rig ran here. The host runs 1.0.46 and was not touched. No upstream release notes exist for 1.0.68–1.0.70.

**Result: SAFE, no code change.**
- After normalisation, every captured pane on AgEnD's path is the same on 1.0.67 and 1.0.70, at 120 and 80 columns. That covers launch, trust, ready, busy, cancel, eight error turns, tool, compact, new, MCP call, quit, resume, the approval card, and four failed `/compact` runs.
- Two differences, both cosmetic:
  - the welcome card lists **Resume session** before **New worktree**;
  - the Agent Dashboard (`grok dashboard`, never opened by AgEnD) moved its folder label into the box border.
- Every `GrokBackend` detector gives the same verdict on both versions (`tests/grok-1.0.70-audit.test.ts`), and the same verdicts as the 1.0.60 and 1.0.67 audits.

## Artifacts (`versions.txt`)

| | 1.0.67 | 1.0.70 |
|---|---|---|
| `grok-<ver>-linux-x86_64` sha256 | `ce33b1a29e37901f56fe59916cda7a1149e6fd377118f918e90d89f9abb52a51` | `22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9` |
| `grok --version` | `grok 1.0.67 (2fe064390d07)` | `grok 1.0.70 (f50904eaee6c)` |

The 1.0.67 binary is byte-identical to the one audited on 2026-10-22.

`grok --help` (`help-*.txt`, `help-diff.txt`; each file also holds `grok worker --help` and `grok worker controller --help`):
- The flags AgEnD passes are unchanged: `--always-approve`, `--resume`, `--model` and `--reasoning-effort` are listed as before. `--no-auto-update` is still hidden and accepted: every capture launched with it.
- `--oauth` now reads "Force browser (loopback) login when the welcome screen authenticates". `grok login` still offers `--device-auth` (alias `--device-code`); `LOGIN_FLOWS.grok` runs plain `grok login`.
- **New: `grok worker controller`**. It claims pending Cursor Cloud Agent requests for team pools and runs a spawn hook for each. `grok worker` also gains many pool options. AgEnD never runs `grok worker`.

## Static precheck (`precheck-1.0.67-1.0.70.txt`)

**MAJOR, hard=3, hinted=5.** None of the flagged strings changes a screen on AgEnD's path:

- **"press Ctrl+C again to exit now / forced stop: killed the running hooks and released their claims" and "stopping after the running hooks finish; press Ctrl+C again to kill them"** (near "grok login"). These are new in 1.0.70 and belong to `grok worker controller`: its two-stage stop for the spawn hooks it runs (the neighbouring strings are "only `grok worker controller` runs without a leader" and "connect_leader_control").
  - Captured offline (`1.0.70-controller/`, `--network none`, a dummy key): it logs `INFO stopping after the running hooks finish; press Ctrl+C again to kill them` on the first Ctrl+C and exits when no hook runs.
  - It is a log line of a headless command, not an interactive prompt.
  - AgEnD stops a grok session with grok's own double Ctrl+Q, whose screens are unchanged (`50-quit-single`, `51-quit-double`).
- **"Yes, proceed / No, cancel / Do you trust the contents of this directory?"** next to "Grok Build". These are the Agent Dashboard's strings, as found in the 1.0.67 audit. Their neighbours moved again.
  - The dashboard paints the same on both versions except for its folder label: 1.0.67's `/tmp/… [Choose Ctrl+l]` line above the box is now `/tmp/… · Ctrl+l` in the top border (`*-dashboard/`).
  - The **launch-path** trust prompt is byte-identical (`*/01-trust`): `Yes, proceed  y / No, quit  n`, and AgEnD answers `y`.
- **"Rate limited (Request timed out (Conflict (failed after retries: request error:"**. This is grok's HTTP status-name table ("Bad Request (", "Too Many Requests (", "Rate limited (", …), with a new neighbour, "Server error: [unavailable]". A main-turn 429 still paints `Retry failed: rate_limit_error: …` → `rate_limit` (`*/07-err-429*`, identical on both).
- **"rate limit exceeded; sleeping. / service not ready; poll_ready must be called first"**: the AWS SDK's (smithy) internal rate-limiter text, as in 1.0.67, with new neighbours. It is never painted.
- **"usage limit reached / status 401 / unauthorized / invalid_request_error"**: grok's compaction-error classifier word list, unchanged. A failed `/compact` paints the same line and gets the same verdict on both (`*-compact-120/60-compact-fail-*`).
- **Elsewhere ("Press h to show all.", "press Enter to retry. The turn was stopped…", "Resume the paused goal…", "usage limit upsell…", "press t to turn memory on or off…", "resume the subagent / Failed to rehydrate subagent worktree")**: the same strings as in 1.0.67 with new neighbours, or features AgEnD's launch does not reach (subagent worktrees, memory view).
- **Counts:** "Grok Build" 78→83, "rate limit" 31→32 and "rate_limit" 72→75. All three are string-pool churn. The ready, busy and rate-limit verdicts are identical on every pane.

## Live (`<version>-<columns>/`, `<version>-approval/`, `<version>-compact-120/`, `<version>-dashboard/`, `1.0.70-controller/`)

**The rig** (`rig/`) is the 1.0.67 audit's:
- `go.sh <version> "<command>"` runs one `docker run --rm --network none --user 1000` container of image `grok-audit-160`, with the binary mounted read-only at `/bin/grok-<version>`.
- Inside it: a private `tmux -L`, a fresh `HOME` per run, and no real account. AgEnD's launch line `grok --no-auto-update --always-approve` runs in a git repo with an AgEnD-shaped `.mcp.json` and `AGENTS.md`. `XAI_API_KEY` is a dummy, and the API base URLs point at the local mock (`rig/mock.js`).

**Steps:**
- `run.sh <version> <width>`: steps 01 to 52, as in 1.0.67.
- `approval.sh`: no `--always-approve`, and a command grok asks about.
- `compact.sh`: `/compact` failing with a 401, 403 "usage limit reached", 500 and 402, each followed by a normal turn.
- `dash.sh`: `grok dashboard`.
- **New, `controller.sh`:** `grok worker controller --all-pools --spawn /bin/true`, offline (its DNS lookups fail), then Ctrl+C three times.

## Unchanged gaps (both versions, already on #1792)

- Grok's own 401 text for a turn has no status code and matches no auth pattern (`07-err-401`).
- The 500 retry line ends in ASCII `...` and does not read busy (`07-err-500`).
- A 403 "usage limit" body is not classified (`07-err-403-usage`, `60-compact-fail-g`).
- The runtime "Yes, always" net matches neither version's approval card (`*-approval/20-approval`). AgEnD's default launch passes `--always-approve`.
