# grok 1.0.60 audit against 1.0.52 (2026-10-16, upstream watch)

The baseline is 1.0.52, the last audited version (`tests/fixtures/grok-1.0.52-audit`). The host runs 1.0.46 and was not touched.

## Artifacts

| | 1.0.52 | 1.0.60 |
|---|---|---|
| `grok-<ver>-linux-x86_64` sha256 | `1668414b047e1050a96d25fe17dfc3efe63190fbf66d8cc1c3de8633caf50d11` | `10e6af64b24724fc1074c373e906b9ad121110044dddcbd97ad43c3a25f96d5f` |
| `grok --version` | `grok 1.0.52 (0920c8169e27)` | `grok 1.0.60 (01a8e1c591c0)` |

`grok --help` differs in one line (`help-diff.txt`): `--resume` also matches a title written with other separators. The flags AgEnD passes are unchanged. `--no-auto-update` is still a hidden flag that both versions accept, and `--always-approve`, `--resume` and `--model` are unchanged.

## Static precheck (`precheck-1.0.52-1.0.60.txt`)

**MAJOR, hard=2, hinted=1.** No item is on AgEnD's path:
- **"Yes, proceed / No, cancel / Do you trust the contents".** There are two copies:
  - The Agent Dashboard's folder picker, whose neighbouring strings moved. AgEnD never opens the dashboard.
  - The tool-approval card's option 2, "Yes, proceed". It is now the card's **default** selection, where 1.0.52 defaulted to option 1, "always-approve mode" (`*-approval/20-approval`). With its default launch (`skipPermissions` unset or true) AgEnD passes `--always-approve`, so the card does not come up. An instance configured with `skipPermissions: false` launches without that flag (`src/backend/grok.ts`), and there the card can come up. AgEnD's runtime net presses `1` explicitly, never Enter on the default. It matches neither version's card, though (below), so the default moving from 1 to 2 is no new regression, and it was not run live here.
  - The launch-path trust prompt is byte-identical: `y  Yes, proceed / n  No, quit / Enter or y to trust · n or Esc to quit` (`*/01-trust`).
- **"subagent rate limit cannot clear by waiting; failing the turn".** This is a tracing event for grok's own subagents (`shell.turn.subagent_rate_limit_vetoed`, next to "disabling the subagent rate-limit wait loop because the sampler owns 429 retries"). It is not painted for a main-turn 429. Both versions paint `Retry failed: rate_limit_error: …`, which reads as `rate_limit` (`*/07-err-429*`).
- **"usage limit reached … status 401 … unauthorized".** This is the same compaction-error classifier list as 1.0.52 (`session/compaction.rs`), unchanged except for its neighbours. A 403 whose body says "usage limit reached" paints `Request denied (403): invalid_request_error: usage limit reached` on both versions (`*/07-err-403-usage`).

The "rate_limit" count change (66→73) is those subagent strings. No detector literal is missing.

## Live (`<version>-<columns>/*.pane.txt`, `<version>-approval/`)

**Isolation and launch** (`rig/`):
- Isolation: a `docker run --network none` container (node:22-bookworm plus tmux), a private `tmux -L`, a fresh `HOME` per run, and the binaries mounted read-only. No real account was used.
- Launch: AgEnD's own line, `grok --no-auto-update --always-approve`, in a git repo holding a `.mcp.json` (a stub stdio MCP server with one tool, `reply`) and `AGENTS.md` in the shape `GrokBackend.writeConfig` writes.
- Auth: `XAI_API_KEY` is a dummy, and `GROK_XAI_API_BASE_URL` points at a local chat-completions SSE mock (`rig/mock.js`). **Correction to the 1.0.52 README:** `GROK_CLI_BASE_URL` is only the update check's base, and the API base is `GROK_XAI_API_BASE_URL` (or `XAI_API_BASE_URL`).
- Side requests: requests with no tools (title, next-prompt suggestion) get an empty answer. Otherwise grok shows the mock's text as a composer suggestion (seen in a first 1.0.60 pass; the feature exists in both binaries).
- Folder trust: `GROK_FOLDER_TRUST=1` makes the prompt appear.
- Delivery: text goes in with `tmux paste-buffer -p` and then Enter.
- Labels: the error turns' prompts are letters (`error turn a` … `h`), and the mock replies `mock reply r<n>`.

**Steps** (the same script on both versions, at 120 and 80 columns):
- 01: trust;
- 02: ready;
- 03 and 05: a stalled turn (busy);
- 04 and 06: done, and Ctrl+C;
- 07: the mock returning:
  - 401 (`a`);
  - 402, the weekly-limit modal (`b`; `-esc` is after Esc);
  - 403 (`c`), 426 (`d`), 429 (`e`) and 500 (`f`, grok's own retry line);
  - a 403 "usage limit reached" body (`g`, `-usage`);
  - a 429 with "rate limit exceeded; too many requests" (`h`, `-text`);
- 09: a `run_terminal_command` under `--always-approve`;
- 10 and 11: `/compact ` and `/new`.

At 120 columns only:
- 32: an MCP `use_tool` call (`agend-audit-grok__reply`);
- 50 and 51: one Ctrl+Q, then two presses 250 ms apart, with `remain-on-exit` on;
- 52: `--resume <id>` from 51.

`<version>-approval/`: a fresh HOME without `--always-approve`, and a command grok asks about (`mkdir … && rm -rf … && curl …`); `echo` and `touch` ran without a card on both versions.

**Result:**
- After normalising times, durations, token counts, the version, the path, the spinner frame, session ids, reply numbers and retry attempts, every step's pane is identical across versions at both widths.
- `GrokBackend`'s ready, busy, error and dialog detectors give the same verdict for every step on both versions (`tests/grok-1.0.60-audit.test.ts`).
- `--resume <id>` brought the conversation back on both.
- Sessions are under `~/.grok/sessions/<encoded cwd>/<uuid>/` on both, as `getSessionId()` expects.

## Unchanged gaps (both versions, already on #1792)

- Grok's own 401 text has no status code and matches no auth pattern (`07-err-401`).
- The 500 retry line ends in ASCII `...` and does not read busy (`07-err-500`).
- A 403 "usage limit" body is not classified (`07-err-403-usage`).
- The runtime "Yes, always" net matches neither version's approval card (`20-approval`). It is a net only: AgEnD's default launch passes `--always-approve`; with `skipPermissions: false` the card is reachable and the person answers it.
