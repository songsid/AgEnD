---
type: synthesis
title: "AgEnD 版本更新總覽（v0.0.16 ~ v2.0.4）— 使用者版"
tags: [version, feature]
sources: [changelog-v2.0.2, changelog-v2.0.3, changelog-v2.0.4, dev-workflow]
created: 2026-06-22
updated: 2026-06-22
---

# AgEnD 版本更新總覽（使用者版）

從 v0.0.16 到 v2.0.4 的重點功能，以使用者視角呈現。

---

## v0.3.x — 協作與擴展基礎

- 你可以讓 agent 之間互相溝通了 — `send_to_instance`、`delegate_task` 等 MCP 工具讓 agent 自動分工
- 你可以用 `create_instance --branch` 為 feature branch 開一個獨立 agent
- Discord 可以用了（MVP） — 安裝 plugin 後 Discord 也能控制 fleet
- 每個 instance 可以設定花費上限 — 超過自動暫停，隔天恢復
- 語音訊息自動轉文字 — Telegram 語音自動透過 Groq Whisper 轉錄給 agent

## v1.8 ~ v1.9 — 智慧化運作

- Agent 工具不需要再手動填 chat_id — 系統自動帶入對話上下文
- 後端錯誤自動偵測 — rate limit、auth 失敗會自動通知你並嘗試切換 model
- Team 功能 — 可以把多個 instance 編成一組，一次廣播訊息給整個 team
- Workspace 目錄自動建立 — fleet.yaml 不需要寫 `working_directory`，自動產生

## v1.11 ~ v1.14 — 多後端 + Web UI + 安全強化

- 支援 5 種 CLI 後端 — Claude Code、Codex、Gemini CLI、OpenCode、Kiro CLI，同一個 fleet 可以混用
- Web UI 上線 — `agend web` 啟動瀏覽器儀表板，即時看狀態、聊天、管理 instance
- Fleet 模板 — `deploy_template` 一鍵部署預設 fleet 配置，適合重複場景
- 一行安裝 — `curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash`
- 36 項安全修復 — API 驗證、路徑防護、webhook 簽名、權限收緊

## v1.15 ~ v1.24 — 穩定性 + Discord 完善

- Crash recovery 更可靠 — 崩潰後先嘗試 `--resume` 恢復完整對話，失敗才注入快照
- Webhook 通知 — fleet 事件可以推到 Slack 或其他 endpoint
- 權限提示倒數 + 記住選擇 — 「Always Allow」讓你不用每次都點
- Discord attachment 下載正常運作
- `agend ls` 顯示 Kiro 的 context 使用率 + 系統記憶體

## v2.0.0 ~ v2.0.1 — 大版本重啟

- 版本號跳到 v2.0.0 — 建立新的 semantic versioning 基線
- Telegram Rich Messages — 表格、程式碼、標題自動用 Rich Message 顯示
- systemd 看門狗 — 50+ instance 不再開機超時被 kill
- `/update` + `/doctor` 指令 — 直接在聊天室更新 AgEnD 或檢查健康狀態
- 非阻塞啟動 — General 先啟動就回報 READY，其餘背景慢慢開

## v2.0.2 — Multi-Channel + 記憶體系

- 多平台同時運行 — TG + Discord 同時上線，各有自己的 General
- Bot-to-bot 通訊 — Rich Message 讓 bot 之間可以透過 @mention 溝通
- 記憶分層確立 — Decision（短規則）→ soul.md（完整記憶）→ Skill（工作流程）
- 文件完善 — configuration.md + commands.md 完整參考文件上線
- ClassicBot 修復 — 聊天記錄、錯誤通知、重複 General 問題一次解決

## v2.0.3 — 指令統一 + 預熱

- TG 和 Discord 指令統一 — /status、/sysinfo、/compact、/collab 兩邊都有
- Instance 預熱 — spawn 後自動載入 steering + skills，不用等第一則訊息
- `agend ls` 即時狀態 — 顯示 Idle/Busy/Crashed/Stopped
- /collab 模式 — 允許其他 bot 在 fleet topic 裡溝通（多 bot 協作）
- /update 聰明偵測 — 自動判斷你是 beta 還是 stable 用戶

## v2.0.4 — 小修復

- 音訊/影片附件正常下載 — 語音轉錄失敗時保留原始音檔，影片自動下載到 workspace
- Chat-log 用本地時區 — 不再顯示 UTC 時間（v2.0.5-beta.1）

---

*最後更新：2026-06-22。資料來源：docs/CHANGELOG.md + git history。*
