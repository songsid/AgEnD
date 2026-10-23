---
section: Changed
---
- **透過臨時公開連結和手機也能用搜尋（#2478）。** 全域搜尋（Ctrl+K）現在 fleet 管理員透過臨時公開連結也能用，所以用 `/web` 登入的手機，選單裡會有**搜尋**，也有 🔍 按鈕。訪客仍然一律不能用。`web.search.public_link: false` 可只在公開連結上關閉，`web.search.enabled: false` 照舊全部關閉。在觸控螢幕上，搜尋列不再顯示 Ctrl K 的提示。
