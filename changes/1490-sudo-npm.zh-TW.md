---
section: Fixed
---
- **`retireSystemCopy`：使用安裝時相同的 npm，而非重新查詢 PATH。** npm 二進位路徑在 `runUpdateInstall` 中解析一次（nvm 安裝時取自 `nvmBin`，系統安裝時透過 `command -v npm`），存入安裝結果並傳給 `retireSystemCopy`。這確保安裝與清理的一致性——nvm 安裝使用 nvm 的 npm，而非父行程 PATH 中的 npm。函式現在回傳 `{ ok: boolean }`，讓呼叫端能感知清理失敗。缺少路徑或非絕對路徑為明確失敗，不再靜默略過。(#1490 P3)
