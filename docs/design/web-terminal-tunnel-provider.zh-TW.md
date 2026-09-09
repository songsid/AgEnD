# Web Terminal 階段三：對外通道設計

狀態：待決策的實作前設計稿。本文件只定義邊界、生命週期與驗收條件，不接上 `/login` 或 `/install-cli`，也不進入發布分支。實際接線必須等本地 Web Terminal 流程驗收通過後再進行。

## 1. 結論

Web Terminal 維持「每個 session 一個 `127.0.0.1:0` listener」的既有隔離。階段三只在 listener 外面加一個可替換的通道提供者；預設提供者是 Cloudflare Quick Tunnel，產生短效的 `https://*.trycloudflare.com` 公網網址。通道只轉送到該次 session 的 loopback port，不接 dashboard、health server 或其他 session。

公網網址不是憑證。真正的授權仍由 Web Terminal 既有 token gate 完成：網址與 access token 分兩則訊息送達，token 一次性、有效熵 100 bits、全 session 合計錯三次即銷毀 session，成功後改用 host-only、session-bound、HttpOnly、SameSite=Strict、Secure cookie。`GET` 頁面與資產完全沒有副作用，連結預覽不會消耗 token、啟動終端或建立 cookie。

通道與 session 採一對一 ownership。通道啟動、停止與 cleanup 都是可取消的 single-flight；只有取得可驗證的 public URL 並從該 URL 成功讀到本 session 頁面，才算 ready。停止只有在 provider 前景程序的 `exit`/`close` 已被父程序觀察，或強指紋探測證明原程序已不存在時，才回報 confirmed。超時或無法判斷不會偽裝成成功，而會保留 cleanup lease、阻止下一個 managed tunnel，並發出明確警告。

## 2. 範圍與不做的事

本階段只處理 Web Terminal listener 的可達性，不改 tmux 輸入橋、token gate、admin gate、單一 login/install window、CLI flow allowlist 或成功判定。Cloudflare、Tailscale 與 ngrok 都只是傳輸層，不成為 AgEnD 的授權來源，也不接觸 fleet 的長期 web token。

Quick Tunnel 是短效、無帳號、無 SLA 的服務。Cloudflare 官方把它定位為開發與測試用途，並標示 200 個 concurrent request 上限及不支援 SSE；Web Terminal 使用 WebSocket，且自身最多只接受八條 socket，因此不碰 SSE 限制，也遠低於連線上限。不過無 SLA 代表 provider 中斷必須被當作可預期的失敗，不得把它描述成永久或高可用入口。

本設計不自動安裝或更新任何第三方 binary，不接受使用者提供任意 shell command，也不把 ngrok auth token 或其他 provider secret 寫進 `fleet.yaml`、argv、log 或 eventLog。

## 3. 設定形狀

通道屬於 Web Terminal，而不是只屬於 `/login`，因為 `/install-cli` 會共用同一套引擎。因此設定放在 `web_terminal.tunnel`：

```yaml
web_terminal:
  enabled: true
  ttl_minutes: 10
  tunnel:
    provider: cloudflared     # cloudflared | tailscale | localhost | none | ngrok
    allow_public: true        # cloudflared / ngrok 的總開關；預設 true
    fallback: localhost       # localhost | none
    tailscale:
      https_port: 8443        # 只在 provider=tailscale 時使用
```

`provider` 省略時為 `cloudflared`。`allow_public` 省略時為 `true`，這是「手機從通訊軟體直接開啟」的產品預設；每次建立前仍必須顯示公網風險確認。若設為 `false`，`cloudflared` 與 `ngrok` 一律不得 spawn，直接依 `fallback` 處理。這個欄位必須是未加引號的 boolean，型別錯誤要在載入設定時 fail closed。

五種 provider 的語意如下：

| provider | 可達範圍 | listener | 管理方式 |
|---|---|---|---|
| `cloudflared` | 公網 HTTPS，預設 | 強制 `127.0.0.1:0` | AgEnD 管理一個前景 Quick Tunnel 程序 |
| `tailscale` | tailnet 內 HTTPS | 強制 `127.0.0.1:0` | AgEnD 建立一條專用 `tailscale serve` mapping；不得覆寫既有 mapping |
| `ngrok` | 公網 HTTPS | 強制 `127.0.0.1:0` | AgEnD 管理一個前景 agent；認證沿用使用者既有 ngrok 設定 |
| `localhost` | 僅本機或使用者自己建立的 SSH port-forward | 強制 `127.0.0.1:0` | 不 spawn 第三方程序，回傳 loopback URL |
| `none` | 保留目前的直接連線／自行反向代理模式 | 使用既有 `web_terminal.bind` 與 `hostname` | 不 spawn 第三方程序，不做自動通道管理 |

