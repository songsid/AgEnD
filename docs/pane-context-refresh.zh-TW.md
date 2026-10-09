# Pane context 更新

[English](pane-context-refresh.md)

View 與狀態更新使用 instance daemon 已有的 tmux manager 與 control 讀取路徑。
Claude Code 仍優先採用具權威性的 `statusline.json`；明確執行 `/ctx` 時，維持
既有同步讀取最新畫面的行為。

## 上限與歸屬

- 輪詢立即回傳快取值。快取以單調時鐘計算達 8 秒後，對目前的 instance／pane
  owner 啟動一次背景更新；多個頁面的同時讀取共用這次更新。
- 擷取 60 行 history，包含排隊在內總預算為 2 秒。既有 lane 將原始輸出限制為
  1 MiB、排隊讀取限制為 256 筆。
- control 連線正常時不建立 capture 子程序。斷線或 control attempt 逾時時，仍
  使用既有 fallback，最多兩個實際子程序；只有 exit／close 才釋放名額。
- 結果必須仍屬於相同 daemon、tmux manager、launch owner、delivery epoch 與
  fleet admission。停機、respawn、pane 替換、取消或移除後，舊結果不可套用。
  缺少 owner 時回傳 unknown。
- Codex、Kiro、Grok 等 backend 使用原有 parser。讀取不可用時仍為 unknown，
  快取間隔過後可重試。

用來辨識預設 tmux namespace 的 OS home，只在帳號資料庫查詢成功後、同一個
OS 使用者內快取。改動 `HOME` 不會取得預設 server 權限；`AGEND_HOME` 仍決定
自訂 namespace。帳號查詢失敗為 unknown，後續可重試；user id 改動會使成功的
home 快取失效。socket／session 名稱不變。

## 證據與限制

#1235 提供的唯讀 alpha.2 profile 長 60.000511 秒，共 5,928 samples；
`scrapePaneContextAsync` 下的 leaf `spawn` samples 合計 1,087.715 ms。
這是取樣時間，並非呼叫次數。它歸因到輪詢 capture 路徑，沒有歸因到目前擱置的
binary discovery、install、Kiro compatibility 或 statusline 工作。

執行 `npm run build`，再執行 `node scripts/benchmark-pane-context.mjs`。它模擬
23 個 instance、每 10 秒一次、共六次輪詢。舊路徑建立私有、只輸出固定文字的
fake tmux；新路徑使用真 manager／lane 與無外部作用的已連線 transport。
不連接 tmux server、不啟動 fleet／backend CLI，也不使用帳號。

| 三次本機測量 | 舊路徑 | 已連線 control |
| --- | --- | --- |
| 每個模擬分鐘的 capture 子程序 | 138 | 0 |
| 完整 fixture 工作量 | 166.7–202.3 ms | 0.82–2.14 ms |
| 單次 event-loop turn 最長 native 呼叫時間總和 | 27.3–50.1 ms | 0 ms |
| 最大 heartbeat 間隔 | 28.3–51.7 ms | 0.56–1.39 ms |

這是單一主機上 inert fixture 的數字。heartbeat 間隔包含主機排程與 I/O，並非
production 延遲保證或新的 live 前後 profile。pane parsing、statusline 讀取與
其他無關工作仍然存在。
