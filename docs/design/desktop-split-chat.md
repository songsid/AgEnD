# 桌面雙對話與拖曳排列（#3637）

狀態：設計提案，等待使用者同意；**尚未實作**。目標：alpha／2.4。調查基準：`1066a85a2c48cae18e700b207adba1cdb450cf5a`。

## 給使用者的摘要

建議先限制 **兩個不同的對話**，預設左右並排；也能改成上下，或把第二個對話放成右下角浮窗。每個窗格都有自己的訊息、捲動位置、狀態與輸入框。關閉窗格只是收起畫面，不會停止 Agent。

從側欄 Agent 的「⋯ → 在另一窗格開啟」，或目前對話標頭的「另開對話」選第二個 Agent。一般點側欄會切換**目前有焦點的窗格**；有框線和「目前窗格」標示，不靠顏色猜。已經開著的 Agent 會直接取得焦點，不重複開啟同一對話。

拖曳窗格標頭時顯示左、右、上、下與浮窗停靠位置；放開後才套用。分隔線與浮窗右下角都能拖曳調整大小，也能用鍵盤。複製維持原樣；「引用到另一窗格：Agent 名稱」會把選取文字放進另一個輸入框，**不會自動送出**。

這個裝置會記住排列；重新整理可回復兩個對話。手機和窄視窗仍然一次顯示一個對話。HTML 預覽與工作區沿用現有面板；雙對話時改以現有的展開模式開啟，關閉後回到原排列，不再塞第三欄。

[圖稿索引與範圍](../screenshots/desktop-split-chat-m2889/README.md)。所有圖都是本機假資料的設計示意，沒有新增可用功能。

## 先沿用現有結構

