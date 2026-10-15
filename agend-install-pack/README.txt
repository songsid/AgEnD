═══════════════════════════════════════════════════════════════
  AgEnD 安裝包 — Telegram AI Agent 艦隊管理工具
═══════════════════════════════════════════════════════════════

本資料夾包含 AgEnD 的完整安裝程式。
安裝完成後，你可以從 Telegram 手機端操控 AI coding agent。

───────────────────────────────────────────────────────────────
  檔案說明
───────────────────────────────────────────────────────────────

  install.sh             主安裝腳本（macOS / Linux / WSL）
  install-macos.command  macOS 雙擊安裝入口
  install-agend.bat      Windows 安裝入口（透過 WSL 執行）
  AGEND_SETUP_PROMPT.md  Kiro IDE 聊天引導安裝提示詞（備用）
  README.txt             你在看的這個檔案

───────────────────────────────────────────────────────────────
  安裝方式（選一種）
───────────────────────────────────────────────────────────────

  【方式 A】macOS 用戶
    雙擊 install-macos.command
    → 終端機會自動開啟並執行安裝

  【方式 B】Linux 用戶
    打開終端機，cd 到這個資料夾，執行：
    bash install.sh

  【方式 C】Windows 用戶
    雙擊 install-agend.bat
    → 會自動透過 WSL 執行安裝
    → 前提：你的 Windows 已經安裝了 WSL
      (如果沒有，用管理員 PowerShell 執行: wsl --install)

  【方式 D】IDE 引導安裝（適合所有平台）
    1. 用 Kiro IDE 開啟你的工作資料夾
    2. 打開 AGEND_SETUP_PROMPT.md
    3. 全選複製 → 貼到 Kiro IDE 聊天框
    4. AI 會逐步帶你完成安裝

───────────────────────────────────────────────────────────────
  安裝前你需要準備
───────────────────────────────────────────────────────────────

  1. Kiro IDE 已安裝（https://kiro.dev）+ AWS Builder ID 已登入
  2. Telegram Bot Token
     → 在 Telegram 搜尋 @BotFather → /newbot → 拿到 Token
  3. Telegram Forum 群組 ID
     → 建立群組 → 開啟 Topics → 加 @RawDataBot → 拿到 Group ID
  4. 你的 Telegram User ID
     → 搜尋 @userinfobot → 傳訊息 → 拿到 ID

───────────────────────────────────────────────────────────────
  安裝完成後
───────────────────────────────────────────────────────────────

  • Telegram 群組裡會出現 Agent Topic，直接打字就能跟 AI 對話
  • 開機自動啟動（agend service install 設定後）
  • 從手機就能操控，不用開電腦

  常用指令：
    agend fleet start     啟動艦隊
    agend ls              查看狀態
    agend logs            查看日誌
    agend fleet stop      停止艦隊
    agend fleet restart   重啟艦隊
    agend service install 設為開機自動啟動

───────────────────────────────────────────────────────────────
  系統需求
───────────────────────────────────────────────────────────────

  • macOS 或 Linux（Windows 需要 WSL）
  • 網路連線（安裝時需要下載 Node.js / npm 套件）
  • 至少一個 AI CLI 後端：kiro-cli / claude / codex / gemini

───────────────────────────────────────────────────────────────
  遇到問題？
───────────────────────────────────────────────────────────────

  1. 用方式 D（IDE 引導安裝）— AI 會幫你排錯
  2. 查看日誌：agend logs 或 cat ~/.agend/daemon.log
  3. 找管理員協助
