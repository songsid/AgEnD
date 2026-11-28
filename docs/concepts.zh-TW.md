# AgEnD 概念與定義

草稿。每個詞條描述 main 上程式碼今天的行為，皆已對照所列檔案驗證。推論之處會標明。這些定義經專案擁有者批准；與定義不合的行為是 bug，或需要一個決議。程式碼與決議不一致之處，見文末「不一致之處」。Fleet decision 只存在於 leader 的專案範圍，讀者打不開，所以每次引用都把使用者看得懂的摘要寫在內文。

## fleet（艦隊）

一台主機上的整個多 agent 系統：instance、排程、team、決議與任務板，由同一個 daemon 依同一份 `fleet.yaml`、在同一個 AgEnD 家目錄（`~/.agend`）下驅動。

- 能做什麼：透過聊天連線、網頁儀表板，或兩者，同時驅動多個 agent。
- 不能做什麼：不能橫跨多台主機。只有一個 daemon、一個 fleet 行程、一個家目錄。
- 程式碼：`src/fleet-manager.ts`（`FleetManager`）、`src/config.ts`（`FleetConfig`）。
- 相關決議與議題：—

## configured、session 與實際回應的模型

對 Claude Code 來說這是三件不同的事：configured（存下來的選擇）；session（這次啟動時狀態列選的）；last served（主執行緒回應 metadata 裡實際回答的模型）。型別化的 safeguard 或可用性備援通知會同時記下原始與備援模型，以及適用的 turn／session 範圍。管線中途的 observation 證明不了最終留下的答案。

AgEnD 只偵測並顯示切換；絕不會因此去改模型或政策。在重複 block 與 resume 期間，一個 Needs-you 項目保持安靜；只有新的回應回到 configured／原始模型時才清除。刻意的 `/model`、下一次啟動的 failover、合成或 API 錯誤的紀錄、標記過的 child／auxiliary 紀錄，都不會變成 provider 切換警報。沒解開的別名、預設值、opusplan 不猜。主執行緒的 Haiku 也算在內。缺少或沒變動的廠商 metadata 可能讓替換悄悄發生而看不見。

- 程式碼：`src/claude-model-observation.ts`、`src/transcript-monitor.ts`、`src/needs-you.ts`。
- 讀法：`describe_instance(name)` 給精簡的 active-switch 摘要；`detail:true` 再加上有界的 configured／launch／session／last-served metadata。

## instance / agent

一個 agent 就是一個 instance：一個 daemon 駕駛一個 CLI、跑在各自的 tmux 窗格裡，有各自的對話紀錄、topic 或房間、工具組。`instance` 是設定與執行時期的用詞（`fleet.yaml` 的 `instances`）；`agent` 是日常用詞。

- 能做什麼：在工具組範圍內聊天、呼叫 MCP 工具；用 `send_to_instance`、`delegate_task`、`report_result` 與其他 instance 傳訊。
- 不能做什麼：不能超出自己的工具組；除了透過 fleet 工具，不能碰其他 instance 的狀態（同一 OS 使用者下的行程彼此並不隔離——見 `docs/design/coordinator-tool-perms.zh-TW.md`）。
- 程式碼：`src/daemon.ts`、`src/instance-lifecycle.ts`。
- 相關決議與議題：#804。

## General

