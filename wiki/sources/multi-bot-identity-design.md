---
type: source
title: "Multi-Bot Identity + 同 Channel 多 Agent"
tags: [architecture, discord]
version: "2.1.0"
raw: raw/multi-bot-identity-design.md
created: 2026-06-29
updated: 2026-06-29
ingested: 2026-06-29
---

# Multi-Bot Identity + 同 Channel 多 Agent

## Summary

v2.1.0 planned feature. 同一 Discord channel 多隻 bot，按 @mention 路由到不同 agent instance。需路由重構（1:1 → 1:N）。

## 方案 B: per-channel bot_token

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

## 進階: 同 Channel 多 Agent

- 一個 channel 對應多個 instance
- 路由按 @哪隻 bot 判定 target
- 每個 instance 綁定自己的 bot client 回覆
- Collab 自然成立（bot 間互相 @mention）

## 架構改動

- 多 bot token → 多 WebSocket connection
- `routing.resolve` 回多個 target（1:N）
- 回覆時選正確的 bot client
- 用戶需建多個 Discord bot application

## 改動量

| 階段 | 估計 |
|------|------|
| Per-channel bot_token | ~150 行 |
| 同 channel 多 agent | ~300+ 行（路由重構） |

## 時程

v2.1.0 scope，尚未實作。

## Related

- [[multi-channel-architecture]]
- [[roadmap]]