`localhost` 與 `none` 刻意不同：前者是安全且可預測的 loopback 模式，也是自動 fallback；後者是相容既有部署的手動模式，可能由操作者自行指定 LAN、tailnet IP 或反向代理。從 public provider 降級時只能自動降到 `localhost`，不能自動降到 `none`，避免在失敗時意外改成非 loopback 暴露。

`fallback: none` 表示 provider 啟動失敗時保留直接模式的既有 URL，不是跳過 token gate，也不是關閉 Web Terminal。要完全停用仍使用 `web_terminal.enabled: false`。

設定驗證還要遵守：未知 provider 拒絕；`tailscale.https_port` 只接受 1–65535 的整數；公網 provider 配 `allow_public:false` 時不得短暫 spawn 後才回退；provider-specific secret 不得出現在設定 schema。

公網模式的確認訊息建議固定為：「將開啟一條最長 N 分鐘、可從公網連線的 Cloudflare Quick Tunnel。連結本身沒有登入權限；一次性 access token 會用另一則私訊送達，請勿轉傳任一則訊息。連線內容會經 Cloudflare 傳輸；若不能接受，請改用 Tailscale 或 localhost。」按鈕仍是既有的「我了解，開啟／取消」，不能因 `allow_public` 預設為 true 而省略逐次確認。

## 4. 元件與 ownership

新增介面只描述能力，不讓 LoginController 知道 provider 的命令列細節：

```ts
type TunnelVisibility = "public" | "tailnet" | "loopback" | "manual";

interface TunnelStartContext {
  sid: string;
  origin: URL;          // 必須是 http://127.0.0.1:<ephemeral-port>
  pagePath: string;     // /t/<sid>/，保留結尾斜線
  expiresAt: number;    // 不得晚於 WebTerminalSession TTL
  signal: AbortSignal;
}

interface TunnelHandle {
  provider: "cloudflared" | "tailscale" | "ngrok";
  visibility: "public" | "tailnet";
  pageUrl: string;
  stop(reason: string): Promise<{ confirmed: true }>;
  onUnexpectedExit(listener: (result: TunnelExit) => void): () => void;
}

interface TunnelProvider {
  preflight(signal: AbortSignal): Promise<PreflightResult>;
  start(ctx: TunnelStartContext): Promise<TunnelHandle>;
}
```

LoginController 的 active entry 擴充為 `{ session, http, tunnel, generation }`。entry 一旦發布，就同時擁有 terminal session、HTTP listener 與 tunnel start/handle。任何 cancel、TTL、完成、token lockout、訊息投遞失敗或 fleet shutdown 都進同一個 `finishEntry()`，第二個呼叫只 join 同一個 promise，不能有多個 cleanup owner。

managed tunnel 另有一把 fleet-wide lease。Web Terminal 本來就只允許一個 login/install window，但 lease 仍獨立存在：若上一個 tunnel 的死亡無法確認，terminal window 可以結束，managed tunnel lease 不得釋放。之後的請求仍可使用 `localhost`，但不得再建立第二個公網／tailnet mapping，直到 reaper 確認舊程序或 mapping 已消失。

## 5. 啟動生命週期

啟動順序如下：

