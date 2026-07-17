---
type: concept
title: "Multi-Bot Persona"
tags: [architecture, discord]
sources: [multi-bot-identity-design, multi-bot-persona-ux]
source_version: v2.0.11
code_refs: ["src/channel/adapters/discord.ts", "src/fleet-manager.ts (handleClassicStart, adapterId binding)", "src/quickstart.ts"]
created: 2026-06-29
updated: 2026-07-04
---

# Multi-Bot Persona

## 目標

同一 Discord guild 內多隻 bot（不同名字/頭像），各自對應不同 agent instance。用戶 @不同 bot 觸發不同 agent。

## Config Schema（per-channel bot_token）

```yaml
classicBot.yaml:
  channels:
    "1234567890":
      name: dev-agent
      bot_token_env: DISCORD_BOT_DEV
    "9876543210":
      name: qa-agent
      bot_token_env: DISCORD_BOT_QA
```

## 路由

- @mention 路由：按 @哪隻 bot 判定 target
- routing.resolve 從 1:1 改成 1:N
- 每個 instance 綁定自己的 bot client 回覆
- Collab 自然成立（互相看到訊息 → @對方觸發）

## Quickstart UX

- 第一層加 "ClassicBot Persona" 選項
- 流程：persona name → bot token → backend → working dir → channels
- 完成後產生 invite link

## Slash Commands

分 token 模式下，每隻 bot 各自註冊 slash command（/compact /ctx /save）。不需 target 參數（一隻 bot = 一個 instance）。

## v2.0.11 ClassicBot 實作

### 核心機制

- 所有 adapter 註冊 slash commands（移除 `registerCommands=false`）
- Persona bot 可在同 guild `/start` 獨立 classic instance
- `handleClassicStart` 記錄 `adapterId` → authoritative binding → reply/cancel 走正確 bot

### Binding 規則

- Classic instance 綁定 adapterId（啟動時記錄）
- 已綁定的 instance 不被 inbound 覆寫（防 dedup winner 錯綁）
- Restart 自癒：沒綁定時 inbound 允許重建
- Restart rebind from persisted adapterId

### Same-Channel Multi-Bot（v2.0.11）

- 同一 DC channel 多 bot 各自 /start 獨立 instance
- ClassicChannelManager composite key: `channelId#adapterId`
- Classic 路由移出 RoutingEngine → `manager.getInstanceByChannel`
- Owner-wins dedup: per-adapter key for classic, global for fleet topic
- 自動 migration: 舊 classicBot.yaml → 新格式（single-bot 命名不變）
- Instance naming: primary 不加 suffix，secondary 加 `-adapterId`

### Auto-General

- `needsGeneral` 只為 primary adapter 建/認領 general
- Secondary adapter 不搶 general

### Dedup 行為

- Classic slash（/start /chat /stop）= per-application → 只有被呼叫的 bot 收到（無 dedup 問題）
- @mention = routing resolve 同一 target = dedup first-wins 正確
- Collab auto-enable 保留

### Guard

- 已有綁定的 classic instance 不被 inbound 覆寫
- 防止 dedup winner 錯綁到非 authoritative adapter

## v2.1 待做

- #8 classic→adapter 持久化（ClassicChannel record 加 adapterId 欄位）
- #2 isAdmin per-adapter（每隻 bot 各自的 admin 判斷）
- Fleet topic @mention dedup owner-wins

## 架構改動

- 多 bot token → 多 WebSocket connection
- 所有 adapter 註冊 slash commands
- 回覆時用 authoritative adapter（adapterId binding）
- 用戶需建多個 Discord bot application

## 時程

- v2.0.11: ClassicBot multi-bot（已實作 ✅）
- v2.1.0: 持久化 + per-adapter admin + fleet topic dedup

## Sources

- [[multi-bot-identity-design]]
- [[multi-bot-persona-ux]]
