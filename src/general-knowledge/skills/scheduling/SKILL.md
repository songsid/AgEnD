---
name: scheduling
description: Cron, one-shot, and silent schedules via the schedule MCP tools
---

## Tools

- `create_schedule` — make a schedule (recurring or one-shot).
- `list_schedules` — list all (optionally filter by target instance).
- `update_schedule` — change cron/at/message/timezone/enabled of an existing one.
- `delete_schedule` — remove one.

A schedule injects `message` into the `target` instance when it fires
(`target` defaults to the current instance).

## Three ways to schedule

**1. Recurring (cron)** — `cron` + optional `timezone` (IANA, default `Asia/Taipei`):
```
create_schedule({ cron: "0 9 * * *", message: "Daily standup summary", timezone: "Asia/Taipei" })
```
Cron is 5-field (min hour dom mon dow). `0 9 * * *` = 09:00 daily in the given tz.

**2. One-shot (at)** — `at` = ISO-8601 datetime **with offset**; runs once then auto-deletes:
```
create_schedule({ at: "2026-07-26T14:00:00+08:00", message: "Ship the release", target: "dev1" })
```
Exactly one of `cron` / `at` is required (mutually exclusive).

**3. Silent** — add `silent: true` to any of the above. The message is pasted straight
into the target's tmux pane instead of posting to the channel — use for heartbeats /
background nudges the user shouldn't see:
```
create_schedule({ cron: "*/30 * * * *", message: "check CI and self-report if red", silent: true })
```

## Notes

- `timezone` is per-schedule; the fire time is fixed to that zone (DST-safe).
- Give recurring schedules a `label` so `list_schedules` / `delete_schedule` are easy.
- One-shot (`at`) needs no cleanup — it deletes itself after firing.
