# v2.1.5 設計：`/login` 與 `/install-cli` 以「限時、認證、單進程 web terminal」為核心

狀態：設計稿 v2（取代同名 v1「chat relay 為主」版本）。作者：溯源。日期：2026-09-07。
使用者決定：v2.1.5 只做 login + install-cli；web terminal 是**主路徑**，安全是主路徑等級。

---

## 0. 一句話

`/login <backend>` / `/install-cli <backend>` → fleet 在**專屬 tmux server** 裡啟動**且只啟動**那一個指令 → 開一條**限時、一次性、只綁這個 pane** 的瀏覽器終端 → 使用者在瀏覽器裡走完任何選單 / prompt / device code / SSO / TUI → 進程結束或 TTL 到 → 全部關閉。fleet 同時**旁觀**（capture-pane）把 device URL/code 貼到聊天、判成功、重啟該 backend 的 instance。**零 LLM、零 per-CLI 按鍵模擬、零 shell 暴露。**

---

## 1. 為什麼反轉、反轉後留下什麼

v1 設計要為每個 CLI 宣告 Menu/Prompt/Hint 規則並替使用者按鍵；kiro 取證顯示這條路每個 CLI、每個版本都要重新取證（預填欄位、`?`/`✔` 行首、Backspace 才能清）。web terminal 讓**人**當 TUI 的解讀者：任何 CLI 的任何 flow 天生支援，backend 宣告縮到「指令、前置指令、旁觀 pattern」。

| 保留（今天就有、不動） | 移除 | 新增 |
|---|---|---|
| 獨立於 instance pane；auth precheck（exit 0 = valid、5s、unknown 不阻擋）；成功後 `recoverBackendInstances`；URL/code spoiler；nonce 按鈕；admin-only | Menu 按鈕→Down×N、`inputPrompt`/`/login code <text>`、`submitInput`、任何對 pane 的 `pasteText` | web terminal 引擎、URL 無秘密 + 一次性 access token gate、TTL、事件稽核、kiro logout-first、失敗人話映射、（第三階段）tunnel provider |

**是否保留 chat relay 當備選？** 建議**不保留互動 relay**（Menu/Prompt），只保留**被動旁觀**：device URL/code 仍貼到聊天（手機使用者可直接點 SSO 連結）、成功/失敗通知、instance 重啟。理由：使用者一定有瀏覽器（他就在 Discord/Telegram 裡）；保留兩套互動路徑等於維護兩套 per-CLI 取證。舊 relay 程式碼在 v2.1.5 以 `login.mode: web|relay`（預設 `web`）保留一版當 rollback 槓桿，v2.1.6 刪除。

---

## 2. 架構

### 2.1 元件

```
 Discord/Telegram admin ──/login kiro──▶ FleetManager ──▶ LoginController
                                                            │ precheck / confirm / preCommand 決策
                                                            ▼
                                                  WebTerminalSession（新，src/web-terminal.ts）
                                                    ├─ tmux -L agend-term-<sid> new-session -d -x 120 -y 36 -- <sh -c "pre; cmd">
                                                    ├─ pipe-pane -o → 輸出串流（含逸出序列）
                                                    ├─ send-keys -H <hex> ← 瀏覽器鍵入（逐 byte）
                                                    ├─ resize-window -x -y ← 瀏覽器視窗
                                                    ├─ capture-pane -J（旁觀：URL/code/success/failure）
                                                    └─ TTL / exit 監看 → kill-server
                                                            ▲  WS
                                                  TerminalHttpServer（每 session 一個 127.0.0.1:0 listener）
                                                    ├─ GET  /t/<sid>            靜態頁（vendored xterm.js，無 CDN，嚴格 CSP）；URL 不含任何秘密
                                                    ├─ POST /t/<sid>/open       {token} → 驗一次性 access token（聊天私訊送達）→ 發 HttpOnly cookie
                                                    └─ WS   /t/<sid>/ws         cookie + Origin 驗證 → 雙向 bytes
                                                            ▲
                                       admin 瀏覽器 ── http://<hostname>:<port>/t/<sid> ──（第三階段：tunnel provider，純轉送）
```

**為什麼是 tmux + 自建 WS，而不是 ttyd？**（兩者都評估過）

