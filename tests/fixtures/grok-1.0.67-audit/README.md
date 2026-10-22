# grok 1.0.67 audit against 1.0.62 (2026-10-22, upstream watch)

The baseline is 1.0.62, the version the watch compared against. The last live audit was 1.0.60's (`tests/fixtures/grok-1.0.60-audit`), and the same rig ran here. The host runs 1.0.46 and was not touched. No official changelog exists for 1.0.63–1.0.67.

**Result: SAFE, no code change.**
- After normalisation, every captured pane is identical across 1.0.62 and 1.0.67 at 120 and 80 columns: launch, trust, ready, busy, cancel, eight error turns, tool, compact, new, MCP call, quit, resume and the approval card. The only difference is the timestamp of the dead pane.
- So are four failed `/compact` runs and the Agent Dashboard.
- Every `GrokBackend` detector gives the same verdict on both versions (`tests/grok-1.0.67-audit.test.ts`), and the same verdicts as 1.0.60's audit.

## Artifacts

| | 1.0.62 | 1.0.67 |
|---|---|---|
| `grok-<ver>-linux-x86_64` sha256 | `2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa` | `ce33b1a29e37901f56fe59916cda7a1149e6fd377118f918e90d89f9abb52a51` |
| `grok --version` | `grok 1.0.62 (1474f9cbdd91)` | `grok 1.0.67 (2fe064390d07)` |

`grok --help` (`help-diff.txt`):
- The long descriptions are shortened.
- `cursor-worker` is renamed `worker`.
- `--add-dir <DIR>` is new.
- The flags AgEnD passes are unchanged: `--always-approve`, `--resume`, `--model` and `--reasoning-effort` are listed as before. `--no-auto-update` is still a hidden flag that both versions accept (every capture launched with it). `launch-effort.ts` reads the reformatted help the same way: low, medium and high are passed, and xhigh is not (`help-1.0.62.txt`, `help-1.0.67.txt`).

## Static precheck (`precheck-1.0.62-1.0.67.txt`)

**MAJOR, hard=1, hinted=4.** None of the flagged strings changes a screen on AgEnD's path:

- **hard=1, the unhinted one:** "usage limit reached / status 401 / unauthorized / invalid_request_error". It is grok's compaction-error classifier word list ("spending-limit, out of credits, usage balance exhausted, usage limit reached, status 401, unauthorized, invalid_request_error"), byte-identical in both binaries. Only its neighbour is new: a "Compaction failed: Compaction sampler build failed: … start a new session using /new." string. Live, a `/compact` whose request fails paints the same line on both versions (`*-compact-120/60-compact-fail-*`):
  - 401: `┃  Compaction failed - Unauthorized (401) from …: invalid_request_error: Incorrect API key provided` → `auth_error`. As for every grok auth hit, the second opinion `grok models` decides; #1792.
  - 402: `… API error (status 402 Payment Required): …` → `quota`, notify.
  - 403 "usage limit reached": `… (status 403 Forbidden): invalid_request_error: usage limit reached` → unclassified, like the turn's 403-usage.
  - 500: `… (status 500 Internal Server Error) …` → nothing.
  - The next turn clears each one.
- **"Yes, proceed / No, cancel … Do you trust the contents"** next to "Grok Build". The strings moved within the binary: they now neighbour the Agent Dashboard's ("Choose", "+ New Agent", box glyphs). The dashboard (`grok dashboard`; never launched by AgEnD) paints the same on both versions (`*-dashboard/`). The **launch-path** trust prompt is byte-identical (`*/01-trust`): `Yes, proceed  y / No, quit  n`, and AgEnD answers `y`.
- **"rate limit exceeded; sleeping. / service not ready; poll_ready must be called first"**: the AWS SDK's (smithy) internal rate-limiter text, byte-identical in both binaries; only neighbours moved. Never painted. A main-turn 429 still paints `Retry failed: rate_limit_error: …` → `rate_limit` (`*/07-err-429*`).
- **"Press Enter to apply and save…", "Press Esc to close…", "press Enter to retry. The turn was stopped…", "Resume the paused goal…", "usage limit upsell…"**: the same strings as in 1.0.62 (the "gone" list shows them), with new neighbours.
- **Counts:** "Grok Build" 75→78 and "rate_limit" 73→72. Both are string-pool churn. The ready and busy verdicts are identical on every pane (busy: `03`, `05`, `10`; idle elsewhere).

## Live (`<version>-<columns>/`, `<version>-approval/`, `<version>-compact-120/`, `<version>-dashboard/`)

**The rig** (`rig/`) is the 1.0.60 audit's:
- a `docker run --network none` container, a private `tmux -L`, a fresh `HOME` per run, binaries mounted read-only, no real account;
- AgEnD's launch line `grok --no-auto-update --always-approve` in a git repo with an AgEnD-shaped `.mcp.json` and `AGENTS.md`;
- `XAI_API_KEY` is a dummy, and `GROK_XAI_API_BASE_URL` points at the local mock (`rig/mock.js`).

New in this rig:
- `compact.sh`: the mock fails the compaction request (its prompt opens "Your task is to produce a faithful, concise summary") with the status named in `COMPACT_ERR_FILE`.
- `dash.sh`: `grok dashboard`, Enter, Enter, Esc.

**Steps:**
- `run.sh <version> <width>`: the 1.0.60 steps, 01 to 52.
- `approval.sh`: no `--always-approve`, and a command grok asks about.
- `compact.sh`: a turn, then `/compact` failing with a 401, 403 "usage limit reached", 500 and 402, each followed by a normal turn.

## Unchanged gaps (both versions, already on #1792)

- Grok's own 401 text for a turn has no status code and matches no auth pattern (`07-err-401`). A failed `/compact` does show one (`Unauthorized (401)`).
- The 500 retry line ends in ASCII `...` and does not read busy (`07-err-500`).
- A 403 "usage limit" body is not classified (`07-err-403-usage`, `60-compact-fail-g`).
- The runtime "Yes, always" net matches neither version's approval card (`*-approval/20-approval`). AgEnD's default launch passes `--always-approve`.
