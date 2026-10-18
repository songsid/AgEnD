---
section: Fixed
---
- **Codex instance 也能使用 `set_web_ambient`（#2155）。** 它的 `duration`、`size`、`spread`、`opacity` 範圍原本用一種 JSON Schema 寫法（`prefixItems`）宣告，Codex 會把它轉成字串清單，照宣告呼叫就一律被拒。現在改成一般的數字陣列；以十進位字串送來的範圍（`["3", "6"]`）也會當成數字接受。新增的測試會確保所有工具的 schema 都維持在各家 MCP client 都會以相同方式解讀的寫法。
