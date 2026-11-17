# Codex precaution screens (M-3292)

Codex 0.169.0 uses footerless precaution menus and a full-screen findings pager. These previously escaped the generic selection detector. Delivery now waits on every recognized precaution state. Needs you and the agent's chat receive a code-owned neutral summary. Findings and quoted continuation text remain in View.

All fixtures are synthetic. Private operational captures were read locally only, and are not included here. Their plain and ANSI confirmation shapes both matched the new reader. This work never executed Codex, sent model input, changed a live session or opened a window.

## Static flow inventory

Audited upstream tag `rust-v0.169.0`, commit `d32063f96c2dff1dc96af839b3952abb6acfeda4`. The installed npm package metadata was 0.169.0; static binary bytes matched the audited strings. `Review findings` is built from immediate stores rather than one contiguous string (see binary-static.json).

1. A violation ends the turn, retires realtime voice, clears queued/composer input and disables ordinary submission.
2. With retained usable findings: **Chat paused as a precaution** → Review findings / Agent command center / New chat / Resume another chat.
3. Without usable findings: **Chat stopped as a precaution** → New chat / Agent command center / Resume another chat. No acknowledgement exists here.
4. Review opens **What we detected**. It optionally shows **Continuation request (quoted)** and then the findings.
5. The pager footer offers ↑/↓ scroll, pgup/pgdn page, home/end jump and **q close**. Ctrl-C also closes; Escape does not. Closing reveals confirmation, without acknowledging.
6. Confirmation: **Acknowledge findings and continue** / **Back**. A missing, blank or oversized retained continuation disables acknowledgement: its number disappears, and Back becomes shortcut 1.
7. Arrow keys move selection. A digit focuses acknowledgement but cannot submit it; Enter on the highlighted enabled row is required. The menus do not allow Escape/Ctrl-C cancellation.
8. Back returns to the paused root menu. It does not continue the turn.
9. Acknowledgement rechecks thread/turn/review identity and current thread status, then submits the exact retained continuation with an override marker. Success starts a new turn and releases the block; failure stays paused with a generic error. Stale/double actions do not resubmit.
10. New chat creates a new session; Resume another chat opens the resume picker; Agent command center opens its overview. AgEnD leaves these session-changing actions in View.
11. No appeal, report or stop choice, no flow-specific timeout and no automatic continuation were found.
12. **⚠ N warnings · f2 to view** is independent passive chrome; it neither blocks delivery by itself nor proves readiness. Existing composer/status ownership remains required.

Sources: [chat widget](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/tui/src/chatwidget/misalignment_policy.rs), [application transitions](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/tui/src/app/misalignment_policy.rs), [selection rendering/keys](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/tui/src/bottom_pane/list_selection_view.rs), [pager](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/tui/src/pager_overlay.rs), [warning chrome](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/tui/src/bottom_pane/chat_composer/warning_notice.rs).

## Controls and limits

The chat exposes Review findings, enabled Acknowledge and continue, and Back only. The no-findings card directs the owner to View. The pager's Back sends q; confirmation actions use verified cursor movement and Enter. Disabled acknowledgement is omitted. No action is automatic. Header-token web scripts cannot claim these cards; an admin session with the existing origin/CSRF checks is required. Channel callbacks retain owning-adapter admin, place and single-consumption checks.

Fail-first: all seven synthetic states failed the new hold/card assertions before implementation. Focused reversals in controls.json caught removal of registration, disabled-action filtering, the under-lock identity check and the human-session gate. Runtime tests use a real Daemon and FleetManager with forbidden host process/socket/lifecycle hooks; other card and web-route tests use inert panes and loopback HTTP only.

Known boundary: this reader is pinned to the audited 0.169 shapes. An unknown future flow needs a new fixture. The report remains in View; no full findings are copied into the chat. Rollback is an ordinary code revert, restoring the prior detector behavior; there is no data migration or session mutation to undo.

## Validation

Alpha: 410/410 tests in 16 affected files, `--maxWorkers=2`; source and test typechecks each report zero errors. No native or model campaign.

```sh
node_modules/.bin/vitest run tests/codex-precaution-3292.test.ts tests/daemon-interaction-observation.test.ts tests/cli-question-chat-3334.test.ts tests/web-chat-c4.test.ts tests/codex-warning-footer-3060.test.ts tests/web-only-dialogs-2910.test.ts tests/kiro-remote-card-2675.test.ts tests/needs-you-derive-1386.test.ts tests/codex-trust-modal.test.ts tests/codex-rate-limit-picker-1008.test.ts tests/codex-update-picker-delivery.test.ts tests/interaction-observation.test.ts tests/kiro-remote-card-chat-2675.test.ts tests/interactive-prompt-assist.test.ts tests/codex-0169-audit.test.ts tests/codex-pane-compat.test.ts --maxWorkers=2
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit -p tsconfig.test.json
```
