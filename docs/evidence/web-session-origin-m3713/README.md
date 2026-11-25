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
