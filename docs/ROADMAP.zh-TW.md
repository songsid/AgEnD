# AgEnD 發展藍圖

> 最後更新：2026-10-07（2.2 主線）
> 短小、面向使用者：已上線什麼、接下來是什麼。

## 已上線 (v1.x)

v1.12 之前的一切：多家 coding CLI 後端、Telegram + Discord 頻道、fleet
編排（含排程與成本防護）、ClassicBot 頻道、即時監控的 web 儀表板、
quickstart、Mirror Topic、完整繁體中文文件。細節見 CHANGELOG 各版本段落。

## 已上線 (2.0.x–2.1.x)

- 2.0.x：取消／投遞狀態 UX、Discord adapter 併入核心、`/save`、
  `/dashboard`、`/settings`、Web View 改版、同頻道多 bot ClassicBot、
  quickstart 系統服務安裝。
- 2.1.0–2.1.3：`/model`、自動暫停／喚醒 + warm cap、Grok 後端、單次排程、
  Settings 頁、`/usage`、`/effort`、即時進度、MCP 自動重啟。
- 2.1.4：`/login`、`/install-cli`、`/clear`、`/steer`、`/btw`、`/tips`、
  Codex 自訂 provider、完整繁中介面。
- 2.1.5–2.1.9：fail-closed 強化、工具預設組合、Codex 續接流程、投遞狀態
  emoji 設定、session 鎖定畫面、delivery worker。
- 2.1.10：一鍵公開 `/login` 連結（AgEnD 自己抓 cloudflared）、
  `/install-cli` 併入 `/login`、登入強化、暫停 instance 自動喚醒、kiro
  engine 釘選。
- 2.1.11：Codex capacity 改用 keep-going nudge、更新頻道釘選、cancel 同時
  停止回覆補救、重啟不再重送、capacity／卡住偵測修正、Discord slash 表格
  與授權門。
- 2.1.12（beta 中）：kiro 2.28 Classic 提示處理、bot 對 bot 可見度設定、
  移除 gemini-cli、macOS 記憶體警報關閉、alpha 發布頻道、反應擁有權修正、
  文件大整理。短的唯一 instance 名稱預計進 2.1.12，待審閱合併。

## 接下來：2.2.0 — web 主線

儀表板成為與 fleet 對話的第一等公民：

- 一次性 code 登入，session 可撤銷。
- 聊天優先 UI：輸入框置中、Markdown、上傳檔案、投遞 tick、Stop。
- 健康 prompt 在 Telegram 與 web 雙向鏡像、只回答一次。
- Echo 同步：web 打的字出現在 instance 的頻道 topic（fleet topic 預設開，
  ClassicBot 逐頻道 opt-in——見
  `docs/design/1320-classicbot-web-echo.md`）。

## 2.2.1 — 聊天深度（規劃方向，可能變動）

- 行內 HTML 預覽。
- 可留存、可搜尋的每 instance 聊天紀錄。
- 步驟清單：agent 正在做什麼，一步一步列出來。

## 2.2.2 — 審閱流程（規劃方向，可能變動）

- Diff 檢視與審閱留言。
- 任務看板。
- 時間線與匯出。

## 2.2.3 — 程式碼流程（規劃方向，可能變動）

- 每任務 worktree。
- PR 流程：從任務直達 pull request。

## 更遠的事

Slack 頻道、plugin 系統、多機器 fleet——可能性依此排序。不排日期，
先把 web 主線送出來。

---

> **AgEnD 不是另一個 coding agent。它是讓 coding agent 團隊協作的營運層。**
