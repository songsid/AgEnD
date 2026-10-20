---
section: Changed
---
- **Windows 安裝程式不再自己重新啟動整個 WSL。** 剛裝好的 Ubuntu 還沒準備好時，只重新啟動那一個 Linux（`wsl --terminate`）再試；還是不行，才會先詢問要不要重新啟動整個 WSL，因為那會停掉這台電腦上所有的 Linux。預設不要；回答不要就停下來，並說明之後怎麼繼續。文件也不再建議執行 `wsl --shutdown`（#1853）。
