# 遠端 /login 重新設計：通用 relay 原語 + kiro Organization + 限時逃生艙

狀態：設計稿（待 leader 拍板分派）。作者：溯源。日期：2026-09-07。
取證來源：kiro-cli 2.21.1 真機（隔離 HOME clone 狀態）；競品/協定研究（Multica、OpenAB、OpenClaw、ACP auth-methods RFD、Claude Code channels permission relay）。

---

## 0. 一句話

把 `LoginFlow` 從「每個 CLI 寫死 command + 一組 pattern + 隱含步驗」改成「backend **宣告**指令（可參數化）、前置指令、非互動路徵、與一組**無序**的畫面規則（Menu / Prompt / Hint / Failure）」；relay 引擎只做「看畫面 → 對規則 → 轉成聊天 UI → 把使用者的回答投遞回 pane」。**零 LLM**：引擎在 fleet 進程用 regex 判定，使用者是唯一的解讀者。逃生艙是獨立模組、預設關閉、admin-only、限時、強制認證、只綁 login 進程。

---

## 1. 現況與問題（為什麼要重構）

現有模型（`src/login-flows.ts` `LoginFlow`、`src/login-manager.ts` `LoginSession`、`src/fleet-manager.ts` 約 400 行聊天膠水）：

| 現況 | 問題 |
|---|---|
| `command` 是固定字串 | kiro Org 需要 `--license pro --identity-provider U --region R`；沒有參數化入口 |
| 沒有前置指令 | kiro 有 token 記錄（含過期可 refresh）時 `login` 一律 `Already logged in` exit 1 —— 使用者踩到的 bug |
| `inputPrompt` 一個 regex，`/login code <text>` 不綁 prompt | 連續兩個 prompt（Start URL → Region）時，晚到的回覆會貼進錯的欄位 |
| `submitInput` 直接貼字 | kiro 會用 state 裡的舊值**預填**欄位（logout 後仍在），貼字→值重複→`dispatch failure` exit 1 |
| 失敗證據取最後 3 行（含空行） | 截圖顯示「/ / Pane is dead」，CLI 的錯誤行被吃掉 |
| 成功/失敗/選單/URL 判定散在 `poll()` 的 if 串 | 加一個 backend 就要改引擎；install-cli 也共用同一段 |
| 聊天膠水（按鈕、nonce、訊息）在 FleetManager | 難測、難讀；三個 slash 分派各複製一份 |

**沒有問題、要保留的**：獨立 tmux 視窗（不碰 instance pane）、remain-on-exit 保留死 pane 證據、auth precheck（exit 0 = valid，5s 上限，unknown 不阻擋）、URL/code 走 spoiler、成功後 `recoverBackendInstances`、nonce 按鈕。

---

## 2. 目標模型

### 2.1 Backend 宣告（`LoginFlow` v2）

```ts
export interface LoginArgs { [key: string]: string }          // e.g. { startUrl, region }

export interface LoginFlow {
  backend: string;
  /** 由參數組出登入指令。沒有參數時等同今天的固定字串。 */
  command: (args: LoginArgs) => string;
  /** 參數宣告：名稱、說明、必要性、驗證（用來解析 `/login kiro startUrl=… region=…` 與 Discord option）。 */
  args?: Record<string, { description: string; required?: boolean; validate?: RegExp; default?: string }>;
  /** 從主機既有狀態找回參數（kiro：`whoami --format json` 的 startUrl/region）。在 preCommand 之前跑。 */
  discoverArgs?: () => Promise<Partial<LoginArgs>>;
  /** 決定性前置指令，同一視窗、同一 shell 串接（`pre; login`）。 */
  preCommand?: { command: string; when: "always" | "token-present" };
  /** 非互動憑證路徵（只用來提示，不自動做）：例如 KIRO_API_KEY / CLAUDE_CODE_OAUTH_TOKEN。 */
  credentialHint?: { env: string; docsUrl: string; caveat?: string };
  authCheck?: AuthCheck;                 // 不變
  loginScreenPattern?: RegExp;           // 不變（daemon 啟動期辨識登出畫面）
  /** 無序畫面規則；引擎每次 poll 全部比對。 */
  screens: ScreenRule[];
  /** 成功：pane 文字或 exit 0（不變）。 */
  successPattern: RegExp;
  /** 已知錯誤 → 人話 + 建議動作。比對範圍 = 死 pane 全文。 */
  failures?: Array<{ pattern: RegExp; message: string; suggest?: "relogin" | "check-args" | "retry" }>;
  timeoutMs: number;
}

export type ScreenRule =
  | { kind: "menu";   prompt: RegExp; options: string[] }
  | { kind: "prompt"; prompt: RegExp;            // 必須只匹配「活的」prompt（kiro：行首 `?`；`✔` 是已答）
      /** 第 1 捕獲群 = 預填值（可無） */
      prefilled?: RegExp;
      /** 對應哪個參數；有的話預填值若等於我們傳入的參數 → 自動接受 */
      argKey?: string;
      secret?: boolean }                          // 使用者輸入是否要 spoiler / 不回顯
  | { kind: "hint";   url?: RegExp; code?: RegExp }
  ;
```

