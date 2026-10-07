# The web dashboard

中文版：[web-dashboard.zh-TW.md](web-dashboard.zh-TW.md)

AgEnD's web dashboard is three panels on one small web server that the fleet runs for you:

| Panel | What it is for |
|---|---|
| **`/ui`**: Dashboard | Talk to your agents (chat, files, Stop), see who is working, and manage instances, tasks, schedules and teams |
| **`/view`** | A read-mostly view of every agent: live terminal, roster, usage, and editing each agent's profile and avatar |
| **`/settings`** | Fleet settings, with apply and restart |

All three share one navigation bar (*Dashboard · View · Settings*) and a **Session** menu. `/` opens the dashboard.

The server listens on **`127.0.0.1`**, on `health_port` (default **19280**). It is reachable from the machine itself unless you set up a way in: see [Reaching it from elsewhere](#reaching-it-from-elsewhere).

## Signing in

The dashboard signs in with a **one-time code**, never with a link that carries a credential.

1. Get a code, either way:
   - in Telegram or Discord, send **`/dashboard`** (fleet admins only). On Discord the reply is visible only to you. On Telegram it is posted in the General topic, where a code is short-lived and works once.
   - on the host, run **`agend web`**. It prints the code and opens the sign-in page. `agend web --code` only prints them.
2. Open the sign-in page and type the 8-character code (`ABCD-EFGH`, with or without the dash, in any case).

About the codes:
- A code works **once** and expires after **5 minutes**. Only the newest code works: asking again replaces the previous one.
- Five wrong tries use up a code. Enough wrong tries across codes pause sign-in for a few minutes. While no code has been issued, there is nothing to guess.
- Every sign-in is announced in the General topic ("New web sign-in: Chrome on macOS"). Turn this off with `web.notify_login: false`.

An old `?token=` link or bookmark (`/ui?token=…`, as older versions printed) is **not** a way in. It opens the sign-in page, and the token is removed from the address bar.

## Sessions

- A session is a record on the server, not a value in your browser. It ends **12 hours** after sign-in, or after **2 hours** without use, whichever comes first. It survives a fleet restart.
- Only what you do counts as use. The page's own background refresh (live updates, polling) never keeps a session alive.
- When a session ends, the page says so once ("Your session has ended. Sign in again") and keeps what you were doing on screen.
- **The Session menu** (top bar) shows:
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

### Writing
- **Enter** sends; **Shift+Enter** adds a line. If sending fails, your text is given back.
- Messages render **Markdown**: headings, **bold**, *italics*, ~~strike-through~~, `code`, code blocks, lists, quotes, rules and links.
  - Links open in a new tab, and only `http(s)` / `mailto` links are links.
  - Nothing in a message, yours or the agent's, can add HTML of its own.
- Reloading the page keeps the conversation: the fleet keeps each instance's recent messages.

### Files and images
- Attach with **📎**, by pasting, or by dropping files onto the chat.
- Limits: up to **5 files per message**, **10 MB each**, **25 MB together**.
- Types: **PNG, JPEG, GIF, WebP, PDF and text files**. The type is read from the file itself, not from its name.
- The agent receives files exactly as from Telegram: the file lands in the instance's workspace inbox (`<AGEND_HOME>/workspaces/<instance>/inbox`), with an `[📷 Image: …]` / `[📎 File: …]` line.
- Files the agent attaches to its reply show in the chat. Images show inline; anything else is a download, never opened in the page.
- An attached file that is **not sent within 30 minutes** is deleted. This holds only while the fleet keeps running: if it restarts in between, the file stays in the inbox ([#1273](https://github.com/songsid/AgEnD/issues/1273)).

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
While the open chat's agent is working, a line above the composer says so, with a **Stop** button.
- Stop does what Telegram's cancel button and `/cancel` do: it interrupts the agent's current reply (Esc), and the messages still waiting are dropped. Their ticks turn to ⊘.
- Stop does **not** stop the instance's process. The instance's own Stop in its actions does that.

## `/view`

`/view` shows every agent: the live terminal capture, the roster with each one's state and context, and AI subscription usage.

- **Reading `/view` needs no sign-in by default** (`web.view_access: open`). That includes the live terminal, so anyone who can reach the port can watch your agents. On a machine only you can reach, that is fine. Otherwise set:
  ```yaml
  web:
    view_access: session   # reading /view needs a signed-in session too
  ```
- **Editing an agent's profile, avatar or the sidebar order always needs a session.** The Edit button sends a signed-out visitor to sign in and back.
- Scripts can still write with the `X-Agend-Token` header.

## Reaching it from elsewhere

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
| `web.notify_login` | `true` | `false`: don't announce new sign-ins in General |
| `web.usage_panel` | `true` | `false`: hide the AI usage panel on `/view` |

Full reference: [configuration.md](configuration.md). CLI commands: [cli.md](cli.md).

## Security notes

- No credential is ever put in a URL: not the fleet token, not a code, not a session.
- Writes from a signed-in browser need the session **and** a per-session CSRF header **and** a matching `Origin`. The cookie alone cannot change anything. Scripts that send `X-Agend-Token` are not affected, since a browser never attaches that header on its own.
- Every panel carries a Content-Security-Policy: scripts, styles, images and connections are limited to the dashboard's own address. (`'unsafe-inline'` is still allowed for now.)

## When something is off

| You see | Why, and what to do |
|---|---|
| **403** when opening the dashboard through a proxy or tunnel | Its `Host` is not allowed: add it to `web.allowed_hosts`. |
| The sign-in page says the code is wrong | Codes are single-use and expire after 5 minutes, and only the newest works. Ask for a new one. |
| "Your session has ended" | 2 hours without use, 12 hours since sign-in, or someone revoked. Sign in again. |
| The dashboard briefly says "disconnected", then keeps updating | The live stream is blocked on your path, so it switched to polling every 5 seconds. Nothing to do. |
| `/dashboard` answers "disabled" | No fleet admins are configured for that bot: add your user to its `allowed_users`. |
