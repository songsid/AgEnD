# 網頁一體化與安全登入：設計與分階段計畫

狀態：**草案 v1，待 leader review，尚未經 Prism 安全 review。本文件不含任何 production code，review 通過前不動工。**

範圍：把 `/dashboard`（`/ui`）、`/view`、`/settings` 整合成一個以 session 登入的網頁，並讓它能透過 Cloudflare tunnel 從外網安全使用。

參考：`docs/design/setup-host-tunnel.zh-TW.md`（setup 宿主的 tunnel 信封，本文大量沿用其原則與 31 條信封）、`src/web-auth.ts`、`src/setup-auth.ts`、`src/view-api.ts`、`src/settings-api.ts`、`src/web-api.ts`、`src/tunnel/*`、`src/fleet-manager.ts`（health server）。

---

## 0. 結論先行

1. **登入**：一次性登入碼（8 字元、單次、5 分鐘、每碼 5 次嘗試）由受信通道（聊天 `/dashboard`、本機 `agend web`）簽發，網頁輸入後兌換成**伺服器端 session**，cookie 只是不透明的隨機 id。這直接複用 `setup-auth.ts` 已經過 review 的「短碼只是兌換鍵、cookie 由獨立的 256-bit secret 產生」模型，不另造一套。
2. **現行 cookie 不能直接拿去給外網用。** 它是 `sha256(web.token)`（`web-auth.ts:106`），所有裝置同值、伺服器不記得它、12 小時只是瀏覽器端的 `Max-Age`：被偷走的 cookie 在下一次 `web-token rotate` 之前永遠有效，也無法只登出一台裝置。所以 Phase 1 的核心是把 cookie 換成 server-side session，不只是「多一個登入頁」。
3. **`/view` 並不只是 metadata。** 公開的 `GET /api/pane/:instance` 回的是 **tmux 終端畫面原文**（`view-api.ts:233`），agent 螢幕上的程式碼、路徑、輸出都在裡面。加上現在**沒有 Host allowlist**，DNS rebinding 今天就能從使用者瀏覽器讀到它，跟 tunnel 無關。這比 `?token=` 洩漏更早要處理（§1.5 F1、F2），我建議拆成獨立的 Phase 0 先出。
4. **UI 一體化走「共用 shell + 各頁獨立」，不做 SPA。** 三個頁面共 3.5k 行 inline JS、三套視覺、無 build 步驟；SPA 重寫的風險與成本遠大於收益。
5. **Cloudflare 那條，先確認使用者要哪一種。** Quick Tunnel（`trycloudflare.com`）官方文件寫明**不支援 SSE**，而 dashboard 的即時更新靠 SSE（`/ui/events`）；且無 SLA、網址每次變。使用者真正想要的「一個穩定網址」多半是 **Named Tunnel**，這條用「手動接入（BYO）」模式就能支援，成本比 managed Quick Tunnel 更低。見 §6 與待決 D2。
6. **對外一定走獨立的 gateway listener**（延續 setup 宿主「埠就是 capability boundary」的結論），只放行 web UI 需要的路徑、只吃 session cookie。不把 tunnel 直接指向 health port（19280），因為那個埠上有 `/agent`、`/restart/*`、`X-Agend-Token` 這些不該過 tunnel 的東西。

需要使用者拍板的點在 §8（D1–D8），其中 **D2（用哪種 Cloudflare tunnel）** 會決定 Phase 3 的形狀，最好先問。

---

## 1. 現況（讀 code 的事實）

### 1.1 入口與路由

所有網頁與 API 都在同一個 HTTP server：`fleet-manager.ts:12483` 的 `healthServer`，`listen(port, "127.0.0.1")`（`:12821`、`:12829`），預設埠 19280。

| 入口 | 路徑 | 處理 | 現行認證 |
|---|---|---|---|
| Dashboard | `/ui`、`/ui/*`（含 SSE `/ui/events`、`/ui/send`、`/ui/instances`、`/ui/config`…） | `web-api.ts` | 全域 gate + `web-api.ts:207` 再驗一次 |
| Settings | `/settings`、`/api/settings/*`（含 `apply`、`restart-fleet`、`reload`、quickstart） | `settings-api.ts` | 全域 gate |
| View | `/view`、`/api/pane/*`、`/api/profiles`、`/api/profile/*`、`/api/avatar/*`、`/api/sort-order` | `view-api.ts` | **GET 全公開**；POST 要 web.token |
| 用量 | `/api/ai-usage` | `usage-api.ts` | 公開 GET |
| Fleet 控制 | `/status`、`/api/fleet`、`/api/activity`、`/api/instance/:n/start`、`/restart/:n`、`/stop/:n` | `fleet-manager.ts` | 全域 gate（Settings 頁會呼叫 `/stop/`、`/start`、`/api/fleet`，見 `settings.html:1096,1644`） |
| Agent CLI | `POST /agent` | `agent-endpoint.ts` | instance token（自己的一套） |
| 健康探測 | `GET /health` | | 公開（只回實例數量統計） |
| 瀏覽器終端 | `/t/<sid>/…` | `web-terminal-http.ts`，**每 session 獨立的 `127.0.0.1:0` listener** | 一次性 token → cookie（自己的一套） |

全域 gate 的豁免清單在 `fleet-manager.ts:12503-12513`：`/health`、`/agent`、`isViewPath`、`isUsagePath`。

### 1.2 認證機制現況

- **憑證**：`web.token`，48 hex（192 bits），`~/.agend/web.token`，0600；每次請求即時讀檔（所以 `agend web-token rotate` 不必重啟就生效）。`web-auth.ts` 是唯一的授權決策點 `decideWebGate()`：cookie → `X-Agend-Token` header → `?token=`（僅 GET，兌換成 cookie 後 302 拿掉）。
- **cookie**：`agend_session`，HttpOnly、SameSite=Strict、`Path=/`、Max-Age 12h、Secure 依 `X-Forwarded-Proto`（`web-auth.ts:176`，信任可偽造 header）。值是 `sha256("agend-web-session-v1:" + token)`，決定性。
- **Origin**：`isSameOriginRequest()`（`:158`）比 Origin==Host；**沒有 Origin 就放行**（`:160`）。沒有 Host allowlist。
- **`/view` 寫入**（`view-api.ts:214`）：`token === ctx.webToken`，token 來自 `?token=` 或 `X-Agend-Token`，用 `===` 比；**不吃 session cookie**。
- **`/dashboard`（聊天）**：`topic-commands.ts:389` 產出 `/view?token=<web.token>`、`/settings?token=…`、`/ui?token=…`，三條都包了 Telegram spoiler，但 `/settings`、`/ui` 會被 gate 兌換成 cookie 並拿掉網址列的 token；`/view` 不在 gate 內、不會兌換，所以 `/view?token=` 的 token 會**一直留在網址列**。
- **`agend web`**（`cli.ts:1726`）：把含 token 的網址寫成 0600 暫存 HTML 再用 `xdg-open` 開，用意是避開 `ps`。
- **`agend web-token rotate`**：改寫檔案，之後所有舊網址、header、cookie 立即失效。這是目前**唯一**的撤銷手段。

