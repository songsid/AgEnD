# grok 1.0.52 audit against 1.0.50 (2026-10-13, #1792)

The baseline is 1.0.50, the version the upstream watch last saw. The host runs 1.0.46 and was not touched.

## Artifacts

| | 1.0.50 | 1.0.52 |
|---|---|---|
| `grok-<ver>-linux-x86_64` sha256 | `c80de0155706ff2d995623887b102f2d0abd2c62b2643dea3a0cebaf7dd724d5` | `1668414b047e1050a96d25fe17dfc3efe63190fbf66d8cc1c3de8633caf50d11` |
| `grok --version` | `grok 1.0.50 (c58f321264ba)` | `grok 1.0.52 (0920c8169e27)` |

`grok --help` differs in one line: `--allow` gained the alias `--allowed-tools`. AgEnD's flags (`--no-auto-update`, `--always-approve`, `--resume`, `--model`) are unchanged.

## Static precheck (`precheck-1.0.50-1.0.52.txt`)

**MAJOR, hard=2.** Neither item is on AgEnD's path:
- **"Yes, proceed / No, cancel" near "Do you trust the contents".** This is a third copy of the trust question. The Agent Dashboard's folder picker uses it (`Ctrl+L` or `/cd` in `grok dashboard` or `/dashboard`); see the bundled `docs/user-guide/23-dashboard.md`. AgEnD never opens the dashboard. The launch-path prompt still reads `y  Yes, proceed / n  No, quit` (`*/01-trust`). "Trust this folder?" is a new short gate label next to "Review the data notice" and "Sign in to Grok".
- **"usage limit reached … status 401 … unauthorized" near "out of credits".** This is grok's existing compaction-error classifier list, unchanged except for a new neighbouring key (`detail`). It is present in 1.0.50.

The count changes ("Grok Build" 70→74, "rate_limit" 62→66, "Do you trust the contents" 2→3) are those copies. No detector literal is missing.

## Live (`<version>-<columns>/*.pane.txt`)

**Isolation and launch:**
- Isolation: a `docker run --network none` container, a private `tmux -L`, a fresh `HOME` per run, and the binaries mounted read-only. No real account was used.
- Launch: AgEnD's own line, `grok --no-auto-update --always-approve`, in a git repo holding the `.mcp.json` (a stub stdio MCP server) and `AGENTS.md` that `GrokBackend.writeConfig` writes.
- Auth: `XAI_API_KEY` is a dummy, and `GROK_CLI_BASE_URL` points at a local chat-completions SSE mock that can stall, call a tool, or fail with a chosen status and body.
- Folder trust: `GROK_FOLDER_TRUST=1` makes the prompt appear, as it does for real accounts.
- Delivery: text goes in with `tmux paste-buffer -p` and then Enter, as AgEnD sends it.
- Labels: the error turns' prompts are letters (`error turn a` … `f`), and the mock replies `mock reply r<n>`. A status code on screen is therefore grok's, never an echo of the rig's own text. (A first pass used `error turn 401`, and `\b401\b` matched the prompt.)

**Steps** (the same script on both versions, at 120 and 80 columns):
- 01: trust;
- 02: ready;
- 03 and 05: a stalled turn (busy);
- 04 and 06: done, and Ctrl+C (the prompt goes back to the composer);
- 07: the mock returning 401, 402 (the weekly-limit modal, now with a third choice `3 (○) Try Again`; `-esc` is after Esc moves the keyboard to the scrollback), 403, 426, 429 and 500 (grok's own retry line);
- 09: a `run_terminal_command` under `--always-approve`;
- 10 and 11: `/compact ` and `/new`.

At 120 columns only:
- 20: the approval card without `--always-approve`;
- 32: an MCP `use_tool` call to the `.mcp.json` server;
- 50 and 51: one Ctrl+Q, then two presses 250 ms apart, with `remain-on-exit` on.

**Result:**
- After normalising times, durations, token counts, the version, the path and the spinner frame, the two versions' panes are identical. The exceptions are a reply-number column and the retry attempt number.
- `GrokBackend`'s ready, busy, error and dialog detectors give the same verdict for every step on both versions (`tests/grok-1.0.52-audit.test.ts`).
- `--resume <id>` carried the conversation on both, and `getSessionId()` found the session under `~/.grok/sessions/<encoded cwd>/<uuid>` on both.

**The leader's MINOR list:**
- "Approve Mode / Edit Prompt in External Editor", "Subagents are still running. Stop them?", "Press Esc to close" and "rate limit exceeded; sleeping" all exist in 1.0.50; only neighbouring strings moved.
- A double Ctrl+Q with a background subagent running quits directly on both versions, with no "Stop them?".
- "usage limit upsell" is a new question kind, next to the existing "credit-limit upsell". It was not reachable with an API key.

## Found (every version)

### Not fixed here: grok's 401 text, and an auth second opinion that always says "valid"

Grok paints a rejected or expired credential as "Authentication required: your session has expired or your credentials were rejected. Run /login to re-authenticate, then resend your message." The text has no status code. The same string is in the 1.0.46, 1.0.50 and 1.0.52 binaries. No `GrokBackend` auth pattern matches it (`*/07-err-401`).

A pattern alone would not help. Every grok auth hit first gets a second opinion from `grok models` (`LOGIN_FLOWS.grok.authCheck`), and a zero exit drops the hit as conversation text. `models/grok-models-<ver>.txt` records `grok models` against the mock, and it exits 0 every time:
- with a valid key;
- with a key the API rejects (401 on `/v1/models`): an empty list;
- with an unreachable API: the same empty list;
- with no credential at all: "You are not authenticated." plus a built-in list.

So no grok auth pattern can pause an instance today. That includes the existing `unauthorized|authentication (failed|error)|\b401\b`. Fixing it needs a grok auth check that tells these cases apart, which is left for a follow-up on #1792.

### Fixed: AgEnD's single Ctrl+Q never quit grok

Grok's Quit is a double press within 1000 ms. Its keyboard docs say so in 1.0.46, 1.0.50 and 1.0.52.

One press only paints `Ctrl+q:press again to quit` (`50-quit-single`). Two presses exit with status 0 and print `Resume this session with: grok --resume <id>` (`51-quit-double`).

`GrokBackend` now returns `getQuitKeyPresses() = 2`. Before this change, every grok stop and pause waited out the quit grace and then SIGTERMed the CLI.
