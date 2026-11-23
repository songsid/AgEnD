# Per-person allowed contacts

## Behavior and boundary

The old contact card hid a standing grant behind a checkbox and only supported a single known origin. The new explicit choice opens the shared Dialog with person, source, target, request type, expiry and optional use limit. Default is seven days and unlimited uses within that period. A known multi-person origin starts unchecked and creates one row per selected person; unknown origins permit only one-time approval. Every retained person still needs a matching rule before an automatic delivery.

Bindings stay exact: platform/adapter/person identity, source, target, verb and both incarnations. Creating grants and admitting the approved request share the transaction. Invalid selections are refused before admission. Existing target-admin authority, revision checks, Hub contact restriction and endorsement-without-origin-propagation remain unchanged. This is contact approval, not an action or read-only permission boundary. General proposal/verified platform confirmation is a separate next slice.

## Validation

- Ten contact/controller/API/UI/origin neighbor files: 124/124 tests pass.
- The first six new standing-grant controls fail against the base store. Tests cover expiry/revoke, exact identity/source/target/verb/incarnations, selected-origin validation, all-origin matching, quotas and transactional rollback, target refresh, Hub refusal and retaining unchanged expired rows.
- Mounted controls cover explicit selections, cancel, duration/defaults, fixed edit scope, localized title/platform/expiry, and a real Permissions panel save with its read revision and unchanged neighboring rows.
- Real product HTTP/app, scratch outbox and synthetic identities: eight desktop/phone × EN/zh-TW × light/dark cases. Six states per case, no horizontal page overflow, page errors or CSP violations; one grant created in each case. Recipe: `scripts/manual/smoke/smoke-contact-grants-m3544.mts`. No live Fleet, account or model calls.
- The eight retained originals show the corrected card/dialog/list views; remaining originals are held locally for the user look. Native date widgets may use the browser locale, so an explicit page-locale expiry line is shown next to the chosen value.

## Style-guide audit

Checked against `docs/design/ui-style-guide.md`: shared Dialog/confirmDialog, card/field/grid2/s-checks/buttons/InfoTip; existing Settings frames and straight accents; spacing and color tokens; no inline styles; existing Skeleton/ErrorState; phone bottom sheet and desktop-centered modal with no horizontal scroll; EN/zh-TW strings and proper Agent/Fleet names; local success link to Permissions; scoped plain-language errors; shared icons. Hub-shell rule is inapplicable to these Fleet-only views. Secondary endorsement detail remains in the existing InfoTip, while the permission scope is visible before saving.

The conditional user-look corrections include localized administrator labels, display names consistently in routes, Discord branding, complete dialog titles, page-locale expiry, whole-phrase metadata wrapping, natural Chinese sentence joining, and a readable token-based disabled primary style scoped to this dialog.

## Risk and rollback

No schema migration. Retaining an unchanged expired rule does not reactivate it; modifying it requires a future expiry and current source. Old single-person decision callers remain compatible. Revert this PR to restore the checkbox and single-person creation UI. Existing durable grants keep their existing matcher and revoke support. The General path is not shipped by this slice.

## Review correction

The policy writer assigns final IDs to new rows. Ticket references now come from its persisted return value rather than the temporary input rows. The regression fails before the correction, then checks the selected person's saved ID, the reread ticket, unchanged neighboring rows and rollback after failed admission. Three affected store/API files pass 22 tests. Runtime-only correction; the approved UI and captures are unchanged.
