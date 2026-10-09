# New-user onboarding: a walkthrough and a plan

Status: design for review. Nothing here is implemented yet.
Source: user feedback on 2.2 alpha.2. Adding a connection in web Settings asks the user to edit `~/.agend/.env` by hand and press "Reload". The user wants the whole flow smoothed out and bot tokens entered on the web. The setup wizard has the same problem, and the controls in the top-right corner are hard to understand.

## 1. Scope and method

The journey covered:
1. Install.
2. `agend quickstart` / `agend init` / `agend setup`.
3. First visit to the web dashboard (sign-in).
4. The Settings setup wizard.
5. Adding a Discord or Telegram connection (bot, token, invite, permissions, server and group ids).
6. The first agent and the first conversation.
7. A second connection, and ClassicBot.

**Method.** This is a code-level trace of `main` (survey at 391bd5e1, spot-checked at 53c2c4b2). Every step below cites the code that implements it and quotes the user-visible strings. The flows were not run live against a real HOME, because fleet decision bd0c88aa forbids running `agend` commands on the host. The first implementation PR (P1, §6) includes a scratch-HOME, private-port browser smoke of the new flow; that is where screenshots belong.

Severity:
- **S1:** blocks the user.
- **S2:** forces them out of the browser, or to hand-edit files.
- **S3:** confusing.
- **S4:** cosmetic.

## 2. The journey today

### 2.1 Install
- `npm i -g @songsid/agend` prints only the runtime line, `✓ AgEnD will run on its bundled Node …` (`launcher/postinstall.cjs:98`).
- **S3:** nothing points to the next step (`agend quickstart`, `agend setup`, or the web).

### 2.2 `agend quickstart` (the recommended path)
`src/quickstart.ts:503`. It needs a TTY and tmux.

- **Steps:**
  - "Step 1/3: Backend" is auto-detected.
  - "Step 2/4: Channel" offers Telegram, Discord or both. There is no web-only choice.
- **Telegram:**
  - The token is pasted and verified with `getMe`.
  - "Add @bot to a Telegram group, then send /start in the group." The group and user ids are then detected by polling `getUpdates` for 3 minutes (`:65-80`). This works well.
- **Discord:**
  - Portal steps and the Message Content intent are printed (`:263-265`), and the token is verified with `/users/@me`.
  - If the bot is in no server, the user is told to build an invite in the portal's URL Generator and paste the Guild id (`:286-290`).
  - **S2: the user id and the General channel id are typed by hand**, which needs Developer Mode (`:305-318`).
- **Files written:** `fleet.yaml` (`channels[].bot_token_env`, `access: locked`, `allowed_users`) and `~/.agend/.env` at mode 0600 (`AGEND_BOT_TOKEN` or `AGEND_DISCORD_TOKEN`).
- **End of run:**
  - It installs the service and prints "Talk to @bot in your Telegram group".
  - **S3: it never prints the web URL, `agend web` or a sign-in code.**
  - **S4:** the step counter goes 1/3, then 2/4.

### 2.3 `agend init` (advanced) and `agend setup` (pre-fleet web form)

**`agend init`** (`src/setup-wizard.ts:303`):
- The Telegram group id is manual: "Open https://api.telegram.org/bot<TOKEN>/getUpdates" or "@getidsbot".
- Discord exits if the bot is in no server.
- **S3: wrong advice at the end:**
  - `systemctl --user enable --now agend` (`:787`), but the installed unit is `com.agend.fleet.service`.
  - "Install Discord plugin: npm install -g @songsid/agend-plugin-discord" (`:796`), but Discord is built in.

**`agend setup`** (`src/cli.ts:2163`):
- Prints a local URL and a setup code, and serves a four-step form (`src/setup-form.ts`).
- Its token step already says "Written to ~/.agend/.env and never shown again".
- **S2:** on commit it shows "On the host, run: agend settings confirm <32-hex id>" (`:286`). The user needs a second terminal, or must walk back to the host when using `--tunnel` from a phone.
- **S3:** it ends with "AgEnD is up. Talk to it in the channel you just set up." There is no dashboard link and no sign-in.

