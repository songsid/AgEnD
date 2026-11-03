---
section: Fixed
---
- **Windows Agent：真機驗收發現的問題已修正（#2953）。** 這台電腦上的常駐（終端工作階段）Windows Agent 現在能啟動；先前在每台 Windows 電腦上，它的 relay 都會立刻結束。常駐 Codex Agent 的下一則訊息，不會再因為畫面仍在重繪而送不出去。建立常駐 Codex Agent 時，不會再因啟動時序問題失敗。Windows Agent 等待權限確認時，會和 Linux Agent 一樣在它的 topic 與 General 顯示提示、列在網頁的「等你處理」，按「停止」或「取消」也能關掉這個提示。提示與「等你處理」改用 Agent 的顯示名稱。設定變更失敗時會說明原因，不再只顯示「無法套用」或「授權已過期」。對同一個待確認的變更再按一次「儲存」，不會再多出一筆相同的請求。新 Windows Agent 的確認內容會列出它的 CLI 與模型。關閉「使用這台電腦 Windows 上的 CLI」後，「新增 Agent」不再提供「Windows 本機」。