使用者的定義（fleet decision 9e3bea6c，「General is the AgEnD administrator」，使用者 2026-11-04）：從 beta.8 起，`general` 工具組拿到完整的 ORCHESTRATION——instance 的新增、刪除、取代、啟動、停止、暫停、喚醒、重啟；template；team；`update_fleet_defaults`；`update_instance_config`；kiro 遷移與對帳工具；`update_decision`；網頁設定——不另加確認。原有的敏感設定（token、存取權與管理員名單）仍由 fleet admin 確認。依使用者 2026-11-09 的決議 36525f1b，General 另有 `get_instance_logs`、`get_fleet_config`、`validate_config`、`list_deployments`，並可經 `update_instance_config` 或 `create_instance` 直接設定其他 agent 的 `tool_set`，不需確認。其他建立者只能在 `create_instance` 與 `deploy_template` 設定 `tool_set`，上限是自己目前的 profile。既有 agent 的 `tool_set` 經 `update_instance_config` 仍只有 General 能改。順序只定義一次（`toolSetRank`）：`full`、`general`、`coordinator`、`worker`、`standard`、`minimal`，權限由高到低。不是 General 的建立者不能給 `full` 或 `general`；自己已經是這兩者的，上限是 `coordinator`。超過上限會被拒絕，並寫明上限。省略 `tool_set` 仍是 `worker`，除非 fleet 預設會把更高的 profile 複製到新 instance 上：上限看的是那個實際 profile。這兩個工具對所有人都拒絕 `skipPermissions`。它取代 2026-09-21 的「dispatcher」說法，隨 beta.8 落地（agy 的 PR）。General 是艦隊的管理 instance——新艦隊的第一個 agent——擁有 General topic。`general_topic: true` 或名字就叫 `general` 的 instance，跑的是 `general` 工具組。

- 能做什麼：使用 coordinator 除了儲存庫租約以外的工具（含唯讀除錯工具），並直接將其他 agent 的 `tool_set` 設為可寫入的工具組：`full`、`standard`、`worker`、`coordinator` 或 `minimal`。
- 不能做什麼：預設 General 工具組不含 `checkout_repo`、`release_repo`；不能指定由角色決定的 `general` 工具組，也不能經這兩個設定工具傳入 `skipPermissions`。General 不得透過工具修改自己的 `tool_set`（建立操作最後指向自己時也一樣）；人員仍可在設定頁或 fleet.yaml 修改。若管理員明確縮限 General 的工具組，縮限仍生效。這項直接設定的例外僅適用於 portable／本機 agent。原生 Windows 的建立，以及顯示名稱、說明或模型修改，仍需原有的管理員核准；其 `tool_set` 請由人員在主機上的設定頁修改。
- 程式碼：`src/tool-permissions.ts`、`src/general-instance.ts`、`src/outbound-handlers.ts`。
- 相關決議：9e3bea6c、36525f1b。

## `coordinator` 工具組

`TOOL_PROFILES.coordinator = WORKER + ORCHESTRATION`：全部 worker 能力，加上所有「經營艦隊而非做事」的動詞——給經營艦隊其中一部分的 agent 用的。

- 能做什麼：新增／刪除／取代／啟動／停止／暫停／喚醒／重啟 instance、管理 team 與 template、改 fleet 預設值與 instance 設定、跑 kiro 遷移與對帳、改別人的決議與網頁設定（`src/tool-permissions.ts:80-93`）。建立或展開時，可把別的 agent 的 `tool_set` 設成 `coordinator` 或更低（`worker`、`standard`、`minimal`），不用確認卡。新 agent 一起動就是那個 profile。
- 不能做什麼：不能超出這張表——沒列的就是拒絕，並說明這個 instance 拿的是哪個 profile。不能給 `full` 或 `general`，不能給高於自己目前 profile 的等級，不能經 `update_instance_config` 改既有 agent 的 `tool_set`，也不能改自己的 `tool_set`。
- 程式碼：`src/tool-permissions.ts:100-107`。
- 相關決議與議題：`docs/design/coordinator-tool-perms.zh-TW.md`（僅有正體中文版）。

## worker

做事的 instance 用的 `worker` profile——沒寫 `tool_set` 時的預設值（`resolveToolSet`，`src/tool-permissions.ts:201-208`）。

- 能做什麼：跟人說話、向同伴回報（`send_to_instance`、`report_result`、`request_information`、`broadcast`、`delegate_task`、`delivery_status`）、讀艦隊狀態、跑自己的任務卡與排程、維護自己的主題與辦公室角色。
- 不能做什麼：任何 orchestration 動詞。被拒絕時會指名 coordinator，並建議用回報代替（`src/tool-permissions.ts:357-374`）。
- 程式碼：`src/tool-permissions.ts:33-72`（`WORKER`）、`:185-208`。
- 相關決議與議題：#804、#895（只能排自己的排程）。

## team 與 team leader

