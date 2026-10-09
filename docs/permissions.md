# Permissions Matrix

AgEnD checks chat admission, command roles, AgEnD tool profiles and HTTP credentials separately. None of these is a sandbox for the coding CLI. See [Security Considerations](SECURITY.md) ([繁體中文](SECURITY.zh-TW.md)) for the host and credential boundaries.

## Permission sources

| Source | Configuration/state | Meaning |
|--------|---------------------|---------|
| Fleet chat admission | `channels[].access` (or legacy `channel.access`) + per-adapter access state | Effective mode and allowed users |
| Fleet admin (**F**) | Owning adapter's YAML `access.allowed_users`; invoking adapter when there is no target | Explicit fleet management authority |
| ClassicBot admin (**C**) | `classicBot.yaml`: `defaults.admin_users` | ClassicBot management authority |
| ClassicBot server/group/user admission | `defaults.allowed_guilds`, `allowed_groups`, `allowed_users` | Discord servers, Telegram groups, Telegram private users respectively |
| AgEnD tool profile | Instance `tool_set` | Server-side permission to invoke AgEnD tools |
| Dashboard / agent HTTP | `web.token` / per-instance `agent.token` | Separate bearer credentials, not chat roles |

**Open chat access and approved pairing do not make a fleet admin.** F is an explicit entry in the owning bot's YAML list (invoking when there is no target); an empty list grants nobody F, and an unknown adapter fails closed. ClassicBot's empty admin list likewise grants nobody C. For new ClassicBot starts, omitted, empty or non-array guild/group/private-user lists admit nobody: non-C callers request approval in General. C may start directly. Existing registrations are unaffected.

## Fleet chat admission and persisted access

Omitting the whole `access` block supplies an **open** fallback. With a configured block, set its mode, `allowed_users` array and pairing limits explicitly; there is no field-by-field runtime initializer that turns an incomplete block into the documented defaults.

- Saved mode takes precedence over YAML mode. Saved allowed users and YAML `allowed_users` are unioned, string-normalized and deduplicated; pairing approval adds a saved grant.
- The primary adapter uses `<dataDir>/access/access.json`; additional adapters use `access/access-<adapterId>.json`. `dataDir` defaults to `~/.agend`, or `AGEND_HOME` when set.
- In locked/pairing mode, removing an ID from YAML alone may leave a saved grant. Removing only its saved grant can let YAML restore it at reconstruction. Remove both grants to revoke allowlist admission; open mode admits all users regardless of that list.
- Typed fleet messages use the target instance's **owning world** access policy. An identified owner whose adapter/world is unavailable is refused; a sibling's policy cannot substitute for it.
- Discord slash commands first require a guild and an allowed source context: the receiving bot's main guild, a registered Classic channel, or a new `/start` whose handler decides admission. DMs and another bot's fleet channels are refused. Fleet slash admission accepts the owning policy's users **or an explicit F**, but still refuses an unavailable owning world. A command's role check follows this ingress check.
- Registered Classic channels bypass the fleet user gate and use ClassicBot registration/allowlist/admin rules. F and C remain separate command roles.

