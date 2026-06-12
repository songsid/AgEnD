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

---

## Topic Mode (Fleet Instances)

Commands available in forum topics (Telegram) or forum channels (Discord).

### Telegram Topic Mode

| Command | Permission Check | Who Can Use |
|---------|-----------------|-------------|
| Send message to topic | `accessManager.isAllowed(userId)` | `allowed_users` (locked), all (open) |
| `/status` | fleet access | Allowed users |
| `/restart` | fleet access | Allowed users |
| `/sysinfo` | fleet access | Allowed users |
| `/ctx` | fleet access | Allowed users |
| `/update` | explicit `allowed_users` check | Allowed users only |
| `/raw <cmd>` | fleet access | Allowed users |
| `/pair` | pairing mode only | Anyone (pairing mode) |

### Discord Topic Mode

| Command | Permission Check | Who Can Use |
|---------|-----------------|-------------|
| Send message to topic | `accessManager.isAllowed(userId)` | `allowed_users` (locked), all (open) |
| `/status` | fleet access | Allowed users |
| `/restart` | fleet access | Allowed users |
| `/sysinfo` | fleet access | Allowed users |
| `/ctx` | fleet access | Allowed users |
| `/update` | explicit `allowed_users` check | Allowed users only |
| `/raw <cmd>` | fleet access | Allowed users |

---

## ClassicBot Mode

Commands available in regular channels/groups/private chats.

### Discord ClassicBot (Slash Commands)

| Command | Permission Check | Who Can Use |
|---------|-----------------|-------------|
| `/start` | `isGuildAllowed(guildId)` | All users in allowed guilds |
| `/stop` | None (beyond active agent) | All users |
| `/chat <msg>` | None (beyond active agent) | All users |
| `/ctx` | None | All users |
| `/compact` | `isAdmin(userId)` | Admin users only |
| `/save <file>` | `isAdmin(userId)` | Admin users only |
| `/load <file>` | `isAdmin(userId)` | Admin users only |
| `/collab` | `isAdmin(userId)` | Admin users only |
| `@mention` (collab) | None | All users (when collab enabled) |

### Telegram ClassicBot — Private Chat

| Command | Permission Check | Who Can Use |
|---------|-----------------|-------------|
| `/start` | `isUserAllowed(userId)` | Allowed users (empty = all) |
| `/stop` | `isAdmin(userId)` | Admin only |
| Direct message | None (after /start) | All users |

### Telegram ClassicBot — Group Chat

| Command | Permission Check | Who Can Use |
|---------|-----------------|-------------|
| `/start` | `isGroupAllowed(chatId)` + `isAdmin(userId)` | Admin in allowed group |
| `/stop` | `isAdmin(userId)` | Admin only |
| `@bot <message>` | None (after /start) | All users |
| `@bot /raw <cmd>` | `isAdmin(userId)` | Admin only |

---

## Access Control Flow

### Inbound Message Processing (`handleInboundMessage`)

```
Message arrives
  │
  ├─ isBotMessage? → only collab classic channels pass
  │
  ├─ accessManager.isAllowed(userId)?
  │   ├─ YES → continue
  │   └─ NO → is TG classic candidate?
  │       ├─ YES → bypass (classic has own permission system)
  │       └─ NO → is classic channel target? → if not, REJECT
  │
  ├─ threadId == null (TG classic mode)?
  │   ├─ /command@other_bot → IGNORE entirely
  │   ├─ /start → isGroupAllowed + isAdmin (group) / isUserAllowed (private)
  │   ├─ /stop → isAdmin
  │   ├─ @mention /raw → isAdmin
  │   └─ @mention (chat) → ALLOW ALL
  │
  └─ threadId set (topic mode)?
      └─ Route to instance (already passed access control above)
```

---

## Known Issues & Notes

1. **Discord `/start` `/stop` have no admin check** — any user in an allowed guild can start/stop agents. By design (guild whitelist = trust boundary).

2. **TG `/start@other_bot` isolation** — commands with `@suffix` targeting a different bot are ignored entirely (v0.0.22-beta.3+).

3. **`allowed_guilds: {}` (non-array)** — treated as "allow all" (v0.0.22-beta.2+ defensive fix).

4. **Fleet access `mode: open`** — bypasses `allowed_users` check for topic mode. ClassicBot has separate permission system.

5. **TG Group Privacy** — Bot must have Group Privacy disabled in BotFather OR be group admin to receive @mention messages. Platform requirement.

6. **`defaults.admin_users` empty** — no one is admin (secure default). Must explicitly add user IDs.

7. **TG private chat `/stop`** — requires admin (same as group). If `admin_users` is empty, no one can `/stop` in private chat. Add yourself to `admin_users` to manage agents.

---

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
  allowed_guilds: ["1496407196106494055"]  # Discord servers
  allowed_groups: ["-5222823063"]          # Telegram groups
  allowed_users: ["951494522"]             # TG private chat
```
