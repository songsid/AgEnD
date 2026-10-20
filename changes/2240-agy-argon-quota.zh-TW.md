---
section: Fixed
---
- **Antigravity（agy）用量列會把 Gemini 4 Argon 的額度獨立成一行（#2240）。** 付費 Pro 方案的 Argon 有獨立額度。AgEnD 以前會把名稱含「Gemini」的都併進同一行 Gemini，Argon 的上限會被其他 Gemini 模型蓋過去。現在不論 agy 以群組或逐模型回報，它都會有自己的一行「Gemini 4 Argon (weekly)」，附上自己的百分比與重置時間。這一列也改成先讀 Google 主要的額度伺服器，所以 Gemini 那一行會顯示真正的五小時與每週上限，而不是最忙的單一模型。