### 1.3 tunnel 現況（更正 `setup-host-tunnel` §1 的「實作狀態：零」）

那份文件寫於實作之前，現在已過時：

- **已實作**：`src/tunnel/{types,cloudflared,manager,lease}.ts`。`CloudflaredProvider`（Quick Tunnel）、嚴格 URL 驗證、無副作用 readiness、single-flight、confirmed-stop、lease + reaper、最小環境變數。
- **唯一消費者是 `agend setup --tunnel`**（`setup-host.ts:46-49,215`）。fleet 的 dashboard、Web Terminal 都**沒有**接 tunnel（Web Terminal 依 T4 刻意不接）。
- **只有 Quick Tunnel**。`TunnelVisibility` 型別已預留 `"tailnet" | "manual"`（`tunnel/types.ts:16`），但沒有 tailscale provider、沒有 named tunnel、沒有 manual 模式。
- **逐次風險確認**只存在於 `setup-tunnel-consent.ts`（CLI TTY 提問，文案只講 bot token）。fleet 有聊天通道，所以 sol 原設計的「聊天按鈕確認」在這裡是可行的，setup 宿主當時沒有。
- **Envelope 31 條中的第 31 條（fleet 側所有 `127.0.0.1:0` listener 做 Host allowlist）尚未落實**：`web-terminal-http.ts` 沒有 Host 檢查（grep 無結果）。gateway listener 之前要補。

所以 Phase 3 要新做的是：gateway listener、fleet 版的 tunnel 啟停與確認、manual/BYO 模式；provider 本體可直接用。

### 1.4 前端技術棧

- **無框架、無 build、無共用程式碼。** `src/ui/` 底下三個獨立 HTML：`dashboard.html`（772 行）、`settings.html`（1701 行）、`view.html`（1019 行），CSS/JS 全 inline，`postbuild` 直接 `cp -r src/ui dist/`。
- **三套視覺**：dashboard 深色玻璃感、view 是 GitHub 深色、settings 是白底。**各自一份 i18n 字典**、各自的 `api()` 包裝、各自處理 401。
- 更新機制：dashboard 用 SSE（`/ui/events`，10 秒心跳）；view 用輪詢（pane、profiles）。
- 只有 dashboard 載 Google Fonts CDN（`dashboard.html:8-9`）：每次開頁都對第三方發請求，也擋住日後嚴格 CSP。
- `web-api.ts:230` 有一個 `/ui/js/<name>.js` 的檔案路由，指向 `dist/ui/<name>.js`，但 `src/ui/` 底下**沒有任何 .js**。它是一個沒長完的「共用腳本」掛鉤，正好是 Phase 2 要的東西。
- 沒有 CSP、沒有 `X-Frame-Options`（dashboard 上有重啟 instance 的按鈕，現在可被 iframe，clickjacking）、認證回應沒有 `Cache-Control: no-store`（只有兌換用的 302 有）。

### 1.5 讀 code 才看到、ticket 沒提到的問題

| # | 問題 | 位置 | 為什麼重要 |
|---|---|---|---|
| **F1** | `/view` 的公開 GET 不只是 metadata：`/api/pane/:name` 回 **tmux 畫面原文（含 ANSI）**；`/api/profiles` 含 model、description、backend；`/api/ai-usage` 含訂閱用量 | `view-api.ts:233,248`、`usage-api.ts:252` | 「公開」= 任何能連到這個埠的人可即時看所有 agent 的終端。loopback 下是刻意接受的，外網下絕不可 |
| **F2** | 沒有 Host allowlist。loopback 綁定不等於安全：DNS rebinding（惡意網頁把自己的網域解析到 127.0.0.1）可以讀到 F1，因為 Origin==Host 對它成立、而 F1 那些路由本來就不要 cookie | `fleet-manager.ts:12483`（不看 Host）；`web-auth.ts:158` | **今天就存在**，不需要 tunnel。修法便宜（Host ∈ loopback 名稱 + 設定的 hostname） |
| **F3** | cookie 是無狀態、決定性的：所有裝置同值；`Max-Age` 只是客戶端提示，伺服器端**沒有過期檢查**；無登出、無單裝置撤銷 | `web-auth.ts:106,22` | 被偷（XSS、裝置遺失、螢幕分享）的 cookie 永久有效直到全域 rotate。`setup-host-tunnel` §3.8 的教訓：推導式 cookie 的強度上限等於它所推導的憑證，且它沒有生命週期 |
| **F4** | `view.html` 的 `api()` 把 web.token 加進**每一個** API 網址（含 pane 輪詢），並把 token 存進 `localStorage`；`view-api.ts` 用 `===` 比較並接受 `?token=` 作為**寫入**憑證 | `view.html:179,353,808,829`；`view-api.ts:206-214` | 違反 `web-auth.ts:14-16` 自己寫的規則（URL token 不得作為寫入憑證）；token 會出現在 Cloudflare 存取紀錄、瀏覽器歷史、螢幕截圖。這就是 leader 說的「View (edit)」殘留，但實際範圍比那個連結大 |
| **F5** | Origin 缺席就放行；沒有 CSRF token | `web-auth.ts:160` | 對 CLI 的 header-token 沒問題（非 ambient 憑證），但**一旦 `/view` 寫入改吃 cookie，就是第一次讓 `/view` 有 CSRF 面**。所以「改吃 cookie」與「加 CSRF 防護」必須同一個 PR，不能分開 |
| **F6** | 完全沒有失敗計數與 rate limit | `decideWebGate` | 192 bits 猜不中，但外網上「無限次嘗試」本身是免費的雜訊與 DoS；而本文要引入 40-bit 短碼，就一定要有 |
| **F7** | SSE 一旦建立就不再驗證：session 撤銷、過期後串流照樣送資料 | `web-api.ts:275-300` | 有了 server-side session，撤銷必須切斷已開的串流 |
| **F8** | `viewToken` 產生並寫到 `view.token`，但**沒有任何程式碼使用它**；`fleet-manager.ts:12508` 與 `view-api.ts` 開頭註解都說「/view 接受唯讀 view.token」，與實作不符 | `fleet-manager.ts:2626-2629`、`view-api.ts:34` | 死碼 + 誤導性文件，Phase 1 一併移除 |
| **F9** | `/dashboard` 把**全權** web.token 貼進聊天平台（spoiler 只遮視覺，平台伺服器與歷史都存了明文） | `topic-commands.ts:381-395` | 換成單次 5 分鐘的登入碼後，這條洩漏的價值降為近零 |

