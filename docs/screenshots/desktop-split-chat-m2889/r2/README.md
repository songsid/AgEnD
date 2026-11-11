# #3637 r2 圖稿：每格四分頁，沒有工作區列

[設計文件](../../../design/desktop-split-chat.md)。**設計而已，沒有產品實作**。最新 brief 同時保留左右／上下、頁內自訂移動、真正瀏覽器 pop-out。

全部為 zh-TW、淺色、1600×1000，使用真正 app.html／側欄／ChatPanel／composer 與 Log 頁面骨架。不是 standalone 網頁。

| 畫面 | 原始 PNG |
|---|---|
| 一格，原有標頭與分頁外觀 | [single](light-single.png) |
| 側欄 ⋯ → 在旁邊開啟 | [sidebar](light-sidebar.png) |
| 左右，各格完整圖示分頁與輸入框 | [right](light-right.png) |
| 左格紀錄，右格聊天 | [log](light-log.png) |
| 上下，各格標頭／四分頁／composer | [stack](light-stack.png) |
| 自訂移動，頁內浮窗可拖標頭與角落縮放 | [float](light-float.png) |
| 拖到右邊，半透明藍色半區 | [right drop](light-drag-right.png) |
| 拖到下面，半透明藍色半區 | [bottom drop](light-drag-bottom.png) |
| 中央，取代目標格 | [center drop](light-drag-center.png) |
| 每格的排列選單 | [menu](light-menu.png) |
| 分割按鈕開 Agent 選擇器／Alt 向下提示 | [header](light-header.png) |
| 彈出視窗在主視窗旁，主視窗剩一格 | [popout](light-popout.png) |

## 範圍與來源

- r1 branch HEAD ff2d1d59c28b6488827d9372428178c18c4fc850，產品基準1066a85a。r2 使用同一分支，只改設計文件、圖稿與 harness。r1 PNG／receipt／manifest 原封保留；舊 manifest 的設計文件／索引摘要對應 r1 commit，不能當成現在文件的摘要。
- render.mts 啟動既有 disposable smoke fixture，私有 HOME、自有 loopback listener、假 Agent／登入／訊息。沒有啟動 Fleet、CLI、真人帳號、現場服務或真 AD；process guard 必須零違規。
- 單格直接複製已渲染的真 shell，不加工作區列。其他狀態重用 r1 靜態 pane 副本，重新使用真 PanelHeader／InstanceSwitch 結構及 ui-icons.js 的 SVG，補上完整分頁；Log 用真 LogPanel 的 frame／class，行內資料為靜態假紀錄。不是同時 mount 兩個可用 pane。
- mock.css 只附加在 fixture 的 app.css 回應，產品 CSS 沒改。evaluate 的資料用引數傳入，不組可執行字串。
- popout PNG 是**兩份真 app surface 的靜態並置示意**，瀏覽器外框為圖稿；沒有執行 window.open／權限／草稿交接。實際外框、分頁或視窗、位置由瀏覽器／OS 決定；圖稿不假裝瀏覽器能保證無 chrome。
- receipt.json 綁 capture HEAD／tree／dirty、18份輸入與當時 served JS／CSS 摘要、每張幾何；使用 digest-first 形式。這是有明確輸入摘要的修改中設計樹，沒有冒充基準已有雙格功能。manifest.json 綁目前文件、harness、receipt、原圖。
- 幾何檢查：無工作區列、每個示意 pane 有4分頁、無重複 DOM id／整頁或 pane 水平溢出／草稿裁切。字型沿用 checksum-pinned Noto CJK，沒有系統安裝。最終重製先 drain route handlers 再關 browser context，避免 CSS 回應在清理中被中斷。
- **未驗收**拖放、分割、keyboard／a11y、引用插入、可用 composer、資料／權限／lease／stream、popup、URL、SKEW、效能。以上仍是設計文件列出的後續建置驗收，不用靜態 PNG 代替。

最終結果：12/12 幾何通過、18/18 capture inputs 驗證、125 served asset bindings、零 process-guard 違規、cleanup 完成、render exit 0。內建影像審閱逐張檢查12原圖，前後雜湊均符合 image-bindings.json；SVG、紀錄、浮窗與選單無剩餘視覺阻擋。詳見 checks.json／visual-review.json。

## 重製

在此 checkout 設 PW_DIR 指向 playwright-core／Chromium，依 r1 索引準備 pinned fontconfig，再執行：

    REPO="$PWD" PW_SCROLLBARS=1 \
      FONTCONFIG_FILE="$PWD/.artifacts/split-chat-design/font-output/fonts.conf" \
      node_modules/.bin/tsx docs/screenshots/desktop-split-chat-m2889/r2/render.mts

OUT 可指定自有輸出目錄；預設 fixture port49470及下一號，有占用就拒絕，不接管，不重試。
