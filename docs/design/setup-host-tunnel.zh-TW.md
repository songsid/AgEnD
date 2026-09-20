# 逃生艙 setup 宿主的對外通道：設計與分階段計畫

狀態：**設計已通過 fable 安全 review，S1 可實作**。T1／T3／T4／T5 由 leader 裁定、T2 由 fable 裁定，全部折入本文（見 §6）。fable 另抓到第七個攻擊面（§3.8）與三條補強，也已折入。本文件回答三件事：cloudflared tunnel provider 目前的實作狀態、sol 的 tunnel 設計與票 5 setup 宿主兩份安全信封要怎麼同時成立、以及可逐段 review 的 stage 拆分。最後一節列出**我不自己拍、要 leader／fable 裁的取捨**。

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

以下七條**不在 sol 的文件裡，也不在票 5 的信封裡**，只有「外網可達的 pre-fleet 宿主」這個組合才存在。§3.8 更特別：它是 T1 的裁示**自己造出來**的，在裁定之前不存在。

### 3.1 🔴 埠交接：tunnel 活過 setup 宿主 = 公網直通 fleet dashboard

sol 的隔離論證是「**埠本身就是 capability boundary**」——每個 session 自己的臨時埠，只服務那個 session 的 path，所以 tunnel 就算把該埠所有 path 都轉進來也跨不到 dashboard。

setup 宿主不成立：它綁的是 **health port**，而 `shutdown(true, "finished")` 的最後一步就是 **spawn fleet**，而 fleet 會綁**同一個埠**跑 dashboard／health／Settings／`/api/*`。

於是：**只要 tunnel 在 fleet 綁上該埠時還活著，那條公網 URL 就從「一個設定表單」變成「整個 fleet 的控制台」**，而且是在任何 fleet 層級的存取控制決策發生之前。cloudflared 的 Quick Tunnel 沒有 SLA、可能在我們沒觀察到 exit 的情況下續命，sol 自己也寫了「無法確認死亡就保留 lease」——那個 unknown 狀態在 Web Terminal 只是「不能再開新 tunnel」，在這裡是「公網 URL 指向 dashboard」。

**採用的解法不是加強關閉順序，而是讓這個危險在結構上不存在**（T3 已裁定）：tunnel 模式下 setup 宿主**改綁 `127.0.0.1:0` 臨時埠**，跟 Web Terminal 一樣。fleet 的 health port 從頭到尾不在 tunnel 後面，殘留 tunnel 只會指向一個沒人會再綁的死埠。

連帶：**`agend setup --tunnel` 與 `--port` 互斥**，tunnel 模式下給 `--port` 要直接報錯、不是忽略。

但 `--port` 只是三個來源之一。`cli.ts:1637` 現在是 `Number(opts.port ?? fleet.health_port ?? 19280)`——**所以 tunnel 模式必須連 `fleet.health_port` 與 19280 預設都不看，直接 bind 0**。否則一個已經有 `health_port:` 的 fleet.yaml，使用者沒給 `--port`、只給了 `--tunnel`，照樣會把 health port 放回 tunnel 後面，而且完全沒有旗標可以怪。

另外：**cloudflared 缺失而 fallback 到 localhost 時，宿主仍然留在臨時埠**。T3 是「tunnel 模式」的性質，不是「tunnel 成功」的性質，不受 fallback 影響。

代價是票 5 的收尾 UX 會變：`setup-form.ts` 的 `waitForFleet()` 現在靠「fleet 綁同一個埠、前端輪詢 `/health`」顯示「AgEnD is up」。臨時埠下這條斷掉。

收尾文案**不能承諾「dashboard 連結會發到頻道」**：dashboard 仍然只綁 loopback，手機就算收到連結也打不開。誠實的說法是「**AgEnD 已啟動，請在你剛設定的頻道跟它對話**」——頻道就是逃生艙交付的東西，dashboard 是之後在主機（或自行轉發）上的事。

即使採用臨時埠，**關閉順序仍要是**：撤銷憑證 → 關 listener（含 `closeAllConnections`）→ **確認 tunnel 死亡** → 才 spawn fleet。無法確認時的處置見 §6 T2（fable 裁定：條件式的「警告但照常 spawn」）。

