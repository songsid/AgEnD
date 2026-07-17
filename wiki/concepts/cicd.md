---
type: concept
title: "CI/CD"
tags: [architecture]
sources: [cicd-and-docs-workflow]
created: 2026-06-21
updated: 2026-06-21
---

# CI/CD

## 觸發條件

| Event | Action |
|-------|--------|
| PR merge → main | CI only（typecheck + build） |
| Tag push `v*` | Publish workflow |

## Publish Workflow

1. checkout + setup-node + npm ci
2. `tsc --noEmit` (typecheck)
3. `npm run build`
4. 從 tag 取版本（`v2.0.3` → `2.0.3`）
5. 判斷 npm tag：含 `beta` → `@beta`，否則 `@latest`
6. Swap package name（@suzuke/agend → @songsid/agend）+ 寫入版本號
7. `npm publish --access public --tag [latest|beta]`
8. Build + publish Discord plugin（同步 swap name）
9. `gh release create`（如已存在會 422，不影響 publish）

## Secrets

- `NPM_TOKEN` — npm publish 用
- `GH_TOKEN` — actions/checkout 自動提供（用於 gh release）

## 版本通道

- **Beta**: tag `v2.x.y-beta.N` → `npm install @songsid/agend@beta`
- **Stable**: tag `v2.x.y` → `npm install @songsid/agend@latest`

## 文件更新流程（Release 時）

| 文件 | 條件 | 負責 |
|------|------|------|
| docs/CHANGELOG.md | 每次 release | agend-wiki 起草 |
| docs/commands.md | 有新指令/行為變更 | agend-wiki |
| docs/features.md | 有新功能 | agend-wiki |
| docs/configuration.md | 新 config option | agend-wiki |
| README.md | 通常不需要 | — |

流程: wiki 起草 → push branch → leader merge → tag stable → CI publish

## Sources

- [[cicd-and-docs-workflow]]
- [[dev-workflow]]
