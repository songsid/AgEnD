# 點擊火花／拖曳軌跡

[English](click-sparks.md)

把 [effect.json](click-sparks/effect.json) 與 [worker.js](click-sparks/worker.js) 複製到實例工作目錄內的一個資料夾，再呼叫
`upload_web_effect { "dir": "<資料夾>" }`，接著用 `apply_web_effect { "id": "<回傳的 id>" }`。
使用者也能在「外觀」選擇此效果供 page 或 box 槽使用。不需素材或參數。點陣圖每邊最多 512 px，繪製最多每秒 30 次，粒子消失後即停止；指標取樣另有下述限制。

若聊天開啟時焦點在輸入框，先點空白處，等效果開始播放，再測試另一次點擊。主機只會把輸入送給已就緒的效果。

- 在未受保護的空白處或一般訊息文字上點擊：出現短暫火花。
- 按住滑鼠主按鈕移動：留下粒子軌跡。單純移動不繪製。
- 輸入框、連結、按鈕、選單與對話框：不提供指標輸入。焦點留在可編輯欄位時也不提供輸入。
  粒子不會蓋住受保護的控制項。
- page 涵蓋視窗；box 只在宣告的矩形內回應。既有的前景安全、同意與效能限制仍然適用。
  代理放置的前景效果仍要求自訂 CSS 關閉，使用者自己的選擇保留原本的豁免。

指標輸入是取樣，並非可靠的滑鼠事件佇列：每個畫格只保留一個合格樣本，每秒最多 60 次，
品質降低時最多 30 次。新的移動可取代移動，但不會覆蓋待送的點擊或其他離散樣本；幾乎同時的
按下、放開、點擊會合併成最後的點擊。中間的點擊或拖曳邊界仍可能被丟棄。範例同時處理點擊與首次收到的按住樣本，
但無法還原主機未轉送的輸入。這個頻率限制約束指標樣本，不是 Worker 動畫畫格。
效果不會收到 DOM 目標、訊息內容或指標身分。觸控瀏覽器可能產生相容的指標／點擊事件；
捲動、觸控取消與拖曳擷取不是效果 API。請用於裝飾，不可作為必要的操作控制項。

原生瀏覽器配方（先 build，在儲存庫根目錄執行）：

```sh
PW_DIR=/path/to/playwright-package OUT_DIR=.artifacts/pointer \
PROBE_ENGINES=chromium,firefox,webkit PROBE_WIDTHS=1366,390 PROBE_MODES=light,dark \
node scripts/manual/effect-pointer-particles-1629.mts
```

配方使用實際的 stock Shell／Chat、效果驅動程式與 Worker，搭配建置後的私有 library／service／preview
模組及合成 session，不會登入真實帳號或啟動 fleet。Linux WebKit 不是真實 Safari。
收據分開記錄原生輸入、觀察到的主機送出封包與截圖；送出封包本身不能證明粒子已繪製。

### 擷取備註

若 Chromium 的 socket 路徑太長，可用 `PROBE_TMP_DIR` 指定自己擁有的短暫存路徑。Linux 啟動時會設定
`FONTCONFIG_FILE=/etc/fonts/fonts.conf`。每組互動使用新 context；安全監測保持啟用，案例內不會清除歷史。
`PROBE_GROUPS` 可選 `clicks`、`protected`、`drag-slow`、`drag-fast`、`degraded`、`touch`，
`PROBE_SURFACES` 可選 `chat`、`page`、`box`。Firefox 透過 in-process Playwright handle 使用原生截圖協定；
`PROBE_RAW_SCREENSHOT=0` 可改用公開 API 的截圖準備流程來診斷。收據分開保存耗時、原生輸入、主機封包時間與
實際粒子像素；必要的輸入或繪製缺失會以非零結束。

封包間隔包含最後的框架驗證與 IPC 延遲，只用來觀察節奏，不能當作 60／30 Hz 閘門時鐘的精確量測；該閘門由 registry 單元測試固定。少量彩色像素未達配方門檻時屬於畫面證據不足，不代表完全沒有繪製。
