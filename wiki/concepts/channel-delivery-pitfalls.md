---
type: concept
title: "Channel/Delivery 開發陷阱"
tags: [architecture, backend, telegram, discord]
sources: [channel-delivery-backend-knowledge]
source_version: v2.0.7
code_refs: ["src/fleet-manager.ts (兩個 on('slash_command'))", "src/fleet-manager.ts reactTarget", "src/fleet-manager.ts handleClassicChannelMessage", "src/daemon.ts deliverMessage / pasteLock", "src/daemon.ts health-check loop / sendEscape", "src/tmux-manager.ts getPaneStatus", "src/topic-commands.ts parseContextPercent", "src/backend/types.ts isModelCompatible", "src/channel/adapters/discord.ts"]
created: 2026-06-27
updated: 2026-06-27
---

# Channel/Delivery 開發陷阱

反覆踩到的坑，改 code 前必看。

## 1. 兩個 slash_command handler

fleet-manager.ts 有 **兩份** slash handler：
- Primary adapter: `this.adapter.on("slash_command")`
- Secondary adapter: `startAdditionalAdapter` 裡的 `adapter.on(...)`

**改任何 slash command 行為必須兩邊都改。** 曾因只改 primary → DC（secondary）壞掉。

## 2. react 目標依平台不同

- TG: reaction 綁 supergroup `chat_id`（不是 threadId）
- DC: reaction 綁 channel/thread id

用 `reactTarget(msg)`：telegram → chatId、其餘 → threadId ?? chatId

## 3. 五個 delivery 出口（無統一入口）

| 出口 | 位置 |
|------|------|
| General topic | fleet-manager |
| Fleet topic | fleet-manager |
| Classic forward | forwardToClassicInstance |
| Cross-instance | outbound-handlers sendToInstance |
| Schedule | handleScheduleTrigger |

**橫切功能（cancel button、auto-pause/wake、image_path 注入）每個出口都要各自 hook。** 長遠：抽 `deliverToInstance()` facade。

## 4. deliverMessage 吞掉結果

- 回 void；pasteLock 無條件 emit `message_delivered`（即使 paste 失敗）
- Channel 層誤判送達（清 ⏳、react ✅）
- 正解：回 boolean，分 `message_delivered` / `message_failed`

## 5. /ctx context% 取得

- claude-code：讀 `statusline.json`（有 used_percentage）
- kiro-cli：**不寫** statusline → tmux pane regex 由下往上掃 `(\d+)%\s*[!❯>]` 等 pattern，需 `-S -60` scrollback

## 6. 中斷鍵 per-backend

| Backend | 中斷鍵 | tmux send-keys |
|---------|--------|---------------|
| kiro-cli | Ctrl+C | `C-c` |
| claude-code, codex | Escape | `Escape` |

## 7. Backend 差異速查

| | claude-code | kiro-cli |
|---|---|---|
| statusline.json | ✅ | ❌ |
| resume | `--continue`（最新 session） | `--resume`（boolean，依 cwd）|
| session 儲存 | `~/.claude/projects/<path>/*.jsonl` | `~/.kiro/sessions/cli/<uuid>.json` |
| 中斷 | Escape | Ctrl+C |
| MCP 啟動 | — | `--require-mcp-startup` |

## 8. Classic collab 附件

未 @mention 的圖存 inbox 但只記 `[📷 saved:/path]` 在 chat-log（不進 `meta.image_path`）→ agent 讀不到。需 parse context 注入。Fleet topic 無此問題（每則跑 processAttachments）。

## 9. Health-check 偽 crash

`getPaneStatus()` 任何 tmux 例外回 null → health-check 當 crash → restart 風暴。指紋：exitCode undefined + lastOutput 空。修法：null 延遲 1.5s 重查。

## 10. Discord 已併入 core

從獨立 plugin 併入 `src/channel/adapters/discord.ts`。factory 加 built-in 分支（排在 plugin loader 前）。Plugin loader 保留給社群 adapter。

## Sources

- [[channel-delivery-backend-knowledge]]
- [[classic-reply-routing]]
- [[model-validation]]