### 2.4 First web visit (sign-in)
- `/` leads to `/signin`: "Enter the one-time code from your chat channel." and "Send /dashboard to your AgEnD bot, or run "agend web --code" on the host." (`src/ui/signin.html:40,46`).
- **S2:** the code comes from chat or the host. This is acceptable by design, since the code is the credential, but nothing on the CLI side tells a new user this. `agend web` also refuses to run without a running fleet ("Web token not found. Is the fleet running?").
- **First screen:** Chat shows "Pick an instance to start". The sidebar's empty state is "No instances yet". `noInstancesHint` is defined but unused (`src/ui/shared/app-i18n.js:50`).
- **S3:** there is no first-run detection. A fleet with no connections never offers the setup wizard; the user has to find the wand icon in Settings.

### 2.5 The Settings setup wizard (four steps, the same as `agend quickstart`)
`src/ui/settings-wizard.js`, strings in `src/ui/settings-strings.js:123-152`, server in `src/quickstart-api.ts`.

| Step | What the user does | Token and ids | Friction |
|---|---|---|---|
| 1 Agent | Picks a backend ("Found on this host: …"), types an absolute working directory, keeps "agent-1" | — | S3: re-running the wizard **overwrites** that agent's directory and backend (`quickstart-api.ts:252-256`) |
| 2 Platform | Telegram or Discord, with a one-line hint ("Create an application in the Discord developer portal and invite the bot to your server.") | — | S2: no invite link, no Message Content intent note |
| 3 Credentials | Pastes the token ("It is written to ~/.agend/.env and never shown again."), presses Verify. Discord: picks a guild from a dropdown, then types "General channel id" and "Your user id". Telegram: "Detect from a message" or typed ids | The token is written by the server; the user does not edit `.env` here. The env var name is a field, defaulting to `AGEND_BOT_TOKEN` (`settings-wizard.js:29`) | **S1: the default env name is the same for Discord and Telegram, and `draftQuickstart` matches an existing connection by `bot_token_env` and replaces it (`quickstart-api.ts:249-251`). Adding Discord after a Telegram quickstart turns the Telegram connection into the Discord one.** Not silently: `planQuickstart` warns "AGEND_BOT_TOKEN is already used by the "…" connection — its token will be overwritten." and lists users dropped from its allow list (`quickstart-api.ts:129-138`). Review shows that warning (`settings-wizard.js:126-130`), and the commit is confirmed. But the default makes the collision the normal outcome of adding a second platform, and the warning talks about a token, not about losing a connection. S2: channel id and user id are typed by hand. S3: an env-var name is a question a new user cannot answer. Telegram detection is refused while the fleet polls the same token |
| 4 Review | Reviews the YAML and the `.env` key, then "Create and start" | — | S1/S2: the commit is a sensitive write (#1423). With no chat yet, it can only be confirmed with `agend settings confirm <id>` on the host |

**The user's reading** ("the wizard also makes me deal with .env and the token"): in the wizard the token is entered in the browser. What breaks the flow is:
- step 3 asks for an env var name and hand-typed ids;
- step 4 sends the user to a host terminal;
- the "New connection" dialog (§2.6), which really does ask for `.env` editing.

### 2.6 Settings → Connections → "New connection"
`src/ui/settings-dialogs.js:434-462`.
- **Fields:** Type, "Adapter id" (placeholder `persona1`), "Bot token env var *" (placeholder `BOT_TOKEN_ENV`), "Group / guild id". There is no token field.
- **S1:** the dialog ends with **"Put the actual token in ~/.agend/.env under this env var, then Reload Fleet."** (zh-TW: "把實際 token 放到 ~/.agend/.env 的這個環境變數下，然後點重新載入。", `settings-strings.js:103,427`).
- **S1: the instruction does not work:**
  - there is no "Reload Fleet" button;
  - `.env` is read only at `startAll` (`fleet-manager.ts:5194`), and a reload does not re-read it;
  - the dialog writes `PUT /api/settings/fleet/channels` directly and shows "Saved", never offering "Restart AgEnD".
- **Hidden working path:** the connection's Settings → Advanced → "Bot token (never stored in the browser)" → "Stage the new token" → Apply already does verify and write-only storage (§4.1).
  - **S3:** for a connection with no running adapter, the server answers `restart_required`, and the UI shows that as success (`settings-apply.js:140`).
- **S3:** a connection row shows "Connected" or "Problem" from the whole fleet's state, not the connection's (`panel-settings.js:388-393`). It shows "Connected" next to "Token missing".

### 2.7 The first agent and the first conversation
- The sidebar ✎ ("New instance") or Settings "+ New agent" opens the create dialog and posts `POST /ui/instances` (`web-api.ts:734`).
- **S1/S2: creating an agent is also a confirmed write** (`settings-effect.ts:96-104`, `force: true`). The toast says "Sent for confirmation — a fleet admin confirms it in chat." even when only the host CLI can confirm.
- **S2:** signing a CLI in (`/login`) is chat-only (`web-commands.ts:9`). The web shows "Sign-in needed" but cannot start it.
- **S3:** "agent", "instance" and "Topic name" are used for the same thing.

### 2.8 A second connection, and ClassicBot
- **Second connection:** in the CLI, "Add another platform" or "Add persona bot". On the web, the wizard (with the S1 replacement risk) or "New connection" (manual `.env`).
- **S3:** the ClassicBot tab is read-only until a room exists ("No ClassicBot channels — start one with /start in a chat."). The web can create `classicBot.yaml`: General → ClassicBot stages `PUT /api/settings/classic/defaults`, whose `readClassic` accepts a missing file and whose writer creates it (`settings-api.ts:197-211,772-788`). Nothing on the ClassicBot tab says that is where to begin.

## 3. The top-right controls

**Panel header (right side):**

| Where | Control | Today | New user? | Proposal |
|---|---|---|---|---|
| Settings | `v1.22.0` pill | Opens the GitHub release | Understandable | Keep; move it into Help |
| Settings | Wand icon, "Setup wizard" (label hidden when narrow) | Opens the wizard | **No:** an unlabelled wand on narrow screens, and nothing says this is where to start | Rename to **"Add a bot"** (it only adds an agent plus a connection). Show it as a full-width call to action in the Connections tab when there is no connection, and on first run (§5.1) |
| Settings | ⓘ "Help" | Six bullet points | Partly. Item 6 says sensitive changes are confirmed "in chat", which is wrong when only the host can confirm | Fix the text; link to `docs/web-dashboard.md` |
| Chat | ⋯ "More actions" | Details / Start / Restart / Stop / Delete | OK | Keep |
| Chat | Model and effort chips | Change model or effort | They look like plain labels | Add a caret and hover styling |
| View | "Text size", "Usage", ⓘ | As named | OK | Keep |

**Sidebar header:** "New instance" uses a **pencil** icon, which reads as "edit". Use a plus icon and say "New agent".

**Right side of the Settings tabs:**
- Agents: "+ New agent". Rows have Settings, Pause/Wake, Start/Stop and ⋯ Delete. OK.
- Connections: "+ New connection" (see §2.6). Rows show "Token configured/missing" and a fleet-wide "Connected/Problem". Make the status per connection (§5.6).
- General: "Review changes" sits at the bottom. OK, but the sticky bottom bar ("Discard", "Apply changes") is the real control. Remove the duplicate.
- Developer: YAML/JSON toggle, Edit/View, Copy, and a button labelled just **"fleet.yaml"** (a download). Label it "Download fleet.yaml".

## 4. What already exists (to build on, not rebuild)

### 4.1 The connection secret flow
`POST /api/settings/connections/:id/secret/verify|apply`, in `settings-api.ts:468-549` and `fleet-manager.ts:17059-17260`.
- **verify:** calls Telegram `getMe` or Discord `/users/@me` (never `getUpdates`). It returns a challenge valid for 5 minutes, bound to the session, an idempotency key and the adapter generation.
- **apply:** needs the `verification_id`. It writes the token through `SecretStore` (atomic, mode 0600, reserved names refused, optional allowlist) under the channel's `bot_token_env`, sets `process.env`, and rebuilds the adapter.
- **Outcomes:** `applied`, `restart_required` (no adapter yet), `rolled_back` or `rollback_failed`.
- The token is write-only and only ever logged redacted.

### 4.2 Provider keys
`/api/settings/provider-secrets` uses the same pattern for a fixed registry (Groq, OpenAI, Anthropic), off unless `web.provider_secrets: true`.

### 4.3 Confirmation (#1423)
- Sensitive writes answer `202 pending_confirmation`: channel changes that affect a connection's access or credentials, secret and binding applies, the quickstart commit, and new agents (`settings-effect.ts`). Ordinary metadata and no-op changes pass without it.
- Confirmation goes to chat (a General topic with fleet admins, excluding the connections being changed) or else to the host (`agend settings confirm <id>`). There is deliberately no HTTP confirmation.

### 4.4 Discovery helpers
- `listDiscordGuilds` (`/users/@me/guilds`).
- Telegram `getUpdates` detection, refused while the fleet polls the token.
- `verifyDiscordToken` already returns the bot's id, which is the application id an invite URL needs.

### 4.5 The public link
The public link **can** call secret and binding verify/apply, and quickstart probe/plan/commit (`public-web-gateway.ts:27-40`). Confirmation still applies.

## 5. Design

### 5.1 First run
- On a fleet with no connection (and on a web-only fleet), Chat and Settings open with a first-run card:
  - "Connect a chat app" (Telegram / Discord), which opens the "Add a bot" flow;
  - "Use the web only", which hides the card.
- The card stays until a connection exists or it is dismissed. `noInstancesHint` becomes this card's agent-side counterpart.
- The CLI points to the web:
  - `postinstall` ends with "Next: run `agend quickstart`";
  - `quickstart` and `setup` end with the dashboard URL and "sign in with `agend web --code`, or send /dashboard to your bot".

### 5.2 Entering a bot token in the browser
One component, used by "Add a bot", by the "New connection" dialog, and by a connection's "Replace token".

- **The field:**
  - A password input (`type=password`, `autocomplete=off`, a show/hide toggle, `spellcheck=false`).
  - It is sent once, to verify and then apply, never stored in the page, and cleared after use.
  - Afterwards the connection shows **"Token set · @botname"** with a **Replace** button. The value is never shown again; the server has no read path.
- **Verify before saving:**
  - Telegram `getMe`, Discord `/users/@me`, through the existing verify endpoint.
  - The form shows the bot's name (and avatar for Discord) before anything is written: "This is @agend_helper_bot — continue?"
  - A bad token is refused with the platform's reason (401 → "Telegram did not accept this token").
- **Storage:** the existing `SecretStore` writes `~/.agend/.env`. **The env name is generated, not asked for:**
  - `AGEND_<PLATFORM>_<ID>_TOKEN`, for example `AGEND_DISCORD_PERSONA1_TOKEN`, upper-cased, with the id sanitised to `[A-Z0-9_]`;
  - unique against the whole secret namespace, re-checked server-side when the token is applied:
    - every configured channel's `bot_token_env`;
    - the provider registry;
    - **every key already in `~/.agend/.env`**, including orphaned keys left by removed connections;
    - `SecretStore`'s reserved names.
  - A collision gets a numeric suffix.
  - The name stays a valid key of bounded length: the id part is truncated so the whole name is at most 64 characters, with a short hash suffix when truncation could make two ids equal.
  - The env name moves to "Advanced" (read-only, with a copy button) for people who manage `.env` themselves.
  - Existing connections keep their names.
  - **This removes the S1 replacement risk**: the wizard and "New connection" can no longer address another connection by name.
- **Matching:** "New connection" and the wizard **create** a connection. They never match an existing one by env name. Changing an existing connection's token is "Replace token" on that connection.
- **Activation without a restart:**
  - A new connection is hot-added. `rebuildAdapterForSecret` already constructs adapters for existing connections; P6 extends it to "no adapter yet".
  - Until then, a `restart_required` outcome is shown as such, with a "Restart AgEnD" button, never as success.
- **Confirmation (#1423)** stays. The first setup is where it hurts (§5.4).
- **The public link:**
  - Secret entry is **refused on the public link**. Server-side, every route that receives a token returns 403 for a `gateway`-surface session:
    - connection `secret` and `binding` verify and apply;
    - provider-secret verify and apply;
    - `POST /api/settings/quickstart/probe`, whose `verify`, `guilds` and `await-telegram-start` actions all take `body.token` (`quickstart-api.ts:342-365`);
    - the quickstart commit.
  - Refusing only the commit would still let the token cross the gateway during verification and discovery.
  - The UI hides the token field and the wizard's credential step there, and shows "Bot tokens can only be entered on this computer's own dashboard (http://127.0.0.1:…)".
  - A token typed on a phone over a tunnel crosses the internet, and the public link is meant for using agents, not for re-keying them. Today these routes are allowed (§4.5); decision Q2 lets the user keep that.
- **Redaction:** the token never enters logs, the event log, `pending` diffs or the confirmation card. Diffs show `AGEND_DISCORD_PERSONA1_TOKEN: (new value)`, as `settingsChangeDiff` already does for secrets.

### 5.3 Discord: invite link, intents and ids
- **Invite link:**
  - After a successful verify, the form shows **"Invite @bot to your server"**: `https://discord.com/oauth2/authorize?client_id=<bot id>&scope=bot%20applications.commands&permissions=<P>`, opened in a new tab.
  - `P` is one constant shared with the CLI. Today's persona set (View Channel, Send Messages, Send Messages in Threads, Manage Messages, Read Message History, Add Reactions, Use Application Commands) gains Manage Channels (the main bot creates topic channels) and Attach Files (the adapter sends files). P3, which introduces the constant, checks it against every adapter call.
  - Never Administrator.
- **The server:** after the user clicks invite, the form polls `/users/@me/guilds` every 2 s (for at most 2 minutes, with a "Check again" button) and selects the new server automatically. Several servers: a dropdown.
- **The General channel:**
  - The form lists the server's text channels (`GET /guilds/{id}/channels` with the bot token) in a dropdown, defaulting to one named "general" if there is one.
  - Today it is a typed id.
- **Your user id (the admin):** a **claim code**, which replaces Developer Mode. The form shows a one-time code and "Mention @bot with `claim ABC123` in the channel you want as General". A mention carries the message text even without the Message Content intent.
- **The bootstrap lane.** At claim time the connection is not applied yet, so no adapter of the fleet is reading this bot. The claim is read by a **pending-claim listener**:
  - **What it is.** A narrowly scoped, temporary reader for this one bot, opened after the token verifies and before the setup is committed: a Telegram long-poll on `getUpdates`, or a Discord gateway session with only `GUILDS` plus mentions.
  - **What it accepts.** It admits nothing but a `claim <code>` message: no command, no delivery, no inbound to any agent.
  - **Binding.** It is bound to the verified bot id, the pending setup id and the code.
  - **What a valid claim records.** The author becomes the first admin and allowed user, and the chat (Telegram group or topic; Discord guild plus channel) is recorded into the pending setup. The setup is then confirmed and committed as usual.
  - **Limits.** At most 5 wrong codes, then the code is retired. The code expires after 10 minutes, and is single-use.
  - **Retirement.** The listener closes on success, cancel, expiry or commit. It also closes, and never starts, when that token is already polled by a running adapter of this fleet; there, the running adapter handles the claim.
  - **Telegram.** Telegram allows one poller per token, so the listener must be closed before the fleet starts polling it.
- **The fallback** when the listener cannot run (for example, a Discord gateway refused): the existing Telegram "Detect from a message", and the Discord server and channel pickers (§5.3), with the user id typed.
- **The Message Content intent** cannot be set through the API.
  - The form says so next to the invite button, with a link to the Bot page of the portal.
  - The adapter's gateway close code 4014 (disallowed intents) becomes a connection status: "Turn on Message Content Intent in the Discord developer portal → Bot".

### 5.4 Telegram ids, and the first confirmation
- **Group and user:** the claim code ("add @bot to your group, then send `/claim ABC123` there") gives both the group id and the user id, through the pending-claim listener (§5.3) for a new bot, or through the running adapter for a token the fleet already polls. The current "Detect from a message" remains as the fallback.
- **The first confirmation:** on a fleet whose only chat is the one being set up, confirmation can only come from the host CLI (§2.5, §2.7). Options for the user (Q1):
  - **A. Keep host confirmation, and make it easier to do.** Confirmation stays an explicit action on one exact proposal:
    - The card shows `agend settings confirm <id>` with a copy button and a QR code.
    - The CLI prints that proposal's summary (the same diff as the card) and asks y/N before confirming.
    - If a `--latest` shortcut is added, it lists the pending proposals. With more than one pending it refuses and asks for an id. With one, it shows that proposal's summary and still asks y/N, bound to the proposal id and digest it showed, so a proposal that changed or was replaced in between is not confirmed.
    - Opening the dashboard (`agend web`) never confirms anything.
    - Security is unchanged.
  - **B. Confirm in the browser for the very first setup.** This **relaxes #1423's independent confirmation** and needs the user's approval (Q1). An empty fleet still has host files, CLI credentials and the authority to run commands to protect. If chosen, its conditions are:
    - **A one-use bootstrap admission**, minted when the data directory is first initialised. It is consumed by the first successfully applied setup and recorded as consumed in the data directory. It never reactivates because the roster later becomes empty again (removing every connection and agent does not bring it back).
    - **Bound to a fresh host-origin session:** loopback, signed in with a host-issued code within the last 15 minutes, `local` surface, never the public link.
    - **Bound to the exact setup proposal** the page shows (id and digest).
    - **Re-checked under the settings ownership fence when it is applied:** still unconsumed, same session, same proposal, no connection applied in between.
  - **C. Claim-code confirmation.** The setup is confirmed by the claim message in the new chat. That proves the person controls the chat and the bot, but not the host.
  - *Proposal:* A in all cases. B for the very first setup only if the user accepts relaxing #1423 under the conditions above. This is a decision (Q1), not a recommendation to implement B now.

### 5.5 Agents and `/login`
- A new agent from the web keeps confirmation but uses the corrected text ("Confirm on the host: …" when there is no chat).
- Under option B, the first agent created with the first connection is part of the same confirmed setup.
- `/login` from the web (a later phase): the Needs-you "Sign-in needed" item gets a "Sign in" button that runs the backend's login flow and shows its device code or URL in the page. That is out of scope for P1–P3.

### 5.6 Smaller fixes
- **Wrong or misleading text:**
  - Replace the `envHint` text ("…then Reload Fleet.") with nothing; the token field (§5.2) supersedes it.
  - "Sent for confirmation — a fleet admin confirms it in chat." and Help item 6 should name the actual confirmation channel: chat or host.
  - Fix the `init` end text (the systemd unit name, no Discord plugin).
- **Status:**
  - `restart_required` is not success.
  - A connection row's status should be that connection's: Token missing / Starting / Connected @bot / Rejected (401) / Missing intent / Not in a server.
- **Wizard:** a re-run must not overwrite an existing agent. Step 1 offers "use existing agent X" or "new agent (name)".
- **Words:** "agent" everywhere in the UI ("instance" only in the CLI and API); "Topic name" becomes "Name".
- **CLI and docs:**
  - The quickstart step counter.
  - The README should not tell the user to `agend fleet start` after quickstart has installed the service, and should add the web steps.
  - The website getting-started should match what quickstart asks.

## 6. Pull requests

Each item is one PR, in order. Sizes are rough. Every PR carries `Author-instance:`, the checklist and reverse-mutation evidence. UI PRs carry a scratch-HOME, private-port browser smoke with screenshots.

| # | PR | Content | Size | Depends on |
|---|---|---|---|---|
| P1 | **Token field + generated env name** | The shared token component (password, verify → bot name, write-only "Token set · @bot", Replace). "New connection" uses it and drops the env-name question and the `.env` instruction. The wizard step 3 uses it; generated unique `AGEND_<PLATFORM>_<ID>_TOKEN`; the wizard never matches an existing connection by env name (fixes the S1 replacement). `restart_required` is shown with a Restart button. Tests: a second wizard run never replaces a connection; generated names are unique and never reserved; the token never appears in a response, a diff or a log | M (2 days) | — |
| P2 | **Public link: no secret entry** | `gateway`-surface sessions get 403 on every token-bearing route: secret/binding and provider-secret verify/apply, quickstart **probe** (`verify`, `guilds`, `await-telegram-start`) and commit; the UI hides the token controls and explains. Tests on the real gateway route for each | S (½ day) | — |
| P3 | **Discord invite + server/channel pickers** | The shared permission constant (CLI and web); the invite button after verify; guild polling; a channel dropdown from `/guilds/{id}/channels`; the intent note; close code 4014 → connection status | M (1–2 days) | P1 |
| P4 | **Claim code** | One-time code bound to a pending setup and bot. The **pending-claim listener** (§5.3): a temporary, claim-only reader for a verified but not yet applied bot, with no command or delivery admission, bounded attempts, and retirement on success, cancel, expiry or commit, and before the fleet polls that token. Plus the same handler in running adapters for already-polled tokens. The author → admin + allowed user, the chat → group/General; the form turns green. Replaces typed user, group and channel ids | M (2–3 days) | P1 (verify). Independent of P6: the listener does not need hot-add |
| P5 | **First confirmation** | Per decision Q1. A: the card with copy/QR; the CLI shows the proposal and asks y/N; an optional `--latest` that refuses when several are pending. B, only if approved: the one-use bootstrap admission. Tests for B: refused after it was consumed (also once the roster is empty again), from the public link, from an old or non-host session, for a different proposal, and on a re-check failure at apply | S–M (1–2 days) | P1 |
| P6 | **Hot-add a connection** | Construct and start an adapter for a newly applied connection without a restart (extends `rebuildAdapterForSecret` to "no adapter yet"); per-connection status in the row | M (2 days) | P1 |
| P7 | **First-run and wording** | The first-run card; CLI and postinstall "next step" lines; the dashboard URL at the end of quickstart and setup; "Add a bot" naming; plus icon; Help text; confirmation toast text; the wizard's existing-agent choice; Developer "Download fleet.yaml"; quickstart step counter; README / getting-started / `init` fixes | M (1–2 days) | P1, P5 |

**Suggested order:** P1 → P2 → P3 → P4 → P5 → P6 → P7. P2 can go in parallel with P1.
- **The first executable path** is P1 + P4 + P5(A). The user enters and verifies the token, claims the chat and admin with a code (through the pending-claim listener), confirms once on the host, and the connection starts. A restart prompt is needed until P6 adds hot-add.
- **With B approved:** no host command at all.
- **After P3:** Discord also has invite and picker help, and no Developer Mode is needed.

## 7. Decisions for the user

1. **Q1 — The first confirmation:**
   - A, an explicit host confirmation made easier;
   - B, a one-use in-page bootstrap confirmation that relaxes #1423;
   - C, a claim message in the new chat.
   - *Proposal: A; B only if relaxing #1423 for the first setup is accepted under §5.4's conditions.*
2. **Q2 — Bot tokens on the public link:** refuse (the proposal) or allow, as today, with confirmation.
3. **Q3 — Generated env names:** may the UI generate `AGEND_<PLATFORM>_<ID>_TOKEN` and hide the name under Advanced, or must the user still be able to choose it at creation?
4. **Q4 — The claim code:** may a message in the chat make its author the connection's first admin, with a code shown only in the signed-in dashboard and valid 10 minutes?
5. **Q5 — The name in the corner:** "Add a bot", "Connect a chat app", or keep "Setup wizard"?
