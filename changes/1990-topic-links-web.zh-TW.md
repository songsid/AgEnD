---
section: Added
---
- **網頁：跨 instance 狀態列與提示卡裡的名稱，點了就會打開那個 instance（#1990）。**
  - 聊天裡的狀態列（「alice → bob: …」）中，另一個 instance 的名稱會打開它的聊天。
  - 提示卡（instance 已停止、在等待輸入）中，instance 的名稱會打開它的終端機 View。
  - 都在 app 內開啟，不重新載入、不開新分頁。重新整理頁面或 fleet 重新啟動後，連結都還在。
  - agent 或人發的訊息永遠不會出現這種連結。
