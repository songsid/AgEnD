---
type: source
title: "AgEnD v2.0.3 Changelog (beta)"
tags: [version, feature, bugfix]
version: "2.0.3"
raw: raw/changelog-v2.0.3.md
created: 2026-06-20
updated: 2026-06-20
ingested: 2026-06-20
---

# AgEnD v2.0.3-beta (2026-06-18, in progress)

## Summary

Focuses on platform parity (Discord fleet commands), developer UX (instance warmup, idle/busy status), and operational improvements (unified /update, /compact).

## Key additions

- **Instance warmup** — auto-trigger context loading after spawn; waits for idle before completing
- **`agend ls` Idle/Busy status** — real-time indication of instance processing state
- **Fleet ready version** — show version in startup notification
- **DC collab auto-enable** — /start auto-enables collab; open mode allows all bot messages
- **Fleet /collab** — bot/webhook messages in fleet topics (TG + DC)
- **Fleet /compact** — compact any fleet instance from chat (TG + DC)
- **DC Fleet slash commands** — /status, /sysinfo, /restart, /ctx as Discord slash commands
- **Unified /update** — both TG and DC spawn `agend update` (detached)
- **TG Classic /compact** — admin-only compact for classic instances

## Key fixes

- /update auto-detects beta version
- Health port infinite retry loop prevented (re-entry guard)
- DC /collab fleet topic requires allowed_users permission
- DC slash commands dedup — /compact was registered twice (beta.13)
- Complete slash command registration + 🔒 admin markers (beta.14)
- General topic: allow /ctx /compact /collab (beta.15)
- /status: remove tmux capture fallback — too slow with many instances (beta.16)
- /ctx enabled in TG General topic and Classic mode (beta.17)

## Design decisions

- Instance warmup: system message post-spawn triggers steering/skill loading; waits for idle state
- Discord collab auto-enable reduces setup friction
- Fleet commands unified across TG and DC for consistent UX
- /update detects current version channel (stable vs beta) and uses appropriate npm tag

## Related

- [[instance-warmup]]
- [[fleet-commands]]
- [[changelog-v2.0.2]]
