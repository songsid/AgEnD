# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.2.0] - 2026-10-16

### Upgrade Notes
- **Kiro upgrade recovery (#906, #1624, #1800).** Resumed conversations keep their saved agent: AgEnD does not automatically type /agent swap, and does not retry that suspended switch on later launches. New instances without identity or launch history may adopt an unclaimed latest conversation only when peer-directory ownership is known safe; a conflict or unknown ownership starts fresh. Existing conversation claims prevent another instance taking the same ID. Untagged legacy steering files are retained with a warning; remove them manually only after coordinating all fleets using the directory. See the Kiro upgrade-recovery guide.
- **[Behaviour change] `/view` no longer takes the web token in its URL or a text box.**
  Saving a profile or avatar (and the sidebar order) used to work with the
  fleet-wide `web.token` sent as `?token=` — which `/dashboard`'s "View (edit)" link
  put in the address bar, and which `view.html` then appended to *every* API
  request and kept in `localStorage`. Writes now need a signed-in session (with
  the same CSRF checks as the other panels) or `X-Agend-Token` from a script; a
  `?token=` is refused as a write credential, the token box is gone, and Edit sends
  a signed-out visitor to the sign-in page and back. **Reading `/view` stays open by
  default** (the live terminal capture included); the new `web.view_access: session`
  requires a sign-in for reads too. The unused `view.token` file (a read-only
  credential nothing ever accepted) is no longer written, and an old one is
  deleted at startup.
- **[Behaviour change] The web panels sign in with a one-time code, and a
  dashboard link no longer carries a credential.** `/dashboard` used to paste the
  fleet-wide `web.token` into `/view?token=`, `/settings?token=` and `/ui?token=`
  — into chat history, browser history and screenshots, where it stayed valid
  until `agend web-token rotate`. It now gives the sign-in page and an 8-character
  code that works once and expires in 5 minutes; typing it there starts a
  **server-side session** (an opaque random id the server can expire, list and
  revoke — not the old cookie that was `sha256(web.token)`, identical on every
  device and valid until rotation). **Everyone signs in once after upgrading:**
  the old cookie is no longer accepted. Sessions end a set time after sign-in or
  after a set idle time, whichever comes first (on the dashboard reached directly, 48 hours each by default and set
  by `web.session.local.*`; a public-link session lasts 4 hours, 30 minutes idle; see #1670), survive a fleet restart, and every write from a page now
  also needs a per-session `X-Agend-CSRF` header and a matching `Origin`.
  `/dashboard revoke` (on Discord: `/dashboard` with `action: revoke`) signs every browser out; `agend web --code` prints a code on
  the host; `agend web-token rotate` still kills every session at once. The
  header token (`X-Agend-Token`) is unchanged for the CLI and scripts. **A
  `?token=` in a URL is no longer a credential anywhere on `/ui` and `/settings`:**
  an old `?token=` link or bookmark opens the sign-in page — sign in there once
  with a one-time code from `agend web` or `/dashboard`. `agend web` now prints a
  code and opens `/signin` instead of a token link. New sign-ins are announced in the General topic
  (`web.notify_login: false` to silence).
- **The first start on 2.2 tells General about web chat, once (#1366).** Each chat platform's General gets one short
  message: what web chat is, that it is the same conversation as the topic, and that `/dashboard` signs you in. It is
  recorded in `~/.agend/upgrade-notices.json` and never repeats; a platform with nowhere to post fleet notices is told
  once it has one. A message that fails to send is tried again at the next start.
- **An empty ClassicBot allowlist now asks General for approval (#1418).** Fleets that relied on omitted or empty `allowed_users`, `allowed_groups` or `allowed_guilds` being open must approve new starts with General's Allow / Allow+admin / Ignore buttons, or add explicit grants. ClassicBot admins may start directly; existing registered channels keep working. Telegram private requests now have the same approval buttons as groups, with the outcome sent back to the requester. Allow+admin grants ClassicBot admin rights, not fleet admin. Approval does not start an agent automatically: retry `/start` (Telegram groups: `/start@OurBot`, by a ClassicBot admin). Discord DMs remain unsupported. Configure a fleet admin on General's owning adapter to approve requests.
- **The AgEnD runtime requires Node.js ^22.14.0 || ^23.6.0 || >=24** for better-sqlite3 v13’s Node-API 10. Supported bundled-runtime platforms normally do not need a PATH Node upgrade: AgEnD uses its private Node. Without an available bundled runtime, prepare a qualifying system Node before installing. Follow the 2.2 upgrade guide for your source version; older updaters have an unlink-first failure window.
- **`better-sqlite3` upgraded to v13 (N-API, `^13.0.3`).** The native SQLite binding now ships prebuilt N-API binaries for every supported platform inside the npm package; no separate GitHub download occurs at install time, and no compiler is needed. The prebuilds are ABI-stable across Node versions, so macOS installs no longer require Xcode Command Line Tools.
- Web Apply for sensitive Settings is now a proposal, not a completed write (#1423). Local and public sessions need a General fleet admin or `agend settings confirm <id>` on the host. Header-token automation cannot authorize sensitive edits. Handle `202 pending_confirmation`, retain the same idempotency key for lost-response retries, and wait for the terminal outcome. Secret fields must be re-entered after rejection/expiry. Pending requests are memory-only and must be resubmitted after restart. First-time Setup requires host confirmation and an explicit Start action; no confirmed chat route means host confirmation, never auto-apply.
- **From 2.1.0–2.1.11, or on a platform without a bundled runtime, upgrade with `npm install -g @songsid/agend@<2.2 version>`, then `agend install` — not with `agend update` or `/update` (#1487).** From 2.1.12 on Linux (glibc 2.28+) or macOS 11+, x64 or arm64, `/update` or `agend update` is enough once 2.2.0 is the stable release; see [Upgrading to 2.2](upgrade-2.2.md).
  - 2.1's updater removes the installed AgEnD *before* it installs the new one. If that install fails for any reason (AgEnD 2.2 refusing your host, a network, registry or proxy problem), nothing is left: no `agend` command. The running fleet lasts only until its next restart or login, and then the service cannot start. This was reproduced on a real Mac, where launchd reports `EX_CONFIG`.
  - A direct `npm install -g` has no removal step; a refused install keeps your current version.
  - **If it already happened:** run `npm install -g @songsid/agend@2.1.12` (or the 2.2 version, once your host can install it), then `agend install`. Your data directory is untouched.
  - AgEnD 2.2's install refusals now say this in plain words, with these commands, when 2.1's updater started the install. See [Upgrading to 2.2](upgrade-2.2.md).
- **Old-updater compatibility on hosts without bundled Node (#1488).** Bundled runtimes cover Linux glibc 2.28+ and macOS 11+, x64/arm64. On other platforms, a missing private runtime requires a qualifying PATH Node (^22.14.0, ^23.6.0 or >=24); prepare it first, then follow the manual path in the 2.2 upgrade guide. Direct npm installation alone does not remove the runtime requirement. Alpine/musl and non-systemd Linux remain unsupported. The 2.1.12 updater unlinks first, so a later install refusal can leave no agend command.
- **musl Linux such as Alpine, and Linux hosts without systemd, are not supported.** AgEnD may still install there on a Node 22.14+, but it is not tested or promised to work. If you run it there anyway, the [upgrade guide](upgrade-2.2.md#1-before-you-upgrade) lists two workarounds: remove `~/.config/systemd/user/com.agend.fleet.service`, then run `agend start`, after updating from 2.1.x; and `apk add procps` so `agend update` can read process start times. (#1912)

### Added
- **`delivery_status` now shows when the CLI actually took a steer, not just that it accepted it (#1201).** A steer, or
  a message handed to a busy CLI's own queue, is accepted into the CLI's input long before the model reads it. Claude
  Code takes it at the next tool boundary or when the turn ends. AgEnD now watches the CLI's transcript (claude-code,
  codex) from where the delivery began:
  - When the delivery's own marker shows up taken, the row gets `consumed_at` and `consumed_via`: `turn`, as its own
    turn, or `mid_turn`, absorbed into the running one.
  - An `uncertain` row becomes `delivered` then. Its failure notice is withdrawn if it has not been sent yet.
  - Only an exact match counts. A miss changes nothing.
  - The watch reads in bounded chunks, looks less often at a transcript that stops growing, ends after 30 minutes,
    and is capped across the fleet.
  - `delivery_status` also shows `delivery_mode` (`steer` / `idle_queue`) and `submission_mode`.
- **A steer Claude Code took mid-turn now counts as consumed after a restart too (#1201).** Claude Code records that
  case as an absorbed queued command, not a user message. Restart reconciliation used to read it as merely queued and
  left the delivery `uncertain` with a ⚠️.
- **A Log tab for each instance shows its work step by step (#1218).**
  - The new 「紀錄」/"Log" tab sits between View and Details. It shows each prompt, the agent's replies (never its thinking), every tool call with its arguments and result, errors, where each turn ended, and fleet events such as a crash, a restart or a waiting prompt.
  - Steps are read on demand from the agent's own transcript when the tab is open, and update live while someone is watching. Secret values (keys, tokens, passwords, long random strings) are masked; long text is cut, with "Show more".
  - It is off by default (`web.log_tab`). Off, it does no work at all. A fleet admin turns it on in Settings → Web, and that change is confirmed like any access change. Once on, it is also available over the public link.
  - Supported: claude-code and codex now. For other backends the tab shows fleet events only. For kiro it also says why: its own steps are shown only once AgEnD can prove which conversation the instance is in now, which no kiro launch allows yet.
- **A fleet with no chat platform works from the web dashboard alone.** With no `channel` / `channels` configured,
  an agent's reply now goes to the web chat (and the agent is told it was sent) instead of being refused with
  "Channel adapters are not ready — retry shortly" forever.
- **Web chat: answer the fleet's prompts from the dashboard.** When an instance looks hung, exits on its own, or is
  stuck on an interactive prompt, the buttons Telegram shows (*Force restart* / *Keep waiting*, *Restart* / *Ignore*,
  *Confirm* / *Cancel*) also appear in that instance's web chat. They are the same prompt, not a copy: one answer counts,
  whichever surface gives it first; the other's buttons collapse to the outcome; and the prompt expires on both at
  once. Only these instance-health prompts are offered there — a `/clear` confirmation, login, Classic group
  approval, tips and the `/model` / `/effort` menus stay where they were asked. A dashboard answer needs the
  signed-in session and its CSRF token, names the instance, and must be one of that prompt's own buttons.
- **Web chat: Markdown, several lines, and history that survives a reload.** Messages in the dashboard's chat now render
  Markdown — bold, italics, `code`, code blocks, lists, quotes, links (http/https/mailto only, opened in a new tab) — and
  nothing in a message can add markup of its own (the text is escaped before any formatting is applied). The composer takes
  several lines (Enter sends, Shift+Enter adds a line) and gives the text back if sending fails. A reload no longer empties the
  chat: the fleet keeps each instance's recent messages (`GET /ui/history`, in memory, bounded), and a stream that drops and
  reconnects is sent what it missed. Long agent replies are no longer cut at 2,000 characters in the web chat (16,000 now).
- **Web chat: see where your message got, see that the agent is working, and stop it.** Each message you send
  from the web chat gets ticks, the same lifecycle a Telegram message shows as reactions: ◷ waiting behind another
  message, ✓ handed to the agent, ✓✓ the agent has it, ! not delivered (each labelled for screen readers, and
  kept across a reload). While the open chat's agent is working, a "*name* is working…" line shows above the
  composer with a **Stop** button that does what Telegram's cancel button and `/cancel` do: Esc into the CLI, and
  the messages still waiting are dropped — their ticks turn to ⊘. (Stop is `POST /ui/cancel/<instance>`, behind
  the same session and CSRF check as every other dashboard write; it is not the instance's Stop, which ends its
  process.) Delivery reports for web messages no longer try to react on Telegram with an id that was never a
  Telegram message.
- **Web chat: send files and images, and see the ones the agent sends back.** The composer has a 📎 button, and
  files can also be pasted or dropped onto the chat (up to 5 per message, 10 MB each, 25 MB together; PNG, JPEG,
  GIF, WebP, PDF and text files). The agent gets them exactly as from Telegram — the file in the instance's
  workspace inbox, a `[📷 Image: …]` / `[📎 File: … → …]` line and `image_path` / `attachment_path` — and files the
  agent attaches to a reply are shown in the web chat (images inline, others as downloads). The type is read from
  the file's bytes, not from its name or the browser's word for it; the stored name is chosen by the fleet; and a
  file can be fetched back only by an id the fleet issued for it (`/ui/file/<id>`), never by a path. Anything that
  is not one of the four image types is served as a download, never rendered. A file attached but not sent within
  30 minutes is deleted, also across a fleet restart: an upload is stored as `web-pending-…` until a message takes
  it, and those left over are swept at startup once 30 minutes old (#1273). Sent files follow the inbox's 7-day
  rotation, like Telegram's.
- **Reply buttons: an agent can offer choices people click (#1266).**
  - `reply` takes `buttons` (up to 10, `{ label, value? }`). They appear in the web chat, on Telegram (inline keyboard) and on Discord (components).
  - A click reaches the agent as a message from whoever clicked (`[button] <label>`). The first permitted click answers for everyone, and every surface then shows the choice and who made it.
  - Anyone who may message the instance there may click. Buttons expire after 24 hours, survive a restart, and cannot be replayed.
  - Where buttons cannot be shown, the choices are added to the text.
- **Web chat: commands and quick actions (#1269).** Typing `/` in an instance's chat opens its own chat commands, the same ones its Telegram/Discord topic accepts. They run through the same handlers and command table (#754/#1148).
  - The commands: `/ctx`, `/compact`, `/clear` (asks first), `/model`, `/effort` (with nothing after them, a list to choose from), `/cancel`, `/btw`, `/steer`, `/pause`, `/wake` and `/save`.
  - Anything else starting with `/` is still sent as a message. Fleet-wide commands stay in General.
  - Quick actions: the model and effort in the chat's header open their lists. **Compact** and **Clear…** appear once the instance's context is 70% used.
  - Over the temporary public link, a message starting with `/raw ` is refused: it would reach the CLI without the `[user:]` envelope. `/save` is refused there too.
- **Web chat: tables, nested lists and highlighted code (#1269).** Agent replies with a Markdown table now show as a
  table (header, `:--`/`--:`/`:-:` alignment, cells with their own bold/links/`code`; a pipe inside a cell is `\|`), lists
  nest by indentation (bullets and numbers mixed, up to six levels), and fenced code in js/ts/json/python/sh is
  highlighted. No library and nothing from a CDN: the same escape-first renderer, with only fixed tags and classes
  added, so nothing in a message can still produce markup of its own.
- **Web chat: preview an agent's HTML (#1306).** A ` ```html ` block in an agent's reply gets a card under it:
  **Preview** runs the HTML in a sandboxed frame served by a separate local listener (`web.preview_port`, default
  `health_port + 1`), so it cannot use the dashboard sign-in or act on the dashboard; **Stop** closes it; **Download**
  saves it as `reply.html`. Previews are **off on every device until that device opts in** (sidebar or the card's menu),
  run only on a click, and carry a banner saying they may be able to send data out and can slow or freeze the tab.
  Only replies the fleet marks as an agent's get a card — HTML from people is only ever code. Through a tunnel or
  proxy, previews need `web.preview_origin` (a separate host name); otherwise the card says why they are off.
- **Web chat: a chat-first layout, light and dark (#1307, layout part).** The conversation is a centred column with
  your messages as bubbles on the right and agent replies across it (each with Copy); code blocks show their language,
  with Copy and Wrap, and fold when longer than 30 lines; the view follows new messages only while you are at the
  bottom, with "↓ N new" when you are not; while the agent works the composer's Send becomes Stop (Send comes back
  when you type). The sidebar can be hidden (remembered) and is a drawer on a phone. The dashboard follows the
  device's light or dark setting, or a per-browser choice (`/assets/theme.js` sets it before the page paints), uses
  the system font stack, and has no inline `style` attribute left (#1300).
- **Web chat: phones, keyboards and screen readers (#1307, mobile + a11y part).** On a phone the on-screen keyboard
  resizes the page instead of covering the composer (`interactive-widget=resizes-content`), the layout keeps clear of
  the notch and home bar (safe-area insets), and the composer's text is 16px so iOS does not zoom. Esc stops the
  agent's reply while it works (not while a form or menu is open, not mid-IME). The sidebar's rows are reachable by
  Tab and open with Enter/Space; the phone drawer keeps focus inside and returns it to ☰ on close. The message list
  is a log that is not read out message by message; one polite status line announces the coarse events (started,
  finished, replied, waiting for your input).
- **Web chat: the agent's turn, and attachments (#1307, turn-status part).** The working line counts how long the agent
  has worked (from when the page saw it start), reads "Stopping…" after Stop until the agent is idle, and says when it is
  waiting on its terminal (a permission question, a login, a dialog) — with a "needs you" badge in the sidebar, labelled
  as read from the terminal. Dragging files over the chat shows where they go; each waits as a chip with its name and
  size; a paste over 10,000 characters is attached as a text file (it can go back in as text). On a fleet with no chat
  platform, the hang, clean-exit and interactive-prompt prompts are now asked on the dashboard (they were not asked
  anywhere); an interactive prompt only when there is a General to help.
- **Web chat → ClassicBot channel echo (#1320 part B).** Successful web sends to a classic instance are copied to that instance's ClassicBot channels, but only to entries with `web_echo: true` (default off, per entry). The copy goes through the channel's own adapter with mention suppression, in the same before-reply ordering lane as part A, and failures never block the web send. No-re-entry reuses part A's shared helper verbatim (`neutralizeWebEchoText`, `formatWebChannelEcho`, `isWebChannelEcho`, fixed `WEB_ECHO_PREFIX`): visible-ASCII mention neutralisation in preview and attachment names, fleet-bot-author plus prefix ingress drop. The opt-in lives in classicBot.yaml and Settings (non-boolean rejected, channel restart on change, second confirmation for group channels in the page).
- **Web chat → fleet topic echo (#1320 part A).** Successful web sends are copied to the owning Telegram or Discord topic, with a five-second total ordering budget before replies proceed. On timeout queued copies are dropped; an already in-flight copy may arrive late, with its outcome logged. `web.echo_to_channel` defaults to true and is editable in Settings without persisting untouched defaults. Echo failures do not block web delivery. Visible mention/command labels and a fleet-bot-author/prefix ingress check prevent echoes from starting another turn, including sibling bots and replays; bot-prefix candidates are quarantined while any configured same-platform bot identity is unknown, without affecting humans. ClassicBot and web-only fleets are excluded.
- **Retention for delivery-outbox.db and the Task Board (#1335).** Both stores grew without bound: `delivery-outbox.db` was accumulating ~2.5 MB/day and the Task Board had 1,099 rows going back to April. Terminal deliveries (`delivered`/`failed`) and `done`/`cancelled` tasks older than `defaults.retention_days` (default 30) are now pruned once at fleet startup and daily after that. `uncertain` rows and non-terminal deliveries are never pruned. Deliveries with still-open reply obligations are skipped until the obligation is closed. Cancelled task prerequisites of live tasks are also kept. Pruning runs in chunks of at most 500 rows and yields between chunks so it never stalls the event loop. When a `delivery_status` query returns no results for a `delivery_id`, the fleet now checks whether the row was pruned and responds with "older than the retention window; record pruned" — but only to the original source or target of that delivery — rather than "Delivery not found". Other lookups can still return "Delivery not found" for hidden, expired or absent rows; that result does not prove non-delivery. The unfiltered `task list` is now capped at 100 rows (most recently updated first) with a note about how many were omitted; filtered lists are uncapped.
- **Task Board tool is now context-efficient (#1336).** The unfiltered `task list` now returns only live tasks (open/claimed/blocked) by default — done/cancelled appear only when `filter_status` includes them. `filter_status` accepts an array for multi-status filters. Each row in the list is compact (`id`, `title`, `status`, `assignee`, `priority`, `updated_at`); pass `verbose: true` for full rows, or use the new `get` action to fetch one complete record. Write operations (`create`, `update`, `claim`, `done`) return a small ack `{id, status, updated_at}` instead of the full object. Task IDs can be abbreviated to their unique 8-hex prefix. `done` now works on open tasks as well as claimed ones.
- **Opt-in fleet CPU profiles for unexplained event-loop stalls (#1338, part of #1235).** The local operator can set `AGEND_CPU_PROFILE_SECONDS=60` for a cold `agend fleet start`; omitted means off. In-process 100 Hz recording stops after at most 30 minutes (when the main thread can service the deadline), with no inspector listening port. Private files under `AGEND_HOME/profiles` are capped at 20 MiB and rotated to five; the file cap does not cap V8's recording memory. Agent sessions cannot enable it through their inherited environment; no chat/web/MCP trigger is added.
- Record a bounded CPU profile inside a running fleet with `agend profile [seconds]`, or the admin-only General `/profile` command (Discord native slash, Telegram typed). Both share the existing startup recording owner, refuse concurrent captures, and retain the duration/artifact/shutdown limits. CLI control uses a same-user private Unix socket; agent environments are refused. No restart, web/MCP control or inspector port is needed.
- **Web chat: talk to your agents from the browser (#1366).** The dashboard's `/ui` is a chat with any instance: pick
  it in the sidebar and type. It is the same conversation as that instance's Telegram or Discord chat — a message sent
  from the web is echoed into the topic as `🌐 web-user: …`, the agent's replies show in both, and you can switch
  between phone and computer mid-conversation. Files and images, Stop, the ticks that show how far a message got and
  the answers to the fleet's prompts all work there (see the web chat entries below). Sign in with a one-time code
  from `/dashboard` (fleet admin) or `agend web`. The dashboard listens on `127.0.0.1`; for a phone, see
  [Reaching it from elsewhere](web-dashboard.md#reaching-it-from-elsewhere).
- **Web chat: a short tour on the first sign-in (#1366).** The first time `/ui` opens on a device, a small card walks
  through five things — pick an instance, it is the same conversation as Telegram/Discord, attach files, Stop, and the
  *needs you* badge — outlining each on the page. Got it, Skip or Esc ends it for that device; **Tour** in the sidebar
  shows it again. It blocks nothing, and it is styled by the page's own stylesheet (no inline style, #1300).
- General admins can opt into a temporary public dashboard link from `/dashboard`, with link/code delivered privately, a fixed two-hour lifetime (1–480 minutes), pinned cloudflared, exposure-scoped sign-in and mandatory public login notices. Public View requires sign-in, previews stay private, and expiry/revoke/shutdown closes access. Cloudflare terminates TLS; this grants full web-admin access, and platform failures deny public sign-in.
- **"Needs you": one list of everything waiting on you, kept live in General (#1386).** Each bot keeps a single
  message in its own General that lists what its instances are waiting on: a fleet prompt (not responding, exited,
  waiting at its terminal), a permission, dangerous-command, sign-in or other dialog, an instance paused for sign-in
  or crashed, and deliveries the fleet could not confirm or deliver (the last 24 hours). Each line links to the
  prompt's own buttons or the instance's thread. The message is edited as things are resolved, on any surface, and
  re-posted (so it notifies) at most once a minute when something new appears. A delivery item has an
  **Acknowledge** button for that bot's admins; it is recorded on the delivery itself. `needs_you.dm: true` also
  DMs that bot's admins. The web dashboard receives the same list for every bot over its existing live stream.
  `needs_you.live_message: false` turns the General message off.
- **The fleet's org chart on the web (#1389).** Fleet → Org chart shows General at the top, then the teams from `fleet.yaml`, then their instances, and finally the instances that are in no team. Each instance shows its display name, what it does, its backend and model, and its live state: working, idle, needs you, looks stuck, paused, stopped or crashed. Each one also links to its Discord thread or Telegram topic and to its chat. The chart is read-only; you still act in Discord. It reads what the fleet already has, follows the live status without polling, and fits a phone's width.
- **A kiro instance running kiro's TUI can now be steered mid-turn (#1405).** `/steer` and `send_to_instance` with
  `steer: true` now reach a working kiro instance launched with `kiro_ui: tui` or `v3`, on a kiro-cli version AgEnD
  has run live: 2.27.1 (TUI and v3) and 2.28.0 (TUI). The steer is taken in at the next tool boundary of the same turn.
  kiro's own interrupt mode decides what happens. AgEnD reads that mode from kiro's input row before every steer and
  never switches it: it pastes only while the row says `Type to steer`, presses Enter only once the box shows this
  delivery's own message, and confirms only once the box is empty again. If the row says `Type to queue` (the user
  chose queue mode, with Ctrl+S), the message is delivered after the turn as before. The same happens on the legacy
  UI and on other versions; `/steer` there says why it is not available for that instance.
- **Needs you in the web app (#1386, #1408 step 4).** `/ui/needs` lists everything waiting on you, from every bot's world: fleet prompts with their own buttons, agents stopped at a dialog, paused or crashed, and deliveries with **Acknowledge**. It is the same list as the live message in General, and anything handled anywhere leaves it. The sidebar shows the count, the tab title starts with `(N)`, and desktop browsers can show a notification for something new while the tab is in the background (opt-in per device).
- **Setup guide links at the bot-token step.** Both `agend quickstart` and the `agend init` setup wizard now print a 📖 link to the website setup guide at the point where they ask for the bot token — Telegram: [songsid.github.io/AgEnD/setup-telegram/](https://songsid.github.io/AgEnD/setup-telegram/), Discord: [songsid.github.io/AgEnD/setup-discord/](https://songsid.github.io/AgEnD/setup-discord/). The link automatically uses the zh-TW page (`/zh-tw/setup-telegram/`, `/zh-tw/setup-discord/`) when the locale is `zh-TW`. The URLs live in a shared `src/setup-guide.ts` module imported by both files (no circular import).
- Added a data-only downgrade compatibility check against published 2.1.12 on Node 20, with current stores on Node 22 before and after. The report separates additive database compatibility from lost web policies, pending approvals, scheduler retries and Kiro ownership protections; it does not promise a safe live downgrade (#1441, Part C).
- **Node compatibility checks (#1441).** Without a supported bundled runtime, preinstall refuses an incompatible system Node. Bundled-runtime platforms can install while npm itself runs on an older Node. Skipping lifecycle scripts does not make an incompatible runtime safe: the launcher must find the private runtime or an explicitly allowed, qualifying system fallback. An old updater that already unlinked AgEnD can still leave no installed command if installation fails; see the 2.2 upgrade guide.
- **AgEnD brings its own Node 22.23.3 on Linux and macOS (#1450).** On Linux with glibc 2.28 or newer and on macOS 11
  or newer (x64 and arm64), installing AgEnD also installs its runtime package `@songsid/agend-node-<os>-<cpu>`, an
  official Node 22.23.3 published with provenance. AgEnD runs on it whatever Node is on your PATH. Your own Node, and
  the CLIs that use it (codex, claude…), are unchanged.
- **Prompt-cache expiry analysis on the web (#1468).** Fleet → Cache shows, for each Claude Code and Codex instance over the last 24 hours, 7 days or 30 days:
  - how long it sat idle between requests, against the cache's lifetime (1 hour for Claude Code; 30 minutes for Codex on GPT-5.6 and later);
  - how often a request came back to an expired cache, and what rewriting it cost;
  - whether a keep-warm ping would have paid off, counting the pings that nothing ever reads afterwards;
  - a keep-warm recommendation, on or off, with its reason.

  ClassicBot rooms are included. Two instances that share a working directory can't be told apart in their transcripts, so neither is analysed, and the panel says so. A fleet row adds it all up. Costs are list prices from one table, and the panel shows the date it was checked. Codex does not record cache writes, so its numbers are marked as estimates. Kiro and other CLIs show "not available".

  The panel is read-only. AgEnD reads transcripts incrementally in bounded passes and keeps a small summary per instance (`cache-ledger.json`). It never calls a vendor API.
- **Web chat: an agent's HTML preview can open in a panel beside the conversation.**
  - **Open in panel** on the preview card shows it with room to use it: a split with a draggable divider (keyboard-resizable, width remembered on the device) on a wide screen, and a full-screen sheet on a phone.
  - The panel has Page / Code, Reload, Stop, Download and a link to the message the block came from.
  - When a later reply has a newer version of the block, the panel offers it instead of swapping it in.
  - Closing the panel or opening another chat stops the preview. The preview's isolation is unchanged: the same sandboxed frame on the preview address, the same per-device opt-in, and a click to run.
- **Codex gets the reply completion guard (#1510).**
  - A Codex agent that answers a human message only in its terminal, never calling `reply`, is now asked once to send its conclusion, as Claude Code and Kiro already are.
  - It needs Codex's own session log to show that the turn holding your message ended and that nothing started after it. The terminal alone can look idle mid-turn, but the log only ends a turn when it really ends: a long tool run, or a steer folded into the turn, keeps it open.
  - An interrupted turn (Esc) or one that ended on a provider error gets no reminder. A turn that cannot be found in the log the instance follows also gets none, as before; for example, two Codex instances in one directory.
- **Muse gets the reply completion guard too (#1510).**
  - A Muse agent that answers a human message only in its terminal, never calling `reply`, is now asked once to send its conclusion, as Claude Code, Kiro and Codex already are.
  - It needs Muse's own session log to show that the run holding your message ended and that nothing started after it. A message typed mid-run makes Muse run once more after the first run ends; the terminal shows a brief idle moment between the two runs, but the log keeps that second run open until it really ends.
  - A cancelled run, or one that failed, gets no reminder. A message that cannot be found in this directory's Muse logs also gets none, as before.
- **Web chat: an agent's `.html` attachment can be previewed (#1522).** A `.html` or `.htm` file an agent attaches to a reply now gets the same preview card as a ` ```html ` block: Preview, Open in panel, and the same per-device opt-in and sandboxed frame. The file is read only when you click, and it is capped at 1 MiB. Files people upload stay plain downloads. Agents are told to prefer attaching a `.html` file over a long ` ```html ` block, which Discord and Telegram split.
- **Settings: enter bot tokens in the browser (#1529).** New connection and the setup wizard take the bot's token in a password field and check it with Telegram or Discord first ("This is @your_bot."). It is stored on this computer under a generated name such as `AGEND_DISCORD_2_TOKEN` (shown under Advanced), so there is no `.env` to edit and no variable name to choose. A connection shows "Token set" and offers Replace.
- **Settings: invite a Discord bot from the browser (#1533).** After a Discord token verifies, New connection and the setup wizard show "Invite @your_bot to your server". The invite asks only for the permissions AgEnD uses, never Administrator. After you invite the bot, the server it joins is picked automatically, and that server's text channels become a list (with #general first). The form also says where to turn on Message Content Intent, and a connection Discord refuses for that intent now says so instead of "Problem".
- **Settings: a new connection starts without restarting AgEnD (#1539).** When AgEnD is already running a connection, a connection added from Settings (New connection or the setup wizard) starts as soon as you apply it. Replacing the token of a connection that is not running also starts it. The first connection of a fleet, and changes to an existing connection, still ask for a restart.
- **Web: a first-run card on a web-only fleet, and the setup wizard can connect an agent you already have (#1549).** With no Telegram or Discord connection, Chat and Settings › Agents / Connections show a card: **Connect a chat app** opens the setup wizard, **Use the web only** hides the card in this browser. The wizard's first step offers **An agent you already have** or **A new agent**. An existing agent keeps its directory, backend and settings, and only its chat connection becomes the new bot. A new agent can no longer take an existing agent's name and overwrite it. Chat with no agent at all offers **New instance**, and the sidebar's New instance button is now a **+**. The Developer download button now reads **Download fleet.yaml**, and the New instance dialog's "Topic name" field is now **Name**.
- The web dashboard now has a Silver **Ag** tab icon and an apple-touch icon, including sign-in, View and temporary public links. Icon requests are public; Host checks and the existing Content Security Policy remain in place (#1557).
- **Web: one instance's Details page, and a Chat / View / Details switch (#1561).** Each instance now has a Details page at `/ui/fleet/agent/<name>`. It shows the instance's runtime and recent activity, and a read-only summary of its configuration: directory, where it is bound, tags and description. **Edit in Settings** opens that agent's settings. The ⋯ menu starts, restarts, stops, pauses or wakes the instance, with the same confirmations as before; deleting an instance stays in the chat's ⋯ menu and Settings. On an instance's pages, the header switches between its **Chat**, **View** and **Details**; on a phone these appear as tabs under the header. While you have an instance open, **Fleet** now takes you to that instance's Details instead of always landing on Tasks. On Details or a Fleet tab, clicking an instance in the sidebar opens its Details.
- **Web: one text size for every page, and the same header controls everywhere (#1563).** Chat, View, an instance's Details and Fleet now have the same two controls at the top, in the same order: **Text size** and **Usage**. Text size is **S / M / L**, and it is one setting for this browser. Choose it on any page and every page uses it, also after a reload. View keeps **Fit**, which sizes its terminal to the box. Your earlier View setting carries over: Comfortable becomes L and Compact becomes S. **Usage** is hidden when the fleet has the usage panel turned off.
- **Web chat: the conversation is still there after AgEnD restarts (#1565).** The latest 500 messages of each agent are kept on this computer, in a private file in the agent's workspace (`workspaces/<name>/web-chat.json`), and come back when the fleet starts again. A page left open across the restart shows each message once. Files in those messages still open after the restart — as long as the file is still in the agent's inbox and unchanged; otherwise its name is shown as unavailable. Buttons and delivery ticks are not kept. Deleting an agent deletes its file.
- **`/web` is a shorter name for `/dashboard` (#1569).** It does exactly the same thing on Discord and Telegram: the same admin-only gate, the same "disabled" reply when no admins are configured, the same refusals, and `/web revoke`. Discord registers it as its own slash command, and the Telegram menu lists it next to `/dashboard`.
- **The sign-in page can send you a new code (#1570).** A browser that signed in before with a code from `/dashboard` gets a "Send me a new code" button, so a lapsed session no longer means going back to chat. The code goes by DM to the person who received the earlier code, and only while they are still a fleet admin. The DM says which browser asked and suggests `/dashboard revoke`. Requests are rate-limited per browser and for the whole fleet, and refused while sign-in is paused. On a public link it works only while that link is open, and the sign-in is announced as before. `/dashboard revoke` and `agend web-token rotate` remove the button everywhere.
- **Attachments preview inline in the web chat (#1589).** Audio and video files (mp4, webm, mov, mp3, m4a, wav, ogg) play in the message with the browser's own controls, streamed by file id in byte ranges of at most 4 MiB. Text files get a card with Show, Download and the first 200 lines (then "Show all N lines"): Markdown through the chat's own escaping renderer, JSON pretty-printed and highlighted, code highlighted, CSV and TSV as a table, anything else as plain text. Nothing in a file is ever run, and files over 1 MiB stay downloads. Formatting is capped at 4,000 elements per card (table cells, highlighted tokens, Markdown elements) and 50 csv columns, "Show all" included; past that, the card shows plain text. The page allows media only from its own `/ui/file/` route. A file that is gone shows as before, with no preview. The public link is unchanged: there, attachments are downloads only and its page allows no media.
- **Web on a phone: swipe to open and close the sidebar (#1605).** Swipe right across the conversation to open the sidebar, and swipe it left to close it — the same as ☰ and tapping outside. A swipe that starts at the very left edge of the screen is left to the browser (on an iPhone that is "back"), and so are swipes on code, tables, the terminal view and the message box, and anything while a dialog or image viewer is open. Up-and-down scrolling is never taken over. Also: **Tour** in Settings → This device now starts once the chat has drawn, and returns you to the message box when it ends.
- **Web: choose how long a dashboard sign-in lasts (#1620).** For the dashboard reached directly (on this computer, your LAN or a tailnet), `web.session.local.absolute_hours` and `web.session.local.idle_hours` in `fleet.yaml` set how long a sign-in lasts and how long it may sit unused — anywhere from 1 to 720 hours (defaults 12 and 2, unchanged). A public-link sign-in keeps its fixed 4 hours / 30 minutes. A change applies without a restart; making it shorter also signs out sessions that are now older than the new limit.
- **Web: a Settings → Web section (#1620).** It edits how long a dashboard sign-in lasts here and how long it may sit unused (`web.session.local.*`), the browser terminal that `/login` opens (on or off, and its minutes), web echo and the public link's menu — web echo and the public link moved here from General. A change that loosens access (a longer session or idle time, the browser terminal turned back on or given more minutes) waits for a fleet admin to confirm it in General or with `agend settings confirm <id>`; one that tightens access applies at once. The other web settings are listed read-only, to be edited in `fleet.yaml`. None of them can be changed over a temporary public link.
- **Web: a misconfigured session limit never gives a longer sign-in (#1620).** A value the validator would refuse no longer falls back to the 12-hour default when that is longer than what was asked: an idle time above the session length is cut to it, and a value below 1 hour counts as 1 hour.
- **Web: avatars and Discord server emoji come from the dashboard itself (#1630, part 1).** The status the web app receives now says what stands for each instance, in this order: the picture uploaded for it in View, its own bot's avatar (only when it has a bot of its own; instances on the shared bot skip this), its persona emoji, or its first letter. A bot with its own colour in its Discord server also gets that colour as an accent. Bot avatars and the custom emoji of the fleet's Discord servers are fetched on the host with the bot's own token, kept in `~/.agend/cache/` (refreshed at most once a day; a failed refresh keeps the last copy), and served by the dashboard to signed-in sessions, including the temporary public link, read-only. The page never loads images from Discord or Telegram. The sidebar starts showing them in the next change.
- **Web chat: Discord server emoji show as pictures (#1630, part 3).** A message with `<:name:id>` or `<a:name:id>` (what a Discord custom emoji is in text) shows the emoji's picture when it belongs to a server the fleet's Discord bots are in. The picture comes from the dashboard itself, so the page never loads Discord; the list of known emoji is read once per page, and only when a message has one. Any other one stays as written. The sidebar's picture check is also stricter: one file under the dashboard's picture routes, never a path that climbs out of them.
- **Web: the sidebar shows who each instance is (#1630, part 2).** Each instance is called by its display name, with its instance name on hover (and under the name when two share a display name). Next to the name is its picture: the one uploaded in View, its own bot's avatar, its persona emoji, or its first letter. A bot with a colour in its Discord server is ringed in that colour. The status dot sits on the picture and says its state (idle, working, looks stuck, paused, stopped, crashed, needs you) to screen readers as well as in colour. The chat header and the Needs list use the display name too.
- **Agents: after an upgrade, each one is told once what is new for it (#1633).** An agent whose session started under an older AgEnD may not know new tool parameters: Claude Code keeps the tool descriptions it loaded earlier in its conversation, so it never saw `reply`'s `buttons` or `stickers`. Now each existing instance gets one short notice, just before the next message it receives (never in the middle of a turn, never to an instance nobody writes to). It lists the agent-facing changes with their exact parameter names, and says to reload a tool's description that looks older. Each item is sent once per instance, and the record of what was sent survives restarts. New instances get nothing, since they already start with the current tools. A version with nothing new for agents sends nothing.
- **Web: favorites (#1664).** Star an instance to pin it in a **Favorites** group at the top of the sidebar, in the order you starred them. On a desktop the ☆ appears when you hover over or focus a row, and stays when the row is starred. On a phone, tap **Edit** at the top of the list. **Edit** also shows ↑ ↓ to reorder favorites. Favorites are one of your synced preferences (#1665), so your phone and desktop show the same list. A deleted instance drops out of the list; a paused or stopped one stays. A public link shows the favorites but cannot change them. At most 50.
- **Web: preferences follow you across devices (#1665).** Theme, language, the sidebar's order, folded groups and filter, and the HTML-preview opt-in are now saved on the host, so a phone and a desktop stay the same. Each browser keeps a copy, and the page is served with the host's theme, so nothing flashes on load, even on a new device. On first load after the update, a device uploads what it had for anything the host doesn't have yet; after that the host's values win. Settings → **Preferences** shows what is synced and what stays on each device (the tour, text size, view fit, the sidebar shown or hidden, panel widths, desktop notifications). A public link can read these preferences but never change them, and it can never turn previews on.
- **Bot-to-bot messages appear in the web chat too (#1672).** What an instance sends another (`send_to_instance`, `delegate_task`, `request_information`, `report_result`) now shows in both instances' web chats, by the same `cross_instance_visibility` rules as the topics: `full` the whole message, `summary` one line, `hidden` nothing. Report and update stay silent on the target's side, and General instances are skipped. A fleet with no chat platform, or an instance with no topic, still gets them. Each one is a muted, read-only status line (plain text, never an agent's reply, folded when long), counted in the chat history and kept across a restart.
- **Web chat: mentions look the way Discord and Telegram show them (#1682).** A user mention `<@id>` (or `<@!id>`) now shows as an **@name** pill instead of the raw token. Role mentions `<@&id>` and channel mentions `<#id>` show the same way, as **@role name** and **#channel**, and every pill shows its id on hover. Names come from what AgEnD already knows: the fleet's own bots (by their instance's name), people who have written to the fleet, and the Discord servers its bots are in. AgEnD makes no extra Discord request for them, and a page only gets the names of the mentions it is showing. An unknown one reads **@user**, **@role** or **#channel**, never the raw token. A Telegram **@username** gets the same look. Code spans and code blocks are left as written.
- **Telegram /web failure links to the bot's private chat (#1686).** When the sign-in code cannot be delivered by DM — because the user has not started the bot privately yet — the failure message now carries a URL button labelled **Start privately →** that deep-links directly to the bot's DM with `/start web` pre-filled (requires Telegram 7.7+). The button is shown only when the bot's username is known and passes Telegram's format check (`[A-Za-z0-9_]{5,32}`); an absent or invalid username falls back to the existing plain-text guidance. The sign-in code is never posted in the group. Discord is unchanged.

  The /web menu also shows a one-line hint with the same link, so users know before they try the button.

  Sending `/start web` from a private DM when you are a fleet admin now replies "You can now use /web in your group" instead of trying to start an agent with a backend named `web`.
- **Web: edit a team (#1689).** Each team on Fleet → Teams now has **Edit**, which opens the team form already filled in with the current members and description. A member that is no longer in the fleet is still listed, so it can be taken out. Saving goes through the same update as the agents' `update_team` tool: members must be instances of this fleet, and nothing is saved if one isn't. A team can't be renamed; the form says so (create a new team and delete the old one). The org chart shows the change the next time it opens. `update_team` can now change a team's description too (an empty one clears it). `agend-agent team-update <name> [add,…] [remove,…] [description]` now works: it used to send the member lists as plain text, which `update_team` refused. A save that fails leaves the team as it was. Both `update_team` and `create_team` now only accept names fleet.yaml actually defines, so `constructor` or `__proto__` is no longer taken for an instance or a team.
- **A pane stuck on a prompt AgEnD doesn't recognise is now caught (#1691).** When a CLI shows a selection prompt (a cursor on numbered options, or a `[y/n]` question) that no known dialog explains, and the pane stays unchanged for a minute while the CLI's own input box is gone, AgEnD:
  - holds deliveries to that instance;
  - marks it as waiting for input;
  - raises one **Needs you** item and one notice saying what the prompt asks, for example "Switch model?".

  AgEnD never presses anything for it. The notice clears when the pane changes, and a prompt held for hours is reported once. An agent's reply that merely contains a numbered list is not a prompt. Triggered by claude's new "Switch model?" dialog (#1690), which used to stall a pane silently.
- **Claude Code instances can use different claude.ai accounts (#1699).**
  - Set `backend_options.claude-code.credential_profile: work`, then sign that profile in once with
    `CLAUDE_CONFIG_DIR=~/.agend/credential-profiles/claude-code/work claude auth login`.
  - Each profile has its own login, account, trust settings and conversations, and a `settings.json` that starts as a
    copy of yours. Your `CLAUDE.md`, agents, commands, skills, output styles and plugins are shared with every profile.
  - On macOS each profile gets its own Keychain item, so profiles never sign each other out.
  - Switching profile with `update_instance_config` restarts the instance on a fresh conversation, with a handover of
    the recent work. AgEnD refuses a switch to a profile that is not signed in and tells you the command to run.
  - An instance without a profile starts exactly as before.
- **Usage per Claude Code profile (#1699, part 3).** Each Claude Code credential profile in use now has its own usage row (`Claude (work)`, `claude:work`) in `/usage`, `get_usage` and the dashboard's usage rail and dialog, next to the default `Claude` row. Each row reads that profile's own login (on macOS, the Keychain item claude keeps for the profile's directory), never the default one. When the usage API can't answer, a row falls back only to the rate limits its own instances wrote. A profile that isn't logged in says "Not logged in" with `/login claude-code <profile>` (#1699 part 2) and the exact command that signs it in on the host, never another account's numbers. Before this, an instance on a Claude profile had no usage row at all. A fleet without Claude profiles looks exactly as before.
- **Sign a Claude Code profile in from chat: `/login claude-code <profile>` (#1699).**
  - It runs `claude auth login` for that profile in the same browser terminal `/login claude-code` uses, so it works
    from a phone. On Discord, `/login` has a new `profile` option.
  - Only the agents on that profile are woken or restarted afterwards. Signing in the default login no longer restarts
    agents on other profiles.
  - When an agent's profile sign-in expires, the alert offers a button for that profile.
  - Kiro and Codex profiles are still signed in on the host; `/login kiro-cli <profile>` replies with the command.
- **HTML previews work on the temporary public link (#1723), from a phone too.**
  - The link opens a second quick tunnel of its own for previews, in the background. The link never waits for it.
  - Until it is up, a card says *Preview is starting…*; if it cannot open, the link keeps working and the card says why.
  - It closes with the link. The preview address is a different site from the dashboard's, so the frame is isolated even more than on the host.
  - Your device's **Allow HTML previews** still applies.
  - `web.preview_on_public_link: false` turns it off, and a configured `web.preview_origin` is used instead.
- `send_to_instance` and `delegate_task` accept explicit `forwards` references so a downstream agent can read an original delivered message with `delivery_status`, including a newly recorded human consent receipt. Every hop requires a grant from a sender who can read the reference; mentioning an ID grants nothing. Human receipts preserve original actor/adapter and content separately from the formatted wire payload, and remain uncertain without owned submission evidence. Platform reply IDs are unchanged; `/raw`, historical relays and Web's unknown platform identity cannot establish native human consent. Guidance now explains hidden/expired lookups and CLI forwarding.
- **`/backend`: move an instance to another CLI backend from chat (#1806).**
  - On Discord, Telegram and the web chat, with exactly `/model`'s permissions: a channel admin.
  - Pick the backend (only CLIs installed on this host), then its model (`/model`'s list, or the default), then its effort (`/effort`'s levels; skipped for a backend without one), then confirm. `/backend <backend> [model] [effort]` goes straight to the confirmation.
  - Nothing changes before the confirmation. Then backend, model and effort are saved in one write and the instance restarts **once**, in a **fresh session**: a conversation does not carry across backends. A turn in progress is interrupted. A stopped or paused instance is saved and not started.
  - It is `update_instance_config`'s backend switch: the new backend's own options apply, and a credential profile with no login for it is refused, with the command that logs it in. Nothing is left half-changed by a refusal.
  - An uninstalled backend, or a model or effort the new backend does not offer, is refused with the valid choices. The backend it already runs changes nothing; `/model` and `/effort` are named for that.
  - Fleet instances only: a ClassicBot agent's backend is set in `classicBot.yaml` or Settings, and `/backend` there says so.
- **`close_poll` ends a poll early (#1823).** An agent can close one of its own open polls before the deadline, for example once everyone has answered. It is the same close as at the deadline: the tally shows, and the results arrive once, marked as closed early.
- **Polls on reply buttons (#1823).** `reply({ buttons, poll: { seconds } })` turns the buttons into a timed, Kahoot-style vote on Discord, Telegram and the web chat.
  - Everyone who may click there votes once, can change their vote, and is told their own choice privately.
  - While it is open, only "N answered" and the time left show; `reveal: "live"` shows the counts as votes come.
  - At the deadline the buttons show the tally. The agent gets one `[poll results]` message with each option's voters and how many ms after the poll opened each voted, to post the answer and scores itself.
  - The deadline and the results survive a restart, and the results are delivered once.
- **Web: a Docs link on Fleet overview (#1844).** The Fleet panel's header has **Docs**, which opens the project's docs site in a new tab — the English pages, or the 繁體中文 ones when the dashboard is in Chinese. On a phone it is a book icon.

### Changed
- **A message to a busy Claude Code instance is handed to Claude's own queue instead of waiting for the turn to end
  (#1169), as Codex already does.** Verified on the real Claude Code 2.1.293 TUI:
  - A message sent while Claude works is queued and sent once the turn ends. The running turn is not interrupted, and
    the message is sent exactly once.
  - While a tool runs, Claude takes the message at that tool's boundary.
  - AgEnD hands a message over only while it can read Claude's input box. A dialog AgEnD does not recognise, or a
    screen it cannot read, waits.
  - AgEnD confirms the hand-off on Claude's screen. It looks for the message's id in Claude's queue, or for a queue
    that was not there before the paste: "Press up to edit queued messages" in the box, under the "ctrl+x ctrl+s to
    send now" row. A reply that merely prints those words proves nothing.
  - An Enter the TUI swallowed gets one more Enter after the turn, never a second paste.
- **AgEnD can now tell whether a message to Claude Code actually left the input box (#1200).** It reads Claude's live
  input box as the region between its two frame rules, captured from Claude Code 2.1.293. Until now it could only tell
  that the pane printed something after Enter. Now:
  - A delivery counts as submitted once Claude shows it outside the box: echoed above the box, or in Claude's queue
    above the spinner, with the message's own id on screen. That covers ordinary messages and steers into a busy turn,
    which used to settle as `steer-accepted-marker-on-pane; input-row-unreadable` and now settle as
    `positive submission proof`.
  - A message still in the box after Enter (Claude shows a long paste collapsed, as `[Pasted text #1 +11 lines]`) gets
    one more Enter, never a second paste.
  - When neither can be shown, the delivery stays at 👀 instead of being called lost.
  - A steer whose outcome Claude's screen cannot show is no longer pasted a second time. Before, it could be submitted
    twice.
- **A fleet stall that comes from many small steps now names them, instead of logging "slow sync work: unknown"
  (#1235).** The stall log used to name a cause only when one single step took at least 50 ms. A minute-by-minute
  check that does a little work for every instance at once added up to a one-second stall with no name. Short steps
  that run back to back are now added together and reported with how many there were, for example
  `daemon.stateEvaluate:safety_sweep=1100ms (20 calls)`.
  - The steps now timed include starting each `tmux` command, the fleet's once-a-minute check of every pane, each
    instance's evaluation of its pane, the 30-second health and reply checks, the delivery queue, the dashboard's
    status updates, and the transcript reads that confirm a delivery.
- **An "Event loop stalled" warning now says, where it can prove it, whether the fleet was busy or waiting (#1235).**
  It describes the longest gap a 100 ms probe saw in that report, with its time and the CPU the event loop's thread got
  inside it, plus the host's load average. A thread that kept running through the gap means the fleet's own work
  blocked it. A thread that barely ran means the fleet was waiting: for a host busy with other work (such as big test
  runs on the same machine), or for a slow system call. When the numbers cannot tell the two apart, the warning says
  so. `docs/diagnostics.md` explains how to read it.
- **Web chat: long pastes and staying at the newest message (#1269).**
  - A paste over 4,000 characters now goes in as a text file instead of filling the composer; before, the limit was 10,000. **As text** on the file still puts it back.
  - When you are reading the newest message, the chat stays at the bottom even if something above finishes drawing afterwards, such as an image or a preview card. If you scroll up to read, nothing moves you, and **Latest** (or **N new**) brings you back.
- **`/dashboard` and the tips say what the dashboard is now (#1366).** The slash-menu entry reads "Sign in to the web
  dashboard and web chat"; on a `localhost` dashboard the `/dashboard` reply adds where the way in from a phone is
  documented; the tips about dashboard links and the web token describe the one-time code and signing browsers out;
  four new beginner tips introduce web chat; and Settings' *What's New* lists 2.2, in English and 繁中.
- **`/ui` is now one app with a sidebar, in a new look (#1408, step 1).**
  - **Layout:** a sidebar with your instances, Fleet, View, Settings, the theme, the language and the Session menu. The conversation sits in a centred column with a rounded composer below it. The type is Inter, bundled with AgEnD. On a phone, the sidebar is a drawer and tabs run along the bottom.
  - **Addresses:** each chat has its own address (`/ui/chat/<name>`) and each Fleet tab too (`/ui/fleet/teams`). Moving around does not reload the page, Back and Forward work, and old `/ui#instance=<name>` links still open the right chat, also through signing in.
  - **Clearer controls:**
    - The composer's control is now **Stop reply**, shown only while the agent works.
    - The instance's own actions moved into the header's **⋯** menu, which offers only what fits its state: Start when stopped; Restart and Stop instance when running; Delete last.
  - **Smaller fixes:**
    - A long instance name is no longer cut short by its "needs you" badge, which now sits on its own line.
    - Code wraps on a phone.
    - Text colours meet WCAG AA in both themes.
  - `/view` and `/settings` move into the same app in the next steps.
  - Built with Preact and htm, included in AgEnD itself (pinned and checksum-verified, licences included). Nothing is loaded from another site, and the page's security policy is unchanged.
- **The web app's last rough edges (#1408 step 5).**
  - Every "are you sure?" is the app's own dialog, with a button that says what it does: leaving Settings with changes not applied, an access change, Restart AgEnD, deleting an agent, a schedule or a team, removing a connection, rebinding it, and allowing HTML previews. A sign-out the server could not save is said on the sign-in page instead of in a browser alert.
  - The sign-in page has the app's look, in light and dark.
  - A connection in Settings fits on one line on a desktop; on a phone its details go under it.
  - Developer → Apply & save writes only the parts of `fleet.yaml` you changed.
  - On a phone, the tour points at ☰ for the instance list.
  - The old shared page script and stylesheet (`/assets/shell.js`, `/assets/shell.css`) are gone: every page is the app or the sign-in page.
- **`/settings` is now part of the app (#1408, step 3).**
  - Settings has the same sidebar, look and themes as the chat; moving between them no longer reloads the page.
  - Agents, Connections, ClassicBot, General and Developer are tabs, each with its own address (`/settings/<section>`). Each agent's and connection's settings open in a dialog (a sheet on a phone), and **New agent** is the sidebar's New instance.
  - Changes are staged and applied together, as before. Once you press **Apply changes** it carries on even if you leave Settings; its progress shows in any panel. Leaving Settings with staged changes asks first.
  - A change that needs a fleet admin's confirmation (#1423) shows a card in any panel, with what it changes, the time left and **Withdraw**. The same goes for a confirmation-gated New instance, delete or Fleet config save.
  - An agent's model that is not known yet now reads "default (detected when it starts)" instead of "default (not probed yet)".
- **`/view` is now part of the app (#1408, step 2).**
  - The same sidebar, look and themes as `/ui`; moving between the chat and View no longer reloads the page.
  - Each agent's terminal has its own address, `/view/<name>`.
  - The roster lives in the sidebar (the drawer on a phone), with its groups, filter and drag order. The header offers **Text size**, **Usage** and **Help**, and the profile is edited in a dialog.
  - Signed out (with `web.view_access: open`), `/view` shows View and **Sign in** only, and reads nothing that needs a session.
- **The buttons on an instance's interactive-input prompt now say what they do (#1414).** When an instance waits on
  terminal input (a permission, a password, a dialog), General's prompt offered *Confirm* / *Cancel*. It now offers
  *Ask General to help*, which asks General to look at the terminal as before, and *I'll handle it myself*, which leaves
  it to you. The question and the outcome line match. The text is shared, so Telegram, Discord and the web chat change
  together.
- **`agend update` checks the new release can run here before it changes anything (#1441).** It reads the release's own Node requirements, from the same npm that will install it, and works out which Node it would run on: AgEnD's bundled Node where the release ships one for this computer, otherwise the `node` on your PATH, or, when the update installs through nvm, the exact Node 22 nvm picked. If that Node doesn't fit, the update stops with "AgEnD was not changed". It says which Node the release needs and why the bundled one doesn't apply (for example on musl Linux), and asks you to install a Node in that range. It doesn't touch your system Node. On the nvm path the check runs once nvm has picked its Node, still before npm installs anything. A `/update` from chat reports the same reason. If the requirements can't be read, or use a range form this check doesn't understand, the update goes ahead as before, and the release's own install check still protects it.
- **`agend` and `agend-agent` start through a launcher that picks the Node AgEnD runs on (#1450).** The commands are
  small POSIX `sh` scripts, so they start even with no `node` on PATH, for example in a shell that has not loaded nvm.
  When a release pins AgEnD's own Node for this platform (Linux glibc ≥ 2.28 x64/arm64, macOS 11+ x64/arm64), the
  install verifies that Node: its exact version, N-API 10, and a database opened in the main thread and in a worker.
  It then records it, and from then on AgEnD runs on it whatever Node is on your PATH. Your system Node, PATH and npm
  stay as they were.
  - Where AgEnD bundles its Node, your system Node's version never blocks an install or an update: Node 20, 18,
    16, any Node whose npm can run the install. AgEnD does not run on it. An install is refused in only two cases,
    and npm then keeps the version you had:
    - this platform has no bundled Node (musl Linux, 32-bit, another OS, glibc older than 2.28, macOS older than 11)
      and your Node is older than AgEnD needs (`^22.14.0 || ^23.6.0 || >=24`), so AgEnD could not start;
    - the bundled Node fails its check during the install.
    npm 8 and 9 (npm 8 is what Node 16 ships) also run `node-gyp` for better-sqlite3 (it does nothing when a prebuilt
    binary exists), so they need what node-gyp needs: a Python 3 up to 3.11 (or with setuptools) and `make` (macOS:
    the Command Line Tools). If that is missing, npm stops the install and keeps your previous version. npm 10 and
    newer skip this step; they need Node 18.17 or newer.
  - A bundled Node that is missing, incomplete or changed after it was verified is refused, with the command that
    repairs it. AgEnD never falls back to another Node silently.
  - If the bundled Node was skipped at install (`--omit=optional`, `--ignore-scripts`), AgEnD uses your Node when it
    qualifies, and says so.
  - `AGEND_NODE=/abs/path/to/node` overrides the choice. It must be a Node AgEnD supports; otherwise AgEnD refuses
    instead of falling back.
  - What AgEnD starts for itself runs on the Node it is running on and on its own CLI file, never a `node` or `agend`
    found on PATH: the MCP server the coding CLIs start, `agend start` and `agend restart` without a service, the
    quickstart reload, `/doctor`, and the Antigravity status line. Paths and arguments in the generated kiro, grok and
    muse wrappers are quoted, so a path with spaces, `$` or backticks is used exactly as written.
  - Native Windows is not supported: run AgEnD inside WSL.
- **The service names AgEnD's own Node, and `agend restart` refuses a service it cannot prove (#1450).**
  - The systemd unit and the launchd plist now start `<AgEnD's Node> <package>/dist/cli.js fleet start`, instead of
    leaving Node to `#!/usr/bin/env node` and the service's PATH.
  - On a platform with no bundled Node, the service starts AgEnD's launcher, which finds Node on the service's PATH at
    each start. Upgrading Node with nvm or Homebrew therefore does not break the service.
  - Before stopping anything, `agend restart` checks that the definition systemd or launchd has loaded starts exactly
    that, with no reload pending. Otherwise it refuses and stops nothing; run `agend install` to rewrite an older
    service. `--force` is for operators.
  - macOS: `agend install --no-activate` no longer leaves a new plist for launchd to pick up at an arbitrary moment. It
    proves the plist and records a planned activation, and the next `agend restart` performs exactly one
    `bootout`/`bootstrap`, rolling back to the previous job if the new one does not run. See `docs/cli.md` for the
    launchd domain AgEnD uses (`gui/<uid>`) and why.
  - macOS: `agend install` and an update wait until launchd has finished unloading the previous job before loading the
    new one. launchd returns from `bootout` early, and loading straight away failed with error 5.
- **`agend update` owns the npm prefix while it runs, and verifies the new release on the Node that release will use
  (#1450).**
  - Before npm runs, the update takes a lock next to the installed package (`<npm prefix>/.agend-install.lock`). A
    second `agend update` into the same prefix, from any fleet, refuses instead of colliding. A lock left by an update
    that died is reclaimed.
  - Only the update's own npm child may install while it holds the lock: the package's install script refuses any
    other install into that prefix, and npm rolls it back. Run one install at a time.
  - A release that brings its own Node is verified on that Node: the update asks the installed release which Node it
    selected, then opens a database with it in the main thread and in a worker. Whatever Node runs the update does not
    count.
  - Chat `/update` runs the `agend` that npm installed, found through npm and checked to be that package, by its full
    path. If that cannot be confirmed, `/update` refuses and says to run `agend update` from a shell. It never falls
    back to whichever `agend` comes first on PATH.
- **Docs updated:** `docs/features.md` gains sections for the "Needs you" inbox (#1386/#1398) and the new web app shell (#1408 step 1). `kiro-cli` `/steer` support in `docs/commands.md` already accurately reflects #1432. Node.js version requirements in README already reflect #1420 (`^22.14.0 || ^23.6.0 || >=24`).
- **Codex session resume docs: `$CODEX_HOME` takes precedence over `~/.codex`.** The two mentions of `~/.codex/state_5.sqlite` and the shared home in `docs/features.md` now read `$CODEX_HOME/state_5.sqlite` (default: `~/.codex`) and `$CODEX_HOME` (default: `~/.codex`). The code (`src/backend/codex.ts:904`) has always used `process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")`; the docs now match.
- **Test: `ENGINES` constant must stay in sync across `package.json`, `scripts/preinstall-guard.cjs`, and `src/node-version-guard.ts`.** A new test reads `package.json` engines.node as the source of truth and asserts: (a) the `ENGINES` string in `preinstall-guard.cjs` is byte-for-byte identical, and (b) `isNodeCompatible()` returns true for the minimum version of each disjunction. Changing any one location without the others fails the test. (#1490 P3)
- **Telegram forum-root commands have a fixed owner:** bare commands use the
  primary connection's General in that group, or the first configured same-group
  General when the primary has none there. The selected bot's admin list applies
  regardless of which sibling receives the message first; a stopped or unresolved
  owner never falls back to another bot. Use `/restart@ThatBot full`,
  `/update@ThatBot`, or that bot's own General topic to address a different bot.
  Ordinary messages and existing Classic commands keep their routing. (#1490)
- **Opening a temporary public link shows each step as it happens (#1512).**
  - The `/dashboard` menu you clicked follows the start step by step, with seconds on each step:
    1. check cloudflared;
    2. download it, in MB of the total;
    3. verify it against the pinned version and SHA256;
    4. start the tunnel;
    5. wait for the public address to answer;
    6. send you the link privately.
  - Steps 1–3 appear only when AgEnD's own cloudflared must be fetched; after the first time it is steps 4–6.
  - A step that fails is marked with its reason, for example "the file did not match the pinned SHA256" or "another tunnel is still running". Running `/dashboard` again retries.
  - The menu is updated at most every 2 seconds (3 on Telegram, where the menu message in General is edited). It never shows the link or the code.
- **Web app: one instance list in the sidebar on every page (#1526).** Chat, View, Fleet, Settings and Needs now show the same list: live status dots, View's tag groups, folding and drag order, and a filter with **Status** and **CLI** chips next to the search box. The filter is the same on every page and this browser remembers it. A row opens the view you are in (View on View, Chat elsewhere), and the list no longer jumps when you navigate. An alias or description set on an instance's profile in View is now shown everywhere, including the chat header.
- **CLI: the persona bot invite uses the same permission set as Settings (#1533).** It adds Manage Channels, Attach Files and Use External Emojis, which the bot's calls need, and drops Manage Messages and Use Application Commands, which the bot does not need (slash commands come with the invite's applications.commands scope).
- **AgEnD reads `~/.agend/.env` the same way everywhere (#1545).** At start, when a new connection starts without a restart, and when a new token's variable name is chosen, the same rules apply: `export KEY=value` lines, quoted values, and the last of a repeated key. A token is therefore never read one way at start and another way later.
- **CLI: setup ends by pointing to the web dashboard (#1550).** `agend quickstart`, `agend setup` and `agend init` now end with the dashboard's address (`http://localhost:19280/`, or the fleet's `health_port`). They also say how to sign in: run `agend web --code`, or send `/dashboard` to your bot. Quickstart's steps are numbered 1/4 to 4/4. When `agend init` installs the service, it now also starts it; it used to suggest a `systemctl` unit that does not exist. Its "install the Discord plugin" line is gone, because Discord is built in. A successful `npm install` ends with "Next: run `agend quickstart`". The README and the website's getting-started page now give the right Node requirement and describe the dashboard.
- **The cloudflared download for the public link works on slow connections (#1554).**
  - It no longer fails after a fixed 5 minutes. It fails only when no data has arrived for 60 seconds, with a 30-minute overall limit, so a slow download that keeps moving finishes.
  - **On Linux it now comes from Cloudflare's own package repository first** (pkg.cloudflare.com), and from the GitHub release if the package is missing, stalls, is too slow or does not match. The package is also half the size.
  - Both sources are checked against the same pinned SHA256. The package's binary is unpacked by AgEnD itself, with nothing else installed.
  - macOS still downloads from GitHub, since Cloudflare publishes no macOS package.
  - On `/dashboard`, step ② says when it switched to GitHub and why.
- **Web chat: an image opens full size in the page (#1558).** Clicking an image in the chat used to open it in a new browser tab. It now shows it over the chat on a dark background, fitted to the screen. To close it, click ✕ or the dark area, or press Esc. When a message has several images, use the arrows or the ← and → keys to move between them. **Open original** still opens the image in a new tab, and Ctrl-click or a middle click on an image opens a new tab as before.
- **Web chat: the HTML preview warning can be dismissed until you next sign in (#1568).** The banner over a running preview has an **I understand** button. Pressing it hides the banner on every preview, in every tab of this sign-in; the next sign-in shows it again. Without a sign-in session, it stays hidden only in that tab. The amber border around every preview always stays. Previews are still off until you allow them, and still run only when you click.
- **Web: an open dashboard tab rides out a fleet restart quietly (#1580).** When AgEnD restarts, each open tab used to retry about every 3 seconds and poll every 5 seconds at the same time, forever, even when hidden — dozens of connections a minute per tab, through WSL2's port relay or a tunnel. Now a tab waits longer between tries (about 1, 2, 4, 8, 16, then 30 seconds), pauses while it is hidden, keeps one connection at most, and closes it when the tab is closed. The page says "Can't reach AgEnD — it may be restarting" with when it tries again. When AgEnD is back, what was said meanwhile appears, once — before, a tab could miss those messages.
- **The web usage panel (◔) opens at once (#1585).** When its last snapshot has expired, the panel now shows it straight away, labelled "Updated N min ago · Refreshing…", while the one refresh that expiry starts runs behind it. The fresh numbers replace it a few seconds later. Before, the panel waited for every vendor (several seconds). Vendors are called exactly as often as before. The `/usage` chat command, the `get_usage` tool and Discord presence still wait for fresh numbers. A snapshot older than 60 minutes is never shown this way. A snapshot, fresh or stale, is shown only under the fleet config it was fetched for: after a credential profile or binding changes, the next read waits for its own fetch, which runs after any fetch already in flight and never alongside it. If the config files' metadata cannot be read, nothing cached is shown, and within the cache window such a read fails instead of calling the vendors again. `/api/ai-usage` is sent `Cache-Control: no-store`.
- **The sign-in code is easy to copy on a phone, and the link's expiry is in your time zone (#1586).** After the `/dashboard` (or `/web`) sign-in message, and after the sign-in page's "Send me a new code" message, the bot sends the code once more in a message of its own: tap it on Telegram, or long-press → Copy Text on Discord. The first message still holds the code, so nothing is lost if the extra message fails. The public link's expiry, and the menu's status line, now read like `2026-10-11 01:30 (UTC+8)` in the fleet's time zone (`TZ`, otherwise the system's), instead of a UTC timestamp.
- **Web: a shorter sidebar footer, and no "refreshing every 5 s" strip (#1603, #1604).** The bottom of the sidebar is now one row — **Settings** and **Session** — instead of five. What this browser chooses for itself (theme, language, allowing HTML previews, replaying the tour) is in **Settings → This device**; on `/view` without signing in, theme and language are behind the ☀ button beside **Sign in**. The strip "Live updates paused — refreshing every 5 s" is gone: polling is a normal way to stay up to date (the public link always polls), so it is no longer shown as a problem. "Can't reach AgEnD — it may be restarting" still shows when AgEnD really cannot be reached.
- **On Discord the sign-in code's own message is inline code (#1606).** The message that repeats the code by itself (#1586) is now `` `ABCD-EFGH` `` on Discord, so a phone copies it with a tap, as it already does on Telegram. It is still the only thing in that message.
- **Closing the public link takes two taps (#1610).** On a phone the "Close public link" button sat right above the code you tap to copy, so a slip could close the link you were about to sign in with. The first tap now only turns the button into "Close link (signs public browsers out)" / "Cancel" on the same message, which keeps its text; only the confirm closes the link, and Cancel puts the button back. The same owner check applies. `/dashboard revoke` and `/web revoke` still act at once.
- **Web: General can show its own bot, and an uploaded picture can be removed (#1630 follow-ups).**
  - The primary bot now counts as an instance's own bot when only that instance uses it, for example a fleet that keeps the primary for General alone. That instance then shows the bot's avatar and its Discord colour ring. A primary shared by several instances or rooms still shows without a ring.
  - View's **Edit profile** has **Remove picture** when a picture is uploaded. On save, the picture is deleted and the bot's avatar, persona emoji or first letter shows again.
  - The route is `DELETE /api/avatar/<instance>`, signed in like the upload.
- **Settings: status-emoji pictures come from the dashboard itself (#1630).** The status-emoji editor's server-emoji grid and preview used to load Discord's CDN in your browser, and the dashboard's content policy allowed `cdn.discordapp.com/emojis/` for that. They now come from the dashboard's own cached route, the same one web chat uses, and the policy no longer allows any remote image: Discord never sees your address when the editor is open. An emoji from a server the fleet's bots are not in shows as its `:name:`. Agents' `list_emojis` image links are unchanged.
- **Web sign-in instructions recommend `/web` (#1655).** Upgrade and first-run messages also use `/web`, including `/web revoke`. `/dashboard` keeps working as an alias with the same permissions and options; command references list both names.
- **Agents: `format: markdown` on Telegram now means markdown; raw HTML tags are shown as text (#1658).** A `reply` with `format: "markdown"` was sent to Telegram as HTML without conversion, so text containing `<` or `&` (`a<b`, `x && y`) was refused and the reply failed, and `**bold**` showed literally. It is now converted from markdown with everything escaped first: `<`, `&` and `>` are shown as typed, and **bold**, *italic*, ~~strike~~, `code` and http(s) links are rendered. HTML tags were never documented under "markdown" and now appear as text. If Telegram still refuses the markup, the reply is sent once more as plain text. Replies with tables, code blocks or headings still go out as Telegram rich messages, unchanged.
- **The web dashboard keeps you signed in for two days by default (#1670).** A sign-in on the dashboard reached directly (this computer, a LAN, a tailnet) now lasts 48 hours, and also 48 hours without use, instead of 12 hours / 2 hours idle. A public-link session stays at 4 hours / 30 minutes. A value you set in `web.session.local.*` or **Settings → Web** still wins, and the limits are still 1 to 720 hours. A session signed in before the update keeps the end it was given at sign-in (12 hours under the old default, or whatever you had set), and nothing revives one that has already timed out. Its idle time moves to the new window only when it is used before its old idle limit, and never past that recorded end. Setting only a shorter session length (for example `absolute_hours: 24`) is still valid: the idle time follows it. Only an idle time above 48 hours without a session length is refused.
- **AI usage is a panel on the right again, on a wide screen (#1673).** On Chat, View, Details and Fleet, a screen 1200 px or wider shows AI subscription usage as a panel beside the page that stays open as you move between pages, as the old `/view` had it. **Usage** in the header (or the panel's ✕) hides or shows it, and this device remembers the choice. A narrower screen, such as a phone, keeps the **Usage** dialog. The panel shows the same rows and refreshes the same way as the dialog, reads nothing while hidden, and is absent when `web.usage_panel` is `false`.
- **Web: collapsible filter groups (#1700).** In the sidebar filter, the **Status** and **CLI** groups each have a header with a chevron. Click anywhere on the header to show or hide that group's checkboxes. When a group is hidden but some of its checkboxes are ticked, the header shows what is selected, for example "Status · idle" or "Status · 3 selected". Whether each group is open is remembered on this device only and is not synced. Both groups start closed.
- **Web: "Open in panel" runs the HTML preview in one click (#1704).** Clicking **Open in panel** on an HTML card now opens the panel and starts the preview there, with no second **Preview** click. If this device hasn't allowed previews yet, the panel shows the **Allow previews** offer, and allowing it starts the preview straight away. Where previews can't run (`web.preview: false` or a public link), the panel opens with nothing running, as before. A newer version of the page in a later reply is still only offered, and nothing runs on its own when a page loads.
- Host memory pressure no longer broadcasts chat notices on any platform, including recovery. Admission protection, logs, health and the Fleet dashboard indicator remain. A held user action explains the wait in its own reply.
- **Web: a wider sidebar, both names, and the CLI on the avatar (#1722).**
  - **Resizing:** drag the sidebar's right edge to make it wider or narrower (200–480 px), or use the arrow keys, Home and End on the edge. Double-click or press Enter to reset. The width is kept on this device. Phones keep the drawer.
  - **Both names:** each row shows the nickname and, under it in smaller text, the real instance name. A row shows one line when the two are the same. Settings → **Names** chooses which one leads. It's a synced preference, and it also applies to the chat header and Needs you.
  - **CLI badge:** the CLI an agent runs is now a letter on the avatar's top-left corner (C Claude Code, X Codex, K Kiro, G Grok, A Antigravity, O OpenCode, M Muse) instead of a coloured dot, and screen readers announce it by name.
  - **The ☆:** it takes the coloured dot's place, so it no longer covers the name. The status dot stays where it was.
- **Web: Fleet → Schedules is readable, and schedules can be edited (#1724).**
  - **Rows:** each one shows its label (or the start of its message), then when it runs in words ("Weekdays 18:00", "Every 15 minutes", "Once · 2026-10-13 14:00 (UTC+8)"), its next run in the fleet's timezone, and the target's display name. The raw cron moves to the tooltip.
  - **One-time schedules:** they show their run time; before, that spot was blank.
  - **Disabled schedules:** they look disabled.
  - **Edit:** a new **Edit** button opens the schedule form filled in, with **Repeat / Once**. Saving goes through the same validation as the `update_schedule` tool.
  - **Create:** **New schedule** can now create one-time schedules, and creating from the web works again.
- **Telegram `/web`: sign in without leaving the bot's private chat (#1742).**
  - A fleet admin who opens the bot's DM through the "Start privately →" link (`/start web`) now gets the /web menu right there. Choosing LAN or the public link sends the sign-in code to that same chat, so there is no trip back to General. The menu belongs to the same General as `/web` there, with the same admin checks, and its buttons work only in that DM for that admin.
  - When `/web` cannot reach you privately, the message now walks through it: ① open the private chat (the button, when the bot's name is known) ② press Start ③ choose the link there. It never tells you to send a bare `/start`, which starts a separate ClassicBot agent. Without a known bot name it says to send `/start web`.
  - Within 10 minutes of that message, your next bare `/start` in the bot's DM (Telegram's START button) is read as `/start web`, once. Every other `/start` behaves as before.
  - If the message's buttons could not be updated, the outcome is posted with its "Start privately →" button instead of without it.
  - Discord is unchanged.
- **Switching a Claude Code agent's credential profile keeps its conversation (#1753).** Until now, a switch started a fresh conversation and gave the new session a short handover. Now AgEnD copies the session's transcript, its folder and its file history into the new profile while the agent restarts, and the agent picks the conversation up there.
  - The old profile keeps its own copy, so switching back returns to the same conversation.
  - The first reply after the switch re-reads the conversation from a cold cache, so it is slower and billed at full price.
  - This applies to `update_instance_config` and to ClassicBot channels.
  - If the copy can't be made, the switch starts fresh with the handover as before, and the reply gives the reason in `carry_failed`. That happens when there is no session yet, when the new profile already holds a different version of that conversation, when there isn't enough disk space, or when the copy fails.
  - Kiro still starts fresh, and Codex never lost the conversation.
- **Skill: credential-profiles updated for Claude Code profile usage rows (#1753).** The stale "Claude Code profiles do not have usage rows of their own yet" note is replaced with the correct behaviour: each named Claude Code profile now has its own `Claude (<profile>)` row reading quota from its own login, and a never-signed-in profile shows "Not logged in — run `/login claude-code <profile>` to sign in". The Signed-out reminder row is now documented as Kiro-only.
- **The sidebar's instance count sits on the filter headers' row (#1776).**
  - The count (for example `71 / 71`) used to take a row of its own under the Status and CLI headers. It is now at the right end of their row, so the filter area is one row shorter.
  - It stays there when a group is opened or a filter is set. In a narrow sidebar, a header moves down to the next row before the count does. The count reads the same as before, including "shown" when a filter is active.
- **Kiro agent-switch notices (#1794, superseded by #1800).** Automatic swapping on resumed conversations is suspended, so no swap or retry is attempted and no failed-switch topic notice is emitted. The saved agent and shared files stay in use. Shared .kiro read/write failures still need attention and remain visible.
- **CI no longer adds to `@songsid/agend`'s npm download count (#1819).** The jobs that install the published 2.1.12
  (the Node 20 rollback smoke, the data-downgrade check, the runtime-acceptance hop and the Mac GUI rehearsal) fetch
  its tarball once, keep it in the Actions cache and check it against the registry's `dist.integrity` before every
  install; a mismatch fails the job. The install fails if npm fetched our tarball anyway.
- **The web chat says who is writing (#1827).** Sign in with a code from `/web` and the agent recognises you as the Discord or Telegram account it was sent to. Your messages arrive as `[user:<name> via web, id:<your user id there>]` instead of `web-user`. This is for recognition only: a web message grants no permission.
  - The name is your account's display name, unless you choose another under **Settings → Preferences → Your name**. It follows you to every device, and is checked so it can't pose as another platform, user, agent or bot.
  - The same name and id are used in the topic echo, ClassicBot room logs, reply buttons and polls (one ballot per account, on the web or the platform), and tasks.
  - Signed in with an `agend web` code: `web-user`, as before.
- **Web: the chat tour starts only when you ask for it (#1854).** A first visit no longer opens a five-step card over an empty page. **Settings → Preferences → Chat tour** opens it on the last agent's chat. With no agent to open, it says "Choose an agent before opening the chat tour." The tour skips steps whose control is not on the page. It no longer promises that every web message shows in Telegram or Discord: web echo decides that.
- **Web: a quiet first Chat (#1854).**
  - The chat page with no agent chosen says one thing: "Choose an agent to start chatting." With no agent at all it says "Create an agent to start chatting." and offers New agent.
  - The connect-a-chat-app card is no longer on the chat page. It stays in Settings → Agents and Connections.
  - An agent's empty chat says "Type a task below."
  - The hint under the message box keeps two cues, Enter to send and Shift+Enter for a new line. The / commands and Esc cues are in its tooltip.
  - On a browser that never chose, the usage panel on the right starts hidden. Usage opens it, and it stays as you leave it.
- **Web: the sign-in page says how to get a code (#1854).** It used to say "Send /web to your AgEnD bot", which sent people who had already done that back to /web without mentioning that a code only exists after you press a sign-in button there. Now it reads "No code? Send /web in General, then press a sign-in button to get one." The `agend web --code` way in sits under a collapsed "No chat bot?". A wrong code says how to get a new one. A sign-in the server could not confirm (for example a public link whose notice did not go out) is no longer reported as a wrong code.
- Chat `/update` failures now use the fleet's language for fixed explanations and recovery instructions. The next action and full-log location appear before the raw diagnostic so the existing 300-character progress marker keeps useful guidance. Update execution, stages, logs and retry behavior are unchanged; raw tool errors may remain in their original language.
- **A short Web Guide on the docs site, and Docs opens it (#1854).**
  - New page, EN and zh-TW: signing in with `/web` and its buttons, using it from a phone (what the temporary public link means), sessions and signing out, `/view` being open by default, and what to check when the Windows browser cannot reach AgEnD in WSL.
  - **Docs** on Fleet overview now opens this guide instead of Getting Started.
  - Getting Started no longer lists a bot token as a requirement: it is needed only to chat from Telegram or Discord; a fleet without one runs from the web dashboard.
- `/web` now starts with the instruction to press a sign-in button for a private code, with clearer choices for the AgEnD computer or another device. Redundant page URLs and the closed-link countdown are removed; Telegram's private-chat setup steps appear only if private delivery is refused. Existing public-link consent and admin checks are retained.
- **A finished update and the 2.2 welcome are short (#1854).**
  - A healthy update now ends in one line: `✅ AgEnD updated to v2.2.0; 3/3 agents running (42s).` Paused or failed agents, ended background work and cleanup warnings are still listed under it.
  - The once-only 2.2 welcome in General is two lines: web chat is here, and an admin sends `/web` in General, then presses a sign-in button to get a code.
  - An update no longer adds a tip to its completion message. Daily tips and `/tips` are unchanged.
- **Web: an instance's avatar defaults to the bot it talks through (#1867).** If you haven't uploaded a picture, the web app shows the avatar of the instance's own persona bot when it has one. Otherwise it shows the bot it speaks through on Telegram or Discord, usually the General bot. Instances with no connection of their own use the General bot too. A bot without an avatar still falls back to the persona emoji, then the name's first letter. Only an instance's own bot gets the coloured ring.
- **`agend doctor` and fleet start show fleet.yaml warnings (#1874 follow-up).** Before, the validator's warnings only appeared in `agend validate`, which someone hand-editing fleet.yaml rarely runs. Examples are a setting AgEnD ignores, such as `web.access`, or a locked channel with no `allowed_users`. Now `agend doctor` lists each warning as a ⚠ row under **Fleet**, and each one is logged once at warn level in `daemon.log` when the fleet starts. No new checks were added.
- **Web chat takes any file type, as Discord and Telegram do.** Archives, office files, programs, HTML, SVG and anything else can now be attached, within the same limits (5 files, 10 MB each, 25 MB together). The agent gets them in its inbox like any other document. In the chat they are only ever a download (`application/octet-stream`, attachment), never shown or run in the page. Images, PDF and text work as before. (#1900)
- **Switching chats in the web dashboard paints at once (#1908).** A chat now opens with its newest messages drawn; the older ones follow right after, without moving what you are looking at. Coming back to a chat with a long history shows it in about 40–50 ms instead of about a quarter of a second.
- **A reply-button click shows as its label in the web chat (#1919).** A person's click now reads "🔘 <label>" in their bubble instead of the line the agent receives (`[button] … (value: …)`), and the value is never shown. Live, the chip shows the message its buttons were on. It stays after a reload, and clicks made on Discord or Telegram show the same way. What the agent receives is unchanged.
- **Web chat takes bigger files, and the limits are yours to set (#1937).**
  - **Defaults:** 50 MB per file and 100 MB per message (was 10 MB and 25 MB), still up to 5 files.
  - **Config:** `web.upload_max_file_mb` and `web.upload_max_total_mb` change the two sizes (whole MB, 1–500). `agend reload` applies a change to the next upload.
  - **Public link:** a file is at most 95 MB, the most a Cloudflare quick tunnel carries in one request.
  - **Memory:** uploads stream to disk instead of being held in memory, and large downloads stream too. An upload that stalls for a minute, or runs past 30 minutes, is dropped with its partial file.

### Fixed
- **`update_instance_config` explicitly refuses `tool_set` (privilege boundary #804/#814).** Passing `tool_set` in the config patch now returns a clear error — `"tool_set can only be changed by an administrator via Settings or fleet.yaml (privilege boundary, #804/#814)"` — and nothing is written. Previously the field was silently dropped. To mark an instance as coordinator: edit `fleet.yaml` and add `tool_set: coordinator`, or use the **Settings** panel in the web UI.
- Kiro's native TUI trust-all-tools prompt now uses the same structural selector at startup and runtime (#849, part A). AgEnD sends one Down from “No, exit”, then confirms only a freshly observed cursor on the per-session “Yes, I accept”. Unknown layouts, a cursor that did not move, and “Yes, and don't ask again” stay held for human input; copied history cannot receive consent keys. Existing model-picker holds and engine/session pins remain intact. This does not enable `kiro_ui: v3`; v3 startup/enablement and further steering verification are parked pending native evidence and user demand.

- Each consent phase is claimed once per launch across startup/runtime, including uncertain key ACKs; stop and tmux replacement retire stale runtime keys. Native column-zero TUI composers disqualify copied trust frames.
- **Kiro conversation ownership (#906, #1410; isolation limited by #1800).** Pinned launches resume the instance’s claimed conversation by ID; new conversations use its own agent with its instructions and AgEnD MCP server. Automatic agent swapping on resumed conversations is suspended: they retain the saved agent and shared .kiro entries, so resumed instances sharing a directory are not fully isolated. User MCP servers remain loaded. Older CLIs lacking per-instance agent support still use shared MCP/steering settings; unsupported UI/engine combinations refuse to launch.
- **Data-loss fix: Settings no longer destroys a legacy `channel:` connection in fleet.yaml (#1056).**
  - With the old single `channel:` key, saving a connection's status emojis (or access) in Settings deleted the `channel:` block and wrote a `channels[0]` holding only the changed field. The next start then rejected the config ("type / bot_token_env required").
  - The save now writes the whole connection as `channels[0]`. On 2.1.x, convert `channel:` to a `channels:` list (or do not save connections in Settings) until you upgrade; a file already damaged must be restored from a backup or rewritten by hand.
- **A config save can no longer write a fleet.yaml that does not load (#1056).**
  - Every save now loads and validates the file it is about to write. A result that would not load, or would add a config error, is not written, and the save reports why (Settings shows the error and keeps the previous values).
- **A connection's status emojis apply without a restart (#1056).**
  - Changing `channels[].options.status_emojis` takes effect at the bot's next stamp, like an agent's own `status_emojis`, and Settings labels it "Immediately". The rest of a connection still needs an AgEnD restart.
- **`list_emojis` explains itself (#1056).**
  - It now has a `platform_note`, for example that Telegram has no server emoji and `standard.reactions` is the complete set.
  - Each status carries a `kind`, which says `progress_prefix` is message text, not a reaction. Settings and `set_persona_emoji` say the same.
- Fleet restarts allow five minutes for multi-batch busy-Kiro shutdown instead of the detached 10-second and systemd 60-second cutoffs (#1071). Shipped legacy unit values migrate on restart with loaded-value verification; custom timeouts/drop-ins are preserved with a warning, while `agend restart` refuses any unreadable or shorter-than-300s loaded budget. Detached waits are asynchronous and monotonic, recheck process identity before signals, and confirm exit before launching a replacement. Unknown or still-live owners refuse replacement. This remains a finite outer grace, not an unlimited guarantee for large fleets or stuck transports; launchd policy is unchanged.
- **Stale command confirmations (#1148/#754):** `/clear` rechecks current authority, source/target and the exact daemon/IPC, cached launch and lifecycle generations after platform retirement waits, before sending the destructive command. Model/effort menus also reject a source channel moved to another target within the same bot, a changed Telegram group, or an ambiguous topic mapping. F/C roles stay unchanged; clear remains excluded from web prompts.
- **In a Telegram instance topic, a command that only works in General now says so, instead of reaching the agent
  (#1148).** The forum group's command menu is the same in every topic, so `/status`, `/sysinfo`, `/dashboard`,
  `/restart`, `/update`, `/profile`, `/doctor`, `/login`, `/usage` and `/visibility` are offered in instance topics too.
  Chosen there, they used to be passed to the agent as ordinary text: nothing ran, and nothing said why. They now
  answer "works in the General topic — please use it there". In General they work as before.
- **Telegram General bot addressing (#1148/#754):** at the forum root, an explicit command suffix is checked before shared dedup, even without a message ID. A wrong or unknown receiving username cannot consume the intended bot's message or run its General command. Bare commands, Classic/present-thread behavior and exact alias forms are unchanged.
- **AgEnD no longer reads a huge transcript all at once (#1218).**
  - Before, when an agent wrote a lot between two reads (a long command's output, a multi-MB tool result, a 300 MB codex session catching up), AgEnD read the whole difference into memory in one go on its main loop.
  - It now reads at most 1 MiB at a time, a few times per poll, for claude-code, codex, kiro and muse session files.
  - A line longer than 256 KiB that holds a turn's record or a reply is still read whole, up to 16 MiB: a codex turn end with a long final reply, a pasted prompt, a long claude reply, any kiro record. So the end of a turn is never missed.
  - Any other long line, such as a multi-MB tool output, is known by its first 8 KiB, which still say which tool step it belongs to, so the progress line does not lose that step.
- View and status context refreshes reuse each instance's tmux control read lane, removing the per-instance capture subprocess when control is connected. Pending results are fenced across stop, respawn, pane replacement and cancellation.
- Cache a successfully verified OS home for the current user to avoid repeated password-database lookups in tmux namespace getters. Failed lookups remain unknown and never trust `$HOME`.
- macOS memory protection now uses only the kernel pressure alarm (1/2/4), driving warning/critical spawn admission without false triggers from available/free RAM or dynamically allocated swap ratios (#1256). Missing or malformed alarms stay unknown, do not throttle or notify, and are logged once per sampler lifecycle with bounded raw output. The existing bounded async sampler owns pressure probes; admission and tool handlers cannot start them. Linux policy is unchanged. A percentage fallback awaits separate real-Mac calibration.
- **The web chat's `/compact` now says when it is done (#1269).** The card used to say "Compact command sent" forever.
  - From the moment the command reaches the agent it says **Compacting…**, then **Conversation compacted** once the agent's transcript records it, and leaves. This works on Claude Code and Codex.
  - Other backends, kiro included, write no record AgEnD can tie to the instance, so the chat says their compaction end can't be detected and leaves, instead of claiming it finished or staying forever.
  - With no record within 10 minutes, the chat says so instead of waiting forever. If the command never reached the agent, or the agent stopped, restarted or changed backend meanwhile, it says it can't follow the compaction.
  - `/clear` and `/cancel` answers that only say the command was sent now leave by themselves. A refusal stays.
- The website installer now detects Muse and no longer advertises the removed Gemini CLI backend. Installation and quickstart behavior are unchanged.
- **Owner-gated text commands (#1346).** In multi-bot groups every bot receives its own copy of each message, so a typed `/cmd` used to be a race: whichever copy arrived first acted on it. Command-like text is now judged by topic ownership *before* the shared dedup key is claimed: a non-owner copy is dropped without consuming the key, and the permission check runs against the owning adapter's admin list (a sibling-only admin can never authorize through another bot's copy). Platform behavior: on Discord fleet topics a typed `/xxx` never runs — the owner posts one system note pointing at the `/` slash menu and consumes it, others stay silent; on Discord ClassicBot channels `/xxx` is ignored silently by every bot (no `/chat` forward either). On Telegram fleet topics a bare `/cmd` runs through the owner only, `/cmd@otherbot` is ignored; Telegram ClassicBot groups ignore bare `/cmd` (only `/cmd@ourbot` runs); Telegram private chats are unchanged. See `docs/commands.md` ("Text Commands by Platform").
- **Service unit `Environment=PATH=` no longer accumulates `node_modules/.bin` entries (#1348).** `buildServicePath()` now drops every PATH entry that contains a `/node_modules/` segment (worktree `.bin` directories and npm's own `node-gyp-bin` runner) and deduplicates the remaining entries while preserving first-appearance order. The nvm bin directory (where `agend` and `node` live) is explicitly preserved. The pollution was self-sustaining: each `agend install`/`/update` copied the calling process's PATH — which inherited the old unit's `Environment=PATH=` — straight into the new unit. The next `/update` after this fix rewrites the unit with a clean PATH automatically.
- Codex recovery no longer treats an unreadable pre-paste input/footer pair as an empty composer (#1359). A body-derived strand requires readable input both before and after the paste; structured-input recovery also rechecks ownership after both the retry delay and the Enter availability wait, immediately before the recovery key. Unknown input leaves the system notice unconfirmed rather than submitting an older draft; new positive echo/queue evidence completes without another key. Unique delivery IDs and row-only retries retain their existing behavior. Native isolated evidence includes a warning-viewer dismissal/resize race; the warmup test now uses the real empty composer fixture.
- Keep Kiro conversation reads and large-history parsing off the fleet event loop, so transcript updates do not block Discord acknowledgements. Reads use a shared, bounded worker with readonly connections, workspace-specific queries and stale-result fences; Kiro's database is never modified.
- **Reply guard false positives (#1377): a successfully delivered reply no longer fires spurious "Turn ended without a
  reply" recovery.**

  Two related races in the `#1241` idle-confirmation path were causing false positive reply-drop reports for kiro and
  other `replyCompletionGuard`-enabled backends:

  - **Case 1 (in-flight IPC delay):** the agent's `reply` tool call was processed and delivered to the channel, but the
    `fleet_outbound_response` IPC message arrived at the daemon *after* the busy→idle edge had already run and armed
    the 60-second confirmation window. Because `settleToolAttempt` had no path to `clearReplyGuardConfirm`, the timer
    fired and started recovery even though the reply had already reached the user.

  - **Case 2 (cross-instance busy/idle revival):** the confirmation window was cleared by a settle that arrived before
    the timer (handled by fix A), but the guard generation was still active. A cross-instance message processed by the
    same instance minutes later updated `busyObservedAt`, and when its turn ended, a fresh confirmation window was
    armed for the old (already-answered) human generation, eventually triggering recovery.

  **Fixes applied:**

  - `replyAttempted` check moved to *after* the `busyObserved` + confirmation-window gates (#1241) so that an
    in-flight reply whose IPC response has not returned yet receives the same 60-second deferral as a no-reply turn
    instead of being reported as "unknown" immediately at the first idle edge.

  - A new `replyAttemptFailed` flag distinguishes a definitively failed reply (adapter returned an error) from an
    in-flight one. A failed reply still fires `reportReplyDropWithoutRetry` immediately, bypassing both the
    `busyObserved` gate and the confirmation window.

  - When `settleToolAttempt` confirms a `completionAction` tool (reply/react/edit_message) at the current obligation
    level and the turn is in the `awaiting` phase (not cancelled, not recovering), it now also calls
    `clearReplyGuardConfirm`, cancelling any pending confirmation timer so it cannot fire spurious recovery.

  - `maybeConfirmReplyGuardIdle` (the steady-idle monitor path) now checks `completionDelivered=true` when there is
    no pending confirmation window — allowing the guard generation to complete on the next monitor tick without waiting
    for a new busy→idle transition.
- **A message Claude Code took at once no longer ends up "uncertain" with a ⚠️ to the user (#1379).** After the Enter,
  Claude keeps showing the pasted text in its input box for a moment. AgEnD read that as "the Enter was swallowed" and
  waited up to 30 seconds for the prompt to come back. A CLI already busy with the message never shows it, and by then
  the reply had pushed the message off the screen, so the delivery was marked uncertain even though it had arrived.
  - A pasted text still in Claude's box only counts as a swallowed Enter if it is still there after 3 seconds.
  - When AgEnD can read the CLI's own transcript (Claude Code, Codex), this delivery's exact id there now proves the
    message was taken, whatever the screen shows.
  - The log line for an uncertain delivery names the actual CLI. It used to say "Codex" for every backend.
- **Frequent fleet pane/window checks reuse the connected tmux control client (#1401, part of #1235).** Error monitors, state captures and pane health reads no longer start a subprocess for every healthy read. Queries retain fresh snapshots and caller deadlines, with bounded fallback during reconnects, output-size limits, and lifecycle checks that discard old results. Pane writes and the staggered safety-sweep schedule are unchanged.
- **The 60-second safety sweep no longer blocks the fleet for the whole sweep at once (#1402).** Every instance's pane
  check used to start in the same tick, each spawning a `tmux capture-pane`. Measured live, that tick blocked the
  fleet's event loop for 150–860 ms, and for 1–2.5 s on a busy host, so messages, buttons and the web UI stalled once a
  minute. Each instance's check now gets a tick of its own, spread evenly over the first 30 seconds of the minute.
- **Web: the sidebar's brand row and every page's header are one row (#1408).**
  - The brand row (AgEnD, hide sidebar, +) was 4 px taller than the page header, with its centre 4 px lower, so a page title such as 設定 looked higher than AgEnD.
  - The title's status, version pill and model chip sat 1–2 px below it, and the header's small buttons and the instance tabs were 30 px beside 36 px icon buttons.
  - Now, on Fleet, Needs you, View, an instance's four tabs and Settings, at desktop and phone widths, both segments are 52 px with one centre line, and the header's controls are all 36 px.
  - On a phone the instance tabs still sit on their own row under the header.
- Kiro TUI launch discovery no longer reads or parses the user's entire session history on the fleet event loop (#1417). One bounded worker validates complete JSON and caches metadata by file identity, size, mtime and ctime (4,096 entries / approximately 4 MiB); a 15-second total budget includes queue time. Adoption, exact owned resume IDs and creation-evidence-only take-up remain unchanged. Launch admission is rechecked before identity/config writes; owned resume IDs skip discovery. A cold scan still reads whole files off-thread, and worker failure/deadline uses the existing unreadable-store policy.
- **A schedule deferred by the 5-hour rate limit now runs once after the window resets, instead of being skipped
  (#1426).** "Deferred" used to mean dropped for that occurrence: a daily check that fired at 100% simply did not
  happen that day.
  - **When it runs.** At the statusline's reset time, or by checking every 15 minutes when no reset time is known.
  - **Same run, labelled.** It keeps the occurrence's run id, and the agent's message starts with
    `[retry] originally due 21:00 (Asia/Taipei), deferred by the 5h rate limit at 100%`.
  - **Never twice.** It never runs at or after the schedule's next run, and it survives a fleet restart.
  - **`last_status`.** It shows `deferred → delivered (retry)` or `deferred → skipped (…)`.
  - **When it cannot run.** If it is superseded, deferred again, or the window does not reset within 5h15m, the
    schedule's chat says so and @mentions the admins.
  - **Stale readings.** A reading whose window has already reset no longer defers anything; an idle instance's
    statusline can show 100% long after the reset.
- **Claude Code 2.1.295's new "Resume this conversation?" prompt is answered, keeping the conversation (#1434).**
  The prompt can open while an instance with a large context sits idle after its prompt cache has gone cold, and on
  resume. While it is up, a delivery's text only goes into the input draft and Enter is refused. AgEnD now answers
  it like the older resume menu: it presses Esc, which the prompt itself labels "resume", only on the exact shape,
  and checks that it closed. Any other shape is held for a human. AgEnD never picks "Start a new conversation",
  which would clear the context.
- **A codex instance that runs out of usage continues on Luna Reserve again, instead of waiting for a human (#1439).**
  - When codex switches to Luna Reserve it shows a picker: the server's offers (Upgrade, Reset usage, Add Credits, …),
    then "Continue with Luna Reserve". AgEnD answers it with Escape, which continues on Luna Reserve.
  - The server changed its offers, starting with "Upgrade", and AgEnD stopped recognising the picker. Instances were
    parked on it until someone pressed Escape by hand.
  - The picker is now recognised by the parts codex itself draws, whatever the server offers above them.
- **codex 0.162: AgEnD still recognises the "conversation is open in another app" screen and the resume directory picker (#1443).**
  - codex 0.162 writes the Control key as `^c` on Linux (`⌃c` on macOS) where it used to write `ctrl+c`.
  - AgEnD found both screens by that text. On 0.162 the "open in another app" screen was no longer held for a human,
    and the directory picker was reported only as an unknown menu.
  - Both spellings are now recognised, so these screens are held for a human again on every codex version.
- **`agend update` no longer removes AgEnD before the new version is installed (#1446).**
  - It took every normal global install for a local `npm link` and unlinked it first, so a failed install (network,
    an incompatible Node, a full disk) left no `agend` at all. Now the current install stays until npm has replaced it.
  - After installing, the update checks that `agend` on your PATH is the new version and that it can open a database
    on the Node it runs with, before restarting anything. An installation running on nvm's Node is checked, refreshed
    and restarted on that Node.
  - A `systemctl restart` that fails is reported as a failure, instead of as success. A restart that systemd is still
    running when the update stops waiting is reported as still running, not as done.
  - Running `agend update` again after a failed check no longer restarts the fleet onto the version that failed it.
  - The fleet is restarted only through the verified install, and only when the service starts that install. If the
    service still points at another install, the update says so and leaves the running fleet alone.
- **Web app: layout follow-ups from the alpha.2 sweep.**
  - In Settings, a change waiting for an admin's confirmation shows in the page, right under the operation, instead of as a card covering it. Other panels keep the card in the corner.
  - On a phone:
    - Settings → Developer keeps its toolbar on one row of icon buttons;
    - the YAML editor scrolls sideways instead of wrapping lines, and a shadow at the edge shows there is more;
    - the agent's profile line in View wraps to two lines instead of being cut;
    - every agent row in Settings wraps its tags the same way;
    - the buttons in **Needs you** and in Teams line up with the text above them.
  - The docs say why the sign-in page logs one 401 before you sign in.
- **Web app: fixes from the alpha.2 regression sweep.**
  - A Fleet list the server fails to load shows the error state with **Try again**, instead of "No tasks yet".
  - Settings no longer asks for provider secrets on a fleet that has none, which removes a 404 from every Settings load.
  - Counts of one are singular: "1 task", "1 connection", "1 room".
  - On a phone:
    - a connection's name keeps its line;
    - Settings' tabs fit the screen;
    - the buttons in Settings rows and in **Needs you** are full-size tap targets;
    - the command palette's descriptions wrap instead of being cut;
    - **Stop reply** is icon-only when there is no room, so the message box keeps its placeholder.
  - In a chat on a desktop, notices appear under the header instead of over the composer's buttons.
  - The sign-in hint never breaks `agend web --code` across lines.
  - The working dot's pulse stays visible on dark backgrounds.
  - The docs cover Fleet → Org chart, Fleet → Cache and the chat's commands.
- **An agent request that is too large now gets a real "413 Request body too large" (#1489).** `POST /agent` already refused requests without a valid instance token before reading them, and never buffered more than 512 KiB. But a request with a valid token and a declared body over the limit saw only a dropped connection. It is now answered with 413 before any of the body is read.
- Updates use the actual restart outcome: pending returns exit 75 and retains repair copies, while failed activation returns exit 1 instead of success (#1490). A failed systemd start can restore this update's package and unit preimages only with unchanged loaded/disk ownership and a confirmed stopped runtime; recovery proves the old loaded target before starting it and still reports the update as failed. Unknown/changed owners and detached failures require operator inspection. System-source Node mismatches now explain user-unit, system-unit and launchd recovery without weakening restart checks.
- **Atomic file writes now include fsync.** Three files that used write+rename without fsync are fixed: `fleet.yaml` (save path in `FleetManager`), `web-sessions.json` (`WebSessionStore.persistNow`), and `update-marker.json`. All three now follow write → fsync(temp fd) → rename → fsync(dir, best-effort). A new `atomicWriteFileSync` helper in `src/atomic-write.ts` is shared by the update-marker and session paths; `FleetManager` uses the same sequence inline to preserve its pre-write validation step. (#1490 P3)
- **Backend detection no longer blocks the fleet (#1490):** `/ui/backends` ran `which` up to seven times per request, synchronously and with a 2 s timeout each, on the fleet's event loop. It now runs `which` as asynchronous child processes that must answer within 2 seconds (one that does not is killed and the backend shows as not installed, as before). An answer is reused for 30 seconds and concurrent requests share one lookup. A lookup that hangs, such as on a dead network mount, costs at most one process per backend until it really exits, never one per request. `/login` still probes fresh, so a CLI it just installed is seen at once.
- Chat updates from a Linux service run in an independent same-user systemd scope, so stopping the fleet does not kill its updater (#1490). Unknown cgroup state or an unavailable scope launcher refuses with host-shell recovery instructions. Installed-path verification, environment, working directory and the two-second delay are preserved; no credentials are placed in argv.
- **`create_instance`: `tool_set` and `skipPermissions` refused with a privilege-boundary error.** A steered General could use `create_instance` to spawn a `full`-profile, no-confirmation worker. Both fields are now refused before Zod's `passthrough()` can forward them to instance-lifecycle. The error message matches the existing `update_instance_config` refusal from #804/#814. (#1490 P3 #13)
- **`update_instance_config`: in-memory patch is rolled back when `saveFleetConfig` throws.** Previously, the instance config was mutated in memory before saving. A failed save left memory and disk inconsistent. The handler now rolls back the in-memory state on save failure. (#1490 P3 #48)
- **A history file that is only locked or unreadable is no longer thrown away (#1490):** when `events.db` could not be opened, the fleet renamed it to `events.db.corrupt-<time>` and started an empty one, whatever the reason. Now only a file SQLite proves is not a usable database (`SQLITE_NOTADB`, `SQLITE_CORRUPT`) is moved aside. A lock that lasts past the 5-second busy timeout, a SQLite driver that does not load on this Node.js (built for another version or architecture), or a permission or disk problem leaves the file exactly as it is: the fleet runs without event logging until it restarts, and posts the reason (with `npm rebuild better-sqlite3` for the driver case) to the General topic.
- **Kiro transcript reads recover from one stuck worker:** after a read times
  out, its worker loses read ownership and a replacement can resume from the
  source's accepted cursor without restarting the fleet. Late replies and exit
  events cannot affect the replacement. A retired worker still occupies a
  physical slot until it exits; at most two workers can exist. If both native
  calls remain stuck, reads retain their 15-second deadline and legacy fallback
  until one exits. Kiro's shared database remains read-only. (#1490)
- **Kiro session lookup no longer scans on the event loop (#1490):** while the Kiro store has no conversation for an instance yet, its transcript source falls back to Kiro's session files. On every 2-second poll it listed the sessions directory and checked every session file synchronously, which took 16–18 ms per instance with 5,000 sessions. The lookup is now asynchronous. A poll checks only the directory and recently active sessions, the directory is listed again only when it changes, and a full rescan runs every 30 seconds, at most 16 file checks at a time.
- **`/model`: reject names with newlines or control characters.** A model name containing `\n`, `\r`, or other control characters was persisted to `fleet.yaml` and pasted raw into the CLI session. The command now returns an error and does not write or paste. (#1490 P3a)
- **Pause/wake handler: own-key check prevents inherited prototype keys from matching instances.** User-supplied instance names like `__proto__` or `constructor` are now checked with `Object.hasOwn` before the instance lookup, so they correctly return "instance not found" and never reach `runPauseWake`. (#1490 P3b)
- **Profile handler: own-key membership enforced before general_topic lookup.** `handleGeneralProfile` now checks `Object.hasOwn` before reading `instances[general]`, so an inherited prototype entry with `general_topic` cannot impersonate a real General — it is refused with "available only in General". (#1490 P3b)
- Fleet startup now reports whether the durable delivery outbox is locked, corrupt, blocked by a native SQLite driver mismatch, or unavailable for another reason, with recovery instructions. AgEnD does not quarantine or reset the queue; startup and new admission remain refused instead of discarding pending messages or submission evidence. Failed initialization/recovery closes its database owner and cannot publish a partially recovered store. (#1490)
- **Quickstart "Add allowed users": supports `channels`-shaped files.** Extracted as `addAllowedUsersToConfig()` (exported). When `fleet.yaml` uses the `channels:` array shape, correctly reads and updates the chosen connection's `access.allowed_users`, and never writes a phantom `channel:` key. Multi-connection files show the connection `id` and `group_id` for disambiguation. (#1490 P2)
- **Quickstart "Overwrite (start fresh)": backup is fail-closed.** Extracted as `backupFleetConfig()` (exported, async, throws on failure). If the backup cannot be written, the overwrite is aborted and an error is printed — the user is never left without their config while believing a backup exists. (#1490 P2)
- **Scheduler: `recordRun` is now atomic.** The `INSERT INTO schedule_runs` and `UPDATE schedules SET last_status` are wrapped in a single transaction. Previously a crash or error between the two statements could leave an orphaned run record without an updated `last_triggered_at` / `last_status` on the schedule. (#1490 P3)
- **A recovery Enter goes only to the window it was for (#1490):** when a delivery's Enter did not submit, AgEnD waits for the prompt and sends one more Enter. If the window was recovered during that wait, the extra Enter went to the new window and the check that followed judged the new window's pane. These recovery Enters are now fenced to the window and spawn they were for, up to the moment the key is sent, and no proof is read from a replaced window.
- **`retireSystemCopy`: uses `join(nvmBin, "npm")` for all npm operations.** For nvm installs, `npm` binary path is now `join(plan.nvmBin, "npm")` — the same binary npm actually invokes via the modified PATH in `inInstallEnv`. This path is used for prefix lock, rollback root, install, verification, and retirement, ensuring `outcome.npmPath` matches what was actually invoked. `retireSystemCopy` takes the explicit path and returns `{ ok: boolean }`; callers set `process.exitCode = 1` on failure. Non-nvm installs do not perform retirement and skip the lookup. (#1490 P3)
- **`saveCpuProfile`: large profiles rejected before `JSON.stringify`.** Size estimation now accounts for all variable fields per node: callFrame URL and functionName (using `Buffer.byteLength(JSON.stringify(str), 'utf8') - 2` for exact UTF-8+escaping bytes), positionTicks arrays (V8 real field; 800k entries can exceed 16 MiB alone), and children arrays. The check exits the estimation loop early when the cap is reached, avoiding per-node work for oversized profiles. (#1490 P3)
- **`CacheService.stop()` returns `Promise<void>`, sets a closing flag, and flushes dirty data bounded to one save.** A `closing` flag fences new `kick()`/`start()` calls immediately. The in-flight pass loop exits at its next iteration boundary (not full backlog), then one bounded `save()` runs before `stopped = true`. `FleetManager.doStopAll()` now awaits `cacheService.stop()`. (#1490 P3)
- **`TmuxControlClient`: observation age uses monotonic clock.** `observationResetAt`, `inObservationGrace`, `lastOutputAt`, and `isIdle` now all use `this.mono()` (backed by `performance.now`) instead of `Date.now()`. A wall-clock jump (NTP, daylight saving) can no longer cause a pane to appear idle before the silence window has elapsed or to remain in grace longer than expected. (#1490 P3)
- **`TmuxControlClient.waitUntilIdle`: resolves `false` when the client is stopped.** Previously it resolved `true`, which would have told callers the pane was idle and triggered delivery into a stopped client. (#1490 P3)
- **A window the fleet can no longer resolve is not treated as idle (#1490):** after three failed `tmux list-panes` for a registered window, the control client used to forget the window, and an unknown window counted as idle once the reconnect grace was over. A delivery could then paste into a CLI that was still generating, where Enter interrupts it. Such a window is now kept as lost and reported busy; asking about it retries the lookup at most every 5 seconds, and once it resolves it is registered again and counts as idle only after 2 seconds of observed silence. A registered window whose pane is not resolved yet after a reconnect is also busy until it resolves. Windows that were never registered keep the previous behaviour.
- **tmux observation after a reconnect, and one slow read (#1490):** after the tmux control connection reconnects, a window counts as idle only once it has been quiet for 2 seconds since its own pane was found again. Previously the 2-second grace started at the reconnect, so with many windows, or with tmux slow under load, the last windows read idle at once and a message could be pasted into a working CLI. A single control read slower than its 2-second budget is now answered by a one-shot read and drained, instead of tearing down the whole control connection and its view of every pane. The connection is reset only if that read's answer never arrives within 10 seconds.
- **Web app: the page no longer scrolls as a whole (#1509).** With a long instance list, the chat page showed two scrollbars, its own and the whole page's, and could scroll the header out of view. Now only the panes scroll.
- **Discord `/dashboard` answers where you clicked (#1512).**
  - The menu is the command's private reply. After a click, the menu itself now changes: first to "sending…" or "opening the public link…", then to where your sign-in details went (by DM, or posted privately right there when the bot cannot DM you).
  - Previously AgEnD looked for that private message in the channel, which Discord can never find (`10008 Unknown Message`). So the menu stayed unchanged, a second click on it did nothing visible, and the outcome was posted publicly in General instead.
  - An expired or stale menu now collapses in place too.
  - `/dashboard` always answers. A menu that cannot be shown says so, instead of leaving Discord to report that the application did not respond.
  - When a DM cannot be delivered, the log says why (for example Discord code 50007: the user does not accept DMs from server members).
- **Web app: on a web-only fleet, a turn that ends without a reply is now caught (#1515).** Messages sent from the web chat to a fleet with no Discord or Telegram connection never armed the reply-completion guard, so an agent that answered in plain text left the chat silent. They now get the same single reminder as platform messages.
- **Web app: clicking another instance keeps the sidebar where it was (#1515).** In View, the instance list jumped back to the top on every click; in both View and Chat, the active instance is now kept in view without moving the list otherwise.
- **Web app: Discord custom emoji show in the status-emoji editor again (#1520).** In Settings → Connections → Discord → Status emojis, every server emoji appeared as a broken image, because the page's security policy refused Discord's emoji CDN. Panels now allow images from exactly `https://cdn.discordapp.com/emojis/` and nothing else from Discord.
- **`/usage`: 429 from vendor usage endpoint no longer shows a red error.** A rate-limit on the *query* endpoint says nothing about the user's subscription. When a cached snapshot exists, the stale numbers are shown instead (existing behaviour). When there is no cached snapshot, a neutral message is shown ("can't fetch usage right now, doesn't affect your agents") instead of a red alarm. The Retry-After header from the 429 response is now respected: force-refreshes within the backoff window return the cached value instead of hammering the vendor endpoint.
- **Public-link progress draws each failure on the step it belongs on (#1525).** A refused tunnel lane (`lease-held`) used to fail ① "Check cloudflared", looking like a cloudflared problem; it now fails ④ "Start the tunnel" with the existing "another tunnel is still running" sentence. A request that ends before its own ⑥ begins (lost currency after a completed shared start) used to mark the successful ⑤ as failed; it now draws the failure on ⑥ and ⑤ stays ✅.
- **Settings: adding a connection never replaces an existing one (#1529).** The setup wizard matched an existing connection by its token variable and overwrote it, so adding a Discord bot after a Telegram one could silently replace the Telegram connection. Every new connection now gets its own id (`discord`, `discord-2`, …) and its own token variable, and one that would take another's is refused.
- **Settings: each connection shows its own state (#1537).** Every connection used to say "Connected" whenever AgEnD was running, even one that had not started or whose token was refused. Now each row shows that connection's own state: Connected · @your_bot, Reconnecting, Starting, Not running, Token missing, Token rejected, or the Message Content Intent fix.
- **Wizard-created Discord connections now bind the General channel correctly.** `planQuickstart` was writing `general_channel_id` at the top-level of the connection (introduced in c25045b0), but the runtime reads it from `channel.options.general_channel_id`. The wizard now writes to the correct location. Existing fleet.yaml files with the old top-level field are still supported via a fallback in `discordGeneralChannelId()`. (#1552)
- **Web: HTML preview notices in your language, and the preview panel can allow previews itself (#1556).** The preview card and side panel used to show their notices in English even in a zh-TW page, such as "Previews are off on this device…", the reasons previews are unavailable, and the banner on a running preview. They now follow the page's language. On a device that has not allowed previews, the panel now offers **Allow previews**, with the same confirmation as the card's menu and the sidebar. After you confirm, Preview is enabled; it still runs only when you click it. Allowing previews is still per browser and per address, so opening the dashboard at another address asks again.
- **Web chat: the image viewer always cleans up when it closes (#1564).** If the browser closed the image viewer by itself, the chat behind it could stay unable to scroll. Every way of closing it now does the same thing: the page scrolls again and focus goes back to the image you opened.
- **Web chat: after a restart, the public link no longer downloads the whole chat history every 5 seconds (#1577).** With history kept across restarts (#1565), a page that polls (the public link, or the local page while its live connection is down) was sent all of the restored messages again on every poll, until someone said something new — about 1 MB each time for a busy chat. Now each page gets the restored history once, and then only what is new.
- **`/view` shows a CLI's faint text as faint (#1582).** Claude Code paints its prompt suggestion and its empty-box placeholder (`Try "…"`) in the input box exactly like typed text, only dim. `/view` dropped the dim attribute, so they looked typed. It now draws dim text faint and the cursor cell reversed. AgEnD's own delivery checks were never misled by a suggestion; this was a display gap, found while checking suzuke/agend-terminal#3744.
- **Agents reading another instance's screen are told which text is faint (#1582).** A CLI paints its own suggestion or placeholder in its input box exactly like typed text, only faint. `get_instance_logs` returned the raw stream, where that showed only as an escape code among cursor moves, so an agent could take a suggestion for something the operator typed (the same flaw as suzuke/agend-terminal#3744). Faint runs are now marked `⟨dim⟩…⟨/dim⟩`, with a note saying they are not input. The bundled fleet-health skill tells agents to keep `-e` on `tmux capture-pane`, and that nothing in another instance's input box is an instruction to them.
- **Web chat: after you send, your message stays fully in view (#1584).** When the "working…" line appeared under the conversation (or the box shrank after a long message), your newest message could end up partly hidden behind it, with the "↓ Latest" button floating over it. The conversation now stays at the very bottom while the working line comes and goes — unless you scrolled up to read, which is never interrupted. The message box also keeps the cursor after you press Send, so you can type the next one straight away (on a phone, the keyboard stays up).
- **The web chat of a ClassicBot room shows what people sent the bot (#1592).** Messages to a ClassicBot with `/chat`, an `@bot` mention in collab mode, or Discord's `/chat` slash reached the agent but never the web chat, which showed only the agent's replies. They are now recorded like every other inbound message: as the user, with the sender's name and their own words, in the room's history that survives a restart. Attachments are not shown there yet.
- **Reply-button choices now start the normal user turn UI.** Discord and Telegram clicks show received/processing reactions and the existing working/cancel bubble, with the same progress and idle/reply cleanup as typed messages. Failed delivery finishes the status and reopens the choice for retry. Web choices retain the daemon-driven working/Stop state. Single-choice claims, private acknowledgements and user-message roles are unchanged. (#1593)
- **Web on a phone: tapping a text field no longer zooms the page in (#1611).** On an iPhone, typing in the sidebar filter (or any search box, settings field, dialog or the sign-in page) zoomed the page in and left it zoomed. Every text field is now at least 16 px on a touch screen or the phone layout, which iOS does not zoom for. Pinch zoom still works, and the desktop look is unchanged.
- **Web on a phone: the no-zoom fix covers every text field, including future ones (#1615).** Follow-up to #1611: a text field that takes its size from the text around it (rather than setting its own) is now also at least 16 px on a touch screen or the phone layout, so iOS never zooms the page in on focusing it. Larger fields keep their size; the desktop look is unchanged.
- **A stale button on one bot no longer waits on another bot's prompt (#1617).** Since #1610, a stale tap on a message that already shows the next step (the public link's confirm/cancel) is only acknowledged. That check now also requires the same bot, so when two bots' message ids collide, one bot's live prompt can't stop the other bot's stale button from being tidied away.
- **Kiro keeps its conversation when upgrading from before the launch ledger (#1624).** On the first launch with
  kiro-cli 2.21+ (`--agent` and `--resume-id` supported), an instance without identity or launch history adopts the
  newest conversation in its engine's store only if no other configured Kiro instance shares its canonical working
  directory and that conversation is unclaimed. Fleet and ClassicBot entries count even when stopped. Ambiguous
  ownership starts a new conversation and posts a notice once; old conversations stay untouched. Older Kiro versions
  keep their existing launch behavior, and upgrading Kiro across 2.21 still adopts from its old-style launch record.
  Deliberate fresh starts and identity keys already recorded as fresh are never automatically re-adopted. Instances
  that already started fresh on beta.1 need manual recovery; see [Kiro recovery](kiro-upgrade-recovery.md).
- **ClassicBot agents can verify message delivery (#1626).** `delivery_status` no longer fails with
  `Unrecognized key: "chat_id"`. ClassicBot's room override now applies only to channel-addressing tools;
  other tool arguments are left intact. Replies, reactions and edits still use the ClassicBot's own room,
  including the original Telegram forum topic. Delivery-status validation stays strict.
- **Web: uploading a View picture no longer deletes another instance's picture (#1630 follow-up).** An upload used to delete every stored avatar whose name began with the instance's name and a dot. So uploading for `a` also removed `a.b`'s picture. Instance names may contain a dot (the Settings quickstart allows it, and so does a hand-edited `fleet.yaml`). Now an upload replaces only the file that instance's own profile records.
- **View: saving one profile field no longer clears the others (#1630).** A profile save now changes only the fields it carries (display name, role, description). A field left out stays as it was, and a blank one clears it. View's own editor always sends all three, so nothing changed there; any other caller that sends one field no longer wipes the rest.
- **View: clearing a display name brings back the agent's own (#1630).** Clearing the display name in View's **Edit profile** used to store an empty name, which still hid the name the agent had given itself (`set_display_name`), so the instance name showed instead. Clearing now removes the override, and the agent's own name (or the instance name) shows again. Display names cleared before this release recover too.
- **A hand-started fleet keeps updating on hosts without a reachable service manager (#1631).** On Linux without a user systemd manager (containers, WSL without systemd, SSH without linger) or a Mac without a GUI session, `agend update` used to create a systemd unit or launchd plist for a fleet that had none. Every later update then rolled back with "The previous package is back in place". The updater now only refreshes a service that already exists. The new version's `agend install --no-activate` also writes nothing when it can tell for certain that an older updater started it, so an update from 2.2.0-beta.1 no longer leaves a file behind either. A manual `agend install` still creates the service, and an existing service is refreshed as before. If an earlier update already left a file on such a host, remove it (`~/.config/systemd/user/com.agend.fleet.service` or `~/Library/LaunchAgents/com.agend.fleet.plist`) and run `agend update` again.
- Correct agent-facing delivery verification advice: “Delivery not found” can mean an ACL-hidden row, expired retention, or no delivery. Agents must obtain an explicitly forwarded verifiable reference before acting, and must not resend uncertain deliveries. Existing instances receive the correction once on reaching 2.2.0; delivery queries and scanner behavior are unchanged.
- **Agents: what AgEnD tells them matches what it does again (#1634).** The fleet instructions, the agent CLI reference, General's core rules, the tool descriptions and fifteen bundled skills were checked against the code. They now describe `reply`'s buttons and stickers, messages from the web chat, the real image / file / quote markers, delivery states (accepted is not delivered; never resend on `uncertain`), `get_fleet_status` (counts only; per-instance state is on `list_instances`), what `agend fleet restart` does (graceful; `--reload` for new code), `--yes` from a fleet session, how each backend resumes its own session, per-backend logins, the reply guard on Codex and Muse, the refused `kiro_ui: v3`, and the current model-listing commands. The MCP server now reports the real AgEnD version (it said 0.3.0) and names it in its instructions, so an agent can tell that a tool description it loaded earlier is older.
- **Settings: the reply-completion guard note is right for Codex and Muse.** Since 2.2 the guard works on Codex and Muse too, but Settings still said "Stored but inactive: codex in mcp mode does not support reply-drop recovery". It now says the guard is available for Claude Code, Codex, Muse and Kiro legacy/TUI in MCP mode.
- **A rate-limited or monthly-capped kiro instance is reported (#1636).** When kiro is throttled it prints `⚠️  Kiro rate limit reached:` and `Request quota exceeded. Please wait a moment and try again.`, and at its monthly cap `Monthly request limit reached` (alone on its line, or with the date the limits reset). Neither comes with the "Kiro is having trouble responding right now" header or an exception name, so neither matched any of AgEnD's kiro patterns: the instance was never flagged and nobody was told. Both are now a rate limit that notifies, as kiro's other throttling messages do. An expired login on the same screen still pauses first, and a message that merely quotes these lines does not trigger anything. The upstream-release precheck now tells the auditor when a "new" string may only be an old one stored in a new order; it still counts as new, for the auditor to decide.
- **A codex instance falsely marked `stuck` comes back on its own, and a stuck target's waiting messages are visible (#1641).** After a restart, a resumed codex shows its idle composer with only `⚠ N warnings · f2 to view` on the footer (no Context meter until its first turn). AgEnD reads that as working (by design, #1031), and a still pane then turned `stuck` with no way out: the pump never hands work to a stuck target, so its queued messages waited for hours at attempt 0. A stuck instance now returns to idle when its pane shows the CLI's own empty composer and codex's rollout shows no turn running. Without a rollout to ask, the same composer has to hold still for 10 seconds. A turn that is still running never counts, and while codex's rollout shows a turn running, no reading of the pane counts as idle, including a turn that was already running when AgEnD began following the rollout. `delivery_status` now says why a queued message waits (`waiting_reason`), and if an always-on instance's queued messages have waited 30 minutes for such a reason, its topic is told once.
- **A silent schedule that landed is no longer reported as "could not confirm", and never shows up in Needs you (#1647).** When a paste from a silent schedule (or another raw paste) can't be proven on the pane right after Enter, AgEnD now looks for the turn it started:
  - **Claude Code:** the transcript entry whose original message contains only one text body, which matches the pasted text after removing Claude's paste wrapper and normalizing whitespace, after the write checkpoint. The transcript path comes from its own statusline.json.
  - **Codex:** not covered — its rollout is chosen by working directory only and can't be bound to this launch, so a Codex raw paste the pane couldn't prove stays "could not confirm".
  - **kiro:** judged by its input row — the pasted text must be gone, or kiro's busy marker shown in its place, with output after the Enter.

  If the turn shows up, the delivery counts as delivered. If not, it stays unconfirmed with the real reason, and is never pasted or sent Enter twice. An unconfirmed or failed silent schedule now goes only to the leader as a notice that names the cause, not into Needs you, and the next run goes ahead as usual. Human messages still show up in Needs you as before. The log now carries the cause behind "a delivery error was recorded", and `delivery_status` describes such a row as "could not confirm".
- **Agents in CLI mode are told the commands they actually have (#1650).** An instance with `agent_mode: cli` has no MCP tools, but every message it received still ended with "Reply using the reply tool" or "use send_to_instance / report_result". Those footers now name the `agend-agent` commands: `agend-agent reply "…"` for a user, and `agend-agent report <sender> "…" <correlation_id>` or `agend-agent send <sender> "…"` for another instance. Instances in the default MCP mode see exactly what they saw before.
- **Agents: a Telegram `edit_message` with `format: "markdown"` no longer fails on `<` or `&` (#1651).** Since #1654 such an edit was sent as Telegram HTML as-is, so text like `a<b` or `x & y` was refused ("can't parse entities") where it used to go through as plain text. The edit text is now converted from markdown with everything escaped first: `<`, `&` and `>` are shown as typed, and **bold**, *italic*, ~~strike~~, `code` and http(s) links are rendered. If Telegram still refuses the markup, the edit is retried once as plain text. Tables and code blocks don't re-render on edit.
- **Agents: `edit_message` keeps a message's formatting (#1651).** `edit_message` took a `format` but ignored it, so on Telegram an edit to a message that was sent with `format: "markdown"` came back as plain text. An edit now renders like `reply`: `format: "markdown"` is rendered on Telegram, and Discord, which always renders Markdown, is unchanged.
- **nvm-route update no longer fails when the old root copy can't be sudo-removed (#1660).** Retiring the old system copy is cleanup: once the new version is installed, verified and running, a refused `sudo -n npm uninstall` becomes a warning instead of exit 1. Chat `/update` reports success, then appends the warning plus the verbatim, shell-quoted manual command to the same update message once the retire outcome lands (the updater retires only after the restart returns, so completion and cleanup notification have separate lifecycles guarded by the update receipt). `sudo -n` stays non-interactive — it never prompts for a password. Real install or verification failures still fail exactly as before.
- **A message sent from the web chat now shows the 🛑 Cancel/progress bubble in the instance's Discord/Telegram topic (#1666).** Until now only a message typed in Discord or Telegram started it; a web message's turn showed a bubble only after the agent's first reply. The bubble appears right after the web message's echo in the topic and follows the same rules as before: it updates while the agent works, goes away when the agent replies while idle or on Cancel, and only people allowed in that topic can press it. A web-only fleet, a message that wasn't delivered, a fleet with the web echo turned off, and ClassicBot instances show no bubble.
- **The instance header and usage rail stay put across Chat, View, Log and Details (#1673, #1218).**
  - The usage rail was not drawn on Log, so on a wide screen the page and its header jumped 320 px when you switched to it. ◔ on Log then turned off a rail you could not see, so it was gone when you went back to Chat.
  - Log now shows the rail like the other tabs. Showing or hiding it is still this device's choice, and it stays the same on every tab.
  - The tab bar and the header's buttons now have the same size and position on every tab: the text-size button is as wide as its widest name ("Fit" included; its zh-TW name is now the shorter 「填滿」), the current tab's bold label no longer resizes the bar, and Log keeps the room the other tabs use for ⋯ or ⓘ.
- **View's text size (Aa) applies at once (#1674).** Choosing Fit, S, M or L on the View page used to show the new size for under a second; the next screen refresh put the old size back until you left the page and returned. The terminal now keeps the size you chose through every refresh and resize. Chat, Details and Fleet already changed at once.
- **Web: the Fleet org chart can be reached again (#1675).** With an instance open, the sidebar's **Fleet** row (and the phone's Fleet tab) goes to that instance's Details, so the Fleet panel and its **Org chart** were out of reach. **Fleet overview** at the top of the sidebar, or at the top of the drawer on a phone, now opens the Fleet panel on the Org chart from any page, with Tasks, Schedules, Teams, Cache and Config a click away. `/ui/fleet/org` works as before.
- **Repeated host-memory chat notices are gone (#1685, superseded by #1712).** The final 2.2 behavior removes all pressure and recovery broadcasts on every platform. Memory admission slowing/holding, logs, dashboard status and health degradation remain; a held human start/restart/wake action gets its reason.
- **`/model` on a Claude Code instance no longer leaves it stuck on Claude's "Switch model?" confirmation (#1690).**
  - Claude 2.1.296 asks to confirm a switch when the conversation is cached for the previous model, and nothing answered it. The pane waited forever with messages queued behind it.
  - **Your switch is confirmed for you,** but only when the dialog names the model you asked for. The reply tells you Claude's next answer re-reads the full history.
  - **If it names a different model,** AgEnD answers No and tells you.
  - **Unknown names are refused** (for example a typo like `opsu`) before anything is typed. Claude itself accepts any name and would switch to it.
  - **Messages are held** while the confirmation is on screen. A confirmation AgEnD didn't ask for is never answered: it is held and shown as **Needs you**.
  - Applies to `/model` from Discord, Telegram, the web and the model menu.
- **Web: creating a team no longer overwrites an existing one, or saves members that don't exist (#1692).** The dashboard's **New team** wrote the team directly to fleet.yaml. It saved any member names it was given, and it silently replaced an existing team of the same name, losing that team's members and description. It now goes through the same path as the agents' `create_team`:
  - the members must be instances of this fleet;
  - an existing team is refused ("Team already exists") and left as it was;
  - names such as `constructor` are refused.

  If saving fleet.yaml fails, no team is created.
- **Restart reply reminders stay bounded** (#1694): each restart sends one notice with up to ten unanswered requests and a count of the rest. Reply obligations expire 24 hours after the last ask by default (`defaults.reply_obligation_ttl_hours`); the requester is told once if no overdue notice was sent. Fresh requests and turn-ended reminders remain supported. Answers still need the request's correlation ID; an unrelated plain message does not close it.
- **An agent on a credential profile whose sign-in expired is now reported, not ignored (#1699).**
  - AgEnD double-checks a sign-in error before pausing anything. It used to check the backend's default login, so an
    agent on another profile looked fine whenever the default login was, and its error was dismissed as conversation
    text.
  - The check now uses the agent's own profile, for Claude Code, Kiro and Codex alike.
  - The alert names the profile and only its agents, and gives the exact command that signs that profile in.
- **Web: spell checking is off where it should be (#1700 follow-up).** The sidebar filter, the bot-token field, the fleet.yaml editor and the delete-confirmation box were meant to have spell checking off, but they rendered with it on. In Chrome with enhanced spell check, the text of a bot token shown in the token field could be sent to Google's spelling service. Spell checking is now really off in all four.
- Linux no longer reports memory pressure or slows new agents just because cold swap is full with ample available RAM. PSI stall measurements drive warnings/holds alongside RAM safety floors; unavailable PSI falls back safely. The log and dashboard retain the pressure signal; all memory-pressure chat broadcasts are removed by #1712.
- **muse: an approval prompt with `skip_permissions: false` is a permission interaction awaiting a human (#1715).** With approvals left on, muse stops at its "Would you like to run the following command?" prompt (escalated pair or `--approval-mode untrusted` staged triple) that no dialog matched, so the instance just read as busy and nobody was asked. AgEnD now recognises the whole prompt — both option shapes, the staged `Stage N/M` / `Current argv` rows, 1.4.4's `›` marker and missing footer line — holds deliveries while it is on screen (Enter would take the preselected allow option), and reports it as `awaiting_input` with a permission Needs-you item, never answering it. The prod `skip_permissions` path is unchanged (an escalation is denied by muse itself with no prompt).
- **muse: `/quit` with a running background task is handled deliberately instead of hanging on the quit menu (#1716).** With a backgrounded task running, muse answers `/quit` with a "Local work is still active" confirmation (`1. Exit anyway` / `2. Stay`) that no dialog matched, so stop/restart waited out the quit timeout and fell back to blind Ctrl-C. AgEnD now recognises the whole menu, holds deliveries while it is on screen (a stray Enter would pick "Exit anyway"), and the stop flow cancels it with Escape — never answering an option — before stopping the process itself, reusing the #1217 path. The ended background work is recorded and reported, never silent: the stop posts it to the instance's topic, the Classic /stop reply appends it, and the fleet restart/update completion names the affected instances (each scoped to its own operation, so an older stop never reports). An idle auto-pause additionally defers while background work runs (see #1717) instead of silently killing it.
- **muse: a running background task no longer blocks idle detection — the composer is free, so the instance reads as idle (#1717).** While a background task runs, muse draws a terminals panel (`main · ↓ to select` / `└ ◆ … running 11s`) between the input box and the status bar, which failed the idle proof; the instance read as neither busy nor idle for the whole task and idle-edge actions (deliveries, cancel retirement, readiness gates) waited. The footer check now accepts exactly that panel shape — header plus `running` task rows, status bar still last — while a genuinely busy turn (interrupt hint above the box, including a turn started while a task runs) still fails the proof and unknown shapes still fail closed. A background task therefore counts as "local work still active", not busy: idle-for-delivery passes, and an idle auto-pause defers while the panel shows running work instead of killing it.
- **Web chat: a long status line's time is drawn on one line again (#1726).** A message from another agent (a `send_to_instance` line) showed its time one character per line beside a long text. The line had picked up the header badge's layout through a shared class name.
- **A public link's HTML preview that comes up unreachable is opened once more (#1732).** Quick tunnels sometimes are not reachable within their startup minute; the preview's tunnel is then started again, once, with a new address, in the background. The card keeps saying *Preview is starting…* meanwhile, and the link itself is never affected.
- **kiro legacy UI: a turn ending with a shell tool whose output has no trailing newline no longer leaves the instance stuck (#1734).** When kiro produces output that doesn't end with a newline, it appends `- Completed in …` on the same line as the last output byte. The completion detector was anchored to a line start and missed it, leaving the tool — and the instance — appearing busy. A queued or scheduled message would park, and the post-submit check would raise "could not confirm" alerts about 10 minutes later. The detector now matches ` - Completed in` preceded by any whitespace, covering both the normal newline case and the same-line case.
- **Chat `/update` shows the "old system install was not removed" note on every kind of restart (#1735).** When an update moved AgEnD from a root-owned install to nvm and could not remove the old copy, the note and its manual command reached the terminal but were missing from the chat summary whenever the fleet restarts without waiting (a fleet started by hand, or macOS launchd). The summary now carries them either way. The note also names the old copy's folder.
- **A fleet finishing its start after an update no longer clears another operation's progress marker (#1735).** It clears only the update it started from; a `/restart full` or a new `/update` begun meanwhile keeps its own. The old install's folder is named in the cleanup note only when it contains no control or invisible characters.
- **Telegram: `setMyCommands` now honours `telegram_api_root` (#1736).** Registering the bot command menu always went to `api.telegram.org`, even when `telegram_api_root` was set to a custom Telegram Bot API server. The URL is now built from the same root the adapter itself uses.
- Dashboard shutdown now ends SSE and drains owned HTTP sockets for up to one second before forcing leftovers closed. Updated pages receiving the shutdown hint delay reconnecting; Windows/WSL troubleshooting explains safe alternate access and operator-selected mirrored networking. This mitigates connection churn without claiming to repair a stuck WSL relay.
- **Telegram `/web` explains a failed public link correctly (#1742 follow-up).** When the sign-in link fails before the bot has tried to message you, for example because the public link cannot start, the message now says that the link could not be started and asks you to run `/web` again. It no longer tells you to open a private chat, which wouldn't help. The private-chat steps, the "Start privately →" button and the 10-minute `/start` window now appear only after a private message was actually tried and could not be delivered.
- **A fleet installed from a custom `AGEND_HOME` keeps that home after a service restart or an update (#1743).** `agend install` (and the refresh an update does) now writes `AGEND_HOME` into the launchd job and the systemd user unit when it is not the default `~/.agend`. Before, the service manager started such a fleet on `~/.agend`. A default-home service definition is unchanged.
- **The usage panel's plan badge stays on one line (#1749).** In the usage rail and dialog, a long plan such as "TEAM PREMIUM (6.25X)" wrapped onto two lines beside the provider name. It now reads **TEAM ×6.25** (likewise TEAM ×1.25 and MAX ×20). The full plan name shows on hover and is read out by screen readers. When space is tight, the provider name shortens with an ellipsis first, and the ↑↓ buttons stay on the same line. `/usage` and `get_usage` still give the full plan name.
- Telegram’s Needs-you live message no longer re-posts an unchanged list every ten minutes. Identical text and buttons skip editing, and Telegram’s “message is not modified” reply counts as success for text and button edits. Only confirmed message/destination or permission loss permits a replacement, under the existing one-post-per-minute limit. If you turned `needs_you.live_message` off as a workaround, you can turn it back on after updating.
- **When several of the fleet's bots share a Discord server, an instance's notices come from its own bot, and the other bots' posts are never taken as input (#1752).** The usage warning (and the held-for-memory notice) used to go out from whichever bot happened to receive the user's message first, which could be a different bot. The instance's own bot then took that post as a user message. Now these notices always come from the instance's bot, in its topic. A message posted in a fleet topic by any bot this fleet runs is ignored, even with `/collab` or open access. `/collab` and open access still let other bots and webhooks in. In ClassicBot rooms, the fleet's bots can still talk to each other by @mention.
- **A Claude profile switch that coincides with another restart still keeps the conversation (#1753 follow-up).** If the switch's restart joined one that was already under way, such as an MCP revival, the conversation was not copied and the reply did not say so. Now the copy runs inside that restart, as long as it has not yet started the new CLI. If it has, the switch reply reports `carry_failed` with the reason, and the usual handover is sent.
- **A Claude profile switch never reports the conversation as carried when the CLI starts on another login (#1753 follow-up).** If a profile switch joined a restart that had read its configuration before the switch was saved, that restart launched the old login, yet the switch could still copy the conversation into the new profile and reply "carried". The copy now happens only when the login being started is the one the switch moves to. Otherwise the reply reports `carry_failed` with the login actually launched, and the handover goes out. When that login is the old one, the CLI simply resumes its own conversation. When it's a third one, it starts fresh.
- **Instances on a Claude credential profile keep the shared auto-memory (#1754).** A named profile has its own `projects/`, so Claude Code's memory for the repository started empty there, apart from every other instance's. Each profile launch now links the profile's memory folder for the instance's repository to the shared one under `~/.claude` (or your own `CLAUDE_CONFIG_DIR`). The key is the repository root, and a git worktree counts as its main checkout, as Claude itself keys memory. Conversations stay per profile. A profile memory folder that already holds notes is never replaced: it is left as it is and a warning is logged. Instances without a profile launch exactly as before.
- **A temporary public link that Cloudflare refuses now says so (#1767).** When trycloudflare is rate-limiting new quick tunnels from this machine (HTTP 429), the steps say "Cloudflare is limiting new temporary links from this machine — try again in a while; the LAN link still works", instead of a timeout after 0 seconds. Any other early stop of cloudflared is named as such, and daemon.log records the reason. The HTML-preview tunnel is now requested only after the link's own tunnel has its address, so it can never use up a request the link needed.
- **Web chat times say the day when it is not today (#1770).**
  - A message from today still shows only its time. One from yesterday shows "Yesterday 17:38", an older one "10/11 17:38", and one from another year "2025/10/11 17:38". Hover a time to see the full date and time zone.
  - Times and days are read in the fleet's time zone (the one chat logs and fleet.log use), not the browser's. The same labels appear on messages, status lines and the preview panel. At midnight the labels update without reloading any preview.
- **Files an agent attaches to a reply stay available in web chat after a fleet restart (#1770).**
  - Before, a reply's .html or .png usually showed as "unavailable" after an update or restart, because web chat only kept files that sit in the instance's inbox, and agents usually send files from /tmp or their working folder. A file also broke if the agent later rewrote or deleted it, or /tmp was cleaned.
  - Web chat now keeps its own copy of each reply file in `workspaces/<instance>/web-files/` and shows that copy. A symlink, a file over 50 MB, or a file inside the AgEnD state folder (other than inbox/) is not shown.
  - Copies are deleted when their message leaves the web chat history. Each instance keeps at most 1 GiB; above that, the oldest copies go first. When a copy is gone, its message shows the file as unavailable, as before. Telegram and Discord are unchanged.
- **A short message you send in web chat gets a bubble that fits its text (#1773).**
  - Before, the bubble stretched to the width of the line above it (your name, the time and the delivery ticks), so a short message such as 「目前進度」 sat in a bubble twice its width. The longer times from #1770 (「昨天 下午03:58」) made this worse.
  - The bubble now fits its text and stays on the right, under the name and time. A long message still wraps at the same width, files still sit inside the bubble, and agent replies look the same as before.
- **An agent resumed across an upgrade can pass `forwards` again (#1780).**
  - A Claude Code session resumed across the beta.7 upgrade still saw the old `send_to_instance`, without `forwards`. It put the verification ID in the message text instead, which grants nothing, so the receiver's `delivery_status` said "Delivery not found".
  - Claude Code keeps a tool's schema from when the session first loaded it, and reloading it does not refresh it. AgEnD's server still accepts the new parameter.
  - Running instances are now told once (the what's-new notice) that `send_to_instance` and `delegate_task` take `forwards`, and that an ID in the text grants nothing. The notice no longer suggests reloading the tool; it says to use the new parameters anyway.
  - The forwarding guidance (skills, tool description and docs) names this failure.
- **Web: Simplified Chinese glyphs now come from the same font family as Traditional Chinese (#1781).** The `--font-ui` stack listed only Traditional Chinese fonts (`PingFang TC`, `Noto Sans TC`, `Microsoft JhengHei`). Simplified-only characters — such as 订 实 结 论 讲 认 档 还 众 数 验 — fell back per glyph to whatever the OS provides (often SimSun or another design), making mixed-script sentences look uneven. Their SC counterparts (`PingFang SC`, `Noto Sans SC`, `Noto Sans CJK TC`, `Noto Sans CJK SC` for Linux, `Microsoft YaHei`) are now added immediately after each TC font in the stack. Traditional text renders as before; no webfont is downloaded.
- **kiro-cli 2.30.0: AgEnD answers its reworded Classic nudge again (#1784).**
  - 2.30.0 renamed "3.0" to "V3" in kiro's launch prompts. AgEnD no longer recognised the Classic deprecation nudge that a legacy (Classic) instance meets at launch: it neither answered nor held it, and the instance took no messages until someone answered it by hand.
  - AgEnD now answers it as before: one step off "Switch to V3", then "Remind me later", with the cursor checked before each key. Nothing changes your engine.
  - The reworded V3 prompt ("You're using Kiro CLI V2. Switch to V3 today.") and agent-config prompt ("still in the V2 format") are answered "Remind me later" and "Not now" the same way. "Don't ask again", or a cursor AgEnD can't read, is still left for you.
- **kiro: launch no longer warns on 2.28.0–2.30.0; warning text no longer repeats "kiro-cli"; Log tab shows plain text instead of JSON (#1785).** Three independent causes: `KIRO_TESTED_MAX` was stuck at 2.27.0 even though 2.28.0 and 2.29.0 (#1576) and 2.30.0 (#1785) were audited live; the version-gate warning passed the raw `--version` line ("kiro-cli 2.30.0") to templates that already say "kiro-cli {0}", producing "kiro-cli kiro-cli 2.30.0"; and the Log tab's event rows stringified the whole payload as JSON when only a `message` field was present, so the "啟動警告" row showed `{"message":"…"}` instead of the message. All three are fixed: max bumped to 2.30.0, warning templates receive the bare semver, and `detail` is the `message` text when that field exists.
- **A grok instance quits cleanly on stop, pause and restart (#1792).**
  - Grok quits only on a second Ctrl+Q within one second. AgEnD sent one, so grok only showed "press again to quit". Every stop then waited three seconds and force-stopped it.
  - AgEnD now sends Ctrl+Q twice, 250 ms apart. The grok 1.0.52 audit found this; 1.0.52 itself is otherwise unchanged for AgEnD.
- **muse /model lists new models from the on-disk provider catalog (#1796).** The list was four hard-coded ids, so new models (muse-wonder-1.0) never appeared even after restart + refresh. `listModels()` now reads the same `model-catalog/*.json` cache the live picker reads — listed (`visible`) rows only, which is what the 1.4.7 picker shows (no `-contributor` ids), file order kept — and falls back to that visible set when the cache is missing or unreadable.
- **muse 1.4.7's approval prompt and "Local work is still active" quit menu are recognised again (#1798).**
  - muse 1.4.7 draws the selection cursor of both as `⟩`. AgEnD accepted only `›` and `❯`, so with `skip_permissions: false` an approval prompt read as ordinary work instead of a prompt waiting for a human. The quit menu was not held against a delivery either, whose Enter picks "Exit anyway" and ends the background work.
  - AgEnD now accepts `⟩` too. The muse 1.4.7 audit found this; 1.4.7 is otherwise unchanged for AgEnD.
- **kiro: a resumed conversation is no longer switched to the instance's own agent, because one lost AgEnD's tools (#1800).**
  - Since #906, AgEnD typed `/agent swap` into a resumed kiro conversation to move it onto the instance's own agent. A user's instance then lost its AgEnD tools: it could not `reply`, and its workaround through a subagent delivered nothing.
  - The switch is suspended. A resumed conversation keeps the agent it was saved under and gets AgEnD's server and instructions from the shared `.kiro` files again, as before #906.
  - Instances whose switch was already recorded get those shared configuration entries back on their next launch. After a restart, check that the instance calls `reply`. That is expected to bring its tools back, but kiro's own tool loading was not verified live.
  - New conversations still start as the instance's own agent.
- **`agend update` no longer rolls back on a Linux host without a D-Bus user bus (#1804).**
  - On a host without `dbus-user-session`, `systemctl --user` works but `busctl --user` cannot connect. Every update there rolled back with "systemd does not know com.agend.fleet.service", even though the service was loaded and running.
  - When the bus cannot be reached, the update now asks systemd over its private socket instead: the same connection `systemctl --user` uses on such a host. It reads exactly the same definition it reads over the bus, so it checks exactly the same things before it restarts through systemd. `agend restart` does the same.
  - Anything that still cannot be proven rolls back. The message now gives the real reason: systemd cannot be reached at all, systemd does not know the unit, systemd refused the request, or the unit does not start the new install. The rollback line no longer claims the restored unit is not loaded when it simply could not be read.
  - Hosts with a working user bus behave as before.
  - **One manual step on such a host.** The update to this version is still checked by the version that is running, so from 2.2.0-beta.9 or earlier it rolls back once more. Install this version yourself with `npm i -g @songsid/agend@beta`, then run `agend restart`; the restart uses the new check. Updates after that run normally.
- **An agent that switches an instance's backend no longer leaves it on the old backend's model (#1808).**
  - `update_instance_config` with a new `backend` and no `model` used to keep the instance's model. An agent moving an instance from claude-code to codex relaunched codex with `--model opus`, and every turn failed.
  - Now a backend switch drops the instance's own model and effort unless they are given, so the new backend runs on its default (or the fleet default it inherits).
  - A model the new backend does not take is refused before anything is written, and the refusal lists the backend's choices. The same goes for an effort level it does not have.
  - "Takes" is the rule `/backend` applies: the backend's offered list (and claude-code's known names); with no list known yet, its usual model-name pattern.
- **`agend attach` now accepts the display names shown by `agend ls` (#1809).** `agend ls` shows human-readable labels — a `display_name` such as `稜鏡 Prism` or `Fable 焚穹`, or a shortened real name such as `agend-reviewer-t996543` — but `agend attach <name>` only matched real instance names. Pasting a label from the table into attach failed. `agend attach` now resolves any such label to its real name before fuzzy matching runs. Real names always keep priority; a partial match such as `稜鏡` (a substring of `稜鏡 Prism`) still requires the complete label.
- **A configured `effort` now reaches codex, claude-code, grok and antigravity at launch (#1811).**
  - Before, only kiro-cli and muse launched with it. The others saved it and launched without: `/effort` on codex restarted the instance and changed nothing, and on claude-code, grok and antigravity it lasted until the next restart.
  - Now every launch, a resumed one included, passes it: `-c model_reasoning_effort` (codex), `--effort` (claude-code, antigravity), `--reasoning-effort` (grok).
  - A stored effort never breaks a launch. It is passed only when the installed version's `--help` lists the flag (antigravity 1.0.x has none) and the level is one that CLI takes. For codex, that is a level the model's catalog lists, because codex does not check it itself. Otherwise the instance launches on the CLI's own setting, and daemon.log and the Log tab say why (no chat notice).
  - Instances that already have `effort` set run at that level from their next restart. The runtime `/effort` is unchanged.
- **Web chat: Markdown tables no longer sit against the scrollbar or break words in the middle (#1812).**
  - In a `.md` attachment's preview, the table now has the same space on both sides, and the scrollbar no longer touches it.
  - Table cells keep words whole: "director" is no longer split into "directo" / "r". A table too wide for the message scrolls sideways in its own frame, instead of squeezing its columns.
  - A long file path in a table cell wraps after its `/`, not in the middle of a name.
  - This applies to tables in chat messages, `.md` previews and CSV previews alike.
- **A failed chat `/update` now shows a short cause and logs the full output (#1818).** Before, a failing updater only reported `updater exited 1` with no information. Now: (1) the updater's stdout and stderr are written directly to `$AGEND_HOME/update.log` via a file descriptor (not a pipe), so the updater can keep writing even after the fleet process that spawned it has stopped, avoiding SIGPIPE killing grandchild processes such as `agend restart` or service installation commands; if the log file cannot be opened the run proceeds silently as before; (2) `update.log` is rotated to ~200 KB when it would exceed that size, and its mode is enforced to 0600 (owner-readable only; raw updater output is written directly, secrets are not masked in the file); (3) the failure message includes a short cause extracted from this run's output only — if there is an `npm error code` line, it is shown together with the following line; otherwise the last meaningful `npm ERR!`/`npm error` line (skipping the generic "A complete log of this run can be found in" footer), the last `✗` line, or the last non-blank line — truncated to ~300 characters and masked before being shown in chat; (4) the message ends with "Full log: `<path>`". The success, pending (exit 75) and interrupted paths are unchanged.
- **After updating to beta.11 or later, agents are told about polls and web identity (#1823, #1827).**
  - The what's-new notice is sent only when there is a new entry for agents, and none had been added since beta.7. So after `/update` to beta.10 or beta.11 a running agent heard nothing. It could keep naming an older AgEnD version, and a resumed session did not know about `reply`'s `poll` or `close_poll`.
  - Running instances are now told once: `reply` takes `poll` (its exact parameters), the results come as one `[poll results]` message, and `close_poll` ends a poll early. They are also told that a web-chat person now carries their Discord or Telegram user id, for recognition only.
- **antigravity: a configured effort reaches agy, as the right model; agy's trust prompt is answered under AgEnD's status line (#1825).**
  - agy prints `--help` on stderr, and AgEnD read only stdout. So #1811's launch gate never found `--effort`: a configured effort was always left out, and the probe cached no levels. Both now read stderr when stdout is empty.
  - agy's model list has one model per level (`gemini-3.8-flash-medium`, `…-high`). agy runs a different model, with only a warning in its pane, when `--model` and `--effort` disagree, when a label like "Gemini 3.8 Flash (High)" comes with any `--effort`, or when the level isn't offered. So the effort now picks that level's model (`gemini-3.8-flash-medium` + `high` launches `gemini-3.8-flash-high`), and `--effort` never goes out with `--model`. A level the model lacks, or a model AgEnD can't find in agy's list, launches the configured model without it. daemon.log and the Log tab say which model ran. fleet.yaml is not changed. agy's model list counts past the probe cache's one day for as long as the agy binary the probe ran is still installed, so a fleet that has run for days keeps choosing the right model.
  - `/effort` and `/backend` offer the levels of the agy model the instance runs (`gpt-oss-120b-medium`: only `medium`).
  - agy's trust prompt is answered again under AgEnD's status line, whose `Context 0% used` row replaces agy's model row there. It is also answered for a model without levels (a right-aligned `GPT-OSS 120B (Medium)`). Before, a new workspace waited at the prompt.
  - agy 1.3.5 itself needs no change: it behaves the same as 1.3.4. Model names in existing configs, slugs and "(High)"-style labels alike, keep launching that exact model.
- **`agend update` no longer says "Already up to date" when the fleet is not running, and a failed chat `/update` names the fix for the cases AgEnD knows (#1829).**
  - When the target version is already installed but no fleet runs, the update now checks the installed package and then says so: `AgEnD vX is installed but the fleet is not running — run: agend start`, with exit code 1. Examples: a restart that never finished, or a stopped service. Before, it reported success. If the installed package does not pass the check, it says to reinstall instead. The update never starts the fleet itself.
  - A failed chat `/update` now ends with a one-line `Fix:` for three known causes:
    - The directory npm cannot rename (`ENOTEMPTY`) after an interrupted install: the exact directory npm names, and only AgEnD's own.
    - The activation check that cannot read systemd on a host without a user bus: `npm i -g @songsid/agend@<target> && agend restart`.
    - An `agend` that the failed install removed: `npm install -g @songsid/agend@<target>`.
- **install.sh no longer installs the obsolete `@songsid/agend-plugin-discord` (#1831).** Discord has been built into the core package since PR #134. A regression introduced in commit 81ce9fcb accidentally re-added `@songsid/agend-plugin-discord` to the install command. The script now installs only `@songsid/agend`, and warns then removes the plugin if a previous install left it behind.
- Silent schedule writes now close the preceding channel reply guard before submission proof, preventing heartbeat-triggered reply notices and reply-required prompts; uncertain deliveries are still not resent. Even the guard for a genuinely missed human reply is closed if it is still in its confirmation window or recovery when a silent schedule lands, with an info log for tracing and no new chat notice.
- **A codex instance whose agent spawned a subagent no longer stays `working` after its reply (#1849).**
  - AgEnD followed the subagent's transcript, which shares the instance's working directory.
  - It read the subagent's work as the instance's own unfinished turn: the working emoji stayed, and the hang warning came after 10 minutes.
  - It now follows only the instance's own transcript. The `Main [default]` footer that codex shows after a spawn already read as idle.
- **Web: Settings and Needs you say what is true (#1854).**
  - When no stuck timeout is set, Settings and the hang notice now show 10 minutes, the detector's real default, instead of 15.
  - Settings help puts the dashboard's own settings under **Web**, not General.
  - The access hint points to **Connections**.
  - A change that waits for a fleet admin says it is confirmed in chat (the General topic) or on the host.
  - The public-link hint no longer claims "No preview exposure": previews get their own temporary tunnel unless `web.preview_on_public_link` is false.
  - An empty Needs you no longer promises Discord. A fleet with no chat app is told only that items show there.
- `/web` local sign-in messages no longer show “Link expires: Local network.” Local packets use three lines; public packets add the real link expiry in the fleet time zone. Both retain the five-minute single-use code, the separate code-only message and the revoke reminder.
- **`agend web` and `agend view` no longer crash on a machine without a browser opener (#1854).**
  - On a server or WSL without `xdg-open`, the command used to crash right after printing the link.
  - It now prints one line saying no browser could be opened; the printed sign-in page and code still work.
- **codex: a resumed idle session no longer reads "working" for the whole hang window.** Sometimes a resumed codex draws its footer without the Context item. If its own rollout shows no open turn and its empty composer stays unchanged, the next safety sweep now marks it idle within about a minute; before, it waited for the 15-minute stuck deadline, and deliveries queued meanwhile. (#1865)
- **Web: View's terminal fits the window again (#1869).**
  - With Fit (the default), a wide pane is no longer held at a 12 px minimum that pushed it past the window. It is never sized larger than what fits, down to a 6 px floor.
  - A slightly smaller window now always shrinks the text.
  - Choosing S / M / L on Chat or any other page no longer turns View's Fit off. Only View's own **Text size** button does.
  - Devices whose Fit was turned off that way get it back once.
- **macOS: an update run from an agent's session no longer leaves the fleet stopped.** On launchd, `agend restart` and `agend update` stop the fleet and then start it again. Run from an agent's session, the command was killed together with that agent when the fleet stopped, so the second step never ran: the fleet stayed down and no message was shown. Such a command now continues in the background and writes its output to `~/.agend/service-activation.log`. After such an interrupted update was recovered with `agend start`, `agend restart` refused every time; it now restarts the job launchd runs. (#1871)
- **Config: `web.access` gets a warning, and "/web disabled" says where fleet admins go (#1874).**
  - Who may run `/web`, `/update` and `/doctor` is the fleet admin list: `access.allowed_users` under the bot's channel. There is no `web.access` setting.
  - `agend validate` now warns about `web.access`, saying where the list really goes, and about any other unknown key under `web`. These keys were ignored silently before.
  - When the list is empty, the `/web` and `/update` replies name the exact key, such as `channel.access.allowed_users` or `channels[id: main].access.allowed_users`.
- **The check after a `/login` install no longer stalls the fleet (#1877).** After an install, AgEnD asks a login shell where the new CLI is. A login profile that starts something in the background could hold that check, and with it the whole fleet, for 10 seconds: no messages, no deliveries, no systemd watchdog ping. The check now runs in the background and ends when the shell does. If the shell outlives its time limit, prints too much, or leaves something holding its output, that lookup's processes are stopped.
- **A missed systemd watchdog ping is now logged.** If AgEnD skips a ping because `fleet.pid` names another process, or `systemd-notify` fails, the fleet log says so (at most once every 10 minutes). Before, the ping just stopped and systemd's restart had no visible cause.
- Discord quickstart now detects your account from a new server message or bot DM and asks you to confirm its username and ID. Its 30-second detection has a required, validated manual fallback. Web setup and New connection also require a valid admin ID, so setup can no longer succeed with an empty or malformed first allow-list entry. Existing access lists are unchanged; web Discord detection remains a follow-up.
- **Linux: a root fleet under a system unit now moves to 2.2 when it is updated from 2.1.** Hosts with `/etc/systemd/system/agend.service` installed 2.2 but kept running 2.1, because `agend restart` refused the unit's old start command. The update now points that unit's `ExecStart` at the new install, as it does for the user unit, and leaves every other line alone. (#1884)
- **Usage panel: the Antigravity (agy) row shows the Gemini quota again.** agy now reports its quota in named groups ("Gemini models", "Claude and GPT models"), each with a five-hour and a weekly limit, and the panel showed only the Claude & others pair. It now pools by group and shows Gemini and Claude & others, session and weekly; the older response shapes look as before. (#1898)
- **An agy instance on Linux gets its fleet instructions again (#1914).** AgEnD wrote them to `.agents/agents.md`, but agy reads `.agents/AGENTS.md`; on a case-sensitive filesystem it never saw them (on macOS's default case-insensitive disk both names are one file, so it worked there).
  - They are now written to `.agents/AGENTS.md`. An old `.agents/agents.md` on its own is renamed to the new name, keeping any lines you added to it.
  - If you already keep your own `.agents/AGENTS.md`, it is left as it is; only AgEnD's own blocks move out of the old file. The rename never replaces anything already at the new name, including a file created at the same moment.
  - If `.agents/AGENTS.md` is a symlink to a file that does not exist, AgEnD leaves it alone, does not write the instructions, and the launch tells you so.
- **Compact no longer wipes an agy conversation (#1915).** On agy, AgEnD's compact (the web chat's **Compact** button and `/compact`) sent `/clear`, which erased the whole conversation instead of compacting it.
  - It now sends agy's own `/compact`, which summarizes the conversation in place (verified on agy 1.3.6).
  - On an agy known to be older than 1.3.6 it is refused, nothing is sent, and the reply says to update agy.
- **A kiro `/compact` from the web chat now says when it ends (#1925).** On kiro's classic UI and the TUI's V2 engine, the card follows the instance's own pane: **Conversation compacted**, or that kiro did not compact the conversation because it was too short or the compaction was stopped. On the TUI, "compacted" means kiro's "Compacting conversation..." line came and went; a failure other than "too short" can't be told apart. kiro's V3 engine still says its compaction end can't be detected.
- **The kiro docs no longer say an instance's agent loads no steering (#1925).** kiro loads `.kiro/steering` for every agent, even one with `resources: []`, so a new conversation also reads the steering files in its directory.
- **Beta users are told about a newer beta again after a stable release ships.** With 2.2.0 out and beta.17 on the beta channel, a beta.16 install got no update notice at all. The newer stable became the notice's target and was then dropped as "same version line", taking beta.17 with it. A beta install's notice now follows the beta channel only, so beta users stay on the beta line. An alpha install with a same-line stable out still hears about its newer alpha. (#1926)
- Refresh the English and Traditional Chinese 2.2 upgrade and feature guides, READMEs, command/configuration references and current release summary against the implemented behavior. Clarify private web sign-in, ClassicBot admission, bundled Node, delivery evidence, memory protection, credential profiles and Kiro recovery. Earlier 2.2 fragments now describe the final behavior; release changelog assembly remains separate.
- The npm package description and search keywords now advertise Muse instead of the removed Gemini backend.
- Correct the English/Traditional Chinese website setup, configuration and feature pages for current 2.2 behavior, including Discord admin detection, supported hosts and private web sign-in. Update repository security and plugin/developer references to match the current APIs and authorization checks.
- Keep the Traditional Chinese CLI reference’s `/web` alias row in the canonical table format required by the documentation copy check. The command name, alias and behavior are unchanged.
- **CI: a PR that changes docs now runs the tests.** Tests read `docs/` files and the root READMEs, so a docs-only PR that changed a row a test pins could merge with the test shards skipped (#1929 turned main red this way). Only a PR that changes nothing but `changes/` fragments skips the tests now. (#1932)

### Security
- **Closed several ways to act on an instance without the right permission (#754, #1148).** An audit of who may run
  what on every channel found these, now fixed:
  - **The ⏹ cancel button** interrupted an instance for anyone who clicked it. It now works only for someone that
    instance's bot lets speak in the topic, and only on that instance's own button.
  - **Telegram `/raw <text>`**, which types straight into the CLI, worked for anyone allowed to talk in the topic. It
    now needs a fleet admin of that topic's bot.
  - **Telegram `/collab`, `/compact` and `/save`** in fleet topics had no admin check. They now need a fleet admin, as
    on Discord.
  - **The advanced-tips unlock button** changed a fleet-wide setting for any clicker. It now needs a fleet admin, like
    `/tips advanced on`.
  - **The `/model` and `/effort` menus** now check, when you click, that you are still an admin and that the click came
    through the same bot.
  - **`/pause` and `/wake` from a General** could reach another bot's instances. They now reach only that bot's own.
  - **Fleet-admin slash commands** (such as `/update` or `/restart`) could run from a ClassicBot channel in another
    Discord server. They now run only in the fleet's own server.
- `docs/commands.md` now says that ClassicBot `admin_users` is one list shared by every bot.
- **One rule decides who is a fleet admin, on every platform (#754, #1148).**
  - Admin is judged by the bot that owns what a command acts on: the instance's bot, or the General's. It is not the
    bot the command arrived on. A Discord slash command in a channel that belongs to another bot of the same fleet is
    now refused there: use that bot's commands.
  - An empty `allowed_users` list means nobody, and so does a bot id that matches no configured channel. That case
    used to fall back to the first channel's list.
  - Telegram typed commands now follow the same command table as Discord slash commands, so a command needs the same
    permission on both.
  - In a Telegram ClassicBot chat, a fleet admin of that bot can now use `/pause`, `/wake`, `/compact` and `/save`, as
    on Discord. `/stop`, `/raw` and group `/start` stay ClassicBot-admin only.
- **The dashboard no longer depends on Server-Sent Events.** If the live stream says nothing for 15 seconds, or
  keeps failing, the page fetches the same status and chat messages every 5 seconds (`GET /ui/poll`) and goes back
  to the stream when it speaks again. Polling uses the very same `<boot>-<id>` cursor as the stream, so the two can
  take turns without a message twice or a gap, also across a fleet restart. (Cloudflare Quick Tunnels do not carry
  SSE, and a buffering proxy looks exactly like a server that never sends.)
- **The dashboard no longer loads its fonts from Google, and every panel carries a Content-Security-Policy**
  keeping scripts, styles, images, fonts and connections to this origin (`connect-src 'self'`), so script that
  somehow ran on a page could not send what it read to another server.
- **The three web panels share one navigation and one session menu, and `/` opens the dashboard.** `/ui`, `/view`
  and `/settings` carry the same *Dashboard · View · Settings* links and a Session button: which browser you are
  signed in as, when the session ends, every other signed-in device (with a Sign-out for each) and Sign out
  everywhere. It is one small script and stylesheet (`/assets/shell.js`, `/assets/shell.css`), not a rewrite of
  the panels.
- **No inline script runs on the web panels unless it is the page's own (#1268).** `script-src` no longer allows
  `'unsafe-inline'`: each panel's own script is served with a fresh per-response nonce, and the dashboard's buttons
  no longer carry `onclick=` attributes (one listener runs a fixed list of actions named in `data-act`). Markup
  injected into a page — an `onerror=` handler, a `<script>` — no longer runs.
- **…and no inline style applies unless it is the page's own (#1300).** `style-src` no longer allows
  `'unsafe-inline'` either: each panel's `<style>` block carries the same per-response nonce, and no panel has a
  `style="…"` attribute any more (the dashboard's went in #1307; /view's and /settings' now — the live terminal's
  colours and the usage meters are set through the style object). Injected markup cannot add inline styles of its own
  (it can still use the page's existing class names). The web terminal keeps its own policy.
- **An unattended page no longer keeps a web session alive (#1373).** A session ends after its idle time without use (#1670 sets the defaults); the
  reads a page makes on its own timer no longer count as use. With `web.view_access: session`, an open `/view` (its
  terminal every 0.8 s, its roster every 5 s, the usage panel every minute) used to keep its session until the
  session's absolute limit, and the dashboard's live stream counted each time the browser reconnected it. Those reads are still
  fully authorized; only opening a page, reading a chat's history and anything you change count. The list is fixed
  on the server, never something a page can claim.
- Sensitive web Settings changes now require an owning General fleet admin's nonce-bound confirmation, or an explicit same-user host confirmation when chat is unavailable (#1423). Access lists, credentials, channel destinations/order and control-bearing settings stay pending for at most five minutes; redacted diffs identify the actual IDs and roles. Ordinary settings remain immediate. Actual jobs and startup continuations carry authorization and configuration fences, shared resource leases and conditional rollback. SetupHost also requires host consent before writing and a separate confirmed finish before handover.
- **POST /agent: instance token is now validated before the request body is read.** Previously the endpoint consumed the entire body before checking authentication, allowing any local process to exhaust daemon memory with a large unauthenticated request. The token header (`X-Agend-Instance-Token`) now carries `<instance>:<token>` and is verified before `readBoundedWebBody` is called; missing or invalid tokens return 401 without touching the body. Bodies exceeding 512 KiB return 413 (same limit as the web API). `agend-agent` updated to send the new header format. (#1489)
- Settings no longer reads a credential written inline in fleet.yaml back out (#1490): `GET /api/settings/fleet` and `/api/settings/fleet/raw` show a hand-written `bot_token` (or any `token`, `secret`, `password`, `api_key`, `web_token` key) as `[configured - redacted]`. A save built from that read carries the placeholder back, and the stored value is kept: connections are matched by id, instances and defaults by path. The placeholder means this only under a credential-named key; elsewhere it is ordinary text. A placeholder with no stored credential behind it, or one whose connection id has two owners, is refused with 400, and fleet.yaml is left untouched.
- **Settings confirmation follows the affected bot's permissions:** a chat
  confirmation requires admin membership on every existing target connection;
  another General's admins cannot approve it just because the buttons appear
  there. Fleet-wide changes and new connections retain the configured primary
  General's admin authority; mixed changes require both. Shared token aliases
  include every affected connection. Cross-platform or unknown targets require
  `agend settings confirm <id>` on the host. Browser pending/retry behavior and
  first-time Setup host confirmation remain available. (#1490)
- **Settings confirmations can no longer be bypassed under an "applies now" setting (#1490).**
  - A sensitive field placed inside an immediate setting's object (for example `persona: { bot_token: … }` or `persona: { allowed_users: … }`) skipped the admin confirmation.
  - Such a field is now confirmed like any other secret or access change. An unknown field there is refused.
  - Only the known parts of `status_emojis` and `hang_detector` still apply without confirmation.
- **Saving connections in Settings writes only connection fields (#1490).**
  - `PUT /api/settings/fleet/channels` refuses any field Settings does not own, such as an inline `bot_token`, an unknown option or an unknown access field.
  - A field added by hand to fleet.yaml still passes through unchanged.
- **Web sign-in and setup page hardening (#1490):**
  - On this computer's own dashboard, a stale `__Host-agend_session` cookie no longer hides a valid `agend_session` one: an ended secure session made a signed-in browser look signed out. Writes are checked against the session that actually signed in. The public link still accepts only its `__Host-` cookie.
  - Polling an Apply (and a token or binding apply), which a page does for up to ten minutes while you wait, no longer counts as activity, so it does not keep an idle session alive (#1373).
  - The `agend setup` page now sends a Content-Security-Policy that runs only its own inline script and style (a fresh nonce per page), plus `X-Frame-Options: DENY`, so it cannot be framed by another site.
- **Settings secret endpoints: 403 for public-link (gateway) sessions.** Six endpoints that write or verify connection tokens/secrets (`/secrets/:id/verify`, `/secrets/:id/apply`, `/connections/:id/secret/verify`, `/connections/:id/secret/apply`, `/connections/:id/binding/verify`, `/connections/:id/binding/apply`), plus the quickstart probe endpoint that receives raw bot tokens for verification, now return 403 for gateway (`surface: "gateway"`) sessions. Local dashboard sessions are unaffected. (#1519)
- **Docs: `create_instance` and `update_instance_config` privilege boundaries described separately.** `tool_set` and `skipPermissions` can only be set through Settings or `fleet.yaml`. `update_instance_config` explicitly refuses `tool_set`; `skipPermissions` is not an accepted field (Zod strips it). `create_instance` refuses both fields explicitly. (#1519)
- **Web app: the panels' security policy can no longer lose its script nonce or image source silently (#1527).** The policy each panel is served with now extends whole directives of the base policy, and AgEnD refuses to start if one is missing, instead of serving pages whose scripts or Discord emoji images would be blocked.
- **Web: the public link can no longer change the fleet-wide sidebar order (#1665).** `POST /api/sort-order` was still allowed over a temporary public link, although the page no longer used it. It is now off the public link's route list, and the handler refuses it there as well (403). Reading the order is unchanged.
- **Web: teams can no longer be created or deleted over a temporary public link (#1689).** `POST /ui/teams` and `DELETE /ui/teams/<name>` were open to public-link sessions, unlike settings. Both are now off the public link's route list, and the handlers refuse them there as well (403). The new team edit is refused in the same way. Teams can still be viewed over the public link.
- **Web: a public link can no longer create, edit or delete schedules (#1724).** Schedules run as messages to agents, so they are refused over a public link in the same way as teams (#1689): the routes are not offered there, and the server refuses them. A public link still lists schedules.

## [2.1.12] - 2026-10-08

### Fixed
- **Fleet stall warnings now show slow synchronous callers and GC pauses (#1235, PR-A).** Bounded,
  monotonic records name instrumented calls taking at least 50ms and GC pauses of at least 200ms in the
  same observation window. Scheduling and delivery behavior are unchanged; unobserved causes remain unknown.

### Upgrade Notes
- **[Removed] The `gemini-cli` backend (#1280).** It had been deprecated, and the date its warning named has passed.
  `backend: antigravity` replaces it: the same Google sign-in, through agy. A config that still names `gemini-cli` is
  now refused rather than run, at the instance level, the fleet default, or a ClassicBot channel or default:
  - **`agend validate`** and Settings report it as an error that names the instance and says to set
    `backend: antigravity`. A fleet.yaml reload that still contains it is refused as a whole, with that message.
  - **After `agend update`** the fleet starts as usual. That one instance does not start: its topic gets a notice
    saying why and what to set, and it is not retried. Every other instance comes up normally. AgEnD never swaps in
    another backend by itself: changing which CLI and which account an instance runs on is your call.
  - `/login gemini-cli` and `agend backend doctor gemini-cli` say the same instead of installing or checking it.
    `agend backend trust`, which only pre-trusted Gemini CLI folders, is removed.

### Added
- **How much of a bot-to-bot message is posted in the topics: full, summary or hidden (#1302).** Cross-instance
  messages are posted in the instance topics so people can follow along, and in a busy fleet they bury the
  conversation. `cross_instance_visibility` now sets it: `full` (the default, exactly as before), `summary` (the same
  posts, one line each: who sent it to whom and the task summary or the opening words) or `hidden` (none). Set it for
  the fleet under `defaults`, with the new fleet-admin `/visibility full|summary|hidden` (Telegram General topic and
  Discord, saved to `fleet.yaml`), or in Settings, which also has a per-agent override. Each topic follows its own
  instance; a change applies at once. Delivery, the Mirror Topic and General are not affected in any mode.
- **An alpha channel, separate from beta and stable (#1259).** A `vX.Y.Z-alpha.N` tag now publishes to npm `@alpha`.
  Before, every tag without `-beta` went to `@latest`, so the first 2.2 alpha would have reached every stable user.
  The publish workflow now maps tags strictly: `vX.Y.Z` → `@latest`, `-beta.N` → `@beta`, `-alpha.N` → `@alpha`.
  Any other tag fails before anything is built, and `@latest` never moves backwards. On the client, `agend update`
  (and chat `/update`) keeps an alpha install on `@alpha`. There is a new `agend update --alpha`, and the "update
  available" notice tells an alpha about newer alphas and stables, never about a beta. Beta and stable installs
  behave as before. The old manual `scripts/publish.sh` is removed: a release is a pushed tag.
- **When the soonest rate-limit reset ticket expires, on the ticket line (#1232, #1244).** Codex's "Rate limit resets:
  2 available" now says when the first of those tickets expires — "Rate limit resets: 2 available · 🎫 Nearest expiry:
  10/22 (in 16d 6h)" — in `/usage`, the View usage panel and `get_usage`'s text, read from Codex's own ticket list
  (`expiresAt` on that metric). A ticket without an expiry is skipped, and with none the line shows the count as
  before. It is an expiry, not a reset: an unused ticket is lost. (The per-backend "⏳ Next reset" line that
  2.1.12-beta.2 added under #1232 was a misreading of the request and is gone, `nextResetAt` with it; each window
  still shows its own "resets in".)
- **Agents can send stickers on Discord and Telegram (#1226).** Three tools, the same on both platforms:
  `list_stickers` (`{ id, name, emoji_or_tags, format }` each, no image URLs), `preview_stickers` (up to 8, downloaded
  for the agent to Read; an animated sticker with no still picture is marked `preview_unavailable`), and a new
  `stickers` field on `reply` (up to 3; `text` may then be omitted). Underneath, each platform works its own way:
  Discord lists the stickers of the server the instance's channel is in (a bot cannot send another server's) and sends
  them on the same message as the text; Telegram lists a sticker set — named in the call or set as the connection's
  `options.sticker_sets` — and sends the text first, then each sticker in order. Every sticker is checked before
  anything is sent, so one that cannot be sent is an error, not a reply that silently arrives without it. Also on the
  agent CLI: `agend-agent stickers`, `sticker-preview`, and `reply … --sticker <id>`.
- **Codex capacity detection hardened against glyph changes and scrollback (#1215).** The capacity row must be the
  live transcript item (last item above the composer, nothing newer) both when the "keep going" nudge is armed and
  when it is accepted — a quotation or scrollback line still notifies the user but never injects. The capacity
  pattern no longer accepts box-drawing chrome (`│ …` popup/table rows are `So` too); quota, rate-limit and auth
  patterns share one `CODEX_STATUS_GLYPH` constant so the next glyph change cannot break them the way #1208 broke
  capacity, and occurrence counting is unified into one counter. The nudge now says to continue only if the last
  request is unfinished. Pane stays the capacity authority; the session-store seam stays observation-only.
- **Interrupted turns resume across restarts when the CLI itself stayed idle (#1209).** When a channel turn is
  armed, the daemon writes a one-shot `in-flight-turn.json` marker (with a TurnFingerprint checkpoint); whatever
  survives a restart is, by construction, an interrupted turn. After boot and CLI spawn, a pure gate decides once:
  crash-loop boots stay clean (#835), cancelled turns never resume (cancel deletes the marker, #1199), a delivery
  still owned by the durable outbox is left to that path, and the seam verdict rules out double-driving — CLI
  re-engaged or conversation switched means skip, unknown holds through the flush grace (one bounded wait, then
  deny), and only a quiet seam outside the grace injects one bounded continuation tied to the original correlation
  (never a re-paste). The marker is consumed before gating, so a second boot never repeats; completion paths clear
  it through the reply guard, a delivered reply clears it even before the idle edge, and a resumed continuation
  never re-arms (truly episode-once). A cancel, stop, pause or respawn during the grace hold stales the gate, so
  nothing is injected after the user already stopped it. Backends without a seam reader resolve to unknown and
  never continue.
- **Unified detection-signal seam for cross-restart turn questions (#1209, #1217a, #1210, #1215).** A new read-only
  observation layer (`src/backend/session-signals.ts`): per-backend `TurnFingerprint` readers that discover the
  workspace's session in the CLI's own store — claude-code (newest project transcript plus its newest timestamped
  tail entry; the tail itself is usually timestamp-less bookkeeping), codex (exact-cwd thread from `state_5.sqlite`
  opened read-only plus the rollout tail) and muse (cwd-matched session plus `recorded_at`) — with a
  backend-agnostic `compareFingerprints` checkpoint diff answering `reengaged` / `quiet` / `unknown`. Only a TURN
  counts: turn-kind filtering keeps bookkeeping writes (cost-state tails, token-count frames,
  workspace-branch observations, bare mtime touches) from reading as re-engagement. Daemon-caused writes are
  excluded on both the mtime and the tail path (plus a 2 s tail skew for entry-ts vs flush-mtime reorder), a
  changed session id counts as reengaged, and a 10 s flush grace withholds `quiet` as `unknown` right after the
  daemon's own write (a CLI that re-engaged but has not flushed yet briefly looks quiet). `readinessFromStore`
  always returns `unknown`: the pane stays the idle/busy authority and existing detection is untouched.
  kiro-classic schema coverage is deferred. Reads are synchronous — resolve fingerprints off the fleet event loop,
  never inside a tool handler. Residual, by design and bounded: an engagement that flushes after a compare is
  caught by the next checkpoint compare, never fabricated by this one.
- **A ClassicBot channel can run on a second subscription (#1220).** A channel in `classicBot.yaml` now takes
  `backend_options.<backend>.credential_profile`, as a `fleet.yaml` instance does — e.g. a classic codex bot on
  `credential_profile: personal`. Its agent is launched on that profile, `get_usage` / `/usage` count it under that
  subscription's row (`Codex (personal)`), and `kiro_engine_status` reports it. Before, the key was silently dropped
  and every classic channel was counted on the shared login. An empty or `null` value is the shared login, also over a
  profile inherited from the fleet defaults. A profile name AgEnD cannot use stops that channel's agent from starting
  rather than running it on another login. Only `codex` and `kiro-cli` have profiles; on another backend the profile
  is reported and ignored. Changing it — in `classicBot.yaml` or in the fleet defaults it inherits, on the next poll or
  a reload — restarts that channel's agent: fresh for kiro, whose other subscription holds other conversations, as for
  a fleet instance.

### Changed
- **Docs: the shipped 2.1.10 and 2.1.11 entries have their own CHANGELOG sections (#1295).** They had stayed under
  `[Unreleased]`; each entry now sits under the first release whose tag contains the commit that added it, Upgrade Notes
  included, and `docs/development.md` lists cutting the section as a release step.
- **Docs: the `wiki/` directory is retired; `docs/` is the single source (#1279).** Its still-useful pages were rewritten
  against the current code and moved into `docs/development.md` (Releases and CI, Release notes style) and four new pages
  in `docs/design/` (channel delivery, ClassicBot reply routing, command permissions, memory layering); the rest was
  deleted and stays in git history. Five superseded docs moved to `docs/archive/` with a header saying what replaced them,
  and the status lines of the `docs/design/` notes now match what shipped.
- **`list_emojis` is lighter (#1226).** Server emojis no longer come with image URLs unless `with_image_urls` is set
  (`preview_emojis` shows the ones an agent wants to look at), and `name`, `limit` and `primary_only` narrow the list —
  on a busy server one call used to cost ~10k characters of context for an agent that needed one emoji. The emoji and
  sticker tool calls now get the shared 30 s budget instead of a fixed 10 s, so a preview that downloads several
  pictures is not cut short.

### Fixed
- **The first Discord slash acknowledgement after an idle gap reuses its connection (#1235).**
  The discord.js REST manager now gets a dedicated undici agent with a 60 s keep-alive (undici's default is
  4 s, so the first `deferReply` after any pause paid a fresh TLS handshake). 60 s is the idle fallback when
  the server sends no Keep-Alive hint; a hinted idle timeout overrides it. One dispatcher is shared by all
  Discord adapters for the life of the process and never closed — the same standing as the global dispatcher
  before, which was likewise never closed on stop. Scoped to this adapter's REST manager only —
  the global dispatcher is untouched, and proxy behaviour
  is unchanged (the adapter has no `HTTPS_PROXY` handling, before or after). Every acknowledgement now also
  logs its delivery/REST split at debug level, so cold vs reused latency can be compared even under the slow
  threshold.
- **Logged-out agy and muse are recognised; agy's effort levels match the binary (#1328).** Found by
  the 2026-10-07 CLI audit (agy 1.3.1, muse 1.4.3):
  - A logged-out agy is now reported as a sign-in incident. Its screen ("You are currently not signed in. / Select
    login method:") was never matched; the old wording only appears in agy's log file.
  - A logged-out muse 1.4.3 ("Log in with browser / Set an API key") no longer passes as ready. Its menu is held,
    with deliveries blocked, until someone logs in.
  - agy's effort levels come from its own `--help` (1.3.1 offers xhigh and max), falling back to low/medium/high.
    Levels are kept across a failed help only for the same agy version, and not past the 24h CLI env cache.
- **A working agy is seen as working; its trust prompt is answered only on a verified cursor (#1328).** From a
  signed-in agy 1.3.1:
  - agy's working row is a braille spinner, a verb and an ellipsis (`⣯  Generating...`), with no timer and no
    `(esc to cancel)`. AgEnD's pattern never matched it, so a working agy always looked idle. That row now counts as
    busy, and so does the rolled-up thought agy shows in its place, but only in agy's own spot: at the left edge,
    right above the input box. A reply that quotes the row leaves a finished turn idle.
  - The trust prompt ("Do you trust the contents of this project?" / "> Yes, I trust this folder" / "No, exit") gets
    one Enter, and only while the cursor is on "Yes". With the cursor anywhere else, or the prompt still up after
    that Enter, it is held, with deliveries blocked, for a human. A copy of the prompt quoted in the conversation is
    not answered.
- **A relative `systemPrompt` / `workflow` `file:` path means the instance's working directory (#1314).** It was
  read against the fleet process's current directory: `~/.agend` under the installed service, the shell's directory
  after a manual `agend fleet start`. So one fleet.yaml could load another file, or none, depending on how the fleet
  was started, and a missing file silently dropped the instructions. Now:
  - `~/` and absolute paths are used as given; anything else is relative to the instance's `working_directory`.
  - For one release, a file found only at the old location is still used, with a warning naming both paths and one
    notice in the instance's topic.
  - A file that is missing, unreadable, over 256 KiB, or not a regular file (a FIFO or device, opened without
    blocking) is logged with its path and error, never its contents. `~name/` (another user's home) is refused.
  - Config validation warns about a reference that names no file.
  - `systemPrompt` is split on commas only when a part is a `file:` reference: an inline prompt such as "You are Kuro,
    a careful reviewer" stays one paragraph (it used to become two).
- **New instances get short unique names; user-facing labels never show a 19-digit id (#1301).**
  A new instance is now `<base>-t<last 6 topic digits>` (lengthened on collision, up to the full id), across
  fleet.yaml keys, instance dirs and tmux windows — existing instances are untouched, never renamed or migrated.
  Reusing a taken name requires proof it belongs to the same topic (full `topic_id` string equality, plus the
  adapter/world check when recorded — checked on the full form and every short/lengthened candidate, so a
  rebind never opens a duplicate entry); a name owned by a different topic is never overwritten. When even
  the full-id form is taken by another topic, creation is refused with an error suggesting a different
  `topic_name`, so every allocated name keeps the `-t<digits>` shape that orphan cleanup recognises. A
  dir-only collision without a config entry never counts as same-topic. Display labels prefer `display_name`,
  else shorten a 19+-digit `-t<digits>` suffix to its last 6 — only while that short label is unique across the
  fleet; on collision the shown tail lengthens just enough (legacy, new and explicit-label entries share one
  namespace), so same-tail instances stay distinguishable in visibility posts, Mirror Topic, broadcasts,
  `/status` and the `agend ls` table. Rollback deletes a created topic through the same adapter/world that
  created it. Agent-facing names (`[from:…]`, logs, lookups, `list_instances`, `--json`/`--names-only`) keep
  the real name. Orphan detection recognises both forms.
- **Updated configuration and operational documentation (#1278).** English and Traditional Chinese now describe native backend instruction files, startup decision snapshots, credential-profile differences, current defaults/tool counts and monitoring-only context guardian settings. Corrected macOS advisory memory behavior, diagnostics, test/build isolation, interaction terminology and hang controls; repaired the Chinese CLI templates link. Documentation only; runtime behavior is unchanged.
- **Settings → Defaults language: no longer pins locale to English on any unrelated save (#1310).** The language `<select>` had no "unset" option, so with `defaults.locale` absent the picker fell to its first choice (en). Any save — even an unrelated one like changing log_level — therefore wrote `locale: en` to fleet.yaml, pinning the UI language and disabling timezone/locale auto-detect. The picker now has an explicit **"Auto (follow system)"** option as the first entry that maps to *unset*. Only changed fields reach the API (`changedFields` against baseline); choosing Auto sends `null` to remove the key.
- **Corrected security, permissions and access documentation (#1275).** Removed the nonexistent IPC secret handshake and generated Bash denylist; documented default permission bypass, persisted access precedence, platform-specific command roles, and the actual dashboard/public View/Host/agent-token boundaries. Documentation only; runtime behavior is unchanged.
- **kiro-cli 2.28.0's "Classic is being deprecated" prompt no longer blocks a legacy instance at launch (#1308).**
  2.28.0 asks before every Classic session, even one launched with AgEnD's pinned `--legacy-ui --agent-engine=v1`:
  "Switch to 3.0 and upgrade my agent configs" or "Remind me later". AgEnD did not recognise it, so the instance sat
  on it. It now answers "Remind me later", moving one verified step off "Switch to 3.0" and pressing Enter only once
  the cursor is seen on "Remind me later". Anything else is held for a human and reported. "Switch to 3.0" is never
  chosen: it makes 3.0 the machine-wide default and reruns the session there, a one-way move. kiro asks again after
  its 7-day snooze. kiro-cli 2.27.x does not show this prompt.
- **Muse session discovery no longer reads whole session logs (#1228).** Finding the workspace's session used to
  `readFileSync` all of every candidate `session.jsonl` before slicing the 64KB head that names the working
  directory — slow when sessions grow long. Both `MuseBackend.getSessionId` and the detection-seam `museFingerprint`
  now go through a shared bounded `readFileHeadSync` (open + stream-decode the first 65,536 characters + close)
  with results identical to the old full read (the bound is decoded characters, not bytes, so multibyte heads
  stay discoverable).
- **Delivery reactions leave agent reactions alone on Telegram (#959).** Status updates now track ownership of the bot's one reaction slot and share a per-message queue with agent reactions. A late status skips when ownership is unknown (including after adapter replacement or an ambiguous API failure), even if the agent chose the same emoji as the old status. General fallback delivery also retains the original chat/thread metadata; Discord topic routing remains unchanged.
- **Corrected `checkout_repo` and `get_usage` tool descriptions (#1296).** The `checkout_repo` description said "read-only worktree" and "instance name or absolute path"; the handler (`daemon.ts`) rejects non-path sources and creates a detached-HEAD worktree, not an enforced read-only mount. The `get_usage` description listed only Claude/Codex/Grok/Kiro; Muse and Antigravity were missing. Both are now accurate. Agents that read tool descriptions to decide how to use them saw wrong information.
- **Config now warns when `context_guardian.max_age_hours` or `grace_period_ms` is set (#1296).** Context rotation was removed; these keys are retained for backwards compatibility but have no effect. Setting either one now produces a validator warning: "no effect; context rotation was removed".
- **A tool step being written when AgEnD starts watching is no longer lost (#1250).** #1221 made AgEnD read a CLI's
  transcript only up to the last complete line. The point it starts from still went to the file's current size. If
  the CLI was half-way through writing an entry at that moment (a first attach, an instance restart, a delivery
  checkpoint), the rest of that entry was skipped as unreadable and its tool progress never showed. Every such
  starting point is now the last complete line, for Claude, Codex and Kiro alike.
- **Kiro outage picker notice is actionable again, interaction IPC is quiet, dead gate removed (#1219).**
  The parked-dialog notice for a generic `dialog` kind (e.g. the Kiro model-unavailable picker) again carries its
  code-owned description — "model unavailable, choose a replacement" — instead of the generic "waiting for your
  input"; specific kinds (permission, login, …) keep their category text. `publishInteraction` no longer re-emits
  and re-broadcasts an unchanged snapshot on every observation (phase/kind/reason/episode/stale/suspected keyed;
  clocks excluded, final state never lost). The unreachable pre-probe `delivery_idle_gate` staleness check is gone;
  the live post-probe fence stays.
- **No more false memory alerts on macOS (#1257).** On a Mac, AgEnD no longer posts the "Host memory pressure"
  notice and no longer slows or holds agent starts for memory. Its free-memory and swap figures are not a pressure
  signal there: macOS adds swap files as it needs them, so a nearly full swap is normal, and a 16 GB Mac with 2.8 GB
  available was being told to start agents one at a time. The samples are still written to the log. Using macOS's own
  memory-pressure level instead is tracked in #1256. Linux is unchanged.
- **`agend-agent reply … --sticker` follows the same rules as the MCP reply (#1254).** For an agent on
  `agent_mode: cli`, a sticker this channel cannot send is checked before anything goes out and comes back as the
  reply's error: another server's sticker on Discord, or something that is not a Telegram sticker id. Before, the
  reply went straight to the adapter. A reply with stickers is also no longer treated as a duplicate of the same text
  sent without them while that one is still in flight. Both paths now build the duplicate check the same way.
- **No more duplicate replies from an early reply-drop recovery (#1241).** On claude-code the reply completion guard
  used to fire on the first idle-looking pane while the agent was still composing its first answer, pasting a
  `[system:reply-required]` prompt the agent later answered a second time. Recovery now waits until the turn proves
  itself over: the first idle edge only arms a 60 s confirmation window (work observed after the edge, a delivered
  reply, or cancel dissolves it), and the prompt goes out only when steady idle persists past the window with no
  reply. An edge with no work observed since the turn armed is held outright. Genuine misses still recover (#750),
  at most a minute later — and the recovery prompt now says to do nothing if the message was already answered.
- **Claude transcript events survive partial writes (#1221).** Tool progress and activity now wait for a record's
  terminating newline before advancing the read offset. A record flushed across polls is read once when complete,
  including after a monitor restart; complete final records still appear immediately. The shared Codex/Kiro JSONL
  tailer uses the same byte boundary, preserving UTF-8 text split across writes.
- **Claude's API retries are seen again (#1239).** While Claude Code retries a failing request
  (`✻ 429 … · Retrying in 4s · attempt 4/10`), AgEnD posts a notice and keeps the turn as running. Since #1101 that
  only worked on screens without a status line. With one, which AgEnD always sets, Claude leaves `esc to interrupt`
  out of the footer, and the check relied on that hint. A live retry therefore read as idle with no notice, and a long
  wait could retire Cancel mid-turn. The row is now told live by where it sits: in the spinner's place, directly above
  the composer. A finished, interrupted or quoted row is still history, and the final rows (`Request rejected (429)`,
  repeated 529, an invalid configured key) are recognised as before. Also, Claude's own Bash permission prompt is
  held again when a long working directory wraps its second option onto two rows.
- **The web login page's sign-in code box is on screen at 100% zoom (#1242).** On a `/login` web terminal the terminal
  sized itself before the "Sign-in code" row appeared and then kept that size: its bottom rows, the CLI's
  `Paste code here` prompt among them, ran under the row and covered it. The box was there, but could not be seen or
  clicked until a zoom change re-fitted the terminal. The terminal now re-fits whenever its own area changes and never
  draws past it, so the prompt and the box are both visible at any window size.
- **Switching an instance's backend no longer leaves it unable to start (#1217).** A session id now belongs to the
  backend that made it (`session-id.backend` next to it). On the first start under a different backend, the old id is
  set aside (`session-id.abandoned-<ts>`, as before) and the new CLI starts fresh, instead of being asked to resume a
  conversation it never had. `update_instance_config` now restarts a running instance, fresh, when its `backend`
  changes. Before, the change was saved and the old CLI kept running until something else restarted it. Three related
  gaps made such a failure permanent, and they are closed too:
  - each backend names the words that prove its session is gone, e.g. muse's "retained session not found";
  - the count of unproven resume failures is kept in the instance directory, keyed by session id. Every start builds
    a new Daemon, so it used to stay at "attempt 1/3" forever and never reached the fresh start after three;
  - Claude's "Background work is running" exit prompt is recognised. Deliveries hold on it, and stop and pause cancel
    it with Escape and stop the process, never choosing one of its options.
- **Discord slash commands: fewer "The application did not respond", and none silent (#1231).** A slash command is
  now acknowledged before anything else is read. When the acknowledgement fails, the command is not run (you were told
  it did not respond, and running it would do it twice on a retry) and you are told so: privately, or in the channel.
  When another session of the same bot already answered it, this one stays silent. An acknowledgement later than 1.5 s
  logs where the time went (delivery vs the acknowledgement itself), the fleet logs every event-loop stall of 1 s or
  more, and the config validator warns when two connections share one bot token. Findings, including what is not a
  cause (presence updates, message volume on its own): `docs/design/1231-discord-slash-ack.md`.
- **Waiting for input is visible (#812).** `describe_instance`, `list_instances`, and status APIs expose a confirmed `awaiting_input` presentation alongside the unchanged execution state and a static interaction category. A second fresh capture confirms a prompt; observations older than 15 seconds are explicitly unverified without releasing safety holds. Claude's captured four-option Bash permission menu is held for a human with no keys sent. Generic terminal hints remain suspected, and editor coverage is not claimed. The 500ms confirmation and 15s freshness values are sandbox-tested policies, not live CLI guarantees.
- **An idle delivery to a Claude / Grok / Muse instance is no longer recorded `delivered` just because the pane printed something (#758).**
  Those CLIs have no readable input row, so an ordinary submission was confirmed by any output after Enter — which a redraw that
  wiped the paste produces too, and the outbox said `delivered` for a message that never arrived. The ✅ is unchanged, but the
  row is now finished by the CLI's own transcript: the delivery's marker found → `delivered` (`transcript-marker`, or
  `transcript-marker-queued` when the CLI holds it queued); the transcript read on the last look for a whole 10 s and the marker
  still absent → `uncertain` (`unverifiable-no-transcript-marker`, so a ⚠️ and a `[system:delivery-outcome]`; nothing is re-pasted,
  the message may still land); transcript unreadable, or a backend with none (Grok, Muse, Gemini, …) → today's `delivered`,
  labelled `output-edge-only; submission-unverifiable`. The wait runs after the pane lock is released, but the fleet lane and
  the shared pump budget stay held until the verdict (successes settle in about a second; a lost paste holds its lane for the
  bounded ~10 s window). Steer, native-queue, Codex, Kiro and raw pastes are untouched.
- **Instance logs no longer read the whole file into memory (#1206).** `get_instance_logs` read `output.log` synchronously in
  full before tailing it, so a multi-MB pipe-pane log blocked the event loop and could blow the 30 s IPC budget. It now reads
  backwards from the end in bounded chunks (at most 1 MB scanned, async), so I/O stays flat no matter how large the log grows.
  Logs that fit the bound keep an exact line count; larger ones return the tail with the count marked unknown and a note saying
  so. A tail with no line break in the scanned window returns its last segment flagged partial instead of an empty answer.
  A failed pipe-pane attach at startup now warns instead of vanishing silently.

## [2.1.11] - 2026-10-05

### Upgrade Notes
- **[Behaviour change] A Codex "model is at capacity" error is now answered with "keep going", not a restart (#905).**
  The old retry restarted the instance after 30 / 60 / 120 s, but a restarted Codex resumes at an empty prompt and
  nothing re-sent the failed turn, so the "retrying" notice promised something that never happened and the work sat
  there. Now the user is told (as before), and about a minute later AgEnD tells the agent "keep going" (繼續) — its
  context is still live, nothing is re-read, the model is not changed. Once per capacity error, and only into a screen
  that has not changed since: if the pane moved on, a person typed, the agent started working, a message is queued,
  the instance was stopped / paused / respawned or the user cancelled, the nudge is dropped. It is timed on the
  monotonic clock (a wall-clock step changes nothing). A second capacity error right after the nudge is a new episode.
  Up to 3 nudges are sent per 30 minutes; the next capacity error after that pauses the instance, as before.
- **[Behaviour change] `agend update` keeps an install on its channel; a beta is never moved to the stable line
  without asking.** With no flag, `agend update` used to install `@latest` whatever was installed, so on a beta it
  could go back to an older stable — and AgEnD's own notice told beta users to run exactly that. It now follows
  the installed version: a prerelease (`x.y.z-beta.N`, or any `x.y.z-<pre>`) updates from `@beta`, a release from
  `@latest`. `/update` in chat no longer decides this itself (it read the version next to its own code, which a
  source checkout reports as `1.22.0`, and sent `--beta` only when that contained "beta"): it runs a plain
  `agend update`, and the installed CLI decides. An update that would go back to an older version is refused
  unless `--stable`, `--version` or `--force` asks for it. New: `agend update --stable` switches a beta install to
  the stable release. A beta user told that a newer stable is out is now told to use `--stable`. The update
  installs exactly the version it checked (`@songsid/agend@2.1.11-beta.3`, not the `@beta` tag, which can move in
  between), and `agend update --version <v>` now works — it used to be read as `agend --version`, print the
  version and install nothing.
- **[Behaviour change] OpenCode instances now start without permission prompts, like every other backend.**
  OpenCode asks before it reads a path outside the project (`Access external directory /tmp`), reads a `.env`, or
  does what your own config marks `ask`; every other backend AgEnD runs already had its skip-permissions switch,
  so an OpenCode instance that opened `/tmp/image.jpg` sat on the prompt until a human answered. AgEnD now
  launches OpenCode with `--auto` (it answers every ask "once"; **an explicit `deny` in your config still
  denies**) when the binary's own `--help` lists it (OpenCode 1.17 and newer). An older OpenCode gets no launch
  switch at all — its only form, the `OPENCODE_PERMISSION` env, would override your own `deny` rules — so its
  prompts are answered at runtime instead. **A prompt that is on screen is answered with "Allow once"** (one
  Enter, nothing remembered); AgEnD used to press Right+Enter, i.e. "Allow always". If it got as far as the
  "Always allow" confirmation, Escape cancels back to the prompt. While a prompt is on screen the pane takes
  no delivery and is not treated as stuck, and agent text, a composer draft or a transcript that merely quotes
  the prompt no longer receives a key. `skipPermissions: false` turns the launch switch off (and the runtime
  answer stays on). A stop that arrives while a launch is being prepared now cancels that launch.
- **[Behaviour change] The legacy chat-relay `/login` mode is removed (#1139).** `login.mode: relay` was the
  pre-2.1.6 way to sign in (AgEnD drove the login CLI in a tmux window and relayed its menus, authorization URL
  and text prompts through chat); `/login` has run in the token-gated browser terminal by default since 2.1.5
  and `/login code` has had no entry point since #1137. **A fleet.yaml that still sets `login.mode: relay` keeps
  loading** — the setting is ignored, with one warning in the log; remove it. Nothing else changes for `/login`
  (web terminal, device-code, public link) or for installing a CLI. A provider-picker button from before the
  upgrade now answers "expired" when tapped.

### Added
- **A CLI dialog that ignores AgEnD's answer is now reported within about 15 seconds, for every backend.** AgEnD
  answers a runtime dialog (a permission prompt, a trust prompt, a picker) by pressing its keys; when the SAME
  dialog — the very same request, character for character (OpenCode names the request from its prompt block, so a
  ticking status line around it does not matter; other CLIs are compared whole-screen) — is still up right after
  the keys, three answers in a row, the instance's topic and the fleet are
  told once ("not taking AgEnD's answer… answer it by hand", with a note when deliveries are held). Before, a
  dialog that held deliveries was reported only after a minute, and one that did not (kiro trust, muse/grok tool
  approval, agy survey) was never reported and was simply re-answered every 5 s forever. The notice names the
  dialog by its fixed description and a count, never anything from the pane, and is sent once per episode (again
  only after the dialog went away and a new one ignores the answer). A prompt that was answered and replaced by a
  fresh one (a burst of tool prompts, or the next queued request of a different target) is not "stuck", and now also
  restarts the one-minute parked clock instead of inheriting it. Limits: two requests that look exactly alike, one
  right after the other, cannot be told apart from the screen and read as an ignored answer; and a screen that
  changes by itself where the CLI cannot name the request (a ticking timer) is never proof either way: it is not
  reported by this check, and the one-minute "parked" report of a dialog that holds deliveries keeps running as
  before (only a dialog that is gone, or a request the CLI positively names as different, restarts that clock).
  After the report AgEnD does not stop answering: it answers the SAME request only every 30 seconds instead of every 5
  (queued requests that merely look alike each still get their answer, just slowly — a truly ignored dialog is pressed
  far less), and a different request, the dialog going away, or a respawn restores the normal pace with a fresh count.
- **General hears when kiro-cli can no longer run a kiro instance.** When the installed kiro-cli refuses a kiro
  instance as configured (#1109) — at start, or at a respawn after kiro-cli replaced itself — every General now
  also gets `[system:kiro-incompat]` as an agent: which instances stopped, kiro's reason, that their
  conversations are intact, and to load the new `kiro-engine-migration` skill. ClassicBot kiro instances count
  too. It is held in the delivery outbox for up to 14 days until each General takes it (the same kiro-cli may
  have stopped General too; ordinary deliveries keep their 24 hours), and sent once per day per refusal. The
  operator's plain notice is unchanged.
- **`kiro_engine_status` tool** (read-only; worker, standard and general profiles): each kiro instance's
  (ClassicBot ones included) `kiro_ui` and credential profile, the engine flags its next launch would use or
  kiro's reason for refusing it, its prepared launches (kiro-cli and AgEnD version per change, from the engine
  ledger) and its V3 session. It runs no process: it reads the kiro-cli compatibility the last kiro launch
  probed, and says when that was.
- **`kiro-engine-migration` skill for General:** what a kiro incompatibility means, that a stopped instance's
  conversation is intact, what to tell the user, and what never to do (restart it to "try again", change
  `kiro_ui`, run kiro-cli, touch `~/.kiro`). The migration itself is not available yet, and the skill says so.
- **A kiro engine ledger, the baseline for the coming V1 → V3 move.** Every kiro launch is recorded in
  `<data dir>/kiro-engine-ledger.json` (owner-only): the instance's working directory and credential profile,
  the kiro-cli version, the AgEnD version, the UI and the engine flags AgEnD pinned — the last launch plus one
  history row per change. It sits outside the instance directory so `replace_instance` does not erase it. It
  never stops a launch: a ledger that cannot be written is skipped.
- **A V3 kiro instance resumes only the V3 session it owns, by id.** kiro's `--resume` on V3 takes the
  newest conversation in the directory from any engine and converts a classic one into a new V3 copy on every
  launch. A V3 instance now starts fresh, and its next launch takes up the session that fresh launch made —
  only when that is certain: created after the fresh start, owned by nobody (ownership is an exclusive claim
  under `<data dir>/kiro-v3/`), and with no other V3 instance in the same directory waiting for its own. After
  that it resumes that session by id while its claim is held; a skipped resume gives it up. A fresh start
  is recorded before the launch, and one that cannot be recorded refuses the launch rather than risk resuming
  the session it gave up later. Anything less certain starts fresh again,
  so two V3 instances sharing a working directory each start fresh. A classic conversation reaches V3 only
  through an explicit migration. `kiro_ui: v3` itself is still refused by validation until V3 runs unattended
  (#849).

### Fixed
- **Cancel stops reply recovery too (#1199).** The cancel button and `/cancel` now mark the current human turn before interrupting the CLI, so an intentional stop no longer triggers the missing-reply warning or asks the agent to produce another conclusion. Replies already being delivered still settle normally; new messages retain their own reply guard. A cancelled recovery's late failure and a cancelled paste's late success cannot restart that turn.
- **A restart no longer re-sends a Claude Code message that was already delivered (#1205).** After a restart the daemon looks for
  each in-flight delivery's marker in the CLI's transcript, and only a marker at the very start of a user entry counted. Claude Code
  stores every pasted message as `<pasted_content id="…">` + the text, so the marker was never at the start and was never found:
  a delivered message looked like "complete transcript, no marker" and, with the old CLI gone, was retried — the same message
  delivered twice. The CLI's own wrapper, in exactly that shape and for Claude Code only, is now accepted in front of the marker,
  which must still lead the body inside it; any other prefix, a quote, or another backend's entry still does not count.
- **Codex's "Selected model is at capacity" is detected on 0.159.2 and 0.160.0 again (#1208).** Those versions print the rejection as
  `■ Selected model is at capacity. Please try a different model.`, but the detector was written against `⚠`, so the capacity notice never
  came, the "keep going" nudge never armed, and the turn just ended in the generic missing-reply path. Any one status symbol (`■`, `⚠`,
  `⚠️`, …) may now open the line; a bullet, dash, quote marker or number still may not, and the sentence must still be the whole line
  from column 0, so prose that mentions model capacity triggers nothing. Detection only — what happens after a match is unchanged.
- **Telegram ClassicBot's `/start` reply says to @mention the bot (#1196).** "Agent started" and "already has an active
  agent" led with `/chat`, the Discord way; on Telegram you talk to a ClassicBot by @mentioning it, and the reply now
  says so. Discord's replies are unchanged, and so is what reaches the agent.
- **A steer into a busy Claude / Grok / Muse instance is `delivered`, not `uncertain` (#1197).** Those CLIs have no readable input
  row, and the idle→busy edge that proves an ordinary submission cannot exist in a pane that is already busy, so every durable
  steer used to end `uncertain` — a ⚠️ for the operator and a `[system:delivery-outcome]` for the sender, for a steer that had
  landed (it was not an IPC timeout: `send_to_instance` returns at once and nothing waits). Now a steer whose own trusted
  `message_id` is on the pane after its successful Enter — more often than before the paste, no dialog, same spawn and window — is
  `delivered`, with the evidence `steer-accepted-marker-on-pane; input-row-unreadable`: accepted into the live turn's input,
  not proof the model has read it (`delivery_status` already shows `delivery_mode: steer`). Anything less stays `uncertain`.
  Also: the steer banner now follows the delivery marker instead of preceding it, so a steer can be proved from the CLI
  transcript after a restart.
- **A Codex turn that runs long with nothing new on screen is no longer declared stuck (#1188).** The live status row's
  own elapsed counter (`• Working (5m 51s • esc to interrupt)`) now counts as proof of life: a counter that moved since
  the last look keeps the turn "working", however long the rest of the pane stayed the same. Before, the 10-minute
  stuck check stamped "the pane changed" with the time of the last output event — minutes old — so a healthy long turn
  was flagged (hang notice, then a restart attempt that "timed out" while the original process kept running). A pane
  whose counter stands still for the stuck timeout is still declared stuck. Also: the daemon's "last change" time never
  moves backwards, and the stuck deadline follows the latest sign of life instead of re-firing at once.
- **The #978 idle escape hatch no longer treats a quoted "esc to interrupt" as a running turn (#991).** It now uses the
  same precise live-status-row match as the rest of the daemon (any title, whole row, column zero): a real status row
  still blocks it, an indented quote or a prose mention in a reply does not.
- **Crash-loop recovery now honours the request to start without resuming (#835).**
  The daemon reads recovery intent before clearing it; failed or superseded starts
  that never reach the reader preserve it. Normal starts keep resuming as before.
- **A Codex footer with the native `Goal achieved (…)` status is recognised again (#1190).** Codex 0.159.2 paints its Goal
  status between the context item and the warnings (`Context 32% left    Goal achieved (1h 6m)    ⚠ 1 warning · f2 to
  view`); the "Context first" footer grammar had no place for it, so the idle composer could not be proved, stranded-input
  recovery ran out and deliveries to that instance failed (`Idle footer not recognised` / `retries exhausted`). Anything
  after the context item that is set apart by a column gap is now footer chrome, whatever Codex calls it or in whatever
  language (`Goal achieved (1h 6m)`, `Goal usage: 90 seconds.`, `Goal complete; time used: 90 seconds.`, `Goal 사용량: 45초.`,
  a field it has not shipped yet), and a Goal field is recognised even set off by a single space — no `session-id`
  status item needed. The same rule applies to a `tui.status_line` you configured (`model · Context 46% left    Goal …`),
  and its readiness pattern is built from the same grammar. A draft or a transcript line
  that merely starts with "Context 32% left" is still not a footer.
- **muse: a message after a cancel is no longer glued to the cancelled one (#829).** Cancelling a muse turn puts the
  interrupted prompt back into muse's input box, and the next delivery was pasted after it, so both were sent as one
  message and the cancelled work ran again. Before pasting, AgEnD now reads muse's input box and empties it with
  muse's own delete keys, one line at a time, checking the screen after each. It clears only a draft that is exactly
  one of AgEnD's own recent pastes to that same CLI process, drawn the way muse wraps it; looking like an AgEnD message
  is not enough, and a collapsed `[Pasted Content N chars]` (whose content cannot be seen) is never cleared. Anything
  else is left alone and stops the clearing, and so does a box that will not empty or a screen that cannot be read:
  the delivery fails and can be retried, and nothing is pasted onto the text. A stop, cancel or respawn while it clears ends the attempt with nothing sent. Other backends send no
  extra keys.
- **macOS no longer mistakes low free RAM for memory pressure.** Native, bounded async
  `vm_stat`/`sysctl` probes estimate reclaimable RAM and read swap; first/stale starts
  wait at most two seconds, with a 30-second shared cache. Unavailable Mac measurements
  now show unknown and neither warn nor slow starts; Linux behaviour is unchanged.
  The estimate can undercount reclaimable RAM, and failed Mac probes temporarily leave
  memory-pressure protection unavailable. Fixture-tested on Linux; live macOS user validation
  is pending. The native-probe commit can be reverted while keeping the unknown policy.
- **The `/login` browser terminal no longer kills the sign-in when you copy, and shows where the code goes.** Pressing
  Ctrl+C to copy the link sent an interrupt that ended `claude auth login` (exit 130); the paste and Enter that followed hit a
  dead session. Now Ctrl+C with text selected copies in every web terminal, and on the login page a Ctrl+C with nothing
  selected (and the Ctrl-C button) is off — Stop still cancels; the installer terminal keeps its Ctrl+C. The CLI echoes
  nothing of the code you paste, so it looked as if nothing had happened: the login page now has a code box that sends the
  code and Enter once and says so (the code is never logged). A code the server refuses ends the command; the page now
  says the code was rejected (expired, already used, pasted twice, or from another attempt) and to start `/login` again,
  instead of "exited with code 1".

### Security
- **Discord slash commands now follow one command table (#1148).** Where a command applies and who may use it is
  declared in one place (`src/command-table.ts`) instead of in two copied handlers; the 🔒 in a command's menu
  description is generated from it, so the label can no longer disagree with the rule. It sits behind the
  authorization door added earlier and can only narrow what the door allowed. The levels are *anyone*,
  *channel admin* (in a fleet channel a fleet admin; in a ClassicBot channel a fleet admin **or** a ClassicBot
  admin), *fleet admin* and *ClassicBot admin*. Behaviour changes:
  - **`/stop`** in a ClassicBot channel needs a ClassicBot admin on Discord, as it always did on Telegram. On Discord it
    was open to everyone; a fleet admin who is not also a ClassicBot admin can no longer stop a ClassicBot channel
    there, and never could on Telegram.
  - **`/compact`** on Discord needs a channel admin (it was labelled 🔒 but had no check on Discord). Telegram is not
    changed by this: it still needs a ClassicBot admin in a ClassicBot chat, and has no check in a fleet topic.
  - **`/save`** needs the admin of the channel's own kind (it asked for a ClassicBot admin even in fleet channels,
    so a fleet admin was refused there and a ClassicBot admin could paste into a fleet instance).
  - **`/pause`, `/wake` and `/collab`** in a ClassicBot channel now also accept a fleet admin on Discord (they accepted
    only a ClassicBot admin). Telegram is not changed: its ClassicBot `/pause` and `/wake` still need a ClassicBot admin.
  - **`/start`** is not changed on either platform, and the table now says so instead of "anyone": Discord checks the
    guild allowlist and nothing else; Telegram checks the user allowlist in a private chat, and the group allowlist
    **and** a ClassicBot admin in a group. The table marks it as decided by its handler.
  - The table has a Telegram column for the cells where Telegram's handlers differ from Discord's, and a test
    (`tests/command-gates-by-platform.test.ts`) drives the real Telegram handlers against it.
  - **`/stop` and `/dashboard` now show the 🔒** they always deserved; `/model`, `/effort`, `/clear` and the
    admin-only commands are unchanged for everyone who could use them.
  - A command that does not apply where it was typed (for example `/ctx` in a channel with no agent) is refused with
    one line saying so, before anything runs; a command that is no longer registered gets an answer instead of
    "the application did not respond".
  Typed `/commands` (as opposed to slash commands) are covered by a follow-up change.
- **Discord slash commands now go through an authorization door (#1148).** AgEnD registers its slash commands
  globally, so every guild the bot is in — and every DM with it — shows the same menu, and the lock emoji in a
  description is only a label. Until now a slash command skipped the allowlist that guards the same words typed
  as a message and never looked at which guild or DM it came from (only `/start` did): anyone who shared any
  server with the bot could `/steer`, `/compact` or `/cancel` a fleet instance or read `/sysinfo`. Now, before
  any command runs: a **DM is refused**; a command from **another guild** is honoured only for a registered
  ClassicBot channel or `/start` (which still checks `allowed_guilds`); and in a fleet channel the caller must be
  someone the **typed-message path would also hear** — the access policy of the adapter that owns the channel's
  instance (an explicit fleet admin always speaks). ClassicBot channels stay open to everyone, as before.
- **`/update`, `/doctor`, `/dashboard` and `/collab` (in a fleet channel) now require a fleet admin of the adapter
  the command came through, and an empty `allowed_users` means nobody.** They used to read the *primary* channel's
  list (`channels[0]`, not the adapter in use) and, for `/update`, `/doctor` and `/collab`, treat an empty list as
  "everyone" — so on a fleet without one, anyone able to type a slash command could run `agend update` on the
  host — while the typed `/update` treated empty as "disabled". Slash and typed now agree. **If you rely on these
  commands, list yourself under that adapter's `access.allowed_users`.**

## [2.1.10] - 2026-10-03

### Upgrade Notes
- **[Behaviour change] One tap for a public `/login` link — AgEnD gets cloudflared itself (#1137).**
  The kiro-cli and claude-code login confirmation now offers **I understand (temporary public link)**,
  **I understand (local network)** and **Cancel** without any configuration: `web_terminal.tunnel.allow_public`
  no longer has to be set, and `allow_public: false` is now the host's switch to turn public links off
  (no button, nothing downloaded). Pressing the public button is still the consent, every login, and the
  consent now warns that anyone with the link and its token can use that login terminal until it ends.
  If no `cloudflared` is on `PATH`, AgEnD downloads Cloudflare's official build into
  `~/.agend/bin` (no sudo, never system-wide): a pinned version, checked against a pinned SHA256 and
  re-checked before every use; a mismatch is deleted and nothing runs. Linux (x86-64, arm64, arm, x86) and
  macOS are covered. If cloudflared cannot be obtained, nothing is opened and the local link is still
  there. Everything else about the public link is unchanged: two private messages for the link and the
  token, fail-closed, a time limit, never logged. Discord and Telegram alike.
- **[Behaviour change] `/install-cli` is gone: `/login` installs a missing CLI, then signs in (#1131).**
  One command for "make this CLI work", so a guild with several AgEnD bots shows one entry per bot
  and there is nothing to mistype (`/install`, `/login-cli`). `/login`'s picker lists every backend
  the fleet can install or sign in to, each labelled with what a click does: an installed CLI signs
  in; a missing one is installed (its official script, verified on PATH) and signing in follows by
  itself. `/login <backend>` does the same, and `/login cancel` also stops an install — those are
  the only forms (`/login code` and a short-lived `reinstall` are gone, #1137). `opencode` and
  `muse` install but have no sign-in flow; `/login gemini-cli` still installs Gemini CLI, which the
  picker does not offer. The Discord slash command and the Telegram menu entry `/install_cli` are
  removed. Typing `/install-cli` (or `/install_cli`) still works in 2.1.10 — it says where the
  command went and runs `/login <backend>` — and will be removed in 2.1.11.
- **[Behaviour change] grok signs in with a code in the chat; claude-code can use the public link (#1137).**
  `grok login` is a device-code sign-in (grok 1.0.46 shows a URL and a code, then only waits), so
  `/login grok` now posts the URL and code in the chat, like codex, instead of opening a browser
  terminal. Its sign-in is also recognised again on grok 1.0.46, which reports "Signed in as …".
  claude-code's sign-in pastes a code back into its terminal, so finishing it from a phone needs
  that terminal: the public link (`web_terminal.tunnel.allow_public`) is now offered for
  claude-code as well as kiro-cli.
- **[Behaviour change] A paused instance now wakes by itself when another instance sends it work
  (#1129).** `delivery_worker` defaults to `wake_only` instead of `off`. Under `off`, a task delegated
  to an instance that had been paused across a fleet restart waited until someone ran `/wake`, with
  no sign it was stuck. Now the wake coordinator wakes it the way `/wake` does: backoff on failure,
  a notice after three failures in a row, and never for an instance paused because its login failed.
  With `warm_cap` set, waking for queued work may exceed the cap by `warm_overflow` (default 2), and
  a `/wake` or message to a paused instance is refused, instead of going over the cap, when the cap
  and overflow are full and no idle instance can be paused. An explicit `delivery_worker: off`
  keeps the old behaviour.
- **[Behaviour change] Crash dumps stay small, and systemd stops restarting a fleet that keeps
  failing (#1113).** On WSL every crash is piped to the WSL crash collector, which ignores
  `LimitCORE`, so kiro-cli and the fleet itself left core dumps of about 1 GB and 450 MB in
  `%TEMP%\wsl-crashes`. The systemd unit now sets `CoredumpFilter=0`, so a dump is a few KB;
  the setting is inherited by the tmux server and every CLI the fleet starts. `LimitCORE=0`
  covers systems that write core files directly. `TimeoutStartSec` goes from unlimited to
  15 minutes. `StartLimitIntervalSec=30min` and `StartLimitBurst=4` stop systemd from
  restarting a fleet that has failed four times in 30 minutes; before, a start took minutes,
  so the old 5-in-10-seconds limit never tripped, and under host memory exhaustion the
  watchdog killed and systemd restarted the fleet indefinitely. **A plain
  `systemctl --user restart com.agend.fleet` counts toward that limit; `agend restart` runs
  `reset-failed` first and is not affected.** `agend restart` (which `agend update` runs)
  adds these to an older unit, reloads systemd and checks that `CoredumpFilter=0` was
  loaded, refusing to restart otherwise — except on systemd older than 246, which does not
  know the setting and only gets a warning. Values you set yourself are left alone.
- **[Behaviour change] kiro instances are pinned to their engine on every launch, and
  refused rather than moved when that is impossible (#1109).** kiro-cli 3.0 (October
  2026) deprecates the classic UI and may default to its V3 engine; kiro also offers a
  "switch to 3.0" prompt whose answer is saved for the whole machine. An instance's
  conversation lives in its engine's store, and moving between engines forks it one
  way. AgEnD now launches `kiro_ui: legacy` as `--legacy-ui --agent-engine=v1` and
  `kiro_ui: tui` as `--tui --agent-engine=v2` (flags outrank saved settings), reading
  what each kiro-cli accepts from its version — or, for anything newer than 2.27, from
  its own `chat --help` (2.3's `--agent-engine` took `rust|kas`, so it gets
  `--legacy-ui` alone). A kiro-cli that can no longer run an instance on its engine is
  not started: one notice says why, and there is no automatic retry; a kiro-cli
  replaced under a running instance is caught at its next respawn. A missing selector
  in `--help` is never taken as proof of an old binary. The "switch to 3.0" and
  "upgrade your agent configs" launch prompts are answered with the choice that changes
  nothing, one key at a time and only on a cursor AgEnD has seen there; any other state
  of them (an unrecognised cursor, "Don't ask again", a key that did not move it) is
  held for a human with deliveries blocked. kiro-cli older than 2.21 or newer than 2.27
  gets a one-time notice; it still starts.
- **[Behaviour change] One broken MCP server no longer stops every kiro instance (#1111).**
  AgEnD launched kiro-cli with `--require-mcp-startup`, which exits (code 3) when ANY
  enabled MCP server fails to start. That includes the servers you configured yourself
  in `~/.kiro/settings/mcp.json`, so a third-party server that broke on kiro-cli 2.27
  kept every kiro instance from starting. kiro now starts like claude and codex do: a
  failing server of yours only loses its own tools (kiro shows it as `✗` in the pane).
  Whether AgEnD's own fleet server connected is checked by the daemon instead, for every
  backend: if a CLI has been up for 90 seconds and AgEnD's MCP server never connected,
  the instance reports that it has no agend tools and, with `mcp_auto_restart` (the
  default), restarts once idle to retry. A server that connects late retracts the report.
- **[Behaviour change] Tunnels reach Cloudflare over http2 and wait up to a minute.** The cloudflared provider now
  passes `--protocol http2` by default (QUIC/UDP 7844 is blocked on many corporate networks and VMs, where cloudflared
  otherwise spends a long time failing over or never connects) and probes readiness through Cloudflare's public
  resolvers (1.1.1.1 / 1.0.0.1) with the system resolver as fallback; the startup budget goes from 30 s to 60 s. This
  applies to `agend setup --tunnel` too. Set `web_terminal.tunnel.protocol: quic` (or `auto`) to keep cloudflared's own
  choice for the login tunnel.
- **[Behaviour change] The `/login` browser terminal applies the same `Host` rule.** Each
  `/login` opens a short-lived listener of its own. It checked that
  `Origin` equals `Host` — which a DNS-rebinding page satisfies by construction — and
  answered to any `Host`. It now refuses, with the same 403 on every path and on the
  WebSocket upgrade, any name that is not `localhost`/`127.0.0.1`/`[::1]`, the fleet
  `hostname:` or a `web.allowed_hosts` entry (the setting the dashboard already uses).
  **If you open the terminal link through a reverse proxy or a LAN address, add that
  name to `web.allowed_hosts`.** The listener can also be told one more exact name, and
  to set its cookie `Secure` from that name rather than from `X-Forwarded-Proto`; nothing
  uses that yet (it is the groundwork for exposing a login terminal through a tunnel).
- **[Behaviour change] The dashboard now refuses requests whose `Host` is not a
  name it knows.** The health/dashboard server listens on 127.0.0.1, but that does
  not stop DNS rebinding: a web page can point its own domain at 127.0.0.1 and
  read, from script, the routes that need no cookie — including `/view`'s live
  terminal capture (`/api/pane/*`). The one thing such a page cannot change is
  the `Host` the browser sends, so every route (`/health` and `/agent` included)
  now answers 403 unless `Host` is `localhost`, `127.0.0.1`, `[::1]`, your fleet
  `hostname:`, or a name listed in the new `web.allowed_hosts`. The port is not
  compared. **If you reach the dashboard through a reverse proxy or a port
  forward that presents another name, add that name to `web.allowed_hosts`**;
  the first refusal of each name is logged in `fleet.log` with that hint. The
  CLI, `agend web`, `/dashboard` and every internal caller use loopback names and
  are unaffected.

### Added
- **`/login` says which fleet it belongs to.** Every AgEnD bot in a Discord guild registers its own
  `/login`, so the slash menu listed identical commands and a picker could come from another fleet
  than the one you meant. Its description now ends with the fleet's label, and the backend picker
  shows `🖥 Fleet: <label>`. The label is `fleet_label` in fleet.yaml, by default
  the host name (plus the AgEnD home's name when it is not `~/.agend`).
- **Finish a `kiro-cli` `/login` from your phone: optional public link
  (`web_terminal.tunnel.allow_public`, default off).** When enabled, the login confirmation offers
  **Open public link** beside **Local link only**; the press is the consent, per login. A Cloudflare Quick
  Tunnel fronts only that login's terminal; the public link and the access token go to the requester as two
  private messages (never the channel); a failed delivery, a failed or lost tunnel, a cancel, a timeout or a
  shutdown all close the tunnel before the next login can start, and a tunnel that cannot be confirmed
  stopped is announced and blocks further tunnels. The tunnel's public name is never logged. Needs
  `cloudflared` on `PATH`. See "Finishing a /login away from the machine" in `docs/configuration.md`.

### Fixed
- **A rejected Discord slash command registration is reported (#1131).** It was swallowed without a
  log line, and Discord keeps the previous command list when it rejects one, so a new or changed
  command could silently never appear. The fleet now logs every registration (the command
  count, or Discord's error code and message) and tells General once when Discord rejects it.
- **Button prompts never fail silently (#1133).** On Discord, a backend chooser with more than five
  backends could not be posted at all: Discord allows five buttons to a row, and all of them were
  in one. Buttons are now laid out in rows of five. A chooser or confirmation that cannot be posted
  now says so instead of reporting "chooser posted" or stopping at "Starting…". A click that cannot
  act — the prompt expired, it is not your prompt, or you are not a fleet admin — now tells you why,
  privately (an ephemeral message on Discord, the button's answer on Telegram). Telegram answers a
  click once the fleet has decided, so a failed answer no longer loses the click. When an outcome
  cannot be written into the prompt it is posted as a message, and a click nothing handles is
  logged.
- **Discord: the `/login` backend buttons respond to clicks (#1131).** A picker posted by
  the native slash command was bound to the channel, while Discord reports every button click by
  guild and channel, so each click was rejected as a mismatch and nothing happened. Buttons now carry
  the same address their clicks report. A picker posted in a channel outside the bot's main server
  (slash commands are accepted there) is now clickable too; any other button from such a channel is
  still ignored, and is logged instead of dropped silently. Slash replies also use `flags` instead of
  discord.js's deprecated `ephemeral` option, and the client listens for `clientReady`.
- **`agend update` / `/update` to 2.1.10-beta.2 failed with "fleet restart failed" on systemd hosts,
  and left the old fleet running (#1113 hotfix).** systemd 249 silently ignores `CoredumpFilter=`
  in a unit file, so beta.2's check that systemd had loaded `CoredumpFilter=0` refused every
  `agend restart`. The check is gone (a loaded value other than 0 is only reported). On Linux the
  fleet now sets its own `/proc/self/coredump_filter` to 0 at startup, and every CLI launch sets it
  in the pane's shell first — so crash dumps stay a few KB on any systemd, including in a tmux
  server the fleet did not start. `AGEND_KEEP_COREDUMP_FILTER=1` turns this off (processes keep the
  mask they inherit, which is not necessarily a full dump). `agend update` also restarts a fleet
  that started before the installed version instead of reporting "already up to date" — only a
  process confirmed by its command line to be the fleet; a stale `fleet.pid` naming any other
  process is never restarted or signalled — so a fleet left behind by a failed restart catches up.
- **A fleet started with a throwaway `HOME` no longer joins the real fleet's tmux server (#1126).**
  Only the user's real `~/.agend` (from the password database, not `$HOME`) uses tmux's default
  socket (if that database cannot be read, no home is the default). Before, a fleet run with `HOME` and `AGEND_HOME` both pointed at a scratch directory
  counted as "default", attached to the live `agend` server, and its startup cleanup killed the
  live fleet's windows as orphans. Nothing changes for an unset `AGEND_HOME`, one set to your real
  `~/.agend`, or any other custom value: each keeps the socket it had.
- **Dashboard responses can no longer be framed, sniffed or cached.** Every
  response from the dashboard/health server now carries `X-Frame-Options: DENY`,
  `Content-Security-Policy: frame-ancestors 'none'` (the pages have buttons that
  restart instances, so a framed page could be clicked through),
  `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` (routes that set
  their own Cache-Control, such as the SSE stream and avatars, keep it).

### Security
- **Instance directories are now 0700 (and existing ones are fixed at startup).** `<data dir>/instances/<name>`
  holds `agent.token` and the IPC socket, but was created with the process umask — typically 0775, so
  group-writable and traversable by every user on the machine (the files inside were already 0600, the
  directory was the open door). New instance directories are created 0700; on start the fleet makes the
  `instances` directory and each instance directory under it 0700 once, logs a single line saying so, and
  never touches anything inside them (a file you put there keeps its mode). Symlinks and directories owned by
  someone else are left alone and named in a warning. The "IPC socket parent directory is world-accessible"
  warning, which fired on every instance start and was never acted on, now fires only for a directory that is
  still open and could not be fixed, once per directory. **If another user or service relied on reading an
  instance directory through group access, give it access explicitly — the group no longer has it.** (#1118)

## [2.1.9] - 2026-10-02

### Upgrade Notes
- **The systemd unit stops the fleet, not every CLI at once (#908).** With
  systemd's default `KillMode=control-group`, stopping or updating the service
  sent SIGTERM to the fleet, the tmux server and every CLI at the same moment,
  before the fleet could quit them one by one. On WSL kiro-cli aborted into a
  core dump of about 1 GB each time. New units use `KillMode=mixed`, and
  `agend restart` (which `agend update` runs) adds it to an existing unit and
  reloads systemd before restarting (#1070). If the line cannot be written, or
  systemd still has another mode loaded after the reload, the restart is
  refused with what to do, instead of stopping the fleet the old way (#1073).
  A `KillMode` you set yourself is left alone.
- **Restarting a paused instance now wakes it (#1075).** It used to come back
  still paused, and after a fleet restart nothing woke it. If the start fails,
  it stays paused and can be woken again.
- **New opt-in delivery setting `delivery_worker` (default `off`; #1075,
  #1078, #1079).** `off` keeps every delivery path as it was. See Added for
  `wake_only` and `on`. With either, `defaults.warm_overflow` (default 2) is
  how far `warm_cap` may be exceeded to wake a target for queued work.

### Added
**Cross-instance messages wake a paused instance reliably (opt-in,
`delivery_worker: wake_only`; #1078).** A message to an instance paused across
a fleet restart used to stay queued at attempt 0 until someone woke it by
hand. A wake coordinator now wakes a paused target when queued work is
waiting, through the same single wake an operator's `/wake` uses. It retries
with backoff, tells both topics after repeated failures, and never wakes an
instance paused for a login failure. It also keeps the number of awake
instances within `warm_cap` plus `warm_overflow`. Each instance can be set
separately.

**Per-instance delivery worker (canary, `delivery_worker: on`; #1079).** For an
instance set to `on`, one worker owns its delivery lane: it waits until the
CLI accepts input, by the daemon's own account, then claims, hands off and
waits for the result, one message at a time. Ownership moves only when nothing
is in flight, and a lost connection after typing began never lets the next
message overtake the unfinished one.

**Persona emoji for photos and attachments (#1080, #1082).** The stamp a bot
puts on a photo or file it saved (📸 / 📎, 👌 / 👍 on Telegram) is now two more
`status_emojis` keys, `photo` and `attachment`, settable in Settings and with
`set_persona_emoji`.

**Every instance can see server emojis (#1081, #1083).** `general` can now
list, preview and set its own stamp; `minimal` can list and preview. ClassicBot
instances get the server emojis from `list_emojis` and can use
`preview_emojis`; only `set_persona_emoji` refuses them and points to
Settings.

**`/status` merges State and adds Model (#1052).** The State column combines
paused, stopped or crashed with the execution state, and Model shows the live
model, the same one `/ctx` reports. The IPC column is gone, and `agend ls`
uses the same State icons.

**`agend delivery scan-forged-envelopes` (#995).** It scans a kiro instance's
own transcript for fleet message envelopes naming real instances and checks
each message id against the durable delivery record. It reports any that the
fleet never delivered. It fails closed on anything it cannot read.

**Quits are logged with their reason and caller (#1030).** A Codex that exits
without relaunching is now reported.

### Fixed
- **Claude Code's first run no longer stops at the trust dialog or quits
  there (#1074).** Its confirm dialogs ignore keys for a moment after they
  appear, so a quick Down then Enter could land on "No, exit". Trust and
  bypass are now answered step by step on a verified cursor. The onboarding
  screens (theme, security notes, terminal setup) are recognised instead of
  being mistaken for a ready prompt, and the login screen is checked before
  readiness.
- **Woken instances stay awake for their work (#1075).** Work from other
  instances now counts as activity, and a woken instance starts its idle timer
  afresh. An instance busy only with delegated tasks used to pause again a
  second after every wake. Start, stop, wake and restart of one instance now
  run one at a time, so a late start can no longer take over from a newer one.
- **grok tells the operator to run `grok update` (#1066).** This replaces
  failing quietly when the server refuses an outdated CLI.
- **Codex remote login offers only device authentication (#1072).**
- **A CLI installed with `/install-cli` can be used by `/login` without
  restarting the fleet (#1059).**
- **A login-error match that cannot be verified pauses the instance only if
  it is still on screen when the turn ends (#1044).** A muse turn past its
  first minute still reads as busy (#1045).
- **The injected envelope no longer repeats a `task_summary` that only echoes
  the message (#1037).**
- **Security:** workspace paths can no longer inject shell commands, and
  identity settings can no longer write to object prototypes (#1061).
  Persona-emoji tools act only on an instance's own config entry (#1062,
  #1065). `list_emojis` and `preview_emojis` refuse inherited names such as
  `constructor` (#1083).

## [2.1.8] - 2026-09-30

### Upgrade Notes
- **Codex instances keep their app-server runtime directories private (#1034).**
  Each instance's `CODEX_HOME` used to mirror `~/.codex/app-server-daemon` and
  `~/.codex/app-server-control` as links, so a Codex that starts its managed
  daemon failed with "socket directory path exists and is not a directory", and
  a daemon started through the link would have been your own, with your
  config. The first start after upgrading removes only the links AgEnD created
  (an exact match on the target), leaves real directories and your own links
  alone, and never touches `~/.codex`. Sessions and the session database stay
  shared. Rolling back is safe: private directories are kept and nothing is
  deleted.

### Added
**An agent can pick its own persona emoji (#1039).** In a channel with several bots every
one stamped the same ✅ on the messages it handled. `list_emojis` shows an
instance what it may use: the standard emojis its platform takes and, on
Discord, the server emojis its bot can react with. `set_persona_emoji` then
sets its own `delivered` stamp (or another status it names) in its
`status_emojis` override, the way `set_display_name` sets its name. The value
is checked the way Settings checks it: Telegram's reaction set on Telegram,
one emoji only, and a server emoji only from a server the bot is in. The
bundled `persona-emoji` skill walks a worker through it. ClassicBot instances
have no per-instance stamps, and the tool says so.
A name and an id say nothing about what a server emoji looks like, so
`preview_emojis` downloads up to 8 of them and returns a local image path for
each, which the agent reads before picking (#1040). The fleet builds the CDN
address from the id of an emoji the bot can use, never from anything the
agent passes, and keeps only small PNGs.

**The Settings emoji picker lists every server the bot can draw on (#1021).**
Besides the connection's own server, it now lists the other servers the bot
is in that ClassicBot's `allowed_guilds` admits, grouped by server, primary
first. A server that refuses its list shows the reason without hiding the
others. Reacting with another server's emoji needs the bot's Use External
Emojis permission in that channel, and the picker says so.

**`/sysinfo` shows each backend CLI's version (#1027)** — Claude Code, Codex,
Kiro CLI, Grok, Antigravity and Muse — from the existing CLI-environment cache.
A stale value stays visible while it refreshes, and the refresh probes run in
a worker thread so a slow CLI cannot block the fleet.

### Fixed
- **Messages reach a Codex instance whose idle footer lacks the Context item
  in about 10 seconds instead of 70 (#1035).** The fleet's own idle wait,
  before a delivery reaches the instance, now accepts the same strict evidence
  as the instance-side fallback below, so it no longer waits out its full
  minute first.
- **A codex instance whose idle footer lacks the Context item no longer waits for ever for its
  first message (#1031).** After a restart, codex sometimes draws its idle composer without the
  `Context N% left` status item (seen on a resumed session whose footer showed only
  `⚠ 2 warnings · f2 to view`). The first delivery after a restart needs a recognised footer,
  so it waited 30 minutes, failed as retryable, and waited again: one instance sat on a queued
  task for seven hours. When the footer is the only thing missing, AgEnD now uses the same
  structural evidence it already uses to call an unknown screen idle. All of it is required:
  an empty input box, no busy row, queued input or known picker, no resume load on screen, the
  same screen for 10 seconds, and a terminal ready for input. It logs a warning when it does.
- **Codex instances resume their own session even when their session database is private (#1028).**
  If `~/.codex` had no session database yet when an instance first started (for example, AgEnD
  was the first thing to run Codex on the machine), Codex created a private one in that
  instance's home and kept using it. AgEnD looked only in the shared home, found nothing, and
  every restart fell back to `codex resume --last` or a fresh start, with a "could not be read"
  warning. AgEnD now reads the database the instance's Codex actually uses, and falls back to
  the shared one only when the instance has none. It stays read-only.
- **A Codex launch that starts a new conversation says so when this workspace
  had one (#1053).** When the resume lookup finds nothing, AgEnD starts fresh,
  and until now said nothing — "never had a conversation" and "the lookup
  missed it" looked the same, which is how #1028 went unnoticed. The launch
  now checks Codex's own rollout files for an interactive conversation of this
  directory with a turn in it, and if there is one, the instance's topic is
  told a new conversation was started and how to continue the earlier one
  (`codex resume <id>`). A workspace that never had a conversation stays quiet.
- **muse instances are no longer paused and `/quit` mid-task by a false
  sign-in error (#1042).** The muse sign-in pattern matched a bare `401`, and
  muse's diff view numbers its rows: editing line 401 of any file was read as
  an expired login, the pause waited for the turn to end, and AgEnD sent
  `/quit` before the agent could commit or report ("Quit when idle" in the
  pane is the description of muse's `/quit`). The pattern now needs one of
  muse's own sign-in sentences, on a row that is not the conversation's or a
  diff's.
- **The kiro transcript poll no longer stalls the whole fleet (#1048).** Every
  kiro instance polls its transcript every 2 seconds, and each poll opened
  kiro's conversation store (over 1 GB on a lived-in machine) and read every
  conversation of its workspace in full to learn whether anything had changed.
  With 13 kiro instances that was about 100 ms of blocking work every round on
  the fleet's event loop: Discord `/ctx` missed its 3-second deadline, the View
  stopped streaming, and a local request took up to 16 seconds. The poll now
  keeps one read-only handle and learns about changes from the index and the
  record header alone: 0.25 ms per round on the same store.
- **Settings › "Restart AgEnD" now shows that it is restarting, and cannot be pressed twice (#1024).**
  The restart really happened, but the button stayed enabled, the panel kept saying "Saved —
  restart AgEnD to apply" while AgEnD was going down, and nothing watched for it to come back —
  so people pressed it again. The click handed the *finished* job it was holding to the watcher,
  whose loop only runs while a job is "running", so it returned at once and re-drew a fresh
  button. It now disables and relabels the button the moment it is pressed ("Restarting…"), asks
  for one confirmation and posts one request, watches the job the server moved to "running",
  shows "Restarting AgEnD…" with an explanation, keeps polling through the seconds when the
  server is unreachable, and reports "Changes applied" and refreshes the page once AgEnD is back.
  A refused restart gives the button back with the reason.
- **Settings › Start / Stop / Pause / Wake on an agent show that they are working (#1024).** They were
  fire-and-forget (a failed stop said nothing, and a second press sent a second request). While
  one is in flight the agent's buttons are disabled and the pressed one reads "Working…", only one
  action per agent runs at a time, and a failure is reported.
- **Codex 0.158 and 0.159 are supported; deliveries wait out a 0.159 resume again (#1025).** Right
  after a restart Codex draws its composer about a second before input is live, and AgEnD
  holds deliveries until then. 0.159 redrew the header without its box, which the hold
  depended on, so on 0.159 a message sent straight after a restart could land during the
  load. The hold now recognises both header layouts. It is also tied to AgEnD's own launch
  state rather than to the screen alone: it applies only after AgEnD launched a resume, and
  it stops once the load has been seen to end or the screen has not changed for 30 seconds.
  So a conversation that quotes the loading screen cannot hold deliveries. AgEnD also launches Codex with
  `features.instant_interrupt` off: 0.159's opt-in setting makes new input steer the running
  reply instead of queueing behind it. Codex before 0.159 lists that key as "ignored" among
  its startup warnings; nothing else changes. On 0.158, instances that run with approvals
  on (`--full-auto`, i.e. `skipPermissions: false`) may see a new approval prompt for
  elevated commands. The default launch bypasses approvals and is unaffected.
- **Settings › Connections & Bots rows no longer break words or clip (#1022).** Since v2.1.7 each
  row (bot type, id, token env var, group/guild, access mode, allowed users, token status,
  connection state, Settings button) was a non-wrapping flex row, so every item shrank and
  wrapped inside its own box — "存取模式:" and "設定" split mid-word, chips became two lines —
  and the tail ("Connected") was clipped by the card. Items now keep their own text on one
  line, the row wraps *between* items when it is too long, and the token-status / state /
  Settings cluster stays together at the end. Long values (env names, user ids) break
  anywhere rather than widen the row. CSS/markup layout only; nothing about the data or the
  Settings button changed. Checked in Chromium at nine widths (1280–390 px) in both languages.
- **Settings › status emojis: every preview value now says where it comes from (#1023).** A report
  said that after picking Received and Queued, the 👀 "moved" to Processing. Nothing moved and
  nothing was mis-stored — the editor binds every value to its status name, and the request
  it sends carries exactly the keys that were picked (`{"received":…,"queued":…}`). 👀 is simply
  the built-in for Received, Processing *and* Progress prefix, and only non-default values were
  labelled, so the 👀 left under Processing looked like a displaced one. Built-in values now
  carry a "default" tag next to the "connection" / "agent" ones. A regression test drives the
  page's real editor code through every pair of picks (in both orders) and asserts each value
  lands on, previews as, and is stored under its own status name.

## [2.1.7] - 2026-09-30

### Upgrade Notes
- **[Behaviour change] Codex instances resume their own conversation, not a
  sibling worktree's (#984).** Codex 0.157's `codex resume --last` picks the
  newest session of the whole git repository, so AgEnD instances on worktrees of
  one repo were taking each other's sessions: a "conversation is open in another
  app" lock screen while the other instance ran, or its conversation silently
  continued here. AgEnD now reads Codex's session database read-only and runs
  `codex resume <id>` for the newest session recorded for exactly this
  instance's working directory. What changes for you:
  - An instance whose sessions are in its own directory resumes the same
    conversation as before.
  - A **new** instance in a repository that other Codex instances already use
    starts a **new** conversation instead of inheriting a sibling's.
  - If the session database cannot be read (for example after a Codex schema
    change), AgEnD starts a new conversation when another Codex instance shares
    the repository, and falls back to `codex resume --last` when none does; either
    way the instance's topic gets a notice. Earlier conversations are never
    deleted and can be resumed by hand with `codex resume <id>`.
  - Nothing is migrated and AgEnD writes no Codex state. A conversation that was
    already taken over before this release (for example a fork created from the
    lock screen) stays where Codex recorded it: check it, and archive a wrong
    fork in Codex, before restarting an affected instance.
- **Delivery-status emojis are configurable, and the filter now keys on who
  reacted (#1005).** A human reaction is never swallowed as a status stamp any
  more, whatever emoji it uses; only the fleet's own bots' stamps are filtered.
  A fleet that does not configure `status_emojis` keeps the built-in set.

### Added
**Delivery-status emojis can be configured per platform and per agent
(#1005).** `status_emojis` on a connection (`channels[].options`) or on an
instance sets the received / queued / processing / delivered / failed stamps
and the progress prefix, including Discord server emojis (`<:name:id>`).
Values are checked the way each platform accepts them — Telegram only takes
its fixed reaction set — and an unusable one falls back to the default with a
warning. The instructions' "don't react with these" list follows the resolved
set. Settings has an emoji picker with a live preview resolved by the same
code the bots react with, listing the server's custom emojis fetched with the
bot token (unavailable ones are shown but cannot be picked).

**Requests that require a reply are tracked until they get one (#926).** A
`requires_reply` request is recorded durably; when the reply is overdue the
owner is reminded and the requester is told, instead of the request quietly
expiring.

**Cross-instance delivery goes through a durable outbox (#929).** Messages
between instances are admitted to an on-disk outbox before they are sent,
reconciled after a restart, and can be looked up with `delivery_status`
(including silent schedules, which are admitted as raw pastes).

**A peer message can be verified by its message id (#856).** Each delivered
message carries an id and a payload digest, and `delivery_status` confirms
whether a given message was really delivered by the fleet — the check to make
before acting destructively on another instance's word.

**`/view` has a sidebar filter** and a more readable usage panel (#999).
`agend ls` collects its rows concurrently and no longer waits on one slow
instance (#997). Shell completion says when `bash <TAB>` will not work, can
install itself, and reports its status (#1003).

### Fixed
- **Codex resumes real sessions again (#1017).** The exact-directory lookup
  introduced for #984 only accepted threads with `has_user_event = 1`, which no
  real Codex 0.157 session carries, so every restart silently started a new
  conversation. A thread is now resumable once any turn ran in it, checked
  against Codex's own rollout when the listing is empty.
- **Codex session-lock and resume-directory screens no longer stall delivery
  silently (#984).** Codex's "This conversation is open in another app (r retry /
  f fork)" screen and its "Working directory · resume" picker matched nothing, so
  startup assumed the screen was ready and messages waited 30 minutes in the idle
  gate before failing. Both are now held: delivery stays blocked, the operator is
  told, and AgEnD never presses `r`, `f` or a picker option for you.
- **Codex's "switch model" nudge on a rate limit is turned off in fleet
  instances (#1008)** (`notice.hide_rate_limit_model_nudge` in each instance's
  config); the screen is still held, never answered, if it appears anyway.
- **Codex's Context status item is found in any status-line position and is
  verified to be in the status line (#931, #978),** with a warning when it
  cannot be added; a status row whose title is the model's reasoning reads as
  busy on every readiness path (#964); no-context readiness and a stale
  capacity baseline are fixed (#947, #949).
- **GitHub credentials stay out of worktree remotes (#855, #963).** Worktrees
  no longer get a token embedded in their remote URL, and an existing one gets
  an advisory warning.
- **Usage survives a failed fetch (#719):** a transient error shows the
  last good numbers instead of blanking the panel; fetch and startup probes are
  bounded and single-flight (#720, #724, #725).
- **Reactions:** a delivery-status emoji replaces the previous one instead of
  stacking (#868), statuses are only ever added and unreacted when leaving ❌
  (#972), a reaction counts as completing a reply (#877), and the reply-drop
  recovery prompt offers "react or reply" (#960).
- **grok's weekly-limit screen is held** instead of being answered (#992);
  **muse's idle check is anchored to the live input box** (#958); **fleet
  restart progress edits are throttled** and retried on Discord 429s (#965).

## [2.1.6] - 2026-09-26

### Upgrade Notes
- **[Behaviour change] Agents no longer get every tool by default (#804).** An instance
  with no `tool_set` in `fleet.yaml` used to be handed all 47 of AgEnD's tools,
  including `create_instance`, `delete_instance`, `deploy_template` and
  `update_fleet_defaults`. Nobody chose that; it was what "unset" meant. The
  default is now `worker`: talk to people and to peers, read everything, do the
  work — and none of the verbs that run the fleet.

  **What you may need to do.** Instances that genuinely coordinate — a team
  lead, a General-like dispatcher, anything that restarts or creates other
  agents — need `tool_set: coordinator` on the instance (or in `defaults`).
  **On first start after upgrading, AgEnD tells you which ones**: it reads the
  last thirty days of activity and names the instances that have actually used
  a tool a worker no longer gets, with what they used. Instances that merely
  delegate are not on that list, because `delegate_task` stays with the worker
  and they lose nothing.

  **Nothing is rewritten for you.** An explicit `tool_set: full` is still
  honoured exactly as written, including `defaults.tool_set: full` — which also
  means a fleet with that line keeps every agent on every tool until the line is
  changed. The notice says so rather than editing your file.

  The profiles are `worker` (default) ⊂ `coordinator` (set by hand) and `full`;
  `standard` and `minimal` are unchanged. `general` remains an identity rather
  than a choice: it comes from `general_topic` and is still refused if written
  by hand.

  One gap to know about: General cannot set `tool_set` for you today — its
  `update_instance_config` tool has no such field, so the value is dropped
  silently. Mark coordinators through Settings or by editing `fleet.yaml`
  (#814).
- **[Behaviour change] Codex instances get a short `CODEX_HOME` (#953).** Codex
  0.157 puts a socket under `CODEX_HOME`, and for instances with long names
  the path exceeded the Unix socket limit. Each instance's home moves to
  `~/.agend/cx/<hash>/` on first use after upgrading; the move is automatic
  and idempotent.
- **Codex resumes with `codex resume --last` again (#933).** The explicit
  per-instance session resume of #913 was reverted; its pane detection for
  Codex 0.155/0.156 (#914) was kept.
- **`kiro_ui: v3` is refused** until kiro's v3 interface can run unattended
  (#850): measured on kiro-cli 2.23.0 it stopped at a migration dialog and a
  trust screen whose default is "No, exit".
- **Switching an agent's subscription starts a new conversation (#798)** — kiro keeps
  its conversations in the same `data.sqlite3` as its login, so a different
  credential profile is a different set of conversations and there is nothing to
  resume. The first launch after a switch skips resume outright, and the new
  session is handed a summary of what the old one was doing (the reply reports
  `conversation_carried_over: false` and `handover_chars`). Say anything that
  must survive verbatim in the channel before switching.
- **Switching to a credential profile that has never been logged in is refused (#798)**
  — kiro-cli does not start a signed-out session, it stops at a sign-in prompt
  and waits, so the agent would sit on a login screen until its startup budget
  expired and then restart into the same screen. The error carries the command
  to log the profile in. Going back to the default login is never refused.
- **A busy health port no longer terminates whatever `fleet.pid` names (#792)** — the takeover used to signal that pid on sight, and a stale or wrong entry names whatever holds it now. The target's command line is checked first, and when it cannot be confirmed the signal is not sent. `fleet.lock` also records whether a fleet or the setup page owns it, so the two refuse each other in both directions instead of one stealing the lock from the other.
- **Dashboard and Settings links now exchange their token for a session cookie (#786)** — opening a link redeems `?token=` once, sets an `HttpOnly; SameSite=Strict` cookie, and redirects to the same page without the token, so the credential stays out of the address bar, browser history and any log that records request URLs. `X-Agend-Token` still works for scripts and the CLI, but a URL token is no longer accepted for a write. `agend web-token rotate` revokes every issued link and cookie at once.
- **Fewer changes ask for a full AgEnD restart (#787)** — "restart AgEnD" used to appear for every cold fleet default, including `backend` and `model`, which the agents absorb by restarting. It is now limited to settings read once when a subsystem is constructed (channel bindings, `health_port`, `defaults.locale`, `cost_guard`, `webhooks`, `daily_summary`, and the two scheduler keys the scheduler captures at startup).
- **A failed self-restart needs the change applied again (#789)** — if the restart cannot be launched, its row is marked failed and the job is finished rather than left open for another attempt. Press Apply again to get a fresh job whose fleet row can be restarted. This is the fail-closed side of "one restart per job": a job whose launch failed must not stay a reusable restart button.

### Added
**Tool access is decided by the fleet, not by what a model happens to be shown (#804).**
Every route into AgEnD's tools — the MCP tool list, a `tools/call` naming a tool
directly, a write straight to the instance's socket, and `POST /agent` — now
passes one permission table checked on the server side. Before, only the first
of those consulted a tool list at all, so narrowing an instance's profile saved
tokens without denying anything. A refused call says which profile the instance
is running under and what to do instead, because the agent reads the error as an
instruction.

**One fleet can now run on more than one subscription of the same backend (#795–#798).** An
instance carries `backend_options.<backend>.credential_profile: <name>`, and
instances naming the same profile share one login while instances naming
different profiles have different ones. An instance with no profile is
untouched: nothing is added to its launch and no directory is created, so a
fleet that does not use this cannot be affected by it. Implemented for
`kiro-cli`; the mechanism is one record per backend (`CREDENTIAL_HOMES`), not a
kiro-shaped design.

A profile lives in `~/.agend/credential-profiles/<backend>/<profile>` and is
logged in once from the host. Only the login is duplicated — kiro's
multi-gigabyte runtimes are symlinked back to the shared copy, so a second
subscription costs megabytes. The credential store itself is never a symlink,
because SQLite follows a linked database to its target and would leave the
profile sharing the login it exists to separate.

General can create an agent on a subscription or move one between them, in plain
language, and `/usage`, `get_usage` and the dashboard show **one row per
subscription** rather than one per backend — `Kiro (work)` beside
`Kiro (personal)`, each read from its own store and never added together. A
profile that is configured but not yet logged in still gets a row, reading
"Signed out", because that is the row you need to see while setting a second
subscription up.

Settings now applies changes as a job you can watch (#788). `POST /api/settings/apply` returns one row per affected agent and `GET /api/settings/apply/:jobId` is the authority on it; the job is stored on disk, so a change that restarts AgEnD itself no longer takes the answer down with it. The client generates the idempotency key before its first attempt, so the retry that follows a lost response rejoins the original job instead of applying everything twice.

The panel can restart AgEnD itself (#789) for a change only a fresh process can adopt, behind its own confirmation, its own idempotency key, and a rate limit of one restart per 10 minutes and three per hour that is written to disk before anything is launched. The restart is announced in the chat channel first and is refused if it cannot be announced, so a panel restart is never invisible to the people who would notice it was not them.

**Codex can use credential profiles too (#806).** A Codex profile swaps only
`auth.json`; sessions, the session database and caches stay shared, so
switching accounts does not have to start a new conversation. `/usage` shows
`Codex (work)` and `Codex (personal)` as separate rows.

**Meta Muse Code is a supported backend (`backend: muse`, #827).** Each
instance gets its own MCP configuration (#903), and muse's subscription usage
is relayed from its response stream into `/usage` (#894).

**The Settings panel was rebuilt (#785–#792).** Rows with modals, an advanced
drawer and a global search; a guided four-step quickstart; a pre-fleet setup
page with safe takeover and locking; and the page gate moved to an HttpOnly
session cookie with Origin checks and token rotation. Connections can rotate
their bot token securely (#864) and rebind to a verified guild or group
(#870), and provider API keys are verified before they are saved (#873).

**The setup page can be reached from a phone through a cloudflared tunnel
(#799–#803).** Every tunnel needs its own confirmation on a terminal — there
is no flag, env var or config that pre-answers it — and the warning says what
passes through Cloudflare. Without cloudflared, the command says so and gives
the local alternative.

**Discord bot activity shows usage (#866),** refreshed eagerly, scoped per
adapter and in a compact form (#891, #901, #921). `/model` has a
"🔄 Refresh models" item (#887), a Claude Code usage-limit pause is reported with
its automatic resume time (#820), `/ctx` shows the auto-pause setting and pause state (#952), and
the daemon logs why a CLI died and whether AgEnD stopped it (#942). Every
instance may now manage its own schedules; scheduling for others stays with
coordinators (#896). The documentation site moved to Astro Starlight, in
English and zh-TW (#825, #832).

### Fixed
- **Codex 0.155, 0.156 and 0.157 are supported (#914, #953).** Their pane
  layouts are recognised, and the folder-trust prompt at startup is handled
  safely (#919).
- **Codex usage limits:** "Continue with Luna Reserve" is chosen automatically
  on the usage-limit menu and the pane stays alive after it (#945, #940), the
  first delivery waits for the reserve to settle (#941), usage shows the
  reserve as "Luna Reserve" even at 0% (#937), and a model-capacity error
  backs off and restarts instead of pausing the instance (#905).
- **Codex:** the Context item is injected into status-line configs that quote
  their keys (#931), and false delivery failures during wake are gone (#918).
- **kiro:** the first delivery stays pending until its submission is proven
  (#934), busy turns are drained before a fleet stop (#938), and the
  unavailable-model picker is held and escalated (#925).
- **muse:** the idle gate is no longer blocked by muse's periodic redraw
  (#932), the second Enter muse asks for is sent (#831), an idle usage snapshot
  is kept (marked stale) while its windows stand (#904), and the usage relay
  resumes directly and notifies when recovery is exhausted (#899).
- **Claude Code's dangerous-command dialog heals itself:** it is denied
  automatically and the agent is told (#881).
- **Delivery and replies:** the resume wait is measured by progress, not wall
  clock (#869); late Cancel buttons are retired (#784) and armed prompts are
  retired on shutdown (#840); a refused artifact tells the agent how to send
  it (#885) and a reply reports the ids of the messages that carry its
  attachments (#836); Discord truncation keeps markdown fences intact (#838);
  a transient tmux `load-buffer` failure is retried (#841).
- **Configuration and access:** a state file that overrides `fleet.yaml`
  access is reported (#833); schedules keep the reply adapter they were
  created on (#844) and refuse a non-string target or id instead of crashing
  (#898); `list_models` honours the one-hour CLI-environment freshness window
  (#902); onboarding keeps the install result and discovers login backends
  (#859); Kiro Pro shows as unlimited (#892); Codex usage sources are split
  and unavailable presence rows hidden (#875); all loggers share one pino
  transport (#845).

## [2.1.5] - 2026-09-16

### Upgrade Notes
- **`/restart full` with empty `allowed_users` is now fail-closed** — previously, an empty `allowed_users` list in fleet.yaml would allow any user to perform admin operations. This release treats an empty list as "no one allowed," requiring explicit population of the allowlist. Review your fleet.yaml before upgrading if you rely on admin commands (#726).
- **Multi-adapter fleets: reply context requires adapter binding** — in fleets running more than one channel adapter (e.g., Telegram + Discord), if `last-chat.json` was written by an older version and lacks an `adapterId` field, the first reply after restart will fail with "no adapter bound" until an inbound message re-establishes the world binding. This is intentional: failing is safer than routing a chat id through the wrong platform's bot. Single-adapter fleets are unaffected (#752).
- **[Behaviour change] Readable backends now fail on unverifiable deliveries** — when a delivery cannot be proven to have left the input row (baseline confirmation fails three times and no unique signature is detected), the daemon reports ❌ instead of relying on output signals to guess ✅. The principle is "fail rather than guess"—users see the failure and can retry. This affects Codex and Kiro; Claude Code and Antigravity are unaffected because they have reliable submission signals (#757, #759).
- **[Behaviour change] Topic disappearance triggers quarantine, not deletion** — when a Discord gateway outage or channelDelete event makes a topic appear missing, the daemon now quarantines the instance (revokes its route, preserves all data) instead of automatically deleting the instance and its worktree. Destructive removal requires explicit authorization via the dashboard confirmation dialog or the `delete_instance` tool. This prevents data loss during transient adapter disconnects (#765, #766, #767).
- **Classic cold fields still require restart** — the new fleet-wide behavior switches (`tool_progress`, `reply_completion_guard`) hot-apply to fleet topics and to Classic channels that already exist. However, ClassicBot "cold" fields—`backend`, `model`, `effort`, and `working_directory`—still require an instance restart (or `/stop` + `/start`) to take effect; SIGHUP alone does not restart Classic instances. This matches the previous behavior and avoids mid-conversation backend swaps (#775).

### Added
The `/login` slash command introduced in 2.1.4 received significant enhancements this release. Login now runs inside the token-gated web terminal, providing a secure browser-based authentication flow for all backends. Codex uses device-auth mode for headless environments. After a successful login, the system reports the result immediately without waiting for instances to restart, and the restart carries a visible deadline so users know when to expect their fleet back online. An inline "re-login" button now appears alongside auth-failure alerts, letting operators fix expired credentials with a single tap instead of typing the command (#715, #717, #729, #733, #748).

The new `/install-cli` command lets operators install CLI backends remotely, and ClassicBot instances now recover automatically after a backend login instead of requiring manual intervention (#733).

The `/ctx` command now displays the configured reasoning effort alongside the model (#738). The `list_instances` MCP tool adopts progressive disclosure: the initial response shows a compact fleet summary with counts by backend, status, and tag, plus guidance on how to drill down. Query parameters (`tags`, `backend`, `status`, `name`) filter the list, and `describe_instance` returns full details for a single instance. Claude Code's live model (read from the statusline) is included when available, and `get_instance_logs` is capped at 200 lines by default to protect against runaway context consumption (#740).

The web dashboard now shows richer instance metadata. The detail header and sidebar hover tooltip display the live model (aligned with `/ctx` parsing), configured effort with a "(configured)" label, backend, and the instance's display name when set. The `/ui/instance/:name` and `/api/profiles` endpoints include the new `model_source`, `effort_source`, `context_pct`, and `display_name` fields so external tools can distinguish live versus configured values (#762, #764, #770).

`/restart full` performs a complete process reload from chat, service-aware and single-flight. The systemd handoff timeout outcome is now tracked correctly, and the reload is fenced against standalone updates so a mid-flight `agend update` cannot race (#726).

Two fleet-wide behavior switches are now exposed in Settings and fleet.yaml. `tool_progress` controls whether the working bubble lists tools as they run (off by default; set to `standard` for semantic labels or `verbose` for command previews). `reply_completion_guard` enables the silent-reply-drop protection from #750; it defaults to `true` and can be disabled per-instance if it interferes with a specific workflow. Both switches resolve through the same channel → classicBot defaults → fleet defaults → hard default chain used by other Classic settings, and hot-apply via SIGHUP or Settings edits without requiring a restart (#775).

### Fixed
This release addresses several silent-message-loss scenarios that could cause user messages to vanish without error.

**[P0 data-loss fix] Discord gateway outages could destroy instances and worktrees.** During a temporary adapter disconnect, the topic-cleanup poller and `channelDelete` handler misinterpreted the missing topic as permanently deleted and automatically removed the instance, deleted its git worktree, and rewrote fleet.yaml—even though the topic still existed on Discord. One user lost 8 instances and 2 worktrees before the bug was identified. The fix is fail-closed: the adapter topology probe now returns a three-state result (present / missing / unknown) where "missing" requires positive evidence from the provider. Cleanup actions use the owning adapter, a single-flight snapshot, and a generation fence; bulk missing results trip a circuit breaker. Automatic topic-missing and channelDelete handling now performs non-destructive quarantine only (revoke route, preserve everything). Destructive `removeInstance` and worktree deletion require an unforgeable authorization token that only the dashboard confirmation dialog or `delete_instance` can issue (#765, #766, #767). **This bug also affects v2.1.4.**

**Codex first-delivery strand after restart or wake.** After a restart or wake, the first message could be swallowed by the CLI's pane redraw, yet the daemon reported ✅. The root cause was that Enter was absorbed by the redraw and the daemon trusted an output signal that never corresponded to actual submission. The fix binds submission verification to backend capability: readable backends must positively prove that text left the input row. A new `InputUnavailableTransient` capability handles Codex 0.154.0's `Resuming session…` transient period, during which Enter is absorbed. Four gates and a generation fence ensure that no delivery is confirmed until the CLI is genuinely ready to receive input (#757, #759, #760, #761).

The Kiro ready-state detector now distinguishes transcript residue from text genuinely stranded in the input row, eliminating false delivery failures that reported ❌ when the message had actually been sent (#736). Kiro CLI 2.14+ prints the agent name in brackets before the prompt (e.g., `[Agent Name] ❯`); the detector recognises this format (#746). When a Kiro session's token expires, the CLI falls back to a sign-in screen. AgEnD now detects that screen structurally (not just by keyword) and withdraws any auth-suspicion flag when a follow-up probe clears. Misidentifying this screen would suppress hang notifications and disable MCP auto-restart—**not** block deliveries—so the fix restores monitoring accuracy rather than unblocking a delivery path (#746, #747).

Codex could report a delivery as successful even when the message was never submitted. The root cause was a race between the input-row snapshot and the actual paste: the daemon saw text in the input area, assumed it had been sent, and returned success. The fix ties submission evidence to the specific paste and explicitly submits any stranded text instead of re-pasting. Additionally, deliveries are now held while the Codex update picker owns the pane, and a message still sitting in the input row is never confirmed as delivered (#745).

A startup timeout no longer abandons a session. Previously, if an instance took too long to start, the daemon would give up and create a fresh session, silently discarding the conversation history. Now the session is preserved and renamed so it can be recovered manually (#737).

Claude Code turns that end without a platform-acknowledged reply are now detected. When this happens, the daemon posts a neutral status message ("the agent did not reply; retrying once") and injects a one-shot recovery prompt asking the model to send its conclusion. If the recovery turn also fails to deliver a reply, the turn ends with an explicit "unrecovered reply drop" notice rather than silent loss. This addresses the root cause of issues #664, #662, and #649 (#750).

The `/model` command now re-probes a stale CLI environment so newly released models appear without requiring a cold start (#721). The `/update` command guarantees terminal progress delivery, fixing cases where the final status message was lost (#722). The usage panel no longer hangs when one provider is slow; each vendor's collection is bounded independently (#718).

Two notification bugs are fixed: fleet-wide notices now post to a channel instead of failing silently, and scheduled notices route to their source chat correctly (#732). The warmup reload notice no longer tells a resume-reloading backend to reload its instructions when it is already doing so (#727). The web terminal now hands out paths with a trailing slash so relative assets resolve correctly (#729). A flaky web-terminal integration test is stabilised (#742).

Cross-channel-world message routing is hardened. When a schedule fires and its reply coordinates belong to a different channel world—for example, a schedule created in a Telegram group targeting a Discord instance—those coordinates are no longer seeded as the target instance's reply context. Previously this caused the instance to send every subsequent channel reply to Discord using a Telegram chat id, producing continuous "Unknown Channel" errors for tens of minutes until a real user message overwrote the stale context. Additionally, the Discord adapter now returns an explicit error when it receives a chat id that clearly belongs to another platform (negative numbers indicating Telegram groups, or numbers too short to be Discord snowflakes), rather than the opaque `10003 Unknown Channel`. In multi-adapter setups where no world is specified, the system now reports a routing error instead of guessing the first available adapter (#752, #753).

The dashboard and `/view` sidebars now show the raw instance name as the primary label, with the display name (when different) as a secondary line below. Previously, the display name replaced the instance name entirely, which lost the stable identifier needed to correlate entries with fleet.yaml and logs. Both lines truncate independently, and the change is purely visual—sorting, click targets, and API payloads are unaffected (#774).

## [2.1.4] - 2026-09-07

### Upgrade Notes
- **fleet.yaml auto-slim is inheritance, not deletion** — fields stripped from instance configs now follow `defaults`. Changing a default later will change those instances too.
- **Owner-adapter fail-closed** — when the adapter that owns a topic goes down, that topic's inbound access is fail-closed (warn log). Previously, another adapter might have accepted the message.
- **`/login` Org SSO not yet supported** — the `/login` slash command is beta; organization SSO flows are a known limitation.

### Added
- **`/login` slash command** — re-authenticate a CLI backend from Telegram/Discord without SSH-ing to the host. Runs a pre-check first and asks for confirmation if the existing auth is still valid, so a working login is never thrown away by accident. After a successful login, instances that were running are restarted so they pick up the new credentials (#611, #613, #614, #617).
- **`/install-cli` slash command** — install a CLI backend on the host remotely, and wired into quickstart. Install commands corrected to the vendors' current ones: kiro-cli via the `curl` installer (was Homebrew) and codex via the official standalone installer (was npm) (#619–#621, #624).
- **`/clear` slash command** — wipe an instance's context. **Admin only, and it requires pressing a confirmation button first** — the destructive action never fires on the command alone (#529, #549).
- **`/steer` slash command + tool progress display** — `/steer <message>` interjects into a turn already running, and the working bubble can list the tools as they run. **`tool_progress` defaults to `off` (opt-in)** so an upgrade does not start broadcasting tool activity into channels; set `standard` for semantic labels or `verbose` to add command previews, from fleet.yaml or the web Settings dropdown (#560, #563, #577, #616).
- **`/btw` slash command** — ask a side question without interrupting the current task. **Claude Code only**; other backends decline explicitly instead of silently dropping the message (#584–#586).
- **`/tips` daily tips** — a 300-tip library (100 beginner / 100 intermediate / 100 advanced) delivered as occasional in-chat cards with Got it / Confused buttons. **Only beginner tips are shown by default.** Advanced tips unlock after 60 tips are dismissed, or immediately when an admin runs `/tips advanced on` — they are never shown unasked. Tips can be filtered by the backends actually in use (#587, #588, #590–#594, #599, #603, #605–#609, #622).
- **`list_models` MCP tool** — agents can enumerate the models a backend really offers instead of guessing. `scope` distinguishes an instance-accurate catalog from the account-wide one, which matters because an instance on a custom provider can offer a different set (#573).
- **Codex custom providers** — `backend_options.codex.provider` points one instance at an alternative provider, available from `create_instance` and documented in a General skill (#545, #552, #553).
- **Cross-backend skill publishing** — skills are published to all six backends in each one's native format, with role-based distribution (General / Worker / Classic) and an MCP payload kept under 2 KB (#554, #555, #557, #558).
- **fleet.yaml auto-slim** — saving strips instance fields that merely repeat a fleet default, plus a one-time migration. **This is inheritance, not deletion**: a stripped field now follows `defaults`, so changing a default later also changes those instances. Identity and routing fields (`working_directory`, `topic_id`, `channel_id`, …) are always kept explicit (#569).
- **Complete zh-TW interface** — 325 locale keys and a typed locale module; no user-facing string is hardcoded English any more (#595).
- **`agend install` activates the service itself** — no manual `systemctl` step after installing. `agend uninstall` now asks for confirmation before removing anything, and `agend doctor` reports system diagnostics (#570, #580).
- **`agend completion install`** — tab completion for bash and zsh (#537).
- **Interactive prompt handling** — when a CLI stops on a sudo/confirmation prompt, AgEnD posts Confirm/Cancel buttons and can ask General to assist, with the buttons nonce-protected and admin-gated (#530, #535).
- **CLI exit and update visibility** — a normally-exited CLI offers Restart/Ignore instead of going quiet, and `/update` shows live progress with elapsed time (#533, #534).
- **OpenCode session resume** — sessions resume properly via CLI JSON discovery with an idle checkpoint, replacing the `--continue` path that hijacked the global session and lost MCP and instructions (#525, #526, #543, #544).
- **Antigravity MCP wiring + persistent workspace** (#618).
- **Usage panel trimmed to what you use** — `/usage` and the web view hide backends this fleet has no login for (#579).
- **CI runs build and tests** — plus gitleaks scanning on push and an explicit permissions block (#524).

### Fixed
- **Expired logins reported honestly** — an expired session is detected as an auth problem instead of being misreported as a stopped MCP server, and no longer raises a "stuck instance" alert on every scan when only re-logging in can help. Codex's startup "Update available!" prompt is also prevented, so a fleet restart no longer leaves every Codex instance waiting on a keypress (#602, #614, #615).
- **Codex SQLite sidecars** — WAL/SHM/journal files are no longer symlinked away from their database, which could split one SQLite database across two homes; legacy links are healed on start (#564).
- **Pane state accuracy** — Kiro no longer reads a stale spinner in scrollback as "working"; Antigravity's cosmetic footer redraw no longer flapped instance state ~52k times a day; Claude Code's cancel button and bubble no longer vanish mid-turn on bare spinner frames; Codex's `›` idle prompt is recognised (#551, #572, #576, #601, #610).
- **Cancel button** — retired correctly after the first message following a restart, and cancelling now clears the pending delivery queue instead of leaving queued work to arrive later (#575, #584).
- **Tool progress history kept** — when a turn ends, the bubble keeps its tool list as a read-only record and only the button is removed; the retained message is labelled as history rather than still claiming to be in progress (#565, #566).
- **ClassicBot fixes** — adapter migration detects the ID domain and self-repairs, `set_display_name`/`set_description` write to the right store, and `update_instance_config` points at the correct tool for Classic instances (#550, #568, #598).
- **Media delivery** — images arrive from Discord reply references and forwarded messages, embed downloads no longer fire on plain URL auto-embeds, Telegram stickers are normalised, and a 📷 reaction is no longer injected as context (#532, #536, #588, #589).
- **Claude Code session resume** — project paths containing dots or underscores encode correctly, and a runtime `/model` switch survives a restart (#538, #539).
- **Schedules use the right persona** — a scheduled message posts as the correct Discord bot in a multi-bot setup (#582).
- **Health check resumes after background-session recovery** (#541).
- **Agent instruction fixes** — instructions now explain how to call `react` and `edit_message`, distinguish a CLI subagent from `create_instance`, and avoid AgEnD's delivery-status emoji. **Instruction changes take effect after a fleet restart**, not immediately (#559, #562, #626).
- **Documentation** — Telegram and Discord bot setup guides (EN + zh-TW), command/config gaps from the 2026-08-13 audit, corrected tool_set counts, de-identified screenshots, and Gemini deprecation labels (#523, #546, #547, #571, #574).
- **ClassicBot Yes/No buttons** — access requests now show inline Yes/No buttons for approval, replacing the text-only workflow (#690).
- **`/sysinfo` fleet summary** — shows instance counts (running/paused), fleet memory, and system memory. Platform-aware formatting: Telegram uses markdown tables, Discord uses plain lines. Summary split to multiple lines for mobile readability (#695, #696, #697).
- **`/install-cli` backend chooser** — bare `/install-cli` (no argument) now shows a backend selection menu instead of an error (#687).
- **Cross-instance steer** — `delegate_task` and `send_to_instance` can now use `steer: true` to inject a mid-turn supplement into a target instance's current turn (#701).
- **Antigravity survey and model discovery** — handles survey prompts and parses TSV model lists (#683).
- **`/sysinfo` resources section** — adds links to documentation, tips, and GitHub (#679).
- **Session management skills** — new General skill documents cross-backend session management and Kiro SQLite recovery (#684, #685).
- **Usage i18n** — AI usage displays are localized; zh-TW duration/binding/rate-limit polish (#665, #675).
- **Codex capacity detection** — detects and reports model capacity errors (#666).
- **Cross-instance message size cap** — oversized messages (>12KB default) are rejected with a clear error instead of being silently truncated (#671).

### Fixed (continued, beta.36–57)
- **ClassicBot allow-list comparison** — IDs are now compared as strings, fixing mismatches caused by JavaScript number precision loss on large Discord snowflakes. Unmatchable IDs are reported to the operator at startup (#691, #692).
- **Fleet error notification** — a fleet error that couldn't be delivered no longer silences the notification queue for ten minutes (#693).
- **tmux paste buffer flake** — test isolation for large pastes vs truncated ones (#694).
- **Discord code-fence split** — cross-instance previews and chunked sends no longer emit a dangling code fence (#698).
- **Classic cross-instance reply** — Classic instances can now reply to cross-instance work requests (#699).
- **Kiro delivery safety** — stops pasting into a busy-but-quiet Kiro pane, verifies submission, and recovers stranded text. The Enter-drop gate no longer has fail-open holes; blank/unreadable panes never prove readiness (#686, #688).
- **Kiro startup resilience** — multiple rounds of hardening: dispose rejected daemons, serialize outage hand-off, wake budget, delayed retries for unattended starts, 20-minute outage memory with positive clearing (#689).
- **tmux storm resilience** — coordinates recovery during tmux storms; preserved deliveries and window crash classification (#674).
- **Discord gateway self-heal** — detects stale gateways and triggers reconnect; preserves native resume recovery; exposes aggregate heartbeat health (#673, #676).
- **Tips button Telegram** — canonicalizes Telegram button context for proper routing (#682).
- **Usage display trim** — hides unused scoped limits from usage display (#681).
- **Kiro CLI version flags** — gates launch flags by CLI version; memoizes compatibility probe (#680).
- **MCP replacement recovery** — a CLI-replaced MCP server no longer restarts a healthy instance; re-checks the idle gate when replacement grace expires (#663, #668).
- **Network family timeout** — preserves longer network attempt overrides; fixed stale Telegram socket handling (#658, #659, #660).
- **CLI help consistency** — help output is now consistent and current (#661).
- **Claude Code trust/delivery hardening** — detects malformed tool-call fragments and attempts reply recovery; detects model fallback and shows live model from statusline in `/ctx`; hardens claude.json updates and detects corrupt-config modal; blocks delivery while parked on a fatal startup screen; tightens error patterns (#648, #650, #651, #652, #653, #654, #655, #656).
- **Codex update prompt** — prevents the "Update available!" prompt from blocking startup (#657).

### Fixed (continued, beta.60–63)
- **`agend health` paused classification** — paused instances are no longer misreported as "Tmux window missing / degraded". Paused status now has its own count in output (`N healthy, M issues, K stopped, P paused`) and does not degrade fleet health (#704).
- **Webhook delivery determinism** — webhooks are now picked up deterministically by the per-instance primary adapter, so multi-adapter setups no longer lose webhooks to the wrong adapter (#707).
- **Inbound access by owner adapter** — access checks are performed by the adapter that owns the topic (before claim). **When the owner adapter is down, that topic's inbound is fail-closed** (warn log emitted). Prevents messages being accepted by the wrong adapter (#710).
- **Claude resume dialog fail-safe** — the "Resume from summary" dialog is never delivered to during restart, preventing silent context loss from accidentally selecting resume (#711).
- **MCP liveness fix** — multiple MCP processes (Codex sub-agents, Claude subagents) no longer cause false "MCP died" reports due to single-slot PID tracking. IPC-layer reachability is now used; recovery clears the notification (#712).
- **`/login` and `/install-cli` beta label** — these commands are marked as beta in help and command menus (#713).

## [2.1.3] - 2026-08-07

### Added
- **tmux 3.7b compatibility** — removed `-r` (read-only) flag from control client, which conflicted with tmux 3.7's new read-only enforcement. Added adaptive paste settle for timing differences (#519, #521).
- **View UI overhaul** — CLI backend icons per instance; instance tooltips with i18n; `/usage` reordered Claude→Codex→Grok→Kiro→Antigravity (#511–513, #514).
- **MCP dead proxy reply** — when the MCP server is unreachable, the daemon can forward agent pane output as a response. **Opt-in only** (`mcp_proxy_reply: true`); default `false` because raw pane output may contain secrets. Cross-instance inbound never triggers this (#515–516).
- **tmux mouse scroll** — `agend attach` enables mouse mode; scroll up to read history (#508).
- **Discord forwarded images** — images from forwarded messages and embeds are now delivered. Fixed `discord.js` messageSnapshots API (no `.message` wrapper) (#505, #518).

### Fixed
- **Kiro Enter retry** — defensive Enter is re-sent on every delivery, not just the first (#504).
- **claude-code classic crash** — fixed crash when tmux window name collides with existing window (#503).
- **Codex session symlink** — migrates legacy session paths; co-located symlinks for CLI and daemon (#507).
- **ctx% > 100%** — parser now reads the real title bar instead of matching chat content (#509).
- **Bot @mention preserved** — `@BotName` kept as `@BotName (you)` in context (#510).
- **TG command menu** — command registration corrected (#517).

## [2.1.2] - 2026-08-06

### Added
- **`/usage` slash command** — check AI subscription usage directly from chat. Shows Claude, Codex, Kiro, Antigravity, and Grok quota in each platform's native rich format (progress bar). Same permission as `/ctx` (no admin gate).
- **`get_usage` MCP tool** — agents can query their own subscription usage. Also available as `agend-agent usage` for CLI-mode agents.
- **AI Usage Panel in `/view`** — 📊 button shows usage panel for all configured backends. Disable with `web.usage_panel: false`.
- **`/effort` slash command** — adjust AI reasoning effort at runtime (low/medium/high/xhigh/max). TG: inline keyboard. DC: select menu. Admin only. Supported across all 6 backends. Codex effort levels are per-model.
- **`get_effort` MCP tool** — query current effort level and strategy. `/status` shows effort column.
- **Reactions as context** — DC/TG reactions are stored in a database and included in the next turn's context, not forwarded as messages. Both directions (user→agent, bot→user). ~~`defaults.reactions_enabled` controls this.~~ **[correction, 2026-08-13]** No such toggle was ever implemented — `reactions_enabled` has zero references in source history; this feature is unconditionally on. Treat the original wording as a documentation error, not a removed feature.
- **Live progress line** — while an agent works, the delivery status message shows the running tool name and elapsed time. Configurable: `defaults.progress_min_elapsed` (seconds, default 30). Shows Kiro's running tool read directly from the pane.
- **Tab completion** — `agend attach <tab>` completes instance names (bash and zsh).
- **Fleet memory report** — `agend ls` footer shows fleet-wide memory total.
- **MCP auto-restart on idle** — when an MCP server dies, AgEnD waits for the instance to go idle then restarts it automatically (crash-loop guard + restart mutex).
- **Singleton fleet startup** — `fleet.lock` prevents duplicate fleet processes from starting.
- **Fleet event loop unblocked** — child processes (sdNotify, etc.) no longer block the main event loop. Watchdog ping is async.
- **Restart progress in General** — live progress of fleet startup: version, instance count, paused list.
- **Startup skips paused queue** — paused instances are excluded from startup launch queue (~50s faster on large fleets).
- **Interactive prompt detection** — detects stalled sudo/Y-N prompts and notifies General.

### Fixed
- **At-least-once message delivery** — cross-instance and scheduled messages retry up to 3 times; final failure is visible to the agent.
- **Cancel button lifecycle** — 4 safety nets (dead daemon, restart, silent reporter, 24h cap). Fixed: spinner, double-observe, post-before-delete ordering, restart mutex, grace retirement.
- **Reply dedup** — 60-second window prevents duplicate replies caused by rate-limit timeouts.
- **General coordinators always warm** — General and multi-channel generals cannot be auto-paused.
- **Delivery routing** — replies use the configured adapter; classic instances route through their bound adapter.
- **pane write serialisation** — all writes into a tmux pane are serialised to prevent interleaving.
- **SQLite hardened** — busy timeouts, corrupt-tolerant event log, bounded query history.
- **Fleet health honest** — `/health` returns 503 when any instance is degraded. `READY=1` is only sent after all generals are up.
- **Error isolation** — one instance's crash no longer takes down the fleet process. ClassicBot errors route to General.
- **Kiro login failure** — no longer misreported as a rate limit.
- **Dashboard token persistent** — `/dashboard` URLs remain valid after fleet restart.
- **agy busy pattern** — Antigravity now has a real busy pattern instead of always-true.
- **Grok/Claude/Codex pattern fixes** — idle detection for edge cases, model error detection, annual key reading.
- **Dead window cleanup** — stale tmux window registrations are retired automatically.
- **Startup dialog guard** — user messages are not pasted into startup dialogs.
- **Secret file mode warning** — warns when a credentials file cannot be made owner-only.

### Changed
- **Cross-instance delivery** — fire-and-queue (non-blocking) instead of awaiting delivery, reducing caller wait time.
- **`defaults.effort`** — new config field for default effort level.
- **`defaults.progress_min_elapsed`** — seconds before live progress shows (default 30).
- **`web.usage_panel`** — show/hide usage panel in `/view` (default `true`).

## [2.1.1] - 2026-07-29

### Added
- **AI usage panel on /view** — 📊 button opens a panel showing live subscription usage for the CLI backends logged in on this machine (Claude session/weekly %, Codex windows/credits, Grok weekly pool, Kiro monthly + bonus/gift credits and Amazon Q subscription). New `GET /api/ai-usage` endpoint (5-min cache); disable with `web.usage_panel: false`. Claude/Codex/Grok provider logic vendored from ai-usage-board/OpenUsage (MIT, see `src/usage/LICENSE.md`); Kiro provider is original research.
- **Kiro TUI effort skill** — general-knowledge skill for Kiro's effort selector in TUI mode.

### Fixed
- **SIGHUP startup window** — startup requests during SIGHUP reload are protected.
- **Reload reconcile safeguard** — aborts reconcile if N→0, empty config, or >50% instance drop detected.
- **Root user Codex PATH** — PATH fallback for Codex when running as root.

## [2.1.0] - 2026-07-27

### Added
- **`/model` slash command** — change backend model from chat. Admin-only. TG: inline keyboard menu. DC: select menu. Shows current model, gives instant feedback.
- **Startup CLI-env probe** — auto-discovers available models at startup and caches per-backend.
- **Auto-Pause/Wake** — idle instances pause after `auto_pause_after` minutes (opt-in, default: disabled). Messages auto-wake paused instances. `general` instance never pauses.
- **Tri-state execution state** — Idle/Working/Stuck shown in `agend ls`, MCP `list_instances`, `/api/fleet`.
- **Adapter startup isolation** — adapters launch in parallel with independent retry; one failing adapter no longer blocks others.
- **Event-driven pane monitor** — uses tmux control mode `%output` events instead of 5-second polling; near-zero idle CPU.
- **Adaptive startup concurrency** — reads `os.freemem()` at startup to limit parallel instance launches on low-RAM machines.
- **Warm cap (LRU evict)** — `warm_cap` config limits resident (warm) instances; excess idle instances auto-pause.
- **Grok Build backend** — full support for Google's Grok CLI: crash recovery, context %, quit key (Ctrl+Q), Web UI, MCP with ASCII-sanitized key.
- **`/model` MCP tools** — `update_instance_config`, `update_fleet_defaults` for runtime config updates.
- **Pause/wake MCP tools** — `pause_instance`, `wake_instance`, `stop_instance`, `get_fleet_status`, `get_instance_logs`, `get_fleet_config`.
- **Cross-instance idle gate** — outbound messages wait for target instance to be idle before delivery.
- **One-shot schedules** — `create_schedule({ at: "ISO-datetime", ... })` fires once and self-deletes.
- **Silent schedules** — `create_schedule({ silent: true, ... })` pastes directly to pane without channel post.
- **ClassicBot backend picker** — `/start` shows backend select menu with install status.
- **Settings page** — structured UI for fleet.yaml/classicBot.yaml with form↔YAML dual-pane sync.
- **Config validator** — `agend validate` CLI + `validate_config` MCP tool.
- **Shared logger** — single root pino transport + child loggers (saves hundreds of MB + threads).
- **Pause freeze monitors** — paused instances stop all timers/watchers (near-zero overhead).
- **Kiro per-instance UI mode** — `kiro_ui: legacy | tui | v3` in fleet.yaml.

### Fixed
- `auto_pause_after` defaults to 0 (opt-in, user must enable).
- `[C]` prefix removed from classic instance display names.
- Cross-instance `[from:]` header shows sender `display_name`.
- Classic instances appear in `agend ls`, `/status`, and Web View roster.
- Grok: ASCII-sanitize MCP server key (CJK key → 0 tools).
- Adapter binding race on restart.
- Kiro lambda prompt recognized as ready pattern.
- Stuck alerts gated on pending inbound work.
- `fleet.log` includes date stamp.
- Unicode instance names (Chinese ClassicBot channels).
- CLI reply uses persisted context after restart.
- agy: auto fresh-restart on unknown model key.
- Idle state invalidated when CLI pane dies.

### Changed
- **Grok Build** — removed experimental markers; now stable.
- **Shared logger** — replaces per-instance worker threads.

## [2.0.11] - 2026-07-08

### Added
- **`/dashboard` command** — admin-only, returns View/Settings/WebUI URLs. DC: ephemeral reply. TG: spoiler-wrapped token.
- **Settings Web Page (`/settings`)** — structured config editor with form ↔ YAML dual-pane sync, validate-before-write.
- **Config Validator** — `agend validate` CLI + `validate_config` MCP tool. Validates channels, instances, backends, access.
- **Web View enhancements** — sidebar drag-sort (SQLite), group by tag, `agend view` CLI, open GET access (no token needed).
- **Same-channel multi-bot ClassicBot** — composite key routing, owner-wins dedup, auto migration, restart rebind.
- **Quickstart persona bot** — "Add persona bot (Discord)" option with 7-step flow.
- **Multi-bot token adapter** — per-channel Discord bot identities.

### Fixed
- **DC general invalid topic_id** — skip + warn + unbind instead of crash loop.
- **Channel missing access field** — defaults to open instead of crash.
- **Avatar DB path** — stores filename (not absolute path); placeholder on missing avatar.
- **`/view` ctx%** — hide when 0 or null.
- **Auto-General** — only primary adapter creates/claims general.
- **React per-adapter** — `reactMessageStatus` uses instance-bound adapter.
- **Warmup false trigger** — skip on first run, defer when idle, add "do not reply".

## [2.0.10] - 2026-07-03

### Added
- **Quickstart auto-installs system service** — asks at end of quickstart, one-step setup.

### Fixed
- **Double fleet race condition** — restart no longer falls back to detached spawn when systemd service exists.
- **WSL Windows PATH filter** — systemd service `Environment=` filters Windows PATH entries.
- **`IS_SANDBOX=1` for root** — systemd service adds env var for claude-code v2.1+ compatibility.

### Changed
- **Remove CI GitHub Release step** — leader writes release notes manually.

## [2.0.9] - 2026-07-02

### Fixed
- **`/ctx` regex for Kiro CLI v3** — matches new λ prompt format (`26% λ !>`).

## [2.0.8] - 2026-07-02

### Added
- **Cancel button** — inline 🛑 button on every inbound message. Track-all design (per-button Map), cross-instance cancel via `correlation_id`, 5-minute idle backstop.
- **Delivery status UX** — 👀 received → ⏳ processing → ✅ done (or ❌ failed). Boolean delivery result with backoff.
- **Discord built-in** — Discord adapter merged into core; no separate plugin install needed.
- **`/save` for fleet topics** — kiro-cli uses `/chat save`, claude-code uses `/export`.
- **`/cancel` command** — slash command alternative to inline button (TG + DC).
- **Model pass-through** — unknown model names passed to CLI with warning instead of silently dropped.
- **Log rotation** — `fleet.log` + inbox rotated via copytruncate on daily timer.

### Fixed
- **`--continue` crash loop** — break loop when resume fails + stop single instance without killing fleet.
- **DC forum thread-aware** — editMessage, deleteMessage, and reactions find messages in forum-topic threads.
- **Health-check null retry** — re-confirms null pane status before declaring crash.
- **TG bare slash ignore** — bare `/` commands in Classic groups no longer trigger errors.
- **DC adapter error isolation** — Discord errors no longer crash the fleet process.
- **Classic collab image path** — surface saved image path as `image_path` on trigger.
- **Cancel button async race** — bounded delete retry, retire by correlation_id.

### Changed
- **Fleet stop performance** — faster stop for large instance counts.
- **`/ctx` scrollback** — robust tmux fallback for kiro-cli.

## [2.0.5] - 2026-06-24

### Added
- **`agend doctor mcp`** — fleet-wide MCP health check (IPC connectivity, config paths, duplicates, binary PATH).
- **TG Classic `/ctx`** — show context usage in classic mode.
- **`/start` notifications to General** — unauthorized DC guilds and TG private chat users trigger an alert to General.
- **Decision filtering** — instances only see fleet-scope + same-project decisions (not all fleet decisions).

### Fixed
- **TG Classic @mention broken by auto-collab** — auto-collab on `/start` now Discord-only; TG classic @mention works correctly again.
- **TG private chat reply 'thread not found'** — `thread_id` no longer incorrectly passed as `message_thread_id` in private chats.
- **`/compact` slash lost** — unified via IPC `raw_paste`; uses `tmux send-keys -l` (literal mode).
- **DC Fleet `/compact` blocked** — no longer incorrectly blocked by classic-only check.
- **Hang detector false positives reduced ~73%** — only flags when pending inbound message exists.
- **claude-code background session conflict** — auto-recovery with re-entry guard instead of crash loop (#79).
- **Crash loop error message** — now distinguishes from 'rate-limited' in notifications.
- **Chat-log timezone** — uses local timezone instead of UTC.
- **install.sh EEXIST** — cleanup error on suzuke→songsid package name upgrade.
- **Export includes classicBot.yaml** — previously missing from `agend export`.
- **Removed soul.md + CLAUDE.md from repo** — accidentally committed files removed.
- **MCP env decision filtering** — passes only filtered decisions, not all fleet decisions.

## [2.0.3] - 2026-06-21

### Added
- **Unified `/update`** — both TG and DC spawn `agend update` (detached); auto-detects beta version and uses `--beta` flag accordingly.
- **DC Fleet slash commands** — `/status`, `/sysinfo`, `/restart`, `/ctx`, `/compact`, `/collab` now available as Discord slash commands (parity with TG).
- **TG Fleet `/ctx` `/compact` `/collab`** — registered in forum bot menu; works in General topic and instance topics.
- **TG Classic `/compact`** — admin-only command to compact classic instance context.
- **TG Classic `/ctx`** — show context usage in classic mode.
- **Fleet `/collab`** — allow bot/webhook messages in fleet topics (TG + DC). Fleet open mode bypasses bot message filter.
- **DC auto-collab on `/start`** — Discord `/start` auto-enables collab mode for the new instance.
- **Instance warmup** — auto-trigger context loading (steering + skills) after spawn; waits for instance to reach idle before marking ready.
- **`agend ls` status indicators** — shows Idle/Busy/Crashed/Stopped per instance in real-time.
- **Fleet ready version** — show AgEnD version in "Fleet ready" startup notification.
- **🔒 Admin markers** — slash command descriptions use 🔒 prefix for admin-only commands.

### Fixed
- **Health port retry loop** — prevent infinite health check retry with re-entry guard flag (#44).
- **`/update` beta auto-detect** — correctly spawns `agend update --beta` when current version is a beta release.
- **DC `/collab` fleet topic permission** — fleet topic `/collab` now correctly requires `allowed_users` permission.
- **DC slash commands duplicate** — `compact` was registered twice causing all commands to fail silently; deduplicated.
- **`/status` performance** — removed serial tmux capture fallback (too slow with 48+ instances); now uses statusline.json only.
- **General topic `/ctx`** — TG General topic (threadId=undefined) now correctly routes to handleInstanceCommand.

## [2.0.2] - 2026-06-17

### Added
- **TG Rich Message receive** — grammy middleware intercepts Rich Message (Bot API 10.1), extracts text for bot-to-bot @mention communication.
- **Multi-channel auto-detect** — each adapter gets its own General instance; unbound generals adopted by topic_id match.
- **`channel_id` field** — explicit binding of General instances to specific adapters.
- **Quickstart live add platform** — add a second platform while fleet is running (systemd restart preferred, fallback detached spawn).
- **`agend stop/start` fallback** — works on machines without D-Bus/systemd (PID kill / direct fleet start).
- **`/sysinfo` version display** — shows AgEnD version in system info table.
- **`/status` context percentage** — tmux capture fallback matches `agend ls` behavior.
- **Multi-channel skill** — General knowledge for dual-platform setup guidance.
- **Memory best practice** — steering rules: Decision (short) → soul.md (full) → skill (on-demand).
- **Configuration & commands docs** — complete fleet.yaml/classicBot.yaml reference + all slash commands.
- **Reply tool instruction** — all instances know to output "." after reply tool to avoid kiro-cli error.

### Fixed
- **TG ClassicBot chat-log** — non-@mention messages now correctly recorded (was empty due to text clearing).
- **TG ClassicBot bot reply logging** — agent outbound replies written to chat-log.
- **TG ClassicBot error notifications** — classic instances receive error alerts via routing table fallback.
- **Bot-to-bot @mention (TG)** — isBotMessage filter allows bot messages with @ourBot mention; Rich Message text extraction.
- **Duplicate general on add platform** — adopt unbound generals instead of creating duplicates.
- **`/restart` admin check** — mode:open no longer allows unauthorized users to restart fleet.
- **Discord `general_channel_id` required** — quickstart loops until provided (prevents broken routing).
- **Unclosed code fences** — stripped before CLI paste to prevent input hang.
- **TG `/chat` removed from menu** — not implemented for TG classic, use @mention instead.

### Changed
- **grammy 1.44.0** — upgraded for Bot API 10.1 support.
- **`assignTopicIds`** — uses `channel_id` → channels config type for platform detection (not name heuristic).

## [2.0.1] - 2026-06-15

### Added
- **Telegram Rich Messages** — grammy 1.44.0, auto-detects markdown tables/code blocks/headings → sendRichMessage with fallback.
- **`/update` + `/doctor` commands** — available in both TG and Discord (admin only). /doctor runs backend diagnostics.
- **systemd watchdog** — Type=notify, WatchdogSec=60, sd_notify via systemd-notify command.
- **Non-blocking startup** — generals start first → READY=1 → remaining instances in background.
- **Daily update check** — fleet daemon checks npm for new versions every 24h, notifies General.
- **Admin reject notification** — non-admin /start or /stop triggers notification to General with user info.
- **Workspace path guard** — create_instance rejects dangerous paths (`.`, `~`, `/`).
- **npm link auto-detect** — `agend update` detects and removes stale npm link before install.
- **install.sh link removal** — readlink fallback to detect npm-linked old versions.
- **Slash command prefixes** — [Fleet] / [ClassicBot] in TG+DC command descriptions.
- **kiro-cli error detection** — "having trouble responding" triggers rate_limit notification.
- **`/status` + `/sysinfo` rich tables** — markdown table output for TG Rich Message rendering.

### Fixed
- **systemd startup kill** — NotifyAccess=all + TimeoutStartSec=0 for 50+ instance fleets.
- **Classic group unbound message** — no longer shows "not bound to an instance" in classic groups.
- **`agend update` message** — says `agend start` instead of `agend fleet start`.
- **Collab empty log** — skip empty bot messages in collab chat log.
- **`/doctor` command path** — uses `agend backend doctor` with fleet default backend.

### Changed
- **Versioning** — jumped from v0.0.23 to v2.0.0. New versioning starts from v2.x.
- **PR flow** — all changes go through feature branch → PR → merge. Branch protection on main.
- **CI auto GitHub Release** — stable tags auto-create GitHub Release with generated notes.

## [2.0.0] - 2026-06-15

Same content as v0.0.23. Version bump to establish new major version baseline.

## [0.0.23] - 2026-06-12

### Added
- **Permissions matrix** — `docs/permissions.md` documents all commands × platforms × access levels.

### Fixed
- **TG classic `botUsername` never set on primary adapter** — `isBotMentioned` was always false. Now correctly sets `world.botUsername` in the `started` event handler and registers listeners before `adapter.start()`.
- **TG `/start@other_bot` triggers all bots** — commands with `@suffix` targeting another bot are now ignored entirely.
- **TG `/start` `/stop` `/raw` admin lock** — group-mode `/start` and `/stop` now require `admin_users`. `@bot /raw` also requires admin.
- **`allowed_guilds: {}` (non-array) breaks access** — non-array values are now treated as "allow all" instead of rejecting everything.

## [0.0.22] - 2026-06-12

### Fixed
- **Classic instance proactive reply** — daemon no longer blocks `reply` tool when no prior inbound message exists. Fleet-manager's classicBot channelId fallback now correctly routes outbound messages.

## [0.0.21] - 2026-06-12

### Added
- **Mention rules in fleet instructions** — all instances now know how to `<@USER_ID>` mention Discord users/bots and `@username` for Telegram. Extracted from `id:` field in inbound messages.

## [0.0.20] - 2026-06-12

### Added
- **User ID in inbound messages** — format now includes `id:USER_ID` for mention support. Agents can `<@ID>` to mention Discord users or use Telegram mention syntax.

### Fixed
- **Classic instance reply fallback** — classic channel agents can now reply even after fleet restart. Falls back to `classicBot.yaml` channelId when `topic_id` is unavailable.

## [0.0.19] - 2026-06-11

### Fixed
- **agy model discovery skill** — clarify that effort suffix (Medium/High/Low/Thinking) is not part of the model name.

## [0.0.18] - 2026-06-11

### Added
- **Model compatibility check** — `defaults.model` only applies to backends that recognize the model name pattern. Incompatible models are silently skipped (e.g. `claude-opus-4.6` won't be passed to Codex).

## [0.0.17] - 2026-06-11

### Added
- **Antigravity CLI backend** — full support for Google's `agy` CLI. Uses CLI mode by default (no MCP). Non-hidden workspace at `~/agend-workspaces/`, instructions in `.agents/agents.md`, trust prompt auto-dismiss.
- **IPC + adapter auto-reconnect** — IPC disconnect retries with exponential backoff then every 60s indefinitely. Adapter fatal errors (Telegram polling init, Discord gateway) also auto-restart with same strategy. Dead tmux panes are auto-respawned.
- **Beta update channel** — `agend update --beta` installs from `@beta` npm dist-tag. CI publishes with `--tag beta` when git tag contains `-beta`.
- **PSS memory reporting** — `agend ls` uses Proportional Set Size from `/proc/<pid>/smaps_rollup` instead of RSS to avoid shared page double-counting.
- **Parallel instance stop** — shutdown uses concurrency 5 for faster fleet stop. Systemd timeout extended accordingly.
- **Configurable context_lines** — per-channel chat log injection depth in classicBot.yaml. Set 0 to disable.
- **Model support in classicBot.yaml** — per-channel model override.
- **Access mode "open"** — allows all users without an allowlist.
- **Fleet memory total** — `agend ls` footer shows instance count and total memory.
- **`agend update` command** — full lifecycle: sudo/nvm detection, npm install, service restart, health check.
- **GitHub Actions CI/CD** — ci, publish, and gitleaks workflows.
- **Workspace git init** — auto-created workspaces get `git init` for CLI backend project root detection.
- **`/agent` endpoint auth bypass** — POST /agent uses instance-level token, skips web UI token check.
- **agy `--model` flag** — pass model selection to antigravity CLI.
- **General-knowledge refactor** — split into `steering/` (always loaded core rules) + `skills/` (on-demand with YAML frontmatter). Reduces General's default context usage.
- **Dynamic model discovery** — skills teach General to run CLI commands (`agy models`, `/model`) instead of hard-coded model lists.

### Fixed
- Install script: auto-detect sudo, nvm-aware PATH, build-essential for native modules, /usr/local/bin symlinks only as root.
- Discord: stickers no longer treated as photo attachments; collab mode chat log includes attachment filenames.
- Daemon: unified log rotation; stale context rotation references removed from prompts.
- Update: kill old fleet process before restart; run daemon-reload before systemctl restart.
- Discord react: use `threadId` instead of `chatId` (guild ID) for 👀, ⏳, ✅ reactions.
- `agend update` restart: add `reset-failed` before `systemctl start` to handle post-kill failed state.
- Cross-instance silence: allow agents to stay silent when they have nothing to add.
- Default `context_lines` reduced from 10 to 5.

### Performance
- Parallel instance stop with concurrency 5.
- Staggered restart notifications.
- Discord `react()` uses single REST PUT instead of 3 sequential API calls (fetchChannel → fetchMessage → react). ~1s → ~300ms.
- 👀 auto-react moved before `setTopicIcon`/`archive`/`processAttachments` for instant feedback.

### Deprecated
- **gemini-cli** — sunset 2026-06-18. Warning shown on fleet start.

## [1.24.0] - 2026-04-21

### Added
- **Discord quickstart UX** — plugin check, channel selection, options output.

### Fixed
- Health check stops when instance directory is removed externally.
- NaN crash on non-numeric input; plugin check uses `npm list -g`.

## [1.23.0] - 2026-04-20

Phase 1–4 of the security/reliability fix plan (`docs/fix-plan.md`) closes here. 36 individual fixes/refactors across 7 PRs (#33, #38, #39, #40, #41, #42, #43, #44).

### Security
- **Phase 1 boundaries** (PR #33) — per-instance `/agent` token, zod validation on all `/ui/*` mutations, template var sanitization, tar entry validation, symlink resolution for `project_roots`, branch/logPath argument injection hardening, `web.token` 0o600.
- **Telegram apiRoot allowlist** (P3.3, `9a7b16b`) — prevents bot-token exfil via attacker-controlled `apiRoot`.
- **Webhook HMAC-SHA256 signing** (P3.1, `e65b97c`) — outbound webhooks now signed; receivers can verify origin.
- **STT requires explicit opt-in** (P3.4, `1fc513e`) — voice transcription no longer activates from env var alone; needs `stt.enabled: true` in `fleet.yaml`.
- **`/update` hardened** (P3.6, `740c202`, `d38a583`) — empty `allowed_users` rejects `/update` entirely; two-step token confirm (8 hex, 60s TTL); version pin during install; auto-rollback on health check fail; supersede notifications.
- **`access-path` rejects path traversal in instance names** (P4.3, `d5d41b7`) — whitelist `^[A-Za-z0-9._-]+$`, rejects `..` / `/` / `\` / NUL.
- **`.env` file mode 0o600** (P4.4, `49a4328`) — wizard writes credential files with restrictive permissions + chmod fallback.
- **CORS tightened, Bearer auth supported** (P3.5, `b180232`) — wildcard CORS removed; web API accepts `Authorization: Bearer <token>` header.
- **`paths.ts` md5 → sha256** (P4.5, `1f91c3c`) — eliminates FIPS / scanner alerts. Custom `AGEND_HOME` users will see tmux session/socket suffix change once on upgrade.

### Fixed
- **Telegram 409 polling cap** (P3.2, `c67f776`) — caps retries to 30 to prevent infinite poll loops.
- **Topic archiver persistence** (P2.6, `f134a66`, `42d5d1f`) — archived topic state now persists across restarts via atomic write of `<dataDir>/archived-topics.json`.
- **IPC single-line buffer cap 10MB → 1MB** (P3.7, `d446384`) — overflow rejected with structured error instead of OOM.
- **Tmux pane cache invalidation on control-mode reconnect** (P2.1, `e967bbb`).
- **TranscriptMonitor reentry guard** (P2.4, `65be144`) — prevents overlapping `pollIncrement` runs.
- **Scheduler catch-up for missed runs within 24h** (P2.3, `01e1e32`, `24d6f8a`).
- **Cost-guard daily-cap reset on session rotation** (P2.2, `875a0b2`) — `warnEmitted`/`limitEmitted` flags now reset properly so post-rotation sessions don't silently exceed daily cap.
- **SSE dead client eviction + socket error handling** (P2.5, `ae2a810`) — `broadcastSseEvent` no longer breaks the loop on a dead client write; `req.on("error")` now cleans up client set on ECONNRESET.
- **Drop redundant sleep+reconnect after instance start** (P2.7, `872547b`) — `startInstance` await chain already guarantees IPC ready; secondary `connectIpcToInstance` was pure dead code.
- **Cost-guard DST handling** (P2.8, `3c9ff9f`) — `msUntilMidnight` now uses `Intl.DateTimeFormat` + binary search instead of `setHours(24,0,0,0)`, so DST spring/fall transitions don't shift the daily reset by ±1h.
- **MessageQueue flood-control backoff reset** (P3.8, `3474c04`) — backoff now actually resets after status_update drop instead of staying at ~30s.

### Changed
- **`fleet-manager.ts` decomposed** (P4.1, PR #43) — 2842 → 1658 lines (-1184). Four new modules:
  - `fleet-dashboard-html.ts` (442 lines) — dashboard HTML constant
  - `fleet-instructions.ts` (168 lines) — `GENERAL_INSTRUCTIONS` + `ensureGeneralInstructions`
  - `fleet-rpc-handlers.ts` (387 lines) — IPC + HTTP CRUD dispatch
  - `fleet-health-server.ts` (326 lines) — `startHealthServer` + `getUiStatus` + `extractWebToken`

  All modules use a Context-injection pattern: each declares a narrow `XxxContext` interface, FleetManager `implements` it, and exported functions take `this` as their first arg.
- **`daemon.handleToolCall` factored** (P4.2, `e6a9596`) — extracted `dispatchFleetRpc(fleetReqId, broadcast, timeoutMs, timeoutMessage, respond)` helper. `handleToolCall` 182 → ~120 lines, daemon.ts -51 lines net.
- **`validateTimezone` unified** (P4.4, `49a4328`) — `scheduler/scheduler.ts` no longer duplicates the validator; imports the canonical version from `config.ts`.

### Docs
- **`docs/fix-plan.md` Phase 1–4 closed** — all P-items either ✅ or moved to **Deferred / Future Work** (logger rotation, cost-guard tiebreaker — both feature-class, not fix-class).
- **`docs/p4.1-split-plan.md` archived** — record of the four-module decomposition strategy.
- **`docs/issue-evaluations.md` added** — analysis of open issues #24 (usage-limit notify) and #8 (default topic preset) with effort/tradeoff breakdowns for future planning.

## [1.22.1] - 2026-04-19

### Fixed
- **Discord attachment download** — `downloadAttachment()` now actually works. Attachments are fetched from the Discord CDN and written to `inboxDir` during `messageCreate` (before the CDN URL expires), and `downloadAttachment()` returns the local path. Also: image attachments are classified as `photo` (enables auto-download on the agent side), filenames are prefixed with the Discord attachment ID to prevent collisions, downloads run in parallel across a message's attachments, failures are logged instead of silently swallowed, and `stop()` cleans up any undrained files. Closes #27.

## [1.22.0] - 2026-04-18

### Added
- **`agend ls` shows Kiro CLI context usage** — for instances running Kiro backend, the listing now reports current context window consumption alongside the other status columns.
- **`agend ls` shows system memory usage** — top-of-listing summary includes host memory pressure so fleet operators can spot memory-starved boxes at a glance.
- **Install script WSL detection** — `install.sh` now detects WSL and avoids picking up a Windows-side `node` on the Linux PATH, which previously caused silent failures during first-run setup.

### Changed
- **Install script URL uses GitHub Pages** — README one-liner points at `https://suzuke.github.io/AgEnD/install.sh` (the official hosted copy) instead of a raw GitHub URL.

### Docs
- **Install one-liner surfaced in both READMEs and the website hero** — previously only documented in the CHANGELOG.
- **WSL installation notes added to README**.
- **Website zh-TW hero tightened** — dropped shipping-speak (`交付`) in favor of dispatcher vocabulary consistent with the rest of the page.

## [1.21.7] - 2026-04-17

### Changed
- **MCP tool schemas unified on zod** — every outbound tool now has a zod schema in `src/outbound-schemas.ts`; `src/channel/mcp-tools.ts` derives `inputSchema` via `z.toJSONSchema()`. Hand-written JSON Schema removed. Required fields now reject empty strings (`minLength: 1`) where the old handlers relied on truthy checks.
- **Outbound handlers validate at entry** — all 18 handlers in `src/outbound-handlers.ts` run `safeParse` before doing work; the ~35 unchecked `args.X as string` casts are gone. `wrapAsSend` also takes a schema, so `request_information` / `delegate_task` / `report_result` get the same guarantees.

## [1.21.6] - 2026-04-17

### Security
- **Web API surface hardening** (H1, H2, H7)
- **Auth, path safety, and leak fixes** across the daemon (H3, H4, H5, H6)
- **Backend command hardening** — model name validation and env value quoting in `buildCommand()`
- **CLI helpers** — avoid shell invocation and redact tokens from `ps` output
- **Scheduler hardening** — timezone whitelist, file count cap, lightweight mode guard
- **Kiro MCP wrapper permissions** — `wrapper.sh` tightened to `0o700` (owner-only)
- **Outbound error sanitization** — tool errors returned to agents strip `$HOME` paths and truncate at 300 chars before exposure

### Fixed
- **Discord expired interaction crash** — adapter now catches expired-interaction errors to prevent daemon crash (upstream PR #26)
- **Scheduler overlapping fires** — atomic update prevents double-firing when two ticks race

### Changed
- **Fleet-manager error observability** — previously swallowed errors are now logged; adapter notices promoted to higher severity

## [1.21.5] - 2026-04-15

### Added
- **Error state warning on `send_to_instance`** — when the target instance is rate-limited, paused, or in crash loop, the sender receives a warning in the tool response (#24)
- **Codex weekly limit detection** — detects "less than N% of your weekly limit" warning and notifies via Telegram (action: notify)

### Fixed
- **MCP server orphan detection via ppid polling** — primary orphan detection now uses `process.ppid` polling (5s interval) instead of stdin EOF, which fails on macOS due to a libuv/kqueue bug that causes CPU spin instead of emitting `'end'`
- **Fleet-level tmux server circuit breaker** — 2+ tmux server crashes in 5 minutes pauses all instance respawns for 30s, preventing thundering herd
- **Process tree kill on spawn failure** — `killProcessTree()` sends SIGTERM to the entire process group (CLI + MCP server) before killing the tmux window
- **Sliding window crash detection** — replaced `rapidCrashCount` (broken by backoff delays > 60s) with `crashTimestamps` sliding window: 3+ crashes in 5 minutes triggers pause

## [1.21.4] - 2026-04-14

### Fixed
- **MCP server orphan cleanup on crash respawn** — daemon reads `channel.mcp.pid` and kills orphan MCP server before spawning new CLI
- **stdin EOF detection for MCP server** — added `process.stdin.on('end'/'close'/'error')` listeners and PID file mechanism (later superseded by ppid polling in v1.21.5)

## [1.21.3] - 2026-04-14

### Fixed
- E2E: mock CLI crash should exit with code 1, not 0

## [1.21.2] - 2026-04-13

### Fixed
- **Delay writing prev-instructions until session established** — prevents change detection from failing on retry when first spawn attempt fails
- E2E: update workflow-template test assertions for new heading behavior

## [1.21.1] - 2026-04-13

### Fixed
- **Kiro CLI 2.0.0 support** — updated ready pattern and startup dialogs for new TUI; fixed false "not found" match

## [1.21.0] - 2026-04-13

### Added
- **CLI mode** — `agent_mode: cli` config switches from MCP tools to HTTP-based agent CLI endpoint
- **Agent CLI endpoint** — HTTP-based alternative to MCP tools for backends that don't support MCP well
- **Idle task nudge** — automatically nudges idle instances with pending tasks from the task board

### Fixed
- Kiro: auto-dismiss trust-all-tools TUI confirmation on startup
- OpenCode: don't add `--continue` when skipResume is true

## [1.20.4] - 2026-04-12

### Added
- **Auto-dismiss interactive prompts** — backend-defined startup and runtime dialogs are automatically dismissed (trust folders, resume pickers, rate limit model switches)
- **systemPrompt file: paths** — supports comma-separated `file:` paths and YAML arrays for multi-file prompt modularization

### Fixed
- Claude Code: add session resume prompt to startup dialogs
- Instructions: avoid empty Development Workflow heading when workflow content has its own headers
- Handle EADDRINUSE on health server — kill old process and retry
- Discord onboarding: 10 UX pain points fixed
- Kiro: use single-quoted env exports in MCP wrapper to prevent backtick/dollar interpretation

## [1.20.2] - 2026-04-11

### Added
- **`agend health`** — fleet health diagnostics via HTTP endpoint (`/health`, `/status`)
- **Communication efficiency rules** in workflow template — structured task flow, silence = agreement, batch points

### Fixed
- OpenCode skipResume not honored + restart notification mismatch
- Safe worktree cleanup when directory is not a valid git worktree

### Changed
- Communication protocol refactored — reduce ack spam with structured task flow

## [1.20.0] - 2026-04-10

### Added
- **`replace_instance` tool** — atomically replace an instance with a fresh one, collecting handover context from the daemon's ring buffer
- **ContextGuardian simplified** — removed max_age timer, state machine, and all restart triggers. Pure monitoring only.

### Fixed
- Skip snapshot injection when `--resume` succeeds on crash recovery
- Clean stale MCP entries on instance removal + writeConfig

## [1.19.1] - 2026-04-10

### Fixed
- **3 UX pain points** — instructions reload on restart, config reload on single instance restart, Web UI create instance missing fields

## [1.19.0] - 2026-04-09

### Added
- **Fleet templates** — `deploy_template` / `teardown_deployment` / `list_deployments` for reusable fleet configurations
- **Configurable staggered startup** — `startup.concurrency` and `startup.stagger_delay_ms` in fleet.yaml defaults
- **Backend column** in fleet status and MCP `list_instances`

### Changed
- `agend logs` consolidated — reads fleet.log directly
- `agend fleet status` and `agend ls` merged into single command

### Fixed
- Clean up orphaned tmux windows on fleet startup
- Prevent quit command race condition during fleet stopAll

## [1.18.0] - 2026-04-08

### Added
- **Unified additive system prompt injection** — all 5 backends now use `--append-system-prompt-file` (Claude Code), steering files (Kiro), or equivalent. Fleet instructions no longer override built-in prompts.

### Fixed
- Always kill tmux window on instance stop/delete
- OpenCode uses "instructions" not "contextPaths" in opencode.json

## [1.17.5] - 2026-04-08

### Added
- **Crash output capture** — captures tmux pane content on crash for diagnostics
- **tmux server crash detection** — distinguishes server-level crash from single window crash

### Fixed
- Kiro MCP env isolation — wrapper script approach replaces process.env pollution
- Kiro MCP transport handshake failure — stdin race condition
- Graceful shutdown via quit command before killing tmux window
- Distinguish normal exit (code 0) vs crash by exit code in health check
- Pre-trust codex workspace + add trust dialog pattern
- Fleet start `--instance` delegates to running daemon via HTTP API

## [1.17.3] - 2026-04-07

### Added
- **Per-instance memory usage** in `agend ls`
- **Channel-aware replies** — pass source in inbound meta + fix format passthrough

### Fixed
- Codex MCP shell escaping + stale snapshot injection on restart

## [1.17.1] - 2026-04-07

### Added
- **tmux socket isolation** for custom AGEND_HOME — prevents conflicts between multiple AgEnD installations

## [1.17.0] - 2026-04-07

### Added
- **`AGEND_HOME` env var** — configurable data directory (default: `~/.agend`)

### Fixed
- Kiro CLI crash loop on restart — skipResume + tmux cleanup

## [1.16.2] - 2026-04-07

### Fixed
- Crash respawn orphan cleanup must not block spawnClaudeWindow

## [1.16.1] - 2026-04-07

### Fixed
- Prevent tmux server death during concurrent context rotation
- P2 code review improvements

## [1.16.0] - 2026-04-07

### Fixed
- P0+P1 code review findings (security, error handling, edge cases)

## [1.15.8] - 2026-04-06

### Fixed
- Codex uses `resume --last` (per-CWD scoped, no SQLite dependency)

## [1.15.6] - 2026-04-06

### Fixed
- Kiro resume uses boolean `--resume` flag

## [1.15.5] - 2026-04-06

### Fixed
- Error monitor scans only after last prompt marker (reduces false positives)

## [1.15.3] - 2026-04-06

### Fixed
- stop() cleanup + IPC reconnect on restart (#14, #12)

## [1.15.1] - 2026-04-06

### Added
- **Auto-inject active decisions** into MCP instructions via env var
- `/update` topic command for refreshing instance configuration

## [1.15.0] - 2026-04-06

### Added
- Webhook notifications for fleet events (rotation, hang, cost alerts)
- HTTP health endpoint (`/health`, `/status`) for external monitoring
- Structured handover template with validation and retry on context rotation
- Permission relay UX improvements (timeout countdown, "Always Allow" persistence, post-decision feedback)
- Topic icon auto-update (running/stopped) + idle archive
- Filter out Telegram service messages (topic rename, pin, etc.) to save tokens

### Changed
- **Crash recovery tries --resume first** — on crash respawn, attempts `--resume` to restore full conversation history before falling back to fresh session + snapshot injection

### Fixed
- Minimal `claude-settings.json` — only AgEnD MCP tools in allow list, no longer overrides user's global permission settings

## [1.14.0] - 2026-04-07

### Added
- **Plugin system + Discord adapter extraction** — Discord adapter moved to standalone `agend-plugin-discord` package; factory.ts supports `agend-plugin-{type}` / `agend-adapter-{type}` / bare name conventions; main package exports (`/channel`, `/types`) enable third-party plugins
- **Web UI Phase 2: full control dashboard** — instance stop/start/restart/delete with name confirmation, create instance form (directory optional, backend auto-detect), task board CRUD, schedule management, team management, fleet config editor (form-based with sensitive field masking)
- **Web UI layout: Fleet vs Instance** — sidebar "Fleet" entry for fleet-level tabs (Tasks, Schedules, Teams, Config); instance tabs limited to Chat + Detail; cross-navigation links between fleet and instance views
- **Web UI UX improvements** — toast notifications, loading states, cron human-readable descriptions, larger status dots, empty state guidance, cost labels, website-consistent styling (#2AABEE accent, Inter + JetBrains Mono fonts)
- **Backend auto-detection** — `GET /ui/backends` scans PATH for installed CLIs; Create Instance dropdown shows installed/not-installed status
- **Instance-specific restart** — `agend fleet restart <instance>` via fleet HTTP API (`POST /restart/:name`)
- **Bootstrap install script** — `curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash`
- **project_roots enforcement** — `create_instance` rejects directories outside configured roots

### Fixed
- **Web UI reply context** — first web message no longer causes "No active chat context"; uses real Telegram group_id/topic_id
- **Web↔Telegram bidirectional sync** — web messages forwarded to Telegram with `🌐` prefix; Telegram messages pushed to Web UI via SSE
- **SSE instant status refresh** — action buttons update immediately after stop/start/restart/delete
- **.env override** — `.env` file values unconditionally override inherited shell environment variables
- **tmux duplicate session race** — `ensureSession()` handles concurrent parallel startup
- **Create Instance form** — directory optional with dynamic topic_name requirement

### Changed
- **discord.js removed from core dependencies** — only needed when `agend-plugin-discord` is installed
- **Web API extracted to `web-api.ts`** — reduces fleet-manager.ts size; all `/ui/*` routes in dedicated module
- **Auth unified** — all Web UI endpoints (including restart) require token authentication

## [1.13.0] - 2026-04-06

### Added
- **Web UI Phase 2: full control dashboard** — create/delete instances, task board CRUD (create, claim, complete), schedule management (create, delete), team management (create with member checkboxes, delete), fleet config viewer (read-only, sanitized)
- **Web UI styling** — aligned with website design: Telegram blue `#2AABEE` accent, Inter + JetBrains Mono fonts, dark theme, rounded cards, toast notifications, loading states
- **Bootstrap install script** — `curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash` for one-line setup (Node.js via nvm, tmux, agend, backend detection)
- **project_roots enforcement** — `create_instance` rejects directories outside configured `project_roots` boundary
- **Auth unification** — all Web UI endpoints (including restart) require token authentication

### Fixed
- **Web UI reply context** — first message from Web UI no longer causes "No active chat context" error; uses real Telegram group_id/topic_id
- **Instant status refresh** — instance action buttons update immediately after stop/start/restart/delete via SSE
- **Web↔Telegram bidirectional sync** — web messages forwarded to Telegram topic with `🌐` prefix; Telegram messages pushed to Web UI via SSE

### Documentation
- Full documentation audit: 20+ missing features added across all docs
- Website redesigned with Spectra-inspired dark-first design

## [1.12.0] - 2026-04-06

### Added
- **Web UI dashboard** — `agend web` launches browser-based fleet monitoring with live SSE updates and integrated chat UI with bidirectional Telegram sync
- **agend quickstart** — simplified 4-question setup wizard replacing `agend init` as the recommended onboarding path
- **project_roots enforcement** — `create_instance` validates working directory is under configured `project_roots` boundary
- **HTML Chat Export** — `agend export-chat` exports fleet activity as self-contained HTML with date filtering (`--from`, `--to`)
- **Mirror Topic** — `mirror_topic_id` config for observing cross-instance communication in a dedicated topic

### Fixed
- **Parallel startup** — handle tmux duplicate session race when spawning many instances simultaneously
- **.env priority override** — `.env` file values now properly override inherited shell environment variables
- **Web UI chat sync** — bidirectional message sync between Web UI and Telegram

### Documentation
- README revamped with hero section, feature highlights, architecture diagram, and "How it works" flow
- Quick Start updated to use `agend quickstart` command
- Full documentation audit: features.md, cli.md, configuration.md updated with all v1.11.0-v1.12.0 features

## [1.11.0] - 2026-04-05

### Added
- **Kiro CLI backend** — new backend for AWS Kiro CLI (`backend: kiro-cli`). Session resume, MCP config, error patterns, models: auto, claude-sonnet-4.5, claude-haiku-4.5, deepseek-3.2, and more
- **Built-in workflow template** — fleet collaboration workflow auto-injected via MCP instructions. Configurable via `workflow` field in fleet.yaml (`"builtin"`, `"file:path"`, or `false`)
- **Workflow split: coordinator vs executor** — General instance gets full coordinator playbook (Choosing Collaborators, Task Sizing, Delegation Principles, Goal & Decision Management). Other instances get slimmed executor workflow (Communication Rules, Progress Tracking, Context Protection)
- **`create_instance` systemPrompt parameter** — agents can pass custom system prompts when creating instances (inline text only)
- **Fleet ready Telegram notifications** — `startAll` and `restartInstances` send "Fleet ready. N/M instances running." to General topic with failed instance reporting
- **E2E test framework** — 79+ tests running exclusively in Tart VMs. Mock backend with `pty_output` directive for error simulation. T15 workflow template tests, T16 failover cooldown tests
- **Token overhead measurement** — test script (`scripts/measure-token-overhead.sh`) and report. Full profile: +887 tokens (0.44% of 200K context, $0.003/msg)
- **Codex usage limit detection** — "You've hit your usage limit" error pattern (action: pause)
- **MockBackend error patterns** — `MOCK_RATE_LIMIT` and `MOCK_AUTH_ERROR` for E2E testing

### Fixed
- **Crash recovery snapshot restore** — write snapshot on crash detection (not just context rotation); replace single-consume file deletion with in-memory `snapshotConsumed` flag so file persists for daemon restart recovery (#11 related)
- **Codex session resume** — `CodexBackend.buildCommand()` now uses `codex resume <session-id>` when session-id file exists (#11)
- **Rate limit failover loop** — 5-minute cooldown on failover-type PTY errors prevents repeated triggering when error text persists in terminal buffer (#10)
- **PTY error monitor hash dedup** — record pane hash at recovery time; suppress same error on same screen to prevent stale re-detection loops
- **CLI restart wait** — replace fixed 1s delay between bootout/bootstrap with dynamic polling (up to 30s) for process exit. Fixes "Bootstrap failed: Input/output error" with many instances
- **CLI attach interactive selection** — fuzzy match ambiguity now shows numbered menu instead of error
- **CLI logs ANSI cleanup** — enhanced `stripAnsi()` handles cursor movement, DEC private modes, carriage returns, and remaining control characters
- **`reply_to_text` in agent messages** — user reply-to context now included in formatted messages pasted to agent
- **General instructions per-backend** — auto-create writes correct file based on `fleet.defaults.backend` (CLAUDE.md, AGENTS.md, GEMINI.md, .kiro/steering/project.md)
- **General instructions on every start** — `ensureGeneralInstructions()` called on every `startInstance` for general_topic instances, not just auto-create
- **Builtin text English-only** — all system-generated text translated from Chinese to English (schedule notifications, voice message labels, general instructions)
- **General delegation principles** — rewritten for coordinator role: delegate proactively with specific conditions instead of "do it yourself"

### Changed
- Fleet start/restart notifications unified to "Fleet ready. N/M instances running." format, sent to General topic
- `buildDecisionsPrompt()` dead code removed (intentionally disconnected in v1.9.0)
- `getActiveDecisionsForProject()` removed from fleet-manager (dead code)

### Documented
- OpenCode MCP instructions limitation (v1.3.10 doesn't read MCP instructions field)
- Kiro CLI MCP instructions limitation (unverified)
- Token overhead report (EN + zh-TW) with reproducible test script

## [1.10.0] - 2026-04-05

_Intermediate release, changes included in 1.11.0 above._

## [1.9.1] - 2026-04-03

### Fixed
- Session snapshot now injected on health-check respawn — crash/kill recovery also gets context restored
- Snapshot paste includes "do NOT reply" instruction to prevent model from attempting an IPC reply that times out

## [1.9.0] - 2026-04-03

### Breaking Changes
- **System prompt injection replaced with MCP instructions.** Fleet context, custom `systemPrompt`, and collaboration rules are now injected via MCP server instructions instead of CLI `--system-prompt` flags. This change was necessary because:
  - Claude Code: `--system-prompt` was passed a file path as literal text instead of file contents — the fleet prompt was **never correctly injected** since inception
  - Gemini CLI: `GEMINI_SYSTEM_MD` overwrites the built-in system prompt and breaks skills functionality
  - Codex: `.prompt-generated` was dead code — written to disk but never read by the CLI
  - OpenCode: `instructions` array was overwritten instead of appended, breaking existing project instructions
- **Impact on existing setups:**
  - `fleet.yaml` `systemPrompt` field is preserved — it now injects via MCP instructions instead of CLI flags
  - `.prompt-generated`, `system-prompt.md`, `.opencode-instructions.md` files are no longer generated
  - Each CLI's built-in system prompt is no longer overridden or modified
  - Active Decisions are no longer preloaded into the system prompt — use `list_decisions` tool on demand
  - Session snapshots (context rotation) are now delivered as the first inbound message (`[system:session-snapshot]`) instead of being embedded in the system prompt

## [1.8.5] - 2026-04-03

### Fixed
- Unified log and notification format to `sender → receiver: summary` style across all cross-instance messages
- Task/query notifications now show the full message body; report/update notifications show only the summary

## [1.8.4] - 2026-04-03

### Fixed
- Cross-instance notification format: `sender → receiver: summary` for clarity
- General Topic instances no longer receive cross-instance notification posts
- Reduced cross-instance notification noise — sender topic post removed; target notification uses `task_summary` when available

## [1.8.3] - 2026-04-03

### Added
- **Team support** — named groups of instances for targeted broadcasting
  - `create_team` — define a team with members and optional description
  - `list_teams` — list all teams with member details
  - `update_team` — add/remove members or update description
  - `delete_team` — remove a team definition
  - `broadcast` now accepts a `team` parameter to target all members of a named team
  - `teams` section in `fleet.yaml` for persistent team definitions

## [1.8.2] - 2026-04-03

### Added
- `working_directory` is now optional in fleet.yaml — auto-created at `~/.agend/workspaces/<name>` when missing
- `create_instance` `directory` parameter is now optional (auto-workspace created when omitted)

### Fixed
- Context-bound routing now runs before IPC forwarding in topic mode (prevented "chat not found" errors)
- Telegram: `thread_id=1` correctly treated as General Topic (no message thread)
- Scheduler initializes before instances start, so active decisions load correctly on fleet spawn

## [1.8.1] - 2026-04-03

### Added
- `reply`, `react`, `edit_message` are now context-bound — `chat_id` and `thread_id` are no longer required in tool calls; the daemon fills them from the active conversation context
- Backend error pattern detection via PTY monitoring — auto-notify on rate limits, auth errors, and crashes
- Auto-dismiss runtime dialogs (e.g. Codex rate limit model-switch prompts)
- Model failover — auto-switch to backup model on rate limit (statusline + PTY detection)

### Fixed
- Recovery notification sent after PTY error monitor detects and handles an error
- Error monitor false positives reduced; invalid `chat_id` auto-corrected from context

## [0.3.7] - 2026-03-27

### Added
- `delete_instance` MCP tool for removing instances
- `create_instance --branch` — git worktree support for feature branches
- External adapter plugin loading — community adapters via `npm install ccd-adapter-*`
- Export channel types from package entry point for adapter authors
- Discord adapter (MVP) — connect, send/receive messages, buttons, reactions
- Per-instance restart notifications in Telegram topics after graceful restart

### Fixed
- `start_instance`, `create_instance`, `delete_instance` added to permission allow list
- Worktree instance names use `topic_name` instead of directory basename to avoid Unix socket path overflow (macOS 104-byte limit)
- `create_instance` with branch no longer triggers false `already_exists` on base repo
- postLaunch stability check replaced with 10s grace period
- Restart notification uses `fleetConfig.instances` + IPC push
- Discord adapter TypeScript errors resolved

## [0.3.6] - 2026-03-27

### Fixed
- Prevent MCP server zombie processes on instance restart
- Harden postLaunch auto-confirm against edge cases

## [0.3.5] - 2026-03-26

### Added
- Per-instance model selection via `create_instance(model: "sonnet")`
- Instance `description` field for better discoverability in `list_instances`
- Auto-prune stale external sessions from sessionRegistry (every 5 minutes)
- AgEnD landing page website (Astro + Tailwind, bilingual EN/zh-TW)
- GitHub Actions workflow for website deployment
- Security considerations section in README

### Changed
- Simplify model selection — only configurable via `create_instance`, not per-message
- Use single `query_sessions_response` for session pruning

### Fixed
- Security hardening — 10 vulnerability fixes (path traversal, input validation, etc.)
- Send full cross-instance messages to Telegram instead of 200-char preview truncation
- Remove IPC secret auth — socket `chmod 0o600` is sufficient and simpler

## [0.3.4] - 2026-03-26

### Changed
- Remove slash commands (`/open`, `/new`, `/meets`, `/debate`, `/collab`) — General instance handles project management via `create_instance` / `start_instance`
- Remove dead code: `sendTextWithKeyboard`, `spawnEphemeralInstance`, meeting channel methods

## [0.3.3] - 2026-03-25

### Fixed
- Correct `statusline.sh` → `statusline.js` in test assertion

## [0.3.2] - 2026-03-25

### Added
- Channel adapter factory with dynamic import for future multi-platform support
- Intent-oriented adapter methods: `promptUser`, `notifyAlert`, `createTopic`, `topicExists`
- "Always Allow" button on Telegram permission prompts
- Per-instance `cost_guard` field in InstanceConfig
- `topology` property on ChannelAdapter (`"topics"` | `"channels"` | `"flat"`)

### Changed
- Channel abstraction Phase A — remove all TelegramAdapter coupling from business logic (fleet-manager, daemon, topic-commands now use generic ChannelAdapter interface)
- CLI version reads from package.json instead of hardcoded value
- Schedule subcommands now have `.description()` for help text

### Fixed
- Shell injection in statusline script — replaced bash with Node.js script
- Timezone validation in setup wizard and config (Intl.DateTimeFormat)
- `max_age_hours` default aligned to 8h across setup-wizard, config, and README
- `pino-pretty` moved from devDependencies to dependencies (fixes `npm install -g`)
- `toolStatusLines` cleared on respawn to prevent unbounded growth
- Try-catch for `--config` JSON.parse in daemon-entry
- Dead code `resetToolStatus()` removed
