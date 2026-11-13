# 桌面雙對話：VS Code 精簡版（#3637，原有文字分頁版）

狀態：**使用者已同意 d6735f99 的文字分頁設計，依文末四階段建置，僅 alpha／2.4**。PR1 #3671、PR2 #3689 已落地，保持普通單格外觀。PR3 #3702 提供拖曳、分隔線與自訂移動；PR4 加入真實 pop-out，依指定先疊在 PR3 分支上，再隨 alpha 合併同步。原始碼調查與靜態圖稿基準：1066a85a2c48cae18e700b207adba1cdb450cf5a；r1 提案：ff2d1d59c28b6488827d9372428178c18c4fc850。

## 給使用者的摘要

不增加「桌面雙對話」工具列。**每格保留 Agent 標頭，以及 聊天／檢視／紀錄／設定**；分頁只切換自己那格。左邊看紀錄、右邊聊天可以同時進行。只有一格時，外觀與今天相同。

側欄 Agent 的 **⋯ → 在旁邊開啟**，或把 Agent 拖到聊天區邊緣，就能開第二格。預設左右各半；每格標頭的分割按鈕／⋯ 可選左右、上下、交換位置、**自訂移動**或**彈出成獨立視窗**。沒有永久排列列。

拖標頭時，藍色半透明區顯示落點：左、右、上、下可分割，中央可取代目標格；Esc 取消。拖分隔線調比例，雙擊回各半。「自訂移動」是頁內可拖、可調大小的浮窗；「彈出」是另一個真正的瀏覽器視窗，可移到另一螢幕。

最多兩個不同 Agent；一般點側欄只換**有焦點的那格**。引用到另一格只放入草稿，**絕不自動送出**。關格子或彈出視窗不停止 Agent。手機與窄畫面一次只顯示一格。

