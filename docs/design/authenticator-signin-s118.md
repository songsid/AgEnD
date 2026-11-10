# S-118: code-only authenticator sign-in proposal

繁中摘要：依使用者決策 a690be6b，登入只需驗證器 App 的 6 位數驗證碼。移除姓名欄與 Settings「你的登入名稱」列，保留「8 字元裝置登入碼」備援。401 不再提姓名；另有中性的「等待下一組驗證碼」提案狀態。這版只更新 PNG，須等使用者核准、junsion 核心 PR 合併及 Leader GO 才實作。

## Decision and core boundary

Decision a690be6b supersedes the name/account UI and earlier name guidance, including the rule that the UI must always supply an account on chat fleets. Both chat fleets and web-only fleets now show only the six-digit authenticator field. No new name row is added in Settings. The previous name-based mockups remain historical in commit95a496778; they are not the current proposal.

The real sign-in shell/assets are from merged #3548 (alpha d5e2a3c873da04a72de4def25c2e53db2889a381). Its existing API is not evidence that code-only matching is implemented. Junsion owns the core follow-up on #3486 (comment6760191119): fresh eligible admins, exactly-one-match sign-in, uniform no-match refusal, multiple-match waiting, replay/limits/notices and the tighter whole-sign-in ceiling. S-118 consumes the merged core only; it does not add matching, eligibility, credential storage or rate-limit policy.

The exact HTTP response for multiple matches is pending Junsion's PR/review. The next-code PNG is a visual proposal, not an invented status code, error enum, retry timer or account disclosure. No core implementation or live authentication is performed here.

## Proposed states

| State | UI |
| --- | --- |
| Primary | Empty six-digit authenticator input, one Sign in action, secondary 8-character device sign-in-code fallback. No account/name field on any fleet. |
| Success | Navigate to /ui after the core creates the session. |
| 401 wrong_code | Check the latest authenticator-app code and the clock on the authenticator device. If the code is right, sign-in may be limited temporarily; use an 8-character device sign-in code or a previously signed-in device. Never infer an account or policy reason. |
| 429 paused | Plain waiting words, with the duration once. Illustration: five minutes. A future consumer uses the actual core retryAfterMs/Retry-After, not this example, and never automatically resubmits a code. |
| Wait for next code | Neutral “Wait for the next code to appear in your authenticator app, then try again.” No admin names, match count, guessed HTTP status or fixed wait. Exact retry behavior is bound to the core answer before implementation. |
| Unavailable / network | Plain cannot-sign-in or cannot-reach message, in-place retry and existing fallback; no implied successful session. |
| Fallback | Existing single-use 8-character device sign-in-code form. Preserve chat/web-only capability gates and instructions. No Devices overview or QR flow is added. |
| Reachability | Three short choices: same Wi-Fi local address, the same private network (e.g. Tailscale), or an admin-provided outside address. No bare localhost/Tailnet jargon, tunnel opening, link creation or automatic navigation. |

## Copy and layout

- Use “8 字元裝置登入碼” consistently in new copy. Existing Settings wording “8 碼裝置登入碼” is separate: settings-devices.js52 and settings-access-strings.js26. It is not silently fixed in this design-only change.
- Short Chinese terms and 每組／立即／直接／核准 stay whole where used. No numeric placeholder suggests a pre-filled code. Previous-device wording is always 使用之前登入過的裝置. App references say 驗證器 App.
- Top alignment stays64px desktop and32px phone across states. Theme remains actual light on desktop and dark on phone. Settings has no new name row and needs no new screenshot in this revision. Carry the earlier build goal of at most two phone lines for banner/toggle summaries; underlying enforcement remains core-owned.
- Existing shell notes remain outside this card: phone 待處理 versus desktop 等你處理; English sidebar labels; narrow search/version clipping.

## PNG scope and reproduction

24 actual-Chrome captures: EN/zh-TW ×1366×900 desktop light/390×844 phone dark × primary/wrong/paused/next-code/reach/fallback. The six requested zh primary/wrong/paused files keep their names; the next-code frames are supplementary. There are no Settings-name captures in the current gallery.

The generator serves the actual signin.html, signin.js, theme/tokens/loading assets, plus a proposal-only self stylesheet and presentation-only DOM projection. Its static loopback listener refuses every POST; it contacts no real account, fleet, CLI or tunnel. The API is not mocked as successful. These are design images, not functional, security, SKEW or release acceptance.

```sh
PW_DIR="$PWD/node_modules" CHROME=/path/to/owned/chrome \
  FONTCONFIG_FILE=/path/to/owned/fonts.conf \
  systemd-run --user --scope -q -p MemoryMax=3G -- \
  node scripts/manual/mockup-authenticator-signin-s118.mjs
```

PNG paths: docs/screenshots/authenticator-signin-s118/. SHA256SUMS pins originals; receipt.json records the precommit base, pending-core boundary, browser and geometry, including zero name inputs. No authored production src delta. User PNG approval, Junsion core merge and explicit Leader GO are all required before implementation.
