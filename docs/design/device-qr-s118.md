# Add a device by QR — S-118 proposal

> **繁中摘要**：在真正的「設定 → 存取與安全」頁面，從「登入與新增裝置」卡片按「＋新增裝置」。電腦顯示短效、單次使用的 QR 圖碼；手機掃描後等待，原本那個電腦工作階段顯示手機資料及「允許這支手機登入」。允許後手機取得自己的普通登入狀態，不複製電腦的管理員身分確認、驗證器或授權。正常流程電腦按兩次，手機只需掃描／開啟網址。不能掃描時，保留 8 位「裝置登入碼」（`ABCD-EFGH`）作為替代方式。
>
> 需要先確認的範圍：main 尚無 alpha 的裝置登入碼服務，必須連同「新增的普通裝置不能登出原本的擁有者」伺服器保護一起帶入。現有 alpha 公開入口禁止裝置登入交換；建議新增**僅限現存、允許管理員登入的公開入口**的短效交換，逐次檢查入口仍有效，絕不因此開啟公開連結。沒有手機可開啟的入口時，明確顯示原因，不把 localhost 放進 QR。圖中是這個提案的畫面，還不是已實作的登入功能。

Status: design and pictures only. Parent M-2753 requires the user's signoff on this larger new screen before implementation. Base: main `170d0a60dbb256bf15dc5c76335ae147b1ac1e61`. No production source changes.

## Screens

[PNG index](../screenshots/device-qr-s118/README.md). These use the real main Settings shell (both desktop navigation columns), shared Dialog and actual sign-in card. Only the proposed card/dialog/request state is mocked. The pictured address is an example, not a created public endpoint.

## User journey

1. On an eligible signed-in computer, open **Settings → Access & security → Sign-in and add a device**. Choose **＋新增裝置**. The server selects a trusted, currently usable destination; the browser never supplies an arbitrary return or target origin.
2. A shared Dialog displays a scannable QR, its readable hostname, **5 minutes** remaining and **Cancel**. The QR is an invitation to request sign-in, not a login credential. No extra Continue button.
3. The phone camera opens the actual sign-in page. An inert GET does not bind or approve anything. The page automatically makes a same-origin POST to bind that invitation to this phone's private polling proof. It clears the invitation from browser history. The phone shows **等待電腦允許**.
4. The **same computer session** displays **允許這支手機登入**, browser/OS, connection class and the deadline. **Allow** or **Deny** settles it directly, without a second confirmation card. Browser/OS are hints derived by the server, not a verified physical-device identity.
5. The approved phone completes its own one-time exchange and opens the dashboard. It gets a new ordinary device session, with no copied `host`, `owner`, TOTP proof or web authorization. The overview refreshes its device list.

Normal human actions: computer **Add + Allow = 2 clicks**; phone **scan/open = 1 action**, with no typed address or code. Camera/OS navigation is outside the page's click count.

Fallback: **使用裝置登入碼** opens the current phone-first code path: the phone displays its code; the computer enters it, sees the device and allows/denies it. Use **裝置登入碼**, reserving **驗證碼** for the authenticator. The current format is eight **base32 characters**, not eight decimal digits; retain its entropy and limits. Once selected on the computer, that request is bound to the selecting session too.

## Authority and integration seams

- The start action uses a server-derived `mayAddDevices` capability, not `tier === admin` or a loopback address alone. Preserve the existing eligible owner/operator boundary. Guests, read sessions, header tokens and device-created non-owner sessions cannot create or approve invitations. Do not widen this to every chat admin implicitly.
- The new QR action starts on the local dashboard, per the agreed S-120 seam. Existing alpha remote-owner manual approval is not removed. Supporting a broader initiating audience would be a separate explicit change.
- S-120 owns `section.card.s-access-devices#access-devices` and its device list. It calls the lazy `/ui/js/device-enrollment.js` export `openAddDevice({ onDone })`; completion calls `onDone()` to refresh the list. There is no new Settings section. Missing module/export under SKEW means no action is offered.
- S-117 owns existing sign-in recovery and glossary keys. New QR words live in `device-enrollment-strings.js` (EN/zh-TW). Use **登入與新增裝置**, **＋新增裝置**, **裝置登入碼**, **允許這支手機登入**. Do not rename unrelated browser-authority controls here.
- The UI uses shared Dialog, `.card`, `.field`, `.btn`, ErrorState/Skeleton and existing tokens. No inline styles. Phone controls meet `--tap`. Poll privately only while visible; do not add an EventSource or break the one-stream-per-tab contract.

