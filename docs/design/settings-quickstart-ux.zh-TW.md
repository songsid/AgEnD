# Settings 網頁改版：以 quickstart 引導為核心

設計提案（**尚未實作、不改動 production 行為**）。供使用者審查；審過再拆實作 ticket。
關聯：#192→#647（Settings 現況）、#577（hot/cold reconcile）、#623（逃生艙）、#769（adapter↔core 解耦 + Web UI 控制面 epic）。

本文所有「現況」敘述都附了程式碼位置，方便審查者自行驗證，而不是只看結論。

---

## v2 修訂說明（回應 fable 架構/安全 review）

**我在 v1 的 D.4 寫錯了一條事實，先更正。** v1 的邊界規則一寫「web 層永不直接操作 daemon，只產生 config 變更」，並畫成一張彷彿描述現況的圖。**現況不是這樣**：`WebApiContext`（`web-api.ts:138-149`）已經直接暴露 `startInstance`／`stopInstance`／`restartSingleInstance`／`removeInstance`／`deliverToInstance`／`connectIpcToInstance`／`saveFleetConfig`，而 `settings-api` 也直接呼 `ctx.lifecycle.pause/wake`（:189）與 `ctx.restartClassicInstanceFromSettings`（:327-336）。**web 層今天已經是一個帶完整生命週期權限的控制面，不是 config 層。**

這個錯誤不是措辭問題，它會直接害到票 5：如果 pre-fleet 用「stub context 承載同一份 handler」來實作，等於在一個**沒有 fleet 的行程裡放進可以 spawn instance 的動詞**——一個提權面。v2 的 D.4 因此整段重寫。

| 修訂 | 內容 |
|---|---|
| D.1 | hot 欄位不是兩處是**五處**，逐一列出 |
| D.2 | 補兩個常態失效：客戶端產生冪等鍵、apply job 必須落磁碟 |
| D.4 | 整段重寫：WebApiContext 拆 config verbs / lifecycle verbs；setup 宿主＝表單 + spawn + 自行退出 |
| D.5 | 整段重寫：setup 不用 web.token、改 CLI 一次性 token；setup-complete 獨立標記；宿主自退作為時間窗 |
| 票 0 | **新增**：Settings 既有 gate 硬化，排在 tunnel 接線之前 |
| 票 1 | 從「schema endpoint」擴成「單一來源 + parity 測試」 |

(A)(B)(C) 維持 v1，未受此次 review 影響。

---

## 摘要

三個發現改變了我原本預期的提案形狀：

1. **現有 UI 已經有 GHES 式「暫存 → 套用」的一半。** `state.pending` + `stageChange()` + `applyPendingChanges()` 已經是暫存模型，而且每個欄位已經標了影響等級（⚡ 立即／🔄 重啟此 Agent／🔄🔄 重啟 AgEnD）。**缺的不是暫存機制，是套用之後的進度回饋。**
2. **pre-fleet setup 模式在架構上比想像中近。** `SettingsApiContext.fleetConfig` 與 `configPath` 已經是 `| null`；web token 來自 `dataDir` 而非 fleet.yaml。也就是說「還沒有 fleet 就先開網頁」並沒有型別上的阻礙。
3. **hot 欄位清單目前有兩份，會漂移。** server 端 `HOT_INSTANCE_CONFIG_KEYS`（`fleet-manager.ts:234`）與前端 `HOT_FIELDS`（`settings.html:376`）是手抄的兩份同樣內容。前端靠它決定顯示「⚡ 立即生效」還是「🔄 重啟」——兩邊一旦不同步，使用者看到的影響說明就是錯的。

因此本提案的重點不是「重寫 Settings」，而是：**把既有的暫存/影響模型補上進度與 pre-fleet 入口，並用 wizard 收斂首次上手路徑**。

---

## (A) UX 需求盤點與三級分類

### A.1 quickstart CLI 目前問了什麼

讀 `src/quickstart.ts`：

