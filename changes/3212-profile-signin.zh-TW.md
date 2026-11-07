---
section: Added
---
- **Codex 與 Kiro 帳號可以在聊天和網頁 dashboard 登入。** 具名的 Codex 或 Kiro 帳號（憑證設定檔）現在可以和 Claude Code 一樣登入：在聊天用 `/login codex <profile>` 或 `/login kiro-cli <profile>`，或在 **設定 → Agents → 帳號** 該列按 **登入**，包括 **＋ 新增帳號** 之後。Codex 會用裝置代碼登入到該 profile 自己的資料夾（`CODEX_HOME`），Kiro 會用該 profile 的存放位置（`XDG_DATA_HOME`）開啟登入選單。以前這些帳號只能在主機上執行指令登入。
