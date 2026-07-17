---
type: concept
title: "Classic Reply Routing"
tags: [architecture, telegram, discord]
sources: [changelog-v2.0.5]
created: 2026-06-25
updated: 2026-06-25
---

# Classic Reply Routing

## 問題

fleet-manager 的 `handleOutboundFromInstance` 是 TG + DC 共用層。Classic instance 回覆時，daemon 填入的 chat_id/thread_id 可能不適合目標平台。

## 路由機制

1. Daemon 填入：`chat_id = lastChatId`（可能是 guild_id）、`thread_id = lastThreadId`（channelId）
2. Fleet-manager 修正：強制覆寫 `args.chat_id = classicChannelId` + `delete args.thread_id`

## 平台差異

| Platform | chat_id | thread_id | 說明 |
|----------|---------|-----------|------|
| TG | 目標 chat ID | 無 | 直接用 chatId 發送 |
| DC | channel_id | 無 | adapter 用 `opts?.threadId ?? chatId` 取 channel |

## 教訓

- 修 TG 會影響 DC（共用層）— 需兩邊都驗證
- Classic reply 必須在 fleet-manager 層覆寫 chat_id（不能信任 daemon 填的）
- DC adapter 的 channel 選擇邏輯：`threadId` 優先，fallback 到 `chatId`

## Sources

- [[changelog-v2.0.5]]