See the [access configuration](configuration.md#channelaccess) ([繁體中文](configuration.zh-TW.md#channelaccess)).

## Command matrix

The full [command surface matrix](command-surface.md) ([繁體中文](command-surface.zh-TW.md)) records all 27 native command names, menu visibility, handling, refusals, forwarding and silence, including unregistered chats and callback qualifiers. The table below is a summary.

**A** means a caller already admitted by the applicable ingress rules, including the explicit Discord fleet-admin admission above. It is not unrestricted access from any server, DM or bot.

**—** means no AgEnD command handler in that scope, not permission to perform that action. Text forwarding still depends on the normal route: a private chat may send it to the agent, while a Classic group still needs a separate mention. A command suffix alone does not replace that mention for an unsupported command.

These are command role requirements; an applicable instance, backend capability and current lifecycle state are still needed.

| Commands | Discord General / instance | Discord Classic | Telegram General | Telegram instance topic | Telegram Classic |
|----------|----------------------------|-----------------|------------------|-------------------------|------------------|
| `/status`, `/restart`, `/login`, `/update`, `/doctor`, `/dashboard`, `/visibility` | F | F | F | Refuse: use General | — |
| `/profile` | General only: F | Refuse | F | Refuse: use General | — |
| `/model`, `/clear` | F | F or C | F | F | F or C |
| `/effort` | F | F or C | F | F | — |
| `/pause`, `/wake` | F | F or C | F | F | F or C |
| `/compact`, `/save` | F | F or C | F | F | F or C |
| `/collab` | F | F or C | F | F | — |
| `/cancel`, `/ctx`, `/steer`, `/btw` | A | A | A | A | A |
| `/sysinfo`, `/usage` | A | A | A | Refuse: use General | — |

Discord's fleet-wide commands can also run in an admitted guild channel without an agent, requiring F; per-agent commands there refuse. Telegram's fleet-wide handlers are General-only. `/tips` is informational: Discord exposes it across admitted contexts and Telegram in General/instance topics; settings-changing arguments require the handler's admin check (F on both platforms).

The implementation matrix is [`src/command-table.ts`](../src/command-table.ts). Discord enforces it after ingress; Telegram General/fleet typed dispatch also enforces its Telegram cells before a recognized handler runs. Classic handlers enforce their own roles. Exact-form passthrough and the ordinary Classic `/chat` exception are detailed in the full matrix; Discord cells do not establish Telegram behavior.

## ClassicBot lifecycle and addressing

| Command/input | Discord Classic | Telegram private | Telegram Classic group |
|---------------|-----------------|------------------|------------------------|
| `/start` | **C**, or an explicitly allowed guild; otherwise General approval | **C**, or an explicitly allowed user; otherwise General approval | `/start@OurBot`: **C** starts directly; others request access for unlisted groups, but an allowed group still needs **C** to start |
| `/stop` | C; registered Classic channel | C | `/stop@OurBot` and C |
| `/load` | C; registered Classic channel | No AgEnD handler | No AgEnD handler |
| `/chat` / normal chat | A; `/chat` needs an active Classic agent | Active agent; private routing | `@OurBot` in chat; active agent (a command suffix alone is insufficient) |
| Collab input | This bot's mention triggers forwarding | Normal private routing | This bot's mention triggers forwarding |

In Telegram Classic groups, slash commands must target the bot as `/command@OurBot`. **Bare slash commands, including `/start`, are silently ignored.** A suffix for another bot is ignored too. Private chats accept bare commands. These checks apply after Telegram delivers the update; platform delivery settings are a separate prerequisite.

Discord `/start` accepts C or an explicit Classic guild grant. An empty list no longer means open. `/stop` requires C on both platforms; being F alone is insufficient. Allowlists admitting a chat do not grant its users admin authority.

## Bot and webhook messages

Bot traffic has additional ingress filters before chat policy:

- Fleet topics accept only the owning adapter's bot/webhook copy. The early filter passes when that receiving owner adapter explicitly has **YAML `access.mode: open`**, or instance collab is enabled. The owning world's effective access policy still runs afterward; collab does not bypass locked/pairing admission, so the bot ID must be allowed there.
- The early filter reads YAML mode. Omitting `access` gives open human admission but does not itself pass this bot filter. Conversely, YAML open plus a saved locked mode still faces the saved allowlist.
- Discord Classic bot input needs that receiving bot's registered agent and collab setting. The exact mention of that bot is additionally required to forward a turn.
- Telegram no-thread bot input has a separate filter: explicit YAML open or an `@OurBot` mention. Registered Classic-group forwarding still requires a mention.

## AgEnD tool permissions

`tool_set` filters the MCP tool menu **and is enforced on the server** for outbound IPC, typed IPC and agent HTTP/CLI operations. Asking for an omitted tool by name cannot bypass the profile. Profile selection uses an explicit recognized `tool_set`, otherwise the General role for General, otherwise worker.

These checks govern AgEnD tools, independently of chat admission/admin roles. They do not constrain a backend's own Bash, file or network tools, and filesystem IPC permissions do not isolate processes sharing the fleet's OS user.

## HTTP credentials

All listener requests first pass the Host allowlist; that header check is not client authentication.

| Entry point | Credential boundary |
|-------------|---------------------|
| Dashboard-gated routes | Current `web.token` in `X-Agend-Token`, or a browser session from a one-time sign-in code (writes also need a matching `Origin` and the session's CSRF header); a URL `?token=` is never a credential |
| GET `/health`, enabled GET `/api/ai-usage`, `/view` and its GET data (including `/api/pane/*`) | Public reads, subject to listener reachability and Host check; no dashboard credential. `web.view_access: session` gates all of these except `/health` |
| View profile/avatar/sort writes | The dashboard gate: a session (with its write checks) or `X-Agend-Token`; never a URL token |
| POST `/agent` | `X-Agend-Instance-Token: <encodedInstance>:<token>` where `<encodedInstance>` is `encodeURIComponent(instanceName)` and `<token>` is the per-instance bearer; verified before body is read (401 if absent/wrong, 413 if body > 512 KiB), plus that instance's AgEnD tool profile |
| Temporary `/login` terminal | Separate per-login credential, not a dashboard credential |

`web.token` persists and can be rotated without a fleet restart; rotating it also ends every browser session. Instance agent tokens are replaced on CLI spawn. A browser session is an opaque random id that the server expires itself (12 hours after sign-in, or 2 hours without use) and can revoke per device. See [Security Considerations](SECURITY.md#dashboard-sign-in-and-browser-sessions) for the sign-in codes, revocation, connection lifetime and secret handling.

## Configuration example

A fleet access excerpt with one explicit administrator; complete the channel's other fields for your platform:

```yaml
# fleet.yaml
channels:
  - id: tg
    type: telegram
    mode: topic
    bot_token_env: AGEND_BOT_TOKEN
    group_id: "-1001234567890"
    access:
      mode: locked
      allowed_users: ["987654321"]
      max_pending_codes: 5
      code_expiry_minutes: 10

# classicBot.yaml (separate file)
defaults:
  admin_users: ["987654321"]
  allowed_guilds: ["234567890123456789"]
  allowed_groups: ["-1001234567890"]
  allowed_users: ["987654321"]
```
