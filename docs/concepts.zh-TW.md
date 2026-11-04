# AgEnD 概念與定義

草稿。每個詞條描述 main 上程式碼今天的行為，皆已對照所列檔案驗證。推論之處會標明。角色名稱採用使用者的定義；程式碼與決議不一致之處，見文末「不一致之處」。

## fleet（艦隊）

一台主機上的整個多 agent 系統：instance、排程、team、決議與任務板，由同一個 daemon 依同一份 `fleet.yaml`、在同一個 AgEnD 家目錄（`~/.agend`）下驅動。

- 能做什麼：透過聊天連線、網頁儀表板，或兩者，同時驅動多個 agent。
- 不能做什麼：不能橫跨多台主機。只有一個 daemon、一個 fleet 行程、一個家目錄。
- 程式碼：`src/fleet-manager.ts`（`FleetManager`）、`src/config.ts`（`FleetConfig`）。
- 相關決議與議題：—

## instance / agent

一個 agent 就是一個 instance：一個 daemon 駕駛一個 CLI、跑在各自的 tmux 窗格裡，有各自的對話紀錄、topic 或房間、工具組。`instance` 是設定與執行時期的用詞（`fleet.yaml` 的 `instances`）；`agent` 是日常用詞。

- 能做什麼：在工具組範圍內聊天、呼叫 MCP 工具；用 `send_to_instance`、`delegate_task`、`report_result` 與其他 instance 傳訊。
- 不能做什麼：不能超出自己的工具組；除了透過 fleet 工具，不能碰其他 instance 的狀態（同一 OS 使用者下的行程彼此並不隔離——見 `docs/design/coordinator-tool-perms.zh-TW.md`）。
- 程式碼：`src/daemon.ts`、`src/instance-lifecycle.ts`。
- 相關決議與議題：#804。

## General

使用者的定義：AgEnD 的管理者。General 是艦隊的管理 instance——新艦隊的第一個 agent——擁有 General topic。`general_topic: true` 或名字就叫 `general` 的 instance，跑的是 `general` 工具組。

- 能做什麼（beta.8 時點）：`general` profile 裡的全部——完整 worker 能力，加上 `create/start/restart/wake_instance`、委派、排程，以及使用者的網頁外觀設定（`src/tool-permissions.ts:107-136`）。
- 不能做什麼（beta.8 時點）：其餘 orchestration 動詞——`delete/stop/pause/replace_instance`、team、template、fleet 預設值與 instance 設定、`migrate/reconcile_kiro_instance`、`update_decision`。依使用者決議，它將透過一個進行中的改動取得全部 orchestration 工具；截稿時在 open PR 中找不到該改動（標為未驗證）。
- 程式碼：`src/tool-permissions.ts:107-136`、`:201-208`；`src/instance-lifecycle.ts:2741`（General instance 不能被 replace）。
- 相關決議與議題：使用者決議 9e3bea6c（截稿時無法用 `list_decisions` 查到——見「不一致之處」）。

## coordinator（角色）與 `coordinator` 工具組

兩回事。角色是合併守門人：只有 coordinator 能合併，在 parity reviewer 的 APPROVE 到達時跑 `scripts/gate-merge.sh`；作者永遠不跑 `gh pr merge`。工具組是 `TOOL_PROFILES.coordinator = WORKER + ORCHESTRATION`：全部 worker 能力，加上所有「經營艦隊而非做事」的動詞。

- 角色能做什麼：透過 gate 合併已審查的 PR。不能做什麼：不能批准——只有 parity reviewer 的 APPROVE 算數。
- 工具組能做什麼：新增／刪除／取代／啟動／停止／暫停／喚醒／重啟 instance、管理 team 與 template、改 fleet 預設值與 instance 設定、跑 kiro 遷移與對帳、改別人的決議與網頁設定（`src/tool-permissions.ts:80-98`）。
- 程式碼：`scripts/gate-merge.sh`、`src/tool-permissions.ts:100-107`。
- 相關決議與議題：62a2fffb（只有 coordinator 能合併）、e723a50a、4e928ba6、`docs/design/coordinator-tool-perms.zh-TW.md`（僅有正體中文版）。

## worker

做事的 instance 用的 `worker` profile——沒寫 `tool_set` 時的預設值（`resolveToolSet`，`src/tool-permissions.ts:201-208`）。

- 能做什麼：跟人說話、向同伴回報（`send_to_instance`、`report_result`、`request_information`、`broadcast`、`delegate_task`、`delivery_status`）、讀艦隊狀態、跑自己的任務卡與排程、維護自己的主題與辦公室角色。
- 不能做什麼：任何 orchestration 動詞。被拒絕時會指名 coordinator，並建議用回報代替（`src/tool-permissions.ts:357-374`）。
- 程式碼：`src/tool-permissions.ts:33-78`（`WORKER`）、`:185-208`。
- 相關決議與議題：#804、#895（只能排自己的排程）。