| | A. tmux pane + 自建 WS（建議） | B. ttyd `--once` 直接 spawn |
|---|---|---|
| 依賴 | tmux（已是硬依賴）、xterm.js（vendored、MIT）；**無 native module、無新二進位** | ttyd 二進位（本 host 與多數部署都沒裝；要下載 + checksum pin） |
| scope | 瀏覽器只對我們的 WS 說話，WS 只對**那一個 pane** `send-keys`；沒有 tmux client 附著 → prefix/new-window 在結構上不可能 | 只 spawn 指令，等價 |
| 旁觀（URL/code 貼聊天、成功判定、失敗證據） | `capture-pane` 現成 | 需 `script` 包一層 tee 才看得到 |
| 瀏覽器斷線 | 進程活著，TTL 內可重連 | `--once` = 斷線即殺，登入作廢 |
| 認證 | 與 fleet admin / eventLog / 一次性連結整合 | HTTP basic auth，另一套 |
| 進程何時啟動 | `/login` 當下（precheck/preCommand 語意清楚） | 首次連線才 spawn |

選 A。B 留作文件記錄的替代方案。

### 2.2 `WebTerminalSession` 介面（login 與 install-cli 共用）

```ts
export interface WebTerminalSpec {
  kind: "login" | "install";
  backend: string;
  /** 唯一會執行的指令（可為 `pre; cmd` 串接）。以 argv 形式傳給 tmux，避免二次解析。 */
  command: string;
  cwd: string;
  ttlMs: number;                 // 預設 login 10 min、install 15 min；上限 20 min（config 夾住）
  /** 旁觀規則（被動；不送鍵） */
  observe?: {
    urlPattern?: RegExp; codePattern?: RegExp;
    successPattern?: RegExp;
    failures?: Array<{ pattern: RegExp; message: string; suggest?: "relogin" | "check-args" | "retry" }>;
  };
  requester: { adapterId: string; userId: string; chatId: string; threadId?: string };
}

export interface WebTerminalEvents {
  onLink(link: { url: string; accessToken: string; expiresAt: number }): Promise<void>;   // 兩則分開的訊息，只給 requester（ephemeral / spoiler 私訊）
  onHint(url: string, code: string | null): Promise<void>;                        // 既有 sendLoginSecret
  onDone(result: { ok: boolean; exitCode?: number; detail: string; suggest?: string }): Promise<void>;
  onAudit(event: string, fields: Record<string, unknown>): void;                  // eventLog
}
```

生命週期：`create()`（起 tmux server + listener + 產 sid 與一次性 access token）→ `onLink` → 等連線（未連線也照 TTL）→ 進程 exit（`remain-on-exit` 保留死 pane 取 exit code 與**非空尾行**）→ `onDone` → `kill-server` + 關 listener。TTL 到 → 同樣收尾，`detail:"ttl"`。fleet 同時**至多一個** session（沿用 `activeLogin`/`activeInstall` 互斥）。

### 2.3 Backend 宣告（`LoginFlow` 縮減版）

```ts
export interface LoginFlow {
  backend: string;
  command: string | ((args: LoginArgs) => string);   // kiro 可帶 startUrl/region 預填（可選，第二階段）
  preCommand?: { command: string; when: "always" | "token-present" };   // kiro: kiro-cli logout
  authCheck?: AuthCheck;               // 不變
  loginScreenPattern?: RegExp;         // 不變（daemon 啟動期用）
  observe: WebTerminalSpec["observe"]; // urlPattern/codePattern/successPattern/failures
  ttlMs?: number;
  /** 明確標記此 CLI 的 login TUI 沒有 shell 逃逸（人工審過）；未標記者不得開 web terminal。 */
  noShellEscape: true;
}
```

kiro：

```ts
"kiro-cli": {
  backend: "kiro-cli",
  command: "kiro-cli login --use-device-flow",          // 使用者在瀏覽器選 Your Organization、打 start URL/region
  preCommand: { command: "kiro-cli logout", when: "token-present" },
  authCheck: { argv: ["kiro-cli", "whoami", "--format", "json"] },
  loginScreenPattern: /Select login method/,
  observe: {
    codePattern: /Code:\s*([A-Z0-9][A-Z0-9-]{3,})/,
    successPattern: /Logged in successfully|Logged in with /,
    failures: [
      { pattern: /Already logged in, please logout/, message: "CLI 仍持有舊 token；請按「重新登入（先登出）」", suggest: "relogin" },
      { pattern: /error: dispatch failure/, message: "Identity Center 拒絕：Start URL 或 Region 可能有誤", suggest: "check-args" },
    ],
  },
  noShellEscape: true,
}
```

