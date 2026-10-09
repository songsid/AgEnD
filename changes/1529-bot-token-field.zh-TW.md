---
section: Fixed
---
- **設定：新增連線絕不會取代既有連線（#1529）。** 設定精靈過去會用 token 變數比對既有連線並覆蓋它，所以在 Telegram 之後新增 Discord bot 時，可能無聲地取代掉 Telegram 連線。現在每條新連線都有自己的 id（`discord`、`discord-2`…）和自己的 token 變數，會佔用別條連線的請求會被拒絕。