## team 與 team leader

team 是 instance 的具名分組（`fleet.yaml` 的 `teams`），用於定點廣播與顯示分群。程式碼裡沒有 team leader 這個角色：協調落在委派或分派工作的那個 instance 身上。

- 能做什麼：一次對多個 instance 說話；側欄與辦公室分群顯示。
- 不能做什麼：不授予任何權限——沒有推選、沒有 leader 專屬工具。
- 程式碼：`create_team`、`list_teams`、`update_team`、`delete_team`（`src/channel/mcp-tools.ts`）。
- 相關決議與議題：見「不一致之處」。

## topic / General topic

topic 是一個 instance 的聊天歸屬：綁定到它的 Telegram 論壇主題（其他連線則是對應範圍）。General topic 是 General instance 的 topic。屬於 General 的指令，在別處只會回答「請到 General topic 用它」。

- 能做什麼：在那裡說話，就能精確找到那個 instance。
- 不能做什麼：不能在別的 topic 跑 General 專屬指令。
- 程式碼：`src/topic-commands.ts`；`src/instance-lifecycle.ts:2257`；`src/tool-permissions.ts:207`。
- 相關決議與議題：—

## Classic（ClassicBot）房間

ClassicBot 跑單一 agent 的私聊或群組，由 `classicBot.yaml` 管理——與 fleet topic 分開，有自己的管理員（`defaults.admin_users`）與聊天白名單。

- 能做什麼：在房間裡 `/start` 一個 agent 並跟它聊天。
- 不能做什麼：不能用 fleet topic 的指令；看不到艦隊；未註冊的聊天除非允許 `/start`，否則保持靜默。
- 程式碼：`src/classic-channel-manager.ts`。
- 相關決議與議題：`docs/permissions.md`。

## web-only fleet（純網頁艦隊）

完全沒有 Discord 或 Telegram 連線的艦隊，從網頁儀表板使用（使用者決議，2026-11-01/02）。它的 agent 跑在 topic 模式，所以仍能從儀表板互傳訊息。

- 能做什麼：聊天艦隊能做的事都能做，只是入口是 `/ui` 而不是聊天。
- 不能做什麼：沒有聊天輸入；沒有 `/web revoke`（根本沒有 `/web`）——它的 Notice 會寫主機上的做法：把每個瀏覽器都登出。
- 程式碼：`src/web-only-fleet.ts:10-22`；`src/fleet-manager.ts:7807-7808`。
- 相關決議與議題：28c2d3a3。

## host owner / operator（主機擁有者／操作者）

AgEnD 電腦上的那個人。在純網頁艦隊裡，就是在這台電腦上跑 `agend web --code` 的那個 session（`HOST_OPERATOR`）：它確認自己的授權、回答自己的提問。

- 能做什麼：確認網頁授權、登入、批准指名要主機操作者的事。
- 不能做什麼：不能從別台電腦冒充操作者；session 被撤銷或過期後也不行。
- 程式碼：`src/authority/web-authority.ts`（`HOST_OPERATOR`）；`src/fleet-manager.ts:2056-2060`；`src/locale.ts:1505-1506`。
- 相關決議與議題：28c2d3a3。

## fleet admin（`admin_users`）

列在某連線 `access.allowed_users`（艦隊）或 `defaults.admin_users`／`allowed_users`（ClassicBot）裡的平台使用者 id。管理員是按人授予的，不是按 instance。

- 能做什麼：管理員限定的指令、確認敏感變更、管理存取權。
- 不能做什麼：沒列名就什麼都不行——空名單等於誰都不給；開放存取或 pairing 核准本身不授予這個角色（`docs/SECURITY.md:13`）。
- 程式碼：`src/config-validator.ts:368-376`、`:677`。
- 相關決議與議題：—

## guest（網頁訪客）

不是艦隊管理員、拿訪客碼登入儀表板的人（`web.guests`，#1920）。訪客只能看到被授權的 agent，且限於它在聊天裡本來就能用的。

- 能做什麼：跟被授權的 agent 聊天；用 `/web revoke` 只登出自己的 session。
- 不能做什麼：管理員路由、Notice、用量報告，以及艦隊對訪客關閉的一切。
- 程式碼：`src/config-validator.ts:738-740`。
- 相關決議與議題：#1920。

## tool set / tool profile（`full`、`coordinator`、`general`、`worker`、`standard`、`minimal`）

伺服器端的對照表，決定一個 instance 能呼叫哪些 MCP 工具（`TOOL_PROFILES`，`src/tool-permissions.ts:100-157`）。寫了 `tool_set` 就以它為準；否則 General instance 拿 `general`，其他一律預設 `worker`（`resolveToolSet`，`:201-208`）。

