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

For how *you* look on the dashboard (theme, identity card, colour, widgets and ambient effects), load `web-appearance`.

## Index

| The user asks about… | Section |
|---|---|
| getting in, `/web`, codes, "Send me a new code", the public link, sessions, signing out, `/view`, guests | [Sign-in and access](#sign-in-and-access) |
| sending, files, buttons, polls, HTML previews, code, tables, slash commands, Stop, history, copies in Discord/Telegram | [Chat](#chat) |
| the red badge, prompts, failed deliveries, desktop notifications | [Needs you](#needs-you) |
| "which agent did I ask about X", Ctrl+K, Ctrl+F in a chat, search results, filters | [Search](#search) |
| Ctrl+Z / undo / redo in a text box, "undo did nothing", "undo changed another box" | [Undo and redo](#undo-and-redo) |
| tasks, schedules, teams, org chart, live traffic lines, cache, Config tab | [Fleet](#fleet) |
| the sidebar list, filters, favorites, Chat / View / Log / Details, the Details page | [Finding an instance](#finding-an-instance) |
| subscription meters, plan badges, profiles, keep-warm, prompt cache | [Usage and the cache report](#usage-and-the-cache-report) |
| what an agent did step by step | [The Log tab](#the-log-tab) |
| any Settings control | [Settings](#settings) |
| themes, cards, widgets, ambient effects (petals, click stars) | [Look](#look) |
| blank page, preview refused, link fails, signed out, "live" missing | [Troubleshooting](#troubleshooting) |

Addresses: the dashboard is served on the host at `http://localhost:<health_port>` (default 19280), on 127.0.0.1
only. Pages: `/ui` chat, `/ui/fleet`, `/ui/needs`, `/view`, `/settings`.

## Sign-in and access

**Getting a code (`/web`).** Only a fleet admin can — someone in the bot connection's `access.allowed_users`.
- Discord: send `/web` in the General channel (`/dashboard` still answers but is deprecated: it says so, then opens `/web`). A menu offers **💻 AgEnD computer: get a
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
`trycloudflare.com`), default 120 minutes (`web.public_link.ttl_minutes`, at most 480; `protocol` http2/quic/auto). With a fixed
hostname (named tunnel, `web.public_link.hostname`) the minutes go up to 10080, or `0` = no expiry, and
`web.public_link.auto_open` reopens the link after AgEnD starts for the admin who last opened it (nothing posted; sign-in
still needs a code).
Close it with **Close public link** → **Close link (signs public browsers out)**, `/web revoke`, or let it expire.
A public link is limited on purpose: no live stream (the page polls), no custom CSS, and Settings → Access & security, Look,
schedule edits and preference writes are refused. HTML previews work over it through a second tunnel
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

**Guests (#1920, #2348).** Off by default: `web.guests.enabled` (or Settings → Access & security → Guests). Then someone
who is not a fleet admin gets a code privately, by sending `/web` or from an admin's **Send sign-in code**, and signs in
as their own Discord or Telegram account. What a guest sees:
- **With explicit grants** (`web.guests.grants`, set in Settings → Access & security → Guests): exactly the agents an
  admin granted that person, nothing else (default deny once the key exists). The admin picks the person from people
  AgEnD has seen writing to an agent, ticks their agents, saves (giving access or more agents waits for a fleet admin in
  General; taking away applies at once and ends their sessions), then presses **Send sign-in code**, a DM, never a post.
  Each code sent and each change to someone's access is in the event log (`guest_code_sent`, `guest_grant_changed`),
  shown to admins under **Recent changes** in that section (no agent's Log tab shows them).
- **Without grants** (before an admin saves the first one): the agents they can already use in chat: their connection's
  fleet topics and General (an `open` connection: only `web.guests.open_instances`), their own Telegram private
  ClassicBot room, and ClassicBot group rooms while their membership is verified, minus any `web.guests.narrow`.
  **Start from today's guests** turns that into grants.

They can chat there unless `web.guests.chat` is false, never send a command (text starting with `/` is refused), and the
agent sees them as `via web (guest)`. A guest's app has no Fleet, View, Settings or Needs you. To invite someone: turn it
on, grant them their agents in Settings → Access & security → Guests, and press **Send sign-in code** (or tell them to
send `/web`). The Guests section is not in Settings over the public link.

**Web authority (#1939).** A signed-in fleet admin's browser can speak as their own Discord or Telegram
account. The one row under the composer (bottom left, before the Enter hint) says **Not verified · Authorize**; the
session menu says **Not verified · Authorize this browser**. Pressing it
sends a card to that account's DM, saying which browser (device, on this computer or the network, when, until when), with
**Confirm** and **Not me**. A card left for 5 minutes is marked expired on the card, and the line offers Authorize
again. Confirm within 5 minutes and the session menu says **Verified · speaks as you until …**; the composer's row says
just **✓ Verified**, with the until-when in its tooltip, its accessible name and a tap. That
browser's messages then carry the account's authority in their delivery receipt for `max_session_hours` (default 48).
Not me signs that browser out, also after Confirm, from the same card. At most one card waits per browser, and 3 an hour
per account. Never for a guest. Over the admin's own named link (#2453) only with **Also over my named link**
(`named_link`, off by default); over the temporary public link `/web` opens only with **Also over the temporary public
link** (`quick_link`, off by default, §0.3). That authority ends with the link, and the card says "over your named link"
or "over the temporary public link". When a browser can't be authorized, the line says why (with a link to Settings when the switch, "Only
this computer" or the named-link option is the reason). Settings → Access & security → **Web authority** (`web.verified_authority`, on
by default) has the switch, **Only this computer can authorize** (`loopback_only`), **Also over my named link** (shown
with a fixed hostname), **Also over the temporary public link**, the hours, the authorized sessions, and **Revoke web authority** (or `/web revoke`). Every change
there applies at once, except turning a link's option on: a General or the host confirms that, never the browser asking.
Agents then see that browser's messages as `via web (verified)` and check their receipt like a Discord or Telegram message.

## Chat

A message to a paused agent wakes it through the same delivery path as Discord/Telegram, including ClassicBot. The composer shows **Waking…**; a refused wake explains why, keeps the draft/files and offers **Retry send**. No automatic resend. Stopped agents still require Start. Upload/history/Cancel do not wake agents. Existing guest/public-link send permissions are unchanged.

**Sending.** Type and press Enter. A message sent while the agent works waits its turn; `/steer <text>` goes into
the current turn, `/btw <question>` asks a side question. **Stop reply** (or Esc) interrupts the reply and drops
queued messages. Text is capped at 16,384 characters; a paste over 4,000 characters becomes a `pasted-….txt`
attachment (its chip has **As text** to undo that).

**Ticks** under your message: ◷ waiting behind another message · ✓ handed to the agent · ✓✓ the agent has it ·
! not delivered · ⊘ dropped by Stop. There is no "read" tick. **Reactions** (#2305): an agent may answer a message that
only acknowledges ("OK", "thanks") with an emoji under the person's bubble instead of a reply — live, kept after a
reload, also on the message's Discord/Telegram copy when the fleet posted one; it counts as the turn's answer.

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
Turn it off with Settings → Chat & connections → **Web echo** (`web.echo_to_channel`). ClassicBot rooms: per room,
`classicBot.yaml` `channels.<key>.web_echo` (Settings → Chat & connections → ClassicBot → the room → **Web echo**). Since 2.2.5
(#2054) a room echoes by default: an unset room follows `web.echo_to_channel`, `web_echo: false` keeps it off and
`web_echo: true` keeps it on. Before 2.2.5, a room echoed only with `web_echo: true`.

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
`needs_you.dm` (default off), `needs_you.task_board` (default off: the task board's cards waiting
for you — set `true` to list them). The task board's daily summary is `defaults.task_board.summary_at` (off unless set,
e.g. `"09:00"`).

## Search

The sidebar row **Search** (under Needs you, with "Ctrl K" / "⌘K"), **Ctrl+K** / **⌘K** anywhere, the header's 🔍 when
the sidebar is hidden or on a phone; **Ctrl+F** in an agent's chat opens it narrowed to that agent (elsewhere Ctrl+F is
the browser's find). Not the sidebar's **Filter** box (that filters the agent list). It searches every agent's chat as
the fleet recorded it, messages between agents (send_to_instance, delegate_task, report_result, broadcast) and Task
Board tasks — never a CLI's own transcript (that is the Log). Results come as you type, grouped by agent, newest
first, badged Chat / Message / Task; 1–2 character words work (alone: the newest 5,000 entries, said in the dialog).
↑↓ / Enter / Esc / click outside; **Filters**: agent, team, time, kinds, **Only mine**; recent searches when empty.
A chat result opens the chat at the message (flashed); a message between agents, a task or a chat row the history no
longer keeps opens as the index's copy. Admins only, over the temporary public link and on a phone too (no guests). Config: `web.search.enabled`
(default on, off everywhere), `web.search.public_link` (default on; false keeps it off the public link), `web.search.retention_days` (unset and 0 = no age limit; 1–3650 days; daily prune still caps at 300,000). Secrets are masked; a hidden `cross_instance_visibility`
agent's messages are not found. "Search is off or not available": `web.search.enabled: false`, or the index could not
open (the fleet log says why); "Still indexing": the first fill after an upgrade.

## Undo and redo

Every text box has its own undo history (#2342): **Ctrl+Z** undoes, **Ctrl+Shift+Z** or **Ctrl+Y** redoes (**⌘Z** / **⌘⇧Z** on a
Mac), only while typing in a box. Undo never changes another box (the browser's own stack is page-wide). Typing undoes a
word (or a pause) at a time; an IME composition is one step. Undoable too: a Tab-completed `/command`, Put back, As
text, a recent search picked, the filter's Esc/× clear, a status-emoji pick, a widget example, a restored CSS version
(a colour swatch is a choice, not text: it starts the hex box afresh). The browser's own Edit-menu Undo goes through the
same history; its Redo is offered only after its own undo (use the keys). Not undoable on purpose: a sent message (never back into the composer), text cleared after Add/Send,
values reloaded after Save. Password fields keep the browser's behaviour.

## Fleet

`/ui/fleet/<tab>`: **Tasks**, **Schedules**, **Teams**, **Org chart**, **Cache**, plus a **Docs** link
(`/ui/fleet/config` leads to Settings → Agent defaults: each of its settings lives in Settings, #2347).
The sidebar's **Fleet** (zh "Fleet 概覽", at the top) and the phone's Fleet tab open the Fleet tab this device used last
(`agend_last_fleet_tab`; the Org chart the first time). The sidebar has no separate Fleet (Details) or View row.
- **Tasks** — the task board: Home lists **projects** (with % done) and what waits for the person (**Confirm** /
  **Send back** finished work, **Answer** a blocked card); **No project** holds `task`-tool tasks. A project is a board
  of main tasks (M-n) by status — To do, In progress, Blocked, Waiting for you, Done — with drag to move, an assignee
  filter and each main task's sub tasks (S-n). A card opens in a dialog: every field editable, its sub tasks, comments,
  progress log, history. **Search cards** in the header. Only a signed-in person confirms the work they handed out
  (an instance's `done` on such a card is review); a card an agent handed out, that agent confirms (#2434). No
  delete: cancel. Alt+arrows on a card's title move it (no drag needed; the card's Position row on a phone). A main
  task's tile shows the sub task at work and who is on it; a card waiting for review that is not wrapped up says
  **To fill in** and Confirm asks first. A card's **Dispatched by** row: who handed it out (a blocked question goes
  to them first). Read-only over the public link.
- **Schedules** — every schedule (silent ones included): when it runs in words, "next …", the target. **New
  schedule** (Repeat with a cron expression, or Once at a date and time; message, target, label, timezone),
  **Edit** (with an **Enabled** box — that is how you pause one), **Delete**. There is no "run now", and silent can't
  be set from the web. Read only on a public link.
- **Teams** — **New team**, **Edit** (members, description; no rename), **Delete**. Read only on a public link.
- **Org chart** — see below.
- **Cache** — see [the cache report](#usage-and-the-cache-report).

**Org chart (#1918).** **Canvas** or **List** (remembered per device). The canvas: General at the top, then teams in
fleet.yaml order, then "Not in a team". Drag to pan, wheel or pinch to zoom (0.2–2.5), **Zoom in / Zoom out / Fit to
screen**, keys `+` `-` `0` and arrows, Enter opens a chat. **Overview** (bottom right, desktop) — click to move there.
Click a team header to fold it. **Find** dims everything that doesn't match. A card shows the state dot, name, state
and backend; clicking it opens the chat. List mode adds the description, model, a link to the Discord thread or
Telegram topic, and **Open chat**.

**Office** (the third view, remembered per device) draws the same fleet as a pixel office: a room per team, a desk
per instance with a name tag, General and "Not in a team" in the **Lobby**. Each little person is its state: typing
with the lamp on (working), tea break (idle), asleep behind a **Closed** sign (paused/stopped), a hand up under a
blinking light (needs you, crashed, looks stuck). With **Live** on, each message, delegation and report is carried
desk to desk along the corridors in the Key's colours; a delegation in progress is a purple folder on the worker's
desk. Hover (or tap once) a desk for its name, state and backend; click (or tap again) opens the chat. **Find** dims
the rest. **Show** picks a team or the Lobby and **People** pins chosen instances (both kept per browser); the
**Office** switcher lists offices kept on the host (`web-offices.json`, `GET`/`PUT /ui/offices`). An admin session
(never a read-only one, a guest or the public link) gets **Edit offices**: add, rename and delete offices, pick who is
in each (whole teams or single instances; none = everyone) and its style, and upload or delete **skin packs** (an
artist's pictures: `manifest.json` plus PNGs, format v1, kept in `web-office-skins/` in the AgEnD home; the host
checks every rule — PNG only, each strip exactly frames·w × h, a 16:9 background, size caps — and never changes a
pack; a strip may give its displayed size, `dw`/`dh`, apart from its pictures' size, and a character may walk four
ways with `walkDown`, `walkUp` and `walkSide`, the side one mirrored for left). **Style** (per browser for the whole fleet, per office for a stored one): **Desks** (the default),
**Studio** — one scene (Work, Lounge, Help desk, Nap corner) where each instance walks to the area for its state —
or an uploaded pack; one the page cannot load is drawn as Desks with a note. On a stored office in Studio or a pack,
**Edit layout** (admin only) shows a 1280×720 coordinate grid and lets you drag seats, furniture, the door and
waypoints (or Tab to one and use the arrow keys, Shift for 10), add or remove waypoints and join or unjoin
corridors; **Save layout** keeps the moves as that office's overrides (the pack stays as uploaded), **Reset** goes
back to the pack's own. While it is open the office picker and Edit offices wait (**Cancel** closes it); if someone
saved the offices meanwhile, Save says so and keeps your layout — Save again puts it on the current list. A crowded area packs extra people into a tighter grid, then shows "+N" in its corner; there
only calls and work get bubbles (a few at most) and name tags show on hover or focus. **Hide paused and stopped**
(per browser, off by default) leaves the sleepers out. Now and then someone says a short line for their state in a
bubble (never message content). Reduced motion: still poses, nothing in the air, bubbles shown whole.
**All offices** (in the switcher once two or more offices are stored, kept per device) shows every stored office as
a tile on one canvas, each exactly as its own view (its style, members, seats, bubbles, walking), labelled with its
name and head count, each as large as its office's content, packed to fill the panel; **Lobby tile** (on by
default; disabled when everyone is in an office) adds the instances in no office. Below 75% name tags show on hover
only. Hover and click work across
tiles; a tile's label, or a double-click on it, opens that office; traffic between offices flies straight across.
Edit offices and Edit layout wait for a single office.
The Office fills the Fleet panel and moves like the Canvas (#2540): drag to pan, the wheel or a pinch to zoom,
**+** / **−** / **Fit** / **Fill** at the top right (the zoom shown as a percentage above them) or the `+ - 0` keys
(with the office focused), an overview at the bottom right to jump (not on a phone). It takes the whole panel: the
Fleet area's full width, down to the window's foot. **Fit** shows the whole scene as large as the panel allows
(any scale, so it fills the panel's width or height); **Fill** (a toggle, kept per office) fills the panel instead,
cropping what overflows — drag to see it. **+** / **−** step in pixel levels (each logical unit a whole number of
screen pixels); drawing is always unsmoothed. A resize fits a fitted view again; the scene can never be dragged off
the panel. The zoom, centre and Fit/Fill are kept per device for each office and style. Around the 16:9 scene the
whole panel is a matte: a pack's own `matte` (`#rrggbb`), else its background's edge colour, else the skin's own
(Studio's hall floor; Desks: the dashboard's background). Hover, click, name tags and Edit layout all work at any zoom: a drag on a handle moves it,
anywhere else pans; zoom and pan are never animated.
**Fullscreen** (the button under **Fit**, or `f`; Esc leaves) shows the office alone: the dashboard's header, tabs
and bars go, and the zoom buttons, the overview (not on a phone), a small office switcher and Exit float over it. It
uses the browser's fullscreen; where a page cannot have it (an iPhone) or the browser refuses, the office covers the
window instead. Opening a chat leaves it, and it is never remembered.
A pack may add a `foreground` (a 16:9 PNG over the whole scene, zones packs only): drawn above the people, furniture
and items in the air, below name tags, bubbles and "+N" — door frames, pillars, table fronts that hide whoever walks
behind them. A furniture item's `depth` may be `"y"`: drawn among the people by base y (whoever stands lower is in
front). Numeric depths keep their meaning (under 1000 under the people, 1000 and up over them).

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
- **View** — the live terminal (read only), the identity card, and **Edit profile** (or **Sign in to edit** when signed out).
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
model, credential profile, team): input, output, reasoning, cache read and cache write tokens, requests, delivered messages,
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
(Settings → Web dashboard → **Usage report over the public link**, applies at once; otherwise the page says "Not offered over
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
(the page keeps 1000). Off by default: `web.log_tab` (Settings → Web dashboard → **Log tab: each agent's steps**; turning it on
from the tab itself needs a fleet admin's confirmation). Full for Claude Code (also after it stopped) and Codex while
running; kiro shows fleet events only; other backends say they have no readable transcript. Secrets are masked.

## Settings

**Chat & connections → Retry now** retries a disconnected connection without a fleet restart; a running login is reused. Startup retries continue with a five-minute cap. Local admin only, unavailable over public links. It changes no token or binding; refresh to read the later result.

Sections (`/settings/<section>`, #2347), in two groups. **You**: **Preferences**, **Look**. **Fleet**: **Agents**,
**Agent defaults**, **Chat & connections**, **Web dashboard**, **Access & security**, **Advanced**. Old addresses (`device`,
`appearance`, `general`, `bots`, `classic`, `web`) lead to the new sections. **Search settings** (top of the sections, **/**;
also Ctrl K → Settings) finds a setting by name, `fleet.yaml` key or synonym in either language and goes to the field.
Header: version, **Setup wizard**, **Help**.

**How changes apply (#2347).** Every Fleet section's edits are unsaved until
**Save**: a field edit (Agent defaults, Chat & connections, Web dashboard, Access & security) is unsaved at once (a straight bar on its left); a dialog's **Done**
adds its changes. The bar **N unsaved change(s)** shows the cost — **Immediately**, **Restart this Agent** or **Restart
AgEnD** — then **Save** or **Discard**; an invalid field keeps Save waiting (**Fix 1 field(s) to save**). Over a public
link an admin can change the fleet's settings too (not the dashboard's own web settings, Guests or Web authority).
Confirmations (e.g. opening access) are asked at Apply. A change that loosens access waits for a fleet admin to confirm
in the General chat ("Waiting for confirmation", **Withdraw**) — unless the browser is web-verified (#2170): an
account that is a fleet admin of every connection the change affects, on their platform, confirms it by its own Apply
("Confirmed by your account"; General gets a notice; every check runs again at execution). Not for a guest, the public
link, an unverified browser or a change that needs the host CLI. After a failure, unapplied changes are staged again
(secrets must be re-entered). **Restart AgEnD** restarts every agent
(never automatic); until then every page shows **N saved change(s) take effect after AgEnD restarts** · **Restart now** ·
**Later**. Preferences and Look save with the same bar (**Your preferences**; device-only switches count on their own; Restore defaults saves at once).

**Preferences** — follows you across devices unless marked:
| Control | What it does | Stored |
|---|---|---|
| Your name (**Save**, **Use web-user** / **Use <account>**) | the name agents see on your web messages | your profile |
| Theme: System / Light / Dark | page theme | host prefs `theme` |
| Language: English / 中文 | page language (not the bots' replies — that is Agent defaults → Language) | host prefs `lang` |
| Names: Nickname first / Real name first | sidebar names | host prefs `names.primary` |
| Allow HTML previews | the preview opt-in | host prefs `preview.optIn` |
| Chat tour (this device) | replays the chat tour | browser |

**Look** — see [Look](#look) for the cards and what they mean.

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
`delete_instance` does — no restart). The agent dialog writes `instances.<name>.*` (an "Inherit" box removes the key, and the field then says what it inherits:
"Inherited: 30 min · change in Agent defaults"; a value nobody set anywhere is marked "default"):
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

**Chat & connections** — connections (the bots): **New connection**: type, bot token (**Verify**), Discord server or Telegram group,
your user ID. It starts without a restart when AgEnD already runs another connection and nothing else at fleet level
changed; a fleet's first connection (or a change to an existing one) offers **Restart AgEnD**. Per bot: **Access mode** (locked / open / pairing) and **Allowed users** —
`channels[i].access.*`, staged, restarts AgEnD, asks before opening access; **Guild/Group id** and General channel /
forum topic with **Verify the new binding** (applies directly after a confirmation); **Status emojis**; Advanced →
**Replace** the token (saved to `~/.agend/.env`); **Delete this bot** (the token stays in `.env`). **Provider API keys**:
**Verify & apply**, used by new processes.

ClassicBot (in **Chat & connections**, `/settings/chat#classicbot`) — per room **Settings**, **Pause / Wake**. The room dialog writes `classicBot.yaml`
`channels.<key>.*`: Backend, Model, Auto-pause after, **Collaboration mode** (`collab`), **Web echo** (`web_echo`),
Advanced **Context lines** (these restart the room's agent); Tool progress and Require a delivered reply (now).

**Agent defaults** — **Project folders** (`project_roots`: where New agent may put an agent; empty = anywhere;
changing it waits for a fleet admin's OK) and the fleet defaults (`defaults.*`): **Language (bot replies)** (`locale`: Auto / en / zh-TW), default
backend and model, auto-pause, tool progress, bot-to-bot visibility, reply guard; Advanced: tool set, agent mode, log
level, **Hang detector enabled** / **Stuck timeout** (`hang_detector.*`), **Startup concurrency** (1–20) and
**Stagger delay** (`startup.*`, restart AgEnD). ClassicBot defaults (in Chat & connections; `classicBot.yaml defaults.*`): default backend, tool
progress, reply guard, **ClassicBot admins**, **Allowed guilds**.

**Access & security** (sessions, browser terminal, public link and fixed address, guests, web authority; web echo is in Chat & connections, the Log tab and usage over the link in **Web dashboard**) — all apply at once; loosening waits for an admin; disabled over a public link.
| Label | Key |
|---|---|
| Session length, hours (1–720) | `web.session.local.absolute_hours` |
| Sign out after unused for, hours (1–720) | `web.session.local.idle_hours` |
| Allow the browser terminal (the `/login` terminal) | `web_terminal.enabled` |
| Terminal session minutes (1–20) | `web_terminal.ttl_minutes` |
| Web echo | `web.echo_to_channel` |
| Log tab: each agent's steps | `web.log_tab` |
| Offer temporary public web links | `web.public_link.allow_public` |
| Public link minutes (1–480; with a fixed hostname 0–10080, 0 = no expiry) | `web.public_link.ttl_minutes` |
| Reopen the public link when AgEnD starts (fixed hostname only) | `web.public_link.auto_open` |
| Tunnel protocol (http2 / quic / auto) | `web.public_link.protocol` |
Shown read-only ("Set in fleet.yaml"): `web.allowed_hosts`, `view_access`, `notify_login`, `preview`, `preview_port`,
`preview_origin`, `preview_on_public_link`, `usage_panel`, `search` (`retention_days`: unset and 0 = no age limit,
300,000-row cap), `provider_secrets`, `upload_max_file_mb`,
`upload_max_total_mb`, `web_terminal.bind`, `web_terminal.tunnel`.

**Advanced** — fleet.yaml as **YAML / JSON**, **Edit / View**, **Copy**, **Download fleet.yaml**; **Apply**
(edit mode) adds the edit to the bar, and Save writes it. While it waits, Agents, Agent defaults and the
connections are off (and the setup wizard); while those have unsaved changes, the editor only reads.

**Setup wizard** — agent (backend, directory, name) → platform → token and server/group, your user ID → preview →
**Create and start**.

## Look

For an agent changing its *own* look, the `web-appearance` skill has the tools and limits. What a person sees in
Settings → **Look**, card by card (the app icon and card upload limits are in **Web dashboard**; following reduced motion and custom CSS off here are in **Preferences**):
- **Agents' themes** — **Show agents' themes, effects and widgets**; off, every chat looks the same and pictures and
  ring colours fall back to the bots' own (all devices).
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
  device** (in Preferences).
- **Restore defaults** — resets this host's appearance settings (it lists what it resets first).

Moved out of Look in 2.3.2 (#2347). **Preferences** (this device only): **Effects: follow the system's reduced-motion
setting** (off by default): on, ambient effects stay still while the system asks for reduced motion. Otherwise they play, with one shared one-time chat note and a local action to follow the system. And **Turn off custom CSS on this device**. **Web dashboard**: the **App icon**;
**Identity card upload limits** — portrait and banner size limits and per-agent picture quota (`web.appearance.*`);
lowering applies at once, raising waits for an admin.

**What an agent can change for the user.** A worker changes only its own look (the `web-appearance` tools); before
#2064 everything on this page was the person's. Since #2064 (2.2.5) General, coordinators and
full-profile instances get `get_web_settings` / `set_web_settings`, which go through the same checks as the page;
workers don't. The `web-appearance` skill's **For the user** section has the details. In short: General can change
the host's appearance settings, one agent's identity colour, ambient effects and Restore defaults; for custom CSS it can save a version **on trial**, keep or revert
the trial, switch to an earlier saved version, or turn CSS off — and it keeps a trial only once the user says they like
it (the user's decision). Still the person's own click on the page: choosing files from their computer
(upload CSS assets), the per-browser switches (custom CSS off on this device, Pause/Resume), and the
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
fleet.yaml (Advanced, or the file) and `agend reload`.
