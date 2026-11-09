---
section: Fixed
---
- **`/login` 不再把 `__proto__` 或 `constructor` 當成 backend（#3474）。** `/login` 後面輸入的字，只會在 AgEnD 自己的 backend 名稱與別名中查找。以前 `/login __proto__` 會對應到內建物件，並回覆「[object Object] has no credential profiles」；現在會得到一般的「沒有這個 backend」回覆，並列出輸入的字。
