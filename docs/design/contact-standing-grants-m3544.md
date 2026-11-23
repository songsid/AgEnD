# 聯絡申請：逐人累積常用轉交（M-3544 提案）

狀態：設計待使用者核准；本文件沒有實作或改動現有授權。日期：2026-11-23。

建議把既有、藏在核取方塊裡的常用轉交，改成卡片上看得懂的第二個選擇：**核准這一次／允許這個人聯絡這個 Agent…／拒絕**。每次增加一筆明確的人員規則，讓日後符合的請求直接轉交。

**這是「可不必再問管理員就轉交」的權限，不是目標 Agent 的操作權限。** 例如，允許轉交一筆標為「唯讀查詢」的訊息，並不能在程式上限定目標只做唯讀操作；目標仍依自己的指示及現有工具權限決定如何處理。此提案不新增資料、指令或正式環境的動作授權，也不以 LLM 判讀訊息來決定放行。

## 1. 現況與缺口

檢查 dev `a1a059f819e47f73a07aae48a198e2eb0b203bf8`：

- 已有常用轉交資料、到期、可選次數及撤銷。卡片目前以「之後同樣的請求也直接轉交」核取方塊提供，預設 7 天；**僅在來源為單一、已知的人時出現**。不只是一個新的資料表功能。[卡片與條件](https://github.com/songsid/AgEnD/blob/a1a059f819e47f73a07aae48a198e2eb0b203bf8/src/ui/contact-authorizations.js#L35)
- 已有比對會逐一檢查所有保留來源的人；每人都要有符合的規則。不明來源無法符合。建立規則的卡片路徑卻只接受一人，因此多人來源會看不到那個核取方塊。[比對](https://github.com/songsid/AgEnD/blob/a1a059f819e47f73a07aae48a198e2eb0b203bf8/src/contact-auth-store.ts#L185)、[建立](https://github.com/songsid/AgEnD/blob/a1a059f819e47f73a07aae48a198e2eb0b203bf8/src/contact-auth-store.ts#L316)
- 目標 Agent 的「設定 → 權限」已有列表與移除按鈕。[現有列表](https://github.com/songsid/AgEnD/blob/a1a059f819e47f73a07aae48a198e2eb0b203bf8/src/ui/contact-permissions.js#L208)

以上是程式行為；沒有讀取個別實際申請的私有內容，也不推定某張實際卡片沒顯示選項的原因。

## 2. 卡片選擇與確認

| 選擇 | 行為 |
|---|---|
| **核准這一次** / **Approve once** | 只轉交這一筆；不新增規則。 |
| **允許這個人聯絡此 Agent…** / **Allow this person to contact this agent…** | 開啟小型確認表單，確認後「核准這一次並儲存規則」。不是點下就永久允許。 |
| **拒絕** / **Decline** | 不轉交；沿用既有拒絕通知。 |

表單直接列出：「{人員} 從 {房間}，透過 {來源 Agent}，向 {目標 Agent} 發送{訊息／工作／詢問}」。期限提供 **1 天、7 天（預設）、30 天、自訂到期時間**，顯示實際到期日期及時區。期限內預設不限次；「進階 → 最多轉交幾次」保留現有次數選項，預設收合。沒有預設永久允許，也不預先勾選擴大權限。

確認文案：

- zh-TW：「在到期前，符合這筆人員、房間、Agent 與請求類型的訊息會直接轉交，不再逐筆核准。這不限制目標 Agent 會採取的操作。可隨時到目標 Agent 的『權限』撤銷。」
- EN: “Until expiry, requests matching this person, room, agent and request type will be forwarded without asking again. This does not limit the actions the receiving agent may take. Revoke this rule at any time in the receiving agent’s Permissions.”

成功後顯示：「已轉交，並允許 {人員} 透過 {房間} 聯絡 {Agent}，直到 {到期時間}。」附「查看規則」。儲存規則與本次核准／准入同一交易完成；失敗不得只顯示成功，也不得悄悄退成單次核准。

## 3. 每筆規則精確綁定什麼

沿用現有 `ContactGrant`，不新增模糊的「信任程度」：

- **人**：平台 + adapter + 使用者 ID，取自系統收件證明；顯示名稱只是標籤，不可由訊息文字冒充。第一版不新增群組授權。
- **來源房間／Agent**：固定這次申請的 ClassicBot 房間及來源 Agent 身分。不是這個人從所有房間都可使用。沿用來源 incarnation；來源換成另一個 Agent 不繼承。
- **目標 Agent**：固定該 Agent 及 incarnation；刪除重建同名 Agent 不繼承。一般程序重啟不使規則失效。
- **請求類型（verb）**：卡片預設只加入這次的精確類型。發訊息、委派工作、要求資訊互不暗中等同；廣播及結果回報不跟著開放。未來擴大類型，也必須在權限表明選，不能根據聊天語意自行增加。
- **到期／次數／建立人**：沿用伺服器時間、剩餘次數與管理員異動紀錄。每次准入時重查規則及建立人仍有管理權限；不能只信卡片開啟時的狀態。

[既有資料欄位](https://github.com/songsid/AgEnD/blob/a1a059f819e47f73a07aae48a198e2eb0b203bf8/src/contact-auth-types.ts#L42)、[准入時再驗證及扣次](https://github.com/songsid/AgEnD/blob/a1a059f819e47f73a07aae48a198e2eb0b203bf8/src/contact-auth-store.ts#L330)。若未來不再是一個來源 Agent 對應一個房間，需獨立的房間身分；不可退成依房間名稱比對。

### 多人與不明來源：不能假裝只是眼前這個人

保留來源可能包含這個對話先前接過的其他人。此提案**不清掉來源、不用最新一句取代來源，也不靠 correlation 猜測工作已結束**。

- **一位已知來源**：直接使用上面的第二個選擇。
- **多位已知來源**：按鈕改成「設定這些人的常用轉交…」。表單列出保留來源的全部人，每人一列、預設不勾選；明選後逐人建立規則。本筆仍是明確核准一次。若只替其中一人新增規則，提示：「目前對話還包含其他來源；所有來源都有符合規則時，之後才會直接轉交。」可以選擇一次替列出的全部人建立規則，但不能用一個「整個房間都信任」取代。
- **不明來源（含超出既有 16 人上限）**：第二個選擇不可用，顯示「無法確認完整來源，只能核准這一次；不會建立常用轉交」。可連到現有來源說明／管理員明確清除來源流程，但不能隨核准自動清除。

多人批次建立只接受該申請內系統已驗證的人員子集合；不得讓 Agent 或表單自行填另一個人的 ID。之後逐人比對的現有規則不變。

## 4. 列表、到期、撤銷與 M-3384

目標 Agent 的「設定 → 權限 → 常用轉交」是主表，列出人員、來源房間／Agent、請求類型、到期、剩餘次數（若有）、誰建立／何時建立。可依人員篩選；卡片成功連結直達該列。提供「延長／調整類型／撤銷」，每次擴大都明列變更後範圍並沿用既有管理員確認與稽核；Agent 只能提出申請，不能改表。

到期或次數用完後，新准入重新需要核准。撤銷從提交後的新准入起生效；不能收回已准入／已送出的訊息、取消已開始的工作，或還原目標已做的操作。既有有效規則原樣保留，不自動延長或擴大；舊版單次核准也不補建規則。

**M-3384 不變**：單次核准及管理員建立的常用轉交都算管理員背書，**不把請求者來源合併到目標 Agent**。來源房間仍保留自己的來源；申請與稽核保留原始來源及規則 ID。目標之後的聯絡依目標自己的既有來源判斷，因此獲准內容可能繼續流轉、不再因這位請求者而逐站問一次。[既有背書行為](https://github.com/songsid/AgEnD/blob/a1a059f819e47f73a07aae48a198e2eb0b203bf8/src/contact-auth-store.ts#L314)

## 5. 每個門檻的具名威脅

| 門檻 | 防止什麼 |
|---|---|
| 系統人員 ID，且所有保留來源逐人符合 | 冒名、用一位已獲准的人洗掉其他人的請求來源。 |
| 固定來源房間／Agent、目標及 incarnation | 一個房間的允許擴散到別的房間，或同名替換 Agent 繼承舊授權。 |
| 精確 verb，擴大須明選 | 「可發訊息」暗中變成可委派、廣播或其他轉交能力。 |
| 目標既有管理員／核准者邊界、目前修訂重查與稽核 | Agent 自行加權、無權的人替目標放行，或過期編輯覆蓋撤銷。沿用現有驗證，不新增人員角色。 |
| 到期、可選次數、准入交易內重查與撤銷 | 遺忘的長期允許、並行重複扣次，或新請求繼續使用已撤銷的規則。 |
| Hub M-3160 仍先於常用轉交 | 用 Classic 聯絡規則繞過 Hub 問答期間不得聯絡同儕的限制。 |

這些門檻**不防止已獲准內容誘導目標使用既有憑證或工具**；那是另外的 action gate／broker 範圍，本提案不拿聯絡表冒充操作隔離。[既有服務邊界](https://github.com/songsid/AgEnD/blob/a1a059f819e47f73a07aae48a198e2eb0b203bf8/src/contact-auth-service.ts#L29)

## 6. 建議使用者核准的範圍

建議一次核准本提案：**固定來源房間與請求類型、7 天預設期限、可明選多人但逐人存規則、不明來源仍單次核准**。這樣增加的是可見、可撤銷的每人常用轉交，不是籠統「信任」或目標操作權限。

使用者核准後才開始：先更新卡片與單人規則操作，再補多人明選與權限表編輯；以單人／多人缺一人／不明來源／跨房間／換 incarnation／到期／撤銷／並行扣次及 M-3384、M-3160 不回歸為驗收。UI 再按風格指南製作真實 app 截圖供使用者看。本次只有設計文件，沒有 UI 原型、程式或行為變更。

## 7. General 及聊天入口：現況與本次範圍

今天支援的切換入口是網頁房間「設定 → 權限」及 Needs you 建議卡的「切換這個房間」，共用 `PUT /ui/api/instances/:name/contact-permissions`。沒有可讓 General 切換此模式的 AgEnD 工具或斜線命令；`update_instance_config` 對 ClassicBot 房間只接受帳號設定 `backend_options.<backend>.credential_profile`，不接受受限模式。[工具的 Classic 分支](https://github.com/songsid/AgEnD/blob/a1a059f819e47f73a07aae48a198e2eb0b203bf8/src/outbound-handlers.ts#L1480)

今天聯絡申請的核准／拒絕在網頁「Fleet → 授權」及 Needs you 的同一張 `TicketCard`，共用 `POST /ui/api/contact-authorizations/:id/decision`；不是 General 的工具，也沒有直接在 Discord／Telegram 執行此決定的聯絡申請按鈕處理器。對 General 說「核准」或 General 自己用 `reply(buttons)` 畫按鈕，都不等於系統核准。[既有 API](https://github.com/songsid/AgEnD/blob/a1a059f819e47f73a07aae48a198e2eb0b203bf8/src/contact-auth-api.ts#L20)、[Needs you 重用網頁卡片](https://github.com/songsid/AgEnD/blob/a1a059f819e47f73a07aae48a198e2eb0b203bf8/src/ui/contact-needs.js#L21)

本次建議先涵蓋兩個既有網頁卡片入口；General 可說明並連到確切申請或權限頁，**不取得代管理員自行核准／加規則的工具**。若使用者也要在 Discord 直接處理，另外明確核准一個 General 的「提出變更」入口：由系統產生綁定真實申請、人員、範圍與目前修訂的確認卡，仍由平台驗證的管理員本人按鈕確認；General 不能確認自己的提案，不能把轉述「管理員說好」當證明。這防止轉述或 Agent 自行放行；不需要讓 LLM 判定誰有管理權。這個聊天確認入口尚未實作，也不在未經核准下默默加入本次功能。