**kiro 宣告範例（全部真機驗證過的字串）**

```ts
"kiro-cli": {
  backend: "kiro-cli",
  args: {
    startUrl: { description: "IAM Identity Center start URL", validate: /^https:\/\/\S+$/ },
    region:   { description: "Identity Center region", default: "us-east-1", validate: /^[a-z]{2}-[a-z]+-\d$/ },
  },
  command: a => a.startUrl
    ? `kiro-cli login --license pro --identity-provider ${sh(a.startUrl)} --region ${sh(a.region ?? "us-east-1")} --use-device-flow`
    : "kiro-cli login --use-device-flow",
  discoverArgs: kiroDiscoverIdcArgs,                 // whoami --format json → startUrl/region（logout 前）
  preCommand: { command: "kiro-cli logout", when: "token-present" },   // 只要 precheck 說 token 在就先登出
  credentialHint: { env: "KIRO_API_KEY", docsUrl: "https://kiro.dev/docs/cli/headless/", caveat: "Pro 訂閱；外部 IdP 可能無法產生（kirodotdev/Kiro#8414）" },
  authCheck: { argv: ["kiro-cli", "whoami", "--format", "json"] },
  loginScreenPattern: /Select login method/,
  screens: [
    { kind: "menu",   prompt: /^\? Select login method/m, options: ["Builder ID", "Google", "GitHub", "Your Organization"] },
    { kind: "prompt", prompt: /^\? Enter Start URL ›/m, prefilled: /^\? Enter Start URL › (\S+)/m, argKey: "startUrl" },
    { kind: "prompt", prompt: /^\? Enter Region ›/m,    prefilled: /^\? Enter Region › (\S+)/m,    argKey: "region" },
    { kind: "hint",   code: /Code:\s*([A-Z0-9][A-Z0-9-]{3,})/ },
  ],
  successPattern: /Logged in successfully|Logged in with /,
  failures: [
    { pattern: /Already logged in, please logout/, message: "CLI 仍持有舊 token；請按「重新登入」（會先登出）", suggest: "relogin" },
    { pattern: /error: dispatch failure/,          message: "Identity Center 拒絕：Start URL 或 Region 可能有誤", suggest: "check-args" },
  ],
  timeoutMs: LOGIN_TIMEOUT_MS,
}
```

其他四個 backend（codex / grok / claude / agy）與 install-cli 只是把今天的欄位搬進 `screens`（hint + 可選 prompt），行為零變化。

### 2.2 Relay 引擎（`LoginRelaySession`，取代 `LoginSession`）

每 2s 一次 poll，順序固定：

1. **success**（pane 文字）→ finish(ok)。
2. **exited**：exit 0 → ok；非 0 → 取**最後 3 行非空**當證據，先過 `failures` 映射成人話 + 建議按鈕（例如 `suggest:"relogin"` → 直接給「重新登入（先登出）」按鈕）。
3. **menu**：首次看到 → 貼按鈕（既有 nonce 機制）；選後 Down×N + Enter，**下一 poll 驗證選單已消失**，沒消失 → 通知「選單未回應」而不是再按。
4. **hint**：URL/code 首次出現 → spoiler（既有），文案加「在任何有瀏覽器的裝置打開」。
5. **prompt**：見 2.3。

