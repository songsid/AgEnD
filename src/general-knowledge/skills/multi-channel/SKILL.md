---
name: multi-channel
description: Setting up multiple platforms (Telegram + Discord) with proper general routing
---

## Multi-Channel Setup

When using multiple platforms (e.g. Telegram + Discord), use `channels:` array instead of single `channel:`:

```yaml
channels:
  - id: discord
    type: discord
    mode: topic
    bot_token_env: AGEND_DISCORD_TOKEN
    group_id: "123456789"
    options:
      general_channel_id: "987654321"
  - id: telegram
    type: telegram
    mode: topic
    bot_token_env: AGEND_BOT_TOKEN
    group_id: "-1001234567890"
```

**Critical: each adapter needs its own general instance.**

```yaml
instances:
  general:
    working_directory: ~/.agend/general
    topic_id: "987654321"        # DC general channel
    general_topic: true
    channel_id: discord           # binds to discord adapter
  general-telegram:
    working_directory: ~/.agend/general-telegram
    topic_id: 1                   # TG general topic (thread_id 1)
    general_topic: true
    channel_id: telegram          # binds to telegram adapter
```

## Auto-Detection

On startup, AgEnD checks each adapter has a bound general. If missing, it auto-creates one with a warning log:
```
WARN: No general instance for adapter — auto-creating
```

The `channel_id` field explicitly binds a general to an adapter. Without it, matching falls back to instance name containing the adapter id (e.g. `general-telegram` matches `telegram`).

## Common Mistakes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| One general for two platforms | TG messages reply in DC | Add a second general with `channel_id` |
| `channels:` without unique `id` per entry | Adapter collision | Set `id: discord` / `id: telegram` |
| Using `channel:` (singular) for multi-platform | Second platform ignored | Switch to `channels:` array |

## Single → Multi Migration

1. Change `channel:` to `channels:` array, add `id` to existing entry
2. Add new platform entry with its own `id`
3. Add a general instance for the new platform with `channel_id: <new-adapter-id>`
4. Restart fleet: `agend fleet restart`
