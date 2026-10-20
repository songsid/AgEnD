---
section: Fixed
---
- **Antigravity（agy）用量列會把 Gemini 4 Argon 的額度和 Gemini 分開（#2240）。** 付費 Pro 方案的 Argon 有獨立額度。AgEnD 以前會把名稱含「Gemini」的都併進同一行 Gemini，Argon 的上限會被其他 Gemini 模型蓋過去。現在：
  - agy 的額度摘要回報 Argon 群組時，它會有自己的一行「Gemini 4 Argon (weekly)」，附上自己的百分比與重置時間；
  - 只有 Argon 的各個模型回報額度時，這一行是「Gemini 4 Argon」，顯示用得最多的 Argon 模型（不推定週期）。

  AgEnD 能呼叫的額度查詢，在目前測試過的帳號上都還沒有回傳 Argon，所以這是為回傳時預先做好的支援，而不是已經顯示的數字。這一列也改成像 agy 一樣，以目前版本的 Antigravity 用戶端身分向 Google 額度伺服器查詢，所以付費方案的 Gemini 那一行會顯示方案本身的五小時與每週上限（和 agy 一致），而不是最忙的單一模型或免費層的數字。
