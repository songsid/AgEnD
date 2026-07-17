---
type: entity
title: "Web View"
tags: [feature]
sources: [web-view-design]
source_version: v2.0.11
code_refs: ["src/web-api.ts", "src/fleet-manager.ts (health server)"]
created: 2026-07-04
updated: 2026-07-04
---

# Web View (/view)

## Overview

唯讀 Web 頁面，即時看 agent terminal 輸出 + 管理 instance profiles。與 /ui（完整管理面板）分離。

## 功能

- **Terminal stream** — 800ms 輪詢 `tmux capture-pane -ep`，ANSI→HTML（16/256/truecolor）
- **Instance profiles** — display_name, avatar, role, description（SQLite 存儲）
- **唯讀認證** — `view.token` 獨立於 `web.token`

## 認證模型

| Token | 用途 | 權限 |
|-------|------|------|
| (none) | /view GET routes | 唯讀（看 terminal + profiles）— **open access** |
| web.token | /view POST + /settings + /ui | 讀寫（edit profiles, manage config） |

Fleet start 時自動生成 web.token。GET routes 不需任何 token。

## 額外功能（v2.0.11）

- **Sidebar drag-sort** — 拖拉排序 instance 順序（SQLite 持久化）
- **Group by tag** — collapsible tag groups in sidebar
- **`agend view` CLI** — 開啟唯讀 View dashboard
- **ClassicBot instances** — 也顯示在 roster 中
- **Non-ASCII names** — 支援中文等 instance 名稱
- **ctx% 隱藏** — ctx = 0 或 null 時不顯示（避免誤導）
- **Avatar 修正** — DB 存 filename（不存絕對路徑）、無 avatar 顯示首字母 placeholder

## API

- `GET /api/pane/:instance` — terminal capture
- `GET /api/profiles` — all profiles
- `GET/PUT /api/profile/:instance` — single profile
- `GET/PUT /api/avatar/:instance` — avatar（4MB limit, png/jpeg/gif/webp）

## Sources

- [[web-view-design]]
