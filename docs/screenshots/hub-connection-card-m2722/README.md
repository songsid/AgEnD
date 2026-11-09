# M-2722：把三張 Hub 連線卡合為一張（待使用者決定）

> **這是設計提案，不是功能驗收或已完成的改版。** 在真實 Fleet「設定 → Hub」外殼中，以靜態示意替換連接區，保留既有元件樣式。沒有實作新的權限、連線、暫停或配對行為；沒有送出 API 寫入。所有名稱都是測試資料，沒有使用使用者的截圖或公司連結。

本機確認卡卡住的修正另在 #3491 / #3488；這份提案不擴大那個修正。

## 建議：一張「Hub 連線」，依目前狀態改變內容

- **尚未連線：** 公司連結／Hub 位址、Fleet 名稱、一個「以公司帳號連線」按鈕。公司登入成功會沿用現有流程啟用成員功能，使用者不需先找另一個開關。
- **配對碼：** 收在「使用配對碼連線（進階）」中，保留舊 Hub 的相容路徑。原本的成員開關移入這個區塊，不另成一張卡；不承諾繞過其既有確認步驟。
- **已連線：** 同一張卡顯示 Hub／Fleet 和連線狀態，以「開啟 Hub」為主要動作，「暫停連線」為較安靜的次要動作。Hub／Fleet 是唯讀文字，不使用輸入框；綠色狀態點沿用側欄的 `.dot.ok`。Agent 分享需另外設定，不再使用沒有對應目標的「下方」提示。
- **已暫停：** 清楚說明停止新的工作與回答傳送、保留連線資料和對話；同一位置提供「恢復連線」。它對應現有成員功能的停用／啟用，並非新設計一套授權。
- **移除：** 收在連線設定，與保留資料的暫停分開。繼續使用既有的確認及身分／精確目標檢查。

這樣比直接刪掉舊配對路徑小：不移除協定、不遷移儲存資料，也不讓舊 Hub 的使用者失去連線入口。預設畫面只呈現主要公司登入流程。沒有新增真人確認步驟；所有操作的後端授權規則仍照原本方式。

**請先決定這個資訊架構是否合適，再實作。** 目前只送出畫面，沒有把它放進產品 PR。

## 真實外殼的 zh-TW 畫面

Desktop 1366×1000/light（進階完整表單 1366×1320）；phone 390×844/dark。設計說明放在卡片外的頁面橫幅，卡片本身只呈現產品內容。手機有自己的捲動區，進階表單另有細節圖。

| 狀態 | 桌面 | 手機 |
|---|---|---|
| 尚未連線 | [PNG](PROPOSAL-desk-unconnected.png) | [PNG](PROPOSAL-phone-unconnected.png) |
| 舊配對進階展開 | [PNG](PROPOSAL-desk-manual.png) | [概覽](PROPOSAL-phone-manual.png)、[表單細節](PROPOSAL-phone-manual-detail.png) |
| 已連線 | [PNG](PROPOSAL-desk-connected.png) | [PNG](PROPOSAL-phone-connected.png) |
| 已暫停 | [PNG](PROPOSAL-desk-paused.png) | [PNG](PROPOSAL-phone-paused.png) |

## Scope / provenance

Actual shell source: alpha `bddab17f9f149976413fa1c1d842383e83ea21e4`, with the separate join-wait UI work present in the owned rig. The connection region is replaced by static trusted DOM. The surrounding Settings shell is retained; its Hub section uses the existing `.s-section-layout` for the standard 24px desktop / 20px phone gap. The illustrated connected/paused states are **not** runtime evidence. All eight state/screen combinations have one connection card, a page-level design banner outside it, no read-only inputs and no horizontal page overflow. The renderer records zero API writes; see [polish-receipt.json](polish-receipt.json).

Uses existing Settings components and token-based CSSOM adjustments for the static composition: `.card`, `.note`, `.field`, `.grid2`, `.form`, `.btn`, `.btn-primary`, `.btn-ghost`, `.tag` and `.dot.ok` / `.dot.warn`. All card buttons retain the shared pill shape; the switch uses the same monochrome `--accent-fill` as primary buttons. Top and expanded fields share `--s-4` spacing. The connected status is green, unconnected neutral, paused amber. Phone primary buttons fill the card width, and the disclosure is scrolled above the bottom navigation; the expanded form has its own detail capture. Desktop manual is captured tall enough to include the entire form.

**Existing shell label discrepancy:** desktop navigation says 「等你處理」 (`needsNav`), while the phone tab says 「待處理」 (`needsTab`), from `src/ui/shared/app-i18n.js`. This is existing app wording, not prototype text; it is flagged for a separate product-copy decision and is deliberately unchanged here.

These are decision PNGs only. No production source, authorization behavior, connection flow or feature flag changed. Behavioral, SKEW, style-gate and authorization acceptance for the proposed redesign belong to a later implementation after approval. The independent waiting-state bug fix remains #3491.