---

## 2. 目標形態與威脅模型

### 2.1 這個 session 值多少

`/ui/send` 對 agent 發訊息、`/ui/instances` 建立 instance、`/settings` 的 `apply`、`restart-fleet`、`/ui/config` 改設定，全部等同於**在主機上以 fleet 使用者身分執行程式碼**（agent 有工具權限）。所以要把一個有效 session 視為約等於一個 shell。這條決定了後面所有取捨：外網模式下 session 要短、要能撤銷、危險操作要能要求近期驗證。

### 2.2 攻擊者

| | 誰 | 能力 |
|---|---|---|
| A1 | 掃描者 | 知道 tunnel hostname，能對公開端點無限請求 |
| A2 | 拿到連結的人 | 聊天群轉發、預覽 bot 抓連結、螢幕截圖 |
| A3 | 竊得 session 的人 | XSS、裝置遺失、瀏覽器擴充、螢幕分享 |
| A4 | 惡意網頁 | 使用者瀏覽器同時登入著時的 CSRF、DNS rebinding |
| A5 | 同網域兄弟站 | `*.trycloudflare.com` 的其他站；**我沒能驗證 trycloudflare.com 是否在 Public Suffix List**（抓不到私有網域區段），所以設計**不依賴 SameSite 擋它**，改靠嚴格 Origin 檢查 |
| A6 | Cloudflare / 中間節點 | TLS 在 edge 終止，看得到所有明文：cookie、pane 畫面、設定、登入碼 |
| A7 | 本機其他程序 / 使用者 | **不在範圍**：能讀 0600 的檔案就已經同 uid；host 上多使用者的情境是既有限制，文件寫明即可 |

### 2.3 威脅 → 對策 → 落在哪

| 威脅 | 對策 | Phase |
|---|---|---|
| DNS rebinding 讀 /view（A4, F2） | Host allowlist（每個 listener） | **0** |
| 掃描者猜登入碼（A1） | 沒有簽發中的碼就沒有東西可猜且不計數；碼 5 分鐘、5 次；全域斷路器 | 1a |
| 拿到連結就登入（A2） | 網址不含憑證；GET 無副作用；碼另送、單次 | 1a |
| 被偷的 cookie（A3, F3） | server-side session、絕對 + 閒置過期、單裝置撤銷、全域撤銷、rotate 連動 | 1a |
| CSRF（A4, F5） | SameSite=Strict + 寫入必須有 Origin 且相符 + `Sec-Fetch-Site` + `X-Agend-CSRF` | 1a（View 寫入在 1b） |
| Session fixation | 登入永遠新發 id，不接受 client 提供的 id，舊 cookie 先撤銷 | 1a |
| token 進 URL / localStorage（F4, F9） | 移除；View 改用 session；`/dashboard` 不再貼 token | 1b |
| SSE 在撤銷後續傳（F7） | 心跳時重驗 session | 1a |
| Clickjacking | `frame-ancestors 'none'` + `X-Frame-Options: DENY` | 0 |
| 認證回應被 edge 快取 | `Cache-Control: no-store` 全面加上 | 0 |
| 外網下 `/agent`、`/restart/*` 可達 | 獨立 gateway listener + path allowlist | 3a |
| cookie 走明文 / 依偽造 header 決定 Secure | Secure 由「Host 命中已驗證的外部 host」決定，不信 `X-Forwarded-Proto` | 3a |
| 殭屍 tunnel 指到重用的埠 | gateway 有 Host allowlist（信封 31），tunnel 關閉時撤銷該 surface 的 session | 3b |
| session 被用來執行程式碼（2.1） | 外網模式下 Tier 2 操作要求近期驗證（可選） | 3a，D5 |
| Cloudflare 看得到明文（A6） | **無法消除**，只能在風險確認文案誠實列出；要避免就用 tailscale serve | 3 |

---

## 3. 登入與 session 設計

### 3.1 複用什麼、改什麼

| 複用 | 改 |
|---|---|
| `setup-auth.ts` 的碼字母表、`normalizeSetupCode`、`constantTimeMatches`、「兌換成功才另生 256-bit secret」的結構 | cookie 從 `sha256(web.token)` 改成**伺服器端 session 的不透明 id** |
| `web-auth.ts` 的 `parseCookieHeader`、`isSameOriginRequest` 形狀、`decideWebGate` 作為唯一決策點 | `decideWebGate` 的判斷從「比 token 推導值」改成「查 session store」 |
| `web.token` 檔與 `rotate` 指令 | `web.token` **退役為 CLI/腳本的 header 憑證**，瀏覽器不再拿它；rotate 連動撤銷所有 session |
| `/dashboard`、`agend web` 這兩個既有入口 | 從「給含 token 的網址」改成「給網址 + 登入碼」 |

`setup-auth.ts` 的 `SetupCredentials` 綁在 setup 宿主的語意上（錯 5 次整個宿主自毀），不能原樣拿來用。建議把碼生成、正規化、常數時間比較抽到共用模組（例如 `src/auth/one-time-code.ts`），`SetupCredentials` 與新的 web 登入都用它；setup-host 的既有測試（`setup-host-hardening.test.ts`）必須維持綠。

### 3.2 登入碼

- **簽發只走受信通道**：聊天 `/dashboard`（沿用 `allowed_users` 檢查，`topic-commands.ts:405`）、本機 `agend web`（透過本機 IPC 請 fleet 簽發；fleet 沒在跑就沒有碼可簽，這是對的）。
- **形狀**：8 字元 base32，顯示 `XXXX-XXXX`，輸入忽略大小寫與連字號（同 setup）。**單次、TTL 5 分鐘、每碼獨立 5 次嘗試預算**。
- 三條關鍵性質：
  - **P1 沒有簽發中的碼 → `/auth/login` 一律回同一個 401，且不計任何失敗。** 攻擊面只在合法使用者剛要了一個碼的那幾分鐘開著，其餘時間根本沒有東西可猜。
  - **P2 一個碼錯滿 5 次 → 只有那個碼作廢。** 不是整個 fleet 上鎖。setup 宿主可以「錯 5 次就自毀」，因為它本來就是十分鐘的逃生艙；長駐 fleet 不能讓路人一鎖就鎖死使用者。代價是使用者再向聊天要一個碼。
  - **P3 全域斷路器**：15 分鐘內累計失敗 ≥ 20 次，暫停接受兌換 5 分鐘並記 log。不影響已登入的 session，也不影響簽發。
