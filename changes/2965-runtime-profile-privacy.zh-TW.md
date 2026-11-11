---
section: Security
---
- Windows Runtime 在讀取狀態前檢查自訂與預設 profile 的權限。新目錄在建立時即為私有；共用、可被其他帳號替換或無法確認權限的現有路徑會被拒絕，不會改寫既有 ACL 或無關檔案。很大的 profile 可能超過檢查上限，請選擇私有專用目錄。