**kiro Org 在 web terminal 下是否「自動就解了」？** 三個問題中兩個是：選單、Start URL/Region 的輸入與預填（使用者自己看到預填值，Enter 或 Backspace 都行）、device code 出現後直接在同一個瀏覽器點 URL —— 都不需我們建模。**第三個不是**：`Already logged in … exit 1` 在 web terminal 裡一樣會立刻結束，而且使用者在終端裡**沒有 shell 可以自己打 `kiro-cli logout`**（這正是 scope 設計的結果）。所以 `preCommand` logout-first 必須保留，由 chat 端確認鈕觸發（文案：「會先執行 kiro-cli logout，N 個 kiro instance 會暫時斷線，成功後自動重啟」）。可選加分：`/login kiro startUrl=… region=…` 用 `--identity-provider/--region` 預填，讓使用者只按 Enter（第二階段）。

install-cli：`command` = 安裝指令（現有）、`observe.successPattern` 無（exit 0 判定）、exit 後 `verifyBinaryOnLoginShell`、再接 /login（現有鏈）。

### 2.4 終端頁面

- vendored `@xterm/xterm` + `addon-fit` + `addon-web-links`（讓 device URL 可點），單一 HTML，`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'`；無外部資源。
- 頁面載入**不觸發任何副作用**（連結預覽機器人會 GET 這個 URL），且 **URL 裡沒有任何秘密**。使用者貼上聊天收到的 access token 後，JS `POST /open` 才驗 token、設 cookie、開 WS。
- 顯示：backend、剩餘 TTL 倒數、「此終端只連到 `<command>`，進程結束即關」、關閉按鈕（送 Ctrl-C 並結束 session）。
- 手機：xterm.js 可用；access token 輸入用一般表單（可貼上）。

---

## 3. 安全模型（主路徑等級）

### 3.0 硬需求：token-gated —— URL 洩漏 ≠ 存取

使用者明確要求：**光有 tunnel/連結 URL 不足以存取**。設計上把「到達」與「授權」拆成兩個不同通道：

| | 連結 URL | access token |
|---|---|---|
| 內容 | `http(s)://…/t/<sid>`，`sid` 為 16 bytes 亂數，**只是路徑，不是憑證** | 20 字元 base32（100 bits）亂數，與 `sid` 綁定 |
| 送達 | 聊天私訊（ephemeral / spoiler） | **另一則**聊天私訊（ephemeral / spoiler），同一個已通過 `isFleetAdmin` 的 requester |
| 拿到後能做什麼 | 只看到一個要求輸入 token 的靜態頁；GET 無副作用 | 無 URL 時什麼都做不了 |
| 生命週期 | 到 session TTL | **一次性**：`POST /open` 驗證成功即消耗；之後只認 cookie。TTL 與 session 相同（≤ 20 分） |
| 驗證 | — | 伺服端 `timingSafeEqual`；錯 **3 次**即 `kill-server`、關 listener、通知 requester「疑似連結外洩」 |
| 落地 | 可出現在瀏覧歷史 / 代理日誌（無害） | **絕不**進 URL、query、log、eventLog；記憶體持有、消耗即清 |

驗證成功後發的 cookie：`HttpOnly; SameSite=Strict; Path=/t/<sid>`，值為另一組 32 bytes 亂數並綁 `sid`，只在該 listener 存活期間有效；WS upgrade 必須帶該 cookie 且 `Origin === Host`。

**tunnel 只是轉送**（第三階段，預設 cloudflared quick tunnel = 公網）：cloudflared / ngrok / tailscale 都不參與授權；gate 在我們的 listener 上，tunnel 前後同一套規則。公網 tunnel 下 token gate 就是唯一防線，這套設計正是為此自洽。tailscale 自帶身分是**額外**一層（進階選項），不取代 token。

這一層疊在「scope 只跑 login/install 進程」「短 TTL」「admin-only」之上。四層各自獨立成立：URL 外洩 → 需 token；token + URL 同時外洩 → 只有一次機會、幾分鐘、且只拿到一個 login 進程的鍵盤；連 admin 帳號被盜 → 才等同 admin 本人操作。

### 3.1 威脅與控制

