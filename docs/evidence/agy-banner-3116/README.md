# M-3116: agy 1.5.9 announcement / empty composer

## Root cause

The supplied real screenshot shows a completed turn, the Hydrogen announcement,
and an empty composer displaying `> Auto mode: edits & safe commands
auto-approved (shift+tab to cycle)`. It has neither a bare `>` line nor the
older shortcut/pie markers. `getReadyPattern` therefore never becomes true;
the monitor remains working although `getBusyPattern` is false. The banner
text itself does not match a busy row.

The fix recognizes only that exact empty-mode placeholder inside a separator
box at the pane end, optionally followed by `Context N% used`. It does not send
Esc or depend on a particular product announcement. Existing active-spinner
checks still veto readiness. Draft suffixes, quoted boxes, unknown footer rows,
model picker and trust screens below the box remain unready.

## Evidence / boundaries

- Fixtures in `tests/fixtures/agy-1.5.9-banner` transcribe the real user screenshots
  supplied on the card. They are explicitly not claimed as raw tmux captures;
  spacing/width and colors are not available from a text transcription.
- Fail-first: `agy-banner-3116` had 2 failures / 8 passes before the fix (working
  instead of idle, and missing ready composer). After the fix it and the
  existing `agy-live-busy-trust-1328` suite passed 37/37.
- No live pane was captured or keyed, no credentials copied, no model prompt
  sent, no installed CLI or user settings changed.

## Model picker: bounded conclusion

The screenshot lists Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Argon),
Gemini 3.8 Flash (current), Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B
(Medium), and a highlighted Gemini 4 Carbon. The screenshot is a partial picker
frame, not evidence of a served model. AgEnD passes the configured model via
`--model` and applies effort through the cached per-model catalogue; it does
not drive this picker to switch models (restart strategy).

The new names are not hard-coded in the model parser: `agy models` supplies
slug/display pairs, with arbitrary valid labels. Determining why this signed-in
session calls Flash current despite its reported Argon launch flag needs that
session's account-dependent catalogue/resume/settings evidence. Leader approved
deferring that separate question while fixing the screenshot-proven readiness
bug. No model-selection behaviour is changed or claimed fixed here.

## Owned offline binary check

The official installer was downloaded as text (never executed), then its
linux_amd64 manifest and 1.5.9 archive were downloaded into the owned worktree.
The archive passed the manifest SHA-512 check. Binary SHA-256 starts
`39816d49d5ab9222`. The host installation was not used or updated.

A `bwrap --unshare-all --clearenv` rig bound only system libraries, the copied
binary and fresh owned home/work/output directories. `/home/han` was absent,
the network namespace had no routes, and no credentials were mounted. One
private tmux was launched inside it with `--model gemini-4-argon-medium`, no
keys or prompt were sent, and it stopped at **Select login method**. Exact
owned session cleanup returned 0; the tmux server had already exited with its
last session (a subsequent kill-server returned 1). The namespace then exited. The raw
logged-out capture is included separately from the screenshot transcriptions.
This does not reproduce an authenticated announcement or prove a served model.

`--version` is 1.5.9; netless `--help` still lists `--model` and `--effort`.
This is a targeted compatibility check, not a full 1.5.9 audit, and the audit
ledger is not advanced. The account-dependent model-current question stays
pending; no real sign-in or model call was made.
