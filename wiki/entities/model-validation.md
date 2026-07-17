---
type: entity
title: "Model Validation"
tags: [feature, backend]
sources: [model-validation-discovery]
source_version: v2.0.7
code_refs: ["src/backend/"]
created: 2026-06-26
updated: 2026-06-26
---

# Model Validation

## 現狀（v2.0.7）

`isModelCompatible(model, backend)` 用 regex 白名單判斷 model 名是否屬於該 backend。不 match 時靜默略過（不帶 `--model`），CLI 使用 default model。

問題：新 model 名（如 `fable`）不在白名單 → 靜默忽略 → 用戶不知道。

## 修復（v2.0.8 planned）

移除靜默略過，改為 pass-through + warning：
- 所有 model 名直接傳給 CLI（不再過濾）
- 不認識的 model 名印 warning log
- CLI 自己處理錯誤（如 "model does not exist"）

## 各 Backend 驗證能力

| Backend | Dry-run | 列出 available models |
|---------|---------|----------------------|
| kiro-cli | ✅ `--no-interactive` | ✅ |
| claude-code | ✅ `--print` | ❌ |
| codex | ✅ `exec` | ❌ |
| agy | ❌ | ❌ |

## Sources

- [[model-validation-discovery]]
