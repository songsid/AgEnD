# The web dashboard

中文版：[web-dashboard.zh-TW.md](web-dashboard.zh-TW.md)

The dashboard's browser tab uses the Silver **Ag** mark on Chat, View, Settings and the sign-in page, including temporary public links. The same mark is available as an apple-touch icon when you save the page to a phone's home screen. Icons are bundled and served from the dashboard itself; loading them requires no sign-in.

AgEnD's web dashboard is three panels on one small web server that the fleet runs for you:

| Panel | What it is for |
|---|---|
| **`/ui`**: the app | Talk to your agents (chat, files, Stop reply), see who is working, and manage instances, tasks, schedules and teams. Each chat has its own address, `/ui/chat/<name>`; Fleet is `/ui/fleet` (`/ui/fleet/schedules`, `…/teams`, `…/org`, `…/cache`, `…/config`); **Needs you** is `/ui/needs` |
| **`/view`** | A read-mostly view of every agent: live terminal, roster, usage, and editing each agent's profile and avatar |
| **`/settings`** | Fleet settings — agents, connections, ClassicBot, defaults, `fleet.yaml` — with apply and restart. Each section has its own address: `/settings/bots`, `…/classic`, `…/general`, `…/web`, `…/advanced` (`/settings` is Agents) |

`/ui`, `/view` and `/settings` are one app with a sidebar: the instances, **Fleet**, **View**, **Settings** and the **Session** menu. Moving around inside it does not reload the page, and Back/Forward work. `/` opens `/ui`, which goes back to the chat you had open last. Old links of the form `/ui#instance=<name>` still work, also through signing in.

