# Settings 網頁改版：以 quickstart 引導為核心

設計提案（**尚未實作、不改動 production 行為**）。供使用者審查；審過再拆實作 ticket。
關聯：#192→#647（Settings 現況）、#577（hot/cold reconcile）、#623（逃生艙）、#769（adapter↔core 解耦 + Web UI 控制面 epic）。

本文所有「現況」敘述都附了程式碼位置，方便審查者自行驗證，而不是只看結論。

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

### D.1 現況：hot / cold 邊界在哪

**server 端（唯一權威）**：`src/fleet-manager.ts:234` 的 `HOT_INSTANCE_CONFIG_KEYS` —
`tool_progress`、`reply_completion_guard`、`mcp_proxy_reply`、`auto_pause_after`、`warm_cap`、`display_name`、`description`、`tags`、`log_level`。

`splitHotColdConfig()`（:260）把一份 instance config 拆成 hot / cold；`reconcileInstances()`（:11426）重讀 fleet.yaml 後：**hot 欄位推進 live daemon；其餘 instance 欄位與 cold fleet-level 設定維持「需重啟」語意**（見 :11420-11424 的註解）。ClassicBot 走同一條路（:11585「Classic cold config changed — restarting」）。

**觸發方式**：`POST /api/settings/reload` 目前只是 `process.kill(process.pid, "SIGHUP")`（`settings-api.ts:356`）——送出後**沒有任何回傳通道**告訴前端「協調到哪了」。

**前端**：`settings.html:376` 有一份手抄的 `HOT_FIELDS`，用來把欄位標成 ⚡ 立即／🔄 重啟。

> **建議先修的小債**：把 hot 欄位清單改由 API 下發（例如 `GET /api/settings/schema` 回傳 hot keys 與每個欄位的 impact），前端不再自己維護第二份。這是 Save→apply→progress 的前置，因為進度畫面必須跟 server 對同一份 hot/cold 認知。

### D.2 要做到 GHES 式 Save→apply→restart→progress，缺什麼

**已經有的**：
- 暫存變更模型：`state.pending` / `stageChange()` / `applyPendingChanges()`（`settings.html:344-365`）
- 每筆變更的影響等級：`now` / `instance` / `fleet`
- 套用前的安全確認：access mode 變更的 `change.confirm()` 前置檢查（:351-358，刻意在第一次寫入前跑完所有確認，避免部分套用）
- SSE 基礎建設：`web-api.ts:270` 已有 `text/event-stream` 與廣播函式
- per-instance 重啟與進度：`RestartProgress`（#722 已有終局送達與 deadline）

**要新增的**：
1. **Apply job 物件**：`POST /api/settings/apply` 回傳 `jobId`，而不是現在的 fire-and-forget SIGHUP。job 內含每個受影響對象一列：`{ target, kind: "hot"|"restart", status: "pending"|"running"|"done"|"failed", error? }`。這正是 GHES 逐元件 DONE/CONFIGURING/PENDING 的對應物。
2. **進度事件**：沿用既有 SSE 通道，新增 `apply_progress` 事件（`jobId` + 該列狀態變化）。**不需要新的傳輸層**。
3. **job 狀態查詢**：`GET /api/settings/apply/:jobId`，供重新整理／斷線重連後補看（SSE 斷線是常態，逃生艙尤其）。
4. **終局保證**：比照 #722——每個 job 有 wall-clock deadline，逾時要明講「仍在重啟中(Ns)」而不是靜默。這條是我在 #748 學到的：**把成功訊息卡在長流程後面，使用者會以為它掛了**。
5. **冪等**：同一個 jobId 重送不得重複重啟（逃生艙在行動網路上重送很常見）。

**不需要新增**：暫存模型、影響分級、SSE 傳輸、per-instance 重啟本身。

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

### D.4 pre-fleet setup 模式（逃生艙關鍵情境）

**可行性比預期高，證據**：
- `SettingsApiContext.fleetConfig: FleetConfig | null`、`configPath: string | null`（`settings-api.ts:38-40`）——型別上已經容許「還沒有 fleet」。
- `GET /api/settings/fleet` 在無 fleet 時回 `{}` 而不是炸掉（:166 `ctx.fleetConfig ?? {}`）。
- web token 來自 `loadOrCreateWebToken(dataDir)`（`web-auth.ts:33`）——**不依賴 fleet.yaml**，所以 token gate 在 pre-fleet 就能成立。

**建議的解耦邊界**：