team 是 instance 的具名分組（`fleet.yaml` 的 `teams`），用於定點廣播與顯示分群。Team leader 是指帶著 `coordinator`（或 `full`）工具組、在跑一個 team 的 instance——是慣例，不是程式碼裡獨立的角色（使用者 2026-11-04 批准）。

- 能做什麼：一次對多個 instance 說話；側欄與辦公室分群顯示。
- 不能做什麼：不授予任何權限——沒有推選、沒有 leader 專屬工具。
- 程式碼：`create_team`、`list_teams`、`update_team`、`delete_team`（`src/channel/mcp-tools.ts`）。
- 相關決議與議題：—

## topic / General topic

topic 是一個 instance 的聊天歸屬：綁定到它的 Telegram 論壇主題（其他連線則是對應範圍）。General topic 是 General instance 的 topic。屬於 General 的指令，在別處只會回答「請到 General topic 用它」。

- 能做什麼：在那裡說話，就能精確找到那個 instance。
- 不能做什麼：不能在別的 topic 跑 General 專屬指令。
- 程式碼：`src/topic-commands.ts:836-839`（在 instance 的 topic 下的 General 指令會指回 General，不會交給那個 agent）；`src/locale.ts:880`（「要在 General topic 使用」）；`src/tool-permissions.ts:207`。
- 相關決議與議題：—

## Classic（ClassicBot）房間

ClassicBot 跑單一 agent 的私聊或群組，由 `classicBot.yaml` 管理——與 fleet topic 分開，有自己的管理員（`defaults.admin_users`）與聊天白名單。

- 能做什麼：在房間裡 `/start` 一個 agent 並跟它聊天。
- 不能做什麼：不能用 fleet topic 的指令；看不到艦隊；未註冊的聊天除非允許 `/start`，否則保持靜默。
代房間裡的人委派工作時，會保留請求人、承接 Agent 與 correlation 的對應；收到匹配的結果後，在綁定頻道摘要回報並提及原請求人。不相關的同儕報告、閒聊與 FYI 維持靜默。

- 程式碼：`src/classic-channel-manager.ts`。
- 相關決議與議題：`docs/permissions.md`。

## web-only fleet（純網頁艦隊）

完全沒有 Discord 或 Telegram 連線的艦隊，從網頁儀表板使用（使用者決議，2026-11-01/02）。它的 agent 跑在 topic 模式，所以仍能從儀表板互傳訊息。

- 能做什麼：聊天艦隊能做的事都能做，只是入口是 `/ui` 而不是聊天。
- 不能做什麼：沒有聊天輸入；沒有 `/web revoke`（根本沒有 `/web`）——它的 Notice 會寫主機上的做法：把每個瀏覽器都登出。
- 程式碼：`src/web-only-fleet.ts:10-22`；`src/fleet-manager.ts:7807-7808`。
- 相關決議與議題：28c2d3a3。

## host owner / operator（主機擁有者／操作者）

AgEnD 電腦上的那個人。在純網頁艦隊裡，就是在這台電腦上跑 `agend web --code` 的那個 session（`HOST_OPERATOR`）：它確認自己的授權、回答自己的提問。從外面用驗證器 App 的 TOTP 碼登入的瀏覽器（見「connections from outside」）同樣是已驗證的擁有者，授權相同，每次請求都會重新檢查。

- 能做什麼：確認網頁授權、登入、批准指名要主機操作者的事。在純網頁艦隊裡，已驗證的擁有者——在這台電腦上，或從外面用驗證器登入——還可以核准新裝置（裝置代碼登入）、登出其他裝置。
- 不能做什麼：不能從別台電腦冒充操作者，但從外面用驗證器登入的擁有者除外；session 被撤銷或過期後也不行。設定、重新綁定或移除驗證器只能在這台電腦上進行。
- 程式碼：`src/authority/web-authority.ts`（`HOST_OPERATOR`）；`src/fleet-manager.ts:2056-2060`；`src/locale.ts:1505-1506`。
- 威脅模型（64a289a0）：和 fleet 同一個作業系統使用者執行的程式，視為擁有者本人。它讀得到 `web.token`、能自己產生這個 session，本來也能修改 `fleet.yaml`。AgEnD 防範的是遠端的人、其他作業系統使用者、公開連結、訪客與 CSRF，詳見 `docs/SECURITY.zh-TW.md#威脅模型`。
- 相關決議與議題：28c2d3a3、64a289a0、#3165、#3327。

