# 逃生艙 setup 宿主的對外通道：設計與分階段計畫

狀態：**design-first 計畫稿，尚未實作**。本文件回答三件事：cloudflared tunnel provider 目前的實作狀態、sol 的 tunnel 設計與票 5 setup 宿主兩份安全信封要怎麼同時成立、以及可逐段 review 的 stage 拆分。最後一節列出**我不自己拍、要 leader／fable 裁的取捨**。

參考：`docs/design/web-terminal-tunnel-provider.zh-TW.md`（sol，branch `design/web-terminal-tunnel-provider`，doc-only）、`docs/design/prefleet-host-spike.zh-TW.md`、`src/setup-host.ts`、`src/setup-form.ts`、`src/setup-marker.ts`。

---

## 1. tunnel provider 實作狀態：**零**

查證結果（`grep -rn cloudflared|TunnelProvider|trycloudflare src/ tests/`）：

- **沒有任何 tunnel provider 實作。** 整個 codebase 只有三處「tunnel」字樣，全是註解裡對未來的預期：`web-terminal-http.ts:5`（「a tunnel pointed at it (phase 3) can reach…」）、`web-auth.ts:174`（`X-Forwarded-Proto` 的來源說明）、`fleet-manager.ts:12339`（Referrer-Policy 對 tunnel host 的考量）。
- 沒有 `TunnelProvider` / `TunnelHandle` 介面、沒有 provider 設定 schema（`web_terminal.tunnel` 不存在於 `types.ts`／`config-validator.ts`）、沒有 lease、沒有 reaper。
- **但 sol 設計要掛上去的地基是真的存在**：`web-terminal-http.ts` 已經是 per-session `127.0.0.1:0` listener（`server.listen(0, this.bind)`），`login-controller.ts`、`login-window-lock.ts` 都在。也就是說 stage 1 是「補上缺的那一塊」，不是「重寫 Web Terminal」。

**結論：這票確實包含兩大塊** —— (a) 依 sol 設計實作 tunnel provider 本體，(b) 用它 front setup 宿主。而且 (b) **不是 (a) 的單純套用**：下一節說明為什麼。

---

## 2. 兩個設計的形狀差異

sol 的設計是為 **Web Terminal session** 寫的。setup 宿主在每一條關鍵軸線上都不一樣：

| | Web Terminal（sol 設計的對象） | setup 宿主（票 5 現況） |
|---|---|---|
| listener | 每 session 一個 `127.0.0.1:0` **臨時埠** | `127.0.0.1:<health_port>`，**就是 fleet 之後要接手的那個埠** |
| 授權憑證 | 一次性 token，20 字元 base32（100 bits） | `randomBytes(24)` hex（192 bits） |
| 比較方式 | `timingSafeEqual`、固定長度 | **`provided === this.token`**（`setup-host.ts:135`） |
| 錯誤次數 | 全 session 三次即銷毀 | **無上限、無 lockout** |
| 憑證送達 | URL 與 token **分兩則 DM** | **同一條連結**（CLI 印出 `/?token=…`） |
| cookie | HttpOnly、SameSite=Strict、**Secure 依已驗證 endpoint 的 https** | `buildSessionCookie(this.token, **false**)` —— Secure 寫死 false |
| Host 檢查 | Origin==Host **且** Host ∈ {loopback, 本次 exact external host} | 只有 `isSameOriginRequest`（Origin==Host），**無 allowlist** |
| GET 副作用 | 完全無副作用（連結預覽安全） | **`GET /?token=` 會把 token 兌換掉並發 cookie** |
| 能力 | 一個 tmux 終端 | **寫 fleet.yaml、寫 .env（bot token）、spawn 整個 fleet** |
| 風險確認 | 聊天室按鈕（逐次） | **聊天室還不存在** |
| 設定來源 | `web_terminal.tunnel`（fleet.yaml） | **fleet.yaml 還不存在** |
| lease reaper | fleet 啟動時與每次新 tunnel 前 | **沒有 fleet 可以跑 reaper** |