**規則之間互斥由 pattern 本身保證**（kiro 用行首 `?` 表示活 prompt，`✔` 表示已答），引擎不記步驗、不假設順序。

**tmux 介面不變**（`LoginTmux`），但 login 視窗改開在**專屬 tmux server**（`tmux -L agend-login`，一個 session 一個 window），理由：(a) 逃生艙要能只暴露這一個 server；(b) fleet 主 tmux session 不再混入 login 視窗；(c) `kill-server` 就是完整清理。install-cli 同樣。

### 2.3 Prompt 票（短 ID）與預填政策

每個「活的 prompt」產生一張票：

```ts
interface PromptTicket { id: string; rule: ScreenRule & { kind: "prompt" }; prefilled?: string; issuedAt: number }
```

- **ID**：5 個小寫字母、排除 `l`（同 Claude Code permission relay：手機好打、不會與 1/I 混）。25^5 ≈ 9.7M。
- **同時只有一張活票**；新 prompt 出現（或同一 prompt 的預填值改變）→ 舊票作廢並通知。
- **投遞規則**：`/login code <id> <text>`（Discord option 同）—— ID 不符或票已作廢 → 拒收並回覆目前活票。按鈕回覆自帶 ID，使用者通常不用打。
- **預填政策（文字只走 relay，不猜按鍵）**：
  | 預填來源 | 動作 |
  |---|---|
  | 預填值 == 我們透過 `args` 傳進去的值 | **自動 Enter**（值是我們放的，確定正確），通知「使用 Start URL X」 |
  | 預填值來自 CLI 自己的舊狀態（沒傳 args） | 貼兩個按鈕：**「使用 X」**（Enter）/ **「改用別的」**（取消本次，提示 `/login kiro startUrl=… region=…` 重來）。**不收自由文字** |
  | 空欄位 | 通知「請回覆 `/login code <id> <text>`」，收到後 `pasteText` |
- **不再對預填欄位做 Backspace 清除**（真機：Ctrl-U / Ctrl-A+K 無效，只有逐字 Backspace，脆）。

### 2.4 指令面

- `/login <backend> [key=value ...]`，也接受 kiro 的位置參數 `/login kiro <startUrl> [region]`；Discord slash 加一個可選 `args` 字串 option（避免每 backend 加 option）。
- 流程（kiro，最常見的「同一 Org 重新登入」）：precheck token 在 → 確認鈕文案改為「會先執行 kiro-cli logout，N 個 kiro instance 的登入會中斷，成功後自動重啟。繼續？」→ `discoverArgs`（whoami）→ 視窗執行 `kiro-cli logout; kiro-cli login --license pro --identity-provider … --region … --use-device-flow` → 兩個 prompt 都是我們的值 → 自動 Enter×2 → URL+Code spoiler → 使用者授權 → success → recover。**使用者零輸入。**
- `/login <backend> token`（可選，v2 之後）：只顯示 `credentialHint`（環境變數名 + 文件），不自動做。

### 2.5 程式結構

```
src/login-flows.ts         宣告（LoginFlow v2 + 5 backend + install flows）
src/login-relay.ts         引擎：poll、規則比對、票、預填政策、失敗映射（純邏輯，注入 LoginTmux）
src/login-controller.ts    聊天膠水：/login 解析、按鈕 nonce、訊息文案、票 → 按鈕、recover；FleetManager 只留 3 行委派
src/login-window.ts        專屬 tmux server 的 LoginTmux 實作（create/attach/kill/capture/paste）
src/login-escape-hatch.ts  階段 3，獨立模組，預設不載入
```

---

## 3. 階段拆分（建議）