## fleet admin（`admin_users`）

列在某連線 `access.allowed_users`（艦隊）或 `defaults.admin_users`／`allowed_users`（ClassicBot）裡的平台使用者 id。管理員是按人授予的，不是按 instance：fleet admin 是指人，General 是指替能在 General topic 跟它說話的人辦事的管理員 agent（使用者 2026-11-04 批准）。

- 能做什麼：管理員限定的指令、確認敏感變更、管理存取權。
- 不能做什麼：沒列名就什麼都不行——空名單等於誰都不給；開放存取或持久化聊天授權本身不授予這個角色（`docs/SECURITY.md:13`）。
- 程式碼：`src/config-validator.ts:368-376`、`:677`。
- 相關決議與議題：—

## guest（網頁訪客）

不是艦隊管理員、拿訪客碼登入儀表板的人（`web.guests`，#1920）。訪客只能看到被授權的 agent，且限於它在聊天裡本來就能用的。

- 能做什麼：跟被授權的 agent 聊天；用 `/web revoke` 只登出自己的 session。
- 不能做什麼：管理員路由、Notice、用量報告，以及艦隊對訪客關閉的一切。
- 程式碼：`src/config-validator.ts:738-740`。
- 相關決議與議題：#1920。

## tool set / tool profile（`full`、`coordinator`、`general`、`worker`、`standard`、`minimal`）

伺服器端的對照表，決定一個 instance 能呼叫哪些 MCP 工具（`TOOL_PROFILES`，`src/tool-permissions.ts:103-155`）。`defaults.tool_set` 對沒有自己寫值的每個 instance 生效，General 也一樣；明示的 `tool_set` 永遠優先，否則 General instance 拿 `general`，其他一律預設 `worker`（`resolveToolSet`，`:201-208`）。

- `full`：全部工具。只能明示指定；預設不會拿到（環境變數 fallback 除外，`:212-222`）。
- `coordinator`：worker 能力加全部 orchestration 動詞——經營艦隊用的 profile。
- `general`：General 的管理員 profile——beta.8 起是 worker 加全部 orchestration 動詞（fleet decision 9e3bea6c）；beta.8 之前只有 `create/start/restart/wake_instance`——以及使用者的網頁設定。
- `worker`：預設值。負責做事，有 `standard` 沒有的回報能力（`report_result`）。
- `standard`：讀取範圍廣，也有自己的排程與主題，但沒有 `report_result`、`delegate_task`、`request_information`——走不完「委派→做事→回報」。
- `minimal`：窄小的發送者——回覆、轉交、查送達、讀決議、下載附件、看 emoji／貼圖列表。
- 程式碼：`src/tool-permissions.ts:30-155`。
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

追蹤工作的單位。主任務 `M-n` 是成果；子任務 `S-n` 是主任務下面的步驟。狀態：open、claimed、review、done、blocked、cancelled。等某人確認的主任務會進 review；從 review 以 done 收尾。

- 能做什麼：把狀態、驗收標準、留言與結果，跨 turn、跨 instance 帶著走。
- 留言與 mention：別人在卡片上留言會喚醒負責人；留言裡寫 `@<instance 名稱>` 會喚醒被點名的 instance，即使那張卡不是它的——是一則 `[Task board]` 通知，寫出誰留言並引用內容；在卡片上回覆，而且只在留言有問題或需要它做事時才回。agent 互相回覆 4 回合後就不再互相喚醒，直到使用者在卡片上寫東西；`defaults.task_board.comment_wakes: false` 可恢復舊規則：留言不通知任何人。
- 討論串：卡片上每則留言都有 ⋯ 選單——回覆（回覆掛在它底下）、反應、編輯（只有作者）、解決討論串、複製、複製連結、刪除——留言框也會說這則留言要給誰（預設是負責人；`@<名稱>` 照樣可用）。回覆會通知被回覆那則的作者；編輯只會喚醒新文字比舊文字多 `@` 的 instance；反應、解決、刪除都不叫醒任何人。agent 用 `reply_to` 回覆，用 `edit_comment` 修改自己的留言。
- 關注卡片：派出這張卡的 instance、關注它的 instance（`task watch`）以及它所屬專案的專案負責人（沒有就用 `defaults.task_board.leader`），在卡片完成、進入待確認、被退回、卡住或換負責人時會收到一則 `[Task board]` 通知——做出改變的人自己不會收到，留言也不算。只有需要你時才介入。`defaults.task_board.progress_wakes: false` 可關閉；agent 在同一張卡上來回改 6 次之後就不再通知關注者，直到使用者動了這張卡。
- 不能做什麼：不能代替人的共識——blocked 的卡還是要等人（或 dispatcher）回答。
- 程式碼：`task` 工具（`src/channel/mcp-tools.ts:79-80`）。
- 相關決議與議題：—