- 同時只保留**一個**有效碼；新簽發覆蓋舊的。
- 兌換用 `POST /auth/login`（見 3.3）。**任何 GET 都不消耗碼、不建立 cookie**（連結預覽 bot 安全，`setup-host-tunnel` §3.2 的教訓）。
- 碼經聊天平台送出，平台看得到；但它單次、5 分鐘，遠好於現在貼全權 token。

**交付形態（D3）**：(A) 使用者在頁面輸入碼（同 setup，最保守）；(B) 一鍵連結 `https://host/signin#code=XXXX-XXXX`：fragment 不會送到 server，預覽 bot 不執行 JS 就不會燒碼，頁面 JS 讀到後立刻 `history.replaceState` 清掉並 POST。手機體驗好很多。但「預覽 bot 不執行 JS」我沒有對 Telegram/Discord/Slack 實測，不能替它們保證。**建議 Phase 1 只做 (A)，(B) 等實測後再開。**

### 3.3 兌換與 session

**`POST /auth/login`** `{code}`：

- 必要條件：`Content-Type: application/json`、body ≤ 1 KB、**Origin 必須存在且 == Host**、Host ∈ allowlist。
- 成功：`sessionId = randomBytes(32)`（256 bits，與碼**完全無關**）；伺服器存 `sha256(sessionId)` → session 紀錄；`Set-Cookie`；回 JSON `{csrf, expiresAt}`。
- **不接受 client 提供的 session id**，登入永遠新發；請求若帶了舊 cookie，先撤銷它。沒有 fixation 的路。

**Cookie**：
- 名稱：外網（Secure）用 `__Host-agend_session`，loopback http 用 `agend_session`。`__Host-` 前綴強制 Secure + `Path=/` + 無 Domain，瀏覽器就不會被兄弟網域覆寫。
- `HttpOnly; SameSite=Strict; Path=/; Max-Age=<絕對 TTL>`，無 `Domain`。
- **Secure 由伺服器已知的外部 host 決定**（Host 命中 tunnel exact host 或設定的 `web.external_hosts`），**不信 `X-Forwarded-Proto`**（同 setup 信封 21；現行 `web-auth.ts:176` 要改）。
- 已知的 Strict 使用者體驗問題：從聊天 App 點連結是跨站導覽，Strict cookie 不會送，看起來像「沒登入」。做法：未登入的受保護 HTML 路由回 `/signin` 殼（200、`no-store`），殼的 JS 先 `fetch("/auth/session")`（同站請求會帶 cookie），有效就 `location.replace(next)`，無效才顯示輸入框。**這條必須用真瀏覽器（Playwright）驗，不能用推論交差**（票 0 同類教訓）。

**Session 紀錄**：`{ idHash, created, lastSeen, absoluteExpiry, idleExpiry, tier, surface, csrf, label, tokenEpoch }`

- `surface`：`local`（health server）或 `gateway`（外網）。tunnel 關閉時撤銷所有 `gateway` session（fail-closed）。
- `label`：UA 摘要 + 來源標示（走 gateway 時可取 `CF-Connecting-IP`，**只作顯示，不作授權**）。
- `tokenEpoch`：建立當下 `sha256(web.token)` 的摘要，**每次請求對照磁碟上目前的 token**。這保住現行「`web-token rotate` 立即殺掉所有 session、不用重啟」的性質。
- `tier`：`admin` 或 `read`（見 D6）。

**存放**：記憶體 Map + 持久化 `~/.agend/web-sessions.json`（0600、原子寫、**只存 hash**、載入時丟掉過期的、`lastSeen` 每 60 秒 debounce 寫）。**持久化不是可選項**：Settings 有 `restart-fleet` 與會重啟 instance 的 `apply` 路徑（`settings-api.ts:387,430`；我沒逐一確認哪些 apply 會重啟整個 fleet process，但 `restart-fleet` 明確會），只放記憶體會讓使用者在自己按下重啟的瞬間被登出，且無法回來（登入碼要從聊天拿）。

**過期政策**（D4，數字待確認）：

| | 絕對上限 | 閒置 |
|---|---|---|
| local（loopback） | 12 小時（沿用現行的意圖，但這次真的在伺服器端強制） | 2 小時 |
| gateway（外網） | 4 小時 | 30 分鐘 |

絕對上限不因活動而延長；只有閒置期滑動。

**多裝置與管理**：
- 同時最多 8 個 session，超過踢掉最舊的。
- `GET /auth/sessions` 列出（label、建立、最後活動、是否本機這個）；`DELETE /auth/sessions/:handle`（handle 是不透明的短 id，**不是 hash**）撤銷單一；`POST /auth/logout` 登出目前這個並清 cookie；「全部登出」。
- 三條撤銷路徑，對應「被偷時怎麼辦」：(1) 網頁上「全部登出」；(2) 聊天 `/dashboard revoke`（admin）；(3) 本機 `agend web-token rotate`（同時涵蓋 session 與 header token，且立即生效）。

**與現行機制的相容**：
- `X-Agend-Token` header 繼續給 CLI 與腳本，**只在 local listener 有效，gateway 不收**（見 6.3）。
- `?token=` 的 GET 兌換：Phase 1 保留但改成兌換**真正的 session**，並在 log 與回應標示 deprecated；Phase 1b 起 `/dashboard`、`agend web` 不再產生這種網址；移除時間見 D8。
- **舊的決定性 cookie 在 Phase 1a 之後不再被接受**，使用者升級後要重新登入一次，寫進 CHANGELOG。

### 3.4 CSRF 與 Origin

對「以 cookie 認證」的請求：

1. 不安全方法（POST/PUT/PATCH/DELETE）**Origin 必須存在且 == Host**；缺 Origin 直接拒絕。（header-token 的 CLI 請求不受影響，因為它不是 ambient 憑證。這一條要把現行 `web-auth.ts:160` 的「缺 Origin 放行」限縮到只適用 header-token。）
2. 若有 `Sec-Fetch-Site`，必須是 `same-origin`（或 `none` 的直接導覽，僅限 GET）。
3. 不安全方法必須帶 `X-Agend-CSRF` = 該 session 的 csrf 值（`shell.js` 的 `api()` 自動帶）。這是縱深防禦：即使 SameSite 因某個瀏覽器怪癖失效，或 A5 的兄弟站攻擊，前兩條與這條至少有一條擋得住。
4. JSON 路由只收 `application/json`；頭像上傳走 image content-type，同樣要 CSRF header。
5. SSE 與其他 GET 是安全方法，不需要 CSRF header，但仍要 cookie。

### 3.5 危險操作分級與近期驗證（D5、D6）

