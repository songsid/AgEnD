---
section: Changed
---

- **儀表板與通知不再叫人在主機上打指令（#3326）。** 同一畫面有替代路徑時，文案會指向那裡：有 Settings job 時按立即重新啟動、在 General 傳 `/restart`（web-only 手改 fleet.yaml 的橫幅則寫重新啟動 AgEnD）、設定 → Agents →「AI 登入與 API 金鑰」→「帳號」或 `/login`、agent 聊天選單的「啟動 instance」、`/update`、`/web revoke`、全部登出，或儀表板 General 聊天裡的按鈕。web-only Fleet 不會提到 General，讀者就是擁有者時也不會請「這台電腦的擁有者」處理。未能寫入的 `/web revoke` 會警告重啟可能讓那些 session 回來。最後手段的 CLI 仍只寫在文件與 `--help`。
