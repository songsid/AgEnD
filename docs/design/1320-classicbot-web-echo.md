# ClassicBot web echo (#1320 part B)

Owner web messages typed in the dashboard chat (`POST /ui/send`,
`src/web-api.ts:404,839`) go straight to the agent via `deliverToInstance`
(`src/web-api.ts:886`) and never appear in the channel. Part A (sol) echoes
them into a fleet instance's own topic. This note designs the ClassicBot
equivalent. Status: **docs first — nothing here is implemented.**

## Why ClassicBot is separate

A fleet topic belongs to one instance. A ClassicBot channel is often a
**shared group** with other members, so echoing the owner's web-typed text
there publishes potentially private text to an audience. Hence:

- default **off** for every ClassicBot channel;
- per-channel opt-in, in config **and** Settings;
- group channels need an explicit acknowledgment (see §2).

Current-state hazard for part A: the part-A sync block
(`src/web-api.ts:916-928`) fires for any `instance` with an IPC client,
using `getAdapterForInstance` + `getGroupIdForInstance`
(`src/fleet-manager.ts:2073-2139`) with primary-adapter/group fallbacks.
ClassicBot instances are **not** in `fleet.yaml` (`ClassicChannelManager`
owns `classicBot.yaml`), so if web chat ever addresses a classic instance
name, the echo would fall back to the primary group with no thread. Part A
should exclude classic instance names until this design lands.

## 1. Opt-in: off by default, per channel

New per-channel key in `classicBot.yaml` (channel entries,
`src/classic-channel-manager.ts:84-108`):

```yaml
channels:
  <key>:
    channelId: "-123456"
    web_echo: true   # default false when absent
```

- Absent/false → no echo, exactly today's behavior.
- Settings: `PATCH /api/settings/classic/channels/:key`
  (`src/settings-api.ts:13`) accepts the key. It is **not** hot:
  `CLASSIC_HOT_CONFIG_KEYS` is only `tool_progress` + `reply_completion_guard`
  (`src/instance-config-impact.ts:52-55`), so flipping `web_echo` restarts the
  channel like any other channel key. The Settings UI must show the restart
  consequence next to the toggle.
- No global default-on: unlike part A's `web.echo_to_channel` (default on
  for fleet topics), a fleet-wide ClassicBot default would silently opt in
  every shared group. Per-channel only.

## 2. DM-only, or warn for groups

- Telegram: private chats have positive ids, groups negative
  (`isPrivateChat`, `src/fleet-manager.ts:5999`); platform inference lives in
  `inferClassicChannelType` (`src/classic-channel-manager.ts:140-155`).
- Discord: DMs are dropped entirely (`if (!msg.guildId) return`,
  `src/channel/adapters/discord.ts:390`), so Discord ClassicBot channels are
  guild channels by construction — there is **no DM-only Discord classic
  channel** today.

Rule: `web_echo: true` on a Telegram private chat just works. On a group
(either platform) Settings must show an explicit warning — "every web message
to this instance is posted where all channel members can read it" — and
require a second confirmation. Rationale: the group case is the privacy risk
named in #1320; a single toggle is too easy to fat-finger. `allowed_groups` /
`allowed_users` (`src/classic-channel-manager.ts:78-81,470-490`) do not
substitute: they gate who may talk *to* the bot, not who may *read* the echo.

## 3. Echo format

Same as part A for consistency (`src/web-api.ts:921-928`): `🌐 web-user:
<preview>`, 500-char preview with ` [...]`, attachments appended as
`[📎 N files: a, b]`. Delivery: the channel's own adapter
(`worlds.get(adapterId)?.adapter`, cf. `src/fleet-manager.ts:12119`,
`12265`), `sendText(channelId, …)` — ClassicBot channels have no thread to
target. Failures are swallowed with a debug log like part A; a failed echo
never fails the web send. For chat-log continuity the echo should also be
appended via `ClassicChannelManager.logMessage` (`src/classic-channel-manager.ts:862-871`)
under username `web-user`, matching how bot replies are logged as `"bot"`
(`src/fleet-manager.ts:6744`).

## 4. Never re-enter the agent

Three independent layers, all already in the code:

1. **Discord** drops the bot's own messages in-adapter
   (`src/channel/adapters/discord.ts:388`).
2. **Telegram** never delivers a bot its own messages (stated at
   `src/fleet-manager.ts:6260-6262`); on top, fleet-level gates drop bot
   copies that do arrive: `botMessageDropReason`
   (`src/fleet-manager.ts:5794-5824`) and the owner check
   `topicOwnerDropReason` (`src/fleet-manager.ts:5778-5788`), applied at
   `src/fleet-manager.ts:5897-5899`.
3. **Collab trigger** needs an exact `<@BOT_USER_ID>` mention, matched only
   against the *message's own* adapter id
   (`src/fleet-manager.ts:12145-12155`); the echo format contains no mention,
   so even a leaked copy cannot trigger a turn. (The self-marker `@user (you)`
   rewrite at `:12176-12179` / `:6263-6264` only applies to inbound text that
   already mentioned the bot.)

Echo-side obligation: the format must never include the bot's mention tag.
A unit test pins the rendered echo for a bot whose username appears in the
web text (e.g. web text "@mybot hello" stays literal, never becomes a
triggering mention).

## 5. Multi-bot channels

Entries are keyed `(channelId, adapterId)`
(`src/classic-channel-manager.ts:209-211`) with per-bot instance names
(`classicInstanceName`, `:134-138`) and per-bot mention matching (§4.3).
Echo follows the same split: `web_echo` is per **entry**, and an echo fires
only for web messages addressed to *that entry's* instance name. The second
subscription (`backendOptions.credential_profile`,
`src/classic-channel-manager.ts:62-66,693-710`) is orthogonal — echo is
channel delivery, not inference, and works identically on either login.
A channel with bot A opted in and bot B not must show exactly one echo.

## 6. Tests

- TG private chat opted in → echo lands in that chat; off/absent → silence.
- TG group opted in → echo lands (with the Settings warning covered by a
  config-shape test, not UI automation).
- Discord guild channel opted in → echo lands; no re-entry via the
  in-adapter self-drop (fake `messageCreate` from self).
- Echo text never contains a triggering `<@id>` mention (mention-shaped web
  text stays literal).
- Multi-bot channel: A opted in, B not → one echo, addressed from A's
  adapter entry; B's agent receives nothing.
- Classic instance in part-A path: no fallback post to the primary group
  (regression for the §0 hazard).
- Setting respected end to end: `web_echo` absent/false/true through
  `PATCH /api/settings/classic/channels/:key` shape.

Open question for part A: message ordering (echo before the agent's reply)
is part A's contract; classic echo inherits whatever ordering part A
establishes.
