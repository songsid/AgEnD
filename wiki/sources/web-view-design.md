---
type: source
title: "Web View (/view) 設計"
tags: [architecture, feature]
version: "2.0.11"
raw: raw/web-view-design.md
created: 2026-07-04
updated: 2026-07-04
ingested: 2026-07-04
---

# Web View (/view) 設計

## Summary

唯讀 Web 介面，即時串流 tmux terminal 輸出到瀏覽器 + instance profile 管理。與 /ui（管理面板）分離。

## 架構

- **Terminal stream**: `tmux capture-pane -ep` 每 800ms 輪詢，前端 ANSI→HTML（支援 16/256/truecolor）
- **Profiles**: SQLite (`~/.agend/profiles.db`) — display_name, avatar, role, description
- **認證分離**: `view.token`（唯讀）vs `web.token`（讀寫），fleet start 時自動生成

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| /api/pane/:instance | GET | Terminal 輸出（capture-pane） |
| /api/profiles | GET | 所有 instance profiles |
| /api/profile/:instance | GET/PUT | 單一 profile CRUD |
| /api/avatar/:instance | GET/PUT | 頭像上傳/取得 |

## 安全

- `execFile` 不用 shell（防注入）
- Instance 白名單（只允許已知 instance）
- Avatar 限制：4MB，png/jpeg/gif/webp only

## Layout

- Sidebar: instance list + status dots（running/stopped/crashed）
- Main: terminal panel（ANSI rendered）
- Bottom: instance card + profile edit

## Related

- [[web-view]]
