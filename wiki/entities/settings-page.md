---
type: entity
title: "Settings Page"
tags: [feature]
sources: [v2.0.11-features]
source_version: v2.0.11
code_refs: ["src/web-api.ts (/api/settings/*)", "src/config-validator.ts"]
created: 2026-07-05
updated: 2026-07-05
---

# Settings Page (/settings)

## Overview

結構化 Web UI 編輯 fleet.yaml + classicBot.yaml。與 /view（唯讀）和 /ui（instance 管理）分離。

## UI

- **Tabs**: Fleet / Instances / ClassicBot
- **左欄**: 表單（dropdown, chip list, table, inline edit）
- **右欄**: YAML/JSON 預覽（可直接編輯）
- **雙向同步**: form 改 → YAML 更新；YAML 改 → form 更新
- **Copy/Download**: 方便版控

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| /api/settings/fleet/* | GET/PUT/PATCH | Fleet config CRUD |
| /api/settings/classic/* | GET/PUT/POST/DELETE | ClassicBot config CRUD |
| /api/settings/reload | POST | Hot-reload config |

## 安全

- Auth: `web.token` required（/view 不需要，/settings 需要）
- Validate-before-write: 錯誤 → 400 擋住；warning → 允許寫入
- 白底配色（GitHub-style 淺色主題）

## Sources

- [[v2.0.11-features]]