| 現有機制 | 本提案如何使用 |
|---|---|
| [#1408 app shell](1408-app-shell.md)：一個 Outlet、導覽、lease 與頁面串流 | 在 Chat 場景內增加兩個有獨立生命週期的窗格，不增加另一套 shell。換頁／登出仍取消全部；更換 B 只取消 B。 |
| [#1481 HTML preview](https://github.com/songsid/AgEnD/issues/1481)：拖曳分隔線、鍵盤調整、裝置記憶與窄螢幕展開 | 共用其幾何限制、分隔線與儲存處理；擴充既有 Chat 場景的排列。不是把完整對話塞進現有的編輯器 `SidePanel`。 |
| `preview-panel.js` 的單一附件位置 | HTML、Markdown、Files & changes 本來就共用這一格。保留一個來源與最多一個 live HTML frame；雙對話時使用既有展開模式，不巢狀分割。 |
| 工作區面板 | 仍綁定發起的 Agent；Follow 的訂閱與輪詢隨該面板關閉。不受另一個對話取得焦點影響。 |
| Needs you | 仍是全頁共用的入口、數量與確認流程。前往時收起雙對話的 view／預覽，回來恢復排列與既有草稿；不複製確認卡或權限。 |
| [M-2520／#3226](https://github.com/songsid/AgEnD/issues/3226)：Hub 共用聊天模組 | 重用 `chat-thread`、`chat-composer`、WorkBar、header／rail 的呈現邊界。v1 先做同一個 Fleet 的對話；未來 Hub 接同一窗格 host，但保留自己的 store、transport 與授權，不跨來源嵌入另一個 app。 |

實作前必須先拆開目前的單一 `setCurrent`、標題與焦點管理、composer 的固定 DOM id／全頁查找，以及 thread cache 的單一保護對象。單純同時 mount 兩次 `ChatPanel` 會互相覆寫，也可能把同一份 thread DOM 搬走。

## 操作與排列

| 問題 | 建議行為 |
|---|---|
| 開啟 B | 側欄 ⋯，或對話標頭「另開對話」中的既有 Agent 選擇器。第一回預設左右各半；之後沿用裝置上次選的模式。 |
| 一般點側欄 | 切換有焦點的窗格；在此之前就清楚標示要被更換的 Agent。若該對話已在另一格，改成移動焦點。 |
| 已有兩格再用「在另一窗格開啟」 | 更換非焦點的那格，選單顯示「取代：Agent 名稱」。原草稿與附件沿用現有 agent-owned store，不悄悄清掉。 |
| 關閉／交換 | 每格標頭都有關閉；剩下一格展開。「排列」選單提供交換位置、平均分配與收起第二格。關閉不停止 Agent，也不清空草稿。交換保留草稿與捲動位置；需要搬動的內嵌預覽先停止，沿用「重新預覽」。 |
| 拖曳 | 僅用窗格標頭的拖曳區，不搶走訊息選字、附件拖放或側欄原有手勢。出現停靠目標與落點預覽；Esc／放開在目標外會取消。 |
| 左右／上下 | 8px 分隔區，滑鼠可拖；每格最小 360px 寬、320px 高。上下排列需要可用高度至少 648px，否則先單格顯示並保留偏好。 |
| 浮窗 | 初始 440×400px、右下角，預設放在主輸入框上方，讓兩個輸入框都可見。可移動，右下角調整大小，最小 380×320px；始終限制在聊天工作區內，不蓋側欄、全頁 dialog 或 Needs you。視窗縮小時重新限制位置。 |
| 為何先兩格 | 現有 thread／草稿以 Agent 為索引；兩格足以比較與交互工作，也能限制畫面、記憶體及焦點複雜度。v1 不做任意數量的視窗管理器。 |

雙格時縮短每格標頭，只留 Agent、狀態、拖曳區、關閉與更多選單；模型選擇仍在各自輸入框上方，既有「檢視／紀錄／設定」放進該格更多選單。排列與「另開對話」位於共用工作區列。單格維持原有標頭，不能因為桌面 viewport 很寬，就把窄窗格當成完整桌面頁塞入全部按鈕。

## 每個窗格的資料、引用與焦點

- 每格有獨立的 lease／generation、thread subscription、composer refs、附件、IME、scroll memo、命令選單與狀態。草稿及送出佇列仍以原對話為主，不以「左／右」作權限識別。
- v1 同一 Agent 的同一對話只能出現一次；再次選它會聚焦現有窗格。沒有新建 Agent 或 CLI session 的暗示。
- 原來的「引用／回覆」仍送回來源對話。新增明確的「引用到另一窗格：B」才會把文字、來源 Agent 名稱送進 B 的游標位置，保留 B 既有草稿、undo，並移動焦點；必須由人按送出。這是文字引用，不把 A 的 `replyTo` id 偽裝成 B 的回覆參照。跨兩個窗格／訊息的混合選取仍不當作一則引用。
- 焦點格負責側欄選取、頁籤標題、既有搜尋與整頁外觀；每格的 Agent 身分呈現留在該格。Enter 只由實際輸入框處理；不把 A 的按鍵轉送給 B。Esc 先關選單／取消拖曳，再由原有規則作用於焦點格，不能一次停止兩個回覆。
- 每格是有 Agent 名稱的 region；DOM／ARIA id 唯一。Tab 可到另一格的標頭／輸入框，既有命令選單加入「切換到另一窗格」。不占用瀏覽器 F6／Ctrl+Tab。分隔線用 `role=separator`；方向鍵調 16px、Shift+方向鍵 64px，Home／End 到界限。浮窗選單的「移動／調整大小」同樣可用方向鍵、Enter 套用、Esc 取消；不要求一定會拖曳。變更完成才播報位置，不在每個 pointer tick 播報。
- 拖曳幾何盡量只改 CSSOM、保留 root 與 thread 身分，不重掛 composer。若交換位置需要改 DOM 順序，先按來源停止將移動的 live frame，再重新掛載；不能隱藏、快取或搬動仍在執行的預覽。關閉 B 不得呼叫會停止 A 預覽的全域清理。

## 記憶、網址與窄畫面

- `localStorage` 包在 try/catch；只存版本、兩個對話識別、焦點、排列、比例及浮窗幾何，不存訊息、草稿、附件或 token。按 Fleet 和目前登入者區分，登出清除該人的窗格列表；沒有可用的非秘密 viewer 識別時，只保存在本分頁記憶。不增加伺服器設定。
- 範例：`/ui/chat/A?compare=B&layout=right&focus=b`。模式為 `right`、`stack`、`float`；幾何留在裝置端。重新整理及分享此網址回復兩格；權限仍重新檢查。B 不存在或不可讀時顯示不可用與關閉，不能偷偷換成別的 Agent。
- `/ui` 可回復此裝置最後的工作區；明確的 `/ui/chat/A` 沒有 compare 就只開 A，不硬塞舊 B。開／換／關對話走既有 history；Back／Forward 回復當時的對話組合。單純聚焦、拖曳或調大小用 replace／裝置記憶，不塞滿上一頁紀錄。比例與數字必須有界限，壞資料退回單格。
- 分割須同時滿足 **viewport ≥1200px、可用聊天寬度 ≥760px**。任一不足即單格；既有 shell 的 900px 手機斷點不改。保留兩個選擇，用短頁籤切換，每次只 mount 一個聊天。回到夠寬時恢復原排列；手機不提供拖曳分割或浮窗。雙對話時暫收起既有 usage rail；不覆寫單格時的偏好。

## 成本、舊分頁與建置切分

不是每格新增 EventSource：仍是 app 的一條 stream；poll-only／public-link 模式仍為零條 SSE。兩格只增加兩個依 Agent 分流的 view subscription／必要 history read。gap recovery 必須涵蓋兩個可見 Agent；共用 history 與卡片請求去重。保留現有 thread cache／message node 上限，保護兩個可見 thread；不用複製整份 Fleet store。關閉／換頁要收回該格的 timers、subagent observers、scroll listeners 與 lease；不喚醒、不暫停或停止後端 Agent。

舊 JS 不認 compare 時仍開 A。新版先確認新窗格 host、自己的字串及 CSS 都載入，才顯示開第二格的控制；舊 server／缺模組／舊 CSS 時保留原單格，不先拆掉 A。新 CSS 限定在新 workspace class，不改舊 shell。保留現有 shared exports／舊路徑 re-export；不讓新 caller 靜態 import 舊快取裡不存在的名稱。SKEW 須含新 JS＋舊 app.css、舊 JS＋新 CSS、舊 server／新 shell，以及持有草稿時的載入失敗。

使用者同意後才建置，PR 建議：

1. **先整理所有權，單格行為不變**：把頁面職責與 ChatView 拆開，pane-local refs／id／lease、visible-agent set、gap recovery 與 preview 清理；維持 Hub 共用模組的舊介面。
2. **左右／上下與完整導航**：開啟、聚焦、關閉、交換、引用、網址／裝置記憶、窄畫面與單一附件 host。新模式完成才顯示入口。
3. **浮窗與停靠**：共用 resize 幾何、pointer／鍵盤、完整 SKEW／可及性／樣式檢查。確認雙 composer 的草稿／IME／附件互不干擾；B 的延遲結果不落到 A；Esc 不同時停止兩個；close/reopen 50 次後資源回到基線、SSE 數不變、live preview ≤1。對相同訊息量量測記憶體；本設計稿不宣稱已跑過雙窗格效能或安全驗收。

Hub 接入另排，使用同一 host 邊界，不另做一套 dock 系統，也不擴大跨來源或使用者權限。

## 調查來源

基準原始碼：[app shell](../../src/ui/shared/app-shell.js)、[leases](../../src/ui/shared/app-ctx.js)、[ChatPanel／thread retention](../../src/ui/panel-chat.js)、[chat store](../../src/ui/chat-store.js)、[composer](../../src/ui/shared/chat-composer.js)、[preview slot](../../src/ui/shared/preview-panel.js)、[workspace](../../src/ui/workspace-panel.js)、[quote validation](../../src/ui/chat-quote.js)。這些是現況；上面列的是待批准的變更，不能把圖稿當成功能驗收。