## Reachable destinations and public links

The server must select an origin from trusted fleet configuration or the current exposure record. Host/X-Forwarded-* headers and a typed browser URL cannot nominate it. A hostname allowlist does not prove reachability. Require HTTPS for a phone destination. Never encode `127.0.0.1`, localhost, an unencrypted LAN endpoint or a link that the phone cannot use.

**Proposed public lane for approval:** allow only a dedicated enrollment landing/bind/poll/finish surface on an already-active dashboard exposure that admits admin sign-in. A view/share/guest-only link is insufficient. Bind the invitation, phone proof and resulting session to exact origin, exposure ID and generation; cap all deadlines by the exposure's deadline. Closing/replacing it, changing its policy or losing its owner stops the exchange. Gateway provenance comes from the listener's immutable context, never request headers. The resulting phone session remains on that gateway surface; it cannot become a local-dashboard credential.

This is a new, narrow manifest/handler allowance: alpha currently rejects `/auth/device-login*` on the public gateway. Do not casually expose those existing routes. Use the new enrollment protocol with explicit gates and negative tests; no unrestricted creation endpoint on a public page.

The QR flow **never enables a public link**, creates a tunnel or accepts a new TLS identity. When no usable origin exists, show the no-entry state and an in-page action to S-120's entry-point card. Main currently lacks alpha's host-owned web-only tunnel path; first-party public-entry setup for that case is a dependency to settle before promising phone access there. An already reachable trusted private/reverse-proxy origin can work without that import. Do not replace this limitation with host-command instructions.

## Request and security model

Use one request object across the journey, with an immutable five-minute outer deadline:

`offered → phone_bound → approved → delivering → complete`

`denied / expired / cancelled` are terminal. A new request gets fresh identifiers; polling or approval never extends the deadline. At most one open offer per initiating session; generating another retires the old one. Retain bounded terminal tombstones until the original deadline so replay gets a settled result, rather than restarting an exchange.

Bind the record to:

- fleet/token epoch and exact initiating session handle plus current owner-authority epoch;
- canonical destination origin, surface and optional exposure ID/generation;
- a random 256-bit invitation secret (only its hash retained);
- a separate 256-bit phone proof created at binding, kept in a narrowly scoped HttpOnly, SameSite cookie; and the request's unchanged expiry.

The QR contains only a short-lived invitation locator/claim secret, preferably in a fragment to avoid request logs and referrers. A copied QR cannot approve or log in; it can at most request a phone binding. A first binding consumes the invitation. Unexpected or conflicting claims must not silently replace the displayed phone. Device names/UA/IP are untrusted presentation hints; show plain guidance to deny an unexpected request. Someone who copies a QR may cause a nuisance request or denial of service, so there are strict quotas, expiry and regeneration; do not claim physical-device attestation.

Owner operations require cookie authentication, CSRF and mandatory exact non-null Origin, then fresh session/authority/request checks **after each await, even on a local request**. Request A is visible and decidable only by its exact initiating session: another tab in that session can reflect the state, but another session (even another owner session) cannot approve it. Signing that session out or revoking its authority invalidates unfinished requests. Header-token access never substitutes for the cookie.

Phone binding/claim uses an isolated pre-auth nonce/proof and same-origin POSTs. It has no ambient owner authority. Enforce the same origin/surface/exposure and live owner/request fences at binding, approval and final issuance. Avoid leaking request presence through unauthenticated lookup/guessing errors. Rate-limit using trusted socket/gateway provenance, not client headers; carry the existing bounded request and code-guessing limits.