| Tier | 內容 |
|---|---|
| 0 讀 | pane、profiles、status、usage、fleet 狀態、SSE |
| 1 一般寫 | profile/avatar/sort-order、tasks、schedules、teams |
| 2 等同主機執行 | `/ui/send`、建立/刪除 instance、`/settings` 的 apply/restart-fleet/reload、fleet config PUT、quickstart commit、`/ui/config`、`/stop`、`/restart`、instance start |

- **D5（建議做，但獨立成 PR）**：gateway session 執行 Tier 2 時，session 年齡須 ≤ 30 分鐘，否則回 `403 {error:"reauth_required"}`，頁面跳出「請向聊天要一個新碼」。loopback 不需要。
- **D6（可選）**：`/dashboard view` 簽發只能讀的碼（`tier: read`），方便給同事看而不給他控制權。有了分級這幾乎是免費的，但不是本案必要。

### 3.6 稽核與通知

記錄（`fleet.log` 與事件紀錄，**絕不記碼、cookie、csrf、session id**）：`auth.login.ok|fail(原因分類)`、`session.create|revoke|expire`、Tier 2 操作（路由 + session label）。

**D7（建議開）**：每次新登入，向 admin 聊天頻道發一則「有新的網頁登入：<label>，<時間>」。這是最便宜的被盜偵測：你沒登入卻收到通知，就知道該撤銷了。

---

## 4. `/view` 收斂

### 4.1 讀

新增 `web.view_access: "open" | "session"`。

- **規則一（不可設定）**：**只要存在任何 gateway listener（tunnel 或 external host），`/view` 的讀取一律要 session。** F1 說明了為什麼：外網公開等於把所有 agent 的終端畫面公開。
- **規則二（D1）**：loopback 的預設值。建議維持 `open`（尊重使用者刻意的決定），因為 Phase 0 的 Host allowlist 已經補掉 DNS rebinding；想收緊的人設 `session`。
- 兩條路的代價要誠實寫進文件：`open` 下同一台主機上的其他使用者仍讀得到 pane（既有限制，A7）。

### 4.2 寫

- `view-api.ts` 的寫入改走共用 gate：session cookie + CSRF（Tier 1）；header-token 給 CLI；**移除 `?token=` 與 `===` 比較**。
- `view.html`：移除 `urlToken`、`api()` 的 token 附加、`localStorage.agend_web_token`、「貼 web.token 才能儲存」的欄位；改成「已登入則可編輯，未登入顯示『登入以編輯』」。
- `dashboard` 訊息刪除 `View (edit)` 那行；`/view` 只給乾淨網址。
- 刪除 `viewToken` 與 `view.token`（F8）。

這一段就是 leader 提的殘留修補；它必須與 3.4 的 CSRF 同時上（F5），否則 `/view` 寫入改吃 cookie 的當下會引入從未存在過的 CSRF 面。

---

## 5. 網頁一體化

### 5.1 三個選項

| | A. SPA 殼重寫 | **B. 共用 shell，各頁獨立（建議）** | C. 只補導覽列 |
|---|---|---|---|
| 做法 | 三頁重寫成一個前端應用 + build 流程 | 抽出共用 CSS/JS（導覽、auth client、i18n、主題），各頁逐一接上 | 每頁手貼一條連結列 |
| 成本 | 高：3.5k 行 inline JS 要遷移，要引入 bundler | 中：分頁逐步遷移，每步可獨立 review | 低 |
| 風險 | 高：SSE/輪詢生命週期、1701 行 settings 迴歸 | 低：頁面內容不動 | 無 |
| 拿到的 | 完全一致 | 一致的導覽、登入狀態、視覺基礎、`401→登入` 行為、CSRF 自動帶、共用 i18n | 只有連結 |
| 適合 | 之後要做更複雜互動時 | **本案目標（一體性 + 共用 session）** | 只求快 |

建議 **B**，理由：使用者要的是「進去後自由切換、不再重登」，這是 session 與導覽的問題，不是渲染框架的問題。B 沒有 build 步驟的新負擔，`postbuild` 的 `cp -r src/ui dist/` 仍然夠用。

### 5.2 具體形狀

**共用資產**（`src/ui/shared/`）：
- `shell.css`：設計 token、導覽列、登入殼。**三頁在此收斂到同一組 token**；先支援深色，settings 的白底當作淺色主題變體，而不是繼續三套並存。
- `shell.js`：渲染導覽列（Dashboard · View · Settings · 使用者選單：目前 session、裝置列表、登出）、`agend.api()`（自動帶 CSRF、401 時導向 `/signin?next=`、`reauth_required` 時彈出重登）、共用 i18n（`t()`，各頁合併自己的字典）、語言/主題切換。
- `signin.js`：登入頁邏輯。

**資產路由**：用 `web-terminal-http.ts` 的做法，**明列 allowlist 的 map**（檔名 → 路徑 + content-type），不做目錄服務。取代目前那個沒長完的 `/ui/js/<name>.js`。

**路由地圖**：

| 路徑 | 用途 | 認證 |
|---|---|---|
| `/signin` | 登入殼（靜態、無副作用、帶 readiness marker） | 公開 |
| `/assets/*` | shell 資產（allowlist） | 公開（無敏感內容） |
| `POST /auth/login`、`GET /auth/session`、`POST /auth/logout`、`GET/DELETE /auth/sessions` | session 管理 | 見上 |
| `/ui`、`/view`、`/settings` | **網址不變**（文件、CLI、書籤相容） | session（`/view` 依 D1） |
| `/` | 有 session → 302 `/ui`；否則 `/signin` | |

**命名**：網頁登入頁叫 `/signin`，**不叫 `/login`**。聊天的 `/login` 是「替 agent CLI 做 OAuth 登入」的逃生艙（`/login` → Web Terminal），同名會在文件與客服上混淆。

**Web Terminal（`/t/<sid>/`）不併入導覽**：它是聊天 `/login`、`/install-cli` 產生的一次性 session，有自己的 listener 與 token，沒有可瀏覽的入口，依 T4 這票也不接。

### 5.3 其他一體化必要項

- **SSE**：Quick Tunnel 不支援 SSE（§6.1），dashboard 必須在 `EventSource` 失敗時**自動退回輪詢**（約 10 秒）。這同時提升一般網路不穩時的韌性，不只是為了 tunnel。
- **SSE 與 session**：心跳（`web-api.ts:283` 的 interval）內重驗 session，撤銷/過期就關串流（F7）。
- **安全標頭**（所有 HTML 與認證回應）：`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`（**Phase 0**）。完整 CSP（`default-src 'self'; script-src 'self' 'nonce-…'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'`）在 Phase 2：三頁目前全是 inline `<script>`，先用「伺服器讀 HTML 時注入 per-response nonce」（`readFileSync` 本來就每次請求都做），等 inline JS 外部化後改成純 `'self'`。
- **字型**：Google Fonts 會擋 CSP 且每次載入都對第三方發請求。建議 Phase 2 改系統字型堆疊，或自帶 woff2 子集（三款都是 OFL，可再散布）。
- 不做：i18n 框架、前端框架、bundler。

