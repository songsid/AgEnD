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

Same frame as part A, produced only through the shared
`formatWebChannelEcho(user, preview)` (`src/web-channel-echo.ts`, PR #1325):
`🌐 web · <user>: <preview>`, 500-char preview with ` [...]`, attachments
appended as `[📎 N files: a, b]` (names already neutralised per §4.1). Delivery: the channel's own adapter
(`worlds.get(adapterId)?.adapter`, cf. `src/fleet-manager.ts:12119`,
`12265`), `sendText(channelId, …)` — ClassicBot channels have no thread to
target. Failures are swallowed with a debug log like part A; a failed echo
never fails the web send. For chat-log continuity the echo should also be
appended via `ClassicChannelManager.logMessage` (`src/classic-channel-manager.ts:862-871`)
under username `web-user`, matching how bot replies are logged as `"bot"`
(`src/fleet-manager.ts:6744`).

The optional third formatter argument is `fullTextNote`; Classic passes `t("web.echo_full_text")` for the localised full-text note.

## 4. Never re-enter the agent

Correction to the r1 draft: the "three independent guards" claim does NOT
hold for cross-bot echoes. The scenario: bot A's echo text contains bot B's
mention (`🌐 web-user: <@200> hello`), B has collab on in that Classic
channel. Discord drops only a bot's *own* messages
(`src/channel/adapters/discord.ts:388`), so B sees A's echo;
`topicOwnerDropReason` deliberately exempts classic channels
(`src/fleet-manager.ts:5778-5788`), `botMessageDropReason` returns null for
a collab-on classic entry (`:5803-5810`), and `handleClassicChannelMessage`
triggers B on `text.includes('<@B>')` (`:12145-12155`). Prism reproduced
exactly this. `allowedMentions` suppression alone does not help either,
because AgEnD's own text match fires regardless of what Discord renders.
The implementable rule has three parts, all echo-side:

1. **Neutralise every mention syntax with visible ASCII replacement
   only** — no zero-width joiners, Markdown escapes, or full-width
   lookalikes (a normalising client or parser can strip invisible/format
   characters and restore a live mention; visible text survives NFKC and
   format-character removal). Exact forms, implemented once in the shared
   `neutralizeWebEchoText` (`src/web-channel-echo.ts`, sol's PR #1325),
   applied to the echoed preview AND to attachment names:
   `<@200>`/`<@!200>` → `[mention: 200]`, `<@&300>` → `[role: 300]`,
   `@everyone`/`@here` → `[at: everyone]`/`[at: here]`,
   `@user` → `[at: user]`, `/cmd@bot` → `[command: cmd at bot]`.
   `@user` and `/cmd@bot` match at a word boundary only — never after
   `://`, never inside an email local part — so URLs and addresses survive
   intact. "The format contains no mention of our own bot" is necessary but
   explicitly insufficient — the rule covers *any* bot's mention syntax.
2. **Echo provenance is author identity, not a cache.** An inbound message
   is an echo, dropped before any trigger evaluation, iff its author is one
   of this fleet's own bot accounts **and** its text starts with the fixed
   echo prefix `WEB_ECHO_PREFIX = "🌐 web · "`. Shared API, implemented once
   in `src/web-channel-echo.ts` (sol's PR #1325) and reused verbatim here —
   `neutralizeWebEchoText(text)`, `formatWebChannelEcho(user, preview)`,
   `isWebChannelEcho(text, authorId, fleetBotIds)`; do not re-spell the
   prefix or the predicate. Fleet bot ids come from read-only authenticated
   identity per configured adapter/world (native adapter getter, no hot-path
   network) — restart-proof, nothing to evict, no recent-ID registry. A
   human copying the prefix doesn't match — their author id is not a fleet
   bot — so their message flows normally; a non-fleet bot posting the prefix
   is treated like any other bot message under the existing collab rules.
   Every adapter applies `isWebChannelEcho` in the common ingress helper,
   first, regardless of `is_bot`, ACK state, or its own `web_echo` flag.
   During startup/rebuild, while any configured world on the same platform
   has an unknown bot identity (including a world not yet registered), the
   common ingress also quarantines bot-flagged prefix candidates before
   trigger evaluation with a debug log. Human copies still flow. Once all
   identities are known, the exact author-id rule applies again and non-fleet
   bots return to the existing collab policy; no unknown author is classified
   as a fleet bot. This also covers pre-ACK and post-restart replays.
3. **Delivery-layer suppression** as defence in depth:
   `allowedMentions: { parse: [] }` on Discord sends, no mention entities on
   Telegram sends — so other clients/bots also see no ping.

The formatter caps the complete echo at 1,800 UTF-16 units with a Unicode-safe cut, keeping the echo and its provenance prefix in a single Discord message.

Part A's shared ordering reservation has a five-second total monotonic budget, including queue and admission waits. On expiry replies proceed, queued copies are dropped with a warning, and an already in-flight copy may land late with a logged outcome. No copy is retried.

A unit test pins the rendered echo for hostile inputs: a `<@other-bot>`
mention, `@everyone`, an attachment literally named `<@200>.png`, and a
replayed echo (same bytes, after restart) — none may reach any agent.

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
- TG group opted in → echo lands.
- Discord guild channel opted in → echo lands; no re-entry via the
  in-adapter self-drop (fake `messageCreate` from self).
- **A→B cross-bot regression** (real inbound + Classic collab): A opted in,
  B with `web_echo` **off** and collab on; A's echo is rendered after NFKC
  plus format-character removal and still carries no live mention — direct
  `<@B>` → `[mention: B]`, an attachment named `<@B>.png` → `[mention:
  B].png`, and a post-restart replayed echo dropped by author identity.
  B's agent receives nothing in all cases; the channel shows exactly one
  echo.
- **Provenance controls**: A→B echo after a restart → dropped; before the
  send ACK → dropped; a human pasting the `🌐 web · …` prefix → delivered
  normally; a non-fleet bot posting the prefix → existing collab rules.
- Multi-bot channel: A opted in, B not → one echo, addressed from A's
  adapter entry; B's agent receives nothing.
- Classic instance in part-A path: no fallback post to the primary group
  (regression for the §0 hazard).
- Settings reuses the existing session/header-token + Origin/CSRF gate
  (`src/settings-api.ts`); group membership alone never authorises an
  opt-in change. A non-boolean `web_echo` is rejected and stays off.
- The group-warning second confirmation is tested against the real page
  logic (what the user must click through), not just the config shape.
- Setting respected end to end: `web_echo` absent/false/true through
  `PATCH /api/settings/classic/channels/:key` shape.

Open question for part A: message ordering (echo before the agent's reply)
is part A's contract; classic echo inherits whatever ordering part A
establishes.
