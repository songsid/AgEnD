---
type: source
title: "CI/CD 流程 + 文件更新流程"
tags: [architecture, fleet]
raw: raw/cicd-and-docs-workflow.md
created: 2026-06-21
updated: 2026-06-21
ingested: 2026-06-21
---

# CI/CD 流程 + 文件更新流程

## Summary

AgEnD 的自動化發布（GitHub Actions）和 release 時的文件更新流程。

## CI/CD

- Tag push `v*` → Publish workflow（typecheck → build → npm publish → GitHub Release）
- PR merge → CI only（typecheck + build）
- Beta: tag `v2.x.y-beta.N` → npm `@beta`
- Stable: tag `v2.x.y` → npm `@latest`
- Package name swap: @suzuke/agend → @songsid/agend（build 時替換）
- Discord plugin 同步 publish

## 文件更新

Release 時必更新：CHANGELOG、commands.md（如有新指令）、features.md（如有新功能）
agend-wiki 負責起草 → push branch → leader merge → tag

## Related

- [[cicd]]
- [[dev-workflow]]
