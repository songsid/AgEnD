> **最新提案：[原有文字分頁＋單一工具群組](../text-tabs/README.md)**。下方 icon tabs 是歷史設計，已由使用者最新回饋取代；舊圖／receipts保持原範圍。

# #3637 r2 追加：四分頁和名稱同一列

[更新設計](../../../../design/desktop-split-chat.md)。**僅設計稿，沒有產品實作。** 取代先前 r2 圖稿的第二行標頭。

- 名稱、狀態、四分頁、分割／⋯／✕ 同一列；右端操作不換行。
- 窗格 ≥640px 顯示圖示＋文字；360–639px 只顯示圖示，每個分頁有完整 tooltip／aria-label，保留 active 語意。
- 名稱先截斷，全名保留在 title；不讓 tabs 因名稱太長消失。

| 圖稿 | 原始 PNG |
|---|---|
| 左右：兩格的 icon＋text tabs 都在第一列 | [right](light-right.png) |
| 左紀錄／右聊天，分頁同列 | [log](light-log.png) |
| 頁內浮窗：窄格改 icon-only | [float](light-float.png) |
| 彈出比較：主視窗文字 tabs／子視窗 icon-only | [popout](light-popout.png) |
| 360px 最小窗格：長名稱截斷，四 tabs 與三操作保留 | [narrow360](light-narrow360.png) |

## 檢查範圍

真正 app shell、側欄、ChatPanel／composer、Log 骨架，以原 r2 harness 做 screenshot-only overlay；使用 app 的 SVG。只有設計文件及圖稿改動。此資料夾保留新的 capture HEAD／dirty／source／served asset bindings；原 r1／r2 PNG、receipts 與 helper 保留原樣。先前 manifests 的文件／索引摘要對應各自捕捉的版本。

幾何檢查量測名稱、tabs、右端操作的垂直中線，必須在同一列；tabs 與操作不重疊或超出 header。每格4SVG tabs；icon-only 有 tooltip／aria-label；依每格寬度核對 label 顯示。360px 實際寬度及長名稱截斷另有明確斷言。也保留無水平溢出、無重複 DOM id、草稿不裁切、Log 單一 filter、process guard 與 cleanup。

popout 仍是兩份 app surface 加上示意瀏覽器外框，沒有執行 window.open。沒有功能、hover/keyboard/a11y、popup、SKEW 或效能驗收；tooltip／ARIA 在此只檢查 DOM 屬性。coarse-pointer 的44px規則有寫入圖稿 CSS，這組桌面截圖未驗證觸控模式。

## 重製

沿用上層 r2 的 PW_DIR 與 pinned Noto CJK fontconfig：

    REPO="$PWD" PW_SCROLLBARS=1 \
      FONTCONFIG_FILE="$PWD/.artifacts/split-chat-design/font-output/fonts.conf" \
      node_modules/.bin/tsx docs/screenshots/desktop-split-chat-m2889/r2/header-row/render.mts

全部為 zh-TW light、1600×1000；disposable fixture、假資料、沒有 Fleet／CLI／真帳號／AD 操作。

最終結果：render exit0；5/5 scenes、10/10 pane headers 幾何通過；20 capture inputs、125 served bindings 驗證；guard0／cleanup完成。內建影像審閱檢查5原圖，沒有剩餘視覺阻擋。原r2的20份非索引檔案與a5e1e9dc9逐位元相同。