---

## 6. Cloudflare tunnel 整合

### 6.1 選項與取捨

| | Quick Tunnel（現有 provider） | Named Tunnel（Cloudflare 帳號 + 自己網域） | `tailscale serve`（私有） | `tailscale funnel` |
|---|---|---|---|---|
| 誰連得到登入頁 | 全網際網路 | 全網際網路（可再疊 Cloudflare Access） | **只有你的 tailnet 裝置** | 全網際網路 |
| 手機不裝 app 可開 | 可 | 可 | **不可**（要裝 Tailscale） | 可 |
| 明文誰看得到 | Cloudflare edge | Cloudflare edge | **沒有第三方**（WireGuard 端到端） | Tailscale relay 路徑 |
| 網址 | 每次隨機 | 穩定 | 穩定 | 穩定 |
| SSE | **官方文件：不支援** | 支援 | 支援 | 支援 |
| 官方保證 | **官方文件：無 SLA、僅供測試開發；同時上限 200 個 in-flight 請求（超過回 429）** | 有 | 有 | 有 |
| 前置 | 只要 `cloudflared` | `cloudflared tunnel login/create/route dns` + 網域 | 裝 tailscale | 同左 |
| AgEnD 現況 | provider 已有（僅 setup 宿主用） | 無 | 無（T5 排除） | 無 |

上表 Quick Tunnel 的 SSE、SLA、200 上限三項來自 Cloudflare 官方文件（trycloudflare 頁面），我在寫本文時抓過。

**建議與取捨**：
- **能裝 Tailscale 的裝置就用 `tailscale serve`**：不對公網曝露、沒有第三方看到明文，這是最小的攻擊面，也符合使用者「不公開曝露」的傾向。
- 使用者明確要 Cloudflare：**建議 Named Tunnel**，不是 Quick Tunnel。Quick Tunnel 對「dashboard 要天天用」是錯的工具（沒 SLA、網址每次變、沒有 SSE）。它適合「臨時給手機開一下」。
- 兩者 AgEnD 都不必自己管 provider 生命週期，用 **manual 模式**（3a）即可：使用者自己起 tunnel/`tailscale serve`，指向 gateway 埠，AgEnD 只需要知道「我的外部 host 是什麼」。
- Named Tunnel 還可在 Cloudflare 那側疊 **Cloudflare Access**（一次性 PIN 或 SSO）當第二道獨立的門。這是使用者端設定，AgEnD 不需要寫任何程式，但值得在文件建議，因為它讓 A1 掃描者連我們的登入頁都摸不到。
- managed Quick Tunnel（3b）保留作為「一鍵臨時開」，但要接受它的限制並在確認文案說清楚。

### 6.2 tunnel 只是傳輸

延續 setup 信封第 1 條：tunnel URL 不是憑證，不碰 `web.token`；真正的門是 §3 的登入。tunnel 掉了不旋轉 hostname、不重發碼（信封 8）。

### 6.3 Gateway listener：對外只走這個

**為什麼不把 tunnel 指向 health port**：health server 有 `/agent`（instance token 的 RPC）、`/restart/*`、`/stop/*`、`/api/instance/*`、`X-Agend-Token` 授權。任何一個都不該過外網。而且「埠是 capability boundary」是唯一在 gate 有 bug 時仍然 fail-closed 的邊界（`setup-host-tunnel` §3.1 的核心結論）。

**做法**：第二個 `http.Server`，綁 `127.0.0.1`，與 health server 共用同一組 handler，但外面包一層 surface 過濾：

1. **Host allowlist**：只有設定的 external host（managed 模式為 tunnel 的 exact host）。loopback 名稱**不**在 gateway 的名單內。
2. **Path allowlist**：`/signin`、`/assets/*`、`/auth/*`、`/ui*`、`/view`、`/api/pane/*`、`/api/profiles`、`/api/profile/*`、`/api/avatar/*`、`/api/sort-order`、`/api/ai-usage`、`/settings`、`/api/settings/*`、`/api/fleet`、`/stop/*`、`/api/instance/*/start`、`/restart/*`（後四者是 Settings 頁實際會呼叫的，`settings.html:1096-1097,1644`；實作時以 grep 三頁 HTML 的實際呼叫為準再確認一次）。**其餘一律 404**，尤其 `/agent`、`/status`、`/health`、`/activity`、`/api/activity`。
3. **憑證只收 session cookie**：**不收 `X-Agend-Token`、不收 `?token=`**。web.token 永遠不需要也不應該過外網。
4. 每個回應 `Cache-Control: no-store`；連線數上限（比照 `web-terminal-http.ts` 的 `MAX_CONNECTIONS`）；請求 body 上限；自己的失敗斷路器。
5. 這個 listener 的 session `surface = gateway`（3.3）。

這需要把 `fleet-manager.ts` 那個大 `createServer` callback 裡的分派抽成 `routeWebRequest(req, res, { surface })`，是 Phase 3a 主要的重構量，也是最值得 Prism 看的部分。

**埠**：managed 模式用 `127.0.0.1:0`（同 setup 宿主，殭屍 tunnel 最多指到死埠）；manual 模式需要穩定埠，用 `web.gateway_port`。兩者都受 Host allowlist 保護（信封 31）。

### 6.4 Managed Quick Tunnel 生命週期（3b）

- **啟動**：聊天 `/dashboard public`（admin）或 `agend web --public`。
- **逐次風險確認**：聊天入口用按鈕（fleet 有通道，這是 setup 宿主做不到而 sol 原設計可行的）；CLI 入口用 TTY 提問，**無 TTY 一律拒絕**。文案要**改寫**：這裡穿過 Cloudflare 的不是 bot token，而是 **session cookie、所有 agent 的終端畫面、設定內容，以及一個能在你主機上執行程式碼的 session**（2.1）。也要寫「Quick Tunnel 不保證可用、不支援即時更新（會退回輪詢）」。
- **兩則訊息**：訊息 1 給網址（不是憑證）、訊息 2 給登入碼（spoiler）。聊天通道存在，所以 sol 的「URL 與憑證分送」在這裡成立。
- **TTL**：預設 4 小時、上限 24 小時；`/dashboard close` 立即關；時間到自動關。
- **readiness**：以 `/signin` 頁內含的 marker 驗證「edge 真的連到這個 listener」（無副作用 GET，符合 `TunnelStartContext` 的契約）。
- **關閉順序**：撤銷所有 `gateway` session → 關 gateway listener（`closeAllConnections()`）→ 停 tunnel 並取得死亡證據。
- **無法確認死亡**：因為 gateway 是獨立埠且 session 已撤銷，T2 的五個條件在這裡都是**結構性成立**：fleet 照常運行，但寫 `tunnel_cleanup_failed`、保留 lease、下次啟動 `reap()`（`ManagedTunnel.reap` 已存在）、訊息含 PID 且不寫「已安全關閉」。
- **意外退出**：同上，撤銷 gateway session，不換 hostname。
- fleet 啟動時先 `reap()`。

