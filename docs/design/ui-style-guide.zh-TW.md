# AgEnD 網頁介面風格指南

[English](ui-style-guide.md)

這份指南寫給所有會修改網頁儀表板或 Hub 頁面的人，包括外部貢獻者。這裡的每條規則都已經定案：來自已合併的 PR、測試或記錄過的決議，並各自註明出處。審查 UI 相關的 pull request 時，會依照這份指南檢查。

寫新的標記或 CSS 之前，先找出最接近的現有畫面，照著它的做法來。一項介面修改看起來應該像是產品原本就有的一部分。

## 規則怎麼檢查

每條規則都會註明檢查方式：

- **CI**：測試或 UI 關卡會讓 pull request 失敗。
- **審查**：沒有自動檢查，由審查者從差異和截圖中確認。

文末的表格把兩者並列。

## 1. 使用共用元件

使用現有的共用元件和 class。已經有的東西，不要另外寫一次性的樣式（決議 3536dae9）。PR 說明要寫出這次修改依循哪個共用元件或哪個現有區塊。

| 需要 | 使用 | 檔案 |
|---|---|---|
| 頁面標題、範圍與引言 | `PageHead` | `src/ui/shared/page-head.js`（2.3.5 線） |
| 一塊內容 | `.card` | `src/ui/shared/app.css` |
| 設定的群組與列 | `.s-group`、`.s-group-head`、`.s-row`、`.field`、`.grid2` | `app.css` |
| 按鈕 | `.btn`、`.btn-primary`、`.btn-danger`、`.btn-ghost`、`.btn-sm`、`.icon-btn` | `app.css` |
| 小型狀態標籤 | `.tag`、`.tag.warn` | `app.css` |
| 提示文字／錯誤訊息 | `.note`／`.err` | `app.css` |
| 載入中、沒有內容、讀取失敗 | `Skeleton`、`Empty`、`ErrorState` | `src/ui/shared/ui-states.js` |
| 對話框／確認 | `Dialog`／`confirmDialog` | `ui-dialog.js`／`ui-confirm.js` |
| 簡短的結果訊息 | `toast(text, ok)` | `ui-toast.js` |
| 圖示 | `Icon({ name, size })` | `ui-icons.js` |

應該這樣寫：

```js
html`<section class="card s-group"><div class="s-group-head"><h3>${t("x.title")}</h3></div>…</section>`
```

不要這樣寫：

```js
html`<section class="s-card">…</section>`   // 沒有這個樣式，結果畫出來沒有外框（#3320）
```

檢查方式：**審查**。

## 2. 同一個設定區塊裡，卡片外框都一樣

頂層的設定卡片就用一般的 `.card`，它提供共用的背景、`--r-md` 圓角和內距（`app.css`）。不要替某一張卡片另外加邊框、內距或圓角：同一個區塊裡的卡片看起來必須一致。卡片裡的東西不能比卡片寬。

這裡兩條分支不一樣。在 2.3.5 線上，#3320 為每個設定區塊加了統一的外框（`.s-section-layout`：1px 的 `--border` 邊框、`--r-md` 圓角、內距 24px（600 px 以下為 16px），並把 select 和輸入框限制在 `max-width: 100%`）。main 沒有這個版面（#3325 刻意沒有帶過來），所以不要把那套外框照搬到 main。

檢查方式：**CI**。UI 關卡的 `:frame` 檢查以區塊為單位：同一個區塊裡看得到的頂層卡片，內距、邊框和左上圓角必須相同。放在抽屜、展開區塊、`details` 或對話框裡的卡片，以及 `.s-dev` 編輯器和 `.s-access-terminal` 卡片，不列入比對。不同區塊之間的外框不互相比對。

## 3. 左側色條一律用直的

表示狀態、選取或引用的左側色條，是一條直的 3px 色條：加上 `.lbar`，再設定 `--lbar-color`。圓角的方塊絕對不要用 `border-left` 做色條，邊框會順著圓角彎進去（#2330、#2332、#2478／#2489）。

應該這樣寫：

