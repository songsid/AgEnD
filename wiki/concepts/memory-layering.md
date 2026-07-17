---
type: concept
title: "Memory Layering"
tags: [architecture, fleet]
sources: [changelog-v2.0.2]
source_version: v2.0.7
created: 2026-06-20
updated: 2026-06-26
---

# Memory Layering

## Overview

AgEnD's three-tier memory system for fleet instances, formalized in v2.0.2.

## Layers

| Layer | Location | Purpose | Load timing |
|-------|----------|---------|-------------|
| Decision | Fleet shared (JSON, `~/.agend/decisions/`) | Role + rules + TODO | Every turn |
| soul.md | Instance workspace root (per-instance, not in repo) | Full memory (architecture, decisions, history) | Steering always |
| Skill | `.kiro/skills/` (per-instance workspace) | Reusable workflows | On-demand |

## Important notes

- `soul.md` is a **per-instance runtime file** — it lives in each instance's workspace (`~/.agend/workspaces/<name>/soul.md`), NOT in the AgEnD source repo
- It was accidentally committed to the repo once and has since been gitignored + removed
- Each instance maintains its own `soul.md` independently (never shared)

## Rules

- Good workflows → skill files in `.kiro/skills/` (per-instance)
- Don't set global skills unless ALL instances need them
- Decision should be < 20 lines — trim or move to soul.md
- Fleet Decision only stores: role basics, cross-instance rules, TODO lists
- Architecture details, bug records, history → `soul.md`

## Sources

- [[changelog-v2.0.2]] (formalized in v2.0.2)