臨時埠也**不是絕對安全**：之後任何 `bind 127.0.0.1:0` 的 listener 都可能拿到同一個埠號，殭屍 tunnel 就會 front 它。收掉這條要靠信封第 31 條（所有 fleet 側臨時埠 listener 一律做 Host allowlist）。

### 3.2 🔴 連結預覽會把一次性 token 花掉（而且是必然發生）

sol §9.2 的安全論證核心是「`GET` 沒有副作用，所以 bot 抓連結不會消耗 token、不會建立 cookie」。

setup 宿主的 `GET /?token=…` **有副作用**：`tokenRedeemed = true`、`Set-Cookie`、302。而這條 URL 唯一的送達方式就是被人貼到某處（見 §3.3）。Telegram／Discord／Slack／iMessage 的預覽 bot 一抓，**token 就被兌換掉了，人再點開拿到 401「run `agend setup` again」**。

這不是機率問題，是「把連結貼進聊天室就必然發生」。而且那個預覽 bot 現在手上有一個有效的 session cookie（cookie 值是 `sha256(token)` 的決定性推導，見 `web-auth.ts:106`）。

任何「把 setup 連結傳給手機」的做法都必須先解掉這條。**T1 裁定的 (ii) 解掉了它**：URL 不帶憑證，預覽 bot 抓到的只是一個輸入框。

### 3.3 🔴 pre-fleet 沒有第二條通道，sol 的「URL 不是憑證」在這裡不成立

sol 靠「URL 一則 DM、token 另一則 DM」把 URL 降級成非憑證。**setup 宿主執行時沒有任何 DM 通道**——bot token 還沒設定，fleet 還沒起來。唯一的輸出是 `agend setup` 那個終端機的 stdout。

所以 tunnel URL 與 token 只能一起出現在同一個地方，**URL 就是憑證**。sol 全篇最重要的那條性質在移植過來時消失了，而這個表單的能力（寫 .env、spawn fleet）比一個終端機 session 更高。

**裁定：(ii)**——tunnel URL 不帶 token，CLI 另外印一段短碼，使用者在頁面上手輸入。搭配硬 lockout（三次），8 字元 base32（40 bits）的猜中上界是 `3/2^40 ≈ 2.7e-12`，用 sol 自己的算法就夠。這條把「URL 不是憑證」救回來，也順帶解掉 §3.2。

（另外兩條已排除：(i) 接受 URL 即憑證——一條被轉傳的訊息就是完整授權；(iii) 終端機二次確認——逃生艙情境下使用者可能只有手機。）

### 3.3.1 🔴 (ii) 的二階後果：表單不能擺在 tunnel 根路徑

URL 不再是憑證，代表**任何知道那個 hostname 的人都能拿到表單並開始試碼**。而 §3.4 要加的硬 lockout 是三次——於是出現一條 (i) 沒有的新路徑：**遠端阻斷設定**。隨便一個掃到 hostname 的人打三次錯碼，宿主就關了，使用者必須回主機重跑 `agend setup`——而「只有手機」正是這個逃生艙存在的理由。

sol 的 Web Terminal 沒有這個問題，因為它的頁面在 `/t/<128-bit sid>/`：掃描者連頁面都找不到。**我們把表單放在 `/` 就等於丟掉這層。**

所以 (ii) 必須配套：**setup 表單也放在一段隨機路徑下**，例如 `https://<random>.trycloudflare.com/s/<128-bit sid>/`。sid 一樣**不是憑證**（憑證是短碼），它的作用只有一個：讓掃描者找不到門，因此點不到那三次 lockout。UX 成本為零（URL 本來就是複製貼上或掃 QR）。

對應的規則：sid 以外的路徑一律 404；`/` 也 404，不做任何提示。lockout 只在 sid 正確的請求上計數，否則掃描者仍可用亂猜的 sid 消耗額度。

**sid 擋的是掃描者，不是拿到連結的人。** 連結本身含 sid，所以聊天室裡任何看得到它的人仍然可以故意錯 5 次把宿主鎖死——這是 sol §9.1 同一個**刻意接受**的殘餘風險，不是這條配套能解的。誠實寫下來，並在 S4 文案加一句「**別把這條連結貼進多人群組**」。

