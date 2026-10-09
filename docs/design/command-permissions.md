# Command permissions

[繁體中文](command-permissions.zh-TW.md)

The [command surface matrix](../command-surface.md) records menus, handling,
refusals and text routing. [permissions.md](../permissions.md) explains admission
and credentials; [commands.md](../commands.md) describes command effects.

## Admission, then command authority

Discord native slash commands pass the source/owner door in
[`slash-authz.ts`](../../src/slash-authz.ts), then the rule in
[`command-table.ts`](../../src/command-table.ts), then the handler. DMs refuse;
foreign guilds allow only registered Classic contexts or new `/start`, and
fleet-admin commands still require the bot's own guild. A sibling bot cannot
handle another owner's fleet channel. An unavailable owning world fails closed.
An explicit F passes fleet admission, but locked access with an empty F list
provides no management authority.

Telegram General/fleet typed dispatch recognizes the exact form it will handle
and enforces the table's **Telegram** cell before that handler runs
(`TopicCommands.tableRefusal`). A non-matching form remains ordinary text.
Classic Telegram uses its own dispatcher and role checks; unsupported group
commands need a separate conversational mention to become ordinary text.

## Roles

| Level | Meaning |
|---|---|
| `anyone` | A caller already admitted by ingress; no additional admin role |
| `fleet-admin` (**F**) | Explicit owning-bot YAML `access.allowed_users`; invoking bot when no target. Empty grants nobody; unknown adapter denies |
| `classic-admin` (**C**) | Shared `classicBot.yaml` `defaults.admin_users`; empty grants nobody |
| `channel-admin` | F in fleet/General; the Classic bot's F or C in an existing Classic registration |
| `handler` | New `/start`'s own admission: C directly, or explicit guild/private-user grant; otherwise General approval. Telegram groups retain C start authority |

Open/pairing chat admission and saved access grants do not confer F. A chat
allowlist does not confer C. The two roles remain distinct: `/stop` and Discord
Classic `/load` require C, whereas existing Classic context controls accept F or C.
Empty Classic new-start grants request approval; existing registrations stay usable.

## Scope and handler exceptions

- Discord exposes all 27 native commands per bot application, but per-agent
  commands refuse without an applicable agent. `/profile` is General-only.
- Telegram's 21 fleet menu entries are shared by General/instance topics; its
  Classic menu has 10. Hidden `/cancel`, `/save` and fleet `/raw` still have handlers.
- Recognized Telegram fleet-wide commands in a worker topic refuse and point to
  General. Exact non-handler forms such as `/STATUS` or `/status report` remain
  ordinary input. `/restart` and `/visibility` match case-insensitively.
- Telegram Classic `/chat` uses ordinary conversation wrapping, not a special
  command handler. The table's `anyone` cell does not create one.
- Discord Classic `/load` submits to every backend without validating backend
  support; successful import is not verified. Classic Telegram raw is currently
  blocked by its generic helper. Neither capability is changed here; [#1458](https://github.com/songsid/AgEnD/issues/1458)
  records future decisions.
- Buttons and selectors have independent nonce, address and current-authority
  checks. A command's earlier authorization is not permission for a later click.
  The source channel and original Telegram group must still map to the target
  at claim and after progress; ambiguous same-world topics refuse.
  Clear also rechecks the exact adapter, daemon/IPC owner, cached launch owner
  (`bootId`, `spawnGeneration`, `launchAttempt`, `launchFenceEpoch`), lifecycle
  epoch and delivery epoch after retiring buttons, before the first IPC effect; it is not web-mirrored.
- At a Telegram forum's root (no topic), bare command-like input selects the
  configured primary adapter's General in that group, or the first configured
  same-group General when the primary has none there. Its own copy and admin
  list govern admission before shared dedup, even without a message ID; arrival
  order does not select an administrator. A stopped or unresolved owner is
  held, with no automatic switch to a sibling. To address another General, use
  `/restart@ThatBot full`, `/update@ThatBot`, or that General's own topic.
  Explicit suffixes require a known, unambiguous matching bot username before
  dedup; wrong or unknown receivers are silent. Ordinary root conversation and
  existing Classic/present-thread username behavior retain their routing.

## Updating the surface

Change the correct platform cell in `COMMANDS`, the real handler and both matrix
languages. Lock labels are generated from the relevant table/menu scopes; a label
never authorizes execution. Keep `command-surface-docs-1148.test.ts` and the real
handler tests in `command-gates-by-platform.test.ts` green. Do not copy a Discord
rule into Telegram by choosing the more restrictive cell.
