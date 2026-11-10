# S-118 code-only PNG proposal

Current decision: a690be6b. No name field; no Settings「你的登入名稱」row. This replaces the name-based proposal at95a496778. Actual #3548 signin.html shell with design-only DOM/CSS projections; all POSTs refused. Code-only core and the exact next-code response are Junsion's pending work. User approval and Leader GO are still required before implementation.

| Language / screen | Primary | Wrong code | Paused | Wait for next code (proposal) | Reach help | 8-character fallback |
| --- | --- | --- | --- | --- | --- | --- |
| zh-TW / desk-light | [PNG](desk-light-zh-TW-primary.png) | [PNG](desk-light-zh-TW-wrong.png) | [PNG](desk-light-zh-TW-paused.png) | [PNG](desk-light-zh-TW-next-code.png) | [PNG](desk-light-zh-TW-reach.png) | [PNG](desk-light-zh-TW-fallback.png) |
| zh-TW / phone-dark | [PNG](phone-dark-zh-TW-primary.png) | [PNG](phone-dark-zh-TW-wrong.png) | [PNG](phone-dark-zh-TW-paused.png) | [PNG](phone-dark-zh-TW-next-code.png) | [PNG](phone-dark-zh-TW-reach.png) | [PNG](phone-dark-zh-TW-fallback.png) |
| en / desk-light | [PNG](desk-light-en-primary.png) | [PNG](desk-light-en-wrong.png) | [PNG](desk-light-en-paused.png) | [PNG](desk-light-en-next-code.png) | [PNG](desk-light-en-reach.png) | [PNG](desk-light-en-fallback.png) |
| en / phone-dark | [PNG](phone-dark-en-primary.png) | [PNG](phone-dark-en-wrong.png) | [PNG](phone-dark-en-paused.png) | [PNG](phone-dark-en-next-code.png) | [PNG](phone-dark-en-reach.png) | [PNG](phone-dark-en-fallback.png) |

All24 frames have overflow, common-top, empty-input, zero-name-input and44px control checks. The requested six zh-TW primary/wrong/paused originals and both next-code proposals receive a full-size visual review. SHA256SUMS pins each image; receipt.json records source/browser/geometry.

The five-minute pause illustrates a retryAfterMs, not a fixed product limit. Next-code has no asserted HTTP status, error enum, countdown or matching-account disclosure; its exact contract awaits core review. No authenticator request, real account, fleet, CLI, tunnel or Devices overview is used. These are PNG proposals, not sign-in/security/SKEW/release acceptance.

Consistent new fallback wording: 8 字元裝置登入碼. Existing Settings still has 8 碼裝置登入碼 at settings-devices.js52/settings-access-strings.js26; that older shell wording is separate. Other unchanged shell notes: bottom-tab 待處理 versus desktop 等你處理, English sidebar labels and narrow search/version clipping. The removed Settings-name images remain in git history only.

Reproduce: scripts/manual/mockup-authenticator-signin-s118.mjs using owned PW_DIR/CHROME/FONTCONFIG_FILE. See [design note](../../design/authenticator-signin-s118.md).
