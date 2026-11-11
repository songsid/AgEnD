# #3637：原有文字分頁與單一工具群組

[更新設計](../../../../design/desktop-split-chat.md)。**設計稿，尚未實作。** 這版取代先前 SVG／icon-only tabs 提案。

本機 alpha 基準1066a85a實際顯示 **聊天／檢視／紀錄／設定**。圖稿複製真 InstanceSwitch 的 rendered DOM，保留標籤、class、data-label 與 selected 樣式；沒有自製 tab 圖示。卡片、字級、用量及原⋯也從真的標頭複製。

| 圖稿 | 原始 PNG |
|---|---|
| 原有 top bar 基準，未改裝 | [baseline](light-baseline.png) |
| 左右：原文字 tabs；工具只在焦點格 | [right](light-right.png) |
| 左紀錄／右聊天，各自分頁 | [log](light-log.png) |
| 頁內浮窗：先截名稱，保留文字 tabs | [float](light-float.png) |
| 360px：聊天保留，尾端文字 tabs 在該格⋯ | [narrow360](light-narrow360.png) |
| 兩個 browser document 示意：各一組工具 | [popout](light-popout.png) |

## 控制放哪裡

同頁只有一個 page-owned 原工具群組，放在焦點格標頭，另一格不複製；沒有新工具列。卡片／Agent操作跟隨焦點 Agent，字級沿用 shared viewer preference，用量沿用單一 rail／dialog。原⋯和焦點格⋯合併，選單先列該格分頁／排列，再分區保留原 Agent／頁面命令。不是把字級改成只調某一格。

名稱先縮到最小可辨識空間；還不夠時從右邊移走未選的尾端文字 tabs。目前分頁保留，隱藏分頁仍以同一文字在該格⋯。窄格的字級／用量工具可沿用緊湊圖示，但**tabs 絕不轉成圖示**。

## 來源與檢查範圍

- 私有 disposable fixture／假 Agent／假登入與假名片，沒有 Fleet start、CLI、真人帳號或AD操作。產品原始碼沒有改動。
- 支援排版重用原r1／r2 helper；舊r2 tab CSS覆寫不載入，新的header overlay不重設 .seg-item 字體、padding、顏色或圓角。tabs直接取真元件DOM；窄幅只加hidden標記及文字overflow選單。
- receipt.json記錄 capture HEAD／tree／dirty、23份輸入與125 served asset bindings。比較每個tab的10項字體／padding／圓角／selected色彩屬性，全部符合baseline的active／inactive原樣；也核對labels、沒有tab圖示、同列、沒有重疊、active tab可見。
- 360px長名稱有實際寬度／ellipsis判定；隱藏labels必須等於選單中的overflow labels。Card／T／Usage各同頁一份，popout比較有兩份document所以各一份。保留無水平溢出、草稿不裁切、無重複id與guard／cleanup檢查。
- popout仍是兩份app surface加示意外框；不是功能popup測試。沒有keyboard／a11y、動態focus／resize／menu權限／SKEW／效能驗收。這些是批准後的建置驗收。
- 舊圖稿、receipts、helpers不改標成新執行。舊manifest的文件／索引摘要對應其捕捉commit，最新文件由這份manifest綁定。

## 重製

沿用PW_DIR與checksum-pinned Noto CJK：

    REPO="$PWD" PW_SCROLLBARS=1 \
      FONTCONFIG_FILE="$PWD/.artifacts/split-chat-design/font-output/fonts.conf" \
      node_modules/.bin/tsx docs/screenshots/desktop-split-chat-m2889/r2/text-tabs/render.mts

6張zh-TW light、1600×1000。連接埠占用就拒絕；不接管既有服務、不重試。

各控制保留原分頁／能力的顯示條件：原本沒有CardMenu或Agent命令的分頁，不因共享host新增那些命令。這組焦點範例為Chat，左側Log不重複工具。

最終結果：render exit0、6cases／10pane headers、40tab styles各10屬性符合baseline；23inputs／125served bindings驗證，guard0／cleanup完成。6原圖視覺清楚，final hashes前後一致；詳見checks.json與visual-review.json。
