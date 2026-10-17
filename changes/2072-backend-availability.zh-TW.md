---
section: Changed
---
- **`/backend` 與建立 instance 的對話框會列出所有 backend，並說明為何某個無法在這台主機上使用（#2072）。** 無法使用的 backend 會停用並註明原因：未安裝、未登入（請用 /login）、或版本低於 AgEnD 支援的最低版本。尚未檢查的仍可選擇；instance 目前使用的 backend 一律不會被停用。Discord 的選單無法停用選項，所以原因寫在選項文字裡，選了會告知原因。
  - 這些結果來自 fleet 在背景更新的快照：啟動時、每 10 分鐘、以及 `/login` 安裝或登入後。若沒有任何變動，就不會執行任何 CLI。
  - 登入狀態一律離線讀取 CLI 自己的憑證檔，不會呼叫任何 API。絕不在 CLI 可能自我更新或連網的情況下啟動它：版本優先從磁碟讀取；否則（Linux）在無網路的環境執行 `--version`；都不行就標示為未知。
  - 選單、ClassicBot 的 `/start` 與設定精靈不再在 fleet 的事件迴圈上執行 `which`。
