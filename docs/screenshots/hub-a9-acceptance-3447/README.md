> **中文摘要：** alpha.9 驗收已完成。最終候選 **923ccf98** 的 Preview 儲存／Hub 啟停在桌機與手機均通過，#3451 已修復；本輪沒有未回報或未解決的 P1/P2。另有三項 P3 文字／狀態提示問題：#3453、#3457、#3458。完整操作於 64dede51 執行，923ccf98 另做修正範圍重測，沒有把前一版的結果冒充成全項重跑。

Parent #3322; previous #3395; assignment M-2706 / `cid-a9-acceptance`.

## Builds and verdict

- Initial full stories: **64dede5189d4d0b11c578c80d2f6d6d36a863ff7**. Initial P2 #3451 reproduced on both screen sizes.
- Replacement/final candidate: **923ccf98bb70be7ebbb6c8ae639a0a1b15e07dd8**, after #3452. Independently verified [post-merge CI success](https://github.com/songsid/AgEnD/actions/runs/42490721172). Coordinator's 24/24 is the checks total; Actions API lists 19 workflow jobs, all success.
- [Evidence index, PNGs, raw receipts and replay segments](./README.md). Chrome **156.0.8078.4**, desktop1366×900 and phone390×844; primary journeys zh-TW. Actual browser screenshots were reviewed separately for readability/overflow.
- **No unresolved P1/P2.** Fixed P2: #3451. Remaining P3: #3453 (publication hint), #3457 (stopped/running and mixed-language copy), #3458 (room capability after refusal). This is an acceptance report, not release authority.

## Full story table — 64dede51

All browser actions below use real product routes and views, not replacement HTTP answers. “Mock” refers to dummy directory facts or the stated agent boundary.

