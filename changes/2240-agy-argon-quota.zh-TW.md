---
section: Fixed
---
- **Antigravity（agy）用量列會把 Gemini 4 Argon 的額度和 Gemini 分開（#2240）。** 付費 Pro 方案的 Argon 有獨立額度。AgEnD 以前會把名稱含「Gemini」的都併進同一行 Gemini，Argon 的上限會被其他 Gemini 模型蓋過去。現在：
  - agy 的額度摘要回報 Argon 群組時，它會有自己的一行「Gemini 4 Argon (weekly)」，附上自己的百分比與重置時間；
  - 只有 Argon 的各個模型回報額度時，這一行是「Gemini 4 Argon」，顯示用得最多的 Argon 模型（不推定週期）。

  這一列向 Google 額度伺服器查詢時，用的身分和 agy 自己的 CLI 完全相同（agy 1.4.3 送出的用戶端名稱與版本），所以付費方案會顯示和 agy 的 `/quota` 一樣的內容：Gemini 那一行是方案本身的五小時與每週上限（不是最忙的單一模型或免費層的數字），Gemini 4 Argon 的每週上限則是獨立的一行。
