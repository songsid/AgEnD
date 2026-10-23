---
title: Web Guide
description: Sign in to the AgEnD web dashboard, use it from a phone, and sign out.
---

The fleet serves a web dashboard on the AgEnD computer. Its chat is the same conversation as your Telegram or Discord chat. A fleet with no chat bot at all runs from the dashboard alone.

## Sign in

Send **`/web`** in General (fleet admins), then press a sign-in button:

- **💻 AgEnD computer: get a code** is for a browser on the AgEnD computer itself.
- **🌐 Other device (temporary public)** is for a phone or another computer. See [From a phone](#from-a-phone) first.

The bot sends you the link and a sign-in code privately; the code never appears in General. Open the link and type the code. A code works **once**, for **5 minutes**, and only the newest one works.

On Telegram the bot can message you only after you have opened a chat with it. If it cannot, press **Open private chat**, press **Start** in Telegram, then choose a sign-in button there.

**No chat bot?** On the AgEnD computer, run:

```bash
agend web          # prints the code and opens the sign-in page
agend web --code   # only prints them
```

If the browser does not open (a server, or WSL without one), use the page and code it printed.

## From a phone

The dashboard listens only on the AgEnD computer (`127.0.0.1`), so a phone cannot open the 💻 link. **🌐 Other device (temporary public)** opens a temporary public link through Cloudflare:

- Nothing is exposed until you press it.
- Cloudflare handles the TLS and can see the traffic. **Anyone who signs in can manage the fleet**: terminals, files, settings. Do not forward the link or the code.
- The link closes by itself after **2 hours** (Settings can set 1–480 minutes). With your own domain (a named Cloudflare tunnel, `web.public_link.hostname`), the address stays the same every time, and the link can last up to 7 days or until you close it. Close it sooner with **Close public link** in your private message or in a new `/web` menu, or with `/web revoke`.
- Every sign-in through it is announced in General.

The button is missing when public links are turned off (`web.public_link.allow_public: false`). Then use a connection you manage yourself, such as an SSH port forward or Tailscale: see [Reaching it from elsewhere](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.md#reaching-it-from-elsewhere).

## Sessions and signing out

- A sign-in on the AgEnD computer lasts **48 hours**, or until it is unused for 48 hours. **Settings → Web** can change both.
- A sign-in through the public link lasts 4 hours (30 minutes unused), and ends when the link closes.
- A browser that signed in with a `/web` code gets **Send me a new code** on the sign-in page next time, so you do not have to go back to chat.
- The **Session** menu at the bottom of the sidebar lists the fleet's signed-in devices, each with **Sign out**, and **Sign out everywhere**.

Saw a sign-in you did not make? Sign every browser out:

| Where | How |
|---|---|
| Telegram | `/web revoke` |
| Discord | `/web` with **`action: revoke`** |
| In the browser | Session → **Sign out everywhere** |
| On the AgEnD computer | `agend web-token rotate` |

## `/view` is open by default

`/view` shows every agent's live terminal, roster and usage. By default reading it needs **no sign-in** (`web.view_access: open`): anyone who can reach the dashboard's port can watch your agents. That is fine on a machine only you can reach. Otherwise require a sign-in:

```yaml
web:
  view_access: session
```

Editing an agent's profile always needs a sign-in, and over the public link `/view` always does.

## Windows (WSL)

AgEnD runs inside WSL. Open the dashboard link in your Windows browser.

**Only if** the dashboard stops opening from Windows (for example after an update), check which side answers. Close the dashboard tabs first, then run these with the same port: 19280 is the default `health_port`, so use yours if you changed it.

```sh
# Inside WSL
curl --noproxy '*' --max-time 5 -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19280/health
```

```powershell
# Windows
curl.exe --noproxy "*" --max-time 5 -sS -o NUL -w "%{http_code}\n" http://127.0.0.1:19280/health
```

**200** inside WSL with **000** on Windows (no response at all) points to a forwarding or connectivity problem between Windows and WSL, not to the dashboard's sign-in. Restarting the fleet again and again need not repair it. Save both results and your Windows and WSL versions for the operator. Meanwhile:

- keep using chat;
- or sign in from another device with **🌐 Other device (temporary public)**;
- or use an SSH route into WSL that you already have.

Do not open the dashboard to your network or turn off sign-in to work around it. The causes and the operator's options are in [the full guide](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.md#windowswsl-linux-responds-but-the-windows-dashboard-does-not).

## More

The [web dashboard reference](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.md) covers everything else: the chat, files, HTML previews, Fleet, Needs you and Settings.
