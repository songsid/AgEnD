> **最新提案：[原有文字分頁＋單一工具群組](r2/text-tabs/README.md)**。下方 icon tabs 是歷史設計，已由使用者最新回饋取代；舊圖／receipts保持原範圍。

> **最新：[r2 同一列標頭](r2/header-row/README.md)**，含360px長名稱控制。

> **目前提案已更新至 [r2](r2/README.md)**：每格四分頁、沒有工作區列、VS Code 手勢，同時保留頁內自訂移動與真正彈出視窗。下方 r1 原圖與 receipts 只作歷史參考；舊 manifest 的文件摘要對應 ff2d1d59。

# 桌面雙對話圖稿（#3637／M-2889）

[設計文件](../../design/desktop-split-chat.md)。這是等待使用者批准的 **alpha／2.4 設計提案**，不是已可操作的功能。

建議：先做兩個不同對話，預設左右並排；每格有自己的輸入框與捲動。一般點側欄切換「目前窗格」；已開的對話只聚焦，不重複開。拖曳標頭可停靠；引用到另一格後，仍須由人送出。手機維持單格。

## 圖稿

全部為 zh-TW、1600×1000。各連結都是原始 PNG；淺、深色各六張。

| 畫面 | 淺色 | 深色 |
|---|---|---|
| 從側欄 Agent 的 ⋯ 開第二個對話 | [淺色](light-sidebar.png) | [深色](dark-sidebar.png) |
| 從對話標頭「另開對話」選 Agent | [淺色](light-header.png) | [深色](dark-header.png) |
| 左右：各自輸入，明確引用到另一格 | [淺色](light-right.png) | [深色](dark-right.png) |
| 上下：各自輸入，拖分隔線調比例 | [淺色](light-stack.png) | [深色](dark-stack.png) |
| 右下浮窗：主輸入框仍可見，角落可調大小 | [淺色](light-float.png) | [深色](dark-float.png) |
| 拖曳：五個停靠目標、落點預覽與 Esc 取消 | [淺色](light-snap.png) | [深色](dark-snap.png) |

## 來源與檢查範圍

- 基準：alpha `1066a85a2c48cae18e700b207adba1cdb450cf5a`。產品原始碼沒有改動。
- `render.mts` 啟動既有 smoke fixture 的私有暫存 HOME 與自有 loopback listener，使用假 Agent／訊息及假登入碼。沒有啟動 Fleet、CLI、真實帳號或現場服務。
- Chromium 先載入真正的 `app.html`、側欄、ChatPanel、訊息與 composer。接著複製已渲染的 shell DOM，僅在這份靜態副本排版；`mock.css` 附加到該本機頁面的真實 app.css 回應，沒有修改產品檔案。兩個 opening 畫面保留既有完整標頭，增加提案入口；雙格畫面示意縮短後的窗格標頭。
- `receipt.json` 記錄捕捉時的 HEAD／tree／dirty 狀態、12 份輸入摘要、讀取的 JS／CSS 回應摘要與每張圖的幾何。雜湊採 digest-first 格式；`manifest.json` 綁定文件、harness、receipt 及原圖。這些是修改中設計樹的捕捉，不冒充該基準已有雙窗格功能。
- 字型使用專案 checksum-pinned Noto CJK helper，regular／bold 的 zh-TW faces 通過 helper 驗證；沒有安裝或更改系統字型。開啟一般捲軸，讓浮窗的捲動範圍可見。
- 12/12 畫面通過沒有重複 DOM id、整頁／窗格沒有水平溢出、草稿不被裁切、焦點窗格與側欄一致的幾何檢查；process guard 為零違規，fixture 完成清理。另人工檢查原圖。
- **沒有**實作或驗收拖曳、鍵盤、引用插入、兩個可用 composer、兩格 lease／stream、URL 回復、SKEW、效能或可及性。畫面上的訊息、草稿、選單、焦點與拖曳狀態都是靜態設計示意；這些功能驗收列在設計文件，批准後才做。

## 重製

在此 checkout 安裝依賴，先設定 `PW_DIR` 指向含 playwright-core 與已安裝 Chromium 的本機環境；可用 `CHROME` 明確指定 Chromium。下面只使用 disposable fixture；若所需連接埠被占用就拒絕，不接管既有服務。

```sh
node scripts/ci/prepare-ui-gate-fonts.mjs \
  --cache-dir .artifacts/split-chat-design/font-cache \
  --output-dir .artifacts/split-chat-design/font-output
REPO="$PWD" PW_SCROLLBARS=1 \
  FONTCONFIG_FILE="$PWD/.artifacts/split-chat-design/font-output/fonts.conf" \
  OUT="$PWD/docs/screenshots/desktop-split-chat-m2889" \
  node_modules/.bin/tsx docs/screenshots/desktop-split-chat-m2889/render.mts
```

預期摘要：`{"cases":12,"guardViolations":[],"cleanup":true}`。若連接埠有衝突，可在執行前用 `PORT` 選另一組未使用的 fixture 連接埠（本身與下一號）；沒有重試迴圈。
