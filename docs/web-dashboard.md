# The web dashboard

中文版：[web-dashboard.zh-TW.md](web-dashboard.zh-TW.md)

AgEnD's web dashboard is three panels on one small web server that the fleet runs for you:

| Panel | What it is for |
|---|---|
| **`/ui`**: the app | Talk to your agents (chat, files, Stop reply), see who is working, and manage instances, tasks, schedules and teams. Each chat has its own address, `/ui/chat/<name>`; Fleet is `/ui/fleet` (`/ui/fleet/schedules`, `…/teams`, `…/org`, `…/cache`, `…/config`); **Needs you** is `/ui/needs` |
| **`/view`** | A read-mostly view of every agent: live terminal, roster, usage, and editing each agent's profile and avatar |
| **`/settings`** | Fleet settings — agents, connections, ClassicBot, defaults, `fleet.yaml` — with apply and restart. Each section has its own address: `/settings/bots`, `…/classic`, `…/general`, `…/advanced` (`/settings` is Agents) |

`/ui`, `/view` and `/settings` are one app with a sidebar: the instances, **Fleet**, **View**, **Settings**, the theme, the language and the **Session** menu. Moving around inside it does not reload the page, and Back/Forward work. `/` opens `/ui`, which goes back to the chat you had open last. Old links of the form `/ui#instance=<name>` still work, also through signing in.

