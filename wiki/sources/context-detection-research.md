---
type: source
title: "Context % 偵測研究"
tags: [architecture, backend]
raw: raw/context-detection-research.md
created: 2026-07-06
updated: 2026-07-06
ingested: 2026-07-06
---

# Context % 偵測研究

## Summary

各 backend 的 context usage 偵測方式研究。agy 可透過 statusline JSON hook 實現，codex 目前無穩定方案。留待 v2.1。

## 偵測方式對照

| Backend | 方式 | 狀態 |
|---------|------|------|
| claude-code | `statusline.json`（CLI 自動寫入） | ✅ 已實作 |
| kiro-cli | tmux capture regex `XX% λ !>` | ✅ 已實作 |
| agy | statusline JSON hook（settings.json → script → stdin JSON） | 可行，v2.1 |
| codex | 無外部 hook（tmux footer 不穩定 / config.toml） | 不穩定 |

## agy 方案

1. 全域設定：`~/.gemini/antigravity-cli/settings.json` → `statusLine.command` 指向 script
2. Script 讀 stdin JSON → 寫 `$AGEND_INSTANCE_DIR/statusline.json`
3. Per-instance env var 區分輸出路徑
4. 不覆寫用戶現有 statusline script（需 chain 或 check）

## agy JSON payload

```json
{
  "context_window": {
    "used_percentage": 42,
    "remaining_percentage": 58,
    "total_input_tokens": 84000,
    "context_window_size": 200000
  }
}
```

## 競品做法

| 工具 | 方式 |
|------|------|
| Multica | timeout 替代 |
| OpenAB | ACP stdio |
| Agent Orchestrator | event file |

## 設計要點（v2.1）

1. 全域設定（一次設好，所有 instance 共用）
2. Per-instance 輸出路徑（env var 區分）
3. 不覆寫用戶設定（chain existing script 或 check-before-write）

## Related

- [[channel-delivery-pitfalls]] (§5 /ctx context% 取得)
