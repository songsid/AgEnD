# Composer popup mouse regression (M-3557)

Main first; the dev twin follows the actual main merge. This fix has a beta.19 freeze exception; it does not release unrelated held PRs.

The real-app baseline reproduces the report: typing `/` and pressing the first `[role=option]` row with a real mouse leaves the box `/`. The strip's pointerdown delegate calls preventDefault on that row, suppressing the compatibility mousedown that performs command completion. The captured event sequence contains pointerdown (prevented) and no mousedown. A mounted regression also fails on the unexpected prevented event.

The delegate now requires `data-composer-focus` on the exact event target. Only the actual padding/background and static working/status/placeholder text surfaces opt in. Eligibility never propagates to descendants: a popup inside an eligible wrapper is not eligible itself, regardless of role, tabindex or future menu markup. Existing native-control, primary-button and touch-scroll guards remain. No role-option exclusion list, popup action changes, CSS/layout changes or new interaction is introduced.

The main chat markup marks the existing strip, work bar/static text, composer box/pill/field/placeholder and bottom-row background/hint. Slash palette rows and every other popup descendant remain unmarked. The dev twin must carry this ownership boundary into its shared ComposerInput/FleetDockStrip and exercise its additional hash/mention lists.

## Proof

Implementation `fe765cd842e74cc134c54636124e68d312219c41`; subsequent evidence-only changes do not alter exercised components.

- Actual scratch-app Chromium baseline fails: mouse row pointerdown prevented, no mousedown, value stays `/`; mounted regression has one assertion failure.
- Corrected actual app: desktop mouse and phone mouse/emulated touch choose `/sysinfo` from a role-option row. The row receives its mousedown. Mouse clicks on the edge strip still focus the textarea and accept typing. A deliberately unclassified popup nested inside the strip receives its own mouse handler. No chat send and no CSP violations.
- Full mounted composer suite17/17 PASS: new slash and listbox/menu/dialog/tooltip/unclassified descendants plus existing edge focus, working/idle strip, controls, touch-scroll, selection and keyboard behavior.
- Test typecheck exit0; changelog207 fragments PASS; public text and staged secret scan clean.

[Browser results](browser-result.json), [source and private-log hashes](verification.json).

Commands:

```sh
npx vitest run tests/web-composer-2478.test.ts
npm run typecheck:tests
node scripts/changelog-assemble.mjs --check
# Set REPO, PW_DIR (playwright-core), CHROME and OUT to owned paths.
node --import tsx scripts/manual/smoke/smoke-composer-popup-m3557.mts
```

This proves Chromium native mouse phases and emulated touch in an owned scratch FleetManager. It is not native-phone/WebKit coverage. Main has the slash popup; dev-only hash/mention variants are integration work for the twin. The fixture never sends a message or starts an agent. An initial main fixture launch using unsupported ephemeral-port mode failed before browsing; the retained baseline above uses the fixture's checked private fixed ports. No screenshot approval or fresh visual campaign is claimed.

Applicable review-checklist rows: input target ownership and real-event fail-first proof, exact component/evidence bindings and inert fixture effects. Runtime authorization, persisted state and activation changes are N/A. User-facing skills need no change for this regression repair. Rollback the marker/delegate changes together in a normal follow-up; rolling back only markers would remove background focus. No migration or runtime rollback.