```css
.my-row { --lbar-color: var(--ok); }          /* 標記裡加上 class="… lbar" */
```

不要這樣寫：

```css
.my-row { border-left: 4px solid var(--ok); }  /* .s-row 有 border-radius: var(--r-md) */
```

檢查方式：**CI**。`tests/web-left-bar-2330.test.ts` 比對樣式表的規則；UI 關卡的 `:left-accent` 則量測每個設定區塊實際畫出來的結果，同一個元素從另一條規則拿到圓角的情況（例如 `.s-row` 加上一個新的列 class）也抓得到（#3367、#3408）。設定頁以外的頁面靠**審查**。

## 4. 間距、字級、圓角和顏色都用變數，淺色和深色都要能用

尺寸和顏色從 `src/ui/shared/tokens.css` 取用：

- 間距 `--s-1` … `--s-8`（以 4px 為格）；
- 字級 `--fs-xs` … `--fs-xl` 和對應的 `--lh-*`，字重 `--fw-*`；
- 圓角 `--r-sm`、`--r-md`、`--r-lg`、`--r-full`；
- 顏色依用途取用：`--text`、`--text-2`、`--text-3`、`--surface`、`--surface-2`、`--border`、`--accent`、`--ok`、`--warn`、`--danger`，以及實際存在的 `-bg`／`-line` 版本（`--ok-bg`、`--warn-bg`、`--warn-line`、`--danger-bg`、`--danger-line`）。

深色是預設的 `:root`，淺色覆寫同樣的名稱。所以用變數寫的顏色在兩種主題下都正確，寫死的十六進位色碼則不會。

應該這樣寫：`color: var(--text-3); padding: var(--s-3) var(--s-4);`

不要這樣寫：`color: #888; padding: 13px;`

檢查方式：**CI**。`tests/web-tokens-1408.test.ts` 檢查變數本身（淺色和深色定義同一組名稱，文字對比至少 4.5:1，焦點框與邊框至少 3:1）。`tests/ui-css-literals-ratchet.test.ts` 則以「只減不增」的方式檢查使用情形：舊規則裡還留著的寫死顏色（`#hex`、`rgb()`、`rgba()`、`hsl()`）和以 px 寫的字級，列在 `tests/ui-css-literals-allowlist.json`；新增一個就會失敗（寫在巢狀規則裡或用大寫也一樣），清單也只會縮小：已經拿掉的值必須從清單移除；`UPDATE_CSS_LITERALS=1` 只會調低清單，不會調高。寫死的間距和圓角沒有掃描，靠**審查**。

## 5. 不使用行內樣式

頁面在 `style-src 'self'` 的內容安全政策（CSP）下執行。不要寫 `style=` 屬性、`el({ style })`、`setAttribute("style", …)`、`<style>` 元素或動態建立的樣式表。請改用 class；執行時才知道的尺寸，透過 CSSOM 設定（`el.style.setProperty(...)`）（#1300）。

應該這樣寫：`` html`<button class="btn btn-primary">` ``

不要這樣寫：`` html`<div style=${"width:" + w + "px"}>` ``

檢查方式：**CI**，由 `tests/web-csp-1300.test.ts` 檢查。

## 6. 載入中、沒有內容、讀取失敗

- 第一次讀取時，顯示和之後內容同形狀的 `Skeleton`。重新整理時，保留已經顯示的內容（#3294、#3295）。
- 沒有東西可顯示時，用 `Empty`，並提示下一步可以做什麼。
- 讀取失敗時，用附有「重試」的 `ErrorState`，不要顯示成空清單。

應該這樣寫：`` !data ? html`<${Skeleton} variant="rows" lines=${4} />` : … ``

不要這樣寫：單純一行「Loading…」文字，或每次重新整理都把內容換成轉圈圈。

檢查方式：共用狀態元件由 **CI** 檢查（`tests/skeleton-loading-3290.test.ts`），新頁面靠**審查**。

## 7. 手機和桌面都能用，不能左右捲動