| ID | Surface / actual steps | Result | Evidence / finding |
|---|---|---|---|
| A9-01 | Open Hub signed out, sign in with dummy AD identity, then explicitly log out; desktop and phone | ✅ Sign-in shown; private view retired after logout | [Desktop](./base/A9-01-desk-logged-out.png), [phone](./base/A9-01-phone-logged-out.png) |
| A9-02 | Navigate Chats, shared Agents, Administration and Notices on both sizes | ✅ One h1/page, one-line brand and usable nav; no horizontal overflow | [Desktop](./base/A9-02-desk-admin.png), [phone](./base/A9-02-phone-admin.png) |
| A9-03 | Generate real join/revoke notices; inspect other pages then Notices | ✅ Retained notice on Notices; no embedded notices on other pages | [Notices](./base/A9-03-desk-notices.png), [phone](./base/A9-02-phone-notices.png) |
| A9-04 | Phone drawer open, settle, close; open session menu | ✅ Controls reachable, drawer dismisses, no clipping | [Drawer](./base/A9-04-phone-drawer-settled.png), [closed](./base/A9-04-phone-drawer-closed.png), [menu](./base/A9-04-phone-session-menu.png) |
| A9-05 | Exact fleet Revoke → cancel, then confirm for phone fleet | ✅ Cancel keeps Online; confirmed exact target revoked; other fleet stays Online | [Desktop confirm](./base/A9-05-desk-revoke-confirm.png), [phone](./base/A9-05-phone-revoked.png) |
| A9-06 | Fresh Hub → inspect default; admin enables Company sign-in joining once | ✅ Default off; saved on visible on both pages | [Default](./base/A9-06-desk-default-off.png), [phone on](./base/A9-06-phone-enabled.png) |
| A9-07 | Admin resolves department DN, checks three permissions/max8, previews and saves | ✅ Group rule saved through UI, separate from feature flag | [Preview](./base/A9-07-desk-policy-preview.png), [saved](./base/A9-07-desk-policy-saved.png) |
| A9-08 | Eligible person follows company link from owned Fleet; Start, then Hub sign-in | ✅ **Two submissions** to saved pin/Online on each size; no code/fingerprint/admin loop; no automatic publication | [Desktop](./base/A9-08-desk-connected.png), [phone](./base/A9-08-phone-connected.png) |
| A9-09 | Outsider uses same join entry and signs in | ✅ Refused on both sizes; no fleet binding/credential | [Desktop](./base/A9-09-desk-outsider-refused.png), [phone](./base/A9-09-phone-outsider-refused.png) |
| A9-10 | Desktop typed/raw Hub address on fresh Fleet, first-use Start | ✅ Local host consent pins identity before AD credentials; no extra fingerprint loop. Phone company-link positive is A9-08, not a claimed second typed-address subcase | [First use](./base/A9-10-desk-first-use.png) |
| A9-11 | Cancel pending join; change descriptor identity while retaining old trust | ✅ Local stop before new AD/join request; no binding; shown at both widths | [Desktop](./base/A9-11-desk-identity-stopped.png), [phone](./base/A9-11-phone-identity-stopped.png) |
| A9-12 | This Hub rename → reload; inspect ID/key/version; clear → reload | ✅ Name changes durable; identity/info retained | [Renamed](./base/A9-12-desk-renamed.png), [phone clear/info](./base/A9-12-phone-cleared.png) |
| A9-13 | Host Fleet Settings → Hub preview switch/port → Save | ❌ Original 403 `admin_confirmation_required`; **resolved on final candidate below** | #3451; [desktop](./base/A9-13-desk-preview-refusal.png), [phone](./base/A9-13-phone-preview-refusal.png) |
| A9-14 | Host Run this Hub off → cancel; off → confirm | ❌ Cancel works; confirmed Stop originally403; **resolved below** | #3451; [desktop](./base/A9-14-desk-stop-refused.png), [phone](./base/A9-14-phone-stop-refused.png) |
| A9-15 | Real granted room, protocol-member answer, reload/reopen <10s; hold read capacity then recover | ✅ All8 desktop/phone×EN/zh×light/dark cases; reload200/history visible; genuine429 has busy/retry and recovers.32 checks | [Desktop reload](./reload/desk-light-zh-TW-reload-visible.png), [phone](./reload/phone-dark-zh-TW-reload-visible.png), [receipt](./receipts/reload.json) |
| A9-16 | UI rules → none/ask/full welcome; directory outage/HELD → Retry recovery | ✅ Actions reflect permission; unknown does not claim no-change or grant access | [None](./base/A9-16-phone-none.png), [ask](./base/A9-16-phone-ask-only.png), [full](./base/A9-16-phone-full.png), [HELD](./base/A9-16-desk-held.png) |
| A9-17 | Quick-pair exception path, both confirmations/fingerprint, pin/Connected; exact revoke and expiry control | ✅47 checks,16 PNGs; desktop-light/phone-dark zh. Expiry uses injected clock, not natural ten-minute waiting. Publication remains separate | [Local](./quick/current-desk-light-zh-TW-local-confirmation.png), [phone Connected](./quick/current-phone-dark-zh-TW-connected.png), [receipt](./receipts/quick.json) |
| A9-18 | Publish/owner grant in UI; normal question; complete group negative; restore membership; admin Resume; revoke grant while answer held | ✅403/no agent input after negative; no auto-resume after rejoin; explicit Resume restores answer. Held answer refused after exact grant revoke. ⚠️ P3 hints/capability copy | [Answer](./base/A9-18-phone-granted-answer.png), [Resume](./base/A9-18-desk-resumed-answer.png), [held answer](./base/A9-18-desk-held-answer-fenced.png); #3453/#3458 |
| A9-19 | All3 setup routes: D3 host versus nonhost/guest/forwarded/public/nonloopback peers | ✅ Host reaches invalid-body validation; all unauthorized cases401/403, setup state unchanged. Repeated on final candidate | [Initial receipt](./receipts/base.json), [final receipt](./receipts/delta.json) |

## Exact final-head delta — 923ccf98

Our real Hub host is **web-only, no General/chat card** (`instances:{}`). Its D3 owner applies at Save. We did not claim the chat-fleet D1 General-card confirmation leg. The joined member fleets are separate fixtures.