| 威脅 | 控制 |
|---|---|
| 連結洩漏（聊天轉貼、截圖、連結預覽、代理日誌） | §3.0：URL 無秘密、GET 無副作用；存取需**另一通道送達的一次性 access token**；錯 3 次銷毀 session 並通知 |
| 連結 + token 同時被非 admin 拿到 | token 一次性（第一個用掉的人贏，requester 立刻發現自己進不去 → 通知「token 已被使用」）；TTL 幾分鐘；拿到的只是單一 login 進程的鍵盤（§scope） |
| 藉終端取得 shell | 瀏覽器**沒有** tmux client；WS 只做 `send-keys -H` 到單一 pane；pane 裡只有 `sh -c "<pre>; <cmd>"`，指令結束 → shell 結束 → pane 死（`remain-on-exit` 只留死畫面）。**只有宣告 `noShellEscape: true` 的 flow 才可開**（五個 backend 與 install 逐一審） |
| 借 web terminal 的 listener 打到 dashboard | web terminal 用**獨立 listener**（`127.0.0.1:0`，每 session 一個），不掛在 health/dashboard server；tunnel（第三階段）只指向這個 listener |
| CSRF / 跨站 WS | `POST /open` 與 WS 都驗 `Origin === Host`；cookie `HttpOnly; SameSite=Strict; Path=/t/<sid>`；WS 無 cookie 即拒 |
| 長時間暴露 | TTL 預設 10 分、上限 20 分（config 夾住），到期 `kill-server`；進程 exit 後 5 秒收尾；瀏覽器關閉不延長 TTL |
| 併發 / 濃縮攻擊面 | 全 fleet 同時至多 1 個 session；同 requester 5 分鐘內最多 3 次建立 |
| 輸入濫用 | 每個 WS frame ≤ 4 KB、每秒 ≤ 64 frame；resize 夾在 20×5 … 250×100；byte 原樣進 pane（含 Ctrl-C = 結束登入） |
| 明文傳輸（HTTP over LAN） | 階段 1–2 與 /dashboard 相同前提：預設只綁 127.0.0.1，透過 SSH 轉發 / tailscale / 反向代理（TLS）到達。階段 3 預設 cloudflared quick tunnel 提供 HTTPS。token 一次性 + 短 TTL 把被動竊聽的價值壓到單次幾分鐘。文案明講「勿在不可信網路用純 HTTP」 |
| 公網 tunnel（階段 3 預設） | URL 公網可達是**刻意的**（手機在通訊軟體點連結、手機瀏覽器完成登入，該裝置不在 tailnet、到不了 localhost）。防線 = §3.0 token gate 整套：URL 零秘密、GET 無副作用、一次性 token 另一通道送達、timing-safe、3-strike 銷毀、TTL、單 session listener（tunnel 打不到 dashboard）。tunnel 純轉送不參與授權 |
| 稽核 | eventLog：`web_terminal_created / link_sent / token_sent / opened(ip, ua) / token_failed(n) / token_lockout / closed(reason, exitCode) / ttl_expired`，含 requester id、backend、kind；**不記** token/cookie |
| 憑證落地 | 登入成功寫的是 CLI 自己的憑證檔（與人在主機終端登入完全相同）；AgEnD 不經手 token |

### 3.2 使用者告知（開啟前的確認訊息，必按「我了解，開啟」）

「將開一條 10 分鐘的瀏覽器終端，只連到 `kiro-cli login`（沒有 shell）。連結與一次性 access token 會**分兩則**私訊給你；光有連結進不去，請勿轉貼任何一則。目前透過 `http://<hostname>:<port>`（純 HTTP）到達，請確保你走的是 SSH 轉發 / tailscale / 內網。」kiro 另加 logout 提示。

### 3.3 設定

```yaml
web_terminal:
  enabled: true              # v2.1.5 預設開（主路徑）
  bind: 127.0.0.1            # 可設 tailscale IP
  ttl_minutes: 10            # 1..20
  # access token gate 沒有開關：永遠開（硬需求）
  tunnel:                    # 第三階段
    provider: cloudflared    # cloudflared（預設，公網、免帳號、HTTPS、手機可開）| tailscale | ngrok | none（localhost-only，SSH 轉發）
    allow_public: true       # 公網 provider（cloudflared/ngrok）需為 true；設 false 則只允許 tailscale/none
login:
  mode: web                  # web | relay（relay = 舊路徑，僅供 2.1.5 回退，2.1.6 移除）
```

---

## 4. 階段拆分

