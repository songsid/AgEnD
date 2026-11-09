---
section: Fixed
---
- **貼上 Claude Code 的登入代碼不會再以「CLI exited, credentials unconfirmed」收場（#2599）。** AgEnD 過去在每個送給登入程式的代碼前面加上 Ctrl+U。Claude Code 2.1.319 以後以 raw 模式讀取提示，沒有任何東西會處理這個字元，伺服器收到的是前面多了這個位元組的代碼，因此拒絕。現在代碼照原樣送出（Kiro 預填的起始網址和區域仍然會加上它需要的 Ctrl+U）。Claude Code 2.1.319 拒絕代碼時的訊息是 `Login failed: That code wasn't accepted`，兩種說法現在都會被判定為代碼被拒絕。
