# Web session identity without go-ahead authority

Contact-origin stamping read a web person only from web-verified authority. A
known signed-in but unverified account therefore became unknown. Recognition is
now captured from the current server session in optional `origin.web_identity`;
receipt authority remains unchanged, with no verified flag added to plain web
input. Typed messages, retries, reply choices and conversation commands carry it.
The current target administrator gate still decides the person's contact role.

Threats and controls:
- Confusing recognition with approval: authority remains none. A reversal marking
  a known account verified fails the metadata assertion. No management or go-ahead
  gate consumes the identity field.
- Body/name/voter-key impersonation: only the admitted session supplies identity.
  Spoofs are ignored; header tokens and unbound sessions acquire no account.
  Host recognition needs explicit provenance on a web-only Fleet.
- Revocation during body read: admission is checked again before dispatch. No
  click, receipt or origin is created when the session was revoked.
- History laundering: existing unknown stays unknown after a new known admin
  input. Old receipts discarded the session join, and unions may include seeds
  or truncated evidence. Recovery uses the existing verified Permissions → Clear
  retained origin, with CAS and audit. No pending request is replayed.

The actual HTTP reply-button case crosses the real controller, FleetManager,
receipt writer and SQLite contact store. Typed input and command admission are
also exercised. Two semantic regressions fail on the exact starting base while
three negative controls pass. Copy the retained fixture into tests with a
`.test.ts` suffix to repeat that proof. Four targeted files pass 71 tests,
including 14 new cases; three instruction suites pass 64. After the release sync,
three targeted identity/public-link/Needs-you suites pass 48. Both TypeScript
checks pass. The first affected run had 916/922 passing in 59 files: two copy
assertions were updated and now pass; four pane-capture assertions also fail
unchanged on the exact starting base (4 failed, 15 passed). Those baseline host
rig failures were not hidden or rewritten. See verification.json for file lists.

The real app recipe is scripts/manual/smoke/smoke-web-session-origin-m3713.mts.
It uses a scratch outbox and synthetic historical unknown ticket without daemon
starts. Both base and changed UI were captured across desktop/phone, light/dark,
EN/zh-TW: 16 before and 16 after PNGs. Eight cases per stage have no page/CSP errors
or horizontal overflow. CSP is collected on both pages. The recovery control is
shown, never pressed. The final phone-English/Chinese Needs-you and Chinese
Permissions originals were individually inspected. The English phone screenshot
shows the full recovery hint; lower actions extend below its viewport. Existing
disabled standing-grant labels are ellipsized. No broader layout claim is made.

This adds recognition, not an authority kind, sandbox or tool grant. No body
matching or DB hand edit repairs history. Optional JSON requires no migration;
reverting may classify later plain-web input as unknown again. No live Fleet,
real account, provider, model or CLI was used.

## Independent-review follow-up

The eight `recovery-needs/` PNGs supersede the earlier after-stage Needs you
frames; the twenty-four other original frames are retained unchanged.
The new receipt binds capture source `65cee97eb2dd6ec71d80607c3314d19590887d19`.
The hint now names the sending Agent by its display name and its full Settings →
Permissions path, separately from Open in Authorizations. No confirmation is
pressed. The source-administrator recovery action itself remains unchanged.

Two edge cases remain deliberately unidentified: a host sign-in on a chat Fleet
which names no chat account, and an approved device without a bound account or
explicit host/TOTP sign-in. Neither borrows an administrator's identity from
dashboard access or a display-only device-approval field. The new controls pin
both; identity remains separate from go-ahead authority. The actual poll flow
starts with a count and Authorize this browser, rejects the unverified scoped
read, and returns the unknown-origin ticket after verification. Mounted EN/zh
Needs you controls exercise Authorize then display the sender-named recovery
hint. This uses the already-merged M-3710 path without widening contactActor.

Identity/contact-UI controls pass 54 tests; the final verification/Needs-you file
passes 14, including the two new locale transitions. Both TypeScript checks pass.
The initial transition test exposed a fixture display-name property typo, fixed
to the production `display_name`; no production identity role was changed.
Revoking web authority leaves sign-in recognition, while signing out ends it.
The simpler request-scoped provenance proposal is recorded on Phase 2 M-3718.

Both final phone originals were individually inspected: English and Chinese
show the complete sender-named recovery path without horizontal clipping or
missing glyphs. The English lower Decline/card edge remains below the viewport;
the Chinese card and Authorizations link fit. Existing disabled contact labels
remain ellipsized. Only synthetic Demo identities and public example text appear.

The final first sentence also names the sender (both unknown-origin and earlier
non-admin reasons), rather than saying “this Agent” under the receiver's heading.
Only TicketCard's reason label changes; its recovery hint, Permissions, CSS, and
identity/authority runtime are unchanged. The two affected UI/Needs suites pass
52 tests. All eight Needs frames are refreshed at the source recorded above.