右欄那些「較弱」的選擇在票 5 的前提下**都是對的**：只綁 127.0.0.1，唯一能連到它的人已經在這台機器上。把它接上公網，前提沒了，每一條都要重新論證。

---

## 3. 兩個設計放在一起才浮現的攻擊面

以下六條**不在 sol 的文件裡，也不在票 5 的信封裡**，只有「外網可達的 pre-fleet 宿主」這個組合才存在。

### 3.1 🔴 埠交接：tunnel 活過 setup 宿主 = 公網直通 fleet dashboard

sol 的隔離論證是「**埠本身就是 capability boundary**」——每個 session 自己的臨時埠，只服務那個 session 的 path，所以 tunnel 就算把該埠所有 path 都轉進來也跨不到 dashboard。

setup 宿主不成立：它綁的是 **health port**，而 `shutdown(true, "finished")` 的最後一步就是 **spawn fleet**，而 fleet 會綁**同一個埠**跑 dashboard／health／Settings／`/api/*`。

於是：**只要 tunnel 在 fleet 綁上該埠時還活著，那條公網 URL 就從「一個設定表單」變成「整個 fleet 的控制台」**，而且是在任何 fleet 層級的存取控制決策發生之前。cloudflared 的 Quick Tunnel 沒有 SLA、可能在我們沒觀察到 exit 的情況下續命，sol 自己也寫了「無法確認死亡就保留 lease」——那個 unknown 狀態在 Web Terminal 只是「不能再開新 tunnel」，在這裡是「公網 URL 指向 dashboard」。

**建議的解法不是加強關閉順序，而是讓這個危險在結構上不存在**：tunnel 模式下 setup 宿主**改綁 `127.0.0.1:0` 臨時埠**，跟 Web Terminal 一樣。fleet 的 health port 從頭到尾不在 tunnel 後面，殘留 tunnel 只會指向一個沒人會再綁的死埠。

代價是票 5 的收尾 UX 會變：`setup-form.ts` 的 `waitForFleet()` 現在靠「fleet 綁同一個埠、前端輪詢 `/health`」顯示「AgEnD is up」。臨時埠下這條斷掉，收尾要改成「設定已寫入，AgEnD 正在啟動，dashboard 連結會發到你剛設定的頻道」——**而這其實才是對的**：那條 dashboard 連結本來就該走頻道，不該讓 pre-fleet 宿主把使用者留在一個即將死亡的公網 URL 上。

即使採用臨時埠，**關閉順序仍要是**：撤銷 token/cookie → 關 listener（含 `closeAllConnections`）→ **確認 tunnel 死亡** → 才 spawn fleet。並保留「無法確認就不 spawn」的 fail-closed（見 §6 取捨 T2）。

### 3.2 🔴 連結預覽會把一次性 token 花掉（而且是必然發生）

sol §9.2 的安全論證核心是「`GET` 沒有副作用，所以 bot 抓連結不會消耗 token、不會建立 cookie」。

setup 宿主的 `GET /?token=…` **有副作用**：`tokenRedeemed = true`、`Set-Cookie`、302。而這條 URL 唯一的送達方式就是被人貼到某處（見 §3.3）。Telegram／Discord／Slack／iMessage 的預覽 bot 一抓，**token 就被兌換掉了，人再點開拿到 401「run `agend setup` again」**。

這不是機率問題，是「把連結貼進聊天室就必然發生」。而且那個預覽 bot 現在手上有一個有效的 session cookie（cookie 值是 `sha256(token)` 的決定性推導，見 `web-auth.ts:106`）。

任何「把 setup 連結傳給手機」的做法都必須先解掉這條。

### 3.3 🔴 pre-fleet 沒有第二條通道，sol 的「URL 不是憑證」在這裡不成立

