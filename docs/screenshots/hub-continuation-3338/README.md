# Hub pairing and grant continuation (#3337, #3338)

Real Chromium 156, initialized production Hub HTTPS + TLS/WSS member runtime, disposable fake LDAPS directory and the production fleet web listener. Scratch HOME, private guard binaries, no live fleet, provider account or model call. Native delivery is a recording stub that calls both `stillCurrent()` and `beforeInput()`; question admission, pairing and grant checks are real.

The baseline is `f0374ff64`'s UI modules and owner CSS against the same production server. The current matrix is desktop 1366×900 and phone 390×844, light/dark, EN/zh-TW. `before-*-grant` uses the old manual Allow button to show the existing form spacing; `current-*-grant` opens from the exact-agent continuation. Controls and text remain in view. No new component library or custom card/button/toggle styles: `PageHead`, `.card`, `.field`, `.field-row`, `.btn.btn-sm`, `Icon`, existing `Dialog` and its existing owner grant route. The owner form resets obsolete inline-form flex sizing in `hub-owner.css`.

## Before and current

| Case | Pairing code card | Published fleet row | Exact-agent Allow form |
|---|---|---|---|
| desk-light-en | [before](before-desk-light-en-code.png) · [current](current-desk-light-en-code.png) | [before](before-desk-light-en-share.png) · [current](current-desk-light-en-share.png) | [before](before-desk-light-en-grant.png) · [current](current-desk-light-en-grant.png) |
| desk-light-zh-TW | [before](before-desk-light-zh-TW-code.png) · [current](current-desk-light-zh-TW-code.png) | [before](before-desk-light-zh-TW-share.png) · [current](current-desk-light-zh-TW-share.png) | [before](before-desk-light-zh-TW-grant.png) · [current](current-desk-light-zh-TW-grant.png) |
| desk-dark-en | [before](before-desk-dark-en-code.png) · [current](current-desk-dark-en-code.png) | [before](before-desk-dark-en-share.png) · [current](current-desk-dark-en-share.png) | [before](before-desk-dark-en-grant.png) · [current](current-desk-dark-en-grant.png) |
| desk-dark-zh-TW | [before](before-desk-dark-zh-TW-code.png) · [current](current-desk-dark-zh-TW-code.png) | [before](before-desk-dark-zh-TW-share.png) · [current](current-desk-dark-zh-TW-share.png) | [before](before-desk-dark-zh-TW-grant.png) · [current](current-desk-dark-zh-TW-grant.png) |
| phone-light-en | [before](before-phone-light-en-code.png) · [current](current-phone-light-en-code.png) | [before](before-phone-light-en-share.png) · [current](current-phone-light-en-share.png) | [before](before-phone-light-en-grant.png) · [current](current-phone-light-en-grant.png) |
| phone-light-zh-TW | [before](before-phone-light-zh-TW-code.png) · [current](current-phone-light-zh-TW-code.png) | [before](before-phone-light-zh-TW-share.png) · [current](current-phone-light-zh-TW-share.png) | [before](before-phone-light-zh-TW-grant.png) · [current](current-phone-light-zh-TW-grant.png) |
| phone-dark-en | [before](before-phone-dark-en-code.png) · [current](current-phone-dark-en-code.png) | [before](before-phone-dark-en-share.png) · [current](current-phone-dark-en-share.png) | [before](before-phone-dark-en-grant.png) · [current](current-phone-dark-en-grant.png) |
| phone-dark-zh-TW | [before](before-phone-dark-zh-TW-code.png) · [current](current-phone-dark-zh-TW-code.png) | [before](before-phone-dark-zh-TW-share.png) · [current](current-phone-dark-zh-TW-share.png) | [before](before-phone-dark-zh-TW-grant.png) · [current](current-phone-dark-zh-TW-grant.png) |

## Acceptance boundaries

- Admin copies the actual member address plus the expiring code; browser and member ports differ.
- Connect uses that address, retains fingerprint comparison, local confirmation, independent Hub owner confirmation and admin approval, then establishes the real member link.
- Publish follows the existing Settings confirmation. The contextual button is unavailable for pending, withdrawn, frozen, missing-ID or changed-pairing rows. A user click opens the approved Hub in a separate tab, leaving the fleet tab as the return context.
- A fresh signed-out Hub tab retains the exact agent through directory sign-in, opens its existing Allow form, grants Alex with the shown revision/expiry, and Alex's subsequent question reaches the real representative admission gate.
- On current alpha, outward Hub changes need explicit host approval until #3355 lands. The base run records three fixture-host decisions as setup; it does not claim the old release completes those confirmations in the browser. The integrated run is **accepted with #3355 @c927eb1e stacked**, separately from this PR's source: real scratch-host sign-in codes and actual Apply now; zero fixture-host decisions. [Integrated code](integrated/workflow-code.png), [published row](integrated/workflow-published.png), [restored grant form](integrated/workflow-signed-in-grant.png).
- Cached-shell SKEW serves `b47cad34a` app-shell.js, hub-client.js, hub-strings.js, app.css, hub.css and hub-owner.css: the address and exact-agent link still render and work. The server field is additive; an older server lacking it shows an explicit address-unavailable hint and never substitutes the browser address. No wire capability or new grant API.
- Focused tests retain CSRF, ownership, current-directory identity, revision, publication and expiry refusal controls. No arbitrary return URL or query-driven grant is introduced.

## Cached shell

| Case | Code card | Fleet row |
|---|---|---|
| Desktop dark EN | [PNG](skew-desk-en-code.png) | [PNG](skew-desk-en-share.png) · [usable form](skew-desk-en-grant.png) |
| Phone light zh-TW | [PNG](skew-phone-zh-TW-code.png) | [PNG](skew-phone-zh-TW-share.png) · [usable form](skew-phone-zh-TW-grant.png) |

Run `scripts/manual/smoke/smoke-hub-continuation-3338.mts` with an owned `AGEND_HUB_RIG_ENV`, `REPO`, `PW_DIR`, `CHROME`, short owned `TMPDIR` and a CJK `FONTCONFIG_FILE`. Base only: `FIXTURE_HOST_APPROVAL=1`. Integrated check: use the separate merged scratch worktree without that flag and `INTEGRATED=1`. Test credentials, keys, cookie values and container state stay in ignored scratch files. Only PNGs are committed as browser evidence.

Final base browser: source `c648ab3e7e30ec2861e7d8a4a7521a8c03ca7040`, 33 checks, 16 before/current cases. Integrated source `ae36debad8a1b74e4b2140947489eb3bed66aa6c` (contains #3355 `c927eb1e`), 10 checks, no fixture host approvals. Full Settings Hub layout gate: 48 checks. The cached stylesheet preserves its old form spacing; the inputs and cancel action were exercised and remain usable.

Review P3: a tab retaining the old switcher dictionary lacks `hub.allowOnHub`. The new action falls back to that dictionary's original localized `Allow…` / `允許…`. EN/zh missing-key tests pin the fallback; removing it fails. Refreshed cached-shell PNGs retain old hub-strings.js as well and assert that translated label through real link navigation.