| 階段 | 內容 | 解決 | 依賴 | 規模 | Review |
|---|---|---|---|---|---|
| **1a（先出，解使用者的 bug）** | 在**現有**模型上最小修：kiro `preCommand` logout-first；`command(args)` + `/login kiro [startUrl] [region]` + `discoverArgs`；**預填且值等於我們參數 → 自動 Enter**；失敗尾行取非空；`Already logged in` / `dispatch failure` 映射。 | 使用者當下的 exit 1；同 Org 重登零輸入 | 無 | 1 PR，~300 行 + tests（用真機擷取的畫面重放） | sol |
| **1b / 2（架構）** | `LoginFlow` v2（screens / failures / args）、`LoginRelaySession` 引擎、Prompt 票 + 短 ID、預填「使用/改用」按鈕、`login-controller.ts` 拆出、專屬 tmux server、五個 backend + install 遷移；舊欄位刪除。 | 連續 prompt 投錯欄位；加 backend 不改引擎；可測性 | 1a 合併後（1a 的 kiro 宣告直接搬進 v2） | 1–2 PR，~900 行；login-manager/login-command/login-flows/install-cli 四組測試重寫 | sol |
| **3（逃生艙）** | `login-escape-hatch.ts`：ttyd + tunnel provider，見 §4。預設關閉、需 config 開啟 + 二進位 preflight。 | 未知 TUI 的 fallback | 2（專屬 tmux server） | 1 PR，~500 行 + 安全測試 | **sol 安全 review 必要** |

為什麼 1a 不直接併進 2：使用者現在登不進去，1a 一天內可出；2 動到五個 backend 與 install-cli，需要完整回歸，不該綁在 hotfix 上。1a 的每一行都能原樣搬到 v2 宣告裡，沒有浪費。

---

## 4. 階段 3：限時逃生艙 —— 安全模型

**定位**：fallback，不是預設路徑。只在 (a) 有活的 login session 且 (b) 引擎連續 N 次 poll（建議 5 次 = 10s）沒有任何規則命中、或 admin 明確下 `/login terminal` 時，**提供「開啟逃生艙」按鈕**；按下才開。永不自動開。

### 4.1 元件

```
[admin 瀏覽器] --HTTPS--> [tunnel provider] --> 127.0.0.1:<port> ttyd --once
                                                   └─ 執行：tmux -L agend-login attach -t login   (只有這一個 window / 一個進程)
```

- **ttyd**（`--once`：第一個 client 斷線即退出；`-i 127.0.0.1` 只綁 loopback；`-c <user>:<otp>` HTTP basic auth；`-b /<32hex>` 隨機 URL path；`-W` 可寫；`-t disableLeaveAlert=true`）。
- **tunnel provider**（可插拔 `TunnelProvider { start(port): Promise<{ url }>; stop(): Promise<void> }`）：
  | provider | 暴露範圍 | 備註 |
  |---|---|---|
  | `tailscale serve`（**建議預設**） | 僅 tailnet | 不出公網；HTTPS 由 tailscale 簽；需 host 已加入 tailnet |
  | `cloudflared tunnel --url` | 公網（trycloudflare 隨機子域） | 零帳號；靠 URL 亂數 + basic auth + TTL 撐 |
  | `ngrok http` | 公網 | 需 token；可加 ngrok 自身 auth |
  | `none`（LAN） | 只綁指定介面 IP | 給同網段/VPN 使用者 |
- **scope 綁 login 進程**：專屬 tmux server（§2.2）裡只有 login 進程；該 server `set -g prefix None; set -g status off; unbind -a`，使用者無法開新 window、無法 detach 進 shell；login 進程結束 → session 結束 → ttyd `--once` 結束。**殘餘風險**：若某 CLI 的 login TUI 自身提供 shell 逃逸（目前五個都沒有），scope 會被突破 —— 逃生艙只對宣告 `escapeHatch: true` 的 flow 開放，預設全 false，逐一審過才開。
- **ttyd 以 fleet 使用者身分執行**（沒有更低權限帳號可切；如同 login 進程本身）。

### 4.2 認證與時效

