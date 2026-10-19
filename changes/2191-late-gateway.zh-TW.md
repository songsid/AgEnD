---
section: Fixed
---
- **阻止退役 Discord Client 再次建連（#2191）。** 延遲抵達的 gateway 回應不會在退役後建立新 socket，避免其原生重連流程移除錯誤監聽後，握手錯誤導致 fleet 停止。