| 階段 | 內容 | 規模 | Review |
|---|---|---|---|
| **1. 引擎 + /login 上線（v2.1.5 核心）** | `src/web-terminal.ts`（tmux server、pipe-pane/​send-keys 橋、TTL、exit 收尾、旁觀）、`src/web-terminal-http.ts`（listener、頁面、`/open`、WS、cookie/Origin/token gate/限流）、vendored xterm.js、`LoginFlow` 縮減 + 五個 backend 遷移（kiro 含 logout-first / failures）、`LoginController` 抽出 FleetManager（確認鈕、連結私訊、旁觀→spoiler、recover）、`login.mode` 開關、eventLog、locale。測試：假 tmux 重放（既有 harness）+ 真 tmux 整合（起真 server、真 WS client 打鍵、TTL 到期、**只有 URL 沒 token 被拒、token 三次失敗銷毀、token 第二次使用被拒**、Origin 拒絕）。 | 1–2 PR，~1500 行 | sol 安全嚴審（§3 逐項） |
| **2. /install-cli 遷移 + 舊路徑清理** | install 走同一 `WebTerminalSession`；刪 Menu/Prompt relay 與 `/login code`（保留在 `mode: relay` 直到 2.1.6）；`/login kiro startUrl= region=` 預填（可選）；docs/commands 更新。 | 1 PR，~500 行 | sol |
| **3. tunnel provider** | `TunnelProvider { start(port) → url; stop() }`。**預設 `cloudflared` quick tunnel**（公網、免帳號、隨機 `*.trycloudflare.com`、HTTPS、手機瀏覽器可開 —— 核心情境「在通訊軟體點連結、手機完成登入」需要公網可達）；進階：`tailscale serve`（裝置在 tailnet 者更私密）、`none`（localhost-only，SSH 轉發）、`ngrok`。preflight：binary 存在、10s 內拿到 URL；**沒裝 cloudflared → 不開 tunnel、回覆安裝指引**（`brew install cloudflared` / apt repo / GitHub release）**並提供 localhost-only fallback 連結**。`allow_public` 明確開關（預設 true 因為預設 provider 就是公網；設 false 時 cloudflared/ngrok 拒開）。開公網 tunnel 前的風險文案：「即將開一條公網可達的臨時連結（N 分鐘）；安全依賴另一則私訊的 access token，請勿外傳任何一則。」tunnel 只指向該 session 的 listener、純轉送、不參與授權。 | 1 PR，~400 行 | sol 安全嚴審 |

依賴：2、3 都依賴 1。1 可再拆「引擎 + 測試（不接指令）」與「/login 接線 + kiro」兩個 PR 以便 review。

---

## 5. 風險與回退

| 風險 | 緩解 | 回退 |
|---|---|---|
| 主機只綁 127.0.0.1，遠端使用者到不了 | 階段 1–2：與 /dashboard 同模型（`hostname` + SSH/tailscale）；階段 3 預設 cloudflared 公網 tunnel 直接解 | — |
| 公網 tunnel 擴大暴露面 | 防線全在 token gate（§3.0）+ 單 session listener + TTL；cloudflared 未安裝時不開、給指引；`allow_public: false` 可整體禁用公網 | 設 `tunnel.provider: none` |
| 純 HTTP 洩漏 token/cookie | token 一次性 + 短 TTL；建議 tailscale/反向代理；第三階段 HTTPS tunnel | 設 `web_terminal.enabled: false` |
| 某 CLI 的 login TUI 有 shell 逃逸 | `noShellEscape` 白名單、逐一審；install 指令為 `sh` 腳本，屬已知：install 只跑我們的固定指令字串 | 對該 backend 拒開 |
| tmux pipe-pane 對高頻 TUI 重繪的延遲/斷幀 | 36×120 預設、pipe-pane 直通不經 capture；整合測試量測 | 不可接受時改 B（ttyd）方案，介面不變 |
| 瀏覽器手機鍵盤對 TUI 的方向鍵 | 頁面提供 ↑↓←→/Enter/Ctrl-C 軟鍵 | — |
| 舊 relay 路徑回歸 | `login.mode: relay` 保留一版 | 切回 relay |
| 引擎 PR 大 | 拆兩個 PR；假 tmux 單元 + 真 tmux 整合 | 逐 PR revert |

---

## 6. 依據（真機/程式碼）

- fleet 已有 loopback HTTP server（`health_port` 19280、`hostname` 組 URL、`web.token` 48 hex 長期 token、`/ui`、`/view`）→ web terminal **不**共用其 token，但沿用「hostname + 自行到達」的部署前提。
- tmux 3.7b、Node 22；tree 內無 node-pty / ws / xterm。
- 本 host 無 ttyd / cloudflared / tailscale / ngrok。
- kiro-cli 2.21.1 事實（隔離 HOME clone）：有 token（含過期可 refresh）→ `Already logged in` exit 1；`auth.idc.start-url/region` logout 後仍在並預填；貼字進預填欄位 → 重複 → `dispatch failure`；IdC 一律 device-code 畫面（`Code: XXXX-XXXX` / `Open this URL: …/#/device?user_code=…`）；`whoami` 有 token exit 0、登出 exit 1；`logout` idempotent。未驗：成功字串（需真人授權）。