## decision（決議）

記錄下來的共識（`post_decision`、`list_decisions`），範圍是某個專案目錄或整個艦隊。決議是艦隊記住「為什麼」的地方，用 `list_decisions` 讀。

- 能做什麼：把 agent 與人之後會參考的共識記下來。
- 不能做什麼：不能自己執行——從來不讀它的程式碼，不受它約束（見「不一致之處」）。
- 程式碼：`post_decision`、`list_decisions` 工具定義。
- 相關決議與議題：—

## 用量工具

`get_usage`（或 `agend-agent usage`）預設是精簡的帳號列：方案、用量百分比與相對重置時間、廠商回報的綁定區間、快取／過期提示，以及 Codex 的重置票券／點數。沒有綁定證據就不猜。用 `detail: true`（CLI `--detail`）拿包含容量與在地化 metadata 的完整 JSON；平常不要拿。共用容量的註腳只寫一次。`get_usage_report` 開頭保留一次 API-equivalent 基準，預設不附速度數字；`detail: true` 回到完整舊格式。金額一律是 API-equivalent，不是真的花掉的錢。兩種模式都保留呼叫者範圍與 estimated／not-priced 標記。網頁用量與 `/usage` 不變。

管理員的 `/status` 表列出 instance、backend、模型、上下文、effort 與執行狀態，沒有費用欄。用量報告保留它的金額。

## credential profile（憑證設定檔）

某個 backend 的具名憑證組（`CREDENTIAL_HOMES`），讓一個艦隊能用多個帳號做事。`/login <backend> <profile>` 登入某個設定檔；能從聊天裡登入的 backend 只有一部分。

- 能做什麼：按 instance 或 backend 分開帳號。
- 不能做什麼：不能跨 backend 共用——設定檔屬於它 backend 的家。
- 程式碼：`src/backend/credential-profile.ts:5-13`、`:266-295`。
- 相關決議與議題：—

## native Windows agent / paired PC / runtime

AgEnD 今天跑在 Linux 與 macOS 上（Windows 上是跑在 WSL 裡，桌面捷徑用 `agend shortcuts` 建）。以下皆為 alpha（`origin/release/2.3.5-alpha`，改寫外部 #2934 而來——決議 72353fdf）。

- 原生 Windows agent 用的是這台 PC 的 Windows 側 CLI：跑在 WSL 的 AgEnD 會找到原生 Windows CLI，在同一個艦隊名冊裡跑 Windows agent，跟 Linux agent 並列（`runtimes.windows_cli`，預設關）。
- 已配對 PC 是另一台用 HTTPS 連上來的 Windows 電腦：它跑小小的 `agend-runtime` runner（從設定頁用一行 PowerShell 指令安裝、指令會先檢查腳本的 SHA-256，或改用 ZIP；永遠不是艦隊本體），用一次性配對碼對外連線，在設定頁比對配對指紋並批准後才加入（#2936）。釘在它身上的 agent，工作目錄就在那台 PC 上。
- General 可以跑在 Windows 窗格：「Run General on」把 General 搬到一台已批准、上線的配對 PC，coordinator——以及聊天與管理員權限——留在主機（#3007）。
- 人的存取權由「設定 → 聊天與連線 → 聊天連線 → 該 bot → 允許使用者（主 bot）」管理，跟 Runtime 配對不同。舊的使用者存取碼已移除，既有持久化授權仍保留；它不會授予 fleet 管理員權限。
- 程式碼（alpha 分支）：`docs/remote-runtime.md`、`docs/windows-cli-preview.md`、`docs/windows-general.md`；`src/runtime-bundle.ts`。
- 相關決議與議題：72353fdf、#2936、#3007。

