---
type: source
title: "Channel/Delivery/Backend 工程知識"
tags: [architecture, backend, telegram, discord]
raw: raw/channel-delivery-backend-knowledge.md
created: 2026-06-27
updated: 2026-06-27
ingested: 2026-06-27
---

# Channel/Delivery/Backend 工程知識

## Summary

agend-dev2 累積的非顯而易見坑點（12 項），涵蓋 slash handler 重複、delivery 出口散落、backend 差異、health-check 誤判等反覆踩到的問題。

## Key insights

1. 兩份 slash_command handler（primary + secondary adapter）— 改一邊另一邊會壞
2. 5 個 delivery 出口沒有統一 facade — 橫切功能極易漏
3. deliverMessage 回 void 且無條件 emit delivered — 已知 bug 方向
4. kiro-cli 不寫 statusline.json — /ctx 靠 tmux pane regex
5. 中斷鍵不同：kiro Ctrl+C、claude/codex Escape
6. health-check null = 誤判 crash → 需延遲重查

## Related

- [[channel-delivery-pitfalls]]
- [[model-validation]]
- [[classic-reply-routing]]
