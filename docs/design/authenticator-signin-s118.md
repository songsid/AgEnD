# S-118: authenticator-first sign-in proposal on #3548

繁中摘要：在真實登入頁加入「登入名稱」與「6 位數驗證碼（驗證器 App）」，以驗證器為主要入口，保留「改用裝置登入碼」。本版包含完整401提示、429白話等候、手機連線說明，以及真實 Settings → 存取與安全 → 擁有者驗證卡中的「你的登入名稱」。僅更新 PNG 提案；使用者核准前不實作產品 UI。#3548 已補齊先前缺少的核心介面，這次不改核心，也不納入尚未 upstream 的 Devices overview。

## Contract and authority

Base: alpha d5e2a3c873da04a72de4def25c2e53db2889a381, merged #3548. The previous proposal's missing-contract finding is resolved by that PR.

- POST /auth/totp sends same-origin JSON `{ account?, code }` with credentials same-origin and the browser's real Origin. Account is typed, not selected from an admin list. It uses autocomplete=username; code uses autocomplete=one-time-code and keeps the core's 32-character input bound so pasted spaces can reach its normalizer. The existing fallback keeps its 12-character display/input allowance for the eight-character code. Never enumerate names or try a code against several admins.
- Account is required on chat fleets, optional only on a web-only fleet. The existing sign-in shell's web-only bootstrap flag lets the consumer omit/hide the name there. These primary mockups show the chat-fleet case.
- Signed-in Settings reads only its own GET /ui/outside → signinName. Display it as “Your sign-in name / 你的登入名稱” in the existing Owner verification card, with a static selectable value; no list of other admins. A web-only fleet needs no name; null without an enrolled app shows setup guidance rather than inventing one.
- Keep #3548's cookies, limits, exact-admin session, notices, replay and final authority checks unchanged. The page does not read HttpOnly cookies, supply authority or change enrollment.

## Proposed states

| State | UI |
| --- | --- |
| Primary | Sign-in name, six-digit code, one Sign in action; secondary device-code fallback. Name hint points to the admin's own Settings card. |
| 200 | Navigate to /ui after the server sets the session. |
| 401 wrong_code | Same neutral failure for every reason: check name, latest app code and phone clock. Full additional hint: if the code is right, sign-in may be limited temporarily; use the 8-character device sign-in code or a previously signed-in device. Never infer unknown account, enrollment or admin status. |
| 429 paused | Plain words, e.g. “Please wait 5 minutes, then try again.” The Sign in button waits for retryAfterMs; fallback remains available. No automatic resubmit. Client countdown is presentation only; the server remains authoritative. |
| 404 | Plain unavailable-here note and the existing sign-in-code fallback; do not claim a policy reason or disclose which rule refused. |
| 503 / network | Could not sign in / cannot reach AgEnD, retry in place. No implied successful session. |
| Fallback | Existing 8-character device sign-in code form, returning to authenticator via one secondary action. Preserve existing chat versus web-only instructions and capability gates; no new Devices flow. |
| Reachability | Closed help disclosure: same Wi-Fi LAN address (localhost is only that computer), same tailnet, or an already enabled outside entry. No link creation, tunnel opening, URL discovery, or automatic navigation. |

The 401 hint is deliberately fuller than a generic “wrong code”: #3548 can answer401 even for a correct code while the admin ceiling is in force. The 429 illustration uses a synthetic 5-minute retryAfterMs; implementation must use the actual server duration/Retry-After fallback, not this fixed example.

## Real-shell PNGs

24 frames: zh-TW and EN  × 1366×900 desktop light  / 390×844 phone dark × primary, wrong, paused, reach, fallback, Settings name. Files: docs/screenshots/authenticator-signin-s118/. PNG hashes are in digest-first SHA256SUMS; receipt.json records the base, browser and geometry.

Sign-in frames render actual signin.html, signin.js, theme/tokens/loading assets plus presentation-only DOM projection and a proposal-only self stylesheet. Settings frames use an owned local 2.3.5-alpha.10+s118 build of the exact #3548 source archive (source-serving fixture, generated archive provenance d5e2a3c8), with the actual app.html/sidebar/second-level Settings navigation and existing Owner verification card; only a synthetic GET/ui/outside own-name projection and the proposed row are added. No Devices overview is added. Synthetic name alice_tg is an example, not a real account.

`scripts/manual/mockup-authenticator-signin-s118.mjs` refuses all sign-in POSTs. The Settings fixture uses a scratch HOME and its synthetic sign-in code only, with authenticator POST blocked. It never starts a fleet, CLI, tunnel, actual authenticator enrollment or live account operation. These images are proposal evidence, not production sign-in, security, SKEW or release acceptance.

```sh
SETTINGS_REPO=/path/to/owned/2.3.x-build-root PW_DIR="$PWD/node_modules" \
  CHROME=/path/to/owned/chrome FONTCONFIG_FILE=/path/to/owned/fonts.conf \
  systemd-run --user --scope -q -p MemoryMax=3G -- \
  npx tsx scripts/manual/mockup-authenticator-signin-s118.mjs
```

For the Settings fixture, archive #3548 source/scripts/templates/launcher/package/tsconfigs into an owned scratch build root, set only that copy's package version to 2.3.5-alpha.10+s118, reuse owned dependencies, and run the normal build. Copy its generated dist/build-provenance.json alongside the source-serving fixture module. The version is explicitly a local design build, not a published release. Source code is unchanged. SETTINGS_ONLY=1 can refresh only the four Settings images while retaining the20 already inspected sign-in images.

No authored production src delta. Build begins only after the user's approval of these PNGs. Consume #3548 as supplied; raise any newly discovered contract gap on #3548/#3486 instead of widening the core.
