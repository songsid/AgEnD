---
section: Fixed
---
- **`retireSystemCopy`：nvm 安裝時所有 npm 操作改用 `join(nvmBin, "npm")`。** npm 二進位路徑固定為 `join(plan.nvmBin, "npm")`——與 `inInstallEnv` 透過修改 PATH 後實際呼叫的 npm 相同。此路徑用於 prefix 鎖定、rollback root、install、verification 和 retirement，確保 `outcome.npmPath` 與實際執行的二進位一致。`retireSystemCopy` 接受明確路徑並回傳 `{ ok: boolean }`；呼叫端在失敗時設定 `process.exitCode = 1`。非 nvm 安裝不需要 retirement，也不進行任何查詢。(#1490 P3)
