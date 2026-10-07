---
section: Security
---
- **網頁面板上只會執行頁面自己的 inline script（#1268）。** `script-src` 不再允許 `'unsafe-inline'`：每個面板自己的 script 會帶一個每次回應都不同的 nonce，dashboard 的按鈕也不再使用 `onclick=` 屬性（改由一個 listener 執行 `data-act` 指定、而且在固定清單裡的動作）。被注入到頁面的標記（例如 `onerror=` 或 `<script>`）不會再執行。
