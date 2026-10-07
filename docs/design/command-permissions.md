# Command permissions

Who may run which chat command, and where. Since #1148 the answer lives in one
table, [`src/command-table.ts`](../../src/command-table.ts). This page explains
how to read it. For the full per-mode access matrix (inbound messages, private
chats, config examples) see [permissions.md](../permissions.md); for what each
command does see [commands.md](../commands.md).

## Two checks, in order

1. **The door** ([`src/slash-authz.ts`](../../src/slash-authz.ts), Discord slash
   commands only) decides whether the caller may speak in this channel at all:
   a DM is refused; a command from another guild is honoured only in a
   registered ClassicBot channel or for `/start`; in a fleet channel the caller
   must pass the access policy of the adapter that owns the channel's instance
   (an explicit fleet admin always passes). ClassicBot channels stay open, as
   they are for typed messages.
2. **The command table** then decides whether the command applies in this kind
   of channel and which admin level it needs. It can only narrow what the door
   let through.

Both run in `FleetManager.dispatchSlash` (`src/fleet-manager.ts`), the single
handler every Discord adapter uses. Telegram's typed-command handlers are not
table-driven yet; the table's `telegram` column records what they actually do,
and `tests/command-gates-by-platform.test.ts` pins each Telegram cell against
the real handlers.

## Levels

| Level | Who passes |
|---|---|
| `anyone` | Whoever the door admitted |
| `channel-admin` | In a fleet channel, a fleet admin. In a ClassicBot channel, a fleet admin **or** a ClassicBot admin |
| `fleet-admin` | An explicit entry in the **invoking adapter's** `access.allowed_users` in fleet.yaml. An empty list means nobody (`/update` and `/dashboard` then reply that the command is disabled) |
| `classic-admin` | A ClassicBot admin only (`defaults.admin_users` in classicBot.yaml; empty means nobody) |
| `handler` | The table asks nothing more; the command's own handler decides. Only `/start` |

Scopes: `fleet` (an instance's own channel/topic), `general` (the General
dispatcher), `classic` (a ClassicBot channel/chat) and `none` (a channel with no
agent). Where a command does not apply, it is refused with one line before
anything runs.

## The table, summarised

Discord column (what `dispatchSlash` enforces):

| Commands | Level | Where |
|---|---|---|
| `/status`, `/restart`, `/login`, `/update`, `/doctor`, `/dashboard` | fleet-admin | everywhere |
| `/sysinfo`, `/usage`, `/tips` | anyone | everywhere (`/tips on/off` is gated by its handler) |
| `/pause`, `/wake`, `/compact`, `/clear`, `/model`, `/effort`, `/collab`, `/save` | channel-admin | agent channels |
| `/steer`, `/btw`, `/cancel`, `/ctx` | anyone | agent channels |
| `/stop`, `/load` | classic-admin | ClassicBot channels |
| `/chat` | anyone | ClassicBot channels |
| `/start` | handler (guild allowlist) | channels with no agent |

Telegram differs in these cells (`telegram` column):

- The fleet-wide commands (`/status`, `/restart`, `/login`, `/update`,
  `/doctor`, `/dashboard`, `/sysinfo`, `/usage`) have handlers only in the
  General topic; elsewhere the text goes to the agent as a normal message.
- `/compact`, `/save` and `/collab` have no check in a fleet topic. In a
  ClassicBot chat `/compact` and `/save` need a ClassicBot admin, and `/collab`
  has no handler.
- `/pause` and `/wake` need a fleet admin in fleet topics and a ClassicBot
  admin (not a fleet admin) in a ClassicBot chat. `/clear` and `/model` need a
  fleet admin in fleet topics and a channel admin in a ClassicBot chat.
- `/effort` and `/load` have no ClassicBot handler on Telegram.
- `/start` checks the user allowlist in a private chat, and the group
  allowlist **and** a ClassicBot admin in a group.

When the two columns disagree, neither is "the real rule": read the column for
the platform you are changing.

## Changing a command's permission

- Edit its row in `COMMANDS`. The 🔒 prefix in Discord slash descriptions
  (`slashLock`) and in the Telegram menus (`telegramMenu`) is generated from the
  table, so the label cannot drift from the rule.
- A new Discord slash command must be added to the table: `dispatchSlash`
  answers a command missing from the table with "that command is not available
  any more" instead of running it.
- If you change a Telegram handler's gate, update the `telegram` cell too;
  `tests/command-gates-by-platform.test.ts` will fail otherwise.
- Do not merge platforms by "most restrictive wins". A cell that holds for
  Discord is not thereby true for Telegram.