sol 靠「URL 一則 DM、token 另一則 DM」把 URL 降級成非憑證。**setup 宿主執行時沒有任何 DM 通道**——bot token 還沒設定，fleet 還沒起來。唯一的輸出是 `agend setup` 那個終端機的 stdout。

所以 tunnel URL 與 token 只能一起出現在同一個地方，**URL 就是憑證**。sol 全篇最重要的那條性質在移植過來時消失了，而這個表單的能力（寫 .env、spawn fleet）比一個終端機 session 更高。

三個可能方向（要裁，見 §6 T1）：
- **(i) 接受 URL 即憑證**，靠一次性兌換 + 短 TTL + 修好 §3.2 撐住。
- **(ii) 拆開**：tunnel URL 不帶 token，CLI 另外印一段短碼，使用者在頁面上手輸入。搭配硬 lockout（三次），8 字元 base32（40 bits）的猜中上界是 `3/2^40 ≈ 2.7e-12`——用 sol 自己的算法就夠。這條把「URL 不是憑證」救回來，也順帶解掉 §3.2（預覽 bot 抓到的只是輸入框）。
- **(iii) 終端機二次確認**：手機開啟時終端機跳確認。逃生艙情境下使用者可能只有手機，不可行。

我的建議是 **(ii)**。

### 3.4 🟠 loopback 才成立的三個弱點，上公網後都要補

- **`provided === this.token`**（`setup-host.ts:135`）是逐字元短路比較。loopback 幾乎無所謂；公網上是可測的側通道。必須改 `timingSafeEqual` + 固定長度。
- **沒有任何嘗試次數上限**。192 bits 猜不中，但「無限次嘗試」在公網上本身就是錯的姿勢，也是免費的 DoS 來源。採 (ii) 短碼時**更是必要條件**。
- **`buildSessionCookie(this.token, false)`** —— Secure 寫死 false。走 HTTPS tunnel 時 cookie 必須是 Secure，而且照 sol 的規則：**由已驗證 endpoint 的 `https:` 決定，不是信可偽造的 `X-Forwarded-Proto`**。

另外 **SameSite=Strict + 從聊天 App 點開** 這個組合要實測：首個請求靠 `?token=`（或短碼）不需要 cookie，302 之後是同站請求應該會帶上——但這正是票 0 當初用 Playwright 驗的那類事，不能用推論交差。

### 3.5 🟠 Host allowlist 缺席

`handle()` 用 `new URL(req.url, "http://127.0.0.1:${port}")` 組 URL，完全不看真實 Host；授權只有 `isSameOriginRequest`（Origin==Host）。cloudflared 會把 Host 改成 `*.trycloudflare.com`，Origin==Host 仍成立，所以功能上會動——但**任何 Host 都會被接受**。要照 sol 的規則收斂成：Host ∈ {`127.0.0.1:<port>`, 本次 provider 的 exact external host}。沒有這條，DNS rebinding 類的花招與「另一條 tunnel 指進來」都少了一層阻擋。

### 3.6 🟠 風險確認、設定、reaper 在 pre-fleet 都沒有家

- **逐次風險確認**：sol 是聊天室按鈕。pre-fleet 只能是 **CLI 互動提示**，且 `agend setup --tunnel` 每次都問、`--yes` 要顯式給；**非互動（無 TTY）一律拒絕開 tunnel**，不能預設放行。
- **`allow_public` 與 `web_terminal.tunnel` 設定**：setup 宿主跑在 fleet.yaml 存在之前，**讀不到任何設定**。tunnel 的選擇只能來自 CLI 旗標（`agend setup --tunnel[=cloudflared|localhost]`）。這代表出廠決策「`allow_public: true`」在這條路徑上**沒有載體**，逐次確認就是唯一的閘門——更不能省。
- **lease reaper**：sol 讓 fleet 啟動時跑 reaper。pre-fleet 沒有 fleet。所以 setup 宿主自己啟動時要跑一次 reaper，**而且 fleet 的 reaper 要看得懂 setup 宿主寫下的 lease**（不同 owner、同一份 lease 檔）。這跟票 5 的 `fleet.lock` role 機制要對齊，不要變成第二套互斥。

