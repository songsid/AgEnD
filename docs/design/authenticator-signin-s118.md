# S-118: one sign-in box

繁中：使用者已核准單一輸入框、800 毫秒規則與文案／對比修正。本 PR 只消費既有登入核心；合併前須等 Junsion 的 code-only 核心，平常 merge 同步後，以真實聊天艦隊路由驗收包含雙重符合的「下一組驗證碼」回應。暫時只完成 web-only 真實路由與 UI 證據，不代表聊天艦隊或雙重符合已通過。

## Input contract

One empty text input; no account field or Settings name row, no mode switch. Autocomplete is one-time-code. Keep a visible Sign in button for accessibility and explicit retry. The helper is 「也可以貼上 8 字元裝置登入碼」.

| Complete value/event | Action |
| --- | --- |
| Pasted six ASCII digits | POST /auth/totp with code only immediately. |
| Typed six digits containing 0, 1, 8 or 9 | The same, immediately. |
| Typed six digits made only of 2–7 | Wait 800 ms. Any further key cancels. Recheck current input, pause, generation and dedupe before dispatch. |
| Eight A–Z/2–7 characters, any case, optionally a middle 4–4 dash | POST /auth/login, uppercase and no dash. |
| Partial, invalid, composition, or a letter/dash candidate shorter than eight | No POST; never strip punctuation into a TOTP. |

The code alphabet is the existing one-time-code.ts alphabet; neither it nor either POST route changes. A pause longer than 800 ms while typing a digit-only device prefix can spend one wrong TOTP attempt. This accepted trade-off cannot be undone by aborting. Completing the device code remains eligible even if that prefix request is held or fails.

Auto-submit is once per distinct canonical route+value for the page, including A→B→A. Manual retry is explicit and cannot duplicate an in-flight attempt. Editing, leaving the form or page retires old requests; stale results after fetch or response-body awaits cannot navigate or repaint. A 429 blocks submissions for the server’s retryAfterMs (Retry-After fallback), then enables manual entry without replaying a value. The code-only core owns the neutral double-match answer shape; consume it after its merge, never infer accounts or counts.

## Presentation and compatibility

Use the existing signin.html shell, loading skeleton, theme and shared tokens; no app.css import. Keep states aligned at the top, input at least 16px and controls at least 44px. Hint/help/disabled text must meet 4.5:1 on actual backgrounds. Chinese uses whole terms and the approved 「即可自動登入」／「目前顯示的驗證碼」. TOTP wrong-code guidance refers to the authenticator and device clock; device-code errors retain used/expired recovery. Reach help describes Wi-Fi, a shared private network and an admin-provided outside address, without opening anything.

New JS tolerates cached HTML without the optional help/hint ids and repairs its old numeric field constraints. Old JS can still use the existing form ids on new HTML; new optional help stays hidden. Keep old assets available for held requests. The temporary /signin/authenticator GET uses the same shell, retaining its original method and availability fences. POST routes, matching, CSRF, replay, limits, session ownership, notices, authenticator storage and device approval are unchanged. Devices overview is out of scope. Only the requested existing 8 碼 → 8 字元 glossary alignment is included in Settings.

## Acceptance boundary

The PR remains HOLD until the core dependency merges, plain merge sync completes, and real code-only chat/double-match acceptance passes. See the committed screenshot receipt for exact source hashes and current web-only proof. Before/SKEW render exact base UI assets routed to an owned scratch listener, rather than claiming a separately running base daemon. No real account, live fleet, CLI, vendor, tunnel or native operation.
