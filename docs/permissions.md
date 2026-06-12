# Permissions Matrix

This document details every permission check in AgEnD across platforms and modes.

## Permission Sources

| Source | File | Fields |
|--------|------|--------|
| Fleet access | `fleet.yaml` | `channel.access.mode` (locked/open/pairing), `channel.access.allowed_users` |
| ClassicBot admin | `classicBot.yaml` | `defaults.admin_users` |
| ClassicBot guilds | `classicBot.yaml` | `defaults.allowed_guilds` (Discord servers) |
| ClassicBot groups | `classicBot.yaml` | `defaults.allowed_groups` (Telegram groups) |
| ClassicBot users | `classicBot.yaml` | `defaults.allowed_users` (Telegram private chat) |

## Discord — Topic Mode (Fleet)

| Operation | Permission Check | Who Can Use |
|-----------|-----------------|-------------|
| Send message to topic | `accessManager.isAllowed(userId)` | `allowed_users` only (locked), all (open) |
| `/status` | `accessManager.isAllowed(userId)` | Same as above |
| `/update` | `allowed_users` list in fleet.yaml | Allowed users only |
| `/restart` | `accessManager.isAllowed(userId)` | Same as above |

## Discord — ClassicBot

| Operation | Permission Check | Who Can Use |
|-----------|-----------------|-------------|
| `/start` | `isGuildAllowed(guildId)` | All users in allowed guilds |
| `/stop` | None (beyond having active agent) | All users |
| `/chat` | None (beyond having active agent) | All users |
| `/ctx` | None | All users |
| `/compact` | `isAdmin(userId)` | Admin users only |
| `/save` | `isAdmin(userId)` | Admin users only |
| `/load` | `isAdmin(userId)` | Admin users only |
| `/collab` | `isAdmin(userId)` | Admin users only |
| `@mention` (collab mode) | None | All users (when collab enabled) |

## Telegram — Topic Mode (Fleet)

| Operation | Permission Check | Who Can Use |
|-----------|-----------------|-------------|
| Send message to topic | `accessManager.isAllowed(userId)` | `allowed_users` only (locked), all (open) |
| `/status` | `accessManager.isAllowed(userId)` | Same as above |
| `/update` | `allowed_users` list in fleet.yaml | Allowed users only |

## Telegram — ClassicBot

### Private Chat

| Operation | Permission Check | Who Can Use |
|-----------|-----------------|-------------|
| `/start` | `isUserAllowed(userId)` | Allowed users (empty = all) |
| `/stop` | None | All users |
| `@mention` / direct message | None (after /start) | All users |

### Group Chat

| Operation | Permission Check | Who Can Use |
|-----------|-----------------|-------------|
| `/start` | `isGroupAllowed(chatId)` + `isAdmin(userId)` | Admin in allowed group |
| `/stop` | `isAdmin(userId)` | Admin only |
| `@mention bot` (chat) | None | All users |
| `@mention bot /raw ...` | `isAdmin(userId)` | Admin only |

## Known Issues & Notes

1. **Discord `/start` `/stop` have no admin check** — any user in an allowed guild can start/stop agents. This is by design (Discord permissions are managed at guild level).

2. **TG `/start@other_bot` isolation** — commands with `@suffix` targeting a different bot are ignored entirely (v0.0.22-beta.3+).

3. **`allowed_guilds: {}` (non-array)** — treated as "allow all" (v0.0.22-beta.2+ defensive fix).

4. **Fleet access `mode: open`** — bypasses `allowed_users` check for topic mode. ClassicBot has its own separate permission system.

5. **TG Group Privacy** — Bot must have Group Privacy disabled in BotFather OR be group admin to receive @mention messages. This is a Telegram platform requirement, not AgEnD.

6. **`defaults.admin_users` empty** — no one is admin (secure default). Must explicitly add user IDs.

## Configuration Examples

### Locked fleet + open classicBot (recommended)
```yaml
# fleet.yaml
channel:
  access:
    mode: locked
    allowed_users: ["951494522"]

# classicBot.yaml
defaults:
  admin_users: ["951494522", "368442276000694273"]
  # allowed_guilds/groups/users: omitted = allow all
```

### Restricted classicBot
```yaml
# classicBot.yaml
defaults:
  admin_users: ["951494522"]
  allowed_guilds: ["1496407196106494055"]  # Discord only
  allowed_groups: ["-5222823063"]          # Telegram only
  allowed_users: ["951494522"]             # TG private chat only
```
