# S-118: one box for authenticator and device sign-in codes

繁中摘要：最新使用者指示取代「改用裝置登入碼」切換。只有一個輸入框，接受 6 位數驗證碼或 8 字元裝置登入碼；完整輸入後自動送出，仍保留可見的「登入」按鈕。備援提示固定一行「也可以貼上 8 字元裝置登入碼」。本次只更新 PNG；須等使用者核准、junsion 核心 PR 合併及 Leader GO 才實作。另有字元集造成的逐字輸入歧義，見下文，實作前須確認處理規則。

## Current UI

- One empty input, text keyboard and autocomplete=one-time-code. No name/account field, Settings name row, mode selector or fallback switch. The text keyboard can type the device-code alphabet; do not force a numeric-only keyboard.
- Primary label: 驗證碼或裝置登入碼. The introduction explains automatic sign-in using the authenticator app's six-digit code. The one-line helper is exactly 也可以貼上 8 字元裝置登入碼.
- Keep a visible Sign in button for accessibility, form submission and an explicit retry. The input handler and form button must share the same validator and in-flight fence. The PNGs do not implement either handler.
- Shown wrong-code PNGs are specifically the POST /auth/totp 401 case: check the newest authenticator-app code and its device's clock. Device-code /auth/login refusals must retain their existing used/expired/unconfirmed guidance, not the authenticator-clock message; add a distinct route-specific regression when building. Additional text is now neutral: 若驗證碼正確仍無法登入，請貼上 8 字元裝置登入碼，或使用先前登入過的裝置. No lockout claim or account inference.
- 429: plain waiting words, duration once, actual core retryAfterMs/Retry-After rather than the five-minute illustration. A paused form sends nothing; expiry does not automatically replay a failed value.
- Next-code: neutral waiting text, no admin name or match count. The exact HTTP answer remains Junsion's core contract, not an invented enum/status/countdown. The disabled button uses existing text/background tokens (--text-2, --surface-2), without fading its text through opacity. Resolved contrast is5.57:1 in light and5.49:1 in dark. No dedicated disabled colour token exists in the captured tokens.css.
- Reach help stays three short choices: same Wi-Fi local address, a shared private network (e.g. Tailscale), or an admin-provided outside address. No bare localhost/Tailnet jargon or automatically opened link.

## Confirmed alphabet and routes

Read from the owned #3548-source checkout:

- src/auth/one-time-code.ts: CODE_ALPHABET is `ABCDEFGHIJKLMNOPQRSTUVWXYZ234567`; ONE_TIME_CODE_LENGTH is8. formatOneTimeCode displays4+dash+4. normalizeOneTimeCode uppercases and strips non-ASCII alphanumerics, including the presentation dash. WebLoginCodes uses generateOneTimeCode.
- src/ui/shared/signin.js and src/auth-api.ts: an existing web/device sign-in code is redeemed via POST /auth/login `{code}`. POST /auth/device-login creates an approval request; it is not the endpoint for this box's already-issued code.
- Six ASCII digits go only to POST /auth/totp `{code}`. A full eight-character alphabet-valid device code, with or without its middle dash and in any case, goes only to POST /auth/login. Never try both routes after a failure.
- UI validation must reject partial/invalid values before any request. Support the specified dash/case formatting; do not use the core's permissive stripping to turn arbitrary punctuation into an apparently complete input. No core route, alphabet or matching change belongs to S-118.

### Real incremental-input ambiguity — needs a rule before implementation

Full six-digit and eight-character values are disjoint by length. The alphabet is not letters-only: it contains2–7. Therefore a legal eight-character code can start with six digits, or even contain eight digits. For example, the synthetic alphabet-valid `234567AB` has prefix `234567`, which is also a complete TOTP-shaped value.

A handler cannot know at the sixth digit whether the person has finished a TOTP or paused halfway through typing a device code. A short quiet-input debounce covers ordinary continuous typing but cannot prove “never send a partial device code” across an arbitrary pause. Aborting a request after character7 does not undo a server attempt. The proposal does not hide this limitation or silently alter the core alphabet.

Before implementation, confirm whether a short quiet-input delay with this residual ambiguity is acceptable, or whether ambiguous numeric prefixes need an explicit submit exception / a separately authorized code-generation constraint. Those alternatives affect the user's automatic-submit promise or the UI-only scope. The PNGs remain useful independently of that choice.

## Planned auto-submit fences (not implemented in this design branch)

- Validate the entire raw value before dispatch. Normalize only accepted formatting, then key attempts by route+canonical value; dash/case-only changes are the same value.
- An auto-attempt is recorded synchronously before awaiting the request. A per-page set prevents A→B→A, rerender, focus/blur or error recovery from repeatedly auto-submitting A. Failed auto-submit does not loop. An explicit Sign in click can be a deliberate retry, still respecting pause/in-flight rules.
- No composition/partial/invalid input, active request, paused state or timer completion dispatches a request. Re-evaluate current input and generation after asynchronous work; an older response cannot settle a newer input's view.
- Keep all server CSRF, session, matching, replay, rate-limit and notices policy unchanged. The code-only matching follow-up is owned by Junsion; S-118 only consumes the merged interface. The input-prefix question above remains a separate pre-build decision.

## Copy, scope and PNG evidence

Keep whole Chinese terms, including 每組／立即／直接／核准 where present. Use 驗證器 App and 8 字元裝置登入碼 consistently. In the eventual implementation PR, align the existing 8 碼 wording in settings-devices.js52 and settings-access-strings.js26 to8字元 as requested; there is no product source edit in this PNG revision. Keep the phone Settings banner/toggle summary goal of at most two lines when that copy is implemented. Devices overview remains outside scope.

20 real-Chrome captures: EN/zh ×1366×900 desktop light/390×844 phone dark × primary/wrong/paused/next-code/reach. The six requested zh primary/wrong/paused files retain their names. Prior fallback-mode and Settings-name images are removed from the current gallery and remain only in git history.

The generator serves actual #3548 signin.html/theme/tokens/loading/signin.js with a presentation-only DOM projection and self stylesheet. Every POST is refused, so these images do not demonstrate automatic submission, authentication, security, SKEW or release acceptance. No real account, fleet, CLI, tunnel or matching operation runs. receipt.json pins the source boundary, browser and geometry; SHA256SUMS pins originals. No authored src delta.

```sh
PW_DIR="$PWD/node_modules" CHROME=/path/to/owned/chrome \
  FONTCONFIG_FILE=/path/to/owned/fonts.conf \
  systemd-run --user --scope -q -p MemoryMax=3G -- \
  node scripts/manual/mockup-authenticator-signin-s118.mjs
```
