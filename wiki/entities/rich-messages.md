---
type: entity
title: "Rich Messages"
tags: [feature, telegram]
sources: [changelog-v2.0.2]
created: 2026-06-20
updated: 2026-06-20
---

# Rich Messages (Telegram)

## Overview

Telegram Bot API 10.1 Rich Message support via grammy 1.44.0. Added in v2.0.1, enhanced in v2.0.2.

## Send (v2.0.1)

- Auto-detects markdown content (tables, code blocks, headings)
- `needsRichMessage()` → `sendRichMessage()` with fallback to `sendText()`
- `/status` and `/sysinfo` use markdown tables rendered via Rich Message

## Receive (v2.0.2)

- grammy middleware intercepts incoming Rich Messages
- Extracts text content for bot-to-bot @mention communication
- Enables multi-bot fleet communication via Rich Message format

## Sources

- [[changelog-v2.0.2]]
