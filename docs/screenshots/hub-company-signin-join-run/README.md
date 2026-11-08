# #3423 company-account connection acceptance

The PNGs come from the real Fleet Settings shell (app sidebar and second Settings menu) and the landed Hub shell, without DOM replacement. Source: `7c10c9d40` on `feat/hub-company-signin-join`, aligned to alpha `10a695e68` (including #3432 and #3430). The later repair-confirmation wording and recovery guidance do not change the normal screens captured here. A bounded, jittered backend poll schedule was added afterward and the two happy paths were rerun on that delta. `SHA256SUMS` identifies every supplied image.

| Run | Result | Scope |
|---|---:|---|
| Current | 13 scenarios, 114 checks | Full 1366/390 × EN/zh-TW × light/dark; real two-submit connection and explicit return; zero per-Fleet admin prompts. Five more scenarios cover outsider, retained-Fleet limit, changed Hub descriptor, cancellation and a copied request in a second browser context. Settled Administration and the distributed public link are included. The four Administration captures were retaken with Copy scrolled into view (5 further layout/navigation checks). |
| Before | 8 scenarios | Exact alpha `10a695e68` panel/membership/client/registry UI modules served on the same isolated listener fixture, before the company flow existed; no replacement markup. All eight viewport/language/theme combinations. |
| Cached assets | 2 scenarios, 21 checks | Current modules with alpha.8 `478bc61145acd3b44e4bf0f05588c42fe06a1831` CSS, app-shell, app-route, i18n, UI states, Hub client and Hub/quick strings. Desktop light EN and phone dark zh-TW complete the connection and return. |
| Focused | 270/270, zero skips | Company join protocol, sealed receipts, HTTP/fake LDAPS, transport/trust, local crash/rejoin, Settings authority, mounted UI, notice mixed versions and existing group/composition/Hub/Settings suites. |
| Final delta | 33/33 tests; 2 browser scenarios, 21 checks | Adds a shared, jittered backend polling window and recovery/repair wording. The desktop and phone happy paths pass again; both typechecks pass after this delta. |
| Aligned alpha | 325/325, zero skips; both typechecks pass | Plain merge of alpha `7a34b6be1` adds the sealed directory-settings writer without changing the captured UI. The full focused set plus its directory-decision integration tests pass on merge head `584a206e9`. |
| Mutations | 13/13 caught | Origin, purpose, owner AAD, delivery expiry, original local session, active journal, crash intent, retained manual quota, fresh eligibility, v2 ACK, v2 wire, invitation recipient and directory epoch. Each run reaches failing assertions; sources restore in `finally`. |
| Types | Both pass | `npx tsc --noEmit`; `npx tsc --noEmit -p tsconfig.test.json`. |

The tests also cover immutable deadlines, same-credential recovery, cancellation after issuance, exact requester/confirmer/binding changes, directory loss and explicit policy denial, required outbox rollback and manual invitation provenance. Local crash injection covers marker, profile, membership and lost ACK response; it is not a power-cut or native Windows claim.

## Reproduce

Use the installed `playwright-core` root and an explicit Chromium executable, a free owned listener port and a scratch output path:

```sh
REPO="$PWD" PW_DIR=/path/to/playwright-core-parent CHROME=/path/to/chromium \
  MATRIX=full OUT="$PWD/.artifacts/hub-company-join/browser" \
  npx tsx scripts/manual/smoke/smoke-hub-company-join.mts
python3 scripts/manual/mutation/hub-company-join.py
```

`BEFORE_ASSETS` or `SKEW` points to a directory of exact `git show <sha>:<path>` asset files. The before set is `settings-hub-membership.js`, `settings-registry.js`, `panel-hub.js`, `hub-client.js` and `hub-quick-pairing.js`; the cached set is listed above. Use `EXTRAS=0` for a baseline/cache run. The runner refuses an already occupied port instead of contacting it.

The fixture uses scratch HOME/AGEND_HOME and a private tmux location with refusing CLI/lifecycle stubs. It starts no daemon, native pane, model, live fleet, vendor account, Telegram or Discord transport. Chat-configured cases exercise the real local host Settings authority with an inert chat connection. The Hub is initialized and sealed normally; production LDAP BER/TLS/session/group/SQLite/audit and pinned member WSS execute against dummy identities in an owned verified fake-LDAPS peer. The owned test CA and loopback hostname mapping are injected per test client; public enterprise PKI deployment is not claimed. Chromium accepts only that fixture's browser certificate. A private Fontconfig file retains the installed CJK font while HOME is scratch; no product font/CSS override is used.

Current checks verify actual ready member links, no browser-side runtime credential or Fleet AD password, no page/CSP errors or horizontal overflow, explicit no-opener handoff and no credential-bearing return URL. A bounded fixture process-exit-listener warning appears when repeatedly booting all 13 owned Fleet fixtures; it is not a browser/application error. Each browser, Fleet member runtime, listener and fake directory is closed after the run; scratch auth/private state is never committed.

## Representative pairs

- Fleet desktop: [before](desk-light-zh-TW-before-fleet.png), [start](after-desk-light-zh-TW-01-fleet-start.png), [connected](after-desk-light-zh-TW-03-fleet-connected.png).
- Fleet phone: [before](phone-dark-zh-TW-before-fleet.png), [start](after-phone-dark-zh-TW-01-fleet-start.png), [connected](after-phone-dark-zh-TW-03-fleet-connected.png).
- Hub: [sign-in](after-desk-light-zh-TW-02-hub-signin.png), [return](after-desk-light-zh-TW-04-hub-return.png), [administration](after-desk-light-zh-TW-09-admin.png), [public company link](after-desk-light-zh-TW-10-public-link.png).
- Refusals: [outsider](after-desk-light-zh-TW-outsider-08-refused.png), [limit](after-desk-light-zh-TW-limit-08-refused.png), [changed identity](after-desk-light-zh-TW-changed-05-identity-changed.png), [copied request](after-desk-light-zh-TW-copied-06-copied-refused.png), [cancelled](after-desk-light-zh-TW-cancel-07-cancelled.png).
- Cache: [desktop](skew-desk-light-en-03-fleet-connected.png), [phone](skew-phone-dark-zh-TW-03-fleet-connected.png).
