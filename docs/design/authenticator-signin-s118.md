# S-118: one box for authenticator and device sign-in codes

繁中摘要：最新使用者指示取代「改用裝置登入碼」切換。只有一個輸入框，接受 6 位數驗證碼或 8 字元裝置登入碼；完整輸入後自動送出，仍保留可見的「登入」按鈕。備援提示固定一行「也可以貼上 8 字元裝置登入碼」。本次只更新 PNG；須等使用者核准、junsion 核心 PR 合併及 Leader GO 才實作。逐字輸入歧義已定案：只含2–7的6字元輸入等待約800ms，續打即取消；極少數提早送出的TOTP可計一次錯誤，續打完整8字元仍須提交裝置碼。不改字元集或核心。

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

### Accepted incremental-input rule

Full six-digit and eight-character values are disjoint by length. A legal device code can still start with six digits: the synthetic alphabet-valid `234567AB` has prefix `234567`, which is also TOTP-shaped. Leader's decision accepts the short wait and residual early attempt; no alphabet or core change is needed.

| Input event and entire current value | Auto-submit rule |
| --- | --- |
| Paste exactly six digits | Submit immediately to /auth/totp, including values made only of 2–7. |
| Paste eight base32 characters, optionally with the middle dash, in any case | Submit immediately to /auth/login after accepted-format normalization. |
| Type six digits containing any of 0, 1, 8 or 9 | Submit immediately to /auth/totp; these characters cannot be part of a device code. |
| Type exactly six characters made only of 2–7 | Wait about 800 ms; any further keystroke cancels the pending timer. Before dispatch, recheck current value, generation, validity, pause and prior-attempt state. |
| Current input contains a dash or letter | Device-code candidate only; never submit it to /auth/totp, including after formatting normalization. Submit only when the complete eight-character base32 format is valid. |
| Partial or invalid value | No automatic or manual network submission. |

A rare user pause longer than the 800 ms window may cause the six-digit prefix to reach /auth/totp before the rest of the device code is typed. That can consume one wrong attempt; this is explicitly accepted. Aborting the client request cannot undo that attempt. If the person then finishes a valid eight-character device code, it must still be submitted to /auth/login, subject to the unchanged server pause policy. The earlier TOTP attempt, its in-flight status or its failure must not silently discard the completed device-code attempt. This is submission of a new complete value, not automatic cross-route retry of the same failed value.

## Planned auto-submit fences (not implemented in this design branch)

- Validate the entire raw value before dispatch. A dash or letter selects device-code classification before normalization. Normalize only accepted formatting, then key attempts by route+canonical value; dash/case-only changes are the same value.
- Record an auto-attempt synchronously before awaiting its request. A per-page set prevents A→B→A, rerender, focus/blur or error recovery from repeatedly auto-submitting A. Failed auto-submit does not loop. An explicit Sign in click can deliberately retry a complete valid value, still respecting pause and same-attempt in-flight rules.
- Any further keystroke cancels the ambiguous-six-digit timer. Paste and explicit submit also retire it, so neither later fires a duplicate. Composition/partial/invalid input, paused state and expiry of a pause never dispatch a request. The 800 ms ambiguous-input timer is the specific allowed delayed dispatch, with final current-value checks.
- Keep distinct attempts and their presentation generations separate. A late response cannot settle a newer input's view; a same-attempt duplicate remains fenced. A valid completed device code remains eligible for its own dispatch after an accepted early prefix attempt, including while that prior attempt is unresolved.
- Keep all server CSRF, session, matching, replay, rate-limit and notices policy unchanged. The code-only matching/next-code response remains Junsion's core work; S-118 only consumes the merged interface. The input timing rule is now settled, while product implementation still waits for user approval, that core PR and Leader GO.

### Required fail-first cases when building

Use controlled timers and held route responses, not elapsed-time sleeps.

- Immediate routing: paste six digits; paste upper/lowercase eight-character codes with/without the dash; type six digits containing 0/1/8/9.
- Delayed routing: an all-2–7 six-digit value is unsent before 800 ms and submitted once at the deadline. Any further keystroke, paste or explicit submit cancels the old timer; its late callback cannot send a duplicate or stale value.
- Negative controls: letters/dashes never reach /auth/totp; partial/invalid values make no request; composition and paused state send nothing; pause expiry does not replay a value.
- Dedupe: a failed attempt, rerender or A→B→A never auto-loops; case/dash-only changes do not create a new device-code attempt.
- Early-attempt continuation: after the accepted prefix attempt, a complete device code submits exactly once despite a held or failed prior request. Preserve route-specific errors and presentation-generation fences.

None of these feature tests is claimed as run in this PNG/document-only branch.

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
