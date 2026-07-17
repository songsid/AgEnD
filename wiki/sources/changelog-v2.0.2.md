---
type: source
title: "AgEnD v2.0.2 Changelog"
tags: [version, feature, bugfix]
version: "2.0.2"
raw: raw/changelog-v2.0.2.md
created: 2026-06-20
updated: 2026-06-20
ingested: 2026-06-20
---

# AgEnD v2.0.2 (2026-06-17)

## Summary

Major multi-channel support release. Adds TG Rich Message receive, multi-channel auto-detection, and significant ClassicBot fixes.

## Key additions

- **TG Rich Message receive** — grammy middleware intercepts Rich Message (Bot API 10.1) for bot-to-bot @mention communication
- **Multi-channel auto-detect** — each adapter gets its own General instance; unbound generals adopted by topic_id match
- **`channel_id` field** — explicit binding of General instances to specific adapters
- **Quickstart live add platform** — add a second platform while fleet is running
- **`agend stop/start` fallback** — works on machines without D-Bus/systemd
- **Memory best practice** — steering rules: Decision (short) → soul.md (full) → skill (on-demand)
- **Configuration & commands docs** — complete fleet.yaml/classicBot.yaml reference

## Key fixes

- ClassicBot chat-log: non-@mention messages now correctly recorded
- Bot-to-bot @mention: isBotMessage filter allows bot messages with @ourBot mention
- Duplicate general on add platform: adopt unbound generals instead of creating duplicates
- `/restart` admin check: mode:open no longer allows unauthorized restart
- Unclosed code fences: stripped before CLI paste to prevent input hang

## Design decisions

- grammy upgraded to 1.44.0 for Bot API 10.1
- `assignTopicIds` uses `channel_id` config for platform detection (replacing name heuristic)
- Multi-channel architecture: one General per adapter, topic_id adoption for unbound generals
- Memory layering formalized: Decision → soul.md → skill (on-demand)

## Related

- [[multi-channel-architecture]]
- [[rich-messages]]
- [[memory-layering]]
