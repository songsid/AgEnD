---
section: Added
---
- **不用 bot 也能設定 AgEnD：設定頁的「Web only (no bot)」（#2233）。** 瀏覽器設定頁（`agend setup`，以及 Windows 安裝程式的最後一步）在 Telegram、Discord 旁多了第三個選項。不需要 bot token、管理員 ID，也不用按 Verify：它只寫入你的第一個 agent、不建立聊天連線，之後從網頁儀表板使用 AgEnD。在機器上用 `agend web --code` 取得登入碼登入；後端 CLI 也能從儀表板登入。之後可以在設定裡加上 Discord 或 Telegram。Windows 安裝程式會提到這個選項，完成畫面也會說「只用網頁儀表板」，不會說通訊軟體已串接。