## public link（quick 與 named，公開連結）

給不在主機邊的人的臨時儀表板入口。quick 是自動建的 `trycloudflare.com` 通道網址，效期短；named 是操作者自己的網域，效期長。訪客可以搭已開啟的公開連結進來，但永遠不帶授權。

- 能做什麼：不用聊天帳號也能看儀表板（搜尋、用量報告、辦公室分享，有開才有）。
- 不能做什麼：需要直連儀表板的管理介面不行（訪客、網頁授權、儀表板自己的網頁設定）。
- 程式碼：`src/config-validator.ts:424-429`；`src/office-share-service.ts:6`（quick 通道 429）；`src/public-preview.ts:4-5`。
- 相關決議與議題：`docs/named-tunnel.md`。

## connections from outside（開放外部連線，僅 alpha）

`origin/release/2.3.5-alpha`：純網頁艦隊可以對網際網路打開自己——「Allow connections from outside」——外面瀏覽器用驗證器 App 的 TOTP 碼登入（#3008；fleet decision 0471da59）。只要這個開關開著、而且「Only this computer can authorize」關著，這樣登入的瀏覽器就是已驗證的擁有者，與主機操作者相同。

- 能做什麼（alpha）：不用操作者自己架通道，也能從外面打開儀表板；用驗證器 App 的碼登入，並以已驗證擁有者的身分核准新裝置、登出其他裝置（維護者裁定，#3165）。
- 不能做什麼：main 上今天不能用——僅 alpha；設定、重新綁定或移除驗證器（只能在這台電腦上進行）。
- 另（#3486）：還沒登入的瀏覽器可以用某位管理員自己的 App 登入成那位管理員（`/auth/totp`，只帶 6 位數驗證碼——由伺服器判斷是誰的；`TOTP_SIGNIN_OVER_PUBLIC_LINK`）；詳見 SECURITY.zh-TW.md。
- 程式碼（alpha 分支）：`src/auth-api.ts`（`/auth/totp`）；`src/authority/web-authority.ts`；`src/fleet-manager.ts`（`deviceApprovalOwner`）。
- 相關決議與議題：#3008、#3165、fleet decision 0471da59。

## web session 與 verified web go-ahead（已驗證的網頁授權）

web session 是登入的瀏覽器（直連儀表板、區網、tailnet，或 opt-in 的連結）。session 要帶上帳號的授權——訊息顯示為 `@web:v`——必須該帳號先在 Discord 或 Telegram 上確認過（#1939）；訪客 session 永遠沒資格。Agent 檢查 `web-verified` 收據，跟 Discord、Telegram 訊息一樣。go-ahead 動作（破壞性、不可逆、花錢、授權類）要有 Discord／Telegram 收據或 `web (verified)` 收據——瀏覽器開著本身什麼都證明不了。

裝置代碼登入（alpha 實驗功能）：在開啟網頁授權的純網頁艦隊上，新裝置會顯示 8 碼代碼，由已驗證的擁有者在已登入的裝置上核准。核准後得到的是一般工作階段——普通的 `@web`，永遠不會帶有核准者的擁有者授權。在純網頁艦隊上，只有已驗證的擁有者可以結束別的工作階段。

- 能做什麼：驗證過後，跟聊天訊息一樣為同樣的行為背書；登出自己。已驗證的擁有者還可以核准新裝置、結束別的工作階段。
- 不能做什麼：沒驗證就什麼都授權不了；普通的 `@web` 與訪客永遠不帶授權。裝置核准建立的工作階段（或任何其他非擁有者的工作階段）不能核准裝置，也不能結束別人的工作階段，只能登出自己。有連接聊天平台的艦隊，或網頁授權關閉時，不提供裝置代碼登入。
- 程式碼：`src/authority/web-authority.ts`；`src/config-validator.ts:517-522`（`web.verified_authority`）；`src/fleet-manager.ts`（`deviceApprovalOwner`、`mayEndOtherSessions`）。
- 相關決議與議題：#1939、#3165。

