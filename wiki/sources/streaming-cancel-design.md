---
type: source
title: "v2.1.0 Streaming + Cancel 設計"
tags: [architecture, feature, telegram, discord]
version: "2.1.0"
raw: raw/streaming-cancel-design.md
created: 2026-06-20
updated: 2026-06-20
ingested: 2026-06-20
---

# v2.1.0 Streaming + Cancel 設計

## Summary

v2.1.0 加入即時 streaming 顯示和 cancel 機制。TG 用原生 Rich Message Draft API，DC 用 tmux poll + editMessage。兩平台共用 /cancel（送 Escape 到 tmux）。

## TG Streaming

- 使用 Bot API 10.1 `sendRichMessageDraft` 原生 streaming
- TG server 負責 token-by-token 更新（AgEnD 不需自己 poll）
- AgEnD 只需把 output pipe 到 Rich Message API
- Cancel: inline keyboard button [🛑 取消] → tmux send-keys Escape

## DC Streaming

- AgEnD 自己 poll tmux pane output → Discord `editMessage` 更新
- 每 2-3s capture last 10 lines → edit message
- Rate limit 安全邊界: DC editMessage ~5次/5s per channel（用 2s interval）
- 流程: placeholder「🤔 Thinking...」+ [🛑 Cancel] button → streaming edits → final edit 完整回覆 + 移除 button
- Cancel: Discord button component interaction → tmux send-keys Escape

## 三態 Status

| State | Trigger | Display |
|-------|---------|---------|
| Thinking | Paste 訊息到 tmux | 🤔 |
| Streaming | tmux 開始有 output | 🔵 |
| Idle | tmux 靜默 2s | 🟢 |

實作: fleet-manager 內部 Map 追蹤狀態（零效能開銷）

## /cancel command

- TG + DC 共用邏輯
- 機制: tmux send-keys Escape（同 /compact）
- TG: inline keyboard button 或 /cancel 命令
- DC: button component interaction 或 slash command

## 參考: OpenAB

- OpenAB 用 ACP JSON-RPC stream event（精確 token stream）
- AgEnD 用 tmux PTY output poll（近似但不需改 backend CLI — backend agnostic）
- 取捨: 精確度略低，但保持 backend-agnostic 架構

## Related

- [[streaming]]
- [[fleet-commands]]
- [[roadmap]]