另外三條實作細節，漏掉就走樣：
- **sid 比對也要 `timingSafeEqual`**。
- **錯 sid 的 404 必須與其他 404 完全不可區分**（狀態碼、header、body 都一樣），否則 sid 可以被差異探測出來。
- **錯 sid 的請求不得 `touch()` idle 計時**——否則掃描者雖然鎖不死宿主，卻能讓它永遠不 idle 關閉，把一個十分鐘的視窗變成無限。所以 sid 檢查要在 `authorize()` 裡面；票 5 已經把 `touch()` 移到 authorize 之後，順序是對的。
- cookie 的 `Path` 綁 `/s/<sid>/`，跟 sol 一致。

（這條**不取代** §3.8：拿到連結的人同時就有 sid，如果 cookie 還是由 40-bit 短碼推導又不計次，猜 cookie 這條路照樣開著。第 28 條的解耦仍然是必改。）

短碼形狀：**8 字元 base32，顯示成 `XXXX-XXXX`，輸入忽略大小寫與連字號**。**lockout 次數定 5**（手機上打 8 個字，5 次比 3 次不容易誤鎖；`5/2^40 ≈ 4.5e-12` 仍可忽略）。這個 DoS 後果要寫進 S4 文案：**任何拿到 URL 的人都能故意錯 5 次讓宿主自毀，之後只能回主機重跑 `agend setup`。**

### 3.8 🔴 cookie 仍由憑證推導，而憑證剛從 192 bits 縮成 40（fable 抓到）

T1(ii) 把憑證從 `randomBytes(24)`（192 bits）換成 8 字元短碼（40 bits），但 cookie 的值仍是**憑證的決定性推導**（`web-auth.ts:106`，`sha256("agend-web-session-v1:" + token)`）。於是 cookie 也只剩 40 bits 的熵。

而 lockout 只管「短碼那條 POST」——**cookie 比對這條路徑沒有任何次數上限**。攻擊者拿到 URL 後根本不必猜短碼：直接帶著候選 cookie 去打受保護路徑，而且候選可以**離線預算**（`sha256` 一個已知前綴，不需要跟伺服器互動就能把 2^40 個 cookie 值算好）。10 分鐘 TTL 內約 6×10⁵ 次請求，成功率約 5×10⁻⁷ —— **比 T1 宣稱的 `3/2^40 ≈ 2.7e-12` 差五個數量級**，而那個宣稱正是接受 40 bits 的理由。

**修法就是 sol 原本的設計**：短碼只是**兌換鍵**，不是 session 憑證。兌換成功時另外產生一個 **256-bit 隨機 session secret**，cookie 帶它的 hash，比對用 `timingSafeEqual`。並且**所有認證失敗共用同一個 lockout 計數**——短碼錯、cookie 不符、sid 正確但憑證不對，全部計進同一個 counter。

（這條的教訓值得寫下來：`webSessionCookieValue()` 從 token 推導 cookie，在 192 bits 的世界裡是個安全的簡化；把憑證縮短就把它變成漏洞。**推導式 cookie 的安全性上限等於它所推導的那個憑證**，換憑證長度時必須重新檢查每一個推導物。）

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
- **信任邊界比 sol 的情境更高**：commit 送出的是**長效 bot token 與 admin id**，而 TLS 在 Cloudflare edge 終止。sol §9.3 那句「Cloudflare 理論上可處理 `/open` 的 token 與終端流量」在這裡要升級成 **「你的 bot token 會經過 Cloudflare 傳輸」**，S4 的風險確認文案必須明講，不能沿用終端 session 的說法。

---

## 4. 調和後的安全信封（實作時要同時成立的 31 條）

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