1. Controller 重新驗證 admin、flow allowlist、rate limit、`allow_public` 與 fleet-wide login window lock。公網 provider 的風險文案在這一步確認。
2. provider preflight 在 terminal 啟動前執行，最多五秒。它只檢查 binary 可執行與必要的本機狀態，不自動安裝、不修改 provider 帳號設定。binary 缺失時不建立任何 provider 程序。
3. 啟動 `WebTerminalSession`，再建立獨立的 `127.0.0.1:0` HTTP listener。session TTL 從 terminal 啟動時計算，不因 tunnel 慢而延長。
4. managed provider 取得精確 origin `http://127.0.0.1:<port>` 與剩餘 TTL，開始可取消的 start。整個 tunnel startup 共用單一 30 秒 wall-clock deadline，包含 spawn、取得 URL 與 readiness probe；不是每一步各自重置 30 秒。
5. provider 回傳的網址先做嚴格驗證，再把其 host 加入 listener 的 allowed external hosts。Cloudflare 只接受 `https://<single-label>.trycloudflare.com/`，不得含 userinfo、非預設 port、query、fragment 或額外 path。不能從任意 child output 接受其他網域。
6. AgEnD 對 `<validated-base>/t/<sid>/` 做無副作用的 HTTPS `GET`，要求 200、預期的 content type 與 session marker。這既確認 edge 已能連到精確 listener，也抓得到錯誤 origin、錯 port 與反向代理 Host 行為。probe 只讀頁面，不碰 `/open`，所以不消耗 token attempt。
7. readiness 成功後才送網址，再用另一則 DM 送一次性 token。任一 delivery 失敗均走完整 cleanup。網址必須保留 `/t/<sid>/` 的結尾斜線，避免相對 asset 解析離開 session path。

Cloudflare provider 用固定 argv、無 shell 啟動：

```text
cloudflared tunnel --no-autoupdate --config /dev/null --url http://127.0.0.1:<port>
```

實作前要以目前支援的 cloudflared 版本核對旗標順序；provider 不能拼接 shell 字串。`--no-autoupdate` 避免 session 期間自我替換；明確空 config 避免使用者家目錄裡的 named-tunnel 設定改變 quick tunnel 行為。Cloudflare 官方說明 Quick Tunnel 遇到 `.cloudflared/config.yaml` 可能無法使用，因此不能依賴使用者環境剛好沒有設定檔。保留連線所需的 proxy/CA 環境變數，但 child log 只在有界記憶體中解析，不能原樣寫入 logger。

Cloudflare 會把隨機網址寫到程序輸出。parser 同時接受已知文字與 JSON log 形狀，但最後只信任嚴格 URL validator。spawn 成功、看到程序仍活或看到一段 URL 都不等於 ready；必須完成上面的 public GET。

## 6. 正常關閉與可證明清理

關閉順序以先撤銷能力、再移除傳輸為原則：

1. 將 entry 原子地改成 `closing`，清除 access token 與 cookie，拒絕新的 `/open`、WS 與鍵盤輸入，並關閉目前的 browser WS。
2. 關閉 per-session HTTP listener 並銷毀其 active sockets。從這一刻起，即使 tunnel 程序尚在，public URL 也只能得到 origin unavailable，碰不到 terminal 或其他 AgEnD 服務。
3. 呼叫 `TunnelHandle.stop()`。直接 child 先收 SIGTERM，最多五秒；仍未退出再收 SIGKILL，最多五秒。只有 Node 對該 `ChildProcess` 觀察到 `exit`/`close`，或強指紋探測證明原 PID 已消失／已被重用，才算 confirmed。不能因 `kill()` 呼叫沒有丟錯、timeout、查詢失敗或 provider CLI 回 0 就宣告死亡。
4. Tailscale 不是只看 child：它修改 tailscaled 的 mapping。stop 必須執行與啟動相對應的精確 `off`，再以 `tailscale serve status --json` 正面確認該 port/target mapping 已不存在。不得使用會清掉操作者其他 Serve 設定的全域 `reset`。
5. tunnel confirmed 後，才釋放 managed lease；terminal tmux 的既有 confirmed kill 接著完成。若 tunnel 無法確認死亡，寫 `tunnel_cleanup_failed`、保留持久 lease，向 admin 提供 provider、PID／mapping 與人工清理指引；不能顯示「已安全關閉」。

為處理 fleet crash，managed tunnel start 前以 mode 0600 原子寫入 lease：`sid/provider/originPort/providerPid/strongIdentity/expiresAt/ownerPid`，不含 token、cookie 或完整 page path。正常 confirmed stop 後才刪除。下次 fleet 啟動與每次新 tunnel 前先執行 reaper：listener/session 不存在或 lease 已過期時，依強指紋回收 provider，確認死亡才清 lease。PID 不符代表原程序已死，絕不對重用的 PID 送 signal。Linux 可沿用 Web Terminal 已有的 `/proc/<pid>/stat` starttime 強指紋；缺少同等強指紋的平台只能把 crash-recovery 判成 unknown 並要求人工清理，不能退回程序名稱或秒級啟動時間後盲殺 PID。

