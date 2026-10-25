---
section: Changed
---
- **kiro 在 AgEnD 底下不再自行更新（#2598）。** AgEnD 啟動的每個 kiro chat 都會帶上 `KIRO_NO_AUTO_UPDATE=1`：instance 啟動，以及版本、help 與模型清單的檢查。kiro-cli 3.0 拿掉了多數 kiro instance 正在用的經典引擎，自行更新上去會讓它們當場壞掉。現在 AgEnD 會讓每個 instance 留在已安裝、檢查過的 kiro 版本。若要讓 kiro-cli 本身也停止更新，請在 `~/.kiro/settings/cli.json` 把 `app.disableAutoupdates` 設為 `true`。
