# M-2722：把三張 Hub 連接卡合為一張（待使用者決定）

> **這是設計提案，不是功能驗收或已完成的改版。** 在真實 Fleet「設定 → Hub」外殼中，以靜態示意替換連接區，保留既有元件樣式。沒有實作新的權限、連接、暫停或配對行為；沒有送出 API 寫入。所有名稱都是測試資料，沒有使用使用者的截圖或公司連結。

本機確認卡卡住的修正另在 #3491 / #3488；這份提案不擴大那個修正。

## 建議：一張「Hub 連線」，依目前狀態改變內容

- **尚未連接：** 公司連結／Hub 位址、Fleet 名稱、一個「以公司帳號連接」按鈕。公司登入成功會沿用現有流程啟用成員功能，使用者不需先找另一個開關。
- **配對碼：** 收在「使用配對碼連接（進階）」中，保留舊 Hub 的相容路徑。原本的成員開關移入這個區塊，不另成一張卡；不承諾繞過其既有確認步驟。
- **已連線：** 同一張卡顯示 Hub／Fleet 和連線狀態，提供「開啟 Hub」及「暫停連線」。分享哪些 Agent 仍留在下方既有公開／授權區，連線不等於分享。
- **已暫停：** 清楚說明停止新的工作與回答傳送、保留連線資料和對話；同一位置提供「恢復連線」。它對應現有成員功能的停用／啟用，並非新設計一套授權。
- **移除：** 收在連線設定，與保留資料的暫停分開。繼續使用既有的確認及身分／精確目標檢查。

這樣比直接刪掉舊配對路徑小：不移除協定、不遷移儲存資料，也不讓舊 Hub 的使用者失去連接入口。預設畫面只呈現主要公司登入流程。沒有新增真人確認步驟；所有操作的後端授權規則仍照原本方式。

**請先決定這個資訊架構是否合適，再實作。** 目前只送出畫面，沒有把它放進產品 PR。

## 真實外殼的 zh-TW 畫面

Desktop1366×900/light；phone390×844/dark。每張圖標示「設計提案｜尚未實作」。手機有自己的捲動區，進階表單另有細節圖。

| 狀態 | 桌面 | 手機 |
|---|---|---|
| 尚未連接 | [PNG](PROPOSAL-desk-unconnected.png) | [PNG](PROPOSAL-phone-unconnected.png) |
| 舊配對進階展開 | [PNG](PROPOSAL-desk-manual.png) | [概覽](PROPOSAL-phone-manual.png)、[表單細節](PROPOSAL-phone-manual-detail.png) |
| 已連線 | [PNG](PROPOSAL-desk-connected.png) | [PNG](PROPOSAL-phone-connected.png) |
| 已暫停 | [PNG](PROPOSAL-desk-paused.png) | [PNG](PROPOSAL-phone-paused.png) |

## Scope / provenance

Actual shell source: alpha `bddab17f9f149976413fa1c1d842383e83ea21e4`, with the separate join-wait UI work present in the owned rig. Only `.hub-membership-settings` is replaced by static trusted DOM for these images. The illustrated connected/paused states are **not** runtime evidence. Eight state/screen combinations assert a single card and no horizontal page overflow; the proposal renderer records zero API writes. A read-only image check found no remaining clipping or unstyled definition-list issue after using existing `.grid2`/`.field` read-only inputs and capturing the phone manual form in view.

Uses the existing Settings section/frame, `.card`, `.note`, `.field-row`, `.field`, `.grid2`, `.btn`, `.tag` and native disclosure styling. No custom CSS, inline styles, colors, fonts or left accent. These are decision PNGs; full behavioral, SKEW, style-gate and authorization acceptance belong to the later implementation after approval.
