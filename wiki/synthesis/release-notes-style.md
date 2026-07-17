---
type: synthesis
title: "Release Notes 寫作風格指南"
tags: [workflow]
sources: []
source_version: v2.0.11
created: 2026-07-17
updated: 2026-07-17
---

# Release Notes 寫作風格指南

GitHub Release Notes 的寫作規範。風格參考 [Outline](https://github.com/outline/outline/releases)。

## 結構

```markdown
## What's Changed

### Highlights
(2-3 個最重要新功能，多寫描述)

### Improvements
(小改善，一行一項)

### Fixes
(bug 修復，一行一項)

**Full Changelog**: https://github.com/songsid/AgEnD/compare/vX.X.X...vY.Y.Y
```

## 風格規則

- 不用 emoji 當分類標題
- 不放 PR 連結（用戶是 end-user 不是 contributor）
- 每項簡潔一行描述
- Highlights 可以多寫 2-3 行說明價值
- 用英文寫（國際化）

## 選材規則

- **放**: npm package 用戶有感的功能/修復
- **不放**: 網站/工具類改動（ps1 腳本、GitHub Pages）— 不影響 npm package
- **Highlights**: 選用戶最有感的功能（通常 2-3 個）

## 範例

```markdown
## What's Changed

### Highlights
- Context % detection now works out of the box for Codex and Antigravity CLI — AgEnD automatically configures each backend's statusline display
- Discord `/status` and `/sysinfo` no longer hang when the fleet has many instances — long replies now use embeds

### Improvements
- Each backend now uses its native compact/cancel command (`/clear` for agy, Ctrl+C for kiro)
- Kiro "Response timed out" is detected on every occurrence and auto-retires the Cancel button

### Fixes
- `defaults.model` no longer applied to incompatible backends
- `/ctx` now shows correct backend for ClassicBot instances
- Beta users no longer see "update available" for the same base version

**Full Changelog**: https://github.com/songsid/AgEnD/compare/v2.0.11...v2.0.12
```

## 注意事項

- 版本號遵循 semver
- CHANGELOG.md（開發者視角，詳細）和 Release Notes（用戶視角，精簡）是不同文件
- Release Notes 由 leader 手動寫（CI 不自動建 GitHub Release）

## Sources

- [[cicd]]
- [[dev-workflow]]