**只有組合才需要的新守則（本文件新增，17–31）：**
17. **tunnel 模式下 listener 綁 `127.0.0.1:0` 臨時埠**，fleet 的 health port 永遠不在 tunnel 後面（§3.1，T3 裁定）。`--tunnel` 與 `--port` 互斥。
18. **確認 tunnel 死亡之後才 spawn fleet**；無法確認時的處置**待 fable 裁定**（T2）。無論裁定為何，「無法確認」都要寫 `tunnel_cleanup_failed`、保留 lease、明確告知。
19. **憑證不在 URL 裡**（§3.3，T1 裁定 (ii)）：URL 不帶 token，CLI 印短碼（8 字元 base32，顯示 `XXXX-XXXX`，輸入忽略大小寫與連字號），使用者在頁面輸入。**GET 任何路徑都不得有副作用**——不消耗嘗試次數、不建立 cookie。表單掛在 `/s/<128-bit sid>/` 之下（§3.3.1）：sid 不是憑證，但沒有它，掃描者就能用錯誤次數遠端阻斷設定；sid 不符一律 404 且**不計入 lockout**，對錯 sid 的回應不可區分。
20. token 比較用 `timingSafeEqual`；**加上硬性錯誤次數上限**（三次，全宿主計數，不是每 IP）。
21. cookie 的 Secure 由**已驗證的 endpoint scheme** 決定，不信 `X-Forwarded-Proto`。
22. Host allowlist：{loopback, 本次 exact external host}。
23. 風險確認只能在 CLI；**無 TTY 一律拒絕**開公網通道。
24. setup 宿主啟動時自己跑一次 lease reaper；fleet 的 reaper 認得 setup 宿主寫的 lease。
25. 公網模式縮短 TTL／idle，並修掉 `TTL == IDLE` 導致 idle 永不觸發這個既有 bug（§3.7）。
26. **表單掛在 `/s/<128-bit sid>/` 之下**（§3.3.1）：sid **不是憑證**，它擋的是掃描者而不是拿到連結的人。sid 比對也用 `timingSafeEqual`；sid 不符的 404 與其他 404 在狀態碼、header 與 body 上**完全不可區分**；sid 不符**不計入 lockout**，也**不得 touch idle 計時**（否則掃描者鎖不死宿主，卻能讓它永遠不 idle 關閉）——所以 sid 檢查必須在 `authorize()` 之內，票 5 已經把 `touch()` 移到 authorize 之後。cookie 的 `Path` 綁 `/s/<sid>/`。
27. 範圍：只做 `cloudflared` 與 `localhost`／`none`（T5）；這票不接 Web Terminal（T4）。
28. **cookie 的 secret 與短碼解耦**（§3.8）：短碼只是兌換鍵；兌換成功時另生 **256-bit 隨機 session secret**，cookie 帶它的 hash，比對用 `timingSafeEqual`。**所有認證失敗共用同一個 lockout 計數**（短碼錯、cookie 不符、憑證不對），次數 **5**。
29. **未認證公開面最小化**：`GET /s/<sid>/`（靜態短碼輸入頁）與兌換用的 POST 是**唯二**不需要 cookie 的端點。`/api/settings/quickstart/environment`（會回報這台機器裝了哪些 backend、既有 channel）、`/probe`、`/plan`、`/commit`、`/setup/finish` **一律要 cookie**。**每一個回應都要 `Cache-Control: no-store`**——目前只有 302 有，其餘可能被 Cloudflare edge 快取。
30. **cloudflared 子程序給最小環境變數**：它會繼承 `agend setup` 那個 shell 的完整環境，其中可能有雲端憑證。固定 argv 之外還要濾成 allow-list（只留 proxy／CA 相關），不是原樣 `process.env`。
31. **所有 fleet 側的臨時埠 listener 一律做 Host allowlist**（§3.1 的依賴）：臨時埠「只指向死埠」不是絕對——之後任何 `bind 127.0.0.1:0` 的 listener（Web Terminal 每 session 一個）可能拿到同一個埠號，殭屍 tunnel 就會 front 它。真正收掉這條靠 Host allowlist：殭屍 tunnel 的 host 不在新 session 的名單裡 → 403。**T3 與 T2 的安全論證都依賴這條。**

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
- **reaper 可以從非 fleet 程序呼叫**（setup 宿主啟動時就要跑一次），並有測試從一個沒有 FleetManager 的情境呼叫它。
- 子程序拿到的是 **allow-list 過的最小環境變數**，不是 `process.env`（信封 30；mutation：改成原樣繼承要紅）。

**S1 不做**：`web_terminal.tunnel` 設定 schema。T4 不接 Web Terminal、而 setup 宿主在 fleet.yaml 存在之前跑（§3.6），所以這票裡那組設定**沒有任何消費者**；加一組沒人讀的設定介面比不加更糟。等 Web Terminal 接線那票再一起做。

