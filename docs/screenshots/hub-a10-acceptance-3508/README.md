# alpha.10 hands-on acceptance — #3508

繁中摘要：在固定候選 `da70c790` 上，以真實 Hub／Fleet 網頁及 Chrome、合成 LDAPS 目錄完成主要驗收。未發現 P1/P2。記錄兩項 P3 文案問題：確認卡的英文摘要，以及 Stop 對「登出」的描述和重新 Run 後保留工作階段的行為不符。兩項額外故障注入未宣稱通過。沒有真實 AD、帳號、Windows、pilot 或 live fleet；清理紀錄附後。本報告不是發布授權。

- **Product source:** `da70c790f774b1f6b0d32559aa70065f7e8485d3`, frozen `release/2.3.5-alpha`; [candidate CI](https://github.com/songsid/AgEnD/actions/runs/42591416887) completed successfully.
- **Build:** ordinary `npm run build` after an acceptance-only package version stamp `2.3.5-alpha.10-a10.acceptance.0`. `receipts/build-provenance.json` reports the exact SHA, alpha line and `modified:false`. No product logic changed. This local version was not published/tagged.
- **Browser:** real Chromium `156.0.8078.4`. Primary desktop1366×900/light/zh-TW and phone390×844/dark/zh-TW. Room-reload additionally ran all8 size/theme/language cells.
- **Isolation:** fresh HOME/AGEND_HOME, `unshare -Urn`, only namespace loopback enabled, dummy accounts, generated TLS/BER AD peers and real production LDAP driver. No external routes or vendor requests. Machine LDAPS/Hub pin checks remained enabled; browser certificate exceptions were rendering-only. Agent/CLI/native lifecycle methods refused execution.

## Story table

✅ means the stated scoped path ran; ⚠️ names a coverage limit, not a hidden pass. File links are evidence directories; receipts and exact archived commands carry the detailed assertions.

| ID | Surface and actual steps | Result | Evidence / limit |
|---|---|---|---|
| A10-01 | Ordinary browser → Settings/Hub → company Start → exact local-confirmation card; host UI sets up scratch authenticator; ordinary browser confirms its own request → real dummy AD login → Connected | ✅ | [main](main/), commands12–13. Ordinary full approval ran on desktop; phone waiting/confirmation/exit was independently exercised in [join-wait](join-wait/); phone D3 full joining ran separately. No internal approval method substituted. |
| A10-02 | Pending request → direct review → browser timeout → inspect/exit → exact Withdraw | ⚠️ | [join-wait](join-wait/),19 checks/two primary cells. Browser clock advances only the local display; server still said pending until withdrawal. A cancelled **terminal operation A → new pending B** discovery fault was not separately injected in this browser run. |
| A10-03 | Admin signs in at domain-root base; group DN → resolve → preview → Save; eligible member joins | ✅ | [main](main/), commands1,6. Synthetic peer remained in `continuation` mode during actual LDAP searches. |
| A10-04 | Absent group under root references; outsider joins; membership outage → Retry | ✅ | Commands7,21,39. Absent exact-DN result was `not-found` with no new rule; outage was HELD and recovered through Retry. References alone never granted access. |
| A10-05 | Clean stamped candidate build → real Settings version/provenance on both sizes | ✅ | `A10-05-*`, command17, build receipt. TS-based rig's installed-path boundary supplied `readInstalledBuild(actual candidate dist)`; no forged metadata or response body. |
| A10-06 | Close old LDAPS peer before opening host Settings/AD | ✅ | [recovery-framed-desk](recovery-framed-desk/), [recovery-framed-phone](recovery-framed-phone/). Correctly framed AD form and successful local read while directory is down. |
| A10-07 | AD down → failed Test; Cancel trust and Stop once | ✅ | Same recovery receipts. Expected Test503 had no epoch effect; cancelling trust/Stop did not commit or stop the listener. |
| A10-08 | D3 Stop cancel → Stop confirm; cold AD form while Hub off | ✅ | Recovery receipts and `AD-down-*` PNGs. Actual listener off; Fleet Settings stayed reachable. |
| A10-09 | Hub off → replacement verified LDAPS → Test/trust/Save → reload | ✅ | Recovery receipts. Persisted directory change while enabled stayed false/listeners stayed off; identity/certificate retained. |
| A10-10 | Replacement AD down → Run; then available-directory sign-in regression | ✅ | Recovery receipt actual listener becomes ready with peer closed. Separate live synthetic-directory sign-ins/joins passed. Listener readiness is not claimed as AD health. |
| A10-11 | Host and configured Hub admin → actual AD editor → candidate endpoint → Save/readback | ✅ | [editor-notices](editor-notices/) two sizes × both surfaces. Hub's trusted-directory reauthentication and rotated session/CSRF follow-up read passed. |
| A10-12 | Candidate endpoint/CA → one trust dialog → readable fingerprints → cancel/confirm | ✅ | Editor and recovery galleries: no early epoch, same shown/saved endpoint, phone actions reachable. |
| A10-13 | Anonymous CA fetch refused → explicit pinned service-only fetch → same dialog → confirm | ✅ | Both recovery galleries. Bind-kind controls and derived CA match; no OS trust-store change. |
| A10-14 | Nonhost admin/guest/forwarded/tunnel/public-host prepare/test/save requests | ⚠️ | Main command24:15 refusals, fleet config hash unchanged. Interrupted-save response and stale-source UI fault injection were **not run**; no non-loopback TCP source was assigned. |
| A10-15 | Actual AD Save generates notice → D3 private Needs-you ACK → person's Hub Notices ACK → reload | ✅ | Editor-notices receipts/PNGs: host ACK leaves person queued; both delivered durably afterward. No directory values/passwords in notice text. |
| A10-16 | Fresh host Settings first setup → addresses → directory/CA ACK → admin → Test/review → Create | ✅ | [setup-ca-visual](setup-ca-visual/). Entire first journey via UI, not preinitialized API state; identity sealed, real owned HTTPS mount verified, group policy never-enabled. |
| A10-17 | Signed-out page, each Hub nav, phone drawer/menu, explicit Sign out | ✅ | Main command17 and43; one h1/page, no horizontal overflow; explicit logout retires private page on both sizes. |
| A10-18 | Company switch default off → admin enable; two-click owner joins; outsider refusal; first-use raw address; changed identity; exact revoke cancel/confirm | ✅ | Main1,6,7,31,33,37–38. Changed identity issued no new Hub join request and no binding. Revocation left other Fleet online. |
| A10-19 | Rename/readback/clear; info; preview Save/TCP; Stop cancel/off/Run on | ✅ + P3 | Main15–20,40–43 plus independent [stop-session-control](stop-session-control/). Host is **web-only D3**, applies at Save. Real listeners changed. Stop's sign-out promise differs from retained-session behavior; explicit logout works. |
| A10-20 | Owner UI grant → ordinary asker → real room delivery → mock-model boundary → real report/answer → reload | ✅ | Main34:answer delivered; reload≈4.5s. [room-reload-full](room-reload-full/)8 cells:200 on ordinary reload/reopen; genuine held-capacity429+Retry-After10 recovered. |
| A10-21 | none/ask/full welcome; outage HELD/Retry; owner group removal → refused room; membership restoration alone stays held; explicit Resume → Check access → answer | ✅ | Main21,25,34–36. No refused input reached mock; exact owner grant required. |
| A10-22 | Web Update banner → Cancel → Confirm → progress → controlled failure/log → changed-version reload prompt | ✅, launch stub | [web-update-web-update-2738](web-update-web-update-2738/)26 checks/two primary cells. Actual routes/UI; target lookup and `launchInstalledUpdate` boundary stubbed. **No npm install, update or service restart ran.** |
| A10-23 | Publication hint retires; neutral localized Run state; denied room holds Send/draft → Check access recovers | ✅, bounded doubles | [p3-state](p3-state/) plus actual main publication/policy-denial/recovery. P3 helper scripts publication replies/group permit; production session/room routes remain real. Main independently proves actual publication and group refusal/resume. |

## Evidence boundaries and first-run corrections

- The main legacy company/group fixture predated AD-editor composition and omitted its new directory-decision callback: its host editor read returned503. That was **not** counted as a product defect or a passing editor leg. The independent production-composition editor/recovery fixtures performed those real reads and saves.
- Older QA selectors used obsolete `/owner`/`/notices` URLs, text-input attributes absent from the DOM, old success text, or the unscoped cookie name. Each raw error remains in the sanitized command receipt. Corrected runs use current real nav/roles, actual readbacks and scoped cookies; no product/fence/timeout was changed.
- One initial Chrome launch failed before any page due to a long SingletonSocket path; the owned TMPDIR was shortened. One recovery aggregate rejected the **new intentional Test503**; the QA allow-list was corrected to exact CA-fetch403 plus one Test503. These are disclosed fixture corrections, not reruns of a hidden product assertion.
- An early phone CA screenshot had an incomplete blank region. A new run captured DOM geometry/styles and waited fonts/paint: the full fingerprint, explanation and ACK were visible. The fresh framed images are authoritative; no persistent CA rendering defect was established.
- The Update launch and P3 publication/permit doubles do not prove a real updater, native Windows, provider quota, signed-in model, Fleet pause or AD production deployment.

## Cleanup

Every short campaign exited0 and independently recorded zero live owned descendant PIDs with its short owned temp removed. The persistent main exec ended143 without completing the driver's `finally` receipt. An **independent post-exit audit** matched exact ART and owned TMPDIR argv, found zero owned processes, confirmed PID3513203 absent, then removed its namespace scratch roots and wrapper HOME roots. See [main-cleanup](receipts/main-cleanup.json), [post-exit inventory](receipts/main-post-exit-inventory.json), and the other [cleanup receipts](receipts/). No graceful-finally claim is made for that rig. Its private network namespace has no remaining owner processes. No host listeners/network/trust/tmux or live fleet were changed.

## Reproduction and privacy

`recipe/` archives QA adaptations and all43 main commands. Copy `driver.mts`/`rig.ts` back under `scripts/manual/a10-acceptance/`, the `accept-a10-*` files to their corresponding `scripts/manual/hub-directory-editor/` or `hub-web-setup/` directory, and use the frozen candidate + its dependencies. `run-rig.py` documents the sanitized namespace launcher; its original owned path layout is intentionally not a generic installer. Existing public smoke entry points remain at the candidate. This is a source/evidence archive, not a new product command.

Only synthetic screenshots and bounded receipts are public. Main command10's private scratch authenticator data is withheld; no cookies, private PEM keys, service secrets or real user screenshots are included. The accepted read-only 子 Agent build remains separate and was not started during this acceptance.
