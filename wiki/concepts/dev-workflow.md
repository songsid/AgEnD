---
type: concept
title: "開發流程"
tags: [architecture, fleet]
sources: [dev-workflow]
created: 2026-06-20
updated: 2026-06-20
---

# AgEnD 開發流程

## 角色分工

| Role | Instance | 職責 |
|------|----------|------|
| Leader | agend-leader | 設計討論、需求拆解、分派、merge PR、tag release |
| Dev | agend-dev-claude | 實作功能/修 bug、push branch、報告完成 |
| Reviewer | agend-reviewer | Code review、找 bug/security issue |
| Architect | agend-architect | 架構評估、method 選擇、trade-off 分析 |
| Wiki | agend-wiki | 文件維護、知識庫管理、版本追蹤 |

**流程調整**: Leader 專注設計討論，實作統一交 agend-dev-claude。

## PR Flow

1. Leader 派任務（delegate_task）
2. Dev checkout feature branch from main
3. Dev 實作 + build + push branch
4. Dev report_result（branch name / PR link）
5. Leader 送 reviewer（delegate_task）
6. Reviewer approve 或 request changes
7. Request changes → dev fix → re-review（target 2 round-trips）
8. Approve → leader merge PR（`gh pr merge`）
9. Leader pull main + tag beta（`git tag v2.x.x-beta.N`）
10. CI auto-publish npm
11. **通知 agend-wiki ingest**（更新 concepts 活頁 + changelog source）

## 文件與 Wiki 整合

| 階段 | 動作 | 負責 |
|------|------|------|
| 設計/決策 | 產出 ingest 到 `wiki/sources/`（immutable） | agend-wiki |
| Merge 後 | 更新 `wiki/concepts/` 活頁 + changelog source | agend-wiki |
| Release | 起草 CHANGELOG entry + push docs branch | agend-wiki |
| 每日 | 巡檢版本+文件落差 | agend-wiki (scheduled) |

通知 agend-wiki ingest 是 PR flow 的固定步驟（step 11）。

## Release Flow

1. Beta 累積功能 → 用戶測試
2. 測試通過 → leader push CHANGELOG + tag stable
3. CI auto-publish npm + auto-create GitHub Release
4. Leader 寫 release notes

## Code Review 規範

- 一次回所有 findings（不分批）
- Target 2 round-trips（review → fix → re-review）
- 第 3 次只看未解決項目
- 嚴重度分級:
  - **Critical** — 必須修（blocks merge）
  - **Warning** — 建議修（non-blocking）
  - **Nit** — 不影響 merge
- 關鍵路徑需 failure mode 分析

## Bug Fix 流程

1. 用戶回報（TG/DC 訊息 + 截圖）
2. Leader 定位（讀 code / debug log）
3. 派 dev 修
4. Reviewer 確認
5. Merge + tag beta
6. 用戶 `agend update --beta` 驗證

## 版本規範

- Stable: `v2.x.y`
- Beta: `v2.x.y-beta.N`
- **所有版本必須先發至少一個 beta** — 不允許直接從 PR merge 跳到 stable tag
- Conventional commits: `feat:` / `fix:` / `docs:` / `chore:`
- Branch protection on main（必須走 PR）

## 通訊協議

- Leader ↔ Dev/Reviewer: `delegate_task` → `report_result`
- Silence = working（不發確認訊息）
- Silence = agreement（沒意見就不回）

## Sources

- [[dev-workflow]]
- [[memory-layering]]
