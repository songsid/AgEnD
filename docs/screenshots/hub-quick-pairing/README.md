# Hub quick pairing acceptance (S-90)

Captured with Chromium 156.0.8078.4 from source `b2775d9c03404feffe5a18a8f1c3ebab4c9e5fcc`.
The production Hub and fleet web listeners are real; their homes, SQLite databases, certificates and all accounts are scratch fixtures.
The production AD driver uses a recorded fake LDAPS wire peer. Only its connector redirects the requested loopback DC port 636 to our owned ephemeral port; TLS verification and critical extended-DN controls stay enabled.

No daemon, native pane, CLI, model API, real account, Windows host, live fleet or tmux server was used.
The primary journey uses the browser for both Hub and local Settings confirmations, normal host sign-in, saved pin and ready member connection.
The additional notice journey creates a second member through the production local pairing API as a **recorded boundary**, not a second browser journey.
Its notice crosses the real negotiated WSS link into the first member's SQLite inbox and local audit before the Hub accepts its ACK. The browser displays that notice through the private Settings endpoint.

| Run | Coverage | Checks | PNGs |
|---|---|---:|---:|
| `before/` | Previous UI modules on current backend; eight desktop/phone × light/dark × EN/zh-TW cases | 21 | 8 |
| `current/` | Full pairing journey, same fingerprint, saved pin, ready connection, refreshed own-fleet row, other-session/admin notices, one-click exact revoke; eight cases | 70 | 41 |
| `notices/` | Additional connected-fleet retention/ACK and review link; desktop light EN and phone dark zh-TW | 30 | 15 |
| `skew/` | Cached pre-S90 CSS and app shell; desktop light EN and phone dark zh-TW, plus an old Hub client that hides quick actions | 22 | 11 |

Every run checks browser errors, CSP violations and foreign requests (all zero), plus verified LDAPS controls and horizontal overflow. CJK capture uses Noto Sans CJK TC. Images include short-lived codes and credentials only from dummy fixtures; all listeners, browsers and scratch state are removed afterward.

The before run retains `panel-hub.js`, `hub-welcome.js` and `hub-client.js` from `7ab23b6c6`, so it is a UI comparison, not an old-server compatibility claim.
SKEW retains that revision's `app.css`, `hub.css`, `hub-owner.css`, `hub-groups.css` and `app-shell.js`; its separate old-client case retains `hub-client.js`.
Mixed-version network tests separately prove old member/new Hub and new member/old Hub send no unnegotiated notice or ACK while the old transport stays usable.

## Representative images

| Surface | Before | Current |
|---|---|---|
| Desktop, light, EN | [Welcome](before/before-desk-light-en-welcome.png) | [Fingerprint](current/current-desk-light-en-fingerprint.png), [connected](current/current-desk-light-en-connected.png) |
| Desktop, dark, zh-TW | [Welcome](before/before-desk-dark-zh-TW-welcome.png) | [Fingerprint](current/current-desk-dark-zh-TW-fingerprint.png), [connected](current/current-desk-dark-zh-TW-connected.png) |
| Phone, light, EN | [Welcome](before/before-phone-light-en-welcome.png) | [Fingerprint](current/current-phone-light-en-fingerprint.png), [connected](current/current-phone-light-en-connected.png) |
| Phone, dark, zh-TW | [Welcome](before/before-phone-dark-zh-TW-welcome.png) | [Fingerprint](current/current-phone-dark-zh-TW-fingerprint.png), [connected](current/current-phone-dark-zh-TW-connected.png) |

[Existing-fleet notice, phone dark zh-TW](notices/current-phone-dark-zh-TW-existing-fleet-notice.png) · [Administrator notice, phone dark zh-TW](notices/current-phone-dark-zh-TW-administrator-notice.png) · [Cached-CSS fingerprint, phone dark zh-TW](skew/current-skew-phone-dark-zh-TW-fingerprint.png).

All 16 current fingerprint/connected images and eight corrected notice images were independently inspected for readable CJK, correct theme/viewport, fingerprint/actions, refreshed fleet row and metadata spacing; no material visual findings.

## Reproduce

Use `scripts/manual/hub-quick-pairing/accept.mts` with `REPO`, `OUT`, `PW_DIR`, `CHROME` and a CJK-capable `FONTCONFIG_FILE`.
Default `MATRIX=full`; `MODE=before`, `EXTRA_NOTICES=1 MATRIX=quick` and `SKEW=1 MATRIX=quick` select the other rows.
The script refuses foreign browser requests and uses private homes and inert CLI stubs.

Focused validation: 335/335 tests across 23 suites, zero skips; both production and test typechecks; changelog guard and scoped diff check.
Fail-first validation recorded ten executed test failures before implementation. `scripts/manual/hub-quick-pairing/mutations.py` caught 12/12 mutations through executed failed assertions: group-only admission, quota boundary, admin headroom, one offer, fingerprint, admin wait, authoritative denial, required notice transaction, exact owner revoke, session privacy, retain-before-ACK and capability guard.
Local JSON/log receipts stay uncommitted; the evidence committed here is PNGs.

## Rollback

Group permissions remain off until the Hub administrator explicitly enables them. No deployment or policy activation is part of this change.
New schema components are `s90-pairing-notices` on the Hub and `s90-pairing-inbox` on members. An older strict binary needs matching pre-upgrade private state and monotonic-floor backups; do not reset an independent floor to admit stale state.
The outbox/inbox refuse new automatic credentials/ACKs at their bounded capacity rather than silently discard security notices. Older members' queued notices stay pending until they support delivery.