### 6.5 Manual / BYO 模式（3a）

只需要一個設定：

```yaml
web:
  external_hosts: ["agend.example.com"]   # gateway 的 Host allowlist，也決定 cookie 的 Secure
  gateway_port: 19281                      # 使用者的 tunnel / tailscale serve 指向這裡
```

沒設 `external_hosts` 就**不啟動 gateway**（預設關閉；fail-closed）。這一步涵蓋 Named Cloudflare Tunnel、`tailscale serve`、nginx/caddy 反向代理，AgEnD 不必碰任何 provider 程式。

---

## 7. 分階段計畫

原則：每個 Phase 一到數個 PR，可獨立 review 與 merge；**Prism 安全 review 通過前，任何 Phase 都不動工**（core-path design-first）。Phase 0 雖小，也走同一關，因為它會改變既有部署的行為。

### Phase 0 — 不需要登入機制就該補的洞

- Host allowlist（health server）：loopback 名稱 + fleet `hostname` + 新增的選用 `web.allowed_hosts`。**這是行為變更**：走反向代理且 Host 不是 localhost 的既有使用者需要設 `web.allowed_hosts`，要寫進 CHANGELOG 與升級說明。`/health` 也要過 Host 檢查嗎？監控通常用 `localhost`/`127.0.0.1`，建議一律檢查，一致比例外好。
- 安全標頭：`Cache-Control: no-store`（認證與登入相關回應）、`nosniff`、`X-Frame-Options: DENY`、`frame-ancestors 'none'`。
- 驗收：`Host: evil.example` 對 `/view`、`/api/pane/*`、`/health`、`/ui` 全部拒絕（mutation：拿掉檢查要紅）；`localhost`、`127.0.0.1`、`[::1]`、設定的 hostname 正常；`X-Frame-Options` 存在。

### Phase 1a — Session 引擎 + 登入

- `src/auth/one-time-code.ts`（從 `setup-auth.ts` 抽出）、`src/web-session.ts`（store、政策、持久化、`tokenEpoch`）。
- `POST /auth/login`、`GET /auth/session`、`POST /auth/logout`、`GET/DELETE /auth/sessions`、極簡 `/signin`。
- `decideWebGate` 改為 session 判斷；CSRF（3.4）；SSE 心跳重驗（F7）；`X-Agend-Token` 保留；`?token=` GET 兌換改發真 session 並標 deprecated。
- `/dashboard` 與 `agend web` 改為簽發登入碼；`web-token rotate` 連動；`/dashboard revoke`。
- 驗收（每條對應 mutation 會紅）：
  1. 無簽發中的碼時打 `/auth/login`：回同一個 401、**失敗計數不變**（mutation：改成計數要紅）。
  2. 錯 5 次該碼作廢、第 6 次即使碼正確也失敗；**另一個新碼不受影響**（mutation：改成全域上鎖要紅）。
  3. 碼單次：兌換兩次，第二次失敗。
  4. session id 與碼獨立：同一個碼在兩個測試 store 兌換出的 id 無關（mutation：由碼推導要紅）。
  5. 過期：絕對過期、閒置過期各一條，**伺服器端強制**（mutation：只依 Max-Age 要紅）。
  6. 撤銷：單一撤銷、全部撤銷、`rotate` 後同一個 cookie 立即失效（mutation：拿掉 `tokenEpoch` 比對要紅）；**重啟後 session 仍在**（持久化）、hash 存檔而非明文。
  7. fixation：帶著舊 cookie 登入，舊的失效、新的不同。
  8. CSRF：cookie 認證的 POST 缺 Origin → 拒、Origin 不符 → 拒、缺 CSRF header → 拒；header-token 的 CLI 請求缺 Origin 仍過。
  9. SSE：撤銷後下一次心跳串流被關。
  10. 所有 GET（含 `/signin`、`/auth/*`）無副作用：不消耗碼、不建 cookie。
  11. 斷路器：15 分鐘 20 次失敗後暫停兌換、已登入 session 不受影響。
  12. 真瀏覽器（Playwright）：登入 → 導覽三頁不需再登入；**從外部連結進入受保護頁**會經 `/signin` 殼自動轉回（Strict 的體驗問題）。
- setup-host 既有測試不變（抽共用碼模組的迴歸）。

### Phase 1b — `/view` 收斂

- `view-api.ts` 寫入改走共用 gate；移除 `?token=`、`===`；`web.view_access`；刪除 `viewToken`／`view.token`；`view.html` 拿掉 token 欄位與 URL 附加；`/dashboard` 刪 `View (edit)`。
- 驗收：`/view?token=<web.token>` 不再授權寫入（mutation：恢復要紅）；session + CSRF 才能 POST profile/avatar/sort-order；`view_access: session` 時未登入讀 `/api/pane/*` 回 401；`view.html` 原始碼不含 `agend_web_token`、不在請求網址附 token。

### Phase 2 — UI 一體化

- `/assets/*` allowlist 路由（取代 `/ui/js/`）、`shell.css`/`shell.js`/`signin.js`；先接 dashboard，再 view，再 settings（每頁一個 PR，各自可回退）；使用者選單與裝置列表；`/` 導向；SSE 退回輪詢；CSP（nonce）；字型自帶或改系統堆疊。
- 驗收：三頁共用導覽且切換不重登；SSE 中斷時 dashboard 自動輪詢並顯示狀態（Playwright 模擬 SSE 失敗）；CSP 標頭存在且頁面無違規回報；`view-responsive.test.ts`、`view-ui-improvements.test.ts`、`settings-*.test.ts` 既有斷言維持綠。

### Phase 3a — Gateway listener + manual/BYO

