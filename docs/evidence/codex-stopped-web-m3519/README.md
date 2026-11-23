# Codex stopped-chat recovery

## Cause and scope

The stopped-screen reader deliberately returned no choices, and tests pinned that behavior. That left a person with an informational web card but no supported recovery action: terminal View is read-only, and ordinary chat input is held behind the CLI dialog.

The new card offers **Start a new chat**, exclusively through the existing human/admin question-card boundary. Chat and Needs you ask through the shared confirmation dialog before submitting. The daemon still verifies the exact current screen identity under its pane lock, walks the physical cursor, then sends Enter. No automatic choice, free-text answer, command-center action or continuation override is added.

The stopped conversation cannot continue. New chat starts without its context; it preserves existing files and AgEnD chat history and does not undo prior edits. Context transfer should use a person-reviewed summary, not automatic replay. Resume another chat remains unavailable from the web: opening its separate picker without a supported remote selection flow would strand the person on another screen. This change does not claim that the stopped conversation can be unlocked by resuming it.

## Needs you investigation

Read-only observations confirmed the daemon's `awaiting_input` / `safety_review` state. The available platform live-message pointer file does not contain per-agent items, and no admin web snapshot was available. Therefore the precise cause of the reported missing badge is **unconfirmed**.

The requested synthetic reproduction uses the real FleetManager and NeedsYouHub with the stopped pane, including the original empty-option card. It produces one prompt item; after prompt retirement it produces the awaiting-input fallback. A separate real `/ui/poll` handler test retains both prompts and derived needs. Empty options do not cause suppression. These controls prevent treating the intentional no-button behavior as proof of a separate missing-item defect.

## Validation

- The stopped-option and Fleet presentation expectations fail on the base (2 failed, 52 passed).
- Focused parser, daemon, Fleet, poll and web-store tests cover stale screens, physical rows, no automatic keys, ordinary-token refusal, explicit confirmation, cancellation, duplicate clicks and expiry/replacement while confirming.
- The browser recipe is `scripts/manual/smoke/smoke-codex-stopped-m3519.mts`. It boots the product web server in a scratch Fleet with synthetic content, never starts a CLI or signs into a provider, and uses headless Chromium. Eight cases cover desktop/phone, light/dark, EN/zh-TW. Each captures the card, confirmation and Needs-you entry. Cancellation produces zero daemon answers; all cases have no horizontal overflow.
- Shared UI components: existing prompt card/actions, Needs-you item, `confirmDialog`/`Dialog`, `.btn`. No CSS added. Copy distinguishes stopped from paused review; findings remain in read-only View.

## Limits and rollback

No live pane was touched. No provider/model call, real credential or live content enters the recipe or evidence. The missing live badge remains an evidence limitation, not a claimed fix. Reverting the parser option and confirmation plumbing returns to the informational stopped card; no storage or migration change is involved.

### Capture review corrections

Confirmation now retains the choice label without an answering indicator; that indicator starts only after confirmation. The eight-case browser recipe explicitly refuses a premature answering indicator. The zh-TW status uses the product's existing localized safety-review string. Confirmation says to provide needed background explicitly rather than referring to a nonexistent summary. Selection guidance no longer suggests typing into read-only View.

The retained question-mark emoji's missing-glyph square is specific to the capture host: `fc-list ':charset=2753'` reports no matching installed font, while `fc-match` falls back to DejaVu Sans. The existing shared prompt prefix is unchanged; no font is installed by the recipe.

After these scoped copy/confirmation corrections, the five affected UI/parser/poll/i18n files pass 102 tests. The original wider 393-test result covers the preceding runtime implementation; no CLI or provider campaign was repeated.