- `full`：全部工具。只能明示指定；預設不會拿到（環境變數 fallback 除外，`:212-222`）。
- `coordinator`：worker 能力加全部 orchestration 動詞——經營艦隊用的 profile。
- `general`：worker 能力加一部分 orchestration（`create/start/restart/wake_instance`）與使用者的網頁設定。刻意比 coordinator 小：分派的人不需要刪除 instance 或重寫 fleet 預設值。
- `worker`：預設值。負責做事，有 `standard` 沒有的回報能力（`report_result`）。
- `standard`：讀取範圍廣，也有自己的排程與主題，但沒有 `report_result`、`delegate_task`、`request_information`——走不完「委派→做事→回報」。
- `minimal`：窄小的發送者——回覆、轉交、查送達、讀決議、下載附件、看 emoji／貼圖列表。
- 程式碼：`src/tool-permissions.ts:30-157`。
- 相關決議與議題：#804。

## Needs you（需要你）

儀表板的 `/ui/needs` 佇列加上 `needs_you` 設定：停下來等人的事項——權限提問、用量上限暫停、agent 不能代答的對話框、未確認的送達。

- 能做什麼：逐項確認。
- 不能做什麼：agent 不能代人回答。
- 程式碼：`src/config.ts:284-293`；`src/web-api.ts`（`/ui/needs/ack`）；`src/daemon.ts:1564`、`:2071`、`:9888`。
- 相關決議與議題：—

## Notices（通知）

純網頁艦隊的 Notices 動態（`/ui/notices`）——General 本來會在聊天裡說的話，留存、推送、列出。只有管理員看得到，訪客不行。

- 能做什麼：列出、標為已讀。
- 不能做什麼：訪客不能讀；有聊天的艦隊這裡是空的，因為 General 會直接說。
- 程式碼：`src/web-api.ts:2346-2349`；`src/fleet-manager.ts:7807-7808`。
- 相關決議與議題：#2910 D2。

## delivery：✅ 👀 ❌、「uncertain」、queued hand-off（#3030）

頻道訊息的狀態表情，由送達的 daemon 驅動：⏳ 排隊中（CLI 在忙，先等）、👀 已送達（貼上並送出 Enter，agent 收到了）、✅ 已確認（觀察到處理中，或原生佇列交接成功）、❌ 失敗（視窗沒了、重試用完）。跨 instance 的列多了兩種狀態：`uncertain`——證據不足以判斷，所以絕不重送，也絕不拿它當同意轉交；queued hand-off（#3030）——交給後端原生佇列的訊息，會盯著 transcript 看，等某個 turn 把它吃掉就 ✅，一直沒被吃就 ❌。

- 能做什麼：一眼看出訊息走到哪一步。
- 不能做什麼：不能證明授權。收據只證明 CLI 收到了那些位元組，不證明人批准了那件事——不可逆的操作前，先驗證人的收據。
- 程式碼：`src/daemon.ts:7907-7913`、`:2450-2545`；`docs/delivery-verification.md`。
- 相關決議與議題：#3030、7244b130、954e5e96。

## schedule（排程）

艦隊的計時器：cron 式或一次性時間，到點就往某個 instance 塞一則訊息（`create_schedule`、`list_schedules`、`update_schedule`、`delete_schedule`）。非 coordinator 的排程只能排自己、且必須是自己建的；要動別人的排程，得是 `full`、`coordinator` 或 `general`。

- 能做什麼：按表把 instance 叫醒並塞訊息給它。
- 不能做什麼：不能超出自己的範圍——卡的是對象，不是工具有沒有。
- 程式碼：`src/channel/mcp-tools.ts`（排程工具）；`src/tool-permissions.ts:67`、`:382`。
- 相關決議與議題：#895。

## task board card（任務卡）

追蹤工作的單位。主任務 `M-n` 是成果；子任務 `S-n` 是主任務下面的步驟。狀態：open、claimed、review、done、blocked、cancelled。等人的確認的主任務會進 review；艦隊內部的卡由擁有者自己關掉。

- 能做什麼：把狀態、驗收標準、留言與結果，跨 turn、跨 instance 帶著走。
- 不能做什麼：不能代替人的共識——blocked 的卡還是要等人（或 dispatcher）回答。
- 程式碼：`task` 工具（`src/channel/mcp-tools.ts:79-80`）。
- 相關決議與議題：1ea064ae（分派一律上板）；內部卡自己關的 team 規則（沒有決議 id——leader 指示）。

## decision（決議）

記錄下來的共識（`post_decision`、`list_decisions`），範圍是某個專案目錄或整個艦隊。決議是艦隊記住「為什麼」的地方，gate 與 reviewer 都會引用它。

- 能做什麼：約束之後的行為（gate 會核對引用的決議內容）。
- 不能做什麼：不能自己執行——從來不讀它的程式碼，不受它約束（見「不一致之處」）。
- 程式碼：`post_decision`、`list_decisions` 工具定義。
- 相關決議與議題：dbcb1de2（發版時清理過期決議）。

