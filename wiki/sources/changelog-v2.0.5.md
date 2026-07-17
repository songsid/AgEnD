---
type: source
title: "AgEnD v2.0.5 Changelog"
tags: [version, feature, bugfix]
version: "2.0.5"
raw: raw/changelog-v2.0.5.md
created: 2026-06-24
updated: 2026-06-24
ingested: 2026-06-24
---

# AgEnD v2.0.5 (2026-06-24)

## Summary

Stability-focused release with `agend doctor mcp` diagnostic tool and 12 bug fixes. Major wins: hang detector false positives reduced 73%, claude-code background session crash loop resolved.

## Key additions

- **`agend doctor mcp`** — fleet-wide MCP health check: IPC connectivity, config paths, duplicate tools, binary PATH verification
- **TG Classic `/ctx`** — context usage display in classic mode
- **Decision filtering** — instances only see fleet-scope + same-project decisions (privacy improvement)
- **/start notifications** — unauthorized access attempts notify General

## Key fixes

- TG Classic @mention: auto-collab on /start restricted to Discord-only
- TG private chat: thread_id no longer incorrectly passed
- /compact: unified via IPC raw_paste + tmux literal mode
- Hang detector: 73% fewer false positives (requires pending inbound)
- claude-code background session: auto-recovery with re-entry guard (#79)
- Chat-log: local timezone (was UTC)
- install.sh: EEXIST cleanup on package rename
- Export: includes classicBot.yaml
- MCP env: filtered decisions only

## Related

- [[changelog-v2.0.3]]
- [[changelog-v2.0.4]]
- [[fleet-commands]]