每個頁面都要能在 390 px 的手機、1366 px 的桌面、兩者之間（900–1366 px），以及很長的內容（很長的名稱、很長的選項）下正常顯示，畫面不能出現水平捲動。版面在 899 px 切換成手機版（`max-width: 899px`）。在手機或觸控螢幕上，輸入框字級至少 16px，避免 iOS 自動放大；每個可操作的控制項長寬都至少要有 `--tap`（44px），核取方塊和選項按鈕以它的標籤計算。

已知的不一致：#3320 的部分設定規則在 `max-width: 600px` 切換，而不是 899 px。新的 CSS 不要沿用 600 px 的寫法；統一兩者是另一項修改。

檢查方式：設定頁由 **CI** 檢查：UI 關卡的 `:overflow`（所有展開區塊都打開、每個選單加上一個很長的選項），以及手機寬度下的 `:tap`。`:tap` 也是只減不增：目前偏小的控制項列在 `scripts/manual/smoke/ui-gate-tap-allowlist.json`，新增一個就會失敗，不論它一開始就畫出來，還是要打開展開區塊才出現。停用的控制項不計。清單只會縮小：完整的關卡（`GATE=full`）遇到已經不再對應偏小控制項的項目，也會失敗。16px 的輸入框由 `tests/web-input-zoom-1611.test.ts` 檢查。Hub 自己的頁面（登入、歡迎頁、對話、擁有者的 Agent、管理和群組權限）在 Hub 關卡裡有一樣的 `:overflow` 和 `:tap` 檢查，清單另外放在 `scripts/manual/smoke/ui-gate-hub-tap-allowlist.json`。其他頁面靠**審查**，看截圖確認。

## 8. 每段文字都有英文和繁體中文

畫面上的每段文字都要走字串表（`src/ui/shared/app-i18n.js` 的 `register()`／`t()`，或該頁自己的字串模組），並同時提供 `en` 和 `zh-TW`。範本、toast 或確認框裡都不能直接寫英文。

應該這樣寫：`` html`<p class="note">${t("x.hint")}</p>` ``

不要這樣寫：`` html`<p class="note">Saved!</p>` ``

檢查方式：**CI**，由 `tests/i18n-ui-literals-2390.test.ts` 檢查範本裡直接寫的英文，以及中英兩邊的字串鍵是否一致。中文措辭靠**審查**，要讀起來像自然的中文。

## 9. 在哪裡開始就在哪裡完成，點擊越少越好

出自決議 721ca0c3：

- **同一個介面完成。** 在網頁提供的功能，就要能在網頁完成。要求使用者改到 Telegram、Discord 或終端機才能完成，就是錯誤；除非安全規則需要第二道驗證，這時頁面要就地提供（例如網頁上的 TOTP 確認），並就地說明替代做法。
- **不叫使用者輸入主機指令。** 介面絕對不能叫人到主機上輸入指令。無法在頁面上完成確認時，請引導使用者到 Telegram 或 Discord 的 General。
- **點擊越少越好。** 除非記錄過的威脅（決議 64a289a0）確實需要，否則不要新增確認對話框、額外的核准，或「按這裡才能繼續」的步驟；真的需要時，沿用使用者本來就會按的那一下。PR 說明要寫出新增任何點擊或確認的理由。

檢查方式：**審查**。PR 說明要寫出這個流程支援哪些介面。

## 10. 錯誤訊息用白話說

錯誤訊息要用使用者聽得懂的話，說清楚發生了什麼、可以怎麼做：例如「無法連上 Hub。」並附上「重試」，而不是 `ECONNREFUSED` 或狀態碼。伺服器的代碼留給日誌。這是使用者為這份指南列出的既有規則之一（2026-11-08），現有測試也在各自的介面上守著它：送達通知絕不顯示原始錯誤（`tests/delivery-notices-i18n.test.ts`），命名連結測試的某個步驟出錯時，顯示整理過的失敗訊息，而不是原始錯誤（#2907，`tests/named-link-test-2906.test.ts`）。

檢查方式：這些介面由 **CI** 檢查，其他地方靠**審查**。

## 11. 中文裡的 Agent 和 Fleet 保留英文