- **兩層**：URL path 32 hex 亂數 + HTTP basic auth 一次性密碼（≥ 24 字元，`crypto.randomBytes`）。兩者只以 **spoiler 私訊**（Telegram）/ ephemeral（Discord）送給**發起的 admin**，不進 topic 廣播。
- **TTL**：預設 5 分鐘、上限 10 分鐘（config 夾住）；到期 `kill ttyd + tunnel.stop()`，login session 本身的 10 分鐘上限仍在。
- **單次**：`--once`；client 斷線即關。同一時間全 fleet 只允許一個逃生艙。
- **admin-only**：`isFleetAdmin` 檢查（與 /login 同）；非 admin 連按鈕都看不到。
- **明確風險告知**：開啟前訊息列出「公網/tailnet 暴露、5 分鐘、只給你、關閉方式 `/login terminal close`」；開啟/關閉/到期/連線建立 全部寫 eventLog（`login_escape_hatch_*`，含 admin id、provider、url host，不含密碼）。
- **preflight**：ttyd 與 provider 二進位存在、版本可用、port 可綁、tunnel 5s 內拿到 URL；任一失敗 → 不開、回覆原因。**本 host 目前 ttyd / cloudflared / tailscale / ngrok 都未安裝** —— 這是部署前置，不是程式碼能補的。

### 4.3 設定

```yaml
login:
  escape_hatch:
    enabled: false          # 預設關
    provider: tailscale     # tailscale | cloudflared | ngrok | none
    ttl_minutes: 5          # 1..10
    allow_public: false     # cloudflared/ngrok 屬公網，需明確 true 才允許
```

### 4.4 不做的事

- 不暴露完整 shell、不暴露 fleet 主 tmux session、不做長期 web terminal、不用 ttyd 的 `--credential` 檔以外的任何持久憑證、不把 URL 貼進 topic。

---

## 5. 風險與回退

| 風險 | 緩解 | 回退 |
|---|---|---|
| CLI 改版讓 regex 失效（kiro 2.x 每月改 TUI） | 所有字串真機驗證 + 註明版本；引擎「無規則命中 N 次」會通知而非空轉；1b 之後加 backend 只改宣告 | 宣告層 revert，引擎不動 |
| logout-first 讓執行中的 kiro instance 立刻失去登入 | 確認鈕文案明講；`recoverBackendInstances` 成功後重啟；只在 precheck 說 token 在時才 logout | 拿掉 `preCommand` 一行 |
| 短 ID 讓 `/login code` 變長 | 按鈕自帶 ID；訊息給可直接複製的完整指令 | 引擎允許「唯一活票且無 ID」時接受（設定項，預設關） |
| 專屬 tmux server 與現有 install-cli 共用行為改變 | 1b 一併遷移 install-cli 並跑其測試 | 1a 不動 tmux 結構 |
| 逃生艙暴露面 | §4：預設關、admin-only、TTL、雙層認證、tailnet 預設、scope 綁單進程、eventLog | 設定關閉即整段不載入；獨立 PR 可單獨 revert |
| 引擎重寫回歸五個 backend | 1a 先出並穩定；2 用真機擷取畫面做 replay 測試（codex/grok/claude/agy 既有測試字串 + kiro 本次擷取） | 2 獨立 PR revert 回 1a |

---

## 6. 已驗證事實速查（kiro-cli 2.21.1，隔離 HOME clone）

- `login --use-device-flow` 仍顯示四選項選單；`--license pro` 跳過選單直接進 Start URL；`--license free` 直接出 Builder ID URL。
- 有 token 記錄（含 expires_at 已過但 refresh 在）→ `error: Already logged in, please logout with kiro-cli logout first` exit 1。refresh 也失效才會進流程（whoami 此時 exit 1 `{"account":null}`）。
- `auth.idc.start-url` / `auth.idc.region` 存在 state，**logout 後仍在**；prompt 預填；`--identity-provider/--region` 預填並覆蓋舊值；預填後仍需 Enter。
- 預填欄位貼字 → 值重複 → `error: dispatch failure` exit 1。Ctrl-U / Ctrl-A+Ctrl-K 無效；Backspace 有效。
- Identity Center 一律 device-code 畫面：`Confirm the following code in the browser` / `Code: XXXX-XXXX` / `Open this URL: https://<start>/#/device?user_code=XXXX-XXXX` / `▰▱ Logging in...`；有無 `--use-device-flow` 相同。
- `whoami --format json`：有 token exit 0 並回 `startUrl`/`region`；登出 exit 1。`logout` idempotent exit 0。
- 未驗證：成功字串 `Logged in successfully`（需真人授權）；logout 對執行中 kiro chat 的即時反應。
