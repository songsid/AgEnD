# Command surface and authorization

[繁體中文](command-surface.zh-TW.md) · [Command reference](commands.md) · [Admission and credentials](permissions.md)

The tables distinguish menu visibility, AgEnD handling, refusal and ordinary text routing. Verified against main `572bf39f9a4d98ed0d1fa78b414d07c7c9f54295`; the roles and command paths are unchanged from the linked audit source below.

## Reading a cell

- `H:A`: AgEnD handles it for a caller admitted by ingress; no additional admin role.
- `H:F`: explicit fleet admin of the owning bot (or the invoking bot when there is no target); an empty YAML list grants nobody F.
- `H:C`: shared ClassicBot `defaults.admin_users`; an empty list grants nobody C.
- `H:F/C`: either F of this Classic bot or C, for an existing Classic registration.
- `H:start`: custom new-start admission; C may start directly, otherwise an explicit guild/private-user grant is needed or General approval is requested. Telegram group starts still require C. Existing registrations are unchanged.
- `R`: AgEnD consumes the command and returns a refusal, including a missing agent. `R:G` specifically points to General. `R:active` says the Classic agent already exists.
- `P`: no AgEnD command handler; normal ingress/routing may send the literal text to the agent.
- `S/P`: an addressed Classic group command without a separate conversational mention is silent; with a separate mention it becomes ordinary agent text.
- `S/R`: unregistered Classic chat is silent, unless a separate bot mention elicits a no-agent notice.
- `R(C)` / `R(F)`: the real unregistered-chat handler checks C / F first, then finds no agent. C alone does not pass the F-or-C helper without a registration.
- `*`: `/tips` without a mode is informational; settings-changing modes require F.

✓ is the configured menu entry, not a runtime grant. Backend support, arguments, lifecycle state and source checks still apply to every H cell. Telegram G/T menus are registered on the whole forum chat, so General and instance topics share their suggestions. Discord registers all 27 commands globally for each bot; platform registration failure may leave an older menu.

## Discord native slash

| Command | Menu | General | Fleet topic | Classic | Unregistered guild channel |
|---|---|---|---|---|---|
| `/profile` | ✓ | H:F | R | R | R |
| `/start` | ✓ | R | R | R | H:start |
| `/stop` | ✓ | R | R | H:C | R |
| `/chat` | ✓ | R | R | H:A | R |
| `/load` | ✓ | R | R | H:C | R |
| `/pause` | ✓ | H:F | H:F | H:F/C | R |
| `/wake` | ✓ | H:F | H:F | H:F/C | R |
| `/compact` | ✓ | H:F | H:F | H:F/C | R |
| `/clear` | ✓ | H:F | H:F | H:F/C | R |
| `/model` | ✓ | H:F | H:F | H:F/C | R |
| `/effort` | ✓ | H:F | H:F | H:F/C | R |
| `/collab` | ✓ | H:F | H:F | H:F/C | R |
| `/save` | ✓ | H:F | H:F | H:F/C | R |
| `/steer` | ✓ | H:A | H:A | H:A | R |
| `/btw` | ✓ | H:A | H:A | H:A | R |
| `/cancel` | ✓ | H:A | H:A | H:A | R |
| `/ctx` | ✓ | H:A | H:A | H:A | R |
| `/status` | ✓ | H:F | H:F | H:F | H:F |
| `/restart` | ✓ | H:F | H:F | H:F | H:F |
| `/login` | ✓ | H:F | H:F | H:F | H:F |
| `/update` | ✓ | H:F | H:F | H:F | H:F |
| `/doctor` | ✓ | H:F | H:F | H:F | H:F |
| `/dashboard` | ✓ | H:F | H:F | H:F | H:F |
| `/visibility` | ✓ | H:F | H:F | H:F | H:F |
| `/sysinfo` | ✓ | H:A | H:A | H:A | H:A |
| `/usage` | ✓ | H:A | H:A | H:A | H:A |
| `/tips` | ✓ | H:A* | H:A* | H:A* | H:A* |

## Telegram typed commands

