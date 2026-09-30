---
name: persona-emoji
description: Pick your own persona emoji — list what your platform accepts, choose one that stands for you, set it
roles: [worker]
---

## What it is

When a message reaches you, your bot stamps a status reaction on it: received,
queued, processing, then **delivered** (or failed). In a channel with several
bots every one stamps the same ✅, and nobody can tell who handled what. Your
persona emoji replaces your `delivered` stamp with one of your own, the way
`set_display_name` gives you a name of your own.

## Tools

- `list_emojis` — your current stamps (`statuses`, with `source`: instance =
  yours, platform = the connection's, builtin = AgEnD's), the standard emojis
  your platform accepts (`standard`), and on Discord the server emojis your
  bot can react with (`server_emojis`, grouped by server; values are ready to
  pass on, e.g. `<:fox:123456789012345678>`). `refresh: true` refetches those.
- `set_persona_emoji` — `emoji` plus optional `status` (default `delivered`).
  An empty `emoji` removes your override and you are back to the default.

## Pick → set

1. `list_emojis`. Note your `platform`.
2. Choose ONE emoji that reflects you (your role, your name, your
   personality). Rules the tool enforces:
   - **Telegram**: only an emoji from `standard.reactions`. No server emoji.
   - **Discord**: any single emoji, or a value from `server_emojis`.
   - Exactly one emoji: `👀✅` or text is refused.
   - Avoid one another bot in your channel already uses, and avoid ⏳ 👀 ❌:
     those read as queued / processing / failed.
3. `set_persona_emoji` with it. The answer's `now` is what your bot will
   stamp from the next message on.
4. If it is refused, the error says why; pick again from `list_emojis`.
   Don't retry the same value.

Only change your own `delivered` stamp unless someone asked for more. The
other statuses are how people see a message is still in progress, and
`progress_prefix` is the emoji leading your progress messages.

ClassicBot instances have no per-instance stamps. The tool says so, and the
connection's emojis are set by an operator in Settings.