正常 TTL／session 結束因此都有正面死亡證據。對「fleet 與 reaper 同時被 SIGKILL」無法做數學上的即時保證；其安全下界是 listener 已隨 fleet 消失，殘留 tunnel 只會指向關閉的 loopback port，且下一次啟動會由 lease reaper 清理。若本地驗收要求 daemon crash 後也立即清程序，可再加一個帶獨立 TTL 與 parent-disconnect watchdog 的小型 supervisor；不應用弱 PID 判斷或 shell trap 假裝已解。

## 7. Provider 中途失效

Cloudflared 自己會在 edge 連線抖動時重連，因此短暫 WebSocket 中斷沿用前端既有 reconnect。若 provider 前景程序真正退出，代表 public hostname 生命週期已結束。已送出的 host-bound cookie 不能安全搬到新 hostname，一次性 token 也可能已消耗，所以本版不自動換一條新 tunnel。

unexpected exit 的處理是：立即撤銷 listener/token/cookie、結束 terminal session、確認 provider 已死、通知 requester「通道中斷，請重新執行 `/login`」。這比悄悄換 URL 或把已授權 session 暴露到另一個 host 更容易推理。若程序在網址與 token 尚未送出前退出，確認死亡後可以走 startup fail-soft。

## 8. 只暴露該 session listener

這個邊界同時由網路與應用兩層保證：

- managed provider 一律只接受由 HTTP server 實際 listen 結果產生的 `http://127.0.0.1:<ephemeral-port>`；schema 不允許使用者提供任意 origin URL。
- 每個 Web Terminal session 有自己的 listener 和 port。該 listener 只有 `/t/<same sid>/`、其 assets、`/open` 與 `/ws`，其他 path 回 404；它沒有 dashboard、health、Settings、usage 或其他 session router。
- tunnel 不連 health port，也不使用 fleet `hostname` 推導 origin。即使外界請求 `/ui`、`/api/fleet` 或另一個 sid，也只會打到這個 per-session listener 並得到 404。
- listener 在 managed provider 下強制 loopback。防火牆沒有新增 inbound port；cloudflared 只建立 outbound connection。
- `/open` 與 WS 除了 `Origin.host === Host`，還要要求 Host 屬於 listener 記錄的 local host 或這次 provider 的 exact external host。provider 不得改寫 Host。Secure cookie 由已驗證 endpoint 的 `https:` 屬性決定，不再只信任可偽造的 `X-Forwarded-Proto`。

這表示 Quick Tunnel 雖然會把該 port 的所有 path 送到 origin，仍不可能藉此跨到 dashboard，因為 port 本身就是 session 的 capability boundary。

## 9. 公網安全論證

### 9.1 未授權取得終端的機率

access token 是 20 個 RFC 4648 base32 字元，實際有效熵為 100 bits。驗證比較固定長度 buffer 並使用 `timingSafeEqual`；長度不符仍先走固定長度比較。整個 session 只有三次錯誤機會，不是每 IP 三次，因此純猜測成功率上界為 `3 / 2^100`，約 `2.37 × 10^-30`。並行 POST 也由同一個 session state 同步遞增，不會各自取得三次預算。

`sid` 是 128-bit 隨機 path，但本設計刻意不把它當授權憑證。即使網址完整公開，攻擊者仍需要 token。反過來，只有 token 而不知道 URL 也無法定位 listener。token 成功後立即從記憶體清除，cookie 另取 256-bit 隨機值，沒有 Domain 屬性，只綁目前 hostname 與 `/t/<sid>` path；session 完成、TTL、lockout 或通道死亡時立即失效。

三次失敗的主要殘餘風險是阻斷服務：知道 URL 的人可以故意輸錯三次讓 session 自毀。這是刻意的 fail-closed 取捨。網路掃描者還必須先找到 128-bit sid，正常情況下網址只出現在請求者所在的聊天；若群組內其他人或連結外洩者惡意觸發 lockout，admin 會收到明確通知並重新開一個全新 session。

### 9.2 GET 與連結預覽

