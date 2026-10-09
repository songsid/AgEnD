# Upgrading from 2.1 to 2.2

[繁體中文](upgrade-2.2.zh-TW.md)

This page is what to do, in order. For the full list of changes, see the [CHANGELOG](CHANGELOG.md).

## 1. Before you upgrade

**Node.**
- On **Linux (glibc 2.28 or newer) and macOS 11 or newer, x64 or arm64**, AgEnD 2.2 brings its own Node 22.23.3 (`@songsid/agend-node-<os>-<cpu>`, installed with it) and runs on that, whatever Node is on your PATH. You do not need to upgrade Node yourself.
- **Anywhere else** (musl Linux such as Alpine, 32-bit, other systems), AgEnD 2.2 needs Node **22.14 or newer** (or 23.6+, or 24+) on your PATH, and refuses to install on an older one.

**How to install it.**
- `agend update` from 2.1.12 **removes the installed AgEnD before installing the new one** (#1487). If the new install is then refused (for example an old Node on a platform without bundled Node), no `agend` is left at all.
- Safest: install the new version directly:
  ```sh
  npm install -g @songsid/agend@2.2.0
  ```
  A direct install that is refused leaves the old version in place.
- If you use `agend update` anyway, make sure the network is stable and, on a platform without bundled Node, upgrade Node to 22.14+ first.

**Back up.** Stop the fleet, then copy `~/.agend` (it holds fleet.yaml, .env and the SQLite stores):
```sh
agend fleet stop
cp -a ~/.agend ~/.agend.bak-2.1
```
If you use Kiro, also keep a copy of each workspace's `.kiro/` directory.

## 2. What happens on the first start of 2.2

All of these happen once, and need nothing from you unless noted.

| What you will see | Why |
|---|---|
| Each **Kiro** instance, on its first resume, gets `/agent swap <agent>` typed into its pane before anything is delivered (#906). If it cannot confirm the switch within 15 s, it keeps the old setup, says so, and retries at the next start. | Kiro instances now each have their own agent. Delete old `.kiro/steering/agend-<instance>.md` files by hand once every fleet using that directory has upgraded. |
| **The web dashboard asks you to sign in again.** Old `?token=` links and bookmarks open the sign-in page. | Sign-in is now a one-time code (8 characters, 5 minutes): send `/dashboard` to your bot, or run `agend web --code` on the host. Sessions last 12 h (2 h idle). |
| **General gets one message about web chat** (#1366). | Sent once per platform, recorded in `~/.agend/upgrade-notices.json`. |
| **ClassicBot: a `/start` from someone not on an allow list asks General for approval** (#1418). | An empty or omitted `allowed_users` / `allowed_groups` / `allowed_guilds` no longer means "open". Approve with General's buttons, or add explicit entries. Already-registered rooms keep working. |
| **Sensitive changes in web Settings become proposals** (#1423). | A General fleet admin confirms them in chat, or you run `agend settings confirm <id>` on the host. Pending proposals are lost on restart; submit again. |
| **A fleet restart may take up to 5 minutes** (#1071). | Busy Kiro instances get time to stop. `agend restart` refuses a service whose loaded stop timeout is shorter than 300 s; `agend install` (or the next restart) migrates AgEnD's own unit. A custom timeout you set is kept, with a warning. |

## 3. After upgrading: a quick check

```sh
agend --version          # 2.2.x
agend fleet status       # every instance running
agend health             # the fleet answers
```
Then:
- Sign in to the web dashboard (`/dashboard` in chat, or `agend web --code`) and open an instance's chat.
- Send a message to one instance from your chat app and from the web; both should reach it.
- Open **Needs you** in the web sidebar: anything waiting for you (a sign-in, a confirmation) is listed there.
- Kiro users: check each Kiro instance answered once after its `/agent swap`.

## 4. Going back to 2.1.12

Do this only if you must. 2.1.12 does not enforce several 2.2 security policies (see below).

```sh
agend fleet stop
npm install -g @songsid/agend@2.1.12    # needs Node 20+ on your PATH: 2.1.12 has no bundled Node
agend install                            # rewrite the service for 2.1.12
agend fleet start
```

- **Run `agend install`.** The 2.2 service starts AgEnD's bundled Node, which the 2.1.12 install removes. Without it the service points at a Node that no longer exists.
- **Never run two versions on the same `~/.agend` at once.**
- **What you lose on 2.1.12** (see [Downgrade compatibility](downgrade-compatibility.md)):
  - ClassicBot's empty allow lists are open again.
  - Web Settings changes no longer need confirmation.
  - `web.view_access: session` is not enforced, so `/view` is readable without sign-in.
  - The public link and Needs you do not exist.
  - Kiro goes back to directory-wide `--resume`.
- **Data:** the databases are readable by 2.1.12 and again by 2.2 afterwards. Pending sensitive-settings proposals do not carry over.
- **Kiro workspace files:** a 2.1.12 write can overwrite shared Kiro files, so restore them from your backup if needed.

## 5. Common questions

**My fleet.yaml uses the old single `channel:` key. Is that a problem?**
It still works. 2.2 Settings saves it safely as a `channels:` list (#1056). On 2.1.x, do not save connections in Settings with a `channel:` file: convert it to a `channels:` list first.

**What is the "public link" in `/dashboard`?**
An optional, temporary HTTPS address (through cloudflared, installed on first use) to open the dashboard from another device. It is off unless `web.public_link.allow_public` is true. It lasts `web.public_link.ttl_minutes` (default 120) and is delivered privately. Bot tokens and other secrets should be entered on the host's own dashboard, not through the public link.

**Discord server emoji show as broken images in Settings → Status emojis.**
Fixed in 2.2: the page now allows Discord's emoji images. Reload the page after upgrading.

**`/dashboard` used to give me a link with a token. Now it gives a code?**
Yes. The link opens the sign-in page; type the code (one use, 5 minutes). `/dashboard revoke` signs every browser out.

**Can I enter a bot token in the browser?**
Yes. In 2.2, Settings → Connections asks for the token, checks it with the platform and shows the bot's name before saving. It is stored in `~/.agend/.env` and never shown again. The change still needs confirmation (#1423).
