---
section: Added
---
- **Web chat → ClassicBot 頻道同步（#1320 part B）。** 成功送到 classic instance 的 web 訊息，會同步到該 instance 開了 `web_echo: true` 的 ClassicBot 頻道（預設關、逐 entry）。同步走該頻道自己的 adapter 並關閉 mention，排序與 part A 同一條 before-reply lane，失敗不阻擋 web 投遞。防重入直接沿用 part A 的共用 helper（`neutralizeWebEchoText`、`formatWebChannelEcho`、`isWebChannelEcho`、固定 `WEB_ECHO_PREFIX`）：預覽與附件名稱的 mention 換成可見 ASCII 標籤，ingress 核對 fleet bot 作者加固定前綴。開關在 classicBot.yaml 與 Settings（非 boolean 拒絕、改了重啟該頻道、群組頻道在頁面二次確認）。
