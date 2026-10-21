# The web dashboard

中文版：[web-dashboard.zh-TW.md](web-dashboard.zh-TW.md)

The dashboard's browser tab uses the Silver **Ag** mark on Chat, View, Settings and the sign-in page, including temporary public links. The same mark is available as an apple-touch icon when you save the page to a phone's home screen. Icons are bundled and served from the dashboard itself; loading them requires no sign-in.

AgEnD's web dashboard is three panels on one small web server that the fleet runs for you:

| Panel | What it is for |
|---|---|
| **`/ui`**: the app | Talk to your agents (chat, files, Stop reply), see who is working, and manage instances, tasks, schedules and teams. Each chat has its own address, `/ui/chat/<name>`; Fleet is `/ui/fleet` (`/ui/fleet/schedules`, `…/teams`, `…/org`, `…/cache`, `…/usage`, `…/config`); **Needs you** is `/ui/needs` |
| **`/view`** | A read-mostly view of every agent: live terminal, roster, usage, and editing each agent's profile and avatar |
| **`/settings`** | Fleet settings — your preferences, web appearance, agents, connections, ClassicBot, defaults, `fleet.yaml` — with apply and restart. Each section has its own address: `/settings/device` (Preferences), `…/appearance`, `…/bots`, `…/classic`, `…/general`, `…/web`, `…/advanced` (`/settings` is Agents) |

`/ui`, `/view` and `/settings` are one app with a sidebar: **Fleet**, **Needs you**, **Search**, the instances, **Settings** and the **Session** menu. An agent's **View**, **Log** and **Details** are the tabs under its header. Moving around inside it does not reload the page, and Back/Forward work. `/` opens `/ui`, which goes back to the chat you had open last. Old links of the form `/ui#instance=<name>` still work, also through signing in.

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

**Send me a new code.** A browser that signed in before with a code from `/web` shows this button on the sign-in page, so you do not have to go back to chat. The new code goes by DM to the person who received that earlier code, never into a group, and only while they are still a fleet admin. The DM names the browser and whether it asked through the public link or the local network. Like any new code, it replaces the previous one, including one `/web` sent a moment ago. It can be asked for once a minute and five times an hour per browser (and once every 20 seconds, 20 times an hour, for the whole fleet). It is not available while sign-in is paused after wrong codes. A code from `agend web` does not make a browser eligible. On a public link the button only works while that same link is open, and the sign-in is announced in General as usual. `/web revoke` and `agend web-token rotate` remove the button from every browser.

An old `?token=` link or bookmark (`/ui?token=…`, as older versions printed) is **not** a way in. It opens the sign-in page, and the token is removed from the address bar.

## Sessions

- A session is a record on the server, not a value in your browser. By default it ends **48 hours** after sign-in, or after **48 hours** without use, whichever comes first — on the dashboard reached directly these two can be set with `web.session.local.absolute_hours` / `idle_hours` (up to 720 hours; see [configuration](configuration.md)). Local sessions survive a fleet restart. Public sessions are scoped to one exposure: four-hour absolute / 30-minute idle limits, and link closure also ends them. They cannot be used locally or on a later exposure; local cookies and header tokens cannot be used on the public host.
- Only what you do counts as use: opening a page or a chat, sending, changing something. What a page does on its own timer never does: the live stream (also when it reconnects), the polling fallback, and `/view`'s terminal, roster and usage refresh. So a tab left open, including `/view` with `web.view_access: session`, still ends after its idle limit (48 hours locally unless configured, 30 minutes for a public session).
- When a session ends, the page says so once ("Your session has ended. Sign in again") and keeps what you were doing on screen.
- **The Session menu** (at the bottom of the sidebar) shows:
  - which browser you are signed in as, and when the session ends (a time of day: "Ends by … at the latest, or after … unused");
  - when more than one browser is signed in: every signed-in device (this one marked **This device**, the others with **Sign out**), and **Sign out everywhere**.
- At most 8 sessions are kept; signing in a ninth drops the one used least recently.

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
- A message you send from the web is echoed into the topic as `🌐 web · <your name>: …` (see *Who the agent sees* below).
- The agent's reply goes to Telegram/Discord as usual and also appears here.
- You can switch between the web and your phone mid-conversation.
- **Switching chats:** the last 12 chats you opened (6 on a phone) come back at once, where you left them; when they hold more than 2,400 messages in all, fewer are kept. The least recently opened goes first, and a favourite only after every chat that isn't one. A chat you only pass through on the way to another (open for under a second, as when clicking down the list) is not kept, so it never pushes out the ones you use; and the last click always wins: what a chat passed on the way was still loading is dropped. A chat you have not opened for a while is drawn again, and nothing on screen moves as it fills in: photos keep their size from the start.
- **No chat platform at all?** With no `channel` / `channels` in `fleet.yaml`, the dashboard alone is enough: an agent's replies come to the web chat.
- **A tour, when you want one.** **Settings → Preferences → Chat tour** opens an agent's chat (the last one you had open) and points out the agent list, files, Stop and the *needs you* badge. It never starts by itself. With no agent to open, it says so.

### Who the agent sees (#1827)

- **Signed in with a code from `/web`:** the code was sent privately to your Discord or Telegram account, and this browser is that account to the agent. Your web messages arrive as `[user:<name> via web, id:<your user id on that platform>]`. An agent that knows you from Discord or Telegram recognises you, and `via web` says where you wrote from.
  - **The name:** your account's display name at sign-in, unless you choose another under **Settings → Preferences → Your name**. The choice follows you to every device you sign in on, the public link included. The id never changes with the name.
  - **Name rules:** 1–32 characters of letters, digits, spaces, single emoji and `. - _ ' ·`. A name can't contain the word "via", and can't be a name AgEnD reserves or an agent's or bot's name here.