| 步驟 | 內容 | 位置 |
|---|---|---|
| Step 1/3 | Backend 偵測與選擇（PATH 掃描，偵測不到就中止並給安裝指令） | `detectBackends()` :37、:685 |
| Step 2/4 | Channel 平台選擇（Telegram / Discord） | :711 |
| — Telegram | BotFather 取 token → 驗證 → 加進群組 → `/start` 自動偵測 group/user | `runTelegramFlow()` :244 |
| — Discord | 貼 bot token → `verifyDiscordToken()` → `listDiscordGuilds()` 選 guild → 貼 User ID → **General Channel ID（必填）** | `runDiscordFlow()` :278 |
| Step 3 | 專案根目錄偵測（`detectProjectRoots()` 依 git 數排序）與確認 | :115、:743 |
| Step 4 | 寫 `fleet.yaml` + `.env`；可選 ClassicBot（guild 清單、預設 backend、admin users） | :760+ |
| 既有 fleet | 五選一：加 allowed users／加平台／加 persona bot／覆寫／略過 | :541 |

**值得注意**：`fleet.yaml` 已存在時，quickstart 走的是一個**完全不同的選單**，而不是同一條 wizard 的續集。這正是網頁版應該收斂掉的重複。

### A.2 三級分類

分類準則：**首次設定必經** = 沒有它 fleet 起不來；**日常常用** = 使用者每週會碰；**進階/少碰** = 裝完之後多數人不再動。

#### Level 1 — 首次設定必經（wizard 專屬）
- backend 選擇（`defaults.backend`）
- 平台選擇 Telegram / Discord
- bot token（寫入 `.env`，非 fleet.yaml）
- group / guild id
- **Discord General Channel ID**（目前 CLI 標為必填）
- allowed_users / admin user id
- 第一個 instance 的 working_directory

> 最少必要步驟：**backend → 平台 → 憑證 → group/user → 一個工作目錄**。其餘都可事後補。

#### Level 2 — 日常常用（常駐面板，卡片 + 行內編輯）
- 新增／刪除 instance、display_name、description、tags
- model / effort（#647）、backend 切換
- auto_pause_after、log_level、tool_progress
- allowed_users 增減、access mode（#647）
- instance 啟停／重啟

#### Level 3 — 進階/少碰（收進「進階」抽屜或 YAML）
- hang_detector、context_guardian、restart_policy
- agent_mode、tool_set、lightweight、model_failover
- system_prompt、warm_cap、mcp_proxy_reply、reply_completion_guard
- ClassicBot 全套、persona bot
- Developer YAML（保留，作為逃生出口）

**現況對照**：目前 UI 是六張長卡（My Agents / ClassicBot / Connections & Bots / General Settings / Developer YAML），Level 1 的欄位散落在各卡中、且**沒有任何引導順序**——首次使用者必須自己知道要先填哪張卡。

---

## (B) 業界流程模板

### B.1 Staged disclosure（分段揭露）/ Stepper
Jakob Nielsen 1995 年提出 progressive disclosure，把複雜任務拆成一次只呈現一段。NN/g 的兩個限制條件對我們特別重要：**分段揭露只在各步驟相依性低時有效**，否則使用者會在步驟間來回卡住；而且**超過兩層揭露通常可用性就掉下來**。

