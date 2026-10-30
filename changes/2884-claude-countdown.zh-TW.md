---
section: Fixed
---
- Claude Code 2.1.314 改了權限提示上的倒數文字（「…will automatically block this request in…」）。AgEnD 判斷是不是同一個提示時，又會忽略這一行會跳動的倒數，所以回答危險指令提示、等待中的提示都和 2.1.312 一樣運作。