### Stage 2 — setup 宿主的公網化前置硬化（**還不接 tunnel**）

先把 §3.4／§3.5 那些「loopback 才成立」的東西補好，**在還沒有任何外網可達性的情況下**，這樣 stage 3 打開通道時信封已經是對的。

- `timingSafeEqual` + 固定長度比較；三次錯誤上限（全宿主計數）；超過即關閉宿主。
- cookie Secure 由 endpoint scheme 決定。
- Host allowlist（此 stage 只有 loopback 一個成員）。
- 憑證交付改成 **(ii)**：URL 不帶 token，CLI 印短碼，頁面輸入。
- 表單改掛在 `/s/<128-bit sid>/` 之下（§3.3.1），sid 不符一律 404 且不計入 lockout。
- TTL／idle 分離，**修掉 `TTL == IDLE` 導致 idle 永不觸發**；long-poll 正確 touch。

驗收：
- **cookie 與短碼解耦**（信封 28）：兩條 mutation 都要紅 ——「cookie 由短碼推導」、「cookie 比對失敗不計入 lockout」。
- 錯 **5** 次後宿主關閉、第 6 次得到 gone；**平行的錯誤只觸發一次關閉**（照 sol §13.9）；**短碼錯與 cookie 錯共用同一個計數**。
- **錯的 sid 不消耗 lockout 額度**，且與對的 sid 在回應上不可區分（都是 404）——否則掃描者既能遠端阻斷設定，也能靠差異探測 sid。
- 短碼**忽略大小寫與連字號**；`XXXX-XXXX` 與 `xxxxxxxx` 等價。
- **公開面最小**（信封 29）：未帶 cookie 打 `/environment`、`/probe`、`/plan`、`/commit`、`/setup/finish` 全部 401；只有 `GET /s/<sid>/` 與兌換 POST 例外。
- **每個回應都有 `Cache-Control: no-store`**（不只 302）。
- `GET` 任何路徑都不再消耗嘗試次數、不建立 cookie（連結預覽安全性的回歸測試）。
- 偽造 `X-Forwarded-Proto` 不能讓 cookie 變 Secure 也不能讓它不變。
- Origin mismatch、未列入 allowlist 的 Host、重放已用短碼全部拒絕。
- **TTL 與 idle 分離**，idle 真的會先觸發（現況 `TTL == IDLE == 15min` 讓 idle 永不觸發，是既有 bug）。
- 既有 `tests/prefleet-host.test.ts`（import graph）與 takeover/lock 測試不變。

### Stage 3 — 用 tunnel front setup 宿主

`agend setup --tunnel`（與 `--port` 互斥，給了要報錯）；tunnel 模式改綁 `127.0.0.1:0`（§3.1）；Host allowlist 加入 exact external host；關閉順序改為 撤銷 → 關 listener → **confirmed tunnel death** → spawn fleet；setup 宿主啟動時跑 reaper；收尾 UX 改成「dashboard 連結會發到頻道」。

驗收：
- **埠交接**：finish 後，在 fleet 被 spawn **之前**，tunnel 已 confirmed 死亡；用 fake provider 讓 stop 回 unconfirmed，斷言 **fleet 沒有被 spawn**、lease 保留、訊息說清楚（這條是 §3.1 的核心，mutation：把順序對調或忽略 unconfirmed，必須紅）。
- tunnel 模式下 listener 不是 health port，**mutation 要明確涵蓋隱含來源**：fleet.yaml 有 `health_port:` + 不給 `--port` + 開 `--tunnel` → 綁到的必須是臨時埠（把 `?? fleet.health_port` 放回去要紅）。`--port` 與 `--tunnel` 同時給要報錯。cloudflared 缺失 fallback 到 localhost 時仍是臨時埠。
- TTL、idle、Ctrl-C、finish、`start()` 失敗五條路都關 listener、停 provider、拿到正面死亡證據。
- 對 `/`、`/setup/status`、`/setup/finish`、quickstart API 以外的 path 一律 404；tunnel 進來的請求碰不到任何 fleet 介面（此時本來就沒有 fleet，但要有測試釘住 path allowlist）。
- **T2 的五個條件各一條斷言**：非臨時埠模式下 unconfirmed → 不 spawn（條件 1 的自動失效）；listener 已確認關閉；憑證已撤銷；lease 保留且記 `tunnel_cleanup_failed`、fleet 起來前不得再開 managed tunnel；訊息含 PID 且**不含「已安全關閉」字樣**。
- **殭屍 tunnel 對重用埠號**：起一個 fake listener 綁到同一個埠號，用舊 tunnel 的 Host 打它 → **403**（信封 31）。
- 收尾文案**不承諾 dashboard 連結**，而是「請在你剛設定的頻道跟它對話」（mutation：改回承諾連結要紅）。
- 真 cloudflared 驗收：手機從外網打得開、完成設定、fleet 起來、URL 不再抵達 origin、child 已退出。

