---
type: entity
title: "Config Validator"
tags: [feature, command]
sources: [v2.0.11-features]
source_version: v2.0.11
code_refs: ["src/config-validator.ts"]
created: 2026-07-05
updated: 2026-07-05
---

# Config Validator

## Overview

共用驗證模組，可從 CLI、MCP tool、Settings page 呼叫。

## 存取方式

| 方式 | 說明 |
|------|------|
| `agend validate` | CLI 指令 |
| `validate_config` | MCP tool（所有 instance 可呼叫） |
| Settings page | validate-before-write（自動） |

## 驗證項目

- Channel: id 格式、type 正確、token_env 存在
- Instance: channel_id 指向存在的 channel
- Backend: 已知值（claude-code, codex, kiro-cli, antigravity, opencode）
- General_topic: 存在性
- Access: 格式正確（allowed_users array）

## Normalize

- Singular `channel` → `channels` array（自動修正）

## Sources

- [[v2.0.11-features]]
