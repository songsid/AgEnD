# Claude Code version audits (2.1.292 → 2.1.294 → 2.1.295)

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

## 2.1.294 → 2.1.295

The audit was run as `AUDIT_DIR=… OLD=294 NEW=295 PORT=18295 bash pass1.sh` (then `extra.sh` and `extra2.sh`).

- **LIVE: no change.** Every surface in the table above was captured on both versions, and all 45 frames classify identically with the production predicates. The input-box readings are identical too. The only differences are spinner verbs, the mock's reply counter, and the moment the effort hint first paints.
- **Predicate fragments:** 3 of 215 changed count.
  - `" and the "` and `"auth token"` are in prose.
  - `"Esc to cancel"` dropped from 12 to 10. Its lost occurrences are the Claude apps gateway connect screen, which AgEnD doesn't handle. The footers AgEnD matches are composed at run time, and every part of them has the same count.
- **New on AgEnD's path (binary only): the "Resume this conversation?" prompt.**
  - It opens on resume, and by an idle timer once the prompt cache has gone cold.
  - It is server-gated: `tengu_amber_tally` and `tengu_drifting_nova`, a subscription tier, and a cost of at least 5% of the 5-hour limit.
  - It never appeared in the rig. It is answered in #1434 (PR #1435) with Escape, its own "resume", and held on any other shape. That PR's fixtures are binary-derived.
- **Upstream changelog:** about 150 entries (hooks, gateway, MCP, plugins, Bash permission checks, paste and vim input). None of the screens AgEnD acts on changed in the frames.