- **適配 AgEnD**：Level 1 的五個問題彼此相依性低（backend 與平台無關、憑證與工作目錄無關），適合 stepper。
- **取捨**：我們目前已經有三層（UI 自稱 `Developer · Level 3`），依 NN/g 的觀察這已經在可用性邊界上。提案因此**不再加第四層**，而是把 Level 3 收進單一「進階」抽屜。
- 來源：[Progressive disclosure（Wikipedia，含 Nielsen 1995 出處）](https://en.wikipedia.org/wiki/Progressive_disclosure)、[UXPin: What Is Progressive Disclosure in UX](https://www.uxpin.com/studio/blog/what-is-progressive-disclosure/)

### B.2 GHES Management Console：Save → apply → 服務重啟 → 逐段進度
這正是使用者提的類比。GHES 的 `ghe-config-apply`（等同 UI 的 Save settings、或 `POST /setup/api/configure`）會套用設定、重載系統服務、重載應用服務、跑 migration；UI 以**逐元件狀態**呈現進度（DONE / CONFIGURING / PENDING），整體狀態為 `running`。

- **適配 AgEnD**：我們的「重啟受影響的 instance」天然就是可逐元件呈現的——每個 instance 一列。
- **取捨**：GHES 的 apply 是**全域、序列、會中斷服務**；AgEnD 的 cold 變更只影響被改到的 instance，所以我們**不該照抄「全域 apply 鎖」**，而是 per-instance 進度。
- 來源：[GHES Management Console REST API](https://docs.github.com/en/enterprise-server@3.14/rest/enterprise-admin/management-console)、[GHES command-line utilities（ghe-config-apply）](https://docs.github.com/enterprise-server/admin/configuration/configuring-your-enterprise/command-line-utilities)

### B.3 Gitea / Nextcloud 首次安裝頁（pre-configuration setup mode）
Gitea 在尚未設定時，於同一個埠提供 setup 頁；**管理員帳號只有在這個階段能從網頁建立**。Nextcloud 的 installation wizard 同理，安裝完才進入一般 UI。

- **適配 AgEnD**：這就是 (D) 要的 pre-fleet 模式的業界先例——**同一個 web server，在「尚未設定」時提供不同的路由集合**。
- **取捨**：Gitea 的 setup 頁預設無認證（靠「先到先得」）。**我們不能照抄**：逃生艙是外網可達的，必須維持 token gate（見 D.4）。
- 來源：[Nextcloud installation wizard](https://docs.nextcloud.com/server/stable/admin_manual/installation/installation_wizard.html)、[Nextcloud web-installer](https://github.com/nextcloud/web-installer/blob/master/setup-nextcloud.php)

### B.4 條件式揭露（conditional disclosure）
只有在滿足條件時才顯示欄位。

- **適配 AgEnD**：平台選 Discord 才問 guild/General Channel、選 Telegram 才問 group——目前 CLI 已經是這樣做，網頁版照搬即可。
- **取捨**：條件式揭露會讓「這個設定在哪」變難搜尋，所以常用面板仍需一個**全域搜尋**入口。
- 來源：同 B.1（NN/g 將 conditional 與 staged 並列為兩種 progressive disclosure）

---

## (C) 改版設計：按鈕 + modal + guided wizard

### C.1 資訊架構

```
/settings
├─ [首次進入且無 fleet] → 自動導向 /settings/setup（wizard，見 C.2）
│
├─ 狀態列：fleet 執行中 / 已停止 · N 個 Agent · [套用變更 (n)] ← 既有 pendingBar
│
├─ 卡片區（Level 2，常駐）
│   ├─ 「Agents」卡：每個 instance 一列 → [設定] 按鈕開 modal
│   │     列上直接顯示：名稱 · 狀態燈 · model · [啟動/停止] [設定]
│   ├─ 「連線」卡：每個平台一列（Discord / Telegram）
│   │     列上顯示：平台 · bot 名稱 · guild/group · [設定] 按鈕開 modal
│   └─ 「存取」卡：allowed_users chips · access mode · [管理] 開 modal
│
├─ 「進階」抽屜（Level 3，預設收合）
│   └─ 裡面才是目前那些長列表：hang_detector / restart_policy / agent_mode …
│
└─ 「Developer YAML」（保留不動，逃生出口）
```

**核心改變**：長列表 → **每列一個 [設定] 按鈕 → modal**。modal 內只放該對象的欄位，並沿用既有的 `impact()` 標記。

### C.2 Guided quickstart wizard（低保真線框）

```
┌─ AgEnD 設定精靈 ─────────────────────── 1/4 ─┐
│  ● 建立 fleet   ○ 選平台   ○ 憑證   ○ 完成   │
│                                               │
│  偵測到的 backend：                            │
│   (•) Claude Code    ( ) Codex   ( ) Kiro     │
│   ⚠ 未偵測到任何 backend → [安裝說明]          │
│                                               │
│  第一個工作目錄：                              │
│   [~/Projects/AgEnD          ] [瀏覽]         │
│   偵測到 12 個 git 專案，已選最可能的一個       │
│                                               │
│                      [取消]  [下一步 →]        │
└───────────────────────────────────────────────┘

┌─ AgEnD 設定精靈 ─────────────────────── 2/4 ─┐
│  ✓ 建立 fleet   ● 選平台   ○ 憑證   ○ 完成   │
│                                               │
│   ┌──────────────┐  ┌──────────────┐          │
│   │  💬 Telegram │  │  🎮 Discord  │          │
│   │  適合手機    │  │  適合多頻道  │          │
│   └──────────────┘  └──────────────┘          │
│   （可之後再加另一個平台）                      │
└───────────────────────────────────────────────┘

┌─ AgEnD 設定精靈 ─────────────────────── 3/4 ─┐
│  ✓ 建立 fleet   ✓ 選平台   ● 憑證   ○ 完成   │
│                                               │
│  1. 開啟 BotFather → /newbot → 複製 token     │
│  2. Bot Token: [·····················] [驗證] │
│     ✓ 已驗證：@my_agend_bot                   │
│  3. 把 bot 加進群組後，在群組送 /start         │
│     ⏳ 等待中…  ✓ 偵測到 group -100… / user … │
│                                               │
│  （Discord 分支：驗證 token → 下拉選 guild →   │
│    貼 User ID → General Channel ID）           │
└───────────────────────────────────────────────┘

┌─ AgEnD 設定精靈 ─────────────────────── 4/4 ─┐
│  ✓ 建立 fleet  ✓ 選平台  ✓ 憑證  ● 完成      │
│                                               │
│  即將寫入：                                    │
│   • ~/.agend/fleet.yaml   （新建）             │
│   • ~/.agend/.env         （bot token）        │
│  接著會啟動 1 個 Agent。                       │
│                                               │
│                 [上一步]  [建立並啟動]          │
└───────────────────────────────────────────────┘

→ 按下後切換到「套用進度」畫面（見 D.3），而不是一個靜默的轉圈。
```

**與 CLI 的對應**：wizard 的四步就是 CLI 的 Step 1–4，只是把「fleet 已存在時的五選一選單」換成**回到常駐面板 + 對應的 modal**，不再是第二套流程。

### C.3 modal 的三條規則
1. **一個 modal 只改一個對象**（一個 instance、一個平台、一組存取設定）。跨對象的設定放常駐面板。
2. **modal 內不自動送出**：關閉 modal 只是把變更加入既有的 `state.pending`，實際寫入仍由頂部 `[套用變更]` 觸發——沿用現行語意，不新增第二種儲存模型。
3. **每個欄位保留 `impact()` 標記**，modal 底部彙總「此 modal 會造成：🔄 重啟此 Agent」。

---

## (D) 架構：Settings 能不能跟 fleet 解耦

### D.1 現況：hot / cold 邊界在哪，以及它被寫了五份

**權威來源**：`fleet-manager.ts:234` 的 `HOT_INSTANCE_CONFIG_KEYS`（9 鍵）—— `tool_progress`、`reply_completion_guard`、`mcp_proxy_reply`、`auto_pause_after`、`warm_cap`、`display_name`、`description`、`tags`、`log_level`。`splitHotColdConfig()`（:260）據此拆分，`reconcileInstances()`（:11426）把 hot 推進 live daemon、其餘維持重啟語意。

**但同一份知識實際上散在五處**（v1 只說了兩處，低估了）：

| # | 位置 | 內容 | 與權威的關係 |
|---|---|---|---|
| 1 | `fleet-manager.ts:234` | 9 鍵 | **權威** |
| 2 | `daemon.ts:3863` `applyConfigUpdate` | 實際只認 `tool_progress`/`reply_completion_guard`/`mcp_proxy_reply`/`auto_pause_after`/`warm_cap`/`tags`/`log_level` | 少了 `display_name`/`description`（由 fleet 端處理）——**差集是刻意的，但沒有任何東西擔保它不變** |
| 3 | `settings-api.ts:344` | classic PATCH 的 `hotOnly` 硬編碼 `tool_progress`、`reply_completion_guard` | 手寫子集 |
| 4 | `fleet-manager.ts:1852` | `restartClassicInstanceFromSettings` 再次硬編碼同樣兩個 | 與 #3 重複 |
| 5 | `settings.html` | **42 處**逐欄位手寫的 `impact("now"/"instance"/"fleet")` | 手寫，決定使用者看到的影響說明 |

**觸發方式**：`POST /api/settings/reload` 目前只是 `process.kill(process.pid, "SIGHUP")`（`settings-api.ts:356`），送出後沒有任何回傳通道。

> v1 說「schema endpoint 可以根治」——**不對，它只根治第 5 處**。票 1 因此改寫為「單一來源 + parity 測試」，見票表。

### D.2 Save→apply→restart→progress 缺什麼

**已經有的**：暫存模型（`settings.html:344` `stageChange`）、影響分級、套用前的安全確認、SSE 基礎建設（`web-api.ts:262-300`）、per-instance 重啟與 `RestartProgress`（#722 的終局送達與 deadline）。

**要新增的**：

1. **Apply job**：`POST /api/settings/apply` 回 `jobId`，內含每個受影響對象一列 `{ target, kind: "hot"|"restart", status, error? }`。對應 GHES 的逐元件 DONE/CONFIGURING/PENDING。
2. **冪等鍵必須由客戶端產生**。v1 只寫「同一個 jobId 重送不得重複重啟」，漏了真正的常態：行動網路上 POST 送達、**回應沒收到**、客戶端重送——此時 server 已 mint 了 jobId 而客戶端不知道，於是產生第二個 job、第二次重啟。**修正**：客戶端送 `Idempotency-Key`（或客戶端預產 jobId），server 在時間窗內對同鍵回同一個 job。逃生艙在行動網路上用，這是預設情境不是邊角。
3. **Job 必須落磁碟**。**fleet-impact 的變更會重啟 AgEnD 本身**——in-memory job 隨行程消失，重啟後 `GET /apply/:jobId` 回 404，進度永遠停在「重啟中」。這正是 #722／#748 的形狀再演一次。**修正**：job 寫磁碟標記，新行程啟動時讀標記、收尾成 `done` 並能回答 GET。
4. **SSE 只是加速通道，GET 才權威**。現行 SSE 不發 `id:`（`web-api.ts:262-300` 無 event id），沒有 Last-Event-ID 續傳，斷線就漏事件。因此進度畫面必須以輪詢 GET 為真相來源、SSE 只用來降低延遲。
5. **終局保證**：每個 job 一個 wall-clock deadline，逾時明講「仍在重啟中(Ns)」而非靜默（#722 教訓）。

### D.3 套用進度畫面（線框）

```
┌─ 正在套用 3 項變更 ───────────────────────────┐
│                                               │
│  ⚡ 立即生效                                   │
│   ✓ general：log_level → debug                │
│                                               │
│  🔄 需重啟                                     │
│   ✓ doupo-leader   已重啟 (4.2s)              │
│   ⟳ doupo-server   重新啟動中… (12s)          │
│   ○ doupo-devenv   等待中                     │
│                                               │
│  ⚠ 仍在重啟中的 Agent 會自己回來，不需要手動處理 │
│                        [在背景繼續] [關閉]      │
└───────────────────────────────────────────────┘
```
（重啟 AgEnD 本身時，此畫面在新行程接手後由磁碟 job 標記續播，而不是回 404。）

### D.4 解耦邊界（v2 重寫）

#### D.4.1 現況更正

`WebApiContext`（`web-api.ts:138-149`）已含 `deliverToInstance`、`startInstance`、`stopInstance`、`restartSingleInstance`、`removeInstance`、`connectIpcToInstance`、`saveFleetConfig`；`settings-api` 另呼 `ctx.lifecycle.pause/wake`（:189）與 `ctx.restartClassicInstanceFromSettings`（:327-336）。**web 層已經是控制面。**

兩條看似自然的 pre-fleet 實作因此都不能用：
- **stub context 承載同一份 handler** → 在無 fleet 行程裡放進可 spawn instance 的動詞（提權面）。
- **setup 宿主內嵌 FleetManager** → 第二個 fleet，與正式 fleet 搶 port / tmux server / IPC socket，並可能同時寫 fleet.yaml。

#### D.4.2 建議：把 context 拆成兩個介面

```ts
// 只碰檔案，永遠可在無 fleet 下實作
interface ConfigVerbs {
  readFleetConfig(): FleetConfig | null;
  writeFleetConfig(patch): void;      // fleet.yaml
  writeClassicConfig(patch): void;    // classicBot.yaml
  writeSecret(key, value): void;      // .env
  validate(candidate): ValidationResult;
}

// 現有那一組，只有正式 fleet 行程能實作
interface LifecycleVerbs {
  startInstance(...); stopInstance(...); restartSingleInstance(...);
  removeInstance(...); deliverToInstance(...); connectIpcToInstance(...);
  lifecycle: { pause(...); wake(...) };
}
```

- 正式 fleet 的 web server 同時實作兩者（行為不變）。
- **setup 宿主只實作 `ConfigVerbs`**；`LifecycleVerbs` 的路由一律回 **409 `fleet not running`**。關鍵在於**靜態型別上就拿不到 daemon**，不是靠執行期判斷——否則哪天有人加一條新路由就又漏了。

#### D.4.3 setup 宿主：表單 + spawn + 自行退出

採 fable 建議的更省邊界：**setup 宿主不是新的 web server**，而是 **quickstart 既有寫檔邏輯 + 一個極小 HTTP 表單**，只提供 wizard 四步與一個 launch 動作，**不載入 `settings.html`**。攻擊面因此只剩四個表單 + 一個 spawn。

```
CLI: agend setup --web
  └─ 印出 http://127.0.0.1:PORT/setup?t=<一次性 token>
     ├─ [表單 1-4] 寫 fleet.yaml / .env（只用 ConfigVerbs）
     └─ [建立並啟動] ─┬─ 寫 setup-complete 標記
                      ├─ spawn `agend start`（或 service start）
                      ├─ 釋放 port、行程退出          ← 宿主不再存在
                      └─ 瀏覽器輪詢同一 port
                          └─ 正式 fleet 的 web server 接手
                             （web.token 來自 dataDir，跨行程有效）
```

**票 5 必須明寫的三件事**：
1. **port 交接**：宿主先完全釋放再 spawn，或約定正式 fleet 起在同一 port 並容忍短暫 connection refused；瀏覽器端以輪詢處理空窗。
2. **宿主退出時機**：spawn 成功即退出，不等 fleet ready（否則宿主活著的時間不可控）。ready 由瀏覽器輪詢正式 server 判斷。
3. **fleet 已在跑時拒絕啟動 setup 宿主**：避免兩個行程同時寫 fleet.yaml。判斷依 pid 檔 + port 佔用。

### D.5 安全（v2 重寫）

#### D.5.1 既有 gate 的實況

- 一把**長期不輪替**的 `web.token`（`fleet-manager.ts:2514`），比對方式為純字串相等（`web-api.ts:204-206`）。
- 接受 `?token=` query 或 header。
- **啟動時把含 token 的完整 URL 寫進 fleet.log**（`fleet-manager.ts:12182`：``{ url: `http://localhost:${port}/ui?token=${this.webToken}` }``）。
- 無 cookie、無 CSP、無 Referrer-Policy。
- `GET /view` **完全不需 token**（`view-api.ts:5` 註解即寫明 "static page (no token)"）。

外網可達之後：token 會留在瀏覽器歷史、截圖、Referer 與 log；**洩漏即永久有效**。而 Settings 能改整個 fleet 與 `.env`，威脅面比 web terminal 大。

#### D.5.2 setup 授權不使用 web.token

- **一次性 setup token 由 CLI 在本機 shell 產生**（本機 shell ≈ admin 等價），**TTL ~15 分鐘、完成即消耗、連續三次失敗即銷毀並要求重新 `agend setup --web`**。
- 理由：pre-fleet 沒有 admin 概念，而 `web.token` 是長期憑證；拿長期憑證當 setup 授權等於把「一次性高權限操作」綁在「永久低輪替憑證」上。

#### D.5.3 setup 只能跑一次，且不可靠刪檔復活

- 寫一個**獨立於 fleet.yaml 的 `setup-complete` 標記**（放 dataDir），路由拒絕**以標記為準**。
- 重跑只能 `agend setup --web --reset`（本機 shell）。**刪掉 fleet.yaml 不會讓 setup 路由復活**——否則外網可達環境裡，任何能刪檔的路徑都變成重置整個 fleet 的入口。

#### D.5.4 時間窗 = 宿主行程自行退出

不用計時器關路由（可被繞過或忘記），而是**宿主完成後直接退出**。這是唯一不可繞過的時間窗形式：行程不在，端點就不存在。

#### D.5.5 Audit 的誠實界線

append-only 檔可行，但必須寫明：目前只有**一把** `web.token`，所以 audit 只能記「**哪一把 token** 做了什麼」，**不是「誰」**。要做到「誰」需要先有 per-user 憑證，不在本提案範圍。

#### D.5.6 `/view` 無 token（需使用者決策）

`allow_public` 一開，`/view` 會公開 instance 名稱與活動。這是產品決策不是技術問題，已請 leader 轉使用者定奪；本提案不預設答案。

## 未決與風險

1. **票 5 的 port 交接**是最需要先 spike 的一塊：宿主退出與正式 fleet 起在同一 port 之間有一段空窗，瀏覽器體驗取決於輪詢處理得好不好。
2. **`daemon.applyConfigUpdate` 與 `HOT_INSTANCE_CONFIG_KEYS` 的差集是刻意的**（`display_name`/`description` 由 fleet 端處理），但目前沒有任何東西擔保這個差集不會悄悄改變——票 1 的 parity 測試就是為此。
3. **NN/g 的「超過兩層揭露可用性下降」**與現有三層（含 Developer YAML）有張力。提案把 Level 3 收成單一抽屜，需使用者確認。
4. **`/view` 無 token 在 `allow_public` 下的暴露面**，待使用者決策。
5. 本文未涵蓋 tunnel 接線本身與 #769 的 adapter↔core 解耦。

## 實作拆分（票 0–5）

| # | 範圍 | 相依 | 備註 |
|---|---|---|---|
| **0** | **既有 Settings gate 硬化**：token → HttpOnly `SameSite=Strict` cookie（query token 僅用於一次性換發）、`Origin == Host` 檢查、`Referrer-Policy: no-referrer`、**停止把含 token 的 URL 寫進 log**（`fleet-manager.ts:12182`） | 無 | **必須排在 tunnel 接線之前**。否則 UX 改版一上線，外網可達的就是一個長期 token 面板 |
| 1 | **hot/cold 單一來源**：`HOT_INSTANCE_CONFIG_KEYS` 為權威；classic `hotOnly` 從同一集合推導（消除 `settings-api.ts:344` 與 `fleet-manager.ts:1852` 兩份硬編碼）；新增 schema endpoint 回每欄 impact，前端刪除 42 處手寫；**加 parity 測試**斷言 `daemon.applyConfigUpdate` 接受的鍵集合 == HOT 集合 − fleet 端處理的鍵 | 無 | 是票 2 的前置：進度畫面必須與 server 同一份認知 |
| 2 | **Apply job**：客戶端產生冪等鍵、job 落磁碟並可跨 AgEnD 重啟續播、`GET /apply/:jobId` 為權威、`apply_progress` SSE 僅作加速、wall-clock deadline | 1 | |
| 3 | **常駐面板改版**：長列表 → 列 + [設定] modal；Level 3 收進單一抽屜 | 1 | |
| 4 | **Guided wizard**（有 fleet 時可於 modal 內重跑） | 3 | |
| 5 | **pre-fleet setup 宿主**：`ConfigVerbs`/`LifecycleVerbs` 介面拆分；極小表單宿主（不載入 settings.html）；CLI 一次性 token；`setup-complete` 標記；spawn 後自行退出；**port 交接、退出時機、fleet 已在跑時拒絕啟動** | 2, 4 | 風險最高，建議先 spike；請 fable 複審 |

## 來源

- [Progressive disclosure — Wikipedia（Nielsen 1995 出處）](https://en.wikipedia.org/wiki/Progressive_disclosure)
- [What Is Progressive Disclosure in UX? — UXPin](https://www.uxpin.com/studio/blog/what-is-progressive-disclosure/)
- [Management Console REST API — GitHub Enterprise Server](https://docs.github.com/en/enterprise-server@3.14/rest/enterprise-admin/management-console)
- [Command-line utilities（`ghe-config-apply`）— GitHub Enterprise Server](https://docs.github.com/enterprise-server/admin/configuration/configuring-your-enterprise/command-line-utilities)
- [Installation wizard — Nextcloud Administration Manual](https://docs.nextcloud.com/server/stable/admin_manual/installation/installation_wizard.html)
- [nextcloud/web-installer — GitHub](https://github.com/nextcloud/web-installer/blob/master/setup-nextcloud.php)