### 3.7 🟡 其他

- `SETUP_HOST_TTL_MS` 與 `SETUP_HOST_IDLE_MS` 都是 15 分鐘，**idle 永遠不會先於 TTL 觸發**。loopback 下無所謂；公網下建議 TTL 縮短（sol 的 `ttl_minutes: 10` 是合理起點）並讓 idle 真的更短（3 分鐘）。
- 表單背後的 `POST /api/settings/quickstart/probe` 會用使用者提供的 token **對 Telegram／Discord 發外連**，`await-telegram-start` 還是 long-poll。在 gate 後面是安全的，但它提高了 gate 被繞過的代價，也是 idle 計時要正確處理 long-poll 的原因。
- 票 5 的「已有 instances 就拒開」發生在 `start()`，**早於任何 tunnel 建立**——這個順序要保住：先拒絕，再不要 spawn cloudflared。

---

## 4. 調和後的安全信封（實作時要同時成立的守則）

**來自 sol、原樣保留：**
1. tunnel 只是傳輸，**不是授權來源**，不碰 fleet 的長期 `web.token`。
2. 固定 argv、無 shell、不自動下載安裝、`--no-autoupdate --config /dev/null`。
3. 嚴格 URL 驗證：只接受 `https://<single-label>.trycloudflare.com/`，不得有 userinfo／非預設 port／query／fragment／額外 path；child 輸出只在有界記憶體解析，不原樣進 log。
4. **readiness 必須是對已驗證 URL 的無副作用 HTTPS GET**，拿到 200 + 預期 content type + 頁面標記才算 ready；spawn 成功、程序還活、看到一段 URL 都不算。
5. 整段 startup 共用單一 30 秒 wall-clock deadline（不是每步各自重置）。
6. 可取消的 single-flight；一個 cleanup owner；stop 必須有**正面死亡證據**（觀察到 `exit`/`close`，或強指紋證明原 PID 已消失）；無法確認 → 寫 `tunnel_cleanup_failed`、保留 lease、明確警告，**不得顯示「已安全關閉」**。
7. lease 檔 0600 原子寫入，不含 token／cookie／完整 page path；PID 不符絕不送 signal。
8. provider 中途死亡 → 關閉 session，**不旋轉 hostname、不重發 token**。
9. 只記 public host，不記完整 URL、不記 child stdout、不記 token／cookie。
10. 每次建立公網通道都要**逐次風險確認**，`allow_public` 預設 true 不能省。

**來自票 5、原樣保留：**
11. 授權走**這次 `agend setup` 產生的一次性 setup token**，不是長期 web.token。
12. Origin==Host；HttpOnly cookie；`Referrer-Policy: no-referrer`；`Vary: Cookie`。
13. 宿主 TTL + 閒置自退；`setup-complete` 標記；**已有 instances 一律拒開**。
14. import graph 不得到得了 fleet-manager／daemon／instance-lifecycle（`tests/prefleet-host.test.ts` 已在守）。
15. 交出埠之前 `closeAllConnections()` 再 `close()`，之後才 spawn fleet。
16. `fleet.lock` 帶 role，雙向互斥。

**只有組合才需要的新守則（本文件新增）：**
17. **tunnel 模式下 listener 綁 `127.0.0.1:0` 臨時埠**，fleet 的 health port 永遠不在 tunnel 後面（§3.1）。
18. **確認 tunnel 死亡之後才 spawn fleet**；無法確認則不 spawn，寫清楚要人工處理什麼（待裁 T2）。
19. **token 不得在 GET 的 query 裡被兌換**（§3.2）——改成短碼手輸入（T1 傾向 (ii)），或至少讓連結預覽無法造成副作用。
20. token 比較用 `timingSafeEqual`；**加上硬性錯誤次數上限**（三次，全宿主計數，不是每 IP）。
21. cookie 的 Secure 由**已驗證的 endpoint scheme** 決定，不信 `X-Forwarded-Proto`。
22. Host allowlist：{loopback, 本次 exact external host}。
23. 風險確認只能在 CLI；**無 TTY 一律拒絕**開公網通道。
24. setup 宿主啟動時自己跑一次 lease reaper；fleet 的 reaper 認得 setup 宿主寫的 lease。
25. 公網模式縮短 TTL／idle。