### Stage 4 — UX 與逐次風險確認

CLI 互動確認文案（照 sol 的建議文案改寫成 pre-fleet 版本：**沒有第二則訊息可以分開送**這件事要誠實寫進去）；無 TTY 拒絕；fallback 文案（cloudflared 未安裝時**明講手機打不開**，不能只丟一個 localhost URL）；`docs/configuration.md`／`docs/cli.md`／CHANGELOG。

驗收：
- 每次都問，`--yes` 才跳過；**無 TTY 一律拒絕**（mutation：無 TTY 時預設放行要紅）。
- `allow_public` 相關語意在 pre-fleet 沒有載體這件事寫在文件裡，不要留下「設定過就不用確認」的想像空間。
- fallback 訊息含「手機通常無法直接開」。
- 風險確認文案含 **「你的 bot token 會經過 Cloudflare 傳輸」**（§3.7 信任邊界升級），不是沿用 sol 那句終端 session 的說法。
- 文案含 lockout 的 DoS 後果：**任何拿到 URL 的人都能故意錯 5 次讓宿主自毀，之後只能回主機重跑 `agend setup`**，並提醒**別把這條連結貼進多人群組**。

---

## 6. 取捨與裁示

**T1 — 憑證怎麼送到手機？→ 裁定 (ii)**（§3.3）
URL 不帶憑證，CLI 印短碼，使用者在頁面手輸入。同時解掉「URL 即憑證」與「預覽 bot 燒掉 token」兩個 🔴。**連帶產生 §3.3.1**（表單要掛在隨機 sid 之下），那條是這個裁示的必要配套，不是可選項。

**T2 — tunnel 死亡無法確認時，還要不要 spawn fleet？→ fable 裁定：警告但照常 spawn，但這是一個條件式裁示**（§3.1）

裁定成立**只在下列五項同時為真時**，缺一即回 fail-closed（不 spawn）：

1. **T3 臨時埠模式**——宿主綁的是 `127.0.0.1:0`，不是 health port。
2. **listener 已確認關閉**（`closeAllConnections()` + `close()` 都完成）。
3. **憑證已撤銷**——session secret 與 cookie 已失效，短碼已作廢。
4. **lease 保留並記 `tunnel_cleanup_failed`**；在 fleet 起來之前不得再開任何新的 managed tunnel。
5. **訊息誠實**——明講「通道未能確認關閉，那條 URL 可能還會回 unavailable 一陣子；要手動處理請 kill PID x」。**不得寫「已安全關閉」。**

**條件式的意思是這是文件裡的一條規則，不是一次性的結論**：若日後有人把宿主改回綁 health port（或讓 `--port` 在 tunnel 模式下生效），本裁示**自動失效**，該路徑必須回到 fail-closed。實作時這要是程式裡的一個顯式判斷（「我現在是臨時埠嗎？」），不是註解裡的假設。

裁示還依賴信封第 31 條：臨時埠可能被之後的 listener 重用，殭屍 tunnel 會 front 它；靠 Host allowlist 讓它拿到 403。

**T3 — 臨時埠 → 裁定採用**（§3.1）
tunnel 模式綁 `127.0.0.1:0`，health port 從頭到尾不在 tunnel 後面。票 5 的 `waitForFleet()` 改成「dashboard 連結會發到頻道」。`--tunnel` 與 `--port` 互斥。

**T4 — 不接 Web Terminal。** provider 先只有一個消費者，換這票的攻擊面只有一個入口。

**T5 — 只做 cloudflared + localhost／none。** tailscale 的 Serve mapping 語意是另一組獨立的正確性負擔，不混進最敏感的這票。
