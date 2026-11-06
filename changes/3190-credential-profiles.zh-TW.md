---
section: Added
---
- **一台 Windows 電腦現在可以使用多個 Claude 帳號（具名 credential profile）。** 在已配對的電腦上，`agend-runtime login claude-code NAME` 會建立一個具名的 Claude Code 登入，`profile list`／`profile default`／`connect --credential-profile` 用來管理。之後 Agent（新增 Windows Agent，或「切換 Runtime／CLI」）可以用名稱選擇 **Claude 帳號**，設定 → Runtime 也會列出每台電腦的 profile 名稱與登入狀態。AgEnD 只會傳送名稱：由 Runtime 對應到自己 profile 底下的資料夾，登入資料不會離開那台電腦（不回報路徑、e-mail 或 token）。名稱不存在、尚未登入、格式不合法，或 Runtime 版本太舊時，會直接停止並說明原因，不會改用電腦本身的帳號。僅支援 Claude Code；Linux／WSL 的 Agent 維持既有的 `credential_profile`。變更 Agent 的帳號會開始新的對話。