繁體中文的文字保留英文的產品名稱：**Agent** 和 **Fleet**，不寫成「代理」或「艦隊」。General 和 Hub 也保留英文（決議 815bfe4a，使用者於 2026-11-08 選定）。英文名詞和前後的中文之間留一個空格，和現有的字串一致。「反向代理」（reverse proxy）是另一回事，照樣用中文。

應該這樣寫：`"這個 Fleet 已關閉預覽"`、`"指令沒有送到 Agent"`

不要這樣寫：`"這個艦隊已關閉預覽"`、`"指令沒有送到代理"`

檢查方式：**CI**，由 `tests/ui-zh-terms-815bfe4a.test.ts` 掃描 `src/` 底下的每個原始碼檔案。

## 12. 設定頁的圖示用共用圖示集，不用 emoji

設定頁的圖示來自共用的線條圖示集：`src/ui/shared/ui-icons.js` 的 `Icon({ name, size })`（24px 格線、2px 線寬、`currentColor`）。不要在那裡用 emoji 當圖示；設定頁改版時已經把它們拿掉了（`docs/design/1408-app-shell.md`）。本身就是內容的 emoji（使用者的訊息、選定的角色 emoji）不算圖示。

應該這樣寫：`` html`<${Icon} name="check" size=${16} />` ``

不要這樣寫：`` html`<span class="s-ico">⚙️</span>` ``

檢查方式：**審查**。

## Pull request 要附的證明

新增或修改 UI 的 PR 要附上（決議 3536dae9）：

- 修改前後的截圖：桌面和手機、淺色和深色、英文和繁體中文；
- 依循的共用元件或現有區塊；
- 如果是新流程，寫出它支援哪些介面，以及新增任何點擊或確認的理由。

## CI 檢查的和審查檢查的

| 規則 | CI | 審查 |
|---|---|---|
| 1. 共用元件 | — | 是 |
| 2. 同一設定區塊的卡片外框一致 | UI 關卡 `:frame`（區塊內） | 跨區塊、其他頁面 |
| 3. 直的左側色條 | `web-left-bar-2330`、UI 關卡 `:left-accent`（設定頁） | 設定頁以外的頁面 |
| 4. 變數、淺色與深色 | `web-tokens-1408`（變數集合、對比）、`ui-css-literals-ratchet`（不新增寫死的顏色或 px 字級） | 寫死的間距和圓角 |
| 5. 不用行內樣式 | `web-csp-1300` | — |
| 6. 載入中／沒有內容／失敗 | `skeleton-loading-3290` | 新頁面 |
| 7. 手機和桌面 | UI 關卡 `:overflow` 和 `:tap`（設定頁、Hub 頁面）、`web-input-zoom-1611` | 其他頁面 |
| 8. 英文與繁體中文 | `i18n-ui-literals-2390` | 措辭 |
| 9. 同一介面完成、點擊最少 | — | 是 |
| 10. 白話的錯誤訊息 | `delivery-notices-i18n`、`named-link-test-2906`（各自的介面） | 其他地方 |
| 11. 中文裡的 Agent／Fleet | `ui-zh-terms-815bfe4a` | — |
| 12. 共用圖示、不用 emoji 圖示（設定頁） | — | 是 |
| 按鈕尺寸（設定頁、Hub 頁面） | UI 關卡 `:buttons`（同一組按鈕 class 高度一致） | — |
| 沒有頁面錯誤或 CSP 回報（設定頁、Hub 頁面） | UI 關卡 `:no-errors` | — |

UI 關卡是 `scripts/manual/smoke/smoke-settings-ui-gate.mts`，由 `.github/workflows/ci.yml` 的 `ui-gate` 工作執行：在 `desk-light-en` 和 `phone-dark-zh-TW` 下逐一檢查每個設定區塊，另外加測 1024 px 的桌面寬度。同一個工作也執行 Hub 關卡 `scripts/manual/smoke/smoke-hub-ui-gate.mts`：在真正的 Hub 網頁伺服器（暫用的資料庫和目錄）上跑同樣的情境；頁面顯示讀取失敗而不是內容時也會失敗。
