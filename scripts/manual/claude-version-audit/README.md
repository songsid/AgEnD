# Claude Code version audits (2.1.292 → 2.1.294 → 2.1.295 → 2.1.306)

These are the scripts behind the version-gate audits of the claude-code backend, under decisions ffb8104e and af2f9f41:
- **#1427** compared 2.1.292 → 2.1.294. Its fixtures are `tests/fixtures/claude-2.1.294-*.pane.txt`, held by `tests/claude-2.1.294-surfaces.test.ts`.
- **The 2.1.295 audit** compared 2.1.294 → 2.1.295. Its fixtures are `tests/fixtures/claude-2.1.295-*.pane.txt`, held by `tests/claude-2.1.295-surfaces.test.ts`.
- **The 2.1.296 audit** (2026-10-10) compared 2.1.295 → 2.1.296 with `OLD=295 NEW=296` and the same three passes. Its fixtures are `tests/fixtures/claude-2.1.296-*.pane.txt` (the 29 live screens of the 2.1.295 set), held by `tests/claude-2.1.296-surfaces.test.ts`.
  - **Frames:** all 45 screens plus the 24 error frames classify identically under the production predicates. The only differences are spinner verbs, the mock's reply counter and the dangerous-command countdown.
  - **predlits.py:** 233 literals, 68 in the binaries; 7 counts moved, all in embedded changelog prose (`Login expired` / `Not logged in` / `fresh machine` lines). The live error strings are unchanged.
  - **Cold-resume prompt (#1434):** every literal of `claudeColdResumePromptState` (title, rows, description, body, footer parts) has the same count. It still never appears in the rig.
  - **Transcript:** the same record types; queue-operation is still enqueue (with content) then dequeue.
  - **`--continue`:** in both versions it resumes the session file with the newest mtime, whatever its timestamps (checked with a one-hour mtime gap both ways). Frame 113 differed only because `age-session.py` rewrote the two files milliseconds apart.
  - `dialogdiff.py` is dominated by minified-code churn on this pair, so it was not used for the verdict.

Both were run on 2026-10-08. `OLD` and `NEW` pick the pair; they default to 292 and 294, so the commands for the first audit stay unchanged.

## Binary identity

| version | sha256 | source |
|---|---|---|
| 2.1.292 | `a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3` | the copy kept from the 2.1.292 audit |
| 2.1.294 | `27122ca7b624f537546fbef35b80c66370d974ff258f3d9b10ac50bb8771f262` | `~/.local/share/claude/versions/2.1.294` (host auto-update) |
| 2.1.295 | `4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358` | `~/.local/share/claude/versions/2.1.295` (host auto-update) |
| 2.1.296 | `24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de` | `~/.local/share/claude/versions/2.1.296` (host auto-update, found by the daily check 2026-10-10) |

## Isolation

- Every CLI runs on a **private tmux socket** (`tmux -L cc294audit`), never the live server. Diff `tmux list-sessions` before and after a run.
- Each run gets an **isolated HOME** (`HOME`, `CLAUDE_CONFIG_DIR` and the `XDG_*` dirs under `$AUDIT_DIR/h/<name>`), started with `env -i`.
- Claude talks to a **local mock**, `ANTHROPIC_BASE_URL=http://127.0.0.1:18294`, run by `mockapi.py`. `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY` and `DISABLE_ERROR_REPORTING` are all set.
- The API key is fake and built at run time. No account is used.

## Running

```sh
export AUDIT_DIR=<scratch dir holding the binaries 2.1.292 and 2.1.294>
bash pass1.sh    # onboarding, trust, production launch, paste/busy/queue, errors, resume, exit
bash extra.sh    # Bypass warning, dangerous rm, MCP approval, not logged in (needs pass1's homes)
bash extra2.sh   # Bash permission (--permission-mode default), backdated session + --continue
cd ../../.. && npx tsx scripts/manual/claude-version-audit/classify.ts list $AUDIT_DIR/cap/292-* > c292
npx tsx scripts/manual/claude-version-audit/classify.ts list $AUDIT_DIR/cap/294-* > c294
diff <(sed 's/^29[24]-//' c292) <(sed 's/^29[24]-//' c294)    # identical = same classification
python3 -I scripts/manual/claude-version-audit/predlits.py src/backend/claude-code.ts $AUDIT_DIR/2.1.292 $AUDIT_DIR/2.1.294
python3 -I scripts/manual/claude-version-audit/dialogdiff.py $AUDIT_DIR/2.1.292 $AUDIT_DIR/2.1.294
```

The passes run under `set -u`, so `lib.sh` treats every optional input as optional (`${WITHKEY:-}`, `gencmd`'s `${3:-}`). `tests/claude-version-audit-rig.test.ts` runs it with stub `tmux` and `npx` to hold that.

Each `step`/`capb` captures both versions and writes `cap/diff-<label>.txt`, with version strings normalised.

`pass1.sh` is the first pass as it was run, rebuilt from the session log with its paths parameterised. One deviation: step 7 built its `ky` home from a copy of the 2.1.291 audit's home in the same state. The script builds it from `k` instead.

## Binary checks

- **`predlits.py`:** selects predicate-text fragments from `src/backend/claude-code.ts` and counts each one in both binaries. The fragments are string literals of 8–200 characters with prose in them, plus literal runs of at least 7 characters inside its regexes; both pass a length and vocabulary filter.
  - 215 fragments selected; 61 occur in the binaries (the rest are AgEnD's own text).
  - Only 2 counts changed: `" and the "` and `"never ask"`. Both changes are in unrelated settings-documentation prose. No predicate text disappeared.
- **`dialogdiff.py`:** lists literal strings present in only one version, filtered to dialog, permission and error words. Of the 2.1.294-only strings, the ones on AgEnD's path are:
  - `[permissions] bypass consent was accepted but user settings do not show it …, so bypass is not passed on`. Production records the consent in the settings it passes with `--settings`, and the production launch still shows `bypass permissions on` (pass1 step 19).
  - `/cd`'s new trust prompt ("These apply to this session only if you trust it …"). AgEnD never runs `/cd`.
  - MCP status labels ("MCP server needs authentication"). These are status text, not a dialog.

## Coverage

LIVE means the screen was captured on both versions, read identically by the production predicates, and stored as a fixture. BIN means only the binary checks above cover it.

| surface | coverage | notes |
|---|---|---|
| onboarding: theme, login method, OAuth URL, security notes | LIVE | |
| API-key dialog | LIVE | unanswered by design: no table presses Enter, and the default is `No (recommended)` (claude-dialogs-1074's documented gap); AgEnD instances log in, they are not given a key |
| workspace trust | LIVE | |
| Bypass Permissions warning | LIVE | Down on `No, exit`, Enter on `Yes, I accept`, then `bypass permissions on`; not shown in production, where AgEnD's `--settings` carries the consent (step 19) |
| production first launch (writeConfig + buildCommand) | LIVE | |
| ready / busy, with and without the statusLine | LIVE | `esc to interrupt` only without it (#1239) |
| input box: paste, collapsed paste, same-words paste | LIVE | transcript records pastes verbatim |
| native queue (#1169) | LIVE | transcript enqueue/dequeue unchanged |
| 429 / 500 / 401 retry rows, repeated 529 | LIVE | the tests pin the live retry entry (status and attempt) |
| not logged in | LIVE | `auth_error` / pause |
| Bash permission prompt | LIVE | needs `--permission-mode default`; held, never answered; not shown in production (bypass) |
| dangerous-command prompt under bypass | LIVE | `select No` (Down, Enter) |
| MCP approval (project `.mcp.json`) | LIVE | unanswered by design, default `Continue without using this MCP server` (as 2.1.286) |
| `--continue`, with a session / with none | LIVE | |
| Background work exit prompt (#1217) | LIVE | held, blocks the quit |
| resume-summary menu (`Resume from summary` / `full session as-is`) | BIN | not reached: a 4h-backdated session resumed directly on both versions; the menu's literals are unchanged in the binary |
| terminal-setup offer | BIN | did not appear in any onboarding run here (tmux, `TERM=xterm-256color`, no `TERM_PROGRAM`) on either version, so the trigger was not provoked; literal unchanged |
| corrupt `claude.json` modal | BIN | not provoked; literal unchanged |

## Every new version: Claude history in the View

The web View draws a Claude agent's earlier conversation from its transcript in Claude's own Ctrl+O style, with the
colours and glyphs sampled from the live screen (`src/ui/shared/view-history.js`; defaults: 2.1.318's own). On each new
version, re-check the history layout:
- capture a settled screen with a prompt, a reply, an edit (its diff) and a tool result on it
  (`t capture-pane -p -e -t <pane> > cap.ansi`), then run
  `npx tsx scripts/manual/claude-version-audit/view-history-sample.mts cap.ansi`; every value should read `sampled`. A
  `NOT FOUND` means the version draws it differently (a new prompt glyph, a box, another bullet): update the sampler and
  its fixture (`tests/fixtures/view-history-claude-*.ansi`, held by `tests/view-history-claude-ui.test.ts`);
- compare Claude's Ctrl+O view with the View's history for the same turn (the tool words, `⎿` results, the fold), and
  check the transcript still parses into the same steps (`tests/log-steps-1218.test.ts`; `tool_use` / `tool_result`).

## 2.1.294 → 2.1.295

The audit was run as `AUDIT_DIR=… OLD=294 NEW=295 PORT=18295 bash pass1.sh` (then `extra.sh` and `extra2.sh`).

- **LIVE: no change.** Every LIVE surface in the table above was captured on both versions, and all 45 frames classify identically with the production predicates. The input-box readings are identical too. The only differences are spinner verbs, the mock's reply counter, and the moment the effort hint first paints.
- **Predicate fragments:** 3 of 215 changed count.
  - `" and the "` and `"auth token"` are in prose.
  - `"Esc to cancel"` dropped from 12 to 10. Its lost occurrences are the Claude apps gateway connect screen, which AgEnD doesn't handle. The footers AgEnD matches are composed at run time, and every part of them has the same count.
- **New on AgEnD's path (binary only): the "Resume this conversation?" prompt.**
  - It opens on resume, and by an idle timer once the prompt cache has gone cold.
  - It is server-gated: `tengu_amber_tally` and `tengu_drifting_nova`, a subscription tier, and a cost of at least 5% of the 5-hour limit.
  - It never appeared in the rig. It is answered in #1434 (PR #1435) with Escape, its own "resume", and held on any other shape. That PR's fixtures are binary-derived.
- **Upstream changelog:** about 150 entries (hooks, gateway, MCP, plugins, Bash permission checks, paste and vim input). None of the screens AgEnD acts on changed in the frames.

## 2.1.304 → 2.1.306

The binaries were 2.1.304 (sha256 `ea0f135784631619a7a409d07322ecec964f9cc4fd377508ed1ba3f141f27912`) and 2.1.306 (sha256 `520bc6c1f40af466bd03a278b5ae1af1a2938bc7de5b9e5cb15526da20d71cfe`).

The audit was run as `AUDIT_DIR=… OLD=304 NEW=306 PORT=18306 TMUX_TMPDIR=<short dir> bash pass1.sh`, then `extra.sh` through `extra6.sh`, in that order.

**Two notes on running the rig:**
- Keep `TMUX_TMPDIR` short, for example `mktemp -d /tmp/ccNNN.XXXX`. Under the session scratchpad, the socket path goes over the Unix 108-byte limit. tmux then never starts, and every step prints SAME on two empty captures. Check the log for `error connecting` and check that the captures are not empty before trusting a SAME.
- There is no `unshare -rn`. In a user namespace claude runs as uid 0 and refuses `--dangerously-skip-permissions`. It also checks that it can reach `api.anthropic.com` at startup. So the rig runs on the host network like the earlier audits, with every API call going to the local mock.

**LIVE: no change on a screen AgEnD reads.** Of 50 steps, 31 are SAME. The 19 DIFFs are:
- spinner and "Worked for" verbs;
- the mock's reply counter and session ids;
- the auto-deny countdown;
- the ` · ← for agents` and `◐ medium · /effort` footer hints, whose timing varies. 2.1.304 paints them as well, and AgEnD matches neither.

The trust, Bypass Permissions, Bash permission (4 options), dangerous-rm and MCP approval screens are unchanged.

**Keys sent the instant a dialog paints (`extra3.sh`, `extra4.sh`, `extra5.sh`):**
- **Startup trust dialog.** Both versions drop keys written the moment it appears: the Down is lost, and sometimes the Enter is kept, which picks `No, exit`. AgEnD is unaffected because it answers trust and bypass one key at a time from the cursor it reads (`claude-2.1.306-trust-keys-dropped`).
- **Dangerous-command menu.** This changed in 2.1.305, with "an Enter meant for the prompt is less likely to be taken as Accept". With Down and Enter written together at once, 2.1.304 declines. 2.1.306 moves the cursor to `No` and drops the Enter (`claude-2.1.306-danger-enter-swallowed`).
  - At AgEnD's cadence (Down, then 200 ms, then Enter) the command was declined on both versions at every delay tried: 0, 0.3, 0.6, 1, 2 and 4 s after the menu painted (`claude-2.1.306-danger-agend-timing-rejected`).
  - A dropped Enter leaves the cursor on `No`. The next poll's `confirm No` entry sends Enter there, never Down.
- **MCP approval.** An Enter at once takes the default, `Continue without using this MCP server`, on both versions. AgEnD never sends it.

**400 errors (`extra6.sh`, one fresh session each).** Each 400 needs a fresh session: in `pass1.sh` the 400 came after the 529 retries in the same session and never reached the API.
- The context-limit 400 paints `Prompt is too long · the request is ~N tokens (limit M) …` the same way in both versions.
- Another `invalid_request_error` keeps its own text, `API Error: 400 <message>`, in both versions.
- AgEnD has no pattern for either, and the composer stays ready. The 2.1.306 fix ("an API error being replaced by 'prompt is too long'") is not reached through this path, and nothing AgEnD reads depends on it.

**Predicate literals:** 265 checked. Seven counts changed, all of them increases. `launch after` went from 0 to 2, but only in a code comment. None is missing.

**Upstream note.** `Auto mode is now Claude Code's default permission mode` appears on both versions. In auto mode the mock's Bash call ran without a prompt (`95-bash-permission`). The 4-option Bash permission prompt needs `--permission-mode default` (`extra2.sh`, `claude-2.1.306-bash-permission-prompt`).

## 2.1.306 → 2.1.308

The binaries were 2.1.306 (sha256 `520bc6c1f40af466bd03a278b5ae1af1a2938bc7de5b9e5cb15526da20d71cfe`) and 2.1.308 (sha256 `356733f185fa988e6bf3aa9a555269fdd167982a2e2a80d3c8a78037bb92ad58`), from the daily upstream watch (2026-10-22). Live fleet instances already ran 2.1.308.

The audit was run as `AUDIT_DIR=… OLD=306 NEW=308 PORT=18308 TMUX_TMPDIR=<short dir> bash pass1.sh`, then `extra.sh` through `extra6.sh`. Fixtures: `tests/fixtures/claude-2.1.308-*.pane.txt` (the same 33 screens as 2.1.306), held by `tests/claude-2.1.308-surfaces.test.ts`.

**LIVE: no change on a screen AgEnD reads.**
- Of 56 steps, 30 are SAME. The DIFFs are spinner and "Worked for" verbs, the mock's reply counter, session ids, the auto-deny countdown and the footer hints (` · ← for agents`, `◐ medium · /effort`) whose timing varies.
- All 62 captures classify identically under the production predicates, with one exception, `131-bypass-fast`. There the old version's trust step timed out under load and never reached the Bypass warning. Rerun twice, both versions read the same.

**Rig fix (extra5.sh, extra6.sh).** With a dozen claude starts at once, the trust dialog can paint after `trust()` first looks. `trust()` then reports "trusted after 0 steps" too early, and the next paste lands on the dialog, which exits. Both passes now wait for the dialog to paint first, and `extra6.sh` gets the `waitfor` it lacked. Before the fix, every `140-danger-timing` read OTHER, and `150-E400LONG` stopped at the trust dialog. After it:
- the dangerous-command menu is declined at AgEnD's cadence (Down, 200 ms, Enter) at every delay (0, 0.3, 0.6, 1, 2 and 4 s) on 2.1.308;
- 2.1.306 is declined at 5 of 6 delays, with one capture taken mid-turn;
- Down and Enter written together still leave the cursor on `No` with the Enter dropped, on both versions.

**The upstream watch's flags:**
- `usage limit that was lifted before its reset` is embedded changelog prose only: 2.1.305's `CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS` for the opt-in `CLAUDE_CODE_RETRY_WATCHDOG` mode. The variable's code is in both binaries, and AgEnD sets neither.
- `Yes, and don’t ask again for:` and `press Enter to respawn` are in both binaries at the same counts. The first is written `don’t` in the source.

**Predicate literals:** 265 checked, 73 in the binaries, 5 counts changed:
- `Esc to cancel` (10 → 9): the `/permissions` "Recently denied" footer now says `Esc to close` (2.1.307). AgEnD never opens `/permissions`.
- `Bash command` and `` `claude auth login` ``: embedded changelog lines and reordered Remote Control or cloud-session help strings.
- ` and the `: prose.

**Upstream changelog (2.1.307):** the fix for `/clear` conversations returning is for cloud and self-hosted runners, and the retry fix is for HTTP MCP servers. AgEnD's MCP server is stdio. Nothing on AgEnD's path changed.

## 2.1.311 → 2.1.312

The binaries were 2.1.311 (sha256 `86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada`) and 2.1.312 (sha256 `4f4178ce41d83e23341ebfbaecdbcf8ea6bf7baea0690025abe49eeec3a5d01d`), from the daily upstream watch (2026-10-28, MAJOR hard=3). The host had already auto-updated to 2.1.312.

The audit was run as `AUDIT_DIR=… OLD=311 NEW=312 PORT=18312 TMUX_TMPDIR=<short dir> bash pass1.sh`, then `extra.sh` through `extra6.sh`. Fixtures: `tests/fixtures/claude-2.1.312-*.pane.txt` (the same 33 screens as 2.1.308), held by `tests/claude-2.1.312-surfaces.test.ts`. Each was matched to its 2.1.311 capture by content; four were picked by hand (`resumed` ← 50, `trust-keys-dropped` ← 120, `danger-enter-swallowed` ← 132, `ready-statusline` ← 20).

**LIVE: no change on a screen AgEnD reads.**
- 36 steps: 22 SAME. The 14 DIFFs are spinner and "Worked for" verbs, session ids, the working-directory name and footer hints (` · ← for agents`, `◐ medium · /effort`).
- All 62 captures classify identically under the production predicates except `132-danger-fast` (Down and Enter written together the instant the dangerous-command menu paints). That is the timing race 2.1.306 and 2.1.308 already showed: 2.1.311 happened to decline, 2.1.312 kept the menu with the cursor on `No`, which AgEnD confirms with Enter on the next poll. At AgEnD's cadence (Down, 200 ms, Enter) both versions declined at every delay (0, 0.3, 0.6, 1, 2 and 4 s).

**The upstream watch's flags (binary):**
- Usage limit (#816): the started and re-armed rows are unchanged — `Usage limit reached · continuing automatically {when} · esc to cancel`. Only the separate "waiting" row now says `Esc to cancel`; AgEnD reads neither that row nor "Continuing automatically".
- #2822 (#2827): `You've reached your <model> limit.` has the same count (10) in both binaries.
- `rate limit usage (5-hour limit):` is prose in the statusline-setup help; the other new "5-hour limit" strings are the new 5-hour-reset offer's labels. Neither is a screen AgEnD acts on.
- `Automatic continue stopped after repeated usage limit hits · This task will not resume on its own` was already in 2.1.311 (as `usage-limit hits · this task`); only its case changed. AgEnD never read it.
- `Press esc to stop the turn.` is the Remote Control permission screen ("…a permission question that this terminal cannot show"). AgEnD does not use Remote Control.
- `rate limit (HTTP 429, or a git wrapper that exits 75)`, `resume the session` and `resume the agent it was waiting on` are changelog prose or `claude -p` debug logs.
- The cold-resume prompt (`COLD_RESUME_*`): every piece has the same count; the `and is` change is elsewhere.
- Model names now drop `[1m]` where it has no effect (changelog), and `[1m]` is still accepted. AgEnD only displays the statusline model; pricing already strips `[1m]`; nothing compares it with the configured model.
- The model-fallback and 24-hook strings named in the release notes have the same counts in 2.1.311.

**Predicate literals:** 268 checked, 73 in the binaries, 4 counts changed: `Esc to cancel` (9 → 13: the usage "waiting" row and new dialogs; AgEnD's resume footer only counts after the two `Resume …` rows), ` and the `, `as given`, `claude auth login` (prose).

## 2.1.312 → 2.1.314

The binaries were 2.1.312 (sha256 `4f4178ce41d83e23341ebfbaecdbcf8ea6bf7baea0690025abe49eeec3a5d01d`) and 2.1.314 (sha256 `4487042b4c4f5d88d4568f68ae98aae0b1ffae58864cf57fb868641bc5f84594`, byte-identical to the host's `~/.local/share/claude/versions/2.1.314`), from the daily upstream watch (2026-10-30, MAJOR hard=3). The host had already self-updated to 2.1.314; 2.1.313 has no release notes.

The audit was run as `AUDIT_DIR=… OLD=312 NEW=314 PORT=18314 bash pass1.sh`, then `extra.sh` through `extra6.sh`. Fixtures: `tests/fixtures/claude-2.1.314-*.pane.txt` (the same 33 screens as 2.1.312, each from the capture its 2.1.312 fixture is byte-identical to), held by `tests/claude-2.1.314-surfaces.test.ts`.

**LIVE: one change on a screen AgEnD reads — the auto-deny countdown.**
- 56 steps: 34 SAME. The 22 DIFFs are spinner and "Worked for" verbs, the mock's reply counter, session ids, the working-directory name — and `99-dangerous-rm`'s countdown row, reworded:
  - 2.1.312: `⚠ Claude Code will automatically deny this request in 1:54, to avoid blocking progress on an unattended session`
  - 2.1.314: `⚠ Claude Code will automatically block this request in 1:55, to avoid holding up an unattended session`
- `claudeCommandRequestIdentity` (the dangerous-command and Bash-permission dialogs' request identity) dropped that row by the old words only, so on 2.1.314 the identity ticked every second: the after-keys check ("the same request still there") read a new request, and a parked dialog's clock restarted. Fixed by `CLAUDE_AUTO_DENY_COUNTDOWN` (`deny` or `block`, any countdown form).
- All 62 captures and the 24 error frames classify identically under the production predicates except `132-danger-fast` (Down and Enter written together the instant the menu paints): the timing race earlier audits showed; 2.1.314 kept the menu on `No`, which AgEnD confirms with Enter on the next poll.

**The upstream watch's flags (binary):**
- `Claude Code will automatically deny this request in` (MISSING): the reworded countdown above.
- `Continue from where you left off and finish the response. Start a new code fence or table header first…` is a message Claude sends its own model after an output-token-limit cut, not a screen.
- `usage limit resets to show a clock time (` and `usage limit messages to call the 5-hour window the…` are changelog prose. `You've reached your <model> limit.` and the `You've hit your …` forms are unchanged in count and shape.
- `continue this in Projects` is a slash command's model-facing description.

**Predicate literals:** 274 checked, 73 in the binaries, 7 counts changed: ` and the ` (minifier churn in prose), `Esc to cancel`, `claude auth login` (prose), `as given`, `launch after`, `no conversation to` (the `--continue` screen still classifies the same).

## 2.1.314 → 2.1.316

The binaries were 2.1.314 (sha256 `4487042b4c4f5d88d4568f68ae98aae0b1ffae58864cf57fb868641bc5f84594`, the same as the last audit's) and 2.1.316 (sha256 `fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824`, byte-identical to the host's `~/.local/share/claude/versions/2.1.316`), from the daily upstream watch (2026-10-31, MAJOR hard=1). The host had already self-updated to 2.1.316.

The audit was run as `AUDIT_DIR=… OLD=314 NEW=316 PORT=18316 TMUX_TMPDIR=<short dir> bash pass1.sh`, then `extra.sh` through `extra6.sh`. Fixtures: `tests/fixtures/claude-2.1.316-*.pane.txt` (the same 33 screens as 2.1.314, each matched to its 2.1.314 capture by content, `danger-enter-swallowed` from 2.1.316's own capture 132), plus two gateway screens, held by `tests/claude-2.1.316-surfaces.test.ts`.

- **Classification:** all 62 captures and the error frames classify identically under the production predicates, except `132-danger-fast`. That is the timing race earlier audits showed; this time 2.1.316 kept the menu on `No`.
- **The hard finding, `Trust gateway ${}?` beside "Sign in", is not a new screen.** The in-TUI Cloud gateway sign-in is in 2.1.314 already: its URL screen, the `Trust gateway <host>?` step and `Signed in to Cloud gateway as`. New in 2.1.316 is the template form used by `claude auth login`. Under managed settings it runs that sign-in in a terminal (2.1.314 printed "run interactive /login") and ends with `Login successful.`, which `LOGIN_FLOWS.claude-code.successPattern` matches.
- **Gateway screens, captured offline on both versions.** User settings `forceLoginMethod: "gateway"` + `forceLoginGatewayUrl` (loopback, a self-signed TLS mock, then `env.NODE_EXTRA_CA_CERTS`).
  - The URL screen ("Cloud gateway" … "Press Enter to connect · Esc for other login methods") is identical on both.
  - The flow reaches the gateway's OAuth discovery (`GET /.well-known/oauth-authorization-server`); the mock's 404 ends it there, so the trust step was not reached.
  - On both versions the production predicates read the URL screen as nothing at all: not ready, no dialog, not a sign-in. `claudeLoginScreenActive` now recognises it, and the bottom-anchored `Trust gateway <host>?` step (from the source), as a sign-in: an auth incident, never a key.
- **Literals** (`predlits.py`, 359 checked, 86 in the binaries): 7 counts moved, all in bare substrings. Every exact form AgEnD matches has the same count, except `Login successful` (+1: the new gateway path) and `Bash command` (+2: the Bash permission capture is unchanged).
  - The auto-deny countdown keeps 2.1.314's wording ("block … holding up an unattended session").
  - Every cold-resume literal has the same count.
- **The other new string**, "continue the last turn of the session it was copied from…", is the `--help` text of a hidden print-mode flag, `--session-began-as-copy`. It is not a screen.

## 2.1.317 → 2.1.318

The binaries were 2.1.317 (sha256 `eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0`) and 2.1.318 (sha256 `708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd`, byte-identical to the host's `~/.local/share/claude/versions/2.1.318`), from the daily upstream watch (2026-11-04, MAJOR hard=4). The host had already self-updated to 2.1.318.

The audit was run as `AUDIT_DIR=… OLD=317 NEW=318 PORT=18318 bash pass1.sh`, then `extra.sh` through `extra6.sh`. Fixtures: `tests/fixtures/claude-2.1.318-*.pane.txt` (the 33 screens of the 2.1.316 set, each from the same capture, `danger-enter-swallowed` from 2.1.318's own capture 132), plus `code-mode-agent-teams`. They are held by `tests/claude-2.1.318-surfaces.test.ts`. The live tmux server kept its one session throughout.

- **Classification:** all 62 captures and the error frames classify identically under the production predicates, except `132-danger-fast` (the timing race; 2.1.318 kept the menu on `No`, which the runtime table confirms with Enter on its next poll).
  - At AgEnD's own cadence (Down, 200 ms, Enter) the dangerous-command menu was declined on both versions at every delay (0–4 s), despite the changelog's "permission prompts being answered by keys typed just after sending a message, or before a slow prompt appeared" fix.
  - The other diffs are cosmetic: spinner verbs, the mock's reply counter, session ids, and on 2.1.318 a `◐ medium · /effort` row above the composer and `· ← for agents` in the footer.
- **The four hard findings are not screens AgEnD meets.**
  - "Press Enter to try again, or ^C to stop." / "… press Enter to check again, or ^C to stop." are the readline loop of `claude mcp add --web` (server flag `tengu_twinkling_aurora`). It only loops with a TTY on stdin and stdout; otherwise it prints a link and returns. AgEnD never runs it, and an agent's Bash tool has stdin from /dev/null. Offline the flag is off: "--web isn't available yet".
  - "… turn it on again to resume the session. Where …" is not the cold-resume prompt (every cold-resume literal keeps its count). It is the opt-in dialog of the experimental Code Mode: `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` plus server flag `tengu_rustling_blossom`. Its focus is "No, start without it" (`cancelFirst`) and it arms after a delay. AgEnD launches every claude with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, which Code Mode refuses before its flag or provider checks: run with the production env plus the opt-in, the real 2.1.318 printed one passive line, "⚠ Code Mode (experimental) isn't available: it can't be used together with agent teams yet. Starting with the ordinary tools.", and started normally.
  - The `rate_limits` string is network-settings documentation. The gone "Press 2 to try again." was the "You should know" toast (now "try again").
- **Literals** (`predlits.py`, 310 checked, 87 in the binaries): 7 counts moved, all in bare substrings. Every exact dialog form AgEnD matches has the same count, except `Please run /login` (+2: the new "Login reached its time limit · Please run /login", read as an auth error like "Login expired").

## 2.1.318 → 2.1.319: the cold-resume prompt, captured live

The binaries were 2.1.318 (sha256 `708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd`) and 2.1.319 (sha256 `dabafec82ca1319fa43d8be36a10fc61b1d11821cb98ad5df04ad95e199b8eed`, byte-identical to the host's `~/.local/share/claude/versions/2.1.319`), from the daily upstream watch (2026-11-07, MAJOR hard=8). The host had already self-updated to 2.1.319.

- **Passes:** `OLD=318 NEW=319 PORT=18319`, pass1 and extra–extra6. All 62 captures classify identically except `132-danger-fast` (the known instant Down+Enter race; 2.1.319 keeps the menu on `No`). The rest of the diffs are spinner verbs, session ids, the countdown, and `◐ medium · /effort` / `· ← for agents` on the production first launch. Transcript record types are the same set.
- **Literals** (`predlits.py`, 310 checked, 87 in the binaries): 19 counts moved, all bare substrings in changelog, SDK-schema or gateway prose, except the cold-resume ones below. "Enter to confirm" +1 is the embedded changelog ("Fixed /feedback showing …"); "resume the session that started it … from this folder" is a model-facing MCP-task note; "usage limit on" / "one million re-sent tokens" are the SDK's `coldResumeQuota` schema text.
- **The cold-resume prompt, live for the first time.** It is server-gated (subscription tier, `tengu_amber_tally`), so earlier audits built its fixtures from the binary. Public builds ignore `CLAUDE_INTERNAL_FC_OVERRIDES` (`getEnvironmentOverrides()` returns null) and drop a seeded `cachedGrowthBookFeatures`; serving the remote eval (`POST /api/eval/<key>`) through an explicit HTTPS proxy with a scratch CA reaches it. `cold-resume/rig.sh up 319` builds the loopback-only namespace, a claude.ai-shaped home with fake tokens and a backdated 180k-token session; `cold-resume/live.mts` then drives AgEnD's real startup scan (`Daemon.dismissDialogsUntilReady`) against the real binary launched by the production `buildCommand` with `--continue`, case by case (`RIG` short: the tmux socket path must fit 108 bytes).
  - Each option's description is painted BESIDE its label, after two or more spaces, and wraps inside that column — never on a row of its own as the 2.1.295/2.1.304 fixtures assumed. With the server's look-up offered ("Claude can look this one up if you refer to it later"), 2.1.318 and 2.1.319 were held for a person instead of answered.
  - 2.1.319 adds a third option, "Resume from summary" ("Claude writes a summary now, and you continue from it"), behind `tengu_eager_brooks`, on the launch trigger only (`offersSummary`). Escape still means `onCancel` → "dismiss": live at 0, 0.3 and 1.5 s the prompt went, the same session stayed, nothing was compacted.
  - The fix (`coldResumeOptionsExact`) reads label + description per option and answers only the known options with their exact texts; anything else stays hold-only. `live.mts` on unfixed main: 1/7 (only the no-look-up shape); fixed: 7/7. Fixtures `tests/fixtures/claude-2.1.31[89]-cold-resume-live-*.pane.txt`, held by `tests/claude-cold-resume-2.1.319.test.ts`.
  - The idle trigger (`tengu_drifting_nova`) needs a real cache expiry (up to an hour on Max) and was not captured; its component is the same apart from `offersSummary`, which only the launch trigger sets.
- **View history:** `EDITDEMO <file>` (mockapi.py) leaves a prompt, a reply, an edit diff and a tool result on screen; `view-history-sample.mts` read every value `sampled, same`.
- **Changelog:** auto mode, `permissions.denyInsteadOfPrompting` (opt-in) and the Monitor ask rules do not touch AgEnD's `--dangerously-skip-permissions` launch (still "bypass permissions on"). MCP tasks move to the background only for a server that runs a tool call as a task; AgEnD's MCP server declares no task support.

## 2.1.319 → 2.1.322: a dropped Escape on the cold-resume prompt

The binaries were 2.1.319 (sha256 `dabafec82ca1319fa43d8be36a10fc61b1d11821cb98ad5df04ad95e199b8eed`) and 2.1.322 (sha256 `bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478`, byte-identical to the host's `~/.local/share/claude/versions/2.1.322`), from the daily upstream watch (2026-11-10, MAJOR hard=1). The host had already self-updated to 2.1.322.

- **Passes:** `OLD=319 NEW=322 PORT=18322`, pass1 and extra–extra6. All 62 captures and the error frames are read the same by the production predicates, except `132-danger-fast` (the known instant Down+Enter race; 2.1.322 keeps the menu on `No`, which the runtime table confirms). At AgEnD's own key timing the dangerous-command menu was declined at every delay (0–4 s) on both versions.
- **Fixtures:** `tests/fixtures/claude-2.1.322-*.pane.txt`, the 33 screens of the 2.1.318 set, each from the same capture of this pass (`bypass-dangerous-rm-prompt` is the one #3590 already added). They are held by `tests/claude-2.1.322-surfaces.test.ts`.
- **`/model`, live:** `/model haiku` and `/model Fable` switch at once on both versions ("Set model to Fable 5.2"). AgEnD never opens the /model menu, so its new "More models" row does not reach AgEnD.
- **View history:** `EDITDEMO` on both versions; `view-history-sample.mts` read every value `sampled, same`.
- **Literals** (`predlits.py`, 312 checked, 88 in the binaries): 11 counts moved, all in embedded changelog lines or renamed minified identifiers. The hard finding, `Name may not be what it looks like`, is the connector file-send card's look-alike warning, reworded to `Name may use look-alike characters.` A flagged name still has its `* "…"` row, so the card is held as before.
- **The cold-resume prompt drops a key sent too early.** With the server's summary option and the new-conversation focus (`tengu_eager_brooks` + `tengu_stateful_mitten`), the prompt paints before it takes keys. The startup scan's Escape on first sight was then lost: `cold-resume/live.mts` failed 5 of 6 launches on 2.1.322 and 1 of 6 on 2.1.319. Without that focus flag every case passed.
  - The answer was one-shot, so the scan never sent it again. It then read the menu's own `❯` row as ready, and the runtime scanner skipped the claimed prompt too: deliveries stayed blocked, but the agent sat on the prompt until a person pressed Escape.
  - The fix: the answer is `retrySafe` (Escape is the prompt's own "resume" or "dismiss", and both keep the conversation). It is sent again while the same exact prompt is still up, at most 3 sends in all and each at least 1 s after the last. No answered dialog still on screen passes the startup ready check. Fixed, `live.mts` passed 8 of 8 launches of the focus case (four each on 2.1.322 and 2.1.319); the pass test now accepts one to three Escapes and checks that the prompt is gone.
  - Fixtures `tests/fixtures/claude-2.1.322-cold-resume-live-*.pane.txt`, held by `tests/claude-cold-resume-retry-2322.test.ts`.

## 2.1.323 → 2.1.325: no detector change (2026-11-14, M-3113)

The binaries were 2.1.323 (sha256 `604d29a6869409106b6a1110bdadcc8b72e8654a5a865d23258f938a696e348e`) and 2.1.325 (sha256 `0dc4f4a9a165fc60746d7ae8489712e5fc352f1e7ad4eb22e7141bd0812eb0cf`). Both are byte-identical to the host's `~/.local/share/claude/versions` copies; the host had already self-updated to 2.1.325. The daily precheck said MAJOR (hard=1).

- **Passes:** `OLD=323 NEW=325 PORT=18325`, pass1 and extra–extra6. Host tmux sessions were unchanged before and after. All 62 captures and the error frames are read the same by the production predicates, except `132-danger-fast`.
- **`132-danger-fast`** is the known instant Down+Enter race. I repeated it six times per version (`rep-danger.sh`, not committed): both versions keep the cursor on **No** and drop the Enter (12/12). The production "confirm No" entry's follow-up Enter then answers it on both, and the command does not run (4/4).
- **The precheck's hard hit is changelog prose.** "a wait chosen in the usage limit menu silently moving to a later reset…" is a 2.1.325 changelog line. The other new strings are changelog lines or internal schema descriptions.
- **The "gone" strings:**
  - "Yes, and manually approve edits" and "resume the wrong conversation" were 2.1.323 changelog lines.
  - "Resume this session with" is still printed on exit. It is now part of a template string the precheck's prompt extraction does not split out. AgEnD does not read it.
- **`Enter to confirm` 3 → 1:**
  - In both versions the live footers are composed from parts, so the literal appears only in a bun helper string and in changelog prose.
  - The composed footers on AgEnD's path still read the same: the resume picker, the confirm dialogs and the cold-resume prompt (below).
- **Literals** (`predlits.py`, 325 checked, 90 in the binaries): 14 counts moved, all in embedded changelog lines or generic words. That includes "Background work is running" 3 → 2 and "launch after" 3 → 2, whose live dialog strings are unchanged.
- **Visible but not on a detector:**
  - The bypass footer gains "· ← for agents".
  - The `/effort` line shows on more frames; it is matched by shape in `CLAUDE_LIVE_TAIL`.
  - The OAuth URL asks one more scope (`user:privacy_consents:write`).
- **Cold-resume prompt, live** (`cold-resume/live.mts`, 325 cases added): `325-lookup`, `325-summary-lookup` and `325-summary-newfocus` PASS 3/3. The prompt was seen, Escape was sent, history was kept and the prompt was gone.
- **Fixtures:** `tests/fixtures/claude-2.1.325-*.pane.txt`, held by `tests/claude-2.1.325-surfaces.test.ts` (27 tests). They are the 33 screens of the 2.1.322 set, each from the same capture of this pass, plus the two live cold-resume frames.
  - The file-send card fixtures are not re-made. That card cannot be reached offline (see `scripts/manual/claude-2317-file-send/README.md`), and its literals are unchanged.

## 2.1.325 → 2.1.326: the resume menu and the retry row (2026-11-17)

The binaries were 2.1.325 (sha256 `0dc4f4a9a165fc60746d7ae8489712e5fc352f1e7ad4eb22e7141bd0812eb0cf`) and 2.1.326 (sha256 `b6b3647d981130dc44fc670846ae97b6cde531ffb667cf9c4d17cfcafb38cb37`, byte-identical to the host's `~/.local/share/claude/versions/2.1.326`). The host had already self-updated to 2.1.326. The daily precheck said MAJOR (hard=18). This first PR covers the two changes that broke AgEnD on the live fleet; the sign-in screens and the full fixture set follow in a second one.

- **Passes:** `OLD=325 NEW=326 PORT=18326`, pass1 and extra–extra6. The host's tmux server kept its one session throughout.
- **The resume-from-summary menu's third row is now "Don't ask again"** (was "Don't ask me again"). `claudeResumeMenuState` then saw an unknown row under the menu, so the menu read as no menu at all: not answered, not held, and the startup scan reported ready with it still up.
  - The menu is server-gated (`tengu_gleaming_fair`, a session at least 70 minutes old with at least 100k tokens), so pass1–extra6 never show it.
  - `cold-resume/resume-menu.mts` (new) runs AgEnD's real startup scan against it. It uses the cold-resume rig (`rig.sh up 326`), the production launch with `--continue`, a backdated 180k-token session and the flag served by the rig's proxy.
  - Before the fix: `325-menu` PASS; `326-menu` FAIL (ready, no key, the menu still up).
  - After the fix: `325-menu`, `326-menu` and `326-menu-80` PASS. Each time the menu was seen, Down and Enter were sent, the full session was kept and nothing was compacted.
  - **Fail-safe:** any other numbered third row is now still read as the menu, held for a person (no key, delivery blocked) and never answered.
- **The API-retry row is lower-case:** `✻ 429 … · retrying in 4s · attempt 5/10` (was "Retrying in"). It reads `· retrying… · attempt n/m` when the renderer's wait is zero (`b===0`).
  - The busy pattern was case-sensitive, so a retrying turn could look idle. The 429/5xx/401/403 notices use `/i` and still matched the "in Ns" form.
  - The no-wait form never showed in 350 frames sampled every 0.2 s (`retry-fast.sh`, not committed): the row moves on within the tick. Its fixture is the real 429 frame with only the wait replaced.
- **Fixtures:** `tests/fixtures/claude-2.1.326-*.pane.txt`: the menu at 160 and 80 columns, the screen after Down and Enter, the 429/401/500 and generic-attempt retry rows (production launch), and the no-wait row. They are held by `tests/claude-2.1.326-surfaces.test.ts`. Paths in the frames are normalised to `/tmp/agend-audit/…`.

## 2.1.325 → 2.1.326, part 2: sign-in screens, the queue marker and the full set (2026-11-17)

Part 1 (the resume menu and the retry row) is its own section. Same binaries and the same passes.

- **Classification:** all 62 captures, the gateway pair and the error frames now read alike under the production predicates, except the two known timing races:
  - `123-mcp-enter-fast`: 2.1.326 took the instant Enter on the trust dialog as `No, exit`, while 2.1.325 dropped it. AgEnD never sends a bare Enter there; its trust entries move and check the cursor first, and production pre-trusts the folder.
  - `132-danger-fast`: the instant Down+Enter race; this time 2.1.326 kept the menu on No.

  Before the fixes below, `03-oauth-url` also differed: 2.1.326's sign-in screen read as nothing.
- **The OAuth sign-in screen was redrawn.** "Browser didn't open? Use the URL below to sign in" (was "url"). The paste prompt is a label, `Paste code here if prompted`, over a boxed input, with `Esc to go back` as the last row. It was `Paste code here if prompted >`, which `claudeLoginScreenActive` anchored on.
  - Now both shapes are recognised: the footer, then only the box and blank rows up to the label, and the URL above it.
  - The plain-terminal `claude auth login` still prints `Paste code here if prompted > `, so the dashboard and Runtime sign-ins are unaffected.
- **Cloud gateway** (user settings `forceLoginMethod: "gateway"` + a loopback `forceLoginGatewayUrl`, then `/login`; `gw.sh`, not committed):
  - The URL screen's footer is composed from key hints: `Enter to connect · Esc to go back` (was `Press Enter to connect · Esc for other login methods`).
  - The login-method menu that Esc returns to now ends with `Esc to cancel` under its options.
  - Both are recognised now, along with the older footers.
- **The native queue's marker** is a `⎿` row: `  ⎿  Queued · ctrl+x ctrl+s to send now` (was `  ctrl+x ctrl+s to send now`). The queue walk skipped it as a tip row, so `InputBox.queued` was lost.
  - Delivery still proved itself by its unique id or its text on screen.
  - The marker is now checked before the tip skip.
- **`esc to interrupt` under the statusline:** 2.1.326 shows it in a running turn's footer even with AgEnD's statusline. The busy test is the spinner's slot, not the footer (#1239), so nothing changes.
- **Cold-resume prompt, live** (`cold-resume/live.mts`, 326 cases added): `326-lookup`, `326-summary-lookup` and `326-summary-newfocus` all PASS. Each time the prompt was seen, Escape was sent, the history was kept and the prompt was gone.
- **Fixtures:** `tests/fixtures/claude-2.1.326-*.pane.txt`, held by `tests/claude-2.1.326-screens.test.ts` (32 tests).
  - The 33 screens of the 2.1.325 set, each from the same capture of this pass (`bypass-dialog-cursor-accept` from capture 92), the two live cold-resume frames, and the gateway URL screen and login-method menu.
  - The queued-transcript fixture is not re-made: the transcript record types are unchanged.
  - Paths are normalised to `/tmp/agend-audit/…`.
- **Mutation checks:** reverting the OAuth shape, the gateway footer, the login-menu footer or the queue marker each turns the screens test red.

## 2.1.326 → 2.1.327: no detector change (2026-11-18, M-3336)

The binaries were 2.1.326 (sha256 `b6b3647d981130dc44fc670846ae97b6cde531ffb667cf9c4d17cfcafb38cb37`) and 2.1.327 (sha256 `343c744baa14bfd38286a7cb90871051f04379956da6c5b803a9e66019a76ac9`, byte-identical to the host's `~/.local/share/claude/versions/2.1.327`). The host had already self-updated to 2.1.327. The daily precheck said MAJOR (hard=9, hinted=0).

- **Passes:** `OLD=326 NEW=327 PORT=18327`, pass1 and extra–extra7. The host's tmux server was never used (private sockets only).
- **Classification:** all 72 captures (62 from pass1–extra6, 8 from extra7, the gateway pair) and the 30 error frames read alike under the production predicates, except `132-danger-fast`. That is the known timing race, and `danger-probe.sh` (new) shows it is the same on both versions:
  - Down+Enter in one burst the instant the menu paints: the cursor moves to No and the Enter is dropped, 4/4 on 2.1.326 and 4/4 on 2.1.327 (this run's pass happened to catch 2.1.326 taking it).
  - AgEnD's cadence (Down, 200 ms, Enter): declined, 4/4 on each. After a 0.5 s or 1 s wait: 8/8 on each.
  - A menu left on No is confirmed by AgEnD's next poll with Enter (`confirm No`), never Down again.
- **The precheck's new prompt strings are not AgEnD screens:**
  - `No, keep connecting` is the IDE auto-connect toggle (`/config`, `--ide`).
  - `No, keep the limit` and `Press Enter to confirm again.` are the spend-limit menu (`/rate-limit-options`).
  - `No, keep plan` and `No, keep running` are "Stop ultraplan?".
  - `Retrying in 0s` and `Yes, and switch to default (ask each time) for this session` occur only in the embedded changelog prose.
  - `Usage limit reset. Re-running` left the binary only because the workflow pause notice became a template (`` `${…?"Continuing on this login":"Usage limit reset"}. Re-running ${n} waiting …` ``). The `Usage limit reset · Continuing automatically` note that `Daemon.USAGE_LIMIT_RESET` reads is unchanged.
- **The resume footer count (`Enter to confirm`, 1 → 3)** is the spend-limit menu's two new strings, not the resume menu. The menu is unchanged and live-tested below.
- **Arrow keys "stop at No instead of wrapping"** (2.1.327 changelog). `extra7.sh` (new) presses past both ends of the Bash permission prompt and the "Switch model?" confirmation. Both versions behave alike: on the permission prompt, Up from `1. Yes` lands on `4. No` and Down past No stays on it. On the switch confirmation, two Downs and then two Ups each leave the cursor on `1. Yes` on both versions. AgEnD's own `/model` answer presses Up only from a verified `2.` and re-reads the screen after each key (`Daemon.answerOwnSwitchDialog`).
  - AgEnD never relies on a wrap. Its automatic keys are Down from a verified cursor (trust, Bypass, the dangerous-command menu, the resume menu), and a remote card walks one verified step at a time, never past a list's ends (`remote-card-answer.ts`). No AgEnD path types a number into a prompt.
- **"Switch model?" (#1690)** shows `Enter to confirm · Esc to cancel` under its options on both versions. `claudeSwitchDialog` allows up to three rows under the pair, so it reads the screen as before (kind, target, cursor), and the runtime table holds it.
- **Indentation:** 2.1.327 draws dialog bodies two columns in (2.1.326: three). Every predicate already allows any leading whitespace.
- **Cold-resume prompt, live** (`cold-resume/live.mts`, 327 cases added): `327-lookup`, `327-summary-lookup`, `327-summary-newfocus` and `327-summary-newfocus-80` all PASS, as do `326-lookup` and `326-summary-newfocus` on the same rig (`rig.sh up 327`). Each time the prompt was seen, Escape was sent, the history was kept and the prompt was gone. `327-summary-newfocus` needed the retrySafe second Escape (#3589).
- **Resume-from-summary menu, live** (`cold-resume/resume-menu.mts`, 327 cases added): `326-menu`, `327-menu` and `327-menu-80` PASS. Each time the menu was seen, Down and Enter were sent, the full session was kept and nothing was compacted.
- **Fixtures:** `tests/fixtures/claude-2.1.327-*.pane.txt`, held by `tests/claude-2.1.327-screens.test.ts` (40 tests):
  - the screens of the 2.1.326 set, each from the same capture of this pass (`bypass-dialog-cursor-accept` from capture 92);
  - the live cold-resume and resume-menu frames;
  - the retry rows (the generic first-attempt row from 0.2 s frames, `retry-fast.sh`, not committed; the no-wait row is the real 429 frame with only the wait replaced, as for 2.1.326);
  - the gateway pair (`gw.sh`, not committed);
  - new: `switch-model-opus` and `bash-permission-down-past-end`.
  - Paths are normalised to `/tmp/agend-audit/…`, including the project key in "Earlier messages are saved in …".
- **Shipped ledger:** the dev branch's `src/cli-audited.ts` (with its Windows Runtime pin) moves to 2.1.327 in the dev PR (#4183); main has no shipped ledger.

## 2.1.328 → 2.1.329: no detector change (2026-11-20, M-3477)

The binaries were 2.1.328 (sha256 `a982d38030b97e750848add2cbb2df6d9a70d5544a22ca9b216a349ba25865e8`) and 2.1.329 (sha256 `30e2724e2aecb1bf5dc9f3130901afb71c5fa229051c190a6d7ad9aff6378d6d`), both byte-identical to the host's `~/.local/share/claude/versions/`. The host had already self-updated to 2.1.329. The daily precheck said MAJOR (hard=10, hinted=0).

- **Passes:** `OLD=328 NEW=329 PORT=18329`, pass1, extra–extra7, `danger-probe.sh` and `trust-hooks.sh` (new). The host's tmux server was never used (private sockets only).
  - Keep `AUDIT_DIR` out of any folder whose `package.json` says `"type": "module"`: the generated `statusline.js` is CommonJS, and under such a folder it fails, so every capture loses its statusline row. A `{"type":"commonjs"}` `package.json` in `AUDIT_DIR` avoids it.
- **Classification:** all 72 captures read alike under the production predicates on both versions, except `132-danger-fast`, the known timing race. `danger-probe.sh` shows it is the same on both: Down+Enter in one burst leaves the cursor on No, 4/4 on each; AgEnD's cadence (Down, 200 ms, Enter) declines, 4/4 on each; 8/8 after a 0.5 s or 1 s wait.
- **The precheck's new prompt strings are not AgEnD screens:**
  - `Press Enter to open the sign-in page in your browser, or Ctrl+C to cancel.` is a new step of the organization gateway's identity-provider sign-in (`[gateway-idp]`, `hybrid_gateway_idp_sign_in`), shown only under enterprise managed hybrid settings. A person finishes that sign-in. No startup or runtime table answers it (`Press Enter to continue` is gated by `claudeSecurityNotesActive`).
  - `continue the conversation here. Start a new conversation.`, `resume this conversation, …`, `resume the session that created …` and `resume the session from a URL …` are multi-organization refusals (a session that ran under another organization, or a URL resume under an organization sign-in). They are messages, not prompts.
  - `continue this conversation here. To send/teleport a new conversation, …` is `/send-to-project`'s refusal text.
  - `retrying in ~60s` is an auth debug-log line (proactive token refresh).
- **Literal counts (`predlits.py`):** 333 checked, 90 in the binaries, 15 counts changed. `Start a new conversation` (2 → 6) and `Cloud gateway` (97 → 101) are the strings above. `claude auth login`, `auth token` and `Not logged in` are new sign-in and gateway help. `to navigate` (18 → 19) is a question dialog's `Tab/Arrow keys to navigate`. `fresh machine` (0 → 1) is embedded changelog prose. No predicate text disappeared.
- **Trust dialog (2.1.329 changelog: it names where a folder's hooks are declared):** `trust-hooks.sh` (new) opens a folder whose `.claude/settings.json` declares a SessionStart hook. 2.1.329 adds one line, `⚠ This folder configures hooks that can run commands without asking, declared in .claude/settings.json`. At 160 and 80 columns it is read and answered exactly as the plain trust dialog (cursor on `No, exit`: Down). The hook never ran (the folder was never trusted).
- **Cold-resume prompt, live** (`cold-resume/live.mts`, 328 and 329 cases added): `328-lookup`, `329-lookup`, `329-summary-lookup`, `328-summary-newfocus`, `329-summary-newfocus` and `329-summary-newfocus-80` all PASS. Each time the prompt was seen, Escape was sent, the history was kept and the prompt was gone.
- **Resume-from-summary menu:** not reached on 2.1.328 or 2.1.329. From 2.1.328 its gate is `tengu_gleaming_fair_reuse` alone, and it opens only when a precomputed summary exists (otherwise `skipped_no_summary`). The rig has none, so the backdated session resumed straight away with the history kept and nothing compacted (`resume-menu.mts`, 328 and 329 cases). `327-menu` on the same rig still PASSes. The menu's literals are unchanged, and 2.1.327's fixtures keep pinning its screen.
- **Cloud gateway URL step:** the rig did not reach it on either version (a `gatewayUrl` in the user settings no longer opens it from `/login`). Its predicate literals are unchanged, and 2.1.327's fixtures keep pinning it.
- **Fixtures:** `tests/fixtures/claude-2.1.329-*.pane.txt`, held by `tests/claude-2.1.329-screens.test.ts` (36 tests):
  - the screens of the 2.1.327 set, each from the same capture of this pass, except the gateway pair, the resume-summary menu and the generic first-attempt retry row (above);
  - `mcp-approval` from the first run of this audit, because the clean rerun's fixed 4 s wait missed the dialog on both versions;
  - new: `trust-hooks` and `trust-hooks-80`.
  - Paths are normalised to `/tmp/agend-audit/…`.
- **Mutation check:** a trust accept row that no longer matches turns the trust tests red, including the new hooks one.
- **Shipped ledger:** the dev branch's `src/cli-audited.ts` (with its Windows Runtime pin) moves in the dev twin; main has no shipped ledger.

## 2.1.329 → 2.1.330: the file-send lead row and the usage-limit note (2026-11-21, M-3501)

The binaries were 2.1.329 (sha256 `30e2724e2aecb1bf5dc9f3130901afb71c5fa229051c190a6d7ad9aff6378d6d`) and 2.1.330 (sha256 `f390eaa0814e6a1bff74cbb47acb74cb9c89d30ced809fe0af5af00c7bfe8ebb`), both byte-identical to the host's `~/.local/share/claude/versions/`. The host had already self-updated to 2.1.330. The daily precheck said MAJOR (hard=3).

- **Passes:** `OLD=329 NEW=330 PORT=18330`, pass1, extra–extra7, `danger-probe.sh` and `trust-hooks.sh`, in an `AUDIT_DIR` with a `{"type":"commonjs"}` `package.json`. The host's tmux server was never used.
- **Classification:** all 72 captures read alike under the production predicates on both versions, except `132-danger-fast`, the known race. `danger-probe.sh` gives the same outcome on both: 4/4 cursor on No for a burst, 4/4 declined at AgEnD's cadence, 8/8 after a wait.
- **Detector change 1, the file-send card.** 2.1.330 rewrote the card's description. The lead row "This call sends <N> file(s) from this computer" / "to <connector>, which decides where to store …" is now "Allowing this sends a copy of 1 file" (or "a copy of <name>", or "copies of <N> files"), with an optional "(… outside this session's folders)", then "through Anthropic" / "to <connector>, a third-party app. Its terms and privacy policy apply.". That lead row is the only mark an ordinary file name gives the card (2.1.322's Gap A). Without it, a plain card was read as the dangerous-command prompt and answered No. `FILE_SEND_MARK` now also accepts a row that starts "Allowing this sends a copy of" or "Allowing this sends copies of <N> files". The 2.1.319–2.1.329 wording is still read. The live card needs a claude.ai connector, so the 2.1.330 fixtures are the 2.1.322 plain cards with the two lead rows rewritten from the 2.1.330 bundle (`tests/claude-file-send-card-2330.test.ts`).
- **Detector change 2, the usage-limit note.** The transcript's informational note is now "Usage limit reached · set to continue automatically {when}" (and "Usage limit reached again · …"), with no " · esc to cancel" tail. To 2.1.329 it was "· continuing automatically {when} · esc to cancel". `CLAUDE_USAGE_LIMIT_PAUSE` reads both, with `{when}` still group 1, so the daemon's pause notice and `quotaPaused()` work again (`tests/claude-transcript-limits-2834.test.ts`). "Usage limit reset" (the end of a pause) is unchanged.
- **The precheck's other hits are not AgEnD screens:**
  - `Press Enter to try again, or ^C to stop. If that fails too, run …` and `press Enter to try now, or ^C to stop …` are the claude.ai connector check of `claude mcp`.
  - `could not continue the previous session (…). Run claude --resume …` is the `--continue` exit message; only its neighbour changed.
  - `resume the session that started it (…)` is tool-result text about a background MCP task.
  - `… Run AGAIN …` is the watch skill's.
- **OAuth screen:** 2.1.330 prints a short `https://claude.ai/oauth/authorize?<token>` and a "Hold Shift while selecting…" hint between the URL and the paste label. `claudeLoginScreenActive` still reads it as the sign-in (it looks for `oauth/authorize` within 13 rows of the paste label), and no AgEnD code parses the old URL's shape.
- **Cold-resume prompt, live:** `329-lookup`, `330-lookup`, `330-summary-lookup`, `329-summary-newfocus`, `330-summary-newfocus` and `330-summary-newfocus-80` all PASS.
- **MCP approval:** not re-captured. The pre-onboarded home now runs in auto mode, where neither version shows it. 2.1.329's fixture pins it.
- **Fixtures:** `tests/fixtures/claude-2.1.330-*.pane.txt`, held by `tests/claude-2.1.330-screens.test.ts`, plus the two file-send cards above. The 2.1.330 busy-queued capture is registered in `tests/claude-queued-input-1169.test.ts`.
- **Precheck manifest:** rebuilt, so the watch now also reads "Allowing this sends" and "set to continue".
- **Shipped ledger:** the dev twin moves `src/cli-audited.ts` and the Windows Runtime pin to 2.1.330. Main has no shipped ledger.

## 2.1.330 → 2.1.331: the cold-resume prompt loses its summary row (2026-11-24, M-3652)

The binaries were 2.1.330 (sha256 `f390eaa0814e6a1bff74cbb47acb74cb9c89d30ced809fe0af5af00c7bfe8ebb`) and 2.1.331 (sha256 `4c00839cf46beb2b38ec310105f2d538f7f9321fe46c636299b74bcab94626b1`), both byte-identical to the host's `~/.local/share/claude/versions/`. The host had already self-updated to 2.1.331. The daily precheck said MAJOR (hard=1): the cold-resume summary description, 2 → 0.

- **Passes:** `OLD=330 NEW=331 PORT=18331`, pass1, extra–extra7, `danger-probe.sh` and `trust-hooks.sh`. The host's tmux server was never used.
- **Classification:** all 70 captures read alike under the production predicates on both versions, except `122-danger-fast` and `132-danger-fast`, the instant-key races (a trust dialog that took the keys on 2.1.330's 122; the dangerous-command menu left on No on 2.1.331's 132). `danger-probe.sh` gives the same outcome on both: 4/4 cursor on No for a burst (confirmed by the next Enter), 4/4 declined at AgEnD's cadence, 8/8 after a 0.5 s or 1 s wait.
- **The hard finding is a removed option, not a rewording.** The cold-resume component no longer takes `offersSummary`: the "Resume from summary" row and its description ("Claude writes a summary now, and you continue from it") are gone, with its compact refusal. Title, body, footer, the Resume and "Start a new conversation" rows and Escape (resume; dismiss on the idle trigger) are byte-identical. `coldResumeOptionsExact` already accepts the two-option prompt, so no detector change: live, `331-lookup` and `331-nolookup` PASS (Escape, one session, nothing compacted, history kept). `330-summary-lookup` and `330-summary-newfocus` still PASS, so the three-option grammar stays for hosts on 2.1.319–2.1.330. `sources.json` marks `COLD_RESUME_SUMMARY_DESCRIPTION` retired after 2.1.330, so the precheck lists it as expected-missing.
- **The behaviour change behind a server flag.** Under `tengu_eager_brooks` (the flag that used to add the summary row), 2.1.331 compacts a cold `--continue` by itself before any prompt shows: `if (flag) { action: "compact"; resumeFromSummary() }`, gated on an expired cache, `autoCompactEnabled` and `idleCompaction`. AgEnD has nothing to answer and the agent comes back on a summary (`331-summary-lookup`, `-newfocus`, `-newfocus-80`: no prompt, `Conversation compacted`, keys []). With the user setting `idleCompaction: false` the prompt comes back and AgEnD's Escape keeps the context (`331-summary-noidle`: PASS).
  - On 2026-11-24 no Claude profile on the host had the flag cached, and `tengu_amber_tally` was `{}`, so neither the prompt nor the auto-compact could fire.
  - Decision (leader, M-3652): no settings change now. `claude-flag-watch.py` (next to `precheck.py`) runs in the daily watch and prints one WARN line per profile where the flag turns up; then AgEnD passes `idleCompaction: false` to Claude instances (decision B). The script is read-only and prints only the profile, the flag's name and whether it is on.
- **The precheck's other hits are not AgEnD screens:**
  - The `--resume` summary menu ("Resume from summary (instant, recommended)" / "Resume full session as-is" / "Don't ask again") is unchanged; the count 4 → 2 is the removed cold-resume row.
  - `could not continue the previous session (…). Run claude --resume …` is byte-identical; only its neighbour changed.
  - "Allow Claude in Chrome to …" was already in 2.1.330. "continue from your phone" is a new busy-only notification ("still working · /remote-control to continue from your phone", shown only while a turn runs); the busy test reads the spinner, never the footer. "resume this agent rather than launch it again" and the gone "Resume this session (above), then run" are model-facing text.
- **MCP approval and file-send cards:** not re-captured (as 2.1.330). The file-send card's 2.1.330 wording is unchanged in the 2.1.331 bundle.
- **Fixtures:** `tests/fixtures/claude-2.1.331-*.pane.txt` (the 2.1.330 set, each from its 2.1.331 capture, plus the live cold-resume lookup, nolookup, after-Escape and flag auto-compact frames), held by `tests/claude-2.1.331-screens.test.ts`. The busy-queued capture is registered in `tests/claude-queued-input-1169.test.ts`. Paths are rewritten to `/tmp/agend-audit`.
- **Shipped ledger (dev):** `src/cli-audited.ts` adds 2.1.331, and the Windows Runtime pin moves to 2.1.331: the same two packages, no dependencies, `claude.exe` at the same path, each integrity the registry's and checked against its downloaded tarball. Main has no shipped ledger.

## 2.1.331 → 2.1.332: no detector change (2026-11-25, M-3753)

The binaries were 2.1.331 (sha256 `4c00839cf46beb2b38ec310105f2d538f7f9321fe46c636299b74bcab94626b1`) and 2.1.332 (sha256 `a2df1f41bb00250992926420d0063f89b127cb81abdd284dbefb80c50ff1d026`), both byte-identical to the host's `~/.local/share/claude/versions/`. The host had already self-updated to 2.1.332. The daily precheck said MAJOR (hard=3, hinted=2): no detector literal missing, 10 counts changed, and new prompt-like strings beside known literals.

- **Passes:** `OLD=331 NEW=332 PORT=18332`, pass1, extra–extra7, `trust-hooks.sh` and `danger-probe.sh`. The host's tmux server was never used.
- **Classification:** all 70 captures read alike under the production predicates on both versions, except `132-danger-fast`, the instant-key race. `danger-probe.sh` gives the same outcome on both: 4/4 cursor on No for a burst, 4/4 declined at AgEnD's cadence, 8/8 after a 0.5 s or 1 s wait. `predlits.py`: 92 of 355 predicate literals are in the binaries, none missing, 7 counts moved, all in prose.
- **The one visible change on a captured screen:** the project MCP approval's footer reads `Enter to confirm · Esc to reject` (it was `… · Esc to cancel`). No AgEnD entry answers or holds that dialog (unanswered by design, default `Continue without using this MCP server`), and `CLAUDE_CONFIRM_FOOTER` is only used for the trust and Bypass dialogs, which still say `Esc to cancel`. The test pins the new footer.
- **Cold-resume prompt:** unchanged. Live, `332-lookup`, `332-nolookup` and `332-summary-noidle` PASS (Escape, one session, nothing compacted, history kept). `332-summary-lookup` auto-compacts under `tengu_eager_brooks` with no prompt, as 2.1.331 did (the flag watch covers it).
- **The precheck's hits are not AgEnD screens:**
  - "Press Enter to check again / try now, or ^C to stop" (and "Press Enter to try again …"): the claude.ai connector wait, only capitalised (`press` → `Press`). AgEnD never adds connectors and matches none of it.
  - `Claude Code exited: could not continue the previous session (…). Run claude --resume to pick a session, or start a new one.`: the exit line of a failed `--continue`, reworded around the same parts. No AgEnD pattern matches this text (`git grep` finds none).
  - "I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.": a list of texts Claude treats as automatic continuations (beside "My computer went to sleep …"), not a message the terminal sends. AgEnD reads usage-limit pauses from the transcript's records (#2834), never this text.
  - "Press Esc to stop Claude while it's working. Turn computer use on or off …" and "… or type help and press Enter to go on without it.": computer use and the self-hosted runner wizard, not on AgEnD's path.
- **Changelog items checked against AgEnD:**
  - "Always deliver" on the prompt for held messages from other sessions, and the footer line while a flagged message has the session on another model: Claude's own messaging between its sessions, which AgEnD does not use (AgEnD delivers by typing into the pane). If that prompt ever showed, it is a selection card AgEnD holds for a person.
  - The `PreSkillShellCommand` startup dialog: only on 2.1.331 and older, and only when a settings file names that hook event. AgEnD's `writeConfig` does not.
  - MCP skills as `server:skill` in the `/` menu: AgEnD's MCP server offers no skills, and the slash commands AgEnD types (`/compact`, `/model`, …) are unchanged.
- **Fixtures:** `tests/fixtures/claude-2.1.332-*.pane.txt` (the 2.1.331 set, each from its 2.1.332 capture, the live cold-resume frames, and the MCP approval), held by `tests/claude-2.1.332-screens.test.ts`. The busy-queued capture is registered in `tests/claude-queued-input-1169.test.ts`. Paths are rewritten to `/tmp/agend-audit` and `/tmp/cr332`.
- **Shipped ledger (dev):** `src/cli-audited.ts` adds 2.1.332, and the Windows Runtime pin moves to 2.1.332: the same two packages, no dependencies, `claude.exe` at the same path, each integrity the registry's and checked against its downloaded tarball. Main has no shipped ledger.
