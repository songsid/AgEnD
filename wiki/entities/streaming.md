---
type: entity
title: "Streaming"
tags: [feature, telegram, discord]
sources: [streaming-cancel-design]
created: 2026-06-20
updated: 2026-06-20
---

# Streaming

## Overview

即時顯示 agent 回覆內容，v2.1.0 planned feature。TG 和 DC 用不同實作但統一 UX。

## TG 實作

- Bot API 10.1 `sendRichMessageDraft` 原生 streaming
- TG server 處理 token-by-token 更新
- AgEnD pipe output → Rich Message API
- 零 rate limit 問題（TG server 端處理）

## DC 實作

- tmux pane output poll（每 2-3s）
- capture last 10 lines → `editMessage`
- Rate limit: ~5 edits/5s per channel（2s interval 安全）
- Placeholder + Cancel button → streaming → final edit

## Cancel 機制

- 共用: tmux send-keys Escape
- TG: inline keyboard [🛑 取消] 或 /cancel
- DC: button component 或 /cancel slash command
- 同 /compact 機制

## 三態 Status

- 🤔 Thinking — 訊息已送入 tmux
- 🔵 Streaming — tmux 有 output
- 🟢 Idle — tmux 靜默 2s

fleet-manager Map 追蹤，零效能開銷。

## 設計取捨

AgEnD 用 tmux PTY poll 而非 ACP JSON-RPC stream（如 OpenAB），因為:
- 保持 backend-agnostic（不需改任何 CLI backend）
- 精確度略低但 UX 足夠好
- 實作簡單（已有 tmux capture 基礎設施）

## Sources

- [[streaming-cancel-design]]