## go-ahead（什麼需要授權）與「擁有者與日常操作」

只有五種動作需要 go-ahead：發布或公開；超出 agent 自己工作範圍的破壞性或不可逆動作；超出正常範圍花錢或花額度；憑證或密鑰；把權限授給或轉給另一個 instance。除此之外——讀取、查詢、分析、狀態與紀錄，以及 agent 被分派領域內的日常操作——都不需要 receipt、按鈕或驗證。每個 agent 的指示都這麼說（「什麼需要授權」，M-3522）。

agent 也可以有一份「擁有者與日常操作」（設定 → 該 agent → Agent 指示；fleet.yaml 的 `operations`，最多 2000 字）：它工作的系統屬於誰、哪些操作在那裡算日常。它緊接在 agent 的 Role 之後，有固定開場白。

- 能做：告訴 agent，比方說，擁有者或管理員要求時重啟服務或讀取紀錄，就是它的正常工作。
- 不能做：批准上面五種中的任何一種——寫在那裡也不行；不能拿它來授權或跳過任何檢查。範本匯出預設不含它（它會點名人物與系統，得由人勾選才含）。
- 另見：詳細資訊 → 「每個 session 都會載入」列出 agent 的 CLI 每個 session 讀哪些檔與大小；單檔超過 50 KB 會警告（Codex：超過其 32 KiB project-doc 上限的部分，Codex 永遠看不到）。

## 不一致之處

只列程式碼跟決議真的對不上的地方。這裡不粉飾。

先前把 General 直接設定 `tool_set` 記成「只有慣例、程式沒有強制」的那一條已經關閉。`toolSetRank` 定義順序，`create_instance` 與 `deploy_template` 執行上限。經 `update_instance_config` 改既有 agent 的 `tool_set` 仍只有 General 能做。General 仍可設定任何可寫入的 profile，但不能指定由角色決定的 `general`。

[English](concepts.md)

## 精簡的工具回覆

通訊工具用精簡的 delivery ID 確認收到；`detail: true`（CLI `--detail`）恢復完整確認。`delivery_status` 預設只給狀態、權限／證明／來源、內容雜湊與遮蔽過的節錄，不是完整原文。要把原始同意拿去用、或要餵給合併門檻，先明確要求 detail 再檢查，不要外洩密鑰。`content_includes` 可以確認某個確切的資源字串，但出現不代表授權。儲存區可見性、擁有的證明、目前的權限撤銷檢查，兩種模式都照做。

## 精簡的 agent 清單

排程、決議與任務清單預設回傳 20 列精簡結果；用同樣的篩選條件跟著 `next_cursor` 翻到沒有為止；`limit` 接受 1–100。被刪除或已對不上的 cursor 要從頭列起。清單是當下視圖，不是快照；翻頁之間有寫入會改變成員或順序。不帶分頁參數的 `detail:true` 回傳舊式完整內容。決議保留 `full:true`、純任務清單保留 `verbose:true` 作為完整內容的別名。照完整規則、目標、驗收或留言行動之前，先用 `{id, detail:true}` 讀決議、用 `{action:"get",id,detail:true}` 讀任務。儀表板與任務的寫入格式不變。

## 收到的訊息標頭

一則人類訊息帶一個 `[hid:hmsg-…]` receipt ID，以及自足的寄件人，例如 `[user:name@dc#ID]`。`dc` 是 Discord、`tg` 是 Telegram、`web:v` 是已驗證 web、`web:g` 是訪客；光禿禿的 `web` 未經驗證。舊式人類標頭與 verification_id 照樣可用。帳號 ID 可用於提及；沒變過的 hmsg 值可用於 receipt 驗證與明確轉交。引用的標頭本身不代表授權。共用的 formatter 在第一則／觀察到重置後的人類訊息，以及每十則證實的人類訊息時提醒一次；看不見的自動 compaction 用那個備援。漏回覆的恢復方式不變。