- **Signed in otherwise** (an `agend web` code, or a session from before 2.2): `web-user`, as before. You can still set a name for those messages; signing in once with a `/web` code makes this browser your account.
- **Agents act on your ordinary requests as you** (#1939): questions, looking things up, analysis, and work in their own scope. A **go-ahead action** — a release or publish, anything destructive or irreversible beyond the agent's own work, spending beyond normal work, credentials or secrets, or giving another agent your authority — needs your account behind it, because an open browser doesn't prove who is at it: authorize this browser, or confirm in Discord or Telegram. Until then, a #1756 human-authorization receipt never names a web message as your account.
  - **Authorize this browser** (in the one row under the composer, bottom left: **Not verified · Authorize**; or in the session menu) and confirm the card in your Discord or Telegram DM. Your messages then arrive as `[user:<name> via web (verified), id:<your user id>]`, and their receipts carry your account's authority (`authority.kind: web-verified`): an agent checks and relays them exactly like a message you sent on Discord or Telegram.
  - It lasts until the authorization runs out (`web.verified_authority.max_session_hours`, default 48), you sign out, or web authority is revoked. Never on the public link or for a guest.
- **The same name is used** in the topic echo, a ClassicBot room's log, reply-button choices, poll results, tasks you create or claim, and web `/steer` and `/btw`.
- **Polls:** your web vote is your account's ballot, the same one as your vote on Discord or Telegram.

### The layout
- The conversation is one centred column. Your messages are bubbles on the right; an agent's replies use the full column, each with **Copy**.
- **Code blocks** show their language, with **Copy** and **Wrap** (long lines wrap instead of scrolling; remembered for this browser). A block longer than 30 lines is folded: **Show all N lines** opens it.
- **Discord server emoji** written as `<:name:id>` (or `<a:name:id>`) show as the emoji's picture when it belongs to a server the fleet's Discord bots are in; AgEnD fetches it once and the dashboard serves it, so the page never loads Discord. Any other one, or one whose picture can't be loaded, reads `:name:` (never the raw markup or an empty box).
- **Emoji** in any message are drawn by your system's colour emoji font (Segoe UI Emoji on Windows, Apple Color Emoji on macOS, Noto Color Emoji on Linux), whatever the agent's theme font — never as boxes. On Linux, install a colour emoji font (for example `fonts-noto-color-emoji`) if you see boxes everywhere.
- **Mentions** show as Discord does: `<@id>` (or `<@!id>`) becomes **@name**, a role `<@&id>` **@role name**, a channel `<#id>` **#channel**, with the id on hover. Names are the ones AgEnD already knows (the fleet's bots, people who wrote to it, the Discord servers its bots are in); an unknown one reads **@user** (or @role, #channel). A Telegram **@username** gets the same look. Nothing inside code is changed.
- The view follows new messages only while you are at the bottom. Scrolled up to read, it stays where you are, and **↓ N new** takes you down.
- The sidebar button at its top hides it (☰ brings it back); the choice is remembered. On a phone the sidebar is a drawer: ☰ opens it — or swipe right across the conversation — and choosing something, tapping outside it, swiping it left or Esc closes it. (A swipe that starts at the very left edge stays the browser's back gesture, and swipes on code, tables, the terminal or the message box are left to them.) A phone also has tabs along the bottom (Chat, Needs you, Fleet, Settings); they make room while the keyboard is open. **Chat** is the current tab on any page of an agent (its Chat, View, Log or Details) and goes to that agent's chat.
- The header shows the instance's name and state, the **Chat / View / Log / Details** switch, **Text size** and **Usage** (the same two, in the same order, on Chat, View, Log, Details and Fleet). **Text size** goes S → M → L and is one setting for this browser: chosen on any page, it is the size on every page and after a reload. **Usage** is AI subscription usage: on a wide screen (1200 px and up) it is a panel on the right beside the page, hidden until you open it: **Usage** (or the panel's ✕) shows or hides it, remembered on this device; on a narrower screen **Usage** opens it as a dialog. Its **⋯** menu holds **Instance details** (the Details page) and the instance's own actions, and only the ones that fit: **Start** for a stopped instance; **Restart** and **Stop instance** for a running one; **Delete** last, behind typing its name.
  - **A failed read keeps the last numbers** (#2236 follow-up). When a provider's read fails (an expired token, a rate limit, a network blip or any other error), its row keeps the numbers from the last good read, up to a week old.
    - The numbers are greyed, and a line says why and when: **expired · cached at 14:05**, **not updated · cached at …** or **couldn't read · cached at …**.
    - For an expiry or another error, a second line says what to do.
    - A window that has reset since shows **reset since …**, with no number.
    - A provider never read successfully still shows its error, and a good read clears the mark.
- **Theme** and **Language** (**Settings → Preferences**; on `/view` without signing in, the ☀ button beside **Sign in**, for that browser only): *System* follows each device's light or dark setting; *Light* or *Dark* fixes it. The language applies to every panel.
- **Who has replied (#2179).** Each row shows when that agent last replied to a person (through its reply tool, on a channel or in the web chat; cross-instance messages don't count): its name and context % on the first line, the time at the end of the second ("just now", "2 min ago", "3 h ago", "yesterday"). A reply less than 10 minutes old is highlighted, and the highlight fades by itself: there is nothing to mark as read. The times move on every 30 seconds, and a new reply shows within about 10 seconds (the next status update).
  - **Sort:** the button next to **Edit** says how the list is sorted. **Custom** (the default) is your own order: a reply never moves a row. **Recent replies** lists everything else by its last reply, without groups; your favorites stay pinned in your order, or, if you choose **Sorted by last reply too**, sort the same way. Drag reordering pauses while it is on. The choice follows you across devices.
  - Guests see no reply times and no sort. The anonymous View page has no reply times either, so its list is always in your Custom order.
- **How the sidebar groups instances (#2172).** An instance in a team (fleet.yaml `teams.<name>.members`) is listed under its team, whatever its tags; one in several teams under the first. One in no team is listed under its first tag, a ClassicBot room under **Classic**, and the rest under **Other**. Teams come first, then tags. Each heading shows what it is: a team's icon, or **#** before a tag (a tag named like a team is a group of its own). **Settings → Agents** groups the same way.
- **Each instance in the sidebar** is called by its display name, with its instance name on hover (and under the display name when two instances share one). Its picture is, in this order: the one uploaded in View (**Edit profile**), its own bot's avatar when it has a bot of its own (the General bot counts when General is the only one using it), else the avatar of the bot it talks through (usually the General bot), its persona emoji, or its first letter. Each instance has an [identity colour](#identity-colours), shown by default on its name, as a bar at the row's left edge and as a ring around its picture. The dot on the picture is its state — idle, working, looks stuck, paused (hollow), stopped, crashed or needs you — and says so to a screen reader too. Pictures and server emoji are fetched by AgEnD on this computer and served by the dashboard itself; the page never loads Discord or Telegram. The filter finds an instance by either name. While a filter is on, the instance you have open stays at the top under **Current**, whether it matches or not, so you never lose the one you're talking to; the count still counts only the matches, and clearing the filter puts it back in its place.
  - A display name set in View (**Edit profile**) wins over one the agent sets itself (`set_display_name`). Clearing it in View shows the agent's own name again (or the instance name).
- The bottom of the sidebar is one row: **Settings** and **Session**. **Settings → Preferences** holds your name, theme, language, whether nicknames or real names come first, HTML previews and the tour.
- **Favorites (#1664).** Star an instance to pin it in **Favorites** at the top of the sidebar, in the order you starred them. On a desktop the ☆ appears when you hover over or focus a row, and stays on starred ones. On a phone, tap **Edit** above the list. **Edit** also shows ↑ ↓ to reorder favorites. A deleted instance drops out; a paused or stopped one stays. At most 50.
- **Preferences follow you across devices (#1665).** Theme, language, the name order, the sidebar's order, folded groups, filter and favorites, HTML previews, and the Web appearance choices (agents' themes shown, card size, your sidebar widget, identity colours) are saved on the AgEnD host, so your phone and your desktop match. A change shows up on your other devices at once, or the next time they load. Each browser keeps a copy and the page arrives with your theme already applied, so nothing flashes. The first time a device loads after the update, it uploads its own choices for anything not saved yet; after that, what is saved on the host wins. The tour, text size, view fit, the sidebar shown or hidden, panel widths, code wrap and desktop notifications stay on each device. A public link can read your preferences but cannot change them.
- **On a phone** the on-screen keyboard resizes the page, so the composer stays above it, and the layout keeps clear of the notch and the home bar.

### Keyboard and screen readers
- **Esc** stops the agent's reply while it works, as Esc in its terminal would. It does nothing while it is idle or when a form or menu is open: Esc closes that first.
- The sidebar's rows are links: **Tab** reaches them and **Enter** opens one (a middle click or Ctrl+click opens it in a new tab). On a phone, the rest of the page cannot be reached while the drawer is open.
- Messages are not read out as they arrive. A screen reader hears the coarse events once each: the agent started, finished, replied, or is waiting for your input. The conversation itself is a log to browse.

### Writing

**Paused agents.** Sending a message wakes a paused instance, including a ClassicBot room. The composer shows “Waking…” until delivery. If waking is refused (for example, no warm slot is free), the page explains why, keeps your text and files, and offers **Retry send**. Retry never runs automatically. A stopped instance still needs to be started; opening history or attaching a file does not wake it. Guest and public-link send permissions are unchanged.

- **Enter** sends; **Shift+Enter** adds a line. If sending fails, your text is given back.
- **Reply to a message (#2272).**
  - **Starting a reply:**
    - **Desktop:** hover a message and press **↩** at its top right, or right-click it for **Reply / Copy text / Copy link**. Shift+right-click, or right-click over selected text, still gives the browser's own menu.
    - **Phone:** swipe left on a message (as in Telegram), or long-press it for the same menu. A swipe right still opens the drawer, on a message too.
    - **Keyboard:** **R** on a focused message.
  - **While replying:** a bar above the composer reads "Replying to *sender*" with the first words, or [Photo] / [File]. **✕** or **Esc** cancels it.
  - **The sent message** shows the quote above it. Click the quote to jump to the original and flash it; if the chat no longer keeps it, the page says so.
  - **What the agent gets:** the same `(reply_to: "…")` line as a Discord or Telegram reply. The server reads it from the quoted message: one line, at most 500 characters.
  - **Who can reply:** you can reply only to a message this chat still keeps. A guest can reply only to messages it can see. A guest who sees a reply to a message it can't see gets "an earlier message" in place of the quote.
  - **The web echo** to Discord or Telegram starts with "↩ *sender*: *first words*" when the quoted message was already in that channel. A web-only original is only named ("↩ an earlier web chat message"), never copied out.
- **The row under the composer** is one line at the bottom left: this browser's web authority, then the key hint (`✓ Verified · Enter to send · Shift+Enter for a new line`). When it ends ("speaks as you until …") is in the tooltip of **✓ Verified**; on a touch screen, tap it. A guest sees their note there, and the temporary public link says why it can't authorize. On a phone the key hint is left out.
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
- Files the agent attaches to its reply show in the chat. Images show inline, and video and audio play inline. Markdown, CSV/TSV, JSON, code and text files get a **Show** card (200 lines, then **Show all … lines**; over 1 MiB, download it to read it). Anything else is a download, never opened in the page. Over the temporary public link only images show inline.
- **Clicking a chat image** opens it full size over the chat (a modifier-click opens the file as the browser does). It opens fitted to the window. To read the detail of a big picture:
  - **On a computer:** the wheel zooms around the pointer. Once the picture is larger than the window, the plain wheel scrolls it and Ctrl/⌘+wheel (or a trackpad pinch) zooms. Click the picture for **100%** at that spot, and click again to fit. Drag to move around. **Fit width** (or `W`) spans a tall picture across the window to read it by scrolling. The toolbar shows the zoom level (click it for fit / 100%) between **−** and **+**. The keys are `+`, `-`, `0` (fit), `1` (100%) and `W`. The arrows step between a message's images, and Esc closes.
  - **On a phone:** pinch to zoom, drag with one finger to move, and double-tap for 100% at that spot (again to fit). A tap on the dark area closes it.
  - Every image opens fitted, and stepping to the next one fits it again. The same viewer shows images in replies and on the temporary public link.
- The chat keeps its own copy of each reply file (`<AGEND_HOME>/workspaces/<instance>/web-files`), so the file still opens after the agent changes or deletes its original, or the fleet restarts. A symlink, a file over 50 MB, or a file inside the AgEnD state folder (other than inbox/) is not shown. A copy is deleted when its message leaves the chat history; each instance keeps at most 1 GiB of copies, and above that the oldest go first.
- An attached file that is **not sent within 30 minutes** is deleted. After a fleet restart, any such file left over is removed at startup once it is 30 minutes old.
- Files that were sent stay in the inbox for **7 days**, like files from Telegram.

### HTML previews
When an agent's reply contains a ` ```html ` block, or attaches a `.html` / `.htm` file, a card under it can run that HTML for you.
- **Files and blocks work the same.** A file's card sits under the reply's files. Its HTML is read from the fleet only when you click **Preview** or **Open in panel**, and it runs in the same sandboxed frame as a block. The file is never opened on the dashboard's own address. **Download** is the file's own link above the card. A file the fleet no longer has (its copy was removed to stay within the limit, or it was sent before AgEnD kept copies) says so; ask the agent to send it again.
- **Up to 1 MiB.** A block or a file over 1 MiB (as UTF-8) gets no preview. A file's listed size is checked before anything is read, and its bytes are checked again after. Files are read as UTF-8.
- **Off until you turn it on.** Use **Allow HTML previews** in **Settings → Preferences**, or the card's **⋯** menu. It asks once and says what it means. The choice is saved on the AgEnD host, so it applies on every device signed in to it (never on the public link). Turning it off stops every running preview.
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

**Reactions.** A message that only needs an acknowledgement ("OK", "thanks") may get one from the agent: an emoji (👍, 👌, 🙏…) under your bubble instead of a reply, as on Discord and Telegram. It appears at once, and also after a reload or on another device. When your message was copied to the agent's Discord/Telegram topic or room, the copy gets the same reaction. A reaction is a complete answer: the chat does not say the agent ended its turn without replying.

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

**One instance's Details** (`/ui/fleet/agent/<name>`) is the Fleet side of that instance: its runtime (backend, model, effort, cost, context, 5-hour and 7-day limits), its recent activity, a read-only summary of its configuration (display name, description, directory, where it is bound, tags), with **Edit in Settings** to change it, and its work on the task board (its cards, as on the board's **Instances**; a card opens on the board). Its ⋯ menu starts, restarts, stops, pauses or wakes it, with the same calls and confirmations as the chat's ⋯ menu and Settings; deleting an instance stays in the chat's ⋯ menu and Settings. A ClassicBot room's Details shows its room instead of a directory, offers only pause and wake (as Settings does), and **Edit in Settings** opens its ClassicBot settings. An instance with no connection of its own is shown on the fleet's first connection, where it is bound by default.
- On an instance page, the header switches between its **Chat**, **View**, **Log** and **Details** (tabs under the header on a phone); the instance stays the same. Someone reading View without signing in sees no switch.
- **Fleet** (at the top of the sidebar, and the phone's Fleet tab) opens the Fleet tab you used last on this device (the Org chart the first time); an instance's Details is the **Details** tab under its header. On Details, an instance in the sidebar opens its Details (on View its View, on Log its Log); on a Fleet tab (the overview, Tasks, …), its Chat.
- **Tasks**: the task board ([features](features.md#on-the-dashboard-fleet--tasks)). Its projects and what waits for you (**Confirm**, **Send back**, **Answer**); a project's main tasks by status (drag to move, filter by assignee, open up sub tasks); a card in a drawer from the right (on a phone, a sheet from the bottom) with every field editable, its sub tasks, comments, progress log and history. Only a signed-in person confirms finished work. Cards are cancelled, not deleted. Alt+arrows on a card's title move it without dragging. A main task's tile shows who works on it now; a card waiting for you that is not wrapped up says **To fill in**, and Confirm asks first. **Instances** (beside the search) lists every instance by team, working ones first, each with its cards as its `task mine` reads them: in progress, blocked, waiting for you, the main tasks it coordinates, what it can start and what waits for other cards; a card opens from there. Over the public link the board is read-only, and instances kept out of sight are not listed.
- **Schedules**: every schedule, silent ones included, with when it runs in words and its next run. **New schedule** (Repeat with a cron expression, or Once at a date and time), **Edit** (its **Enabled** box is how you pause one) and **Delete**. There is no "run now", and whether a schedule is silent can't be set here. Over the public link schedules are read-only.
- **Teams**: **New team**, **Edit** (members and description — the same update as the `update_team` tool) and **Delete**. A team cannot be renamed — create a new one and delete the old. Over the public link teams are read-only.
- **Org chart** (`/ui/fleet/org`; **Fleet** at the top of the sidebar, or of the drawer on a phone, opens it from any page the first time, then the Fleet tab you used last): General at the top, then the teams from `fleet.yaml`, then the instances in no team.
  - **Canvas** (the default) or **List**, remembered on this device.
  - The canvas: drag to pan, the wheel or a pinch to zoom, **Zoom in / Zoom out / Fit to screen**, and the keys `+`, `-`, `0` (fit) and the arrows. **Overview** (bottom right, not on a phone) shows the whole chart: click to move there. A team's header folds it (remembered on this device). **Find** dims what doesn't match; Enter unfolds and goes to the first match. A card shows the picture, state, name and backend; clicking it (or Enter) opens the chat.
  - The list shows each instance's display name, what it does, its backend and model, its live state (working, idle, needs you, looks stuck, paused, stopped or crashed), a link to its Discord thread or Telegram topic, and **Open chat**.
  - **Live** (on by default) draws messages between instances as they travel (#1918). **Key** (in the toolbar; open, its strip sits above the canvas, never over it) explains the lines: the colour is the kind (delegate_task, send_to_instance, report_result, broadcast) — dotted while queued, moving while it is delivered, fading for 12 seconds once delivered or read. **×N** means several share a line; zoomed out, lines join whole teams. A `delegate_task` also draws the work: a slow-moving line from the delegator to the worker stays **in progress** until the worker's `report_result` (same correlation id) comes back, then one line returns and it goes; one with no report after 4 hours fades as **no report yet**. A reload or the public link shows the open ones too. Every line ends on a card or a folded team's box, and two cards in one box are joined inside it. No message text is ever shown, and an instance with `cross_instance_visibility: hidden` is left out. On the public link it refreshes every 5 seconds.
  - **How the lines run (#2182):** each line goes from card to card around the other cards, through a gap in a team's border (never along it, never across a team's name), by the shortest clear way; lines that share a stretch are drawn apart (in a crowded gap they can run closer), and an arrowhead never sits on a border. Zoomed out, and in a browser that cannot run the router, lines follow the gaps between the teams as before. The router is [libavoid](https://www.adaptagrams.org/) (via `libavoid-js` 0.4.5, LGPL-2.1-or-later, an npm dependency AgEnD serves unmodified); it runs in a worker of its own, the only part of the dashboard that may run WebAssembly, and that worker can reach nothing.
  - The chart only shows: you act in Discord, or from the chat.
- **Cache** (`/ui/fleet/cache`): how often each Claude Code and Codex instance's prompt cache expires between requests over 24 hours, 7 days or 30 days, what rewriting it costs, and whether a keep-warm ping would pay off.
  - It reads the transcripts on the machine, never a vendor API, and keeps a small summary per instance (`cache-ledger.json`).
  - Costs are list prices from one table; the date they were checked is shown.
  - Where a transcript records cache writes, those are used. Where it does not (some Codex sessions), the rewrite is estimated from the uncached input, and the numbers are marked as estimates; so are they when the cache lifetime had to be assumed.
  - Kiro shows "Not available (credit-billed; no cache data)"; so do other CLIs AgEnD has no cache data from.
  - **Cache writes 5 min / 1 h:** each Claude instance shows how many tokens it wrote with a 5-minute TTL and how many with a 1-hour one (#2001).
  - **Behaves as (#2010):** what a 5-minute cache really lasts, measured from the last 7 days of gaps between requests of 5 to 60 minutes.
    - Rarely rewritten (at most 10% of at least 10 gaps): it counts as 1 hour, and keep-warm is simulated so.
    - Mostly rewritten (at least half): the card recommends setting `prompt_cache_ttl: "1h"` for that instance (see [configuration](configuration.md#claude-prompt-cache-ttl)) instead of keep-warm. The fleet row counts such instances.
    - Too few gaps: it says so, and the figures are marked as estimates.
  - Agents read the same report with `get_cache_report`. General, coordinators and full-profile instances see every instance; any other agent with the tool sees only its own row (the `minimal` tool set has none).
- **Usage** (`/ui/fleet/usage`, #2122): each agent's tokens, requests, delivered messages and their **API-equivalent at list price — not money spent** (subscriptions aren't billed per token), over today, 7 days, this month, all, or custom days in the fleet's timezone. The ◔ usage dialog links here (**By agent →**).
  - **Rows** are ranked by the API-equivalent (by tokens where nothing is priced), each with a bar, input / output / cache read / cache write / total tokens, requests and messages, and its backend, models and credential profile. Group them by agent, backend, model, credential profile, or team (teams as configured now).
  - **Marks in words:** Codex records no cache writes, so they read "not reported" (an estimate), never 0; a model not in the price table shows its tokens and "not priced"; hours read before this release say their backend and profile weren't recorded. Kiro and the other CLIs AgEnD can't read are listed below with the reason, never as $0. Claude subagent (sidechain) turns aren't counted yet.
  - **Trend and heatmap:** a stacked daily chart of the top 5 agents and the others, and a calendar of daily totals where a day read with nothing used (grey) is told apart from a day not collected (dashed). Both are described in text, so colour is never the only cue.
  - **CSV:** **Download CSV** saves the shown answer's daily rows (date, zone, agent, backend, model, tier, profile, the token columns, requests, amount, the basis and the marks; messages on rows of their own).
  - **Freshness:** collected from when the fleet started (kept 400 days) and read every 10 minutes; while the reader catches up the page says totals may still grow. It never re-reads on a timer.
  - **Not everything at once:** when a long range has more daily rows than one answer carries, the page says from which date the trend, the heatmap and the CSV start; the rows and totals still cover the whole range. A day used only by a model not in the price table is shown as used ("not priced"), never as a day with nothing used. If the fleet's timezone changed, days keep the zone they were made in and the page says so; a day made in both shows each part.
  - **Who sees it:** signed-in sessions; never a guest. Over the temporary public link it says "Not offered over the public link" unless **Settings → Web → Usage report over the public link** is on (`web.usage_report_on_public_link: true`, [configuration](configuration.md); it applies at once), with a link to that switch on the dashboard reached directly. `web.usage_panel: false` hides it with the rest of usage. Agents read the same report with `get_usage_report`.
- **Config**: the fleet's channel, access and defaults.

## Needs you (`/ui/needs`)

Everything waiting on you, from every bot's world, in one list: a fleet prompt (not responding, exited, waiting at its terminal), an agent stopped at a permission, a dangerous command, a sign-in or another dialog, an agent paused for sign-in or crashed, a delivery the fleet could not confirm or deliver, and a task board card waiting for your confirmation or blocked on a question (**Open the card**). It is the same list as each bot's live **Needs you** message in General (there, each bot shows only its own agents). Something handled anywhere, in Discord, Telegram or here, leaves every list.

- **Needs you** in the sidebar (and a tab on a phone) shows how many things are waiting; the browser tab's title starts with `(N)`.
- The list is grouped by agent, oldest first. A prompt has its own buttons; a delivery has **Acknowledge**; an agent paused for sign-in has **Sign in** when the dashboard can run its login (#2233); every item has **Open chat**.
- **Notify me on this device** shows a desktop notification when something new needs you while the tab is in the background (a terminal wait only once it has lasted 5 seconds). It is per browser, asks for permission when you turn it on, and needs a secure address: `127.0.0.1`/`localhost` or the HTTPS public link, not a plain-HTTP LAN address. It is not offered on phones: there, the Discord notification (a new post in General, and the optional DM) is the one to rely on.

## Search (Ctrl+K)

Find who you asked about something: one search over every agent's chat (Discord, Telegram and the web, as the fleet recorded them), the messages agents send each other (send_to_instance, delegate_task, report_result, broadcasts) and the Task Board. An agent's own terminal transcript is not searched; that is its **Log**.
- **Opening it:** **Search** in the sidebar (under **Needs you**, with its shortcut), **Ctrl+K** (**⌘K** on a Mac) anywhere, or the 🔍 button in the header when the sidebar is hidden and on a phone. **Ctrl+F** (**⌘F**) in an agent's chat opens it narrowed to that agent; everywhere else Ctrl+F stays the browser's find. The sidebar's **Filter** box is something else: it filters the agent list by name, model or backend.
- **Typing:** results come as you type (after a short pause), grouped by agent, newest first, each with **Chat**, **Message** (between agents, shown as sender → target) or **Task**, and the words you typed marked. Words of 1–2 characters work too (Chinese included); on their own they search the newest 5,000 entries, and the dialog says so. With nothing typed it shows your recent searches (this browser only).
- **Keys:** ↑↓ move, **Enter** opens, **Esc** or a click outside closes. **Filters** folds out: an agent, a team, a time (24 hours, 7 days, 30 days), which kinds, and **Only mine** (messages you wrote).
- **Opening a result:** a chat message opens its agent's chat at that message, flashed. A chat message the chat no longer keeps, a message between agents and a task open as the copy search kept (a chat message with the ones around it), with the chats to go to or the Task Board.
- **What it keeps:** its own index (`search.db` in the AgEnD home), filled from what the fleet already has the first time and then as things happen, kept `web.search.retention_days` (90 by default). Secret values are masked before anything is kept. A message's verification ids, working directory and branch are never kept. A message to or from an agent whose `cross_instance_visibility` is `hidden` is not found.
- **Who can use it:** fleet admins signed in to the dashboard reached directly. Never a guest, and never over the public link: there is no Search row, button or shortcut there, and Ctrl+F stays the browser's find. `web.search.enabled: false` turns it off ([configuration](configuration.md)).

## Undo and redo in text fields

Every box you type in (the composer, search, the sidebar filter, Settings, the Task Board, the CSS and YAML editors) has its own undo history.
- **Keys:** **Ctrl+Z** undoes, and **Ctrl+Shift+Z** or **Ctrl+Y** redoes. On a Mac use **⌘Z** and **⌘⇧Z**. The keys only work while you are typing in a box; anywhere else they do what the browser does.
- **One box at a time:** undo in one box never changes another. (The browser's own undo is one stack for the whole page.) Typing is undone a word at a time, or back to a pause. While an input method (IME) is composing, the keys are left to it.
- **What the page puts in a box can be undone too:** a completed `/command` (Tab) or a filled-in argument, a failed send's **Put back**, a long paste brought back with **As text**, a recent search picked, the sidebar filter cleared with Esc or ×, a status emoji picked or reset, a widget example, and a restored CSS version. A colour swatch is a choice, not text: picking one starts the hex box's history afresh.
- **The browser's own Undo** (its Edit menu or a right-click) goes through the same history. Its own Redo is only offered after its own undo, so use the keys to redo.
- **What cannot be undone:** a sent message never comes back into the composer, so there is no accidental resend. Text cleared after Add or Send, and values reloaded after Save, start a fresh history. Password fields keep the browser's own behaviour.

## Log (`/ui/log/<name>`)

What an agent did, step by step: what it was asked, its replies (never its thinking), each tool call (Read, Edit, Search, Run, Web, MCP, Sub-agent, …, with **Show output**), errors, the end of each turn, compactions, and fleet events such as a crash and restart.
- **All / Tools / Errors** filter it; **Live** shows while it updates.
- It opens with the newest 200 steps; **Load older steps** adds 100 at a time, and the page keeps up to 1000.
- It is off until a fleet admin turns it on: `web.log_tab` (**Settings → Web → Log tab: each agent's steps**), or **Turn on the Log** on the tab itself, which waits for a fleet admin's confirmation.
- Claude Code shows everything, also after the instance stopped; Codex while it runs; kiro shows the fleet events only. Other CLIs say they have no transcript AgEnD can read. Secret values are masked.

## `/view`

`/view` shows every agent: the live terminal capture, the roster with each one's state and context, and AI subscription usage. Each agent has its own address, `/view/<name>`; `/view` alone opens the one this browser looked at last.

- **The roster is the sidebar** while View is open (on a phone, the drawer): grouped as the sidebar is (team, then tag), with the filter at the bottom (**/** jumps to it) and your own order (drag a group or an instance). Rows show the context in use and the backend's colour; hover for the rest.
- **The header** has **Text size**, **Usage** and **Help**. On View the size goes Fit → S → M → L: **Fit** (the default) sizes the terminal to fit its box, never larger, down to a 6 px floor. S / M / L are the size every page shares. Choosing a size on another page keeps View on Fit; only View's own Text size leaves it. The terminal stays dark in both themes.
- **The card under the terminal** shows the agent's name, role and model; its arrow opens the whole profile. **Edit profile** changes the display name, role, description and avatar. **Remove picture** (shown when one is uploaded) goes back to the bot's avatar, the persona emoji or the first letter when you save.

- **Reading `/view` needs no sign-in by default** (`web.view_access: open`). That includes every agent's live terminal, with no account and no limit to some agents. The dashboard listens on `127.0.0.1` only, but "anyone who can reach the port" covers more than you:
  - every other user and process on the machine;
  - anyone a reverse proxy, a tailnet share or a port forward you set up lets in (`web.allowed_hosts`);
  - on WSL2, the Windows side.

  On a machine only you can reach, that is fine. Otherwise set:
  ```yaml
  web:
    view_access: session   # reading /view needs a signed-in session too
  ```
- **Signed out, `/view` is View alone:** the sidebar has View and **Sign in**, nothing that needs a session is shown or read, and **Sign in to edit** takes you to the sign-in page and back.
- **Editing an agent's profile or avatar always needs a session.** The order of the roster is one of your synced preferences (above); an anonymous reader's stays in that browser.
- Scripts can still write with the `X-Agend-Token` header.

## `/settings`

**Connections → Retry now** asks a disconnected connection to try again immediately, without restarting AgEnD. An ongoing attempt is reused. Startup failures keep retrying with a capped five-minute delay while the fleet runs; a long outage no longer exhausts them permanently. This control requires a local admin sign-in and is unavailable over a public link. It does not change the token, permissions or saved binding. Refresh Connections to see a later recovery.

**Preferences**, **Web appearance**, **Agents**, **Connections**, **ClassicBot**, **General**, **Web** and **Developer** (the whole `fleet.yaml` as YAML or JSON; **Edit**, **Copy**, **Download fleet.yaml**, and **Apply & save**, which applies at once without the bar) are tabs, each with its own address. The search box filters agents, connections and ClassicBot rooms; **Setup wizard** runs the same four steps as `agend quickstart`; it always adds a connection, for a new agent or one you already have.

A fleet with no chat connection yet (web only) shows a card above the Agents and Connections tabs (not on Chat, which has one instruction: choose an agent, or create one): **Connect a chat app** opens the setup wizard, **Use the web only** hides the card in this browser.

- **Changes are staged, then applied together.** An agent's, a connection's or a ClassicBot room's **Settings** dialog stages its changes when you press **Stage change**; General's or Web's **Review changes** does the same. (A connection's new binding, **Delete this bot**, provider API keys and **New connection** apply directly; Preferences and Web appearance save at once.) The bar at the bottom counts them and says what applying them costs (immediately, a restart of that agent, or a restart of AgEnD); **Apply changes** applies them all, **Discard** drops them. Staged changes stay while you move between tabs; leaving Settings with any asks **Discard N pending changes?** first.
- **Once you press Apply, it carries on without you.** You can open the chat or anything else: the writes, the reload and its progress go on, a line at the top says how it is going, and Settings shows the details when you come back. A second Apply waits until the first is done. When a change needs AgEnD itself restarted, **Restart AgEnD** is offered (with its own confirmation).
- **Web** holds the dashboard's own settings: how long a sign-in lasts here and how long it may sit unused (`web.session.local.*`; empty = the default), the browser terminal `/login` opens (on or off, and its minutes), web echo, the Log tab (`web.log_tab`) and the public link's menu. A change that loosens access — a longer session or idle time, the browser terminal turned back on or given more minutes, the public link — waits for a fleet admin to confirm it in General (or `agend settings confirm <id>`, see [Confirming sensitive changes](#confirming-sensitive-changes)); one that tightens access applies at once. The other web settings are listed read-only: they decide what the dashboard listens on and exposes, so they are edited in `fleet.yaml` (then `agend reload`; `web.preview_port` and `web.preview_origin` take a restart). Over a temporary public link none of this can be changed: the section says so and the server refuses it.
- **New agent** is the same dialog as the sidebar's **+** (New instance).
- **Sign-ins** (under the agents, #2233) lists each backend's login on this machine and each credential profile an agent uses, with its state. **Sign in** (or **Sign in again**) opens the sign-in dialog; a login the dashboard cannot run shows the command to run on the machine instead, and one that is not installed its install command. See [Remote CLI sign-in](features.md#remote-cli-sign-in-login).
- **Bot tokens are entered here, not in `.env`.** **New connection** and the **Setup wizard** ask for the bot's token in a password field; **Verify** asks Telegram or Discord whose token it is and shows the bot ("This is @your_bot.") before anything is saved.
  - The token is stored on this computer in `~/.agend/.env`, under a name AgEnD generates (`AGEND_DISCORD_TOKEN`, `AGEND_DISCORD_2_TOKEN`, `AGEND_TELEGRAM_PERSONA1_TOKEN`…). **Advanced** shows it, read-only, for people who manage `.env` themselves; nobody has to type one.
  - Both always **add** a connection. A second bot on the same platform, even in the same server, becomes its own connection (`discord-2`, …); an existing connection is never replaced. To change a connection's token, open its **Settings** → **Advanced** → **Replace**.
  - A connection shows **Token set** (with the bot's name while it runs) or **Token missing**, never the token. A new connection starts as soon as Apply runs, without a restart, when AgEnD is already running another connection and nothing else at fleet level changed; the Apply card says "Starting the new connection". A fleet's first connection, or a change to an existing one, still offers **Restart AgEnD**. A token replaced on a connection that is not running starts it the same way; for the first connection it waits for that restart.
- **A change that needs a fleet admin's confirmation** (see [Confirming sensitive changes](#confirming-sensitive-changes)) shows a card in any panel: what it changes, the time left, and **Withdraw**. Apply waits for it; once it is confirmed the rest goes on, and if it is refused or expires, nothing after it is applied and those changes are staged again (a bot token has to be entered again).

### App icon

The picture a browser tab shows for the dashboard, and the icon an "Add to Home Screen" shortcut gets on a phone. **Settings → Web appearance → Look → App icon**:

- **Choose image…** a square picture: PNG, JPG or WebP, 512 × 512 or larger. A wider or taller one is cropped to its centre; a smaller one is enlarged (the card warns, since it may look soft). You see the new icon before **Use this icon**; **Cancel** keeps the old one.
- **Restore default** brings back the AgEnD icon.
- Only an admin's session can change it. A read-only session sees it; guests and the public link do not have the card.
- **Who sees it:** everyone who can open the dashboard's address — the sign-in page and the public link show the same icon, as they did the AgEnD one. Do not use a private picture.
- **On an iPhone or iPad** the home screen keeps the icon it had when the shortcut was added: remove the shortcut and add it again to see a new one. Android and desktop browsers pick it up on their next visit.
- The dashboard has a web app manifest (`/manifest.webmanifest`: the name AgEnD, standalone, the 192 and 512 px icons), so installing it as an app on Android or a desktop uses the same icon.

The host makes the sizes from the one picture (the 180 px touch icon, a 32/48 px favicon, the manifest's 192 and 512 px) and keeps them in its state directory (`web-app-icon/`). Every icon address carries the icon's version, so a browser fetches the new one as soon as it changes.

### Identity colours

Each agent has a colour you can find it by in the sidebar.
- **Where it comes from**, in this order:
  - a colour a person picked for it;
  - the agent's own (its theme's `identity.color`, else its accent), while you show agents' themes;
  - its own bot's colour from its Discord role;
  - otherwise one of a few soft automatic colours, chosen from its name (two agents may share one).
- **Where it shows:** its name, a bar at the row's left edge, and the ring around its picture, in any combination. The default is all three. A person's choice for an agent wins, then the agent's own, then this host's default.
- **Changing one agent's:** its **⋯ → Colour…** in the chat or Details, or **Colour…** in View's **Edit profile**.
  - Pick one of 12 colours (each readable in light and dark) or your own hex colour, and the places it shows.
  - **Reset** goes back to the agent's, the bot's or the automatic one.
  - This works over a temporary public link too, like profile edits.
- **This host's settings,** in **Settings → Web appearance → Identity colours:**
  - where colours show by default;
  - **Turn off colours**, which hides every identity colour on this host. The colours people picked are kept and come back when you turn colours on again.
- **Restore defaults** (Settings → Web appearance): see [Restore defaults](#restore-defaults).

### Custom CSS (Settings → Web appearance)

**Web appearance** holds your own stylesheet. It applies only to your screens: every device where you are signed in, never anyone else's. It covers Chat, Fleet, Details, Needs you, Log and View.

- **Never on Settings.** Settings is always drawn without your CSS, so you can always undo a stylesheet that hides something.
- **Never in these places either:**
  - the sign-in page;
  - a temporary public link (a different person, who can't reach Settings);
  - the anonymous `/view` reader.
- **Save and try.** A saved version is on trial. A bar on every page asks **Keep this custom CSS?** Choose **Keep** within 15 seconds, or it reverts on its own. It also reverts if the tab is closed or the CSS hides the bar.
- **Saved by General for you.** When you ask General to change your custom CSS, the version waits until you open the dashboard (up to 10 minutes; if you don't, it goes back without ever showing). Its 20 seconds start once it is on your screen, so CSS that hides the bar still reverts. Tell General "keep it" in chat: if that arrives after the 20 seconds, General puts that version back in force. If you saved a different version on your page in the meantime, General doesn't keep that one instead: it asks you which you want.
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

- **Its own chat, and optionally the whole page (#2196).** A theme changes that agent's chat panel and its picture and ring in the sidebar. The agent can also put its colours on **the whole page while its chat, View, Log or Details is open**: the sidebar, the header and the usage rail (on a phone, the drawer, the header and the bottom tabs). Open another agent and the page takes its look; open one without page colours, or anything else, and the page is in your own look again. The header follows the page: without page colours it is in your look, even while the chat below it is themed.
  - **Colours only.** Never fonts, pictures, CSS or the layout, so switching never moves anything. AgEnD's status colours (the Needs you count, the state dots, errors, the focus ring) are never themed, and a page theme is refused unless text, its accent and those status colours stay readable on its sidebar and background.
  - **Your choice wins.** A chat's or Details' **⋯ → Page colours**: *the agent's choice* (the default), *on the whole page* or *only its chat* — kept for this host, like the colour you pick for an agent.
  - It never changes Settings or any other agent's chat.
- **For your own custom CSS (#2199).** While an agent's chat, View, Log or Details is open, `<body>` carries `data-agent="<its instance name>"`; elsewhere it has none. It switches in the same moment as the page, with or without agents' themes shown, so your stylesheet can follow the agent you are looking at — for example `body[data-agent="atlas"] { --bg-sidebar: #e2f0ed; }`.
- **Checked twice.** The host stores only values that pass the checks (fixed colour, font and border choices, text that stays readable in both modes). The page checks again before drawing, and drops anything else.
- **Pictures stay on the host.** They are served from the dashboard itself, with their metadata removed, and never loaded from the internet.
- **People decide.** In a chat's or Details' **⋯** menu:
  - **Lock theme** stops the agent changing it. **Unlock theme** allows it again.
  - **Reset theme…** removes it and keeps a lock in place.
  - Both need a signed-in admin, and neither is offered over a temporary public link.
- **Your switch.** **Settings → Web appearance → Show agents' themes, effects and widgets** turns them off on all your devices. Every chat then looks the same, and pictures and ring colours are the bots' again. `?safe=1` also loads a page without them.
- **Reduced motion.** Ambient effects play even when your system asks for reduced motion. To keep them still on a device, tick **Effects: follow the system's reduced-motion setting** under that switch (this device only; off by default). The same device preference controls Canvas Worker effects; an OS request alone does not pause them.
- **Limits.** An agent's changes are at least 30 seconds apart, at most 10 an hour. Its uploads (pictures, effects, mods) are not counted; each picture's size limits and the agent's picture quota still apply. A picture you uploaded for an agent in its profile wins over its theme's. `web.themes.agent_edit: false` in `fleet.yaml` refuses every agent's changes.

### Identity cards

Each agent can have an identity card: a portrait, a banner, a one-line tagline and a short bio.

- **Who sets it.** The agent sets its own with `set_web_theme` (`card.tagline`, `card.bio`, and `card.portrait` / `card.banner` naming pictures uploaded with `set_web_theme_asset` for those slots). A person sets theirs in View's **Edit profile**. **A person's field wins over the agent's, field by field**: leave a field empty to show the agent's.
- **Where it shows.** At the top of the agent's **Details**; in **View**, above the profile row while it is expanded; and in the agent's chat, right under the header. The chat's card is hidden until you show it from the **card button** in the chat header (next to ⋯; there for guests and the public link too, and highlighted while the card is shown). It opens a small menu of two checkboxes: **Show card**, and **Show picture and bio**. Unticking the second leaves only the banner (and the agent's widget strip under it) to save height; it is greyed out while the card is hidden, or when the card has no banner. Nothing sits on the card itself. Shown, the banner is flush under the header. Both choices are kept on this device.
- **Size.** Each card has **S / M / L**. **Settings → Web appearance → Identity cards** sets the size for every card on all your devices, and a card's own control sets that card apart. Over a temporary public link the size is kept on that device only.
- **Text stays text.** The tagline and bio are never markup or links. Pictures are served by the dashboard itself, with metadata such as GPS removed.
- **The banner's crop and focus.** A banner is cropped to fit each card. It is never drawn wider than **5 : 1** (on a wider screen it is centred over a blurred copy of itself) nor narrower than **9 : 4**, which crops the sides. So every card, on every screen and layout, shows the **safe area**: the middle **84% of the width** and **53% of the height** of a 1600×600 banner (the default limit) — a **1350×320 area**. **Banner focus** in Edit profile moves it up or down: drag the slider and the preview shows the safe area (dashed) and a phone's medium card (yellow). The agent sets it with `card.bannerFocus` (0 top … 100 bottom), General with `set_web_settings { what: "banner_focus" }`; a person's wins. Keep faces and text inside the safe area.
- **Pictures that are too large.** Edit profile offers to shrink a portrait or banner that is over the limits ("This picture is 3000×4000; it will be resized to 1024×1365"). The server checks the result like any upload.
- **Clear card** removes your tagline, bio, portrait and banner; the agent's own card shows again. A person's **Reset theme…** removes the agent's card and leaves yours. **Lock theme** stops the agent changing its card.
- **Over a temporary public link** you can edit the card, as you can the profile and picture. Theme reset and lock, and the limits below, stay off it.
- **How an agent sees itself.** `get_web_appearance` tells an agent how it appears now: its face and where it comes from (profile, theme, bot, emoji or initial), its ring colour, its identity colour and where that comes from (a person's pick, its theme's accent, its own bot's Discord role, or automatic), its card field by field (whose each field is), its theme per mode, whether it is locked, and its limits. `preview_web_appearance` draws that as an SVG per mode in its own working directory (`.agend/appearance/light.svg`, `dark.svg`), with the pictures it shows written beside it (`avatar.png`, `portrait.png`, …) — only its own. From a shell: `agend-agent appearance` and `agend-agent appearance preview [light|dark]`.
- **Upload limits:** see [Card upload limits](#card-upload-limits).

### Card upload limits

**Settings → Web appearance → Identity card upload limits** (or `web.appearance` in `fleet.yaml`) sets the largest portrait and banner anyone may upload and how many pictures each agent may keep.
- Fields: portrait width, height (px) and size (KiB); banner width, height and size; pictures per agent; picture space per agent (MiB). Each shows the value in force and the allowed range; empty means the default (shown greyed).
- Defaults: portrait 1024×1536, 1.5 MiB; banner 1600×600, 768 KiB; 8 pictures, 4 MiB per agent.
- A lower limit applies at once; a higher one waits for a fleet admin's confirmation. A limit applies to new uploads only; pictures already stored stay.
- Only a signed-in admin sees and changes these here; otherwise edit `web.appearance` in `fleet.yaml`.

### Widgets

A widget is a small panel of facts drawn by the dashboard itself: numbers, progress bars, a line of text, a short list, a coloured badge, a sparkline. Whoever places it writes only **what to show** (a short JSON spec) and **the values** — never HTML, script, links or CSS. The dashboard draws it with its own components in the page's colours, inside a thin frame with a **✦ title** chip, so a widget never looks like part of AgEnD and nothing in it can be clicked.

- **Where.** An agent may place one in **its own chat**, as a strip under the header (up to 4 items), and one on **its own Details** page (up to 8 items). Your own widget goes in **the sidebar**, under the instance list; agents can't place one there.
- **Live values.** Besides the values it sets, an agent's widget can show its own state, context use and cost, as the page already shows them. Your sidebar widget can show the fleet's counts: working, needs you, idle, stopped. Nothing else is read for it.
- **How an agent sets one.** `set_web_widget` with `slot` (`chat_header` or `details`) and a `spec` places or replaces it. With only `data`, it gives the placed widget new values: at most one update every 10 seconds and 180 an hour, apart from its theme changes. `remove_web_widget` takes it out. From a shell: `agend-agent widget set|data|remove`.
- **People decide.** **Lock theme** stops an agent changing its widgets too. A chat's or Details' **⋯** menu offers **Remove the chat header widget** and **Remove the Details widget**. A widget a person placed (from a mod) takes the agent's values, but the agent can't replace or remove it. **Reset theme…** removes the agent's widgets.
- **Your sidebar widget.** **Settings → Web appearance → Your sidebar widget** takes the spec and values as JSON. It shows a preview and says what's wrong before saving. **Start from an example** fills in the fleet's counts. It is kept with your preferences on all your devices, and is never shown over a temporary public link or with `?safe=1`.
- **Your switch** hides agents' widgets along with their themes. The public link shows agents' widgets, like their cards.

### Ambient effects

An ambient effect is a light decoration an agent puts in its own chat: falling petals, snow, rising lanterns, twinkling stars, or glyphs that scatter where you click. The agent sends only data (a preset, up to 4 glyphs or small pictures, colours and a few numbers); the dashboard draws it. No agent code runs, so it needs no consent and plays by default.

- **Where.** Behind the messages of that agent's chat, never over the composer or header. It never takes a click, a tap or focus: a click star appears for a moment over the messages and your click still lands on what is under it.
- **One of each.** A chat has at most one looping effect (falling, rising or twinkling) and one click effect.
- **How an agent sets one.** `set_web_ambient` with a `preset` (`fall`, `rise`, `twinkle`, `burst-on-click`) and its `glyphs`; `clear_web_ambient` removes it. It counts as a theme change: the same rate limit, and **Lock theme** stops it.
- **People decide.** The chat's **⋯** menu offers **Clear the ambient effect** and **Clear the click effect**; **Reset theme…** clears both. Ask General to set one for an agent (it becomes yours, and the agent can't change it).
- **When it doesn't show,** the chat's **⋯** menu says why, and choosing the line fixes it right there (on the public link too): **Show agents' themes, effects and widgets** is off (it turns it on); **Effects: follow the system's reduced-motion setting** is on while the system asks for reduced motion (this device stops following it); or the page was opened with `?safe=1` (it leaves safe mode).
- **Reduced motion.** When your system asks for reduced motion and an ambient effect plays anyway, the chat says so once on that device ("Your system asks for reduced motion; effects are on.") with **Turn off here**, which ticks **Effects: follow the system's reduced-motion setting** for that device.
- **Cost.** At most 24 looping glyphs, and at most 3 bursts of 16 at once, animated with transform and opacity only. A hidden tab pauses it.
- **The public link** shows it, with the viewer's own switch, like agents' themes and widgets.
- **Mods** carry it (**Ambient effect** when you import or export).

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
- **Effects** in a mod need the effect library (see [Effects](#effects)). Where it is unavailable, a mod that carries effects is refused with `effects_unavailable`.
- Mods are a signed-in person's action, or General's when you ask it (below). They are never available over a temporary public link, and an ordinary agent can only propose one.

### Asking General to change it for you

General (and a coordinator or full-profile instance) can change **Settings → Web appearance** for you: just ask in chat.
- **What it uses:** `get_web_settings` tells it every setting in plain words, and `set_web_settings` changes one through the page's own checks.
- **What it can change:** agents' themes shown, identity colours and where they show, card sizes, the sidebar widget, one agent's colour, effects on a chat and your effect slots, an agent's proposed mod (it shows you the plan, then installs only what you asked for), and Restore defaults.
- **Custom CSS:** it keeps its safe rules. General can put it on trial, keep or revert the trial, switch to an earlier saved version, or turn it off. It keeps a trial when you say you like it.
- **What only you can do, on the page:** choosing a file from your computer (a mod file, an effect folder, a CSS asset, a card picture), this browser's own switches, downloading an export, and the card upload limits.

### Effects

A Canvas Worker effect is a small animation drawn by code in an isolated Worker, with no page or DOM of its own. **Settings → Web appearance → Effects** manages them; agents place their own with the `web-appearance` tools.
- **The library.** **Upload an effect folder**: `effect.json` and `worker.js`, with optional raster pictures, up to 1 MiB after processing. Each effect lists **Your copy** or **Shared with you**. **Share your copy with agents and people on this fleet** lets them use it; **Delete your copy** removes an unused copy (other people's copies stay). **Profile history** shows how it ran on viewers' pages — reported observations, not proof of its cost. **Reload library** reads it again.
- **For a chat.** Choose the **Chat**, set an effect's **Parameters**, then **Save for this chat** (it replaces that chat's parameters with these values) or **Remove from this chat**.
- **Your effect choices.** One effect each for the **Sidebar**, **Header**, **Page** and **Box**, each with **Pause / Resume** and **Clear**, and a **Cursor**, which shows its state and has **Clear**. They follow this platform sign-in (a Discord and a Telegram account stay separate); a host-operator sign-in shares **Host-wide effect choices**.
- **Playback is separate from HTML previews.** CW uses an opaque isolated document on the dashboard listener: no HTML-preview consent, preview port or localhost restriction. Signed-in public/guest viewers can play current effects in chats they may see, without library, personal-slot, Trial or profile access. Try still needs a signed-in admin's explicit click outside the public link. The cursor uses a static image. Playback starts without FPS calibration; show, safe mode, hidden tabs, browser support and the live guard remain. The device-only **Effects: follow the system's reduced-motion setting** is off by default and shared with ambient effects; an OS request alone and data saver do not block playback. Public/guest viewers have a show/off switch in the Chat header, with local recovery; it changes only this browser, never host settings.
- **The pause budget.** An effect that makes the page slow is paused to protect it ("Paused to protect page responsiveness"); **Resume** keeps the limit of three such pauses.
- **Your switch** (**Show agents' themes, effects and widgets**) and `?safe=1` turn agents' effects off.
- **Nothing set, nothing loaded.** Until the open chat has an effect, you choose one of your own, or an agent offers a Try, the page doesn't load the effect player at all, so it costs nothing. It loads the first time one of those happens, within the same moment the effect would start anyway. Ambient effects and your custom CSS don't need it.

When a placed effect cannot play, a notice stays in its chat and the Effects dialog names the reason. Appearance
switches link to **Web appearance**; public Show off offers **Turn effects on here** without writing host preferences.
An unavailable isolated frame offers Reload, never an HTML-preview setup step. A one-time chat note offers to follow the
system's reduced motion setting. A chosen motion block offers **Play effects anyway**, including public/guest viewers;
safe mode offers **Leave safe mode**. Hidden tabs, browser support and safety have named messages. Unknown codes stay local. Agents get only closed
blocked reasons reported within five minutes, without viewer identifiers/counts/device details; reports grant no playback.

### Restore defaults

**Settings → Web appearance → Restore defaults** puts this host's appearance settings back to their defaults. It asks first and says what it resets:
- whether agents' themes and effects are shown;
- the card size, and each card's own size;
- your sidebar widget;
- where identity colours show, and whether colours are off;
- your custom CSS is turned off (its versions are kept), and so is its switch on this device.

It leaves alone the colours people picked for agents, installed mods, uploaded effects and the card upload limits.

## Reaching it from elsewhere

### Temporary public link from a phone

In the owning General, an admin can choose **🌐 Other device (temporary public)** from `/web` (Discord native slash; Telegram typed). Nothing is downloaded or exposed until that click. The bot DMs the link and code; Discord has an awaited ephemeral fallback. Telegram users must `/start` the bot privately first. No code is posted in General.

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
| `web.usage_panel` | `true` | `false`: no **Usage** button, panel or dialog on the dashboard, and `/api/ai-usage` is not served (the chat's `/usage` and the `get_usage` tool still work) |
| `web.preview` | `true` | `false`: no HTML previews at all (cards show the code and Download only) |
| `web.preview_port` | `health_port + 1` | The preview listener's port, on `127.0.0.1` |
| `web.preview_origin` | — | A separate host name, mapped to the preview port, for previews through a tunnel or proxy |
| `web.preview_on_public_link` | `true` | `false`: no previews over the temporary public link (no second tunnel) |
| `web.public_link.allow_public` | `true` | Offer the opt-in action; disabling also closes an existing link |
| `web.public_link.ttl_minutes` | `120` | Fixed lifetime from consent, 1–480 minutes; no renewal of an existing link |
| `web.public_link.protocol` | `http2` | cloudflared `http2`, `quic` or `auto` |
| `web.echo_to_channel` | `true` | Copy web chat messages to the instance's own Telegram or Discord topic |
| `web.log_tab` | `false` | Show each agent's steps in its **Log** tab |
| `web.upload_max_file_mb` | `50` | Largest file in a web chat message, whole MB 1–500 |
| `web.upload_max_total_mb` | `100` | Largest message (all its files), whole MB 1–500 |
| `web.session.local.absolute_hours` | `48` | How long a sign-in at the dashboard's own address lasts, 1–720 hours |
| `web.session.local.idle_hours` | `48` | How long it may sit unused, 1–720 hours and at most `absolute_hours` |
| `web_terminal.enabled` | `true` | `false`: `/login` refuses (no browser terminal) |
| `web_terminal.ttl_minutes` | `10` | How long a `/login` browser terminal stays open, 1–20 minutes |

**Settings → Web** edits `web.echo_to_channel`, `web.log_tab`, `web.public_link.*`, `web.session.local.*` and `web_terminal.enabled` / `ttl_minutes`; it lists the others read-only (with `web.provider_secrets`, `web_terminal.bind` and `web_terminal.tunnel`).

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
| "Your session has ended" | 48 hours without use or since sign-in (the defaults); on a public link 4 hours, 30 minutes unused, or the link closed; or someone used `/web revoke`, **Sign out everywhere** or `agend web-token rotate`. Sign in again. |
| Updates arrive a few seconds late, with no live stream | The live stream is blocked on your path (or this is the public link), so the page polls every 5 seconds; the Log tab may lag up to 30 seconds. Nothing to do — it is not shown as a problem. |
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

Any HTTP code from Linux (**200**, or **503** while the fleet is degraded) with Windows **000** points to a forwarding/connectivity problem; a blank page alone does not establish that. Save the results and Windows/WSL versions. Repeated fleet restarts need not repair the forwarding layer.

AgEnD finishes SSE responses at shutdown, waits at most one second for ordinary HTTP work to drain, then closes remaining owned sockets. Updated pages receiving the shutdown hint wait 10–15 seconds before reconnecting and then use the normal capped backoff. Existing pages loaded before the update keep their previous retry policy until refreshed. This reduces open streams and retry traffic; it cannot guarantee recovery of a stuck Windows relay. The listener closes late, but the replacement still starts its instances before binding HTTP, so the entire outage can exceed one second. Abrupt exits cannot send the hint.

For recovery without interrupting the fleet, use an **already available, trusted SSH route to WSL**, bypassing Windows localhost forwarding. For example, in Windows, replace `WSL_SSH_HOST` with that existing SSH destination:

```powershell
ssh -N -L 127.0.0.1:19290:127.0.0.1:19280 WSL_SSH_HOST
```

Open `http://127.0.0.1:19290/signin` and obtain a fresh code with `/web` or `agend web`. (19290 is just a free port: not 19281, which is the preview port; HTML previews are off at this alternate address.) The alternate port remains Windows-loopback-only; normal sign-in, Host and same-origin checks still apply. Close the tunnel when finished. An existing explicitly approved public link is another option. Do not expose the local listener to the LAN or disable authentication for this workaround. If no alternate route exists, keep using chat and ask the operator to plan maintenance; there is no guaranteed nondisruptive relay reset here.

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

**Your own Apply confirms it when this browser is web-verified (#2170).** After **Authorize this browser** (see
[the chat](#the-chat-ui)), a change that would wait for a chat card is confirmed by your Apply itself when all of these
hold: your account is on the platform of the connections the change affects, and a fleet admin of every one of them
(the rule above); the change's scope is known; and there is a General the chat card could have gone to (connected, on
that platform, not one the change affects). The card then says "Confirmed by your account", and that General gets a
plain notice: who confirmed it from the web, the source, the requester, the summary and the outcome. Every check runs
again when the change executes: if the authorization was revoked or ran out, you signed out, you are no longer an
admin of those connections, or no General a chat card could go to is left (disconnected, its agent stopped), nothing is
applied (the change ends as stale). Anything else waits for chat or the host
exactly as before: a browser that is not web-verified, a guest, the public link, the host's own `agend web` session,
an account on another platform, or a change that needs host CLI confirmation. Know what this rests on: authorizing
the browser is **one** confirmation in your DM, kept for that session until it is revoked, runs out or signs out — not
a fresh confirmation for each Apply. Anyone using that verified, signed-in browser (one left unattended, or a copy of
its session cookie) can confirm such changes the same way. Sign out, or revoke it (Settings → Web → **Revoke web authority**, or **Not
me** on the DM card), when you leave the browser.

First-time Setup also returns a pending request. Confirm it on the host, then explicitly choose **Start AgEnD**. A pending response, an old successful commit or a changed configuration cannot hand over the setup listener to the fleet.
