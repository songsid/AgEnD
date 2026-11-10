# S-118: authenticator sign-in presentation proposal

繁中摘要：以實際 AgEnD 登入頁呈現「6 位數驗證碼（驗證器 App）」為主要入口，保留「改用裝置登入碼」。
「如何在手機開啟 AgEnD？」說明同 Wi-Fi、tailnet、管理員已開啟的外部入口；不開啟任何公開連結。
這批 PNG 是畫面提案，尚未實作登入功能。#3503 提供每位管理員的驗證器與變更確認，但沒有提供 LAN／聊天 Fleet
的新裝置「每位管理員驗證器登入」介面；必須先由其核心擁有者補上可接用的介面，或由 leader 縮小本卡範圍。

## Scope and visual proposal

- Based on alpha `b394feedc1ce7619a607b0fd114604c8bdd7ebdf` (#3503).
- Actual `src/ui/signin.html`, `shared/signin.js`, theme, loading stylesheet and tokens, rendered in Chromium.
- Primary: open the AgEnD address, enter the six-digit authenticator code, press Sign in.
- Secondary: **Use a device sign-in code / 改用裝置登入碼**. The existing eight-character code is a fallback, not another authentication mechanism.
- A closed help disclosure explains reaching the same fleet from a phone. Opening it never opens a tunnel or navigates to another service.
- Wrong-code copy asks for the newest code and a correct phone clock. Existing core expiry, replay and pause semantics must remain authoritative.
- No QR enrollment, device approval replacement, new administrator selector, or new authenticator storage/enforcement is proposed here.

The primary, reachability help, device-code fallback and wrong-code states are shown at 1366×900 light and 390×844 dark in zh-TW.
The primary is also shown in English at both sizes. The fallback shown is the existing chat-issued device-code entry; a future
consumer must preserve server capability gating for the web-only device-approval alternative and public-entry rules.

## Consumer seam missing from the landed core

The landed code deliberately retains the old sign-in boundary:

| Existing contract | Evidence at the base |
|---|---|
| Only a web-only fleet's designated outside entry renders the six-digit form | `src/auth-api.ts`, `serveSigninPage`; `src/ui/shared/signin.js`, `outside = webOnly && …` |
| `/auth/totp` requires gateway provenance; a direct LAN/tailnet request cannot use it | `src/auth-api.ts`, POST `/auth/totp` |
| The sign-in callback accepts only exposure ID and code, and verifies the host operator's authenticator | `src/fleet-manager.ts`, `outsideSignIn`; `src/web-remote-access.ts`, `verify(code, who = HOST_ADMIN_KEY)` |
| The resulting authorization is the host operator, not the owner of an arbitrary admin authenticator | `src/fleet-manager.ts`, `authorizeOutsideSession` |
| A chat fleet explicitly has per-change authenticator codes but no authenticator sign-in | `tests/settings-remote-confirm-122.test.ts`, “a chat fleet's authenticator is for per-change codes only” |

Changing only the form cannot complete the requested per-admin sign-in on a direct LAN/tailnet address or a chat fleet.
Calling the existing host-operator path for another admin would change authority. S-118 does not do that, and does not scan
or try all administrators' secrets. Its production source is unchanged.

**Decision needed before implementation:** have the #3503 owner expose the new-device per-admin sign-in consumer contract,
including how the new browser identifies the admin whose code it submits; or narrow S-118 to presentation of the existing
web-only outside-entry flow. The recommended path is to keep the requested UI and obtain the core-owned consumer contract.

## Evidence and reproduction

PNG files and `receipt.json`: `docs/screenshots/authenticator-signin-s118/`.

`scripts/manual/mockup-authenticator-signin-s118.mjs` serves the real static sign-in shell, then projects proposed presentation
into the DOM. It refuses every POST, never starts a fleet or CLI, and has no auth store or real accounts. Browser requests are
restricted to its owned loopback server. These are UI mockups, not successful sign-in, core security or SKEW acceptance.

```sh
PW_DIR="$PWD" CHROME=/path/to/owned/chrome FONTCONFIG_FILE=/path/to/owned/fonts.conf \
  systemd-run --user --scope -q -p MemoryMax=3G -- \
  node scripts/manual/mockup-authenticator-signin-s118.mjs
```

The capture checks horizontal overflow, the card's reachable top edge and visible button/disclosure height (44px minimum).
It uses the actual sign-in page rather than loading `app.css`, which has unrelated composer and full-height rules.
No production implementation or authentication changes are included in this design branch.