```
            ┌────────────────────────────┐
  瀏覽器 ──▶│  web server（永遠可跑）      │
            │  ├ token gate（web.token）  │  ← 無 fleet 也有效
            │  ├ /settings/setup  (無 fleet 時)│
            │  └ /settings        (有 fleet 時)│
            └───────────┬────────────────┘
                        │ 只透過兩個動詞
                        ▼
            ┌────────────────────────────┐
            │  config 層：讀/寫 fleet.yaml │
            │  classicBot.yaml / .env     │
            └───────────┬────────────────┘
                        │ applyJob（新增）
                        ▼
            ┌────────────────────────────┐
            │  fleet 生命週期              │
            │  reconcile / start / restart│
            └────────────────────────────┘
```

**邊界規則**：
1. **web 層永不直接操作 daemon**，只產生 config 變更與 apply job；由 fleet 層去 reconcile。這讓 Settings 在 fleet 未啟動時仍可運作（只是 apply job 會是「建立並啟動」而非「重啟」）。
2. **pre-fleet 時 web server 由誰啟動**：目前 web server 由 FleetManager 啟。pre-fleet 模式需要一個**不需要 fleet.yaml 就能起的最小宿主**（`agend setup --web` 之類）。這是唯一需要新增生命週期的地方，也是這份提案裡風險最高的一塊，建議單獨拆 ticket 並請 fable 看。
3. **setup 完成即收斂**：wizard 最後一步寫檔 + 啟動 fleet，之後 `/settings/setup` 應該**拒絕再次提供**（比照 Gitea 的「admin 只能在 setup 階段建立」），避免外網可達的環境留著一個能重寫整個 fleet 的入口。

### D.5 安全（不弱化）

- **維持既有 token gate**：所有 `/api/settings/*` 已由全域 web-token gate 保護（`settings-api.ts:18` 的註解、`web-api.ts:204-206`）。pre-fleet 模式**照用同一個 gate**，token 來自 dataDir，第一次啟動即產生。
- **admin gate 不因 pre-fleet 而放寬**：有 fleet 之後，設定/重啟面板仍走 admin 判定；pre-fleet 階段沒有 admin 概念，因此**必須靠 token + 「setup 只能跑一次」** 兩層，而不是放行。
- **逃生艙預設外網可達**（cloudflared + `allow_public:true`，見 leader 的 project decision），所以：
  - setup 模式建議加**時間窗**（例如啟動後 N 分鐘內未完成即關閉 setup 路由，需重新以 CLI 開啟），降低「裝好忘了設定」的暴露面。
  - apply/restart 這類有副作用的動作，建議在 audit log 留一筆（誰的 token、改了什麼、job 結果）。
- **不建議**照抄 Gitea 的無認證 setup 頁。

---

## 未決與風險

1. **pre-fleet 的 web 宿主**（D.4 規則 2）是唯一需要新增生命週期的部分，也是最該先做 spike 的。
2. **hot 欄位兩份清單**（D.1）建議在 apply job 之前先收斂，否則進度畫面會用一份可能過期的認知去標示影響。
3. **NN/g 的「超過兩層揭露可用性下降」**與我們現有的三層（含 Developer YAML）有張力。提案的做法是把 Level 3 收成單一抽屜而不是再細分，但這需要使用者確認接受。
4. 本文未涵蓋 tunnel 接線（排在此 UX 改版之後）與 #769 的 adapter↔core 解耦本身。

## 建議的實作拆分（供審過後開票）

| # | 範圍 | 相依 |
|---|---|---|
| 1 | `GET /api/settings/schema`：hot keys + 欄位 impact 由 server 下發，前端刪除手抄清單 | 無 |
| 2 | Apply job + `apply_progress` SSE + `GET /apply/:jobId` + deadline/冪等 | 1 |
| 3 | 常駐面板改版：長列表 → 列 + [設定] modal；Level 3 收進抽屜 | 1 |
| 4 | Guided wizard（有 fleet 時可重跑於 modal 內） | 3 |
| 5 | pre-fleet setup 模式（最小 web 宿主 + 一次性 setup 路由 + 時間窗） | 2, 4 |

---

## 來源

- [Progressive disclosure — Wikipedia（Nielsen 1995 出處）](https://en.wikipedia.org/wiki/Progressive_disclosure)
- [What Is Progressive Disclosure in UX? — UXPin](https://www.uxpin.com/studio/blog/what-is-progressive-disclosure/)
- [Management Console REST API — GitHub Enterprise Server](https://docs.github.com/en/enterprise-server@3.14/rest/enterprise-admin/management-console)
- [Command-line utilities（`ghe-config-apply`）— GitHub Enterprise Server](https://docs.github.com/enterprise-server/admin/configuration/configuring-your-enterprise/command-line-utilities)
- [Installation wizard — Nextcloud Administration Manual](https://docs.nextcloud.com/server/stable/admin_manual/installation/installation_wizard.html)
- [nextcloud/web-installer — GitHub](https://github.com/nextcloud/web-installer/blob/master/setup-nextcloud.php)
