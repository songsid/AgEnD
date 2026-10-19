---
section: Fixed
---
- **用量：Antigravity（agy）那一列重新顯示 Gemini 額度（#2174）。** agy 的額度摘要現在只列出「Claude and GPT models」一組，所以那一列只剩 Claude 與其他模型。每個模型其實仍各有自己的額度，因此 AgEnD 現在也會讀取模型清單，補上摘要漏掉的額度池：Gemini 以用量最高的模型計算，並附上重置時間。AgEnD 不認得的供應商或 id，會用它自己的名稱單獨列出，不再算進 Claude 與其他模型。
