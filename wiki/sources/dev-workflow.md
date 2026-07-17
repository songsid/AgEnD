---
type: source
title: "AgEnD 團隊開發流程"
tags: [architecture, fleet]
raw: raw/dev-workflow.md
created: 2026-06-20
updated: 2026-06-20
ingested: 2026-06-20
---

# AgEnD 團隊開發流程

## Summary

AgEnD 專案的完整開發流程文件，涵蓋角色分工、PR flow、release flow、code review 規範、bug fix 流程、版本規範、通訊協議、記憶分層。

## 角色

| Role | Instance | 職責 |
|------|----------|------|
| Leader | agend-leader | 需求拆解、分派、merge、tag |
| Dev | agend-dev1/dev2 | 實作、push branch |
| Reviewer | agend-reviewer | Code review、approve |
| Architect | agend-architect | 架構評估、trade-off |
| Wiki | agend-wiki | 文件維護、知識庫 |

## 流程摘要

- PR: delegate → branch → implement → push → review → merge → tag beta → CI publish
- Release: beta 累積 → 測試通過 → CHANGELOG + tag stable → CI publish + GitHub Release
- Bug fix: 回報 → leader 定位 → dev 修 → review → merge + beta → 用戶驗證
- Review: 2 round-trips target, Critical/Warning/Nit 分級

## Related

- [[dev-workflow]]
- [[memory-layering]]