---

## 5. Stage 拆分

每個 stage 一個 PR、可獨立 review、獨立 merge。**stage 1 對 production 是純新增**（沒有呼叫端），stage 2 之前 `agend setup` 的行為完全不變。

### Stage 1 — tunnel provider 本體（不接任何呼叫端）

`TunnelProvider` / `TunnelHandle` / `TunnelStartContext` 介面（照 sol §4）、`CloudflaredProvider`、嚴格 URL validator、readiness probe、single-flight + 可取消 start、confirmed stop、lease 檔與 reaper、事件。設定 schema `web_terminal.tunnel`（含 `allow_public` 必須是未加引號 boolean、載入時 fail closed）。**只做 `cloudflared` 與 `localhost`／`none`；tailscale 與 ngrok 這票不做**（sol 設計留著，之後另開）。

驗收（對應 sol §13 的 1–6、11、12）：
- fake provider 證明啟動順序：listener → tunnel → URL ready **之後**才可能送 token。
- 兩個並行 start 只有一個拿到 lease；stale callback 不得關掉新 handle。
- shutdown 落在 preflight／spawn／URL parse／public GET 各階段，最後都只有一個 cleanup owner。
- child 已 spawn 後 startup timeout：**只有 confirmed exit 才 fallback**；unknown 必須 fail closed 並保留 lease。
- 惡意 child 輸出（多餘 query／userinfo／path／ANSI／超長行／別的網域）全部拒絕。
- crash 後留一筆 lease，reaper 能依強指紋回收；**PID 被重用時不得送 signal**（要有測試）。
- binary 不存在／不可執行 → 不 spawn，明確訊息。

### Stage 2 — setup 宿主的公網化前置硬化（**還不接 tunnel**）

先把 §3.4／§3.5 那些「loopback 才成立」的東西補好，**在還沒有任何外網可達性的情況下**，這樣 stage 3 打開通道時信封已經是對的。

- `timingSafeEqual` + 固定長度比較；三次錯誤上限（全宿主計數）；超過即關閉宿主。
- cookie Secure 由 endpoint scheme 決定。
- Host allowlist（此 stage 只有 loopback 一個成員）。
- 憑證交付改成 **T1 裁定的形式**（若採 (ii)：URL 不帶 token，CLI 印短碼，頁面輸入）。
- TTL／idle 分離，idle 真的比 TTL 短；long-poll 正確 touch。

驗收：
- 錯三次後宿主關閉、第四次得到 gone；**平行三個錯誤只觸發一次關閉**（照 sol §13.9）。
- `GET` 任何路徑都不再消耗嘗試次數、不建立 cookie（連結預覽安全性的回歸測試）。
- 偽造 `X-Forwarded-Proto` 不能讓 cookie 變 Secure 也不能讓它不變。
- Origin mismatch、未列入 allowlist 的 Host、重放已用短碼全部拒絕。
- 既有 `tests/prefleet-host.test.ts`（import graph）與 takeover/lock 測試不變。

### Stage 3 — 用 tunnel front setup 宿主

`agend setup --tunnel`；tunnel 模式改綁 `127.0.0.1:0`（§3.1）；Host allowlist 加入 exact external host；關閉順序改為 撤銷 → 關 listener → **confirmed tunnel death** → spawn fleet；setup 宿主啟動時跑 reaper；收尾 UX 改成「dashboard 連結會發到頻道」。