## credential profile（憑證設定檔）

某個 backend 的具名憑證組（`CREDENTIAL_HOMES`），讓一個艦隊能用多個帳號做事。`/login <backend> <profile>` 登入某個設定檔；能從聊天裡登入的 backend 只有一部分。

- 能做什麼：按 instance 或 backend 分開帳號。
- 不能做什麼：不能跨 backend 共用——設定檔屬於它 backend 的家。
- 程式碼：`src/backend/credential-profile.ts:5-13`、`:266-295`。
- 相關決議與議題：—

## native Windows agent / paired PC / runtime

AgEnD 今天跑在 Linux 與 macOS 上（Windows 上是跑在 WSL 裡，桌面捷徑用 `agend shortcuts` 建）。原生 Windows runtime 是 `release/2.3.5-alpha` 上的 alpha 工作，改寫外部 #2934 而來。Pairing（`agend access pair`）是按 instance 發給人的存取碼——「paired PC」這個詞在程式碼與文件裡都不存在。

- 能做什麼（alpha 落地後）：在 Windows 上原生跑 agent。
- 不能做什麼（今天）：在 WSL 之外跑 Windows。
- 程式碼：`src/windows-shortcuts.ts`；`src/cli.ts:1241`（pairing 模式）；`docs/cli.md:394-398`。
- 相關決議與議題：72353fdf；見「不一致之處」。

## public link（quick 與 named，公開連結）

給不在主機邊的人的臨時儀表板入口。quick 是自動建的 `trycloudflare.com` 通道網址，效期短；named 是操作者自己的網域，效期長。訪客可以搭已開啟的公開連結進來，但永遠不帶授權。

- 能做什麼：不用聊天帳號也能看儀表板（搜尋、用量報告、辦公室分享，有開才有）。
- 不能做什麼：需要直連儀表板的管理介面不行（訪客、網頁授權、儀表板自己的網頁設定）。
- 程式碼：`src/config-validator.ts:424-429`；`src/office-share-service.ts:6`（quick 通道 429）；`src/public-preview.ts:4-5`。
- 相關決議與議題：`docs/named-tunnel.md`。

## web session 與 verified web go-ahead（已驗證的網頁授權）

web session 是登入的瀏覽器（直連儀表板、區網、tailnet，或 opt-in 的連結）。session 要帶上帳號的授權——訊息顯示為 `via web (verified)`——必須該帳號先在 Discord 或 Telegram 上確認過（#1939）；訪客 session 永遠沒資格。Agent 檢查 `web-verified` 收據，跟 Discord、Telegram 訊息一樣。go-ahead 動作（破壞性、不可逆、花錢、授權類）要有 Discord／Telegram 收據或 `web (verified)` 收據——瀏覽器開著本身什麼都證明不了。

- 能做什麼：驗證過後，跟聊天訊息一樣為同樣的行為背書。
- 不能做什麼：沒驗證就什麼都授權不了；普通的 `via web` 與訪客永遠不帶授權。
- 程式碼：`src/authority/web-authority.ts`；`src/config-validator.ts:517-522`（`web.verified_authority`）。
- 相關決議與議題：#1939。

## 不一致之處

程式碼與決議（或題目要的詞）對不上的地方，都列在這裡，不粉飾。

1. **Team leader。** 題目要的詞沒有對應物：team 存在，但程式碼與文件裡沒有 leader 角色、推選或專屬工具。建議的理解：協調落在委派或分派工作的 instance 身上。
2. **Paired PC。** 這個詞在程式碼與文件裡不存在。已驗證的碎片：`agend access pair` 發放的存取碼（`src/cli.ts:1241`）與 Windows runtime alpha（`release/2.3.5-alpha`，決議 72353fdf）。
3. **General 的 orchestration 工具。** 程式碼的 `general` profile（`src/tool-permissions.ts:107-136`）只有 `create/start/restart/wake_instance`，但使用者決議說身為管理者的 General 將透過一個進行中的改動取得全部 orchestration 工具。截稿時找不到這樣的 open PR——程式碼那一半已驗證，改動那一半沒有。
4. **決議 9e3bea6c。** 用 `list_decisions`（標題、已封存、標籤篩選）查不到，這個 clone 裡也不是 commit。上面的 General 詞條照題目引用它；領導給出正確出處前，這個連結保持未驗證（已用 `request_information` 問過，`cid-concepts-doc`）。
5. **Administrator 與 `allowed_users`。** 使用者定義 General 是管理者，但程式碼按平台使用者 id（`access.allowed_users`）授權管理員，沒有綁在 instance 身上的管理員身分。兩者如何對上，等 (4) 的決議原文再定。

[English](concepts.md)
