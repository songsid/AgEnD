# Grok 1.0.88: static and isolated terminal audit

M-3291 follows the version-audit and isolation rules. The design was written
first in `docs/design/grok-1.0.88-audit.md`. Fixtures and replay scripts are
in `tests/fixtures/grok-1.0.88-audit/`.

The supplied precheck compared 1.0.77 with 1.0.88:

```text
BASIS: hard=1; hinted=4
PRECHECK: MAJOR
```

No detector literal disappeared. Five literal counts changed and 26 new
prompt-like strings appeared away from known literals. Those mechanical
results are preserved; live evidence determines their relevance.

## Product repairs

The exact weekly-limit scrollback matcher missed the new `Tab:question`
footer, and Space no longer returned to the picker. Both versions accept
literal tab, followed by X. The ordered options, current-footer checks,
paid-action exclusions and reset/retry gates are unchanged.

The actual no-key screen has `Sign in with Grok / Quit` plus a composer
shape and a build footer. It must be held despite the broad ready hint.
The new hold requires the ordered action rows and current footer, with no
keys. A copy above a normal live composer is not an active hold.

## Static findings and dispositions

`LIVE` below means actual rendering by the retained executable with a
local mock. `BIN` means retained binary text, not a proved live screen.

| Precheck group | Evidence and disposition |
| --- | --- |
| `No, cancel` next to box characters and `Grok Build` | BIN: these bytes existed in the old pool too, but their neighbors moved. LIVE launch trust still says `Yes, proceed / No, quit`; the dashboard was also captured. No new normal-launch cancel choice was observed. |
| `Yes, proceed … Do you trust the contents` | LIVE: launch trust renders the same known choices/hotkey. The changed pool neighbor is not a new trust action. |
| `Yes, proceed … Enter or y to trust … Starting` | LIVE: y proceeds to the normal composer. Binary concatenation changed; the action is unchanged. |
| Two `rate limit exceeded; sleeping` hits | BIN: internal client/service readiness strings with changed neighbors. LIVE main-turn 429 still renders the known framed `rate_limit_error` row. |
| Approve mode / external prompt editor / stop subagents | BIN: optional mode/editor/subagent surfaces, not reached by AgEnD's launch or lifecycle commands. No new automatic answer is added. |
| Continue current session / re-borrow | BIN: optional agent/subagent flow. Direct UUID resume was verified LIVE. |
| Reject-and-explain / allow-edits-in-folder variants | BIN: workspace permission choices. LIVE default-permission shell card was captured, never accepted; normal AgEnD launch uses always-approve. These variants are not generalized into permission approval. |
| Find matches / close/filter/search / show all | BIN: interactive search/palette text. No AgEnD key sequence opens these views. |
| Three review-and-send strings | BIN: review/draft UI and embedded instruction text. No ordinary input/receipt contract is inferred from them. |
| Resume paused goal / resume in worktree / resume subagent | BIN: optional goal/worktree/subagent commands. Existing UUID resume and `/new` were verified LIVE. |
| Cancel before moving | BIN: neighbors name a running turn, move, stop and background tasks. This optional move confirmation was not reached; it is not silently answered. |
| `continue from it with` | BIN: guidance fragment without a demonstrated new action. |
| Insert newline / save-Esc-discard / Esc-close / Tab-focus | BIN: editor/navigation help. LIVE boxed short/long input and queued submission were captured; weekly scrollback exposed the separate Tab repair. |
| Enter to retry a stopped turn | BIN: explicit retry guidance, not an instruction to auto-submit. LIVE cancel restores the draft. |
| Approve plan / memory controls | BIN: optional planning/memory UI. Neither is exercised or automatically selected by this audit. |
| Usage-limit-as-JSON / usage upsell and related event names | BIN: help/event fragments. LIVE weekly-limit question and scrollback states were captured at both widths. |

The unavailable upstream changelog supplies no additional assurance. The
full 31-hit inventory stays distinguishable from the subset reached live.
See the fixture README for OAuth, Windows and pre-existing detector gaps.

## Validation and rollout

Both new defects were pinned red before the corresponding source repair.
Validation covers 818 distinct cases in 26 files across staged runs
(809 in the regression pass, six added controls and three retry-rendering
controls), with runtime source unchanged between those runs. Four reversals
fail assertions and restore exactly. Both TypeScript programs exit zero;
the detector manifest is current. Acceptance is posted for the exact
public head before review. Binary files,
account state and raw scratch homes are never committed. Public evidence
uses separate path and hash fields.

The common detector changes also affect main, which has the same old
matchers; a main twin is required. Inline switching remains alpha-only and
is not ported by this audit. The installed CLI is unchanged. The lead,
after review and merge, decides when to record 1.0.88 as audited.

Rollback reverts the narrow detector and generated-manifest changes. That
restores the old failure on the new screen; it does not alter CLI binaries
or credentials.