[最新原有文字分頁圖稿](https://github.com/songsid/AgEnD/blob/d6735f99/docs/screenshots/desktop-split-chat-m2889/r2/text-tabs/README.md)；[r2 其他操作圖稿](https://github.com/songsid/AgEnD/blob/d6735f99/docs/screenshots/desktop-split-chat-m2889/r2/README.md)。圖稿使用本機假資料與真正 app shell；全部是靜態提案，不是功能驗收。

## r1 → r2

- 移除共用工作區列；四個分頁回到各格。依最新 r2 回饋，分頁與名稱／狀態維持同一列；不加圖示，窄格先截名稱，再把放不下的尾端分頁移到該格 ⋯，不換行。
- 開第二格用側欄 ⋯、側欄拖放、標頭分割按鈕；排列只在各格選單。
- 採 VS Code 的邊緣／中央落點、Alt 分割方向、sash 雙擊重設，不照搬會搶瀏覽器快捷鍵的部分。
- 依最新補充，**同時保留頁內「自訂移動」及真正「彈出視窗」**。r1 原圖與 receipt 保留原範圍，沒有改標成 r2。

## 先沿用現有結構

| 現有機制 | r2 的接點 |
|---|---|
| [#1408 app shell](1408-app-shell.md)：Outlet、lease、導覽、串流 | 在既有 Agent 場景放兩個 pane host，不另建 shell。拆全頁／窗格生命週期，Chat／View／Log／Details 切換留在目標格；全頁 Needs you／Fleet／Settings 仍由原 Outlet 管。 |
| [#1481 HTML preview](https://github.com/songsid/AgEnD/issues/1481) | 沿用分隔線、幾何界限、裝置記憶與窄幅展開規則；不把聊天塞進編輯器用的 SidePanel。 |
| preview-panel 與工作區 | 保留單一附件 slot、最多一個 live HTML frame。雙格開預覽／Files & changes 時用既有展開模式，標來源 Agent／返回，不增第三欄。Follow 隨附件面板關閉。 |
| Needs you | 全頁入口、數量、確認與權限不變；離開雙格釋放 view／預覽，回來還原格子與既有草稿。不複製確認卡。 |
| [M-2520／#3226](https://github.com/songsid/AgEnD/issues/3226) Hub chat-app | 共用 thread／composer／header／rail 與 pane host；v1 先同一 Fleet。Hub 保留自己的 store、transport、授權，不跨來源嵌 app，不另造 dock。 |

目前不能直接 mount 兩個 ChatPanel：單一 setCurrent、全頁 title／搜尋、composer 固定 id、thread cache 保護對象、預覽清理會互相覆寫。先拆 visible-agent set ＋ focused pane、pane-local refs／lease／generation，再接兩格。InstanceSwitch 交由 pane router；格內「設定」指該 Agent 的 Details，**不是**全 Fleet 設定。

## 每格標頭：原有文字分頁，不加圖示

直接重用目前 build 的 InstanceSwitch 元件、文字、字體、間距、圓角及 selected 樣式；不另外設計 icon tabs。此圖稿的 alpha 基準1066a85a已含#3624，實際顯示 **聊天／檢視／紀錄／設定**。其他版本若仍寫「詳細資訊」，沿用該版本字串，不在分格功能硬改名。分頁依原權限／backend capability 顯示。

名稱、狀態、可見文字分頁及右端操作維持同一列。沒有「640px以下改圖示」規則：

1. 名稱先縮短，以省略號截斷、title保留全名；保留最小可辨識名稱／狀態空間。
2. 還放不下時，由右至左把尾端分頁移到**該格 ⋯**，使用原文字，不縮成圖示或裁掉半個字。目前分頁始終可見；需要時先移走其他未選分頁。
3. ⋯ 中的隱藏分頁仍只切換自己那格。分割、⋯、✕ 留在最右端。360px圖稿顯示長名稱截斷、聊天文字及其餘分頁在選單中。

### 卡片、字級、用量與原有 ⋯：同頁只一組

不新增全頁工具列。在**焦點窗格標頭的右端**安置唯一一組原有工具，另一格不複製；切換焦點才由同一個 page host 改綁目前 Agent／分頁。右端依序為原有卡片、T字級、用量，以及分割／合併的⋯／✕。窄格沿用工具本來的緊湊圖示模式；**文字分頁仍不轉圖示**。

| 控制 | 所有權與作用 |
|---|---|
| 卡片按鈕 | 只有一個，沿用 CardMenu；顯示焦點 Agent 的名片。顯示卡片／圖片介紹仍用原本 viewer preferences，不新增各格設定。Agent 沒有卡片時按原能力不顯示。 |
| T 小／中／大 | 只有一個，沿用 HeaderTools／裝置字級設定，同頁兩格都套用。焦點在檢視時保留原有 Fit 選項與既有語意。 |
| 用量 | 只有一個，沿用原 usage rail／dialog，不各開一份輪詢。仍按目前 Agent 能力及頁面 feature gate 顯示。開 rail 後重新檢查760px可用寬，不夠則走既有單格 fallback。 |
| 原頁面⋯ | 與焦點格的⋯合併為一個入口：先列該格隱藏分頁／排列，再分區保留原頁面／Agent操作；不在同一格放兩個⋯。非焦點格⋯只有該格分頁／排列。 |

切換焦點時關閉舊 menu／卡片 popup，未完成的舊 Agent 動作不改綁到另一個 Agent；送出仍驗當初擷取的 Agent／lease。pop-out 是另一個 document，自有一組工具；不是在同頁重複。單格保留今天的標頭，不額外加 workspace bar。

[原有 top bar 基準、左右、紀錄、浮窗、360px overflow 與彈出原圖](https://github.com/songsid/AgEnD/blob/d6735f99/docs/screenshots/desktop-split-chat-m2889/r2/text-tabs/README.md)。先前 icon tabs 圖只作歷史，本次提案已取代它們。

## VS Code 手勢對照與開啟規則

| 操作 | AgEnD r2 |
|---|---|
| 側欄 ⋯ → 在旁邊開啟 | 一格時在右側開 B；已有兩格，選單寫「取代：非焦點 Agent 名稱」。同 Agent 已開就聚焦，不複製。 |
| 標頭 Split Editor Right | 點分割圖示開 Agent 選擇器，選後向右分割；**Alt＋點向下**。不同於編輯器：不能複製同 Agent，所以需選第二個。兩格時明示取代對象。 |
| 拖側欄 Agent／窗格標頭 | 超過最小拖曳距離才開始；左／右／上／下藍色半區先預覽、放開套用，中央覆蓋目標格。Esc／無效區取消。訊息選字、附件拖放不啟動排列。 |
| 已有兩格再拖 | 仍最多兩格：外部 Agent 取代落點所屬格，邊緣決定兩格方向／順序，不建第三格。拖既有 B 到 A 中央是**交換**，對自己中央不動；原草稿保留。 |
| sash 拖曳／雙擊 | 調比例／回 50:50。左右每格至少 360px；上下至少 320px，需可用高度 ≥648px。拖曳與鍵盤共用界限。 |
| 每格排列選單 | 左右、上下、交換位置、自訂移動、彈出成獨立視窗、收起此格。單格不出現無效的交換／收起；不增加永久列。 |
| 自訂移動 | 第二格為頁內浮窗，完整四分頁與 composer 保留。標頭自由拖、角落縮放，拖回藍色邊緣可停靠。初始 560×460px、右下且在主 composer 上方；最小 420×360px，限聊天區內，不蓋側欄／dialog／Needs you。尺寸不足回單格。 |
| 拖出視窗 | 瀏覽器無可靠的窗外 pointer/drop 保證，且可能封鎖非點擊 popup；**v1 不以拖出自動開窗**。拖到無效區維持原位，以標頭選單明確點擊開窗；不加一個不能可靠完成的拖出落點。 |

普通側欄點擊換焦點格；標頭、分頁、composer 點擊都可取得焦點。焦點用細框與「目前」標記，不只靠顏色。收起一格後另一格展開，保留原草稿、附件、捲動、狀態。同一 Agent 不開兩格，避免既有 agent-owned thread DOM／草稿／佇列互搶。

## 彈出：真視窗，不是頁內浮窗

在人的點擊處同步 window.open 同來源既有 /ui/chat/B?presentation=popout，應用隱藏自己的側欄，保留 Agent 標頭、四分頁與功能。瀏覽器決定視窗或分頁、是否顯示網址列；不能保證沒有 OS／瀏覽器外框，也不能強制移到另一螢幕。

- 同來源既有 cookie 登入，**URL 不放 token、session、草稿**，子視窗照常重新授權。公開／訪客／唯讀不因 pop-out 改變。
- 保留 WindowProxy，以 exact origin ＋ exact child window 做短暫 ready／草稿交接；子視窗接收未送文字／附件後確認。不傳 cookie、權限或後端操作，完成後解除 opener，忽略過期／重複回覆。不以任意 postMessage 當登入證明。
- **子視窗載入且確認接收前，原格保留**；成功才收起、另一格展開。被擋、登入失效、逾時或無法交接時，提示「未能開啟，請允許彈出視窗或留在這裡」，原格／草稿不動。不能用帶 noopener 的 null 回傳判斷封鎖，因為也可能已開但無 handle。
- 交接視窗上限 15 秒，綁定同一來源、WindowProxy、viewer 範圍、Agent 與一次性 nonce；原頁切換／登出、草稿更新（含輸入後改回原字）、子頁切走或輸入法組字均不得清除原稿。文字最多交接 100 萬字元，附件沿用既有數量／大小限制；超限保留原格，不截斷。子頁已輸入內容不覆寫。不移動送出佇列，不上傳附件；原格有設定離頁保護時仍由原保護決定是否收起，無法確認時兩邊保留草稿副本。
- 關子視窗只關畫面，不停 Agent，原頁不自動再開。可從側欄重開；reload 子視窗恢復單 Agent pop-out，不再彈出另一窗。各視窗各有 history。
- 兩格上限是**同頁**，不新增跨分頁的全域視窗管理器。跨視窗用正常複製貼上，「引用到另一格」v1 先只做同頁兩格。

## 資料、引用、鍵盤與可及性

每格分頁沿用原有 session 權限及 supportsInstanceFeature；分格不增加訪客、唯讀或不支援 backend 的能力。每格有自己的 view、composer、scroll、IME、附件、狀態 chip、subscription、lease。草稿／佇列仍屬 Agent，切紀錄再回聊天不清草稿。A 的 Log refresh／filter 不影響 B Chat；焦點格供側欄、頁籤標題、搜尋判定，Enter 只作用於實際輸入框。

「引用到另一窗格：B」把文字與來源名稱放進 B 游標處，保留 undo／草稿，由人送出；不用 A 的 replyTo id 假裝 B 回覆。跨兩格／多訊息混選不當成單則引用。B 正看紀錄時，引用動作明示切 B 到聊天再放草稿。

| 快捷鍵／焦點 | 提案 |
|---|---|
| 分割 | Windows／Linux Ctrl+反斜線，Mac Cmd+反斜線，與 VS Code 相同，開第二 Agent 選擇器。向下用 Alt＋點或選單。 |
| 切換格 | 候選為 Windows／Linux Ctrl+Alt+反斜線，Mac Ctrl+Cmd+反斜線；另有標頭／命令選單「切換到另一窗格」及 Tab。這是網頁替代鍵，不冒稱 VS Code 原鍵；實作驗 Chrome／Edge／Safari／Firefox、非 US 鍵盤，衝突則只留選單。 |
| 必須保留 | **Ctrl／Cmd+1、2** 留給瀏覽器；Ctrl+Tab、F6、Ctrl／Cmd+W、瀏覽器前後頁與輸入法不攔截。只在 Agent 場景、非 IME composition 接排列鍵，既有文字輸入鍵優先。 |
| 分隔線／浮窗 | role=separator，可 Tab；方向鍵 16px、Shift＋方向鍵 64px、Home／End 到界限；選單回各半。浮窗「移動／調整大小」用方向鍵、Enter 套用、Esc 取消。 |

每格有 Agent／目前分頁名稱的 region、唯一 DOM／ARIA id。收起後焦點回剩餘格標頭；不偷正在輸入的 IME。Esc 先關選單／取消拖曳，再依原規則處理焦點格，不同時停止兩個回覆。完成排列才播報，避免 pointer tick 連續朗讀。窄格先截名稱，放不下的文字分頁移到該格⋯；目前分頁留在同列，所有分頁仍可用鍵盤到達。

## 記憶、網址、窄畫面與成本

- localStorage 包 try/catch，按 Fleet／非秘密 viewer id 分隔。只存版本、Agent、每格分頁、焦點、right／stack／float、比例、浮窗界限，不存訊息／草稿／附件／token。登出清列表，無 viewer id 只記憶體；reload 不自動開 popup。
- 例：/ui/chat/A?compare=B&layout=right&paneA=log&paneB=chat&focus=b。舊 JS 忽略 query 仍開 A；新版 reload／deep link 還原兩格、各自重新驗權。B 不可讀顯示不可用／收起，不偷換人。明確 /ui/chat/A 無 compare 就單格；/ui 才回裝置偏好。開／換／關走 history，焦點／比例 replace，不塞滿 Back。
- **viewport ≥1200px 且聊天可用寬 ≥760px** 才雙格，否則只 mount 焦點格，以短 Agent 頁籤切換，保留兩格／分頁／排列。原 shell 900px 斷點不改；上下高度不足亦單格。窄畫面無拖曳／頁內浮窗，窄 popup 仍完整單格；分頁保留文字，放不下的項目移到該格⋯，不增加第二行。
- 同頁兩格共用**一條 app stream**，poll-only／public-link 仍零 SSE。pop-out 是另一份 document，照既有頁面各一條；主頁＋pop-out 合計可兩條，不另建跨視窗 transport。
- 共用 store／history 去重，gap recovery 覆蓋兩個可見 Agent。thread cache 保護兩格但不提高 KEEP／NODES 上限，不因開格啟動 Agent。清 timers／scroll／observers／lease 只清該格；全頁離開／登出清兩格。
- live HTML 不可在執行時隱藏、快取或搬 DOM；交換／改布局需搬時先停原 frame，再用既有「重新預覽」。B 清理不能停 A 附件，同頁 live frame ≤1。

## SKEW 與建置切分

新 pane host、字串、CSS 都 ready 才顯示入口；舊 server／缺模組／舊 CSS 退原單格且保草稿。保留舊 exports／re-export，不靜態 import 舊快取不存在的名字。新 CSS 限新 workspace class。舊版不識 pop-out presentation 時，完整單格仍可用，不白頁。

依使用者已同意的設計按順序做：

1. **所有權整理，單格不變**：拆 page／pane，Chat／View／Log／Details 可局部切換，唯一 refs／id、visible-agent／gap、preview ownership；Hub 舊介面不變。
2. **左右／上下完整路徑**：側欄／標頭開格、四分頁、焦點、取代／交換／收起、引用、URL／記憶／窄幅、鍵盤／a11y；此 slice 完整才顯入口。
3. **拖曳與自訂移動**：共用幾何／sash，邊緣／中央落點、Esc、50:50、鍵盤移動／縮放。
4. **pop-out**：同步開窗、被擋／ready／草稿交接／失敗留原格、opener／origin、獨立登入生命週期，不擴權。

每段 fail-first 與真操作；SKEW 含新 JS＋舊 app.css、舊 JS＋新 CSS、舊 server、新舊 pane/tab／popup 模組交錯、載入失敗時草稿。驗雙 composer IME／附件隔離、遲到結果不串格、Esc 不雙停、50 次 close/reopen 資源回基線、同頁 SSE 不變、live preview ≤1，同訊息量比記憶體。圖稿不代替這些驗收。PR2–PR4 各自附 PNG 並直接送單雙號審查，不逐段請使用者看圖；PR4 完成時，一次提交涵蓋所有排列與手勢的桌面繁中明／暗整組，供使用者審閱。

## 對照與來源

[VS Code editor groups／Alt 分割](https://code.visualstudio.com/docs/editing/getting-started/userinterface)、[layout／獨立視窗](https://code.visualstudio.com/docs/configure/custom-layout)、[快捷鍵](https://code.visualstudio.com/docs/reference/default-keybindings) 提供分組操作；[Chrome 快捷鍵](https://support.google.com/chrome/answer/157179?hl=en) 確認數字鍵留給瀏覽器。Slack [separate windows](https://slack.com/intl/en-gb/help/articles/4403608802963-Open-separate-windows-in-Slack) 適合明確旁開／開窗入口；[Edge split screen](https://www.microsoft.com/en-us/edge/features/split-screen) 是同分頁雙頁參考。AgEnD 採 VS Code 排列手勢，保留 Agent／權限／草稿邊界。

[MDN window.open](https://developer.mozilla.org/en-US/docs/Web/API/Window/open) 說明 popup、手勢與 handle 限制。現況接點：[app shell](../../src/ui/shared/app-shell.js)、[lease](../../src/ui/shared/app-ctx.js)、[ChatPanel](../../src/ui/panel-chat.js)、[InstanceSwitch](../../src/ui/shared/instance-switch.js)、[store](../../src/ui/chat-store.js)、[preview](../../src/ui/shared/preview-panel.js)、[workspace](../../src/ui/workspace-panel.js)、[quote](../../src/ui/chat-quote.js)。這些是調查依據；各段完成後另附實作驗證。
