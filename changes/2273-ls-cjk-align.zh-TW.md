---
section: Fixed
---
- **`agend ls` 的欄位在名稱包含 CJK、表情符號或拉丁延伸字元時，現在能正確對齊（#2273）。** 名稱欄原本使用 JS 字串長度（code unit）來補齊空白，導致每個佔 2 個終端機欄位的 CJK 與表情符號字元，會把後方所有欄位往右推。現在所有欄寬計算與補白均改用支援 Unicode EAW 的 `displayWidth` 函式：全形（Wide/Fullwidth）字元算 2 欄，半形（Narrow/Neutral）字元（包括 é、č 等重音拉丁字母）算 1 欄。`agend attach` 的互動選單與歧義清單也套用了相同修正。