| Command | Menu G/T | Menu Classic | General | Fleet topic | Classic private | Classic group | Unregistered private/group |
|---|---|---|---|---|---|---|---|---|
| `/profile` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/start` | — | ✓ | P | P | R:active | R:active | H:start |
| `/stop` | — | ✓ | P | P | H:C | H:C | R(C) |
| `/chat` | — | — | P | P | P | S/P | S/R |
| `/load` | — | — | P | P | P | S/P | S/R |
| `/pause` | ✓ | ✓ | H:F | H:F | H:F/C | H:F/C | R(F) |
| `/wake` | ✓ | ✓ | H:F | H:F | H:F/C | H:F/C | R(F) |
| `/compact` | ✓ | ✓ | H:F | H:F | H:F/C | H:F/C | R(F) |
| `/clear` | ✓ | ✓ | H:F | H:F | H:F/C | H:F/C | R(F) |
| `/model` | ✓ | ✓ | H:F | H:F | H:F/C | H:F/C | R(F) |
| `/effort` | ✓ | — | H:F | H:F | P | S/P | S/R |
| `/collab` | ✓ | — | H:F | H:F | P | S/P | S/R |
| `/save` | — | — | H:F | H:F | H:F/C | H:F/C | R(F) |
| `/steer` | ✓ | ✓ | H:A | H:A | H:A | H:A | R |
| `/btw` | ✓ | ✓ | H:A | H:A | H:A | H:A | R |
| `/cancel` | — | — | H:A | H:A | H:A | H:A | R |
| `/ctx` | ✓ | ✓ | H:A | H:A | H:A | H:A | R |
| `/status` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/restart` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/login` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/update` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/doctor` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/dashboard` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/visibility` | ✓ | — | H:F | R:G | P | S/P | S/R |
| `/sysinfo` | ✓ | — | H:A | R:G | P | S/P | S/R |
| `/usage` | ✓ | — | H:A | R:G | P | S/P | S/R |
| `/tips` | ✓ | — | H:A* | H:A* | P | S/P | S/R |

## Addressing, unbound topics and other inputs

- Discord DMs refuse every native slash command. A foreign guild refuses everything except new `/start` or a registered Classic context; even there, fleet-admin operations and settings-changing `/tips` refuse. Other-owner fleet channels refuse native commands, even for a person administering both bots.
- Discord typed `/xxx` in fleet/General produces a use-slash-menu notice from the owner and is consumed; Classic typed slash text is silent. A foreign bot suffix is silent when the receiving username is known.
- Telegram Classic groups require `/cmd@ThisBot`; **bare slash commands are silent**, including `/start`. A suffix for another bot is silent when the receiving username is known. Private chats accept bare forms. Existing Classic/present-thread handling permits a suffix when that username is unknown. At a configured Telegram forum root, bare command-like input uses the primary connection's same-group General, or the first configured same-group General if the primary has none there. The selected bot's admin list governs; stopped or unresolved targets never switch to siblings. Use `/restart@ThisBot full`, `/update@ThisBot` or that bot's own topic for another General. Explicit suffixes require a known, unambiguous username before shared dedup: wrong or unknown receivers are silent, even without a message ID. Ordinary root conversation keeps its routing. A command suffix is not a conversational mention.
- Recognizers are exact: `/STATUS`, `/status report`, `/update now`, `/pause one two`, etc. remain ordinary agent text in fleet/General. `/restart` and `/visibility` are case-insensitive. This is pinned existing behavior, not the old bug where a recognized `/status` in a worker topic was forwarded.
- Telegram `/sys-info` and `/sys_info` alias General `/sysinfo`; `/install-cli` and `/install_cli` alias General `/login`. They have no menu entries. `/sys-info` and `/sys_info` match only their **unsuffixed exact forms**; adding `@bot` leaves ordinary text. The install aliases accept suffixes. Recognized General aliases in worker topics point to General.
- Telegram fleet `/raw <text>` is hidden and F-gated, then enters the raw delivery path. `/raw@bot ...` is ordinary wrapped text, not a raw bypass. Classic `/raw <text>` denies non-C; even C has no successful native raw path today, as the generic `/chat /raw ...` helper drops it. Group mention-shaped variants can instead become ordinary wrapped messages. This capability is unchanged; follow-up [#1458](https://github.com/songsid/AgEnD/issues/1458) records the deferred decision.
- In a configured Telegram forum, an unregistered topic gets the unbound-topic notice. It is not the unregistered Classic-chat column. Missing General may leave no-thread input silently unhandled.
- General `/pause` and `/wake` need an explicit instance owned by that General's bot. General itself cannot be paused. Authorized fleet-wide restart/status/login/diagnostics and settings still affect shared fleet/host state; owner authorization is not world-limited execution.
- `/load` on Discord sends `/chat load <filename>` to **every Classic backend**, without a backend check. Kiro has that native command. On other backends AgEnD neither reads nor verifies the response: the CLI can reject the command or interpret it as input, and AgEnD's acknowledgement proves submission only. No successful import is promised; [#1458](https://github.com/songsid/AgEnD/issues/1458) records the deferred capability decision.
- Classic menus and start grants are separate from already-registered chat access. Open conversation or pairing does not grant F; C is one shared list across bots/platforms. Classic approval may fall back to another General and uses that General's F.
- A persisted Telegram Classic `collab: true` takes the generic Discord-style mention branch; ordinary Telegram/private forwarding can therefore become silent. Normal Telegram starts do not enable this flag.

## Buttons and selections

Buttons have their own handler gates; menu visibility and a slash command's gate do not authorize a later click.

| Surface | Actual gate |
|---|---|
| Cancel | current owner/destination/message; admitted fleet speaker, or an existing Classic conversation participant |
| Model / effort | opener + adapter/channel + current owner/admin; the source channel and original Telegram group must still map to this target at claim and after the progress update; ambiguous same-world topics refuse |
| Clear | F or C in Classic, F elsewhere; exact nonce/world/message; current role, source target, adapter, daemon/IPC owner, cached launch owner, lifecycle epoch and delivery epoch are rechecked after button retirement, before clear IPC |
| Tip feedback | identified caller + exact nonce/world/message; advanced unlock additionally requires F |
| Login / hang / exit / Classic approval | F + exact nonce/world/message, plus request-specific ownership where present |
| Dashboard / Settings confirmation | current owner F, nonce and requester/authority fences |

**Clear is not web-mirrored**: its nonce is absent from `listWebPrompts`, and `clickWebPrompt` refuses it. No web clear admission is added.

Source: `src/fleet-manager.ts:10443`, `:11592`, `:14413`, `:14719`, `:11126`. Stale/unknown callback IDs do not grant authority.

## Maintaining the matrix

`tests/command-surface-docs-1148.test.ts` checks both languages' command cells and menu membership against the command table, with explicit Classic real-handler exceptions. `tests/command-gates-by-platform.test.ts` exercises the real handlers. Update both documents when a rule, menu or route changes. Do not infer a Telegram handler from a Discord cell.

The no-thread General suffix and after-await callback fences reject stale or unverified sources. They preserve the role model and exact-form passthrough. Clear compares the cached `{bootId, spawnGeneration, launchAttempt, launchFenceEpoch}` and lifecycle epoch across its wait; unavailable ownership refuses. Once the first synchronous IPC/config effect is admitted, the existing backend/restart behavior continues.

## Audited sources

- [`src/command-table.ts:116`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/command-table.ts#L116) — 27 command rules / 27 條命令規則
- [`src/command-table.ts:215`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/command-table.ts#L215) — 21/10 Telegram menus / Telegram 選單
- [`src/channel/adapters/discord.ts:1117`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/channel/adapters/discord.ts#L1117) — Discord global registration / 全域註冊
- [`src/topic-commands.ts:1896`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/topic-commands.ts#L1896) — Telegram registration scopes / 註冊 scope
- [`src/fleet-manager.ts:3347`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/fleet-manager.ts#L3347) — Discord door → table → handler
- [`src/fleet-manager.ts:3531`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/fleet-manager.ts#L3531) — Discord source/owner door / 來源與 owner
- [`src/fleet-manager.ts:3281`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/fleet-manager.ts#L3281) — Explicit fleet admin / 明確授權 F
- [`src/topic-commands.ts:580`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/topic-commands.ts#L580) — Telegram table enforcement / 授權表接線
- [`src/topic-commands.ts:526`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/topic-commands.ts#L526) — Exact typed forms / 精確文字辨識
- [`src/fleet-manager.ts:6915`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/fleet-manager.ts#L6915) — Telegram Classic real dispatch / 實際路由
- [`src/classic-channel-manager.ts:483`](https://github.com/songsid/AgEnD/blob/41687055f2bf5b26fcc9f350309caa183729ca78/src/classic-channel-manager.ts#L483) — Empty Classic start grants / 空准入清單

- [`src/fleet-manager.ts:6767`](https://github.com/songsid/AgEnD/blob/5ccbf10d11d4698fd3a4682e16fd4d843054aabf/src/fleet-manager.ts#L6767) — No-thread General suffix / 無 thread 的 General 定址
- [`src/fleet-manager.ts:11196`](https://github.com/songsid/AgEnD/blob/462b528007e33c071a05ca54521c117ca28148df/src/fleet-manager.ts#L11196) — Clear after-await fence / clear 等待後重驗
- [`src/fleet-manager.ts:14788`](https://github.com/songsid/AgEnD/blob/462b528007e33c071a05ca54521c117ca28148df/src/fleet-manager.ts#L14788) — Selector source mapping / 選單來源對應