- `routeWebRequest({surface})` 重構；gateway listener（Host allowlist、path allowlist、只收 cookie、no-store、連線上限）；`web.external_hosts`／`web.gateway_port`；Secure 由外部 host 決定；tunnel 開啟時 `/view` 強制 session（規則一）；補 `web-terminal-http.ts` 的 Host allowlist（信封 31）。
- **D5** 的 Tier 2 近期驗證與 **D6** 的 read tier，若使用者選要，放這一階段但獨立 PR。
- 驗收：對 gateway 打 `/agent`、`/status`、`/health`、`/restart/x` 全 404（path allowlist 用測試釘住，mutation：放寬要紅）；帶 `X-Agend-Token` 打 gateway 受保護路由 → 401；`Host: agend.example.com` 以外全拒；未設 `external_hosts` 時 gateway 不存在（埠沒開）；偽造 `X-Forwarded-Proto` 不影響 Secure；殭屍 host 對重用埠 → 403；真實驗收：以 Named Tunnel 或 `tailscale serve` 從手機登入並操作。

### Phase 3b — managed Quick Tunnel（fleet 版）

- `/dashboard public`、`agend web --public`、聊天按鈕確認 + CLI TTY 確認（無 TTY 拒絕）、兩則訊息、TTL、`/dashboard close`、關閉順序與撤銷 `gateway` session、意外退出處理、fleet 啟動 `reap()`。
- 驗收：關閉順序斷言（fake provider 讓 stop 回 unconfirmed → gateway 已關、session 已撤、lease 保留、訊息不含「已安全關閉」，mutation：忽略 unconfirmed 要紅）；無 TTY 拒絕（mutation：預設放行要紅）；確認文案含 cookie、終端畫面、設定、主機執行能力四項與 SSE/SLA 限制；真 cloudflared 從外網手機登入、dashboard 在無 SSE 下正常輪詢、關閉後網址不再抵達 origin。

### 不做（範圍守門）

SPA/框架/bundler；OAuth、passkey、TOTP（之後可獨立做，passkey 是自然的下一步）；多使用者帳號與角色（只有 admin/read 兩個 tier）；Cloudflare Access 的整合程式（只建議、不實作）；IP allowlist；cookie 週期性輪換（絕對 + 閒置 + 撤銷已涵蓋，輪換增加複雜度但威脅模型下收益有限）；Web Terminal 併入導覽（T4）。

---

## 8. 待使用者決定

| # | 問題 | 建議 | 何時要 |
|---|---|---|---|
| **D2** | **你用的（或要用的）是哪一種 Cloudflare tunnel？** 有 Cloudflare 帳號與網域嗎？ | 有 → Named Tunnel + manual 模式（3a）。沒有 → 先 Quick Tunnel（3b），但要接受無 SSE、無 SLA、網址每次變。手機能裝 Tailscale 的話 `tailscale serve` 最小曝露 | **最先**，決定 Phase 3 形狀 |
| **D1** | `/view` 在 loopback 的讀取是否也收斂？ | 維持 `open`（Phase 0 已補 DNS rebinding），有 tunnel 時一律要 session；可用 `web.view_access: session` 自行收緊 | Phase 1b 前 |
| **D3** | 登入碼交付：頁面輸入，或一鍵連結（`#code=` fragment）？ | Phase 1 只做輸入；一鍵連結等對 Telegram/Discord/Slack 預覽 bot 實測後再開 | Phase 1a 前 |
| **D4** | session 過期數字 | local 絕對 12h / 閒置 2h；外網 絕對 4h / 閒置 30m；tunnel TTL 預設 4h、上限 24h | Phase 1a 前 |
| **D5** | 外網模式下 Tier 2 操作要求 30 分鐘內驗證？ | 要（session 約等於 shell），獨立 PR | Phase 3a |
| **D6** | 要不要只讀 session（`/dashboard view`）？ | 可晚點；分級做完後幾乎免費 | Phase 3a |
| **D7** | 每次新登入通知 admin 聊天頻道？ | 開 | Phase 1a 前 |
| **D8** | `?token=` 網址兌換何時移除？ | Phase 1b 起不再產生、標 deprecated，**下一個 minor 移除**（會弄壞舊書籤，需要 CHANGELOG） | Phase 1b 前 |

另外兩個我直接定了、有異議再說：網頁登入頁命名 `/signin`（避開聊天 `/login`）；Phase 0 拆成獨立、先出。

---

## 9. 已知殘餘風險（寫明白，不藏）

- **Cloudflare 看得到全部明文**（A6）。無法消除，只能確認文案誠實、或改用 `tailscale serve`。
- **拿到 gateway 網址 + 剛好搶到登入碼視窗的人**：碼只有 40 bits，靠 5 分鐘 × 5 次 × 全域斷路器壓低，以及「沒簽發就沒有攻擊面」。若使用者在公開群組貼出碼，5 分鐘內任何人都能用，這是人的問題，文案要提醒別貼進多人群組。
- **`open` 模式下的同機其他使用者**能讀 pane（A7）。
- **Strict cookie 的導覽體驗**靠 `/signin` 殼補償，必須真瀏覽器驗證；若在某個瀏覽器/行動 App 內建瀏覽器失效，退路是改 Lax 並靠 Origin + CSRF header 撐住（本設計的寫入防護本來就不依賴 SameSite）。
- **Quick Tunnel 的服務品質**（無 SLA、SSE、200 上限）不受我們控制。
- **Session 等同 shell**（2.1）。D5 降低、但不消除：只要 agent 有工具權限，登入者就能透過 agent 執行程式碼。這是產品本質，不是本設計的缺陷。

---

## 附錄：證據索引

| 事實 | 位置 |
|---|---|
| health server 只綁 loopback、不查 Host | `fleet-manager.ts:12483,12821,12829` |
| gate 豁免清單 | `fleet-manager.ts:12503-12513` |
| cookie 值 = `sha256(token)`；Max-Age 12h | `web-auth.ts:106,22` |
| 缺 Origin 放行 | `web-auth.ts:158-160` |
| Secure 信 `X-Forwarded-Proto` | `web-auth.ts:176` |
| `/view` 寫入 `===` 與 `?token=` | `view-api.ts:206-214` |
| `/api/pane` 公開 | `view-api.ts:233` |
| `viewToken` 產生但無人使用 | `fleet-manager.ts:2626-2629`；`view-api.ts:34` |
| `/dashboard` 貼 token | `topic-commands.ts:381-395` |
| `view.html` token 進 URL 與 localStorage | `view.html:179,353,808,829` |
| SSE 無重驗 | `web-api.ts:275-300` |
| tunnel provider 與唯一消費者 | `src/tunnel/*`；`setup-host.ts:46-49,215` |
| 一次性碼 + 獨立 session secret + 共用失敗預算 | `setup-auth.ts`（全檔） |
| Web Terminal 無 Host 檢查 | `web-terminal-http.ts`（grep 無 allowlist） |
| Settings 呼叫的 fleet 控制路由 | `settings.html:1096-1097,1644` |
| 未使用的 `/ui/js/` 掛鉤 | `web-api.ts:230-247`；`src/ui/` 無 `.js` |