Create a **pending** fresh phone session before cookie delivery; only the same phone proof may finish and activate that exact session. Finish is idempotent for that same delivery, never a second session creation. If the cookie was delivered but the finish response was lost, normal session checking can recover. If delivery cannot be recovered, settle as incomplete and offer a new QR; do not enroll again behind a retry button. Restart invalidates unfinished state and pending sessions. Cancellation before completion cannot leave an active device; cancellation after completion does not revoke a successfully added device silently.

Keep the existing public session expiry/idle caps. Only the intended QR contains its invitation locator/secret. The phone polling proof, session cookie and TOTP data never reach the computer or any URL. Device login codes appear only in their explicit fallback UI. Logs and analytics retain none of these secrets; published screenshots use inert samples only. Record successful add/deny/revoke notices using existing delivery policy; audit metadata includes request ID, source session handle, device session handle, origin class and outcome, never secrets.

## Main-first work and acceptance

Main has no alpha `DeviceLoginRequests`, approval UI, QR vendor asset or `via:device` display field. Port only the portable device-login primitives and the **server-side companion guard preventing a new non-owner device from signing the owner/other sessions out**. Do not import Runtime, Hub or the entire outside/TOTP feature. Reuse main's SessionStore, origin/CSRF, host-operator and pending-session mechanisms. Keep the alpha fallback's existing approved authority semantics in the twin.

Fail-first through real HTTP/cookie boundaries:

1. One QR binds one phone; second bind/replay/cross-phone finish never signs in or creates another session.
2. Five-minute expiry at every transition and during held awaits; approval does not refresh time.
3. Allow creates one ordinary session; deny/cancel/restart/failed delivery creates no active session.
4. Another session, guest/read/header token, forged Host/Origin/CSRF or stale owner cannot inspect/approve it.
5. QR-created sessions cannot approve devices, inherit web authority/TOTP or terminate the owner/other sessions.
6. Wrong origin/exposure, guest/read-only public entry, expired/replaced/closed public link all refuse; private and gateway cookies never cross surfaces.
7. Late bind/poll/allow responses after cancellation or a newer request cannot replace the current request or cookie.
8. Code fallback retains eight-character entropy, limits, expiry and final approval; selected fallback binds the selecting session.

Real browser acceptance covers desktop/phone EN/zh-TW, light/dark, real QR decoding, camera-equivalent navigation, independent computer/phone sessions, allow/deny/expired/unreachable paths, CSP, keyboard focus, 44px targets and old-shell/CSS SKEW. Mutation reversals cover the session, origin, expiry, consume, exposure and non-owner-revoke fences. Pictures are PNGs, not CI artifact links.

Estimate after design/scope confirmation: **2–3 developer days** for the portable core/companion guard, origin-bound exchange and UI/negative browser matrix; **about half a day** for alpha adaptation and parity/compatibility checks, excluding review/CI queue time. Main's web-only public-entry dependency could add work if included here; resolve that boundary before implementation.

## Source notes

Read-only comparison against main above and alpha's merged M-2746 tree:

- `src/auth-api.ts`, `src/web-session.ts`, `src/web-auth.ts`, `src/web-continuation.ts`, `src/public-web-gateway.ts`, `src/web-request-context.ts`.
- Alpha `src/web-device-login.ts`, `src/ui/settings-devices.js`, `src/ui/shared/signin.js`; `FleetManager.deviceApprovalOwner`, `webDeviceLoginAct` and `mayEndOtherSessions`.
- Current alpha QR runs in the opposite direction (new phone generates a code; QR opens approval on another device). It does not bind approval to the initiating session. This proposal needs new state, not a new picture over that protocol.

Rollback: the current branch contains proposal documents/capture code/PNGs only. No server, configuration, schema or authentication behavior has changed.
