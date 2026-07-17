---
type: source
title: "Multi-Bot Persona — Quickstart UX + Slash Commands"
tags: [architecture, discord]
version: "2.1.0"
raw: raw/multi-bot-persona-ux.md
created: 2026-06-29
updated: 2026-06-29
ingested: 2026-06-29
---

# Multi-Bot Persona — Quickstart UX + Slash Commands

## Summary

追加 multi-bot 設計：quickstart 加入 persona 建立流程 + 每隻 bot 各自註冊 slash commands。

## Quickstart UX

- Quickstart 第一層加 "ClassicBot Persona" 選項
- 流程：persona name → bot token → backend → working dir → channels
- 完成後產生 invite link

## Slash Commands（分 token 模式）

- 每隻 bot 各自註冊自己的 slash command（/compact /ctx /save）
- 不需要 target 參數（每隻 bot = 一個 instance，無歧義）

## Related

- [[multi-bot-identity-design]]
- [[multi-bot-persona]]
