---
name: web-dashboard
description: Where things are on the AgEnD web dashboard and what they do — signing in, the chat, Needs you, Fleet (org chart, live traffic), usage and the cache report, the Log, schedules, every Settings tab and control with its config key, and troubleshooting. Use it to answer "where is X / what does Y do / how do I Z" about the web.
roles: [general, worker, classic]
---

## How to use this skill

Look the question up in the index, then relay the short answer in the user's words. The labels below are the
English UI labels (the page also has 中文). Before you state a value the user configured (a limit, a switch), read
it: `get_fleet_config` shows fleet.yaml; this skill gives defaults. Never invent a control that is not listed here.
Never tell anyone to kill `wslrelay` or run `wsl --shutdown` (see Troubleshooting).

For how *you* look on the dashboard (theme, identity card, colour, widgets, ambient effects, effects, mods), load `web-appearance`.

## Index

| The user asks about… | Section |
|---|---|
| getting in, `/web`, codes, "Send me a new code", the public link, sessions, signing out, `/view`, guests | [Sign-in and access](#sign-in-and-access) |
| sending, files, buttons, polls, HTML previews, code, tables, slash commands, Stop, history, copies in Discord/Telegram | [Chat](#chat) |
| the red badge, prompts, failed deliveries, desktop notifications | [Needs you](#needs-you) |
| tasks, schedules, teams, org chart, live traffic lines, cache, Config tab | [Fleet](#fleet) |
| the sidebar list, filters, favorites, Chat / View / Log / Details, the Details page | [Finding an instance](#finding-an-instance) |
| subscription meters, plan badges, profiles, keep-warm, prompt cache | [Usage and the cache report](#usage-and-the-cache-report) |
| what an agent did step by step | [The Log tab](#the-log-tab) |
| any Settings control | [Settings](#settings) |
| themes, cards, widgets, ambient effects (petals, click stars), effects, mods | [Web appearance](#web-appearance) |
| blank page, preview refused, link fails, signed out, "live" missing | [Troubleshooting](#troubleshooting) |

Addresses: the dashboard is served on the host at `http://localhost:<health_port>` (default 19280), on 127.0.0.1
only. Pages: `/ui` chat, `/ui/fleet`, `/ui/needs`, `/view`, `/settings`.

## Sign-in and access

**Getting a code (`/web`).** Only a fleet admin can — someone in the bot connection's `access.allowed_users`.
- Discord: send `/web` (alias of `/dashboard`) in the General channel. A menu offers **💻 AgEnD computer: get a
  code** and, when `web.public_link.allow_public` is not `false`, **🌐 Other device (temporary public)**. Sent
  anywhere else, `/web` answers privately (DM, else an ephemeral reply) with the local link and a code only.
- Telegram: `/web` works only in the General topic ("/web works in the General topic — please use it there"). In a
  DM with the bot, `/start web` opens the same menu when one General is configured.
- On the host: `agend web` prints a code and opens the browser; `agend web --code` only prints it.
- If the bot has no admins: "⛔ /web disabled — this bot has no fleet admins: … is empty."

**The code.** 8 characters shown as `ABCD-EFGH` (case and the dash don't matter), valid 5 minutes, single use; asking
again replaces it. 5 wrong tries use it up; 20 failures in 15 minutes pause sign-in for 5 minutes ("Too many wrong
codes — sign-in is paused for a few minutes."). The sign-in page is **Sign in to AgEnD**: field **One-time code**,
button **Sign in**.

**Send me a new code.** On the sign-in page, for a browser that signed in before with a `/web` code (remembered 90
days). The code arrives by DM. Limits: one a minute and five an hour per browser; fleet-wide one per 20 s, 20 an hour.

**Local vs public link.** Local: the dashboard on the host itself (127.0.0.1; the address cannot be changed, only
`health_port`). Public: **🌐 Other device (temporary public)** starts a Cloudflare quick tunnel (an address under
`trycloudflare.com`), default 120 minutes (`web.public_link.ttl_minutes`, at most 480; `protocol` http2/quic/auto).
Close it with **Close public link** → **Close link (signs public browsers out)**, `/web revoke`, or let it expire.
A public link is limited on purpose: no live stream (the page polls), no custom CSS, and Settings → Web, appearance,
mods, effect-library/personal-selection management, schedule edits and preference writes are refused. Current in-scope
Chat effect metadata/code reads are allowed, with session/epoch/exposure checks; the public viewer’s show switch is browser-local. HTML previews work over it through a second tunnel
of their own (`web.preview_on_public_link`, default on).

**Sessions.**
- Local: 48 h from sign-in and 48 h unused (`web.session.local.absolute_hours` / `idle_hours`, 1–720). Background
  polling and the live stream don't count as use. Sessions survive a fleet restart.
- Public link: always 4 h / 30 min unused, and they end when the link closes.
- At most 8 sessions; the least recently used is dropped.
- The session menu (sidebar): "Signed in · …", "Ends by <time> at the latest, or after <span> unused". With more than
  one session it lists **Signed-in devices** (this one marked "· This device", others with **Sign out**) and **Sign
  out everywhere**.
- `/web revoke` (in chat) signs every browser out, withdraws an unused code and closes the public link.

**`/view` without signing in.** `web.view_access`: `open` (default) or `session`. With `open`, anyone who can reach
the local address sees every instance's live terminal and the roster (status, context %, model, effort, backend,
tags, name, description, avatars, cards) and the usage meters — read only; editing says "Sign in to edit". Over a
public link `/view` always needs sign-in.

**Guests (#1920, 2.3 beta).** Off by default: `web.guests.enabled` (or Settings → Web → Guests). Then someone who is
not a fleet admin sends `/web` and gets a code privately, signing in as their own Discord or Telegram account. A guest
sees only the agents they can already use in chat: their connection's fleet topics and General (an `open` connection:
only `web.guests.open_instances`), their own Telegram private ClassicBot room, and ClassicBot group rooms while their
membership is verified, minus any `web.guests.narrow`. They can chat there unless `web.guests.chat` is false, never send
a command (text starting with `/` is refused), and the agent sees them as `via web (guest)`. A guest's app has no Fleet,
View, Settings or Needs you. To invite someone: turn it on, then tell them to send `/web`. The Guests card is not in
Settings over the public link.

**Web authority (#1939, 2.3 beta).** A signed-in fleet admin's browser can speak as their own Discord or Telegram
account. The one row under the composer (bottom left, before the Enter hint) says **Not verified · Authorize**; the
session menu says **Not verified · Authorize this browser**. Pressing it
sends a card to that account's DM, saying which browser (device, on this computer or the network, when, until when), with
**Confirm** and **Not me**. A card left for 5 minutes is marked expired on the card, and the line offers Authorize
again. Confirm within 5 minutes and the session menu says **Verified · speaks as you until …**; the composer's row says
just **✓ Verified**, with the until-when in its tooltip, its accessible name and a tap. That
browser's messages then carry the account's authority in their delivery receipt for `max_session_hours` (default 48).
Not me signs that browser out, also after Confirm, from the same card. At most one card waits per browser, and 3 an hour
per account. Never on the public link or for a guest; when a browser can't be authorized, the line says why (with a
link to Settings when the switch or "Only this computer" is the reason). Settings → Web → **Web authority**
(`web.verified_authority`, on by default) has the switch, **Only this computer can authorize** (`loopback_only`), the
hours, the authorized sessions, and **Revoke web authority** (or `/web revoke`). Every change there applies at once.
Agents then see that browser's messages as `via web (verified)` and check their receipt like a Discord or Telegram message.

## Chat

A message to a paused agent wakes it through the same delivery path as Discord/Telegram, including ClassicBot. The composer shows **Waking…**; a refused wake explains why, keeps the draft/files and offers **Retry send**. No automatic resend. Stopped agents still require Start. Upload/history/Cancel do not wake agents. Existing guest/public-link send permissions are unchanged.

**Sending.** Type and press Enter. A message sent while the agent works waits its turn; `/steer <text>` goes into
the current turn, `/btw <question>` asks a side question. **Stop reply** (or Esc) interrupts the reply and drops
queued messages. Text is capped at 16,384 characters; a paste over 4,000 characters becomes a `pasted-….txt`
attachment (its chip has **As text** to undo that).

**Ticks** under your message: ◷ waiting behind another message · ✓ handed to the agent · ✓✓ the agent has it ·
! not delivered · ⊘ dropped by Stop. There is no "read" tick.

**Files.** 📎, drag and drop ("Drop files to attach them") or paste. Up to 5 files, 50 MB each, 100 MB per message
(`web.upload_max_file_mb` / `web.upload_max_total_mb`, 1–500; over a public link at most 95 MB per file). The type is
read from the bytes: PNG/JPEG/GIF/WebP are photos, PDF a document, UTF-8 a text file; anything else (archives,
binaries, `.html`/`.svg` and other markup) is stored as **download-only**. The agent receives the path in its
workspace `inbox/`; an unused upload is deleted after 30 minutes.

**Replying to a message (#2272).**
- **How:** the ↩ on hover, a right-click (Reply / Copy text / Copy link), a swipe left (as in Telegram; a swipe right still opens the drawer) or long-press on a phone, or R on a focused message. A bar above the composer shows what is answered; ✕ or Esc cancels.
- **The sent bubble** shows the quote, and clicking it jumps to the original.
- **The agent** gets `(reply_to: "…")`, exactly as from a Discord or Telegram reply, read by the server from the quoted message (one line, at most 500 characters). Nothing new for guests: they reply only to what they can see.
- **The channel echo** quotes only a message that was already in that channel.

**In replies.** Images inline; video and audio play inline; Markdown, CSV, JSON, code and text files get a **Show**
card (200 lines, then "Show all … lines"); other files download. Code blocks have a language tag, **Wrap** and
**Copy**, and fold after 30 lines. Each reply has **Copy this reply**. Markdown: headings, lists, quotes, bold/italic/
strike, links, and tables (header row plus separator, alignment, up to 20 columns). Discord mentions show as names;
a Discord server emoji (`<:name:id>`) of the fleet's servers shows as its picture, and any other (or one whose picture
can't load) as `:name:`. Unicode emoji are drawn by the system's colour emoji font under every theme font (boxes on
Linux mean no colour emoji font is installed). There is no @-autocomplete in the composer.

**Buttons and polls.** An agent's reply can carry up to 10 buttons ("Choices"); a click shows as a 🔘 chip and the
agent receives `[button] <label>` (with `(value: …)` when it differs). Buttons expire after 24 h ("Expired — reply in
text"). Polls show "Poll", "Time left", "🗳 N answered"; voter names only when it closes.

**HTML previews.** An agent's ` ```html ` block or `.html` file gets a card: **Preview**, **Stop**, **Download**,
**Open in panel** (side panel: **Page** / **Code** / **Reload** / **Close**). Previews need a one-time opt-in, **Allow
HTML previews** (also in Settings → Preferences); it is a host-wide preference, and you still press Preview each time.
The page runs in a sandboxed frame on a second port (`health_port + 1`, default 19281). "Never preview HTML on this
device" turns it off for this browser session. Cards are at most 1 MiB; a cut-off block says "Truncated — ask the
agent to send it as a .html file."

**Slash commands** (the **Commands** palette): `/ctx`, `/compact [instructions]`, `/clear` (asks first), `/model
[name]`, `/backend [backend] [model] [effort]` (asks first), `/effort [level]`, `/cancel`, `/btw`, `/steer`, `/pause`,
`/wake`, `/save <file>` (not on a public link). Anything else: "Not a command here — Enter sends it as a message."
At 70% context, quick actions **Compact** and **Clear…** appear. `/raw <text>` (local only) passes text to the CLI
unwrapped.

**History.** The server keeps the last 500 messages (about 1M characters) per instance in its workspace
`web-chat.json`; the page loads the last 200. There is no "load older". After a restart, buttons and ticks are not
restored; files that can't be served again show as unavailable.

**Copies in Discord/Telegram (web echo).** For a fleet topic instance, each web message is also posted to its topic as
`🌐 web · <name>: …` (the first 500 characters plus attachment names; longer text says "(full text in web chat)").
Turn it off with Settings → Web → **Web echo** (`web.echo_to_channel`). ClassicBot rooms: per room,
`classicBot.yaml` `channels.<key>.web_echo` (Settings → ClassicBot → the room → **Web echo**). From 2.3.0-beta.3
(#2054) a room echoes by default: an unset room follows `web.echo_to_channel`, `web_echo: false` keeps it off and
`web_echo: true` keeps it on. Before that, a room echoed only with `web_echo: true` — check the running version.

## Needs you

`/ui/needs`, the sidebar row **Needs you** with a count, the phone tab of the same name, and "(N)" in the browser
tab title. Items, grouped by instance, oldest first:
- the CLI waiting: "Permission needed", "Dangerous command waiting", "Sign-in needed", "Waiting at a dialog", "May be
  waiting for input", "Waiting at its terminal", "Not responding", "Exited";
- the instance: "Paused: sign-in needed", "Crashed";
- deliveries from the last 24 h: "Could not confirm delivery", "Delivery failed" (source → target · kind).

A prompt shows its own answer buttons (first answer wins); a delivery has **Acknowledge** (clears it everywhere);
"Paused: sign-in needed" has **Sign in** when the dashboard can run that login (#2233); every item has **Open chat**. **Notify me on this device** (Turn on / Turn off) gives desktop notifications while the
tab is hidden — per browser, not on phones or plain-HTTP addresses. Config: `needs_you.live_message` (default on),
`needs_you.dm` (default off).

## Fleet

`/ui/fleet/<tab>`: **Tasks**, **Schedules**, **Teams**, **Org chart**, **Cache**, **Config**, plus a **Docs** link.
The sidebar's **Fleet** (zh "Fleet 概覽", at the top) and the phone's Fleet tab open the Fleet tab this device used last
(`agend_last_fleet_tab`; the Org chart the first time). The sidebar has no separate Fleet (Details) or View row.
- **Tasks** — the task board: Home lists **projects** (with % done) and what waits for the person (**Confirm** /
  **Send back** finished work, **Answer** a blocked card); **No project** holds `task`-tool tasks. A project is a board
  of main tasks (M-n) by status — To do, In progress, Blocked, Waiting for you, Done — with drag to move, an assignee
  filter and each main task's sub tasks (S-n). A card opens in a dialog: every field editable, its sub tasks, comments,
  progress log, history. **Search cards** in the header. Only a signed-in person confirms work in review (an
  instance's `done` on such a card is review). No delete: cancel. Alt+arrows on a card's title move it (no drag
  needed; the card's Position row on a phone). Read-only over the public link.
- **Schedules** — every schedule (silent ones included): when it runs in words, "next …", the target. **New
  schedule** (Repeat with a cron expression, or Once at a date and time; message, target, label, timezone),
  **Edit** (with an **Enabled** box — that is how you pause one), **Delete**. There is no "run now", and silent can't
  be set from the web. Read only on a public link.
- **Teams** — **New team**, **Edit** (members, description; no rename), **Delete**. Read only on a public link.
- **Org chart** — see below.
- **Cache** — see [the cache report](#usage-and-the-cache-report).
- **Config** — the main channel, access (Locked/Open, allowed users), default backend and project roots; **Save
  changes** rewrites fleet.yaml (its comments are lost).

**Org chart (#1918).** **Canvas** or **List** (remembered per device). The canvas: General at the top, then teams in
fleet.yaml order, then "Not in a team". Drag to pan, wheel or pinch to zoom (0.2–2.5), **Zoom in / Zoom out / Fit to
screen**, keys `+` `-` `0` and arrows, Enter opens a chat. **Overview** (bottom right, desktop) — click to move there.
Click a team header to fold it. **Find** dims everything that doesn't match. A card shows the state dot, name, state
and backend; clicking it opens the chat. List mode adds the description, model, a link to the Discord thread or
Telegram topic, and **Open chat**.

**Live traffic** (**Live** switch, on by default; **Key** in the toolbar explains it, as a strip above the canvas): a line for each message between instances.
Colour by kind — task (delegate_task) purple, send/query/update teal, report pink, broadcast orange; between teams
(zoomed out) slate. Dotted = queued, dashed with a moving pulse = being delivered, grey fading for 12 s = delivered or
read. "×N" = several messages share a line; failed ones belong in Needs you. A `delegate_task` also draws the work: a
slow-moving purple line, delegator → worker, **in progress** until the worker's `report_result` with the same
correlation id comes back (then one pink line returns); none after 4 h fades as **no report yet**. Reloads and the
public link show the open ones. Every line ends on a card or a folded team's box. #2182: lines are routed card to card
by libavoid (libavoid-js 0.4.5, LGPL) in a worker — around cards, through gaps in team borders, never along a border or
across a team's name, lines sharing a stretch drawn apart; zoomed out, or where the router can't run (no WebAssembly,
an old browser), they follow the gaps between teams as before. The worker alone may run WebAssembly and reaches nothing
(its own CSP); the dashboard's CSP is unchanged. No message
text is ever shown; instances with `cross_instance_visibility: hidden` are left out. On a public link it refreshes
every 5 s.

## Finding an instance

**The sidebar list.** Grouped by team (an instance in `teams.<name>.members` under its first team, whatever its tags), else by
its first tag ("#" before the heading), ClassicBot rooms under Classic, the rest under Other; Settings → Agents the same (#2172).
Each row (#2179): name and context % on the first line, the time of the agent's last reply to a person at the end of the
second ("2 min ago"; cross-instance messages don't count); a reply under 10 minutes old is highlighted, fading by itself
(nothing to mark read). The sort button beside Edit: **Custom** (default; a reply never moves a row) or **Recent replies**
(the rest by last reply, no groups, no dragging; favorites pinned in their order, or **Sorted by last reply too**); synced
as `nav.sort`. Guests and the anonymous View reader: no times, no sort (always Custom).
**Filter: name, model, backend** (Esc clears), facets **Status** and **CLI**, "N / M shown".
While a filter is on, the instance you have open stays on top under **Current**. **Favorites**: the star on a row;
**Edit** to reorder (at most 50; "Clear the filter to reorder favorites"). Drag to reorder the full list; groups fold.
Order, folding, filter and favorites follow you across devices. A row keeps you on the same kind of page (from a Log
to that instance's Log).

**Chat | View | Log | Details** switch at the top of an instance.
- **View** — the live terminal (read only).
- **Log** — [the Log tab](#the-log-tab).
- **Details** — Configuration (display name, description, directory, bound to, tags; "Read only — change it in
  Settings." with **Edit in Settings**), Runtime (backend, model, effort, cost, context, 5 h and 7 d rate), Recent
  activity, its identity card and widget. The ⋯ menu: Start / Restart / Stop instance, Pause / Wake, Colour…, **Page
  colours** (#2196: the agent's choice / on the whole page / only its chat — host prefs `theme.pageByInstance`), and
  the theme lock/reset.
- **Page colours (#2196):** an agent's theme with `page.on` (or a person's "on the whole page") colours the sidebar,
  the header and the usage rail (a phone: drawer, header, tabs) while that agent's Chat/View/Log/Details is open —
  colours only; status colours (Needs you count, state dots, errors, focus ring) never change. The header follows the
  page, not the chat. Off with agents' themes off or `?safe=1`.

Phone layout: bottom tabs Chat, Needs you, Fleet, Settings. Chat is current on any of an agent's pages and goes to its
chat; View, Log and Details are the switch under the header.

## Usage and the cache report

**Usage.** The **Usage** header button: a right-hand rail at 1200 px or wider (shown/hidden per device; on Chat,
View, Log, Details and Fleet), otherwise a dialog — **AI Subscription Usage**. One row per provider in use (Claude,
Codex, Muse, Grok, Kiro, Antigravity; every Claude login on the host, used or not — `Claude (default)` and each profile, #2236): Claude's **Session** (5-hour window) and **Weekly** (7-day), per-model weekly
rows, "binding" on the window that will stop you, **Extra usage** in dollars. "high" at 70%, "near limit" at 90%.
Refreshes every 60 s while open; **Refresh** forces it (at most once per 30 s); **Move up / Move down** reorders rows.
`web.usage_panel: false` hides the rail and dialog (the `/usage` chat command and `get_usage` still work).
**A failed read keeps the last numbers** (#2236 follow-up): an expired token, a rate limit, a network blip or any other
error shows the numbers from the last good read (up to a week old), greyed, with "expired · cached at 14:05" (or "not
updated" / "couldn't read") and what to do under it; a window that has reset since says "reset since …" with no number.
`get_usage` rows carry `stale: true`, `cachedAt`, `staleCause` (expired / transient / error) and `resetPassed` on such
metrics; read them as old. A provider never read successfully still shows its error. A good read clears the mark.

**Profiles and plan badges.** Each Claude credential profile has its own row: the card says "Claude" with the
profile on its own line (the API and chat call it "Claude (<profile>)"); a shared row appears only while some
instance uses the default login. The badge is the account's plan — e.g. **Pro**, **Max ×20**, **Team ×6.25** (the
multiplier is its rate-limit multiple; full name on hover). A setup-token login has no badge. A signed-out profile
says "Not logged in — sign in with /login claude-code <profile> …". More: the `credential-profiles` skill.

**The cache report** (Fleet → **Cache**; the `get_cache_report` tool). How often each instance's prompt cache
expires between turns and what that costs, read from transcripts (Claude Code, Codex; kiro is credit-billed: "Not
available"). Windows **24 h / 7 days / 30 days**. Fleet row: **Expiry cost**, **Keep-warm would save**,
**Recommended**, and **Switch to 1-hour cache** when an instance needs it. Per instance: requests, gaps past the TTL,
expired (rewrote), tokens rewritten, expiry cost, keep-warm pings and their cost, net, cache writes 5 min / 1 h, and
**Behaves as** — whether a "5m" cache really expires after 5 minutes (measured over 5–60 minute gaps of the last 7
days). Money is list price (date shown); quota effects are estimates. `get_cache_report` gives the fleet to General,
coordinators and full-profile instances, and each other instance only its own row.

**The usage report** (the `get_usage_report` tool, and Fleet → **Usage**, `/ui/fleet/usage`, #2122; the ◔ dialog's
**By agent →** opens it). Per instance (or backend,
model, credential profile, team): input, output, cache read and cache write tokens, requests, delivered messages,
and an amount, over today / 7d / month / all / custom days in the fleet's timezone. **Every amount is the
API-equivalent at list price — not money spent** (subscriptions aren't billed per token): say "API-equivalent", never
"spent". Measured for Claude Code and Codex. Marks to repeat in words:
- `cache_write_not_reported`: Codex records no cache writes, so they are neither shown as 0 nor priced.
- `not_priced`: the tokens are shown, the amount isn't.
- `source_unknown`: read before #2122, when which backend and profile read it was not recorded (backend and profile
  "unknown" — never today's).

Each hour keeps the backend whose reader read it and the profile it was read under, so an instance that changes
backend or profile keeps its history as it was. `notMeasured` lists kiro and the other backends with their reason;
they are never a $0 row, and what such an instance measured before still shows. Messages are counted per instance, so
by backend they go under its backend now. Coverage only says "read" for a catch-up that listed and read every source
(an unreadable directory or transcript is not covered, never a 0). Scope as
`get_cache_report`. The dashboard reaches it over the public link only with `web.usage_report_on_public_link: true`
(Settings → Web → **Usage report over the public link**, applies at once; otherwise the page says "Not offered over
the public link" and links to that switch on the dashboard reached directly); guests never. The page adds a daily trend (top 5 and
others), a heatmap that tells a day read with nothing used from a day not collected, and **Download CSV** (the shown
answer's daily rows, with the basis). Claude subagent (sidechain) turns aren't counted yet. A long range whose daily rows
are too many says from which date the charts and the CSV start (the totals stay whole); a day used only by an unpriced
model is "used, not priced"; after a timezone change each day keeps the zone it was made in, and the page says so.

**Keep-warm** means sending a small turn before the cache expires so the next real turn reads it instead of
rewriting it. **Today it is only a simulation and a recommendation** — AgEnD sends no keep-warm pings (#1469 is
still being designed). If the report says **Switch to 1-hour cache**, the remedy is
`backend_options.claude-code.prompt_cache_ttl: "1h"` on that instance (takes effect on the next start).

## The Log tab

What an agent was asked, its replies (never its thinking), each tool call (Read, Edit, Search, Run, Web, MCP,
Sub-agent…, with **Show output**), errors, turn ends, compactions and fleet events, on one timeline. Filters **All /
Tools / Errors**; **Live** while it updates. Opens with the newest 200 steps; **Load older steps** adds 100 at a time
(the page keeps 1000). Off by default: `web.log_tab` (Settings → Web → **Log tab: each agent's steps**; turning it on
from the tab itself needs a fleet admin's confirmation). Full for Claude Code (also after it stopped) and Codex while
running; kiro shows fleet events only; other backends say they have no readable transcript. Secrets are masked.

## Settings

**Connections → Retry now** retries a disconnected connection without a fleet restart; a running login is reused. Startup retries continue with a five-minute cap. Local admin only, unavailable over public links. It changes no token or binding; refresh to read the later result.

Tabs (`/settings/<tab>`): **Preferences**, **Web appearance**, **Agents**, **Connections**, **ClassicBot**,
**General**, **Web**, **Developer**. Header: version, **Setup wizard**, **Help**.

**How changes apply.** Agents, Connections, ClassicBot, General, Web and Developer edits are *staged*: a dialog's
**Stage change** (General/Web: **Review changes**) adds it to the bar **Changes not applied yet**, which shows the
cost — **Immediately**, **Restart this Agent** or **Restart AgEnD** — then **Apply changes** or **Discard**.
Confirmations (e.g. opening access) are asked at Apply. A change that loosens access waits for a fleet admin to confirm
in the General chat ("Waiting for confirmation", **Withdraw**) — unless the browser is web-verified (#2170): an
account that is a fleet admin of every connection the change affects, on their platform, confirms it by its own Apply
("Confirmed by your account"; General gets a notice; every check runs again at execution). Not for a guest, the public
link, an unverified browser or a change that needs the host CLI. After a failure, unapplied changes are staged again
(secrets must be re-entered). **Restart AgEnD** restarts every agent. Preferences and Web appearance save directly.

**Preferences** — follows you across devices unless marked:
| Control | What it does | Stored |
|---|---|---|
| Your name (**Save**, **Use web-user** / **Use <account>**) | the name agents see on your web messages | your profile |
| Theme: System / Light / Dark | page theme | host prefs `theme` |
| Language: English / 中文 | page language (not the bots' replies — that is General → Language) | host prefs `lang` |
| Names: Nickname first / Real name first | sidebar names | host prefs `names.primary` |
| Allow HTML previews | the preview opt-in | host prefs `preview.optIn` |
| Chat tour (this device) | replays the chat tour | browser |

**Web appearance** — see [Web appearance](#web-appearance) for the cards and what they mean.

**Signing a backend in (#2233)** — local admin sessions only (never a guest or the public link): Settings → Agents →
**Sign-ins** (each backend's login and each credential profile an agent uses: state, **Sign in** / **Sign in again**,
or the host command / install command where the dashboard cannot), the web `/backend` picker's **Sign in to
<backend>** on a "not signed in" choice, and Needs you's **Sign in**. The dialog: the pre-check's question (still
signed in? kiro logs out first; **Use a temporary public link** where allowed), then a device code, or **Open the
sign-in terminal** + its one-time access code (this browser only, no DM). While it runs every admin page shows
"Signing in to X (started on <device>)" with **Open**; another browser sees no code and may **Cancel sign-in**. Ends
when the browser session ends. A missing CLI is not installed here (the dialog says the install command). agy and
opencode: no dashboard sign-in. Config: `web_terminal.*` (as `/login`).

**Agents** — **New agent**; per agent **Settings**, **Pause / Wake**, **Start / Stop** (direct), ⋯ **Delete agent**
(staged; on Apply it waits for a fleet admin's confirmation in General, then the agent is stopped and removed, as
`delete_instance` does — no restart). The agent dialog writes `instances.<name>.*` (an "Inherit" box removes the key):
| Label | Key | Applies |
|---|---|---|
| Display name, Description | `display_name`, `description` | now |
| Backend, Model, Working directory | `backend`, `model`, `working_directory` | restarts the agent |
| Auto-pause after (minutes, 0 = off) | `auto_pause_after` | now |
| Channel binding | `channel_id` | restarts AgEnD |
| Stuck timeout (minutes) | `hang_detector.timeout_minutes` | agent |
| Agent mode, Tool set | `agent_mode`, `tool_set` | agent |
| Tool progress; Bot-to-bot messages in topics (full / summary / hidden); Log level | `tool_progress`, `cross_instance_visibility`, `log_level` | now |
| Require a delivered reply | `reply_completion_guard` | now |
| Lightweight mode, Fallback model | `lightweight`, `model_failover` | agent |
| System prompt | `systemPrompt` | agent |
| Tags | `tags` | now |
| General topic (fleet dispatcher) | `general_topic` | AgEnD |
| Status emojis (Received, Queued, Processing, Delivered, Failed, …) | `status_emojis` | agent |

**Connections** (the bots) — **New connection**: type, bot token (**Verify**), Discord server or Telegram group,
your user ID. It starts without a restart when AgEnD already runs another connection and nothing else at fleet level
changed; a fleet's first connection (or a change to an existing one) offers **Restart AgEnD**. Per bot: **Access mode** (locked / open / pairing) and **Allowed users** —
`channels[i].access.*`, staged, restarts AgEnD, asks before opening access; **Guild/Group id** and General channel /
forum topic with **Verify the new binding** (applies directly after a confirmation); **Status emojis**; Advanced →
**Replace** the token (saved to `~/.agend/.env`); **Delete this bot** (the token stays in `.env`). **Provider API keys**:
**Verify & apply**, used by new processes.

**ClassicBot** — per room **Settings**, **Pause / Wake**. The room dialog writes `classicBot.yaml`
`channels.<key>.*`: Backend, Model, Auto-pause after, **Collaboration mode** (`collab`), **Web echo** (`web_echo`),
Advanced **Context lines** (these restart the room's agent); Tool progress and Require a delivered reply (now).

**General** — fleet defaults (`defaults.*`): **Language (bot replies)** (`locale`: Auto / en / zh-TW), default
backend and model, auto-pause, tool progress, bot-to-bot visibility, reply guard; Advanced: tool set, agent mode, log
level, **Hang detector enabled** / **Stuck timeout** (`hang_detector.*`), **Startup concurrency** (1–20) and
**Stagger delay** (`startup.*`, restart AgEnD). ClassicBot card (`classicBot.yaml defaults.*`): default backend, tool
progress, reply guard, **ClassicBot admins**, **Allowed guilds**.

**Web** — all apply at once; loosening waits for an admin; disabled over a public link.
| Label | Key |
|---|---|
| Session length, hours (1–720) | `web.session.local.absolute_hours` |
| Sign out after unused for, hours (1–720) | `web.session.local.idle_hours` |
| Allow the browser terminal (the `/login` terminal) | `web_terminal.enabled` |
| Terminal session minutes (1–20) | `web_terminal.ttl_minutes` |
| Web echo | `web.echo_to_channel` |
| Log tab: each agent's steps | `web.log_tab` |
| Offer temporary public web links | `web.public_link.allow_public` |
| Public link minutes (1–480) | `web.public_link.ttl_minutes` |
| Tunnel protocol (http2 / quic / auto) | `web.public_link.protocol` |
Shown read-only ("Set in fleet.yaml"): `web.allowed_hosts`, `view_access`, `notify_login`, `preview`, `preview_port`,
`preview_origin`, `preview_on_public_link`, `usage_panel`, `provider_secrets`, `upload_max_file_mb`,
`upload_max_total_mb`, `web_terminal.bind`, `web_terminal.tunnel`.

**Developer** — fleet.yaml as **YAML / JSON**, **Edit / View**, **Copy**, **Download fleet.yaml**; **Apply & save**
(edit mode) applies at once, without the bar.

**Setup wizard** — agent (backend, directory, name) → platform → token and server/group, your user ID → preview →
**Create and start**.

## Web appearance

For an agent changing its *own* look, the `web-appearance` skill has the tools and limits. What a person sees in
Settings → **Web appearance**, card by card:
- **Agents' themes** — **Show agents' themes, effects and widgets**; off, every chat looks the same and pictures and
  ring colours fall back to the bots' own (all devices). **Effects: follow the system's reduced-motion setting** (this
  device only, off by default): on, both ambient and Canvas Worker effects stay still while the system asks for reduced
  motion. Otherwise both play, with one shared one-time chat note and a local action to follow the system.
- **Ambient effects** — an agent's falling petals, snow, rising lanterns, twinkles or stars on a click, drawn behind
  its chat by the dashboard (data only, no consent needed). They show by default, the public link too; the chat's ⋯
  menu says why one is not showing (choosing the line fixes it there) and offers **Clear the ambient effect** /
  **Clear the click effect**. With the system asking for reduced motion, the chat says once per device that effects
  are on, with **Turn off here**. General can set or clear one for the user (`set_web_settings`, `what: "ambient"`).
- **Identity colours** — each agent's colour in the sidebar comes from, in order: a person's pick (⋯ menu →
  Colour…), the agent's own, its bot's Discord role colour, or an automatic soft colour. Choose where it shows (Name /
  Left bar / Ring) or **Turn off colours** (the picks are kept).
- **Identity cards** — Small / Medium / Large for all cards; a card's own S / M / L overrides it.
- **Your sidebar widget** — a small panel under the instance list built from JSON (no HTML or script), with live
  values such as `fleet.working` and `fleet.needs_you`; agents can't change it.
- **Custom CSS (yours only)** — your own CSS on every device you sign in on, never on Settings, never others'; it
  can't load from the internet (put pictures and fonts under Assets: PNG, WebP, JPEG, GIF, WOFF2, 1 MiB in total).
  **Save and try**, then **Keep** within 15 s or it reverts; **Turn off (all devices)**; earlier versions **Use
  this**. If something is hidden or broken, open the page with `?safe=1`, or tick **Turn off custom CSS on this
  device**.
- **Mods** — one `.agendmod.json` file carrying a look; importing shows everything first and applies only what you
  tick (custom CSS is never pre-ticked); agents can propose mods (**Review** / **Dismiss**); **Export a mod** writes one.
  Uninstalling removes the mod, not what it applied.
- **Effects** — the effect library (upload a folder with `effect.json` and `worker.js`, up to 1 MiB), save one for a
  chat, share your copy; **Your effect choices** for Sidebar / Header / Page / Box (each with Pause / Resume and
  Clear) and a Cursor (its state, and Clear). CW uses the dashboard's opaque isolated document, independently of
  **Allow HTML previews**, its listener and port. Signed-in public/guest viewers can play current effects in chats they
  may see, without library, personal-slot, Trial or profile grants. Their Chat header offers a browser-local show/off
  switch and recovery, on desktop and phone; it never changes host preferences. A Try sample starts on a signed-in non-public admin's
  click, with no extra consent. The show switch, safe mode, hidden tab, browser support and live performance guard remain.
  No startup FPS calibration; data saver does not block. Reduced motion blocks only if this device chose to follow it.
  A blocked placement keeps an exact named notice. On ordinary dashboard sessions, Show/custom-CSS actions open
  **Web appearance**. Public/guest Show-off has **Turn effects on here**; a guest CSS refusal offers Reload.
  An unavailable
  isolated transport offers Reload, never an HTML-preview setup step. A motion refusal offers **Play effects anyway**;
  safe mode offers **Leave safe mode**. The dialog names loading, safety and raw unknown codes. Codes stay local; agents get only closed recent blocked reasons without viewer identifiers or counts.
- **Identity card upload limits** — portrait and banner size limits and per-agent picture quota
  (`web.appearance.*`); lowering applies at once, raising waits for an admin.
- **Restore defaults** — resets this host's appearance settings (it lists what it resets first).

**What an agent can change for the user.** A worker changes only its own look (the `web-appearance` tools); before
#2064 everything on this page was the person's. Since #2064 (2.3.0-beta.3; check the running version) General, coordinators and
full-profile instances get `get_web_settings` / `set_web_settings`, which go through the same checks as the page;
workers don't. The `web-appearance` skill's **For the user** section has the details. In short: General can change
the host's appearance settings, one agent's identity colour, mods (review, install, cancel, dismiss, uninstall),
effects and the effect slots, and Restore defaults; for custom CSS it can save a version **on trial**, keep or revert
the trial, switch to an earlier saved version, or turn CSS off — and it keeps a trial only once the user says they like
it (the user's decision, 2.3.0-beta.3). Still the person's own click on the page: choosing files from their computer
(import a mod, upload an effect folder or CSS assets), the per-browser switches (custom CSS off on this device, Pause/Resume), downloading an exported mod, and the
card upload limits. The docs' "Asking General to change it for you" says the same for people.

## Troubleshooting

**Blank dashboard / can't connect (WSL).** The dashboard listens on 127.0.0.1:`health_port` inside WSL; Windows
reaches it through WSL's localhost forwarding. Compare the two sides:
- in WSL: `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19280/health`
- in Windows PowerShell: `curl.exe -sS -o NUL -w "%{http_code}" http://127.0.0.1:19280/health`
Any HTTP code (200, or 503 when the fleet is degraded) means that side reaches the listener; `000` means no
connection. A 403 "Host not allowed" means the name used isn't localhost/127.0.0.1 — add it to `web.allowed_hosts`.
If WSL answers and Windows doesn't, the forwarding is the problem: try `http://localhost:19280` vs
`http://127.0.0.1:19280`, or the SSH tunnel in docs/web-dashboard.md. **Do not** tell the user to kill `wslrelay`
or run `wsl --shutdown` — that stops every WSL program, AgEnD included. Changing WSL's networking mode is the user's
own decision. If the port is taken by something else, chat says "Dashboard unavailable — health port … is already in
use".

**Preview "connection refused" / "did not answer within 3 s".** The preview frame comes from the second port
(`health_port + 1`). Over SSH, forward that port too (`-L 19281:127.0.0.1:19281`). Through a proxy or tunnel the two
names are kept apart: the **dashboard's** external name goes in `web.allowed_hosts`, and `web.preview_origin` must be
a **different** host name, mapped to the preview port, that is neither the dashboard's `hostname` nor in
`web.allowed_hosts` (the validator refuses a preview origin the dashboard answers to). "Something else answered on
the preview port": another program holds it — change `web.preview_port` (restart). If fleet.log says "Preview
listener unavailable", the port could not be bound (older versions' cards then wrongly said previews were turned
off).

**Public link fails at once.** Read the step list the bot posts and daemon.log's "Public web link … startup failed":
- "another tunnel is still running" — a `/login` link or an unconfirmed old tunnel; wait for it to end, or close it;
- "Cloudflare is limiting new temporary links from this machine" (HTTP 429) — try later; the local dashboard still
  works;
- "cloudflared stopped before it gave a public address" / "could not be started" / "the download did not complete"
  — the tunnel program failed or couldn't be fetched (network, proxy);
- "Cloudflare gave no public address in time" — only after a real 60 s wait;
- no steps at all: `web.public_link.allow_public: false`, or the sender is not a fleet admin.

**"Your session has ended."** It lasted its 48 h (or the idle limit), a public link closed or ran 4 h / 30 min idle,
or someone ran `/web revoke`, **Sign out everywhere** or `agend web-token rotate`. Get a new code: `/web`, **Send me
a new code**, or `agend web` on the host. "No session — open the dashboard link again" means the browser keeps no
cookies for the site.

**No live updates ("it only refreshes every few seconds").** The page normally keeps one live stream; if nothing
arrives within 15 s, it stays silent 30 s, or a proxy buffers it, the page polls every 5 s instead and retries the
stream in the background. Nothing is lost except immediacy (the Log tab may lag up to 30 s). A public link always
polls. "Can't reach AgEnD — it may be restarting" means even polling failed.

**Usage meters missing.** `web.usage_panel: false`, the window is narrower than 1200 px (use the Usage button), or
no instance uses that provider.

**Settings won't change something.** Over a public link, Web settings and appearance are read only; a loosening
change waits for an admin's confirmation in General chat; a value in the "Set in fleet.yaml" list must be edited in
fleet.yaml (Developer tab, or the file) and `agend reload`.

### Canvas Worker playback diagnostics

The effect player loads only when there is something to play: the open chat has a placed effect, the person chose a
personal effect, or a Try card is shown (#2193). Before that, nothing of it is in the page, by design. Ambient effects
and custom CSS never need it.

If an effect cannot play, the Chat notice and Effects dialog show its local refusal code. A failed Try retains its stop
code on the offer card; the browser console also names refusals. Include the code when reporting a problem. Long chat
history is checked separately from the bounded set of current paint holes. Moving the pointer away does not stop Try;
window blur, navigation, closing or loss of the verified stage does. Local raw codes are not sent in agent summaries.
