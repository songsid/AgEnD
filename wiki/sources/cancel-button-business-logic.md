---
type: source
title: "Cancel Button Business Logic"
tags: [architecture, feature, telegram, discord]
raw: raw/cancel-button-business-logic.md
created: 2026-06-30
updated: 2026-06-30
ingested: 2026-06-30
---

# Cancel Button Business Logic

## Summary

完整業務邏輯文件：觸發/消失條件、5 個場景分析、DC vs TG 差異、5 個 bug、治本建議（三態偵測）。核心問題：button 綁 reply tool（假設 reply=結束），但 agent 常 reply 後繼續工作。

## Key insight

核心設計假設「一個 inbound → agent 工作 → 一次 reply 結束」在多數場景不成立。治本需要三態偵測（Thinking/Streaming/Idle），idle 才 clear。

## Related

- [[cancel-button]]
- [[channel-delivery-pitfalls]]