驗收：
- **埠交接**：finish 後，在 fleet 被 spawn **之前**，tunnel 已 confirmed 死亡；用 fake provider 讓 stop 回 unconfirmed，斷言 **fleet 沒有被 spawn**、lease 保留、訊息說清楚（這條是 §3.1 的核心，mutation：把順序對調或忽略 unconfirmed，必須紅）。
- tunnel 模式下 listener 不是 health port（mutation：改回 health port 要紅）。
- TTL、idle、Ctrl-C、finish、`start()` 失敗五條路都關 listener、停 provider、拿到正面死亡證據。
- 對 `/`、`/setup/status`、`/setup/finish`、quickstart API 以外的 path 一律 404；tunnel 進來的請求碰不到任何 fleet 介面（此時本來就沒有 fleet，但要有測試釘住 path allowlist）。
- 真 cloudflared 驗收：手機從外網打得開、完成設定、fleet 起來、URL 不再抵達 origin、child 已退出。

### Stage 4 — UX 與逐次風險確認

CLI 互動確認文案（照 sol 的建議文案改寫成 pre-fleet 版本：**沒有第二則訊息可以分開送**這件事要誠實寫進去）；無 TTY 拒絕；fallback 文案（cloudflared 未安裝時**明講手機打不開**，不能只丟一個 localhost URL）；`docs/configuration.md`／`docs/cli.md`／CHANGELOG。

驗收：
- 每次都問，`--yes` 才跳過；**無 TTY 一律拒絕**（mutation：無 TTY 時預設放行要紅）。
- `allow_public` 相關語意在 pre-fleet 沒有載體這件事寫在文件裡，不要留下「設定過就不用確認」的想像空間。
- fallback 訊息含「手機通常無法直接開」。

---

## 6. 要裁的取捨（我不自己拍）

**T1 — 憑證怎麼送到手機？**（§3.3、§3.2）
pre-fleet 沒有第二條通道，sol 的「URL 與 token 分兩則送」搬不過來。
- (i) 接受 URL 即憑證（改動最小，但連結預覽問題必須另解，且一條被轉傳的訊息就是完整授權）。
- (ii) **URL 不帶憑證 + CLI 印短碼、頁面手輸入**（我建議這條）：救回「URL 不是憑證」、順帶解掉預覽消耗 token、代價是手機要打 8 個字。需搭配硬 lockout。
- (iii) 終端機二次確認：逃生艙情境下使用者可能只有手機，不可行。

**T2 — tunnel 死亡無法確認時，還要不要 spawn fleet？**（§3.1）
我的傾向：**不 spawn**（fail closed），設定已寫入，告訴使用者到主機上跑 `agend start`。代價很硬：逃生艙的最後一步在使用者只有手機時失敗。若採 §3.1 的臨時埠設計，殘留 tunnel 只指向死埠，風險大幅下降——**是否因此改為「警告但照常 spawn」，請裁**。

**T3 — 臨時埠 vs 保留 health port。**（§3.1）
臨時埠讓「tunnel 活過交接」在結構上不可能，代價是票 5 的 `waitForFleet()` 收尾 UX 要改寫成「連結會發到頻道」。我認為值得且本來就更正確，但這會動到已 merge 的票 5 行為，**請確認**。

**T4 — 這票要不要一併做 Web Terminal 的接線？**
stage 1 的 provider 是 sol 為 Web Terminal 設計的。本計畫只把它接到 setup 宿主，Web Terminal 的 `/login` 接線留給原設計。好處是這票的攻擊面只有一個入口；壞處是 provider 會有一段時間只有一個消費者。**傾向：這票不接 Web Terminal。**

**T5 — tailscale／ngrok。**
sol 設計涵蓋三個 provider。我建議這票只做 cloudflared + localhost/none，tailscale 的 Serve mapping 語意（不得覆寫既有 mapping、不得 `reset`、要查 status 正面確認）是另一組獨立的正確性負擔，混在最敏感的這票裡不利於 review。