The server listens on **`127.0.0.1`**, on `health_port` (default **19280**). It is reachable from the machine itself unless you set up a way in: see [Reaching it from elsewhere](#reaching-it-from-elsewhere).

## Signing in

The dashboard signs in with a **one-time code**, never with a link that carries a credential.

1. Get a code, either way:
   - in General, use **`/dashboard`** (fleet admins only; Discord native slash). Choose local sign-in or a temporary public link. The menu contains no code: the bot sends the link and code privately.
   - on the host, run **`agend web`**. It prints the code and opens the sign-in page. `agend web --code` only prints them.
2. Open the sign-in page and type the 8-character code (`ABCD-EFGH`, with or without the dash, in any case).

About the codes:
- A code works **once** and expires after **5 minutes**. Only the newest code works: asking again replaces the previous one.
- Five wrong tries use up a code. Enough wrong tries across codes pause sign-in for a few minutes. While no code has been issued, there is nothing to guess.
- Local sign-ins are announced in General unless `web.notify_login: false`. Public sign-ins always require a confirmed public notice.

An old `?token=` link or bookmark (`/ui?token=…`, as older versions printed) is **not** a way in. It opens the sign-in page, and the token is removed from the address bar.

## Sessions

- A session is a record on the server, not a value in your browser. It ends **12 hours** after sign-in, or after **2 hours** without use, whichever comes first. Local sessions survive a fleet restart. Public sessions are scoped to one exposure: four-hour absolute / 30-minute idle limits, and link closure also ends them. They cannot be used locally or on a later exposure; local cookies and header tokens cannot be used on the public host.
- Only what you do counts as use: opening a page or a chat, sending, changing something. What a page does on its own timer never does: the live stream (also when it reconnects), the polling fallback, and `/view`'s terminal, roster and usage refresh. So a tab left open, including `/view` with `web.view_access: session`, still ends after its idle limit (2 hours locally, 30 minutes for a public session).
- When a session ends, the page says so once ("Your session has ended. Sign in again") and keeps what you were doing on screen.
- **The Session menu** (at the bottom of the sidebar) shows:
  - which browser you are signed in as, and when the session ends;
  - every other signed-in device, each with **Sign out**;
  - **Sign out everywhere**.

### Signing every browser out (revoke)

Use any of these if you see a sign-in you did not make, or a device you no longer trust:

| Where | How |
|---|---|
| Telegram | `/dashboard revoke` |
| Discord | the `/dashboard` slash command, with **`action: revoke`** |
| On the host | `agend web-token rotate`. This also rotates the token the CLI uses; a running fleet picks it up with no restart. |
| In the browser | Session menu → **Sign out everywhere** |

If the server cannot save the change (a disk problem), the reply says so: everyone is signed out **for now**, but a restart could bring the sessions back, so fix the disk and revoke again.

## The chat (`/ui`)

Pick an instance on the left to talk to it. The web chat is **the same conversation** as its Telegram/Discord topic:
- A message you send from the web is echoed into the topic as `🌐 web-user: …`.
- The agent's reply goes to Telegram/Discord as usual and also appears here.
- You can switch between the web and your phone mid-conversation.
- **No chat platform at all?** With no `channel` / `channels` in `fleet.yaml`, the dashboard alone is enough: an agent's replies come to the web chat.
- **First time here?** The first time `/ui` opens on a device, a short tour points out the instance list, files, Stop and the *needs you* badge. **Tour** at the bottom of the sidebar shows it again.

### The layout
- The conversation is one centred column. Your messages are bubbles on the right; an agent's replies use the full column, each with **Copy**.
- **Code blocks** show their language, with **Copy** and **Wrap** (long lines wrap instead of scrolling; remembered for this browser). A block longer than 30 lines is folded: **Show all N lines** opens it.
- The view follows new messages only while you are at the bottom. Scrolled up to read, it stays where you are, and **↓ N new** takes you down.
- The sidebar button at its top hides it (☰ brings it back); the choice is remembered. On a phone the sidebar is a drawer: ☰ opens it, and choosing something, tapping outside it or Esc closes it. A phone also has tabs along the bottom (Chat, Fleet, View, Settings); they make room while the keyboard is open.
- The header shows the instance's name and state. Its **⋯** menu holds **Instance details** and the instance's own actions, and only the ones that fit: **Start** for a stopped instance; **Restart** and **Stop instance** for a running one; **Delete** last, behind typing its name.
- **Theme** and **Language** (bottom of the sidebar): *System* follows your device's light or dark setting; *Light* or *Dark* fixes it for this browser. The language applies to every panel.
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
- Limits: up to **5 files per message**, **10 MB each**, **25 MB together**.
- Types: **PNG, JPEG, GIF, WebP, PDF and text files**. The type is read from the file itself, not from its name.
- The agent receives files exactly as from Telegram: the file lands in the instance's workspace inbox (`<AGEND_HOME>/workspaces/<instance>/inbox`), with an `[📷 Image: …]` / `[📎 File: …]` line.
- Files the agent attaches to its reply show in the chat. Images show inline; anything else is a download, never opened in the page.
- An attached file that is **not sent within 30 minutes** is deleted. After a fleet restart, any such file left over is removed at startup once it is 30 minutes old.
- Files that were sent stay in the inbox for **7 days**, like files from Telegram.

### HTML previews
When an agent's reply contains a ` ```html ` block, a card under it can run that HTML for you.
- **Off on every device until you turn it on.** Use **Allow HTML previews on this device** at the bottom of the sidebar, or the card's **⋯** menu. It asks once and says what it means. Turning it off stops every running preview.
- **Click to run, every time.** **Preview** runs it in a frame under the card, with this banner: *"Previews run the agent's HTML in an isolated frame. It cannot use your login, but it may be able to send data out. Only preview content you trust. A preview can slow or freeze this tab."* **Stop** closes it. One preview runs at a time.
- **Download** saves the HTML as `reply.html`. It is never opened in the dashboard.
- **What it can and cannot do.** The preview runs in a sandbox on a separate address, so it cannot use your sign-in, read your session or act on the dashboard. It **may** be able to send data out (no browser blocks every way), so preview only HTML you trust.
- **Only agents' replies** get a card, marked so by the fleet. HTML from people (on the web, Telegram or Discord) is only ever shown as code. A block cut off by the length limit gets no preview: ask the agent to send a `.html` file instead.
- **Where it works.** Previews come from a second local port, `health_port + 1` (19281). Over SSH, forward it too: `ssh -L 19280:127.0.0.1:19280 -L 19281:127.0.0.1:19281 <host>`. Through a tunnel or proxy they need `web.preview_origin`, a separate host name mapped to that port; the proxy must pass the external `Host` through. Otherwise the card says why previews are off, and shows the code and **Download** only.
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
- Only these instance-health prompts come to the web. A `/clear` confirmation, login, ClassicBot approvals, tips and the `/model` / `/effort` menus stay where they were asked. The web chat runs its own `/clear`, `/model` and `/effort` (below).
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
  - `/cancel`
  - `/btw <question>`
  - `/steer <text>`
  - `/pause` and `/wake`
  - `/save <file>`
- **Where the answer shows:** above the message box.
- **Not a command:** anything else starting with `/` is sent as an ordinary message, as before. So is a line typed with a file waiting beside it.
- **Fleet-wide commands** (`/status`, `/restart`, `/update`, `/login`, …) stay in General.
- **`/raw`** is not offered. Over the temporary public link a message starting with `/raw ` is refused, and so is `/save`.
- **Quick actions:**
  - The model and effort in the chat's header open their lists.
  - Once the instance's context is 70% used, **Compact** and **Clear…** appear above the message box.

## Fleet (`/ui/fleet`)
The fleet's shared work and its overview, one tab each. Every tab has its own address.
- **Tasks**, **Schedules** and **Teams**: the task board, cron schedules and teams. Create, claim and delete them here.
- **Org chart** (`/ui/fleet/org`): General at the top, then the teams from `fleet.yaml`, then the instances in no team.
  - Each instance shows its display name, what it does, its backend and model, and its live state (working, idle, needs you, looks stuck, paused, stopped or crashed).
  - Each instance also links to its Discord thread or Telegram topic and to its chat.
  - The chart is read-only: you act in Discord, or from the chat.
- **Cache** (`/ui/fleet/cache`): how often each Claude Code and Codex instance's prompt cache expires between requests over 24 hours, 7 days or 30 days, what rewriting it costs, and whether a keep-warm ping would pay off.
  - It reads the transcripts on the machine, never a vendor API, and keeps a small summary per instance (`cache-ledger.json`).
  - Costs are list prices from one table; the date they were checked is shown.
  - Codex does not record cache writes, so its numbers are marked as estimates.
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
- **The header** has **Text size** (Fit → Comfortable → Compact), **Usage** and **Help**. The terminal stays dark in both themes.
- **The card under the terminal** shows the agent's name, role and model; its arrow opens the whole profile. **Edit profile** changes the display name, role, description and avatar.

- **Reading `/view` needs no sign-in by default** (`web.view_access: open`). That includes the live terminal, so anyone who can reach the port can watch your agents. On a machine only you can reach, that is fine. Otherwise set:
  ```yaml
  web:
    view_access: session   # reading /view needs a signed-in session too
  ```
- **Signed out, `/view` is View alone:** the sidebar has View and **Sign in**, nothing that needs a session is shown or read, and **Sign in to edit** takes you to the sign-in page and back.
- **Editing an agent's profile or avatar always needs a session.** The order of the roster is kept in this browser only.
- Scripts can still write with the `X-Agend-Token` header.

## `/settings`

**Agents**, **Connections**, **ClassicBot**, **General** and **Developer** (the whole `fleet.yaml` as YAML or JSON) are tabs, each with its own address. The search box filters agents, connections and ClassicBot rooms; **Setup wizard** runs the same four steps as `agend quickstart`.

- **Changes are staged, then applied together.** An agent's or a connection's **Settings** dialog stages its changes when you press **Stage change**; General's **Review changes** does the same. The bar at the bottom counts them and says what applying them costs (immediately, a restart of that agent, or a restart of AgEnD); **Apply changes** applies them all, **Discard** drops them. Staged changes stay while you move between tabs; leaving Settings with any asks **Discard N pending changes?** first.
- **Once you press Apply, it carries on without you.** You can open the chat or anything else: the writes, the reload and its progress go on, a line at the top says how it is going, and Settings shows the details when you come back. A second Apply waits until the first is done. When a change needs AgEnD itself restarted, **Restart AgEnD** is offered (with its own confirmation).
- **New agent** is the same dialog as the sidebar's ✎ (New instance).
- **A change that needs a fleet admin's confirmation** (see [Confirming sensitive changes](#confirming-sensitive-changes)) shows a card in any panel: what it changes, the time left, and **Withdraw**. Apply waits for it; once it is confirmed the rest goes on, and if it is refused or expires, nothing after it is applied and those changes are staged again (a bot token has to be entered again).

## Reaching it from elsewhere

### Temporary public link from a phone

In the owning General, an admin can choose **Open temporary public link** from `/dashboard` (Discord native slash; Telegram typed). Nothing is downloaded or exposed until that click. The bot DMs the link and code; Discord has an awaited ephemeral fallback. Telegram users must `/start` the bot privately first. No code is posted in General.

It uses AgEnD's pinned, checksum-verified cloudflared, never an arbitrary executable on PATH. Only one tunnel can run; a public `/login` terminal shares that slot. The fixed lifetime is **two hours**, including startup; reuse does not renew it. Settings can set 1–480 minutes or disable the option. A private close button, a fresh menu, `/dashboard revoke`, expiry and fleet shutdown close access. Unconfirmed child cleanup blocks another tunnel, but web access is already closed.

The separate gateway accepts only its current tunnel Host and reviewed panel routes. `/view` always requires sign-in there; preview, SSE, `/health`, `/agent` and code issuance are excluded. Chat polls immediately. Closing revokes that exposure's codes and sessions; local sessions stay separate. The host is ephemeral, never persisted in `allowed_hosts`.

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
| `web.usage_panel` | `true` | `false`: hide the AI usage panel on `/view` |
| `web.preview` | `true` | `false`: no HTML previews at all (cards show the code and Download only) |
| `web.preview_port` | `health_port + 1` | The preview listener's port, on `127.0.0.1` |
| `web.preview_origin` | — | A separate host name, mapped to the preview port, for previews through a tunnel or proxy |
| `web.public_link.allow_public` | `true` | Offer the opt-in action; disabling also closes an existing link |
| `web.public_link.ttl_minutes` | `120` | Fixed lifetime from consent, 1–480 minutes; no renewal of an existing link |
| `web.public_link.protocol` | `http2` | cloudflared `http2`, `quic` or `auto` |

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
| "Your session has ended" | 2 hours without use, 12 hours since sign-in, or someone revoked. Sign in again. |
| The dashboard briefly says "disconnected", then keeps updating | The live stream is blocked on your path, so it switched to polling every 5 seconds. Nothing to do. |
| `/dashboard` answers "disabled" | No fleet admins are configured for that bot: add your user to its `allowed_users`. |

### Confirming sensitive changes

Changing access/F/C lists, secrets, connection destinations/order, public exposure or control-bearing instance settings returns `202 pending_confirmation`. The requester can list/poll `GET /api/settings/pending[/:id]` and withdraw an unclaimed request with `DELETE /api/settings/pending/:id`. Other sessions receive 404. Polling is passive and does not extend sign-in lifetime; `remaining_ms` is the countdown, and the display timestamp is not an authorization deadline.

Confirm the redacted diff in General as a fleet admin. If chat is unavailable, use the host command `agend settings confirm <id>`; Reject, expiry or session revocation does not apply the change. Apply retries must reuse the same `Idempotency-Key` and body, which returns the same request. After a terminal failure, review and submit a new key; secrets must be entered again. In the web app, a request waiting for confirmation shows as a card in any panel, with its countdown and **Withdraw** (see [`/settings`](#settings)).

First-time Setup also returns a pending request. Confirm it on the host, then explicitly choose **Start AgEnD**. A pending response, an old successful commit or a changed configuration cannot hand over the setup listener to the fleet.