The server listens on **`127.0.0.1`**, on `health_port` (default **19280**). It is reachable from the machine itself unless you set up a way in: see [Reaching it from elsewhere](#reaching-it-from-elsewhere).

## Signing in

The dashboard signs in with a **one-time code**, never with a link that carries a credential.

1. Get a code, either way:
   - in General, use **`/web`** (fleet admins only; Discord native slash). Press **💻 AgEnD computer: get a code** for the AgEnD computer, or **🌐 Other device (temporary public)** for another device (when allowed). The instruction appears first, without redundant page URLs or a closed-link countdown. The menu contains no code: the bot sends the link and code privately, then the code once more in a message of its own, so a phone can copy just the code (tap it to copy: Telegram shows it as code, Discord as inline code). A public link's expiry is shown in the fleet's time zone, with its UTC offset.
   - on Telegram, the bot can message you only after you open a chat with it. If `/web` can't reach you, tap **Open private chat** (or send `/start web` to the bot), press Start, and the same menu opens in that private chat: choose there and the code arrives right below it. Within 10 minutes of such a failure, the bot's own START button (a bare `/start`) does the same, once.
   - on the host, run **`agend web`**. It prints the code and opens the sign-in page. `agend web --code` only prints them.
2. Open the sign-in page and type the 8-character code (`ABCD-EFGH`, with or without the dash, in any case).

The private local packet has three lines: the sign-in URL, the five-minute single-use code and the secrecy/revoke reminder. A public packet adds its actual link expiry in the fleet time zone. A local URL has no separate link-expiry row; the code and browser-session lifetimes are different. The code-only follow-up is retained.

About the codes:
- A code works **once** and expires after **5 minutes**. Only the newest code works: asking again replaces the previous one.
- Five wrong tries use up a code. Enough wrong tries across codes pause sign-in for a few minutes. While no code has been issued, there is nothing to guess.
- Local sign-ins are announced in General unless `web.notify_login: false`. Public sign-ins always require a confirmed public notice.

**Send me a new code.** A browser that signed in before with a code from `/web` shows this button on the sign-in page, so you do not have to go back to chat. The new code goes by DM to the person who received that earlier code, never into a group, and only while they are still a fleet admin. The DM names the browser and whether it asked through the public link or the local network. Like any new code, it replaces the previous one, including one `/web` sent a moment ago. It can be asked for once a minute and five times an hour per browser (and a few times a minute for the whole fleet). It is not available while sign-in is paused after wrong codes. A code from `agend web` does not make a browser eligible. On a public link the button only works while that same link is open, and the sign-in is announced in General as usual. `/web revoke` and `agend web-token rotate` remove the button from every browser.

An old `?token=` link or bookmark (`/ui?token=…`, as older versions printed) is **not** a way in. It opens the sign-in page, and the token is removed from the address bar.

## Sessions

- A session is a record on the server, not a value in your browser. By default it ends **48 hours** after sign-in, or after **48 hours** without use, whichever comes first — on the dashboard reached directly these two can be set with `web.session.local.absolute_hours` / `idle_hours` (up to 720 hours; see [configuration](configuration.md)). Local sessions survive a fleet restart. Public sessions are scoped to one exposure: four-hour absolute / 30-minute idle limits, and link closure also ends them. They cannot be used locally or on a later exposure; local cookies and header tokens cannot be used on the public host.
- Only what you do counts as use: opening a page or a chat, sending, changing something. What a page does on its own timer never does: the live stream (also when it reconnects), the polling fallback, and `/view`'s terminal, roster and usage refresh. So a tab left open, including `/view` with `web.view_access: session`, still ends after its idle limit (48 hours locally unless configured, 30 minutes for a public session).
- When a session ends, the page says so once ("Your session has ended. Sign in again") and keeps what you were doing on screen.
- **The Session menu** (at the bottom of the sidebar) shows:
  - which browser you are signed in as, and when the session ends;
  - every other signed-in device, each with **Sign out**;
  - **Sign out everywhere**.

### Signing every browser out (revoke)

Use any of these if you see a sign-in you did not make, or a device you no longer trust:

| Where | How |
|---|---|
| Telegram | `/web revoke` |
| Discord | the `/web` slash command, with **`action: revoke`** |
| On the host | `agend web-token rotate`. This also rotates the token the CLI uses; a running fleet picks it up with no restart. |
| In the browser | Session menu → **Sign out everywhere** |

If the server cannot save the change (a disk problem), the reply says so: everyone is signed out **for now**, but a restart could bring the sessions back, so fix the disk and revoke again.

## The chat (`/ui`)

Pick an instance on the left to talk to it. The web chat is **the same conversation** as its Telegram/Discord topic:
- A message you send from the web is echoed into the topic as `🌐 <your name>: …` (see *Who the agent sees* below).
- The agent's reply goes to Telegram/Discord as usual and also appears here.
- You can switch between the web and your phone mid-conversation.
- **No chat platform at all?** With no `channel` / `channels` in `fleet.yaml`, the dashboard alone is enough: an agent's replies come to the web chat.
- **A tour, when you want one.** **Settings → Preferences → Chat tour** opens an agent's chat (the last one you had open) and points out the agent list, files, Stop and the *needs you* badge. It never starts by itself. With no agent to open, it says so.

### Who the agent sees (#1827)

- **Signed in with a code from `/web`:** the code was sent privately to your Discord or Telegram account, and this browser is that account to the agent. Your web messages arrive as `[user:<name> via web, id:<your user id on that platform>]`. An agent that knows you from Discord or Telegram recognises you, and `via web` says where you wrote from.
  - **The name:** your account's display name at sign-in, unless you choose another under **Settings → Preferences → Your name**. The choice follows you to every device you sign in on, the public link included. The id never changes with the name.
  - **Name rules:** 1–32 characters of letters, digits, spaces, single emoji and `. - _ ' ·`. A name can't contain the word "via", and can't be a name AgEnD reserves or an agent's or bot's name here.
- **Signed in otherwise** (an `agend web` code, or a session from before 2.2): `web-user`, as before. You can still set a name for those messages; signing in once with a `/web` code makes this browser your account.
- **It is for recognition only.** A web message is never a verified message from that platform account: it grants no permission, and a #1756 human-authorization receipt never names it as one.
- **The same name is used** in the topic echo, a ClassicBot room's log, reply-button choices, poll results, tasks you create or claim, and web `/steer` and `/btw`.
- **Polls:** your web vote is your account's ballot, the same one as your vote on Discord or Telegram.

### The layout
- The conversation is one centred column. Your messages are bubbles on the right; an agent's replies use the full column, each with **Copy**.
- **Code blocks** show their language, with **Copy** and **Wrap** (long lines wrap instead of scrolling; remembered for this browser). A block longer than 30 lines is folded: **Show all N lines** opens it.
- **Discord server emoji** written as `<:name:id>` (or `<a:name:id>`) show as the emoji's picture when it belongs to a server the fleet's Discord bots are in; AgEnD fetches it once and the dashboard serves it, so the page never loads Discord. Any other one stays as written.
- **Mentions** show as Discord does: `<@id>` (or `<@!id>`) becomes **@name**, a role `<@&id>` **@role name**, a channel `<#id>` **#channel**, with the id on hover. Names are the ones AgEnD already knows (the fleet's bots, people who wrote to it, the Discord servers its bots are in); an unknown one reads **@user** (or @role, #channel). A Telegram **@username** gets the same look. Nothing inside code is changed.
- The view follows new messages only while you are at the bottom. Scrolled up to read, it stays where you are, and **↓ N new** takes you down.
- The sidebar button at its top hides it (☰ brings it back); the choice is remembered. On a phone the sidebar is a drawer: ☰ opens it — or swipe right across the conversation — and choosing something, tapping outside it, swiping it left or Esc closes it. (A swipe that starts at the very left edge stays the browser's back gesture, and swipes on code, tables, the terminal or the message box are left to them.) A phone also has tabs along the bottom (Chat, Fleet, View, Settings); they make room while the keyboard is open.
- The header shows the instance's name and state, the **Chat / View / Details** switch, **Text size** and **Usage** (the same two, in the same order, on Chat, View, Details and Fleet). **Text size** goes S → M → L and is one setting for this browser: chosen on any page, it is the size on every page and after a reload. **Usage** is AI subscription usage: on a wide screen (1200 px and up) it is a panel on the right beside the page, hidden until you open it: **Usage** (or the panel's ✕) shows or hides it, remembered on this device; on a narrower screen **Usage** opens it as a dialog. Its **⋯** menu holds **Instance details** (the Details page) and the instance's own actions, and only the ones that fit: **Start** for a stopped instance; **Restart** and **Stop instance** for a running one; **Delete** last, behind typing its name.
- **Theme** and **Language** (**Settings → Preferences**; on `/view` without signing in, the ☀ button beside **Sign in**, for that browser only): *System* follows each device's light or dark setting; *Light* or *Dark* fixes it. The language applies to every panel.
- **Each instance in the sidebar** is called by its display name, with its instance name on hover (and under the display name when two instances share one). Its picture is, in this order: the one uploaded in View (**Edit profile**), its own bot's avatar when it has a bot of its own (the General bot counts when General is the only one using it), else the avatar of the bot it talks through (usually the General bot), its persona emoji, or its first letter. Each instance has an [identity colour](#identity-colours), shown by default as a ring around its picture and a bar at the row's left edge. The dot on the picture is its state — idle, working, looks stuck, paused (hollow), stopped, crashed or needs you — and says so to a screen reader too. Pictures and server emoji are fetched by AgEnD on this computer and served by the dashboard itself; the page never loads Discord or Telegram. The filter finds an instance by either name.
  - A display name set in View (**Edit profile**) wins over one the agent sets itself (`set_display_name`). Clearing it in View shows the agent's own name again (or the instance name).
- The bottom of the sidebar is one row: **Settings** and **Session**. **Settings → Preferences** holds theme, language, HTML previews and the tour.
- **Favorites (#1664).** Star an instance to pin it in **Favorites** at the top of the sidebar, in the order you starred them. On a desktop the ☆ appears when you hover over or focus a row, and stays on starred ones. On a phone, tap **Edit** above the list. **Edit** also shows ↑ ↓ to reorder favorites. A deleted instance drops out; a paused or stopped one stays. At most 50.
- **Preferences follow you across devices (#1665).** Theme, language, the sidebar's order, folded groups, filter and favorites, and HTML previews are saved on the AgEnD host, so your phone and your desktop match. A change shows up on your other devices at once, or the next time they load. Each browser keeps a copy and the page arrives with your theme already applied, so nothing flashes. The first time a device loads after the update, it uploads its own choices for anything not saved yet; after that, what is saved on the host wins. The tour, text size, view fit, the sidebar shown or hidden, panel widths, code wrap and desktop notifications stay on each device. A public link can read your preferences but cannot change them.
- **On a phone** the on-screen keyboard resizes the page, so the composer stays above it, and the layout keeps clear of the notch and the home bar.

### Keyboard and screen readers
- **Esc** stops the agent's reply while it works, as Esc in its terminal would. It does nothing while it is idle or when a form or menu is open: Esc closes that first.
- The sidebar's rows are links: **Tab** reaches them and **Enter** opens one (a middle click or Ctrl+click opens it in a new tab). On a phone, the rest of the page cannot be reached while the drawer is open.
- Messages are not read out as they arrive. A screen reader hears the coarse events once each: the agent started, finished, replied, or is waiting for your input. The conversation itself is a log to browse.

### Writing
- **Enter** sends; **Shift+Enter** adds a line. If sending fails, your text is given back.
- Messages render **Markdown**: headings, **bold**, *italics*, ~~strike-through~~, `code`, code blocks, lists, quotes, rules and links. Also:
  - **Tables** (`| a | b |` with a `|---|---|` row under the header, and `:--` / `--:` / `:-:` for alignment). Write `\|` for a pipe inside a cell.
  - **Nested lists**, by indentation, up to six levels.
  - **Highlighted code** in fenced blocks marked `js`, `ts`, `json`, `python` or `sh`. Other languages show plain.
  - Links open in a new tab, and only `http(s)` / `mailto` links are links.
  - Nothing in a message, yours or the agent's, can add HTML of its own.
- Reloading the page keeps the conversation: the fleet keeps each instance's recent messages.

### Files and images
- Attach with **📎**, by pasting, or by dropping files onto the chat (it shows where they will go while you drag). Each file waits above the composer as a chip with its name and size, and **✕** removes it.
- A paste longer than **4,000 characters** is attached as a text file instead of filling the composer. **As text** on its chip puts it back into the composer.
- Limits: up to **5 files per message**, **50 MB each**, **100 MB together** by default.
  - Change the two sizes with `web.upload_max_file_mb` and `web.upload_max_total_mb` in `fleet.yaml`: whole MB, 1–500. One file is never allowed more than a whole message. `agend reload` applies a change to the next upload; a page that is already open uses the new numbers after it reloads. `agend doctor` and the fleet's start warn about a value it cannot use.
  - **Over the public link** a file is at most **95 MB**, whatever the config says: a Cloudflare quick tunnel carries about 100 MB per request, and each file is one upload. The refusal says so.
  - The chat checks a file against these limits before sending it, and the server checks every upload again, by the bytes that actually arrive.
  - A file uploads as it streams to disk, so big files do not use much memory. An upload that goes a minute without any data, or takes over 30 minutes, is dropped, and its partial file with it. Through the public link, the tunnel drops a connection that is silent for 15 seconds.
  - The agent gets a path, so a file's size does not matter to AgEnD. Some agent CLIs may still refuse to read a very large text file.
- Types: **any file**, as in Discord and Telegram. The type is read from the file itself, not from its name. PNG, JPEG, GIF and WebP are images; PDF and UTF-8 text are kept as such. Anything else (an archive, an office file, a program, HTML, SVG …) is stored under its own extension (lower-case letters and digits, else `.bin`), and in the chat it is only ever a download, never opened in the page.
- The agent receives files exactly as from Telegram: the file lands in the instance's workspace inbox (`<AGEND_HOME>/workspaces/<instance>/inbox`), with an `[📷 Image: …]` / `[📎 File: …]` line.
- Files the agent attaches to its reply show in the chat. Images show inline; anything else is a download, never opened in the page.
- The chat keeps its own copy of each reply file (`<AGEND_HOME>/workspaces/<instance>/web-files`), so the file still opens after the agent changes or deletes its original, or the fleet restarts. A symlink, a file over 50 MB, or a file inside the AgEnD state folder (other than inbox/) is not shown. A copy is deleted when its message leaves the chat history; each instance keeps at most 1 GiB of copies, and above that the oldest go first.
- An attached file that is **not sent within 30 minutes** is deleted. After a fleet restart, any such file left over is removed at startup once it is 30 minutes old.
- Files that were sent stay in the inbox for **7 days**, like files from Telegram.

### HTML previews
When an agent's reply contains a ` ```html ` block, or attaches a `.html` / `.htm` file, a card under it can run that HTML for you.
- **Files and blocks work the same.** A file's card sits under the reply's files. Its HTML is read from the fleet only when you click **Preview** or **Open in panel**, and it runs in the same sandboxed frame as a block. The file is never opened on the dashboard's own address. **Download** is the file's own link above the card. A file the fleet no longer has (its copy was removed to stay within the limit, or it was sent before AgEnD kept copies) says so; ask the agent to send it again.
- **Up to 1 MiB.** A block or a file over 1 MiB (as UTF-8) gets no preview. A file's listed size is checked before anything is read, and its bytes are checked again after. Files are read as UTF-8.
- **Off until you turn it on.** Use **Allow HTML previews** in **Settings → Preferences**, or the card's **⋯** menu. It asks once and says what it means. The choice applies on every device where you are signed in (never on the public link). Turning it off stops every running preview.
- **Click to run, every time.** **Preview** runs it in a frame under the card, with this banner: *"Previews run the agent's HTML in an isolated frame. It cannot use your login, but it may be able to send data out. Only preview content you trust. A preview can slow or freeze this tab."* **I understand** on the banner hides it until you next sign in. The amber border around the preview always stays. **Stop** closes it. One preview runs at a time.
- **Download** saves a block's HTML as `reply.html` (a file keeps its own name). It is never opened in the dashboard.
- **Open in panel** shows the block beside the conversation, with room to use it. On a phone it is a full-screen sheet; **←** goes back to the chat.
  - From an idle card, the panel opens with its own **Preview** to click. From a running preview, the same button moves that preview into the panel.
  - The panel's bar: **Page** / **Code** (the source), **Reload**, **Stop**, **Download**. **From …** at the top shows the message the block came from.
  - Drag the divider to resize it, or focus it and use ← →, Home and End. This device remembers the width.
  - When a later reply carries a newer version of the block (the same `<title>`, or any newer block when it has none) or of the file (a file with the same name), the panel offers it with **Show it**. It never swaps it in by itself, and the new version waits for **Preview**.
  - Closing the panel (**×**, **←** or Esc) or opening another chat stops its preview. Starting a preview in a card stops the panel's: one preview runs at a time.
  - There is no "open in a new tab": the HTML only ever runs in the sandboxed frame. Use **Download** to take it elsewhere.
- **What it can and cannot do.** The preview runs in a sandbox on a separate address, so it cannot use your sign-in, read your session or act on the dashboard. It **may** be able to send data out (no browser blocks every way), so preview only HTML you trust.
- **Only agents' replies** get a card, marked so by the fleet. HTML from people (on the web, Telegram or Discord) is only ever shown as code, and a `.html` file a person uploads stays a plain download. A block cut off by the length limit gets no preview: ask the agent to send a `.html` file instead. Agents are told to prefer a file for whole pages, since a long block is split on Discord and Telegram.
- **Where it works.** Previews come from a second local port, `health_port + 1` (19281). Over SSH, forward it too: `ssh -L 19280:127.0.0.1:19280 -L 19281:127.0.0.1:19281 <host>`. Through a tunnel or proxy they need `web.preview_origin`, a separate host name mapped to that port; the proxy must pass the external `Host` through. Otherwise the card says why previews are off, and shows the code and **Download** only.
- **On the temporary public link (#1723)** previews work too, from a phone as well.
  - The link opens a second quick tunnel of its own for them, in the background, once the link's own tunnel has its address (the link always asks Cloudflare first, #1767). The link never waits for it: it is ready as soon as its own tunnel is.
  - Until the preview tunnel is up, a card says *Preview is starting…*, then runs as usual. If it cannot open, the link keeps working and the card says why.
  - A preview tunnel that comes up unreachable (the edge has not learned its name in time) is opened once more, with a new address, while the card still says *starting* (#1732).
  - It closes with the link.
  - Its address is another `trycloudflare.com` name. `trycloudflare.com` is on the Public Suffix List, so the frame is a different site from the dashboard: more isolated than the local default (a second port on the same name).
  - Your device's choice (**Allow HTML previews**) applies, and it cannot be changed over the link.
  - `web.preview_on_public_link: false` turns this off. A `web.preview_origin` you configured is used instead of a second tunnel.
- **⋯ → Never preview HTML on this device** hides **Preview** on every card for this browser session.
- **A preview that hangs** can be stopped with **Stop**; it may keep using that tab's preview process, so new previews in that tab may not start until you open the dashboard in a new tab.

### Ticks: where your message got
Each message you send shows how far it got, the same steps Telegram shows as reactions:

| Tick | Meaning |
|---|---|
| ◷ | Waiting behind another message |
| ✓ | Handed to the agent |
| ✓✓ | The agent has it |
| ! | Not delivered |
| ⊘ | Dropped by **Stop** before the agent got it |

### "*name* is working…" and Stop
While the open chat's agent is working, a line above the composer says so, and **Stop reply** appears in the composer in place of **Send**. Type something and **Send** comes back beside it: a message sent while the agent works waits its turn.
- Stop does what Telegram's cancel button and `/cancel` do: it interrupts the agent's current reply (Esc), and the messages still waiting are dropped. Their ticks turn to ⊘.
- Stop reply does **not** stop the instance's process. **Stop instance** in the header's **⋯** menu does that.
- The line shows how long the agent has been working, counted from when this page saw it start. After Stop it reads "Stopping *name*…" until the agent is idle.
- When the agent is waiting on its terminal (a permission question, a login, a dialog), the line says "*name* is waiting for your input", and the instance gets a **needs you** badge in the sidebar. This is read from the terminal screen, so take it as approximate. Answer it from the prompt buttons below, or on the host.

### Answering the fleet's prompts
When an instance looks hung, exits on its own, or is stuck on an interactive prompt, the buttons Telegram/Discord show also appear in that instance's chat: *Force restart* / *Keep waiting*, *Restart* / *Ignore*, *Ask General to help* / *I'll handle it myself*.
- It is the **same prompt**: the first answer counts, from either place. The other side's buttons then show the outcome, and the prompt expires everywhere at once.
- Only these instance-health prompts come to the web. A `/clear` confirmation, login, ClassicBot approvals, tips and the `/model` / `/effort` menus stay where they were asked. The web chat runs its own `/clear`, `/model`, `/backend` and `/effort` (below).
- A prompt raised while the page was not connected appears as soon as it reconnects. One answered elsewhere meanwhile shows as answered.
- **No chat platform?** On a dashboard-only fleet these prompts are asked here, in the instance's chat. An interactive prompt's *Ask General to help* asks your General instance to look at the terminal, so that one is offered only when the fleet has a General.

### Commands and quick actions
Type `/` at the start of the message box for the instance's own chat commands, the same ones its Telegram/Discord topic accepts. The same handlers run them, under the same rules.
- **The palette:** it filters as you type. ↑/↓ moves, **Tab** completes, **Enter** runs, **Esc** closes it.
- **Commands:**
  - `/ctx`: context use, model and effort.
  - `/compact [instructions]`
  - `/clear`: asks first.
  - `/model [name]` and `/effort [level]`: with nothing after them, the list to choose from.
  - `/backend [backend] [model] [effort]`: another CLI backend, one choice at a time (the backend, its model, its effort), then asks first. It restarts once, in a fresh session. Model lists come from the cache only, as for `/model`.
  - `/cancel`
  - `/btw <question>`
  - `/steer <text>`
  - `/pause` and `/wake`
  - `/save <file>`
- **Where the answer shows:** above the message box.
  - `/clear` and `/cancel` say they were sent, and that answer leaves by itself after a few seconds. An answer to read, a list to choose from and a refusal (even one worded as plain text) stay until you close them.
  - `/compact` says **Compacting…** from the moment the command reaches the agent until the agent's transcript records the compaction, then **Conversation compacted**, and leaves. This works for Claude Code and Codex, whose transcripts AgEnD reads.
  - kiro (classic and the TUI's V2 engine) says on its own pane how a compaction ended, so the card follows that pane: **Conversation compacted**, or that kiro did not compact the conversation because it was too short or the compaction was stopped. On the TUI, Esc and Ctrl-C don't stop a compaction, and "compacted" means kiro's "Compacting conversation..." line came and went: a failure other than "too short" was never seen, so it can't be told apart.
  - On other backends, kiro's V3 engine included, the card says their compaction end can't be detected, and leaves.
  - With no record after 10 minutes it says so and stays. If the command never reached the agent, or the agent stopped, restarted or changed backend meanwhile, it says it can't follow the compaction any more.
- **Not a command:** anything else starting with `/` is sent as an ordinary message, as before. So is a line typed with a file waiting beside it.
- **Fleet-wide commands** (`/status`, `/restart`, `/update`, `/login`, …) stay in General.
- **`/raw`** is not offered. Over the temporary public link a message starting with `/raw ` is refused, and so is `/save`.
- **Quick actions:**
  - The model and effort in the chat's header open their lists.
  - Once the instance's context is 70% used, **Compact** and **Clear…** appear above the message box.

## Fleet (`/ui/fleet`)
The fleet's shared work and its overview, one tab each. Every tab has its own address. **Docs** in the header opens the docs site's short Web Guide (in the dashboard's language) in a new tab.

**One instance's Details** (`/ui/fleet/agent/<name>`) is the Fleet side of that instance: its runtime (backend, model, effort, cost, context, 5-hour and 7-day limits), its recent activity, and a read-only summary of its configuration (display name, description, directory, where it is bound, tags), with **Edit in Settings** to change it. Its ⋯ menu starts, restarts, stops, pauses or wakes it, with the same calls and confirmations as the chat's ⋯ menu and Settings; deleting an instance stays in the chat's ⋯ menu and Settings. A ClassicBot room's Details shows its room instead of a directory, offers only pause and wake (as Settings does), and **Edit in Settings** opens its ClassicBot settings. An instance with no connection of its own is shown on the fleet's first connection, where it is bound by default.
- On an instance page, the header switches between its **Chat**, **View** and **Details** (tabs under the header on a phone); the instance stays the same. Someone reading View without signing in sees no switch.
- With an instance open, the sidebar's **Fleet** (and the phone's Fleet tab) goes to that instance's Details; with none open, to Tasks. On Details or a Fleet tab, an instance in the sidebar opens its Details.
- **Tasks**, **Schedules** and **Teams**: the task board, cron schedules and teams. Create, claim and delete them here. A team's **Edit** changes its members and description (the same update as the `update_team` tool); a team cannot be renamed — create a new one and delete the old. Over the public link teams are read-only.
- **Org chart** (`/ui/fleet/org`; **Fleet overview** at the top of the sidebar, or of the drawer on a phone, opens it from any page): General at the top, then the teams from `fleet.yaml`, then the instances in no team.
  - Each instance shows its display name, what it does, its backend and model, and its live state (working, idle, needs you, looks stuck, paused, stopped or crashed).
  - Each instance also links to its Discord thread or Telegram topic and to its chat.
  - The chart is read-only: you act in Discord, or from the chat.
- **Cache** (`/ui/fleet/cache`): how often each Claude Code and Codex instance's prompt cache expires between requests over 24 hours, 7 days or 30 days, what rewriting it costs, and whether a keep-warm ping would pay off.
  - It reads the transcripts on the machine, never a vendor API, and keeps a small summary per instance (`cache-ledger.json`).
  - Costs are list prices from one table; the date they were checked is shown.
  - Where a transcript records cache writes, those are used. Where it does not (some Codex sessions), the rewrite is estimated from the uncached input, and the numbers are marked as estimates; so are they when the cache lifetime had to be assumed.
  - Kiro and other CLIs show "not available".
- **Config**: the fleet's channel, access and defaults.

## Needs you (`/ui/needs`)

Everything waiting on you, from every bot's world, in one list: a fleet prompt (not responding, exited, waiting at its terminal), an agent stopped at a permission, a dangerous command, a sign-in or another dialog, an agent paused for sign-in or crashed, and a delivery the fleet could not confirm or deliver. It is the same list as each bot's live **Needs you** message in General (there, each bot shows only its own agents). Something handled anywhere, in Discord, Telegram or here, leaves every list.

- **Needs you** in the sidebar (and a tab on a phone) shows how many things are waiting; the browser tab's title starts with `(N)`.
- The list is grouped by agent, oldest first. A prompt has its own buttons; a delivery has **Acknowledge**; every item has **Open chat**.
- **Notify me on this device** shows a desktop notification when something new needs you while the tab is in the background (a terminal wait only once it has lasted 5 seconds). It is per browser, asks for permission when you turn it on, and needs a secure address: `127.0.0.1`/`localhost` or the HTTPS public link, not a plain-HTTP LAN address. It is not offered on phones: there, the Discord notification (a new post in General, and the optional DM) is the one to rely on.

## `/view`

`/view` shows every agent: the live terminal capture, the roster with each one's state and context, and AI subscription usage. Each agent has its own address, `/view/<name>`; `/view` alone opens the one this browser looked at last.

- **The roster is the sidebar** while View is open (on a phone, the drawer): grouped by tag, with the filter at the bottom (**/** jumps to it) and your own order (drag a group or an instance). Rows show the context in use and the backend's colour; hover for the rest.
- **The header** has **Text size**, **Usage** and **Help**. On View the size goes Fit → S → M → L: **Fit** (the default) sizes the terminal to fit its box, never larger, down to a 6 px floor. S / M / L are the size every page shares. Choosing a size on another page keeps View on Fit; only View's own Text size leaves it. The terminal stays dark in both themes.
- **The card under the terminal** shows the agent's name, role and model; its arrow opens the whole profile. **Edit profile** changes the display name, role, description and avatar. **Remove picture** (shown when one is uploaded) goes back to the bot's avatar, the persona emoji or the first letter when you save.

- **Reading `/view` needs no sign-in by default** (`web.view_access: open`). That includes the live terminal, so anyone who can reach the port can watch your agents. On a machine only you can reach, that is fine. Otherwise set:
  ```yaml
  web:
    view_access: session   # reading /view needs a signed-in session too
  ```
- **Signed out, `/view` is View alone:** the sidebar has View and **Sign in**, nothing that needs a session is shown or read, and **Sign in to edit** takes you to the sign-in page and back.
- **Editing an agent's profile or avatar always needs a session.** The order of the roster is one of your synced preferences (above); an anonymous reader's stays in that browser.
- Scripts can still write with the `X-Agend-Token` header.

## `/settings`

**Agents**, **Connections**, **ClassicBot**, **General**, **Web** and **Developer** (the whole `fleet.yaml` as YAML or JSON) are tabs, each with its own address. The search box filters agents, connections and ClassicBot rooms; **Setup wizard** runs the same four steps as `agend quickstart`; it always adds a connection, for a new agent or one you already have.

A fleet with no chat connection yet (web only) shows a card above the Agents and Connections tabs (not on Chat, which has one instruction: choose an agent, or create one): **Connect a chat app** opens the setup wizard, **Use the web only** hides the card in this browser.

- **Changes are staged, then applied together.** An agent's or a connection's **Settings** dialog stages its changes when you press **Stage change**; General's or Web's **Review changes** does the same. The bar at the bottom counts them and says what applying them costs (immediately, a restart of that agent, or a restart of AgEnD); **Apply changes** applies them all, **Discard** drops them. Staged changes stay while you move between tabs; leaving Settings with any asks **Discard N pending changes?** first.
- **Once you press Apply, it carries on without you.** You can open the chat or anything else: the writes, the reload and its progress go on, a line at the top says how it is going, and Settings shows the details when you come back. A second Apply waits until the first is done. When a change needs AgEnD itself restarted, **Restart AgEnD** is offered (with its own confirmation).
- **Web** holds the dashboard's own settings: how long a sign-in lasts here and how long it may sit unused (`web.session.local.*`; empty = the default), the browser terminal `/login` opens (on or off, and its minutes), web echo and the public link's menu. A change that loosens access — a longer session or idle time, the browser terminal turned back on or given more minutes, the public link — waits for a fleet admin to confirm it in General (or `agend settings confirm <id>`, see [Confirming sensitive changes](#confirming-sensitive-changes)); one that tightens access applies at once. The other web settings are listed read-only: they decide what the dashboard listens on and exposes, so they are edited in `fleet.yaml` (then `agend reload`; `web.preview_port` and `web.preview_origin` take a restart). Over a temporary public link none of this can be changed: the section says so and the server refuses it.
- **New agent** is the same dialog as the sidebar's **+** (New instance).
- **Bot tokens are entered here, not in `.env`.** **New connection** and the **Setup wizard** ask for the bot's token in a password field; **Verify** asks Telegram or Discord whose token it is and shows the bot ("This is @your_bot.") before anything is saved.
  - The token is stored on this computer in `~/.agend/.env`, under a name AgEnD generates (`AGEND_DISCORD_TOKEN`, `AGEND_DISCORD_2_TOKEN`, `AGEND_TELEGRAM_PERSONA1_TOKEN`…). **Advanced** shows it, read-only, for people who manage `.env` themselves; nobody has to type one.
  - Both always **add** a connection. A second bot on the same platform, even in the same server, becomes its own connection (`discord-2`, …); an existing connection is never replaced. To change a connection's token, open its **Settings** → **Advanced** → **Replace**.
  - A connection shows **Token set** (with the bot's name while it runs) or **Token missing**, never the token. A new connection starts as soon as Apply runs, without a restart, when AgEnD is already running another connection and nothing else at fleet level changed; the Apply card says "Starting the new connection". A fleet's first connection, or a change to an existing one, still offers **Restart AgEnD**. A token replaced on a connection that is not running starts it the same way; for the first connection it waits for that restart.
- **A change that needs a fleet admin's confirmation** (see [Confirming sensitive changes](#confirming-sensitive-changes)) shows a card in any panel: what it changes, the time left, and **Withdraw**. Apply waits for it; once it is confirmed the rest goes on, and if it is refused or expires, nothing after it is applied and those changes are staged again (a bot token has to be entered again).

### Identity colours

Each agent has a colour you can find it by in the sidebar.
- **Where it comes from**, in this order:
  - a colour a person picked for it;
  - the agent's own (its theme's `identity.color`, else its accent), while you show agents' themes;
  - its own bot's colour from its Discord role;
  - otherwise one of a few soft automatic colours, chosen from its name (two agents may share one).
- **Where it shows:** its name, a bar at the row's left edge, and the ring around its picture, in any combination. The default is the ring and the bar. A person's choice for an agent wins, then the agent's own, then this host's default.
- **Changing one agent's:** its **⋯ → Colour…** in the chat or Details, or **Colour…** in View's **Edit profile**.
  - Pick one of 12 colours (each readable in light and dark) or your own hex colour, and the places it shows.
  - **Reset** goes back to the agent's, the bot's or the automatic one.
  - This works over a temporary public link too, like profile edits.
- **This host's settings,** in **Settings → Web appearance → Identity colours:**
  - where colours show by default;
  - **Turn off colours**, which hides every identity colour on this host. The colours people picked are kept and come back when you turn colours on again.
- **Restore defaults** (Settings → Web appearance) puts this host's appearance settings back to their defaults and turns your custom CSS off. It asks first and says what it resets. The colours people picked, installed mods, uploaded effects and the card limits stay.

### Custom CSS (Settings → Web appearance)

**Appearance** holds your own stylesheet. It applies only to your screens: every device where you are signed in, never anyone else's. It covers Chat, Fleet, Details, Needs you, Log and View.

- **Never on Settings.** Settings is always drawn without your CSS, so you can always undo a stylesheet that hides something.
- **Never in these places either:**
  - the sign-in page;
  - a temporary public link (a different person, who can't reach Settings);
  - the anonymous `/view` reader.
- **Save and try.** A saved version is on trial. A bar on every page asks **Keep this custom CSS?** Choose **Keep** within 15 seconds, or it reverts on its own. It also reverts if the tab is closed or the CSS hides the bar.
- **What it may contain.** At most 64 KiB, and it never loads anything from the internet:
  - `@import`, `@namespace` and `@charset` are refused.
  - Any `url()` or `src()` is refused, except `url("asset:<id>")` naming a file under **Assets**.
  - `image-set()`, `cross-fade()`, `element()`, `paint()`, `expression()`, `behavior`, `-moz-binding`, `javascript:` and `vbscript:` are refused.
  - The reason for a refusal is shown when you save. What is served is a clean rewrite of what you wrote, never the uploaded bytes.
- **Assets.** PNG, WebP, JPEG, GIF or WOFF2: up to 16 files and 1 MiB in total. Metadata such as GPS location is removed. **Copy reference** gives you the `url("asset:<id>")` to paste.
- **Earlier versions.** The last five are kept, and **Use this** puts one back. **Turn off (all devices)** goes back to the stock look.
- **On this device.** **Turn off custom CSS on this device** affects only this browser, so a phone layout can be fixed on the phone. Add `?safe=1` to any page's address to load it once without custom CSS.

### Agents' themes

An agent can give its own web chat a look: colours for light and dark, an accent, the bubbles' corners and border, a font, a background picture, its own picture, and the words it shows while working. It sets them with the `set_web_theme`, `set_web_theme_asset` and `reset_web_theme` tools (`agend-agent theme` from a shell).

- **Only its own chat.** A theme changes that agent's chat panel and its picture and ring in the sidebar. It never changes the sidebar itself, the header, Settings or any other agent's chat.
- **Checked twice.** The host stores only values that pass the checks (fixed colour, font and border choices, text that stays readable in both modes). The page checks again before drawing, and drops anything else.
- **Pictures stay on the host.** They are served from the dashboard itself, with their metadata removed, and never loaded from the internet.
- **People decide.** In a chat's or Details' **⋯** menu:
  - **Lock theme** stops the agent changing it. **Unlock theme** allows it again.
  - **Reset theme…** removes it and keeps a lock in place.
  - Both need a signed-in admin, and neither is offered over a temporary public link.
- **Your switch.** **Settings → Web appearance → Show agents' themes, effects and widgets** turns them off on all your devices. Every chat then looks the same, and pictures and ring colours are the bots' again. `?safe=1` also loads a page without them.
- **Limits.** An agent's changes are at least 30 seconds apart, at most 10 an hour, with at most 3 picture uploads an hour. A picture you uploaded for an agent in its profile wins over its theme's. `web.themes.agent_edit: false` in `fleet.yaml` refuses every agent's changes.

### Identity cards

Each agent can have an identity card: a portrait, a banner, a one-line tagline and a short bio.

- **Who sets it.** The agent sets its own with `set_web_theme` (`card.tagline`, `card.bio`, and `card.portrait` / `card.banner` naming pictures uploaded with `set_web_theme_asset` for those slots). A person sets theirs in View's **Edit profile**. **A person's field wins over the agent's, field by field**: leave a field empty to show the agent's.
- **Where it shows.** At the top of the agent's **Details**; in **View**, above the profile row while it is expanded; and folded into the agent's chat, under the header. The chat's card is folded until you open it, and that choice is kept on this device.
- **Size.** Each card has **S / M / L**. **Settings → Web appearance → Identity cards** sets the size for every card on all your devices, and a card's own control sets that card apart. Over a temporary public link the size is kept on that device only.
- **Text stays text.** The tagline and bio are never markup or links. Pictures are served by the dashboard itself, with metadata such as GPS removed.
- **Pictures that are too large.** Edit profile offers to shrink a portrait or banner that is over the limits ("This picture is 3000×4000; it will be resized to 1024×1365"). The server checks the result like any upload.
- **Clear card** removes your tagline, bio, portrait and banner; the agent's own card shows again. A person's **Reset theme…** removes the agent's card and leaves yours. **Lock theme** stops the agent changing its card.
- **Over a temporary public link** you can edit the card, as you can the profile and picture. Theme reset and lock, and the limits below, stay off it.
- **How an agent sees itself.** `get_web_appearance` tells an agent how it appears now: its face and where it comes from (profile, theme, bot, emoji or initial), its ring colour, its identity colour and where that comes from (a person's pick, its theme's accent, its own bot's Discord role, or automatic), its card field by field (whose each field is), its theme per mode, whether it is locked, and its limits. `preview_web_appearance` draws that as an SVG per mode in its own working directory (`.agend/appearance/light.svg`, `dark.svg`), with the pictures it shows written beside it (`avatar.png`, `portrait.png`, …) — only its own. From a shell: `agend-agent appearance` and `agend-agent appearance preview [light|dark]`.
- **Upload limits.** **Settings → Web appearance → Identity card upload limits** (or `web.appearance` in `fleet.yaml`) sets the largest portrait and banner and how many pictures each agent may keep. Defaults: portrait 1024×1536, 1.5 MiB; banner 1600×600, 768 KiB; 8 pictures, 4 MiB per agent. A lower limit applies at once; a higher one waits for a fleet admin's confirmation. A limit applies to new uploads only; pictures already stored stay.

### Widgets

A widget is a small panel of facts drawn by the dashboard itself: numbers, progress bars, a line of text, a short list, a coloured badge, a sparkline. Whoever places it writes only **what to show** (a short JSON spec) and **the values** — never HTML, script, links or CSS. The dashboard draws it with its own components in the page's colours, inside a thin frame with a **✦ title** chip, so a widget never looks like part of AgEnD and nothing in it can be clicked.

- **Where.** An agent may place one in **its own chat**, as a strip under the header (up to 4 items), and one on **its own Details** page (up to 8 items). Your own widget goes in **the sidebar**, under the instance list; agents can't place one there.
- **Live values.** Besides the values it sets, an agent's widget can show its own state, context use and cost, as the page already shows them. Your sidebar widget can show the fleet's counts: working, needs you, idle, stopped. Nothing else is read for it.
- **How an agent sets one.** `set_web_widget` with `slot` (`chat_header` or `details`) and a `spec` places or replaces it. With only `data`, it gives the placed widget new values: at most one update every 10 seconds and 180 an hour, apart from its theme changes. `remove_web_widget` takes it out. From a shell: `agend-agent widget set|data|remove`.
- **People decide.** **Lock theme** stops an agent changing its widgets too. A chat's or Details' **⋯** menu offers **Remove the chat header widget** and **Remove the Details widget**. A widget a person placed (from a mod) takes the agent's values, but the agent can't replace or remove it. **Reset theme…** removes the agent's widgets.
- **Your sidebar widget.** **Settings → Web appearance → Your sidebar widget** takes the spec and values as JSON. It shows a preview and says what's wrong before saving. **Start from an example** fills in the fleet's counts. It is kept with your preferences on all your devices, and is never shown over a temporary public link or with `?safe=1`.
- **Your switch** hides agents' widgets along with their themes. The public link shows agents' widgets, like their cards.

### Mods

A mod is one file, `<name>-<version>.agendmod.json`, that carries a look: an agent's theme with its pictures, its card text (tagline and bio, never card pictures), widgets, effects, and custom CSS. It is plain JSON of at most 8 MiB, with no zip and nothing to unpack. **Settings → Web appearance → Mods** imports, lists, downloads, uninstalls and exports them.

- **Import is two steps.**
  - **Import a mod file…** checks the whole file and shows everything in it before anything changes: the theme's colours and pictures, the card text, each widget as it will look, each effect with where it draws and what it hears, and **the custom CSS in full**. The author is shown as unverified.
  - Tick what you want, choose the agent it goes to, then **Install**. Only the ticked parts are applied, all at once. If any part fails, nothing changes.
- **Custom CSS is never ticked for you.** It reads "Custom CSS from this file — read it before turning it on". If you tick it, it becomes your own CSS on trial: **Keep** it, or it reverts after 15 seconds.
- **Where things go.** The theme, card text and agent widgets go to the agent you choose, as a person's choice (**Lock theme** and **Reset theme…** work on it as usual). A sidebar widget becomes yours. Custom CSS becomes yours only, as always.
- **The check is strict.** Every file must be listed with its SHA-256 and used by exactly one part. Paths are lowercase with no `..`. Each part is checked as its own feature checks it: theme contrast, picture types and sizes, widget specs, the custom-CSS rules, and effects.
- **Versions.** A mod's identity is its content. Importing another version of an installed name asks to **Replace** it. Up to 20 mods and 64 MiB can be installed.
- **Download** gives back an installed mod's file. The file is the whole bundle, including effects its import left out. So a file that carries effects downloads only for someone who may share every one of them: their own effect with the same content, or one a person shared. A file without effects downloads for any admin.
- **Uninstall** removes the mod from the list, and its effects from your library unless something still uses them. What it applied stays until you reset it.
- **Export a mod** makes a file from what is in force now: an agent's theme with its pictures and the effects it places, its card text and widgets, your sidebar widget, and your custom CSS with the files it names. An exported file imports as it is. **Only effects that are yours to carry away travel**: your own and ones a person shared. Someone else's private effect placed on that agent stays out, and the page says how many were left out. An agent's own export (`export_web_mod`) follows the same rule for the agent.
- **Agents' mods.** An agent can export its own look as a mod file (`export_web_mod`, written in its working directory) and propose a mod for you to review (`propose_web_mod`). A proposal shows under **Proposed by agents**: **Review** opens it into the same two-step import, and **Dismiss** drops it. A mod an agent proposes can never carry custom CSS, and agents never import.
- **Effects** in a mod need the effect runtime. Until this fleet has one, a mod that carries effects is refused with `effects_unavailable`.
- Mods are a signed-in person's action. They are never available over a temporary public link, and an agent's CLI token can't reach them.

## Reaching it from elsewhere

### Temporary public link from a phone

In the owning General, an admin can choose **Open temporary public link** from `/web` (Discord native slash; Telegram typed). Nothing is downloaded or exposed until that click. The bot DMs the link and code; Discord has an awaited ephemeral fallback. Telegram users must `/start` the bot privately first. No code is posted in General.

While it starts, the menu you clicked shows each step with its seconds, updated at most every 2 s (3 s on Telegram):

1. check cloudflared;
2. download it, in MB of the total;
3. verify it against the pinned version and SHA256;
4. start the tunnel;
5. wait for the public address to answer;
6. send you the link privately.

Steps 1–3 appear only when AgEnD's copy must be fetched; after the first time it is steps 4–6. A step that fails is marked with its reason, and running `/web` again retries. The menu shows only these words and numbers, never the link or the code.

It uses AgEnD's pinned, checksum-verified cloudflared, never an arbitrary executable on PATH. On Linux it is fetched from pkg.cloudflare.com first and from GitHub when that fails or is too slow; step ② says when it switches. macOS uses GitHub only. Only one tunnel can run; a public `/login` terminal shares that slot. The fixed lifetime is **two hours**, including startup; reuse does not renew it. Settings can set 1–480 minutes or disable the option. A private close button (two taps: Close link, then confirm; Cancel puts it back), a fresh menu, `/web revoke`, expiry and fleet shutdown close access. Unconfirmed child cleanup blocks another tunnel, but web access is already closed.

The separate gateway accepts only its current tunnel Host and reviewed panel routes. `/view` always requires sign-in there; SSE, `/health`, `/agent` and code issuance are excluded, and the preview frame is never served from it (previews have their own tunnel, see [HTML previews](#html-previews)). Chat polls immediately. Closing revokes that exposure's codes and sessions; local sessions stay separate. The host is ephemeral, never persisted in `allowed_hosts`.

This grants full web-admin access, including terminals, files, settings and host actions. Cloudflare terminates TLS and can see traffic. Do not forward the link or code. A confirmed public 🔐 notice in the owning General is required within five seconds before a session becomes usable, even with `notify_login: false`; platform outages can block sign-in. Public guesses can consume the shared sign-in breaker. A proxy you configure yourself needs its own protection.

### A connection you manage yourself

The server answers on `127.0.0.1` only. To use the dashboard from another device, give it a way in, and tell it the name it will be reached by.

1. **Pick a way in**, safest first:
   - **SSH port forward**: `ssh -L 19280:127.0.0.1:19280 <host>`, then open `http://localhost:19280`. Nothing changes on the fleet.
   - **Tailscale** (`tailscale serve`), or another private network.
   - **A reverse proxy or a tunnel** (for example Cloudflare). Prefer a named, access-controlled one over a public Quick Tunnel.
2. **Allow the name.** Any `Host` the fleet does not know gets 403; that is what stops DNS rebinding. Add yours:
   ```yaml
   web:
     allowed_hosts: [dashboard.example.com]
   ```
3. **Close `/view` to strangers:** set `web.view_access: session`, because `/view` shows your agents' terminals.
4. **Use HTTPS.** A proxy that sends `X-Forwarded-Proto: https` gets a `Secure` session cookie.
5. **Live updates.** Some paths cannot carry the live stream (Server-Sent Events): a Cloudflare **Quick Tunnel**, or a proxy that buffers responses. The dashboard notices when the stream stays silent for 15 seconds and fetches the same updates every 5 seconds instead. Nothing is lost or shown twice, and it switches back when the stream works again.

Whoever reaches the address still has to sign in with a code from you, and each sign-in is announced in General.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `health_port` | `19280` | The dashboard's port (on `127.0.0.1`) |
| `web.view_access` | `open` | `session`: reading `/view` needs a sign-in too |
| `web.allowed_hosts` | — | Extra `Host` names to answer to (behind a proxy, tunnel or port forward) |
| `web.notify_login` | `true` | `false`: don't announce new local sign-ins in General; public sign-ins always require a notice |
| `web.usage_panel` | `true` | `false`: no AI usage anywhere — no **Usage** button, no usage panel or dialog, and `/api/ai-usage` is not served |
| `web.preview` | `true` | `false`: no HTML previews at all (cards show the code and Download only) |
| `web.preview_port` | `health_port + 1` | The preview listener's port, on `127.0.0.1` |
| `web.preview_origin` | — | A separate host name, mapped to the preview port, for previews through a tunnel or proxy |
| `web.preview_on_public_link` | `true` | `false`: no previews over the temporary public link (no second tunnel) |
| `web.public_link.allow_public` | `true` | Offer the opt-in action; disabling also closes an existing link |
| `web.public_link.ttl_minutes` | `120` | Fixed lifetime from consent, 1–480 minutes; no renewal of an existing link |
| `web.public_link.protocol` | `http2` | cloudflared `http2`, `quic` or `auto` |
| `web.echo_to_channel` | `true` | Copy web chat messages to the instance's own Telegram or Discord topic |
| `web.session.local.absolute_hours` | `48` | How long a sign-in at the dashboard's own address lasts, 1–720 hours |
| `web.session.local.idle_hours` | `48` | How long it may sit unused, 1–720 hours and at most `absolute_hours` |
| `web_terminal.enabled` | `true` | `false`: `/login` refuses (no browser terminal) |
| `web_terminal.ttl_minutes` | `10` | How long a `/login` browser terminal stays open, 1–20 minutes |

**Settings → Web** edits `web.echo_to_channel`, `web.public_link.*`, `web.session.local.*` and `web_terminal.enabled` / `ttl_minutes`; it lists the others read-only (with `web.provider_secrets`, `web_terminal.bind` and `web_terminal.tunnel`).

Full reference: [configuration.md](configuration.md). CLI commands: [cli.md](cli.md).

## Security notes

- No credential is ever put in a URL: not the fleet token, not a code, not a session.
- Writes from a signed-in browser need the session **and** a per-session CSRF header **and** a matching `Origin`. The cookie alone cannot change anything. Scripts that send `X-Agend-Token` are not affected, since a browser never attaches that header on its own.
- Every panel carries a Content-Security-Policy: scripts, styles, images and connections are limited to the dashboard's own address.
  - Only the page's own script runs. It carries a fresh nonce on each load, and there is no `'unsafe-inline'` for scripts, so markup injected into a page cannot run code.
  - The same for styles: only the page's own stylesheet applies (no `'unsafe-inline'`), so injected markup cannot add inline styles of its own (it can still use the page's existing class names).

## When something is off

| You see | Why, and what to do |
|---|---|
| **403** when opening the dashboard through a proxy or tunnel | Its `Host` is not allowed: add it to `web.allowed_hosts`. |
| The sign-in page says the code is wrong | Codes are single-use and expire after 5 minutes, and only the newest works. Ask for a new one. |
| "Your session has ended" | 48 hours without use or since sign-in (the defaults), or someone revoked. Sign in again. |
| Updates arrive a few seconds late, with no live stream | The live stream is blocked on your path (or this is the public link), so the page polls every 5 seconds. Nothing to do — it is not shown as a problem. |
| A page looks wrong or something is hidden after you saved custom CSS | Add `?safe=1` to the address to load it without your CSS. Settings → **Web appearance** is never styled by it: fix the CSS there, or turn it off. |
| `/web` answers "disabled" | No fleet admins are configured for that bot: add your user to its `allowed_users`. |
| The browser's developer tools show a red **401** for `/auth/session` on the sign-in page | Expected: the page checks whether you are already signed in, and "no" is a 401. Nothing to do. |

### Windows/WSL: Linux responds but the Windows dashboard does not

If the dashboard stops opening from Windows after an update, first close the dashboard tabs to stop reconnect traffic. Compare the same configured port (19280 below) with explicit timeouts:

```sh
# Inside WSL
curl --noproxy '*' --max-time 5 -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19280/health
```

```powershell
# Windows
curl.exe --noproxy "*" --max-time 5 -sS -o NUL -w "%{http_code}\n" http://127.0.0.1:19280/health
```

Linux **200** with Windows **000** points to a forwarding/connectivity problem; a blank page alone does not establish that. Save the results and Windows/WSL versions. Repeated fleet restarts need not repair the forwarding layer.

AgEnD finishes SSE responses at shutdown, waits at most one second for ordinary HTTP work to drain, then closes remaining owned sockets. Updated pages receiving the shutdown hint wait 10–15 seconds before reconnecting and then use the normal capped backoff. Existing pages loaded before the update keep their previous retry policy until refreshed. This reduces open streams and retry traffic; it cannot guarantee recovery of a stuck Windows relay. The listener closes late, but the replacement still starts its instances before binding HTTP, so the entire outage can exceed one second. Abrupt exits cannot send the hint.

For recovery without interrupting the fleet, use an **already available, trusted SSH route to WSL**, bypassing Windows localhost forwarding. For example, in Windows, replace `WSL_SSH_HOST` with that existing SSH destination:

```powershell
ssh -N -L 127.0.0.1:19281:127.0.0.1:19280 WSL_SSH_HOST
```

Open `http://127.0.0.1:19281/signin` and obtain a fresh code with `/web` or `agend web`. The alternate port remains Windows-loopback-only; normal sign-in, Host and same-origin checks still apply. Close the tunnel when finished. An existing explicitly approved public link is another option. Do not expose the local listener to the LAN or disable authentication for this workaround. If no alternate route exists, keep using chat and ask the operator to plan maintenance; there is no guaranteed nondisruptive relay reset here.

For prevention, `wslinfo --networking-mode` inside WSL can identify the active mode where that tool exists. Missing output is **unknown**. Microsoft documents NAT localhost forwarding through wslrelay and a different architecture for mirrored networking. On supported Windows 11 22H2+ hosts, an operator may choose `networkingMode=mirrored` under the existing `[wsl2]` section of `%USERPROFILE%\.wslconfig`. This affects all WSL2 distributions and firewall behavior, and takes effect after a **planned WSL restart**, which interrupts their workloads. AgEnD makes no Windows configuration changes or WSL restart. Mirrored mode is an option, not a guaranteed cure.

Sources: [Microsoft networking](https://learn.microsoft.com/en-us/windows/wsl/networking#mirrored-mode-networking), [WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config), [WSL forwarding architecture](https://github.com/microsoft/WSL/blob/master/doc/docs/technical-documentation/localhost.md). Investigation and limits: [#1738](https://github.com/songsid/AgEnD/issues/1738).

### Confirming sensitive changes

Changing access/F/C lists, secrets, connection destinations/order, public exposure, control-bearing instance settings, or loosening a web setting (a longer local session or idle time, the browser terminal turned on or given more minutes) returns `202 pending_confirmation`. The requester can list/poll `GET /api/settings/pending[/:id]` and withdraw an unclaimed request with `DELETE /api/settings/pending/:id`. Other sessions receive 404. Polling is passive and does not extend sign-in lifetime; `remaining_ms` is the countdown, and the display timestamp is not an authorization deadline.

Confirm the redacted diff in General as a fleet admin. If chat is unavailable, use the host command `agend settings confirm <id>`; Reject, expiry or session revocation does not apply the change. Apply retries must reuse the same `Idempotency-Key` and body, which returns the same request. After a terminal failure, review and submit a new key; secrets must be entered again. In the web app, a request waiting for confirmation shows as a card in any panel, with its countdown and **Withdraw** (see [`/settings`](#settings)).

**Which bot's admin can confirm?** Changes to existing connections require the
admin of every affected connection, including both owners when an agent moves.
A shared token requires every connection that uses its environment key.
Fleet-wide changes and new connections require the configured primary General's
bot admin (the first configured General if the primary bot has none). A mixed
change requires both sets of permissions. Moving the prompt to another General
does not give that bot's admins permission to confirm; admin membership is
checked again before applying. Cross-platform or unknown targets require host
CLI confirmation. First-time Setup still uses host confirmation.

First-time Setup also returns a pending request. Confirm it on the host, then explicitly choose **Start AgEnD**. A pending response, an old successful commit or a changed configuration cannot hand over the setup listener to the fleet.
