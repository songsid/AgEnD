---
type: source
title: "Model 驗證機制發現"
tags: [architecture, backend]
version: "2.0.8"
raw: raw/model-validation-discovery.md
created: 2026-06-26
updated: 2026-06-26
ingested: 2026-06-26
---

# Model 驗證機制發現（2026-06-26）

## Summary

`isModelCompatible` regex 白名單機制的缺陷：新 model 名靜默被忽略。各 CLI 的 dry-run 驗證能力調查 + v2.0.8 修復方案。

## 問題

- `isModelCompatible` 用 regex 白名單驗證 model 名稱
- 不 match → 靜默略過（不帶 `--model` flag）
- 結果：CLI 用 default model，用戶不知道指定的 model 沒生效

## 各 CLI 驗證能力

| Backend | 非互動驗證 | Output |
|---------|-----------|--------|
| kiro-cli | `--model X --no-interactive "test"` | "does not exist" + available list |
| claude-code | `--model X --print "test"` | "not exist or no access" |
| codex | `codex exec --model X "test"` | "not supported" |
| agy | ❌ 無非互動模式 | — |

## Available models (kiro-cli, 2026-06-26)

auto, claude-opus-4.6, claude-sonnet-4.6, claude-opus-4.5, claude-sonnet-4.5, claude-sonnet-4, claude-haiku-4.5, deepseek-3.2, minimax-m2.5, minimax-m2.1, glm-5, qwen3-coder-next

## 修復方案

- **v2.0.8 方案 A（止血）**: 移除靜默略過，改 pass-through + warning log
- **未來方案 B/D**: MCP tool `check_model`，kiro-cli parse available list，其他 backend advisory

## Related

- [[model-validation]]