| Recheck | Desktop + phone result | Evidence |
|---|---|---|
| A9-13 preview on + chosen port → Save → reload → preview off | ✅ Eight actual PUT responses across both lifecycle cases are202, no403. Port persists after reload; actual preview TCP listener opens, then closes when disabled | [Desktop saved](./delta/DELTA-A9-13-desk-preview-saved.png), [phone off](./delta/DELTA-A9-13-phone-preview-off.png) |
| A9-14 Stop cancel → Stop confirm → Start | ✅ Cancel keeps running; saved false closes actual Hub listener; saved true reopens it with same Hub identity | [Phone confirm](./delta/DELTA-A9-14-phone-stop-confirm.png), [stopped](./delta/DELTA-A9-14-phone-stopped.png), [restart](./delta/DELTA-A9-14-phone-restarted.png) |
| Shell quick regression, real dummy AD admin sign-in | ✅ Welcome/Admin/Notices, desktop + phone: one title, no horizontal overflow | [Desktop](./delta/DELTA-shell-desk-admin.png), [phone](./delta/DELTA-shell-phone-notices.png) |
| A9-19 security repeat | ✅ All3 routes: D3 GET200/invalid POST400; ordinary signed-in nonhost admin403; synthetic guest401; forwarded/tunnel headers403; wrong public Host403; bound gateway host-cookie replay401; actual assigned nonloopback TCP source403. Config/init/identity/key/cert/drafts unchanged | [Receipt](./receipts/delta.json) |

Screenshots show **“Hub 正在啟動。”**, not a readiness claim; the separate TCP check and retained identity establish that the listener reopened. #3457 records the visible off-state label/English detail, not failure of these checks.

The full diff64→923 has seven files: two manual helpers, one new test, four production files (`locale.ts`, `settings-effect.ts`, `settings-hub-preview.js`, `settings-hub-run.js`). The Settings gate addition is scoped to the two new PUT paths. The Hub shell/company/group/quick/room product paths exercised in the full run are byte-identical; their full stories are **carried with this explicit limit**, not labeled as rerun on923. Source diff and hashes are in the evidence index.

## Scope, fixture corrections and cleanup

Real sealed Hub, FleetManager/HubRuntime/settings writer, actual HTTPS/WSS/session/grant/journal/lease paths and production LDAP driver over a synthetic TLS/BER AD peer. Dummy initial admin/directory facts/certificates are setup only. Policy, enable, join, rename, clear, publication, grant, revoke and Resume use product UI. Main rig's model boundary checks `beforeInput` and incarnation before inert replies; reload/quick rigs use the disclosed protocol-member boundary. No real account, AD, model vendor, native/Windows/tmux, pilot or live fleet.

Setup sanity is access control only: invalid host bodies deliberately reach400; it does **not** claim a functional initialization prepare/test/commit. Guest is a fixture session (first refusal guest_scope_empty, later expired); gateway uses the production bound request context on an owned forwarding listener. Nonloopback source is an actual assigned local TCP source, not an external machine or a real tunnel. No OS trust/network settings changed.

Raw fixture failures remain in receipts: wrong guessed URL/selector, early async checkbox read, one mock caller-current bound past its valid delivery lifetime, old smoke expecting embedded notices, and final start-toast locator expecting the wrong wording. Corrected fixtures reran the actual paths; no product fence, timeout, or API reply was changed. Initial missing-font screenshots are excluded. No blanket “all raw commands pass” claim.

Both persistent campaigns awaited shutdown and independently checked **zero live owned PIDs**, all owned roots removed and all recorded listener ports reusable (base107 PIDs/9ports; delta31 PIDs/4ports). Reload receipt confirms browser/HTTPS/rig/key cleanup; quick harness closes resources in finally. No running acceptance rigs remain. [Base cleanup](./receipts/base-cleanup.json), [delta cleanup](./receipts/delta-cleanup.json).