`GET /t/<sid>/` 與 assets 只回預載的靜態檔案，不啟動 tmux、不消耗 token、不設 cookie，也不改 session state。預覽 bot 跟隨同 origin 的 302 或抓取頁面，只會得到 token 表單。所有有副作用的動作都在 `POST /open` 或已持 cookie 的 WS；兩者要求 matching Origin 和 Host。

網址不含 token、cookie、command、backend credential 或 provider secret，因此它出現在聊天、瀏覽歷史、Cloudflare access log 或 link-preview log 不會直接授權終端。頁面與 response 仍使用 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`、CSP、`frame-ancestors 'none'`。

### 9.3 信任邊界與殘餘風險

token gate 防的是未授權的公網使用者，不提供對 tunnel provider 的端對端保密。Quick Tunnel 的 HTTPS 在 Cloudflare edge 終止，Cloudflare 是此模式的受信任傳輸提供者，理論上可處理 `/open` 的 token 與之後的 terminal 流量。每次風險確認必須明講這一點；不能接受第三方傳輸處理內容者應選 `tailscale`、`localhost` 或自行管理的 `none`。

主機上可替換 `cloudflared` binary 的本機帳號本來就能控制同一個 AgEnD 使用者，因此不在遠端威脅模型內。AgEnD 仍要以固定 argv、無 shell、無自動下載降低誤設定與命令注入面。

Quick Tunnel 的 hostname 隨程序改變且沒有 SLA。這不削弱授權，但影響可用性；中途程序死亡時本版選擇關閉 session，而不是讓舊 cookie 跨 host 或重新發 token。

## 10. Fail-soft 與使用者訊息

Fail-soft 只在能證明「沒有未知 managed tunnel 留下」時成立：

| 失敗點 | 行為 |
|---|---|
| `allow_public:false` + public provider | 不 spawn，改用 `localhost`，清楚說明政策阻擋 |
| binary 不存在／不可執行 | 不 spawn，改用 `localhost`；附官方安裝文件與「手機通常無法直接開」提示 |
| preflight 判定 provider 尚未登入／tailnet 未啟用 | 不 spawn，改用 `localhost`；不自動修改帳號設定 |
| spawn 在建立 child 前失敗 | 安全降級 `localhost` |
| child 已建立，但拿不到合法 URL、readiness timeout 或 public GET 失敗 | 先 stop 並取得 confirmed death，之後才降級 `localhost` |
| child cleanup 無法確認 | fail closed：不送 token、不宣布 localhost fallback；關 listener/session、保留 lease、發出 cleanup 警告 |
| provider 在 active session 中退出 | 關閉 session 並通知重試；不旋轉 hostname |

Cloudflared 未安裝時的訊息應直接說：「公網通道未建立；以下是僅限本機／SSH 轉發的備用連結。若要讓手機直接開啟，請依 Cloudflare 官方文件安裝 cloudflared 後重試。」不能只回一個看似正常但手機必然打不開的 localhost URL。

通道 fallback 不改 token 規則。localhost URL 與 token 仍分兩則送，TTL 不重置；若剩餘 TTL 已不足兩分鐘，直接取消並請使用者重開，避免交付一個幾乎立即過期的 session。

## 11. Tailscale 與 ngrok 的特殊規則

`tailscale` 使用 Serve，不使用 Funnel，因此不受 `allow_public` 控制，只有 tailnet 成員可達。preflight 必須確認 Tailscale 已登入、MagicDNS／HTTPS 可用且指定 `https_port` 未被 Serve 或 Funnel 使用。啟動與停止都只操作這次使用的 port；發現既有 mapping 就拒絕並 fallback，絕不呼叫 `tailscale serve reset`。Tailscale 官方指出 `--bg` 會持久存在並在重啟後恢復，所以 AgEnD 不使用 `--bg`，仍在 stop 時執行精確 `off` 並查 status 驗證。

`ngrok` 與 cloudflared 同屬 public provider，必須 `allow_public:true`。它只沿用使用者既有 agent credential，不提供 `authtoken` 設定欄位，也不把 token 放 argv。網址只接受 ngrok provider 明確回報且通過 scheme/host validator 的 HTTPS endpoint。程序、URL readiness、unexpected exit 與 confirmed stop 都走同一份 provider contract。

## 12. 稽核與可觀察性

新增事件建議如下：

| 事件 | 最少欄位 |
|---|---|
| `web_terminal_tunnel_preflight` | sid、provider、結果、errorKind |
| `web_terminal_tunnel_ready` | sid、provider、visibility、host、startupMs |
| `web_terminal_tunnel_fallback` | sid、provider、reason、fallback |
| `web_terminal_tunnel_died` | sid、provider、exitCode、signal |
| `web_terminal_tunnel_cleanup_failed` | sid、provider、pid 或 mapping id、probeState |
| `web_terminal_tunnel_closed` | sid、provider、reason、confirmed |

只記 public host，不記完整 `/t/<sid>/` URL；不記 provider stdout/stderr、token、cookie、DM body、ngrok credential 或 request header。錯誤沿用有界的 `errorKind/errno/exitCode`，不信任第三方 error message。通道 ready、fallback、unexpected exit 與 cleanup failure 都要有一則面向 requester 的人話通知，不能只留 debug log。

## 13. 驗收與對抗測試

實作接線前後至少要完成下列測試：

1. fake provider 驗證 listener、tunnel、link、token 的啟動順序；URL ready 前不得送 token。
2. 兩個同步 start 只能有一個取得 managed lease；stale callback 不得關閉新 handle。
3. shutdown 落在 preflight、spawn、URL parse、public GET、link delivery、token delivery 各階段，最後都只有一個 cleanup owner。
4. child 已 spawn 後 startup timeout，只有 confirmed exit 才 fallback；unknown cleanup 必須 fail closed 並保留 lease。
5. TTL、cancel、token lockout、CLI exit、fleet shutdown 五條路都關 listener、關 WS、停 provider 並取得正面死亡證據。
6. daemon crash 後留一筆 lease，新 fleet reaper 能清掉同指紋 child；PID 被重用時不得送 signal。
7. tunnel 對 `/ui`、`/api/fleet`、另一個 sid 與 `/` 全部 404；精確 session page/assets/open/ws 正常。
8. public Host allowlist、Origin mismatch、偽造 `X-Forwarded-Proto`、錯 cookie、重放 token 全部拒絕；Secure cookie 由 endpoint metadata 決定。
9. 3 個平行錯 token 全局觸發一次 lockout、一次 teardown、零 terminal input；第 4 個請求得到 gone/locked。
10. link preview GET 與 302 follow 不改 token attempt、不建立 cookie、不啟 WS。
11. cloudflared output 放入惡意 URL、ANSI、超長行、額外 query/userinfo/path 時皆拒絕，child confirmed stop 後才 fallback。
12. cloudflared 不存在、無法執行、quick tunnel service timeout、edge 尚未 ready 都得到明確 localhost fallback；手機不可達風險必須出現在訊息中。
13. 真 cloudflared 驗收：公共 HTTPS 頁面與所有 assets 可載入，錯 token 剩餘次數正確，真 token 後 WS 可用，Stop/TTL 後 URL 不再抵達 origin 且 child 已退出。
14. 真 tailscale 驗收：不覆寫既有 mapping，off 後 status 確認精確 mapping 消失；真 ngrok 驗收同樣確認 child 與 endpoint teardown。

## 14. 建議決策

建議直接確認以下五點，實作才能保持單一語意：

1. 公網預設維持 `provider: cloudflared`、`allow_public: true`，但每次都要顯示風險確認；設定成 false 時自動回 `localhost`。
2. `localhost` 定義為強制 loopback 的安全模式；`none` 定義為沿用目前 bind/hostname、由操作者自行提供網路路徑的相容模式。
3. Quick Tunnel 中途死亡後關閉 session，不自動旋轉 hostname 或重發 token。
4. Cloudflare 是 public 預設下的受信任傳輸提供者；token gate 防公網未授權者，但不宣稱對 Cloudflare 端到端保密。
5. Tailscale Serve 發現既有 mapping 時 fail-soft，不覆寫也不 reset；ngrok 只用既有本機 credential，不在 AgEnD 設定中接收 secret。

## 15. 參考資料

- [Cloudflare：Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare：Tunnel 設定與 Quick Tunnel](https://developers.cloudflare.com/tunnel/setup/)
- [cloudflared 原始碼：Quick Tunnel 建立與 URL 輸出](https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/quick_tunnel.go)
- [Tailscale：Serve CLI 與關閉方式](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Tailscale：Serve 與 Funnel 的可達範圍](https://tailscale.com/kb/1223/funnel)
