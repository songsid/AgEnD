---
section: Added
---
- **設定頁可以看出 Claude 登入的是哪一個帳號（遮罩 email 與方案）。** 在設定 → Runtime 的 Windows 電腦卡片與 Agent 的「Claude 帳號」選單中，每個 credential profile 與預設登入都會顯示成 `work · ab***@example.com · Team`；設定 → Agents →「CLI 登入」也會用同樣格式顯示 AgEnD 主機自己的 Claude Code 登入（預設與每個 `credential_profile`）。只保留 email 前兩個字元（只有一兩個字元時留一個），接著 `***`，再接完整網域，所以能分辨工作帳號與個人帳號；完整 email 不會離開保有該登入的電腦，也不會被記錄。Windows Runtime 只在按「重新偵測」（以及 `agend-runtime login` 之後）回報；AgEnD 只接受這個遮罩格式，其他一律拒絕；不認得這個欄位的舊版 Runtime 就只是不顯示。API key 登入會顯示為沒有帳號 email；不在 `free`、`pro`、`max`、`team`、`enterprise` 之內的方案顯示為「未知方案」。現在由同一個解析器讀取 `claude auth status`，登入檢查、主機列表與 Windows Runtime 共用。
