# Upgrading from 2.1 to 2.2

[繁體中文](upgrade-2.2.zh-TW.md)

This page is what to do, in order. For the full list of changes, see the [CHANGELOG](CHANGELOG.md).

## 1. Before you upgrade

**Node.**
- On **Linux (glibc 2.28 or newer) and macOS 11 or newer, x64 or arm64**, AgEnD 2.2 brings its own Node 22.23.3 (`@songsid/agend-node-<os>-<cpu>`, installed with it) and runs on that, whatever Node is on your PATH. You do not need to upgrade Node yourself.
- **Anywhere else** (musl Linux such as Alpine, 32-bit, other systems), AgEnD 2.2 needs Node **22.14 or newer** (or 23.6+, or 24+) on your PATH, and refuses to install on an older one.

**Do not use 2.1.12's `agend update` for this upgrade.** It removes the installed AgEnD before it installs the new one (#1487), so a refused install leaves no `agend` at all. Install with npm instead (step 2.3 below): a refused direct install leaves the old version in place.

## 2. Upgrade, step by step

`AGEND_HOME` below is your AgEnD data directory: `~/.agend` unless you set `AGEND_HOME`.

**2.1 Stop the fleet, and make sure it has exited.**
```sh
agend stop          # if you run AgEnD as a service (you ran `agend install`)
agend fleet stop    # if you start it yourself with `agend fleet start`
# Wait until the fleet process is really gone. Neither command waits for that:
while kill -0 "$(cat "${AGEND_HOME:-$HOME/.agend}/fleet.pid" 2>/dev/null)" 2>/dev/null; do sleep 2; done
```
A busy fleet (Kiro instances finishing their turns) can take minutes to stop. If you see "fleet process still running", wait; do not go on while it runs. A service must also stay stopped: do not start it from another terminal in the meantime.

**2.2 Back up** the data directory (fleet.yaml, .env and the SQLite stores). If you use Kiro, also copy each workspace's `.kiro/` directory.
```sh
cp -a "${AGEND_HOME:-$HOME/.agend}" "${AGEND_HOME:-$HOME/.agend}.bak-2.1"
```

**2.3 Install 2.2.**
```sh
npm install -g @songsid/agend@2.2.0
```

**2.4 Start it again.**
- **As a service:** run `agend install`. It rewrites the service for 2.2 (the 2.1 service definition is refused by 2.2's restart checks) and starts it.
- **By hand:** run `agend fleet start` as you did before.

**2.5 Check** (section 4).

## 3. What changes on the first start of 2.2

**Once, on the first start:**
- **Kiro:** each instance, on its first resume, gets `/agent swap <agent>` typed into its pane before anything is delivered (#906). If the switch cannot be confirmed within 15 s, the old setup stays, a notice says so, and the next start tries again. Delete old `.kiro/steering/agend-<instance>.md` files by hand once every fleet using that directory has upgraded.
- **Web sign-in:** everyone signs in again. Old `?token=` links and bookmarks open the sign-in page. Send `/dashboard` to your bot, or run `agend web --code` on the host, for a one-time code (8 characters, 5 minutes).
- **General gets one message about web chat** (#1366), once per platform, recorded in `AGEND_HOME/upgrade-notices.json`.

**From now on (policies):**
- **Web sessions** last 12 h (2 h idle) on this computer's dashboard, and 4 h (30 min idle) through the public link.
- **ClassicBot:** a `/start` from someone not on an allow list asks General for approval (#1418). An empty or omitted `allowed_users` / `allowed_groups` / `allowed_guilds` no longer means "open". Approve with General's buttons, or add explicit entries. Already-registered rooms keep working.
- **Sensitive changes in web Settings are proposals** (#1423). A General fleet admin confirms them in chat, or you run `agend settings confirm <id>` on the host. Pending proposals are lost on restart; submit again.
- **Stopping the fleet may take up to 5 minutes** (#1071), so busy Kiro instances can finish; starting it again takes its own time on top. `agend restart` refuses a service whose loaded stop timeout is shorter than 300 s; AgEnD's own unit is migrated, and a custom timeout you set is kept with a warning.

## 4. After upgrading: a quick check

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

## 5. Going back to 2.1.12

Do this only if you must. 2.1.12 does not enforce several 2.2 security policies (see below).

1. **Stop and confirm the fleet has exited**, exactly as in 2.1. Never run two versions on the same data directory at once.
2. **Back up the current state** (the data directory and each workspace's `.kiro/`). Your pre-upgrade backup does not hold what changed on 2.2, and 2.1.12 can rewrite some files.
3. **Install 2.1.12.** It has no bundled Node, so it needs Node 20 or newer on your PATH:
   ```sh
   npm install -g @songsid/agend@2.1.12
   ```
4. **Start it again.**
   - **As a service:** run `agend install`, which rewrites the service for 2.1.12 and starts it. This is required: the 2.2 service starts either AgEnD's bundled Node (removed when 2.1.12 replaces the package) or 2.2's launcher, which 2.1.12 does not have.
   - **By hand:** run `agend fleet start`.

**What you lose on 2.1.12** (see [Downgrade compatibility](downgrade-compatibility.md)):
- ClassicBot's empty allow lists are open again.
- Web Settings changes no longer need confirmation.
- `web.view_access: session` is not enforced, so `/view` is readable without sign-in.
- There is no public link and no Needs you.
- Kiro goes back to directory-wide `--resume`.

**Data.** The stores that were tested (the delivery outbox, scheduler, events, Needs you pointer, fleet.yaml and Kiro files, on Linux, data only, no running fleet) could be opened and written by 2.1.12 and then reopened by 2.2. That is not a guarantee for every platform or a running fleet. Pending sensitive-settings proposals do not carry over, and a 2.1.12 write can overwrite shared Kiro files, so keep the backup from step 2.

## 6. Common questions

**My fleet.yaml uses the old single `channel:` key. Is that a problem?**
It still works. 2.2 Settings saves it safely as a `channels:` list (#1056). On 2.1.x, do not save connections in Settings with a `channel:` file: convert it to a `channels:` list first.

**What is the "public link" in `/dashboard`?**
A temporary HTTPS address (through cloudflared, installed on first use) to open the dashboard from another device.
- `/dashboard` offers it by default, but a link is created only when an admin chooses it there, and it is delivered privately.
- `web.public_link.allow_public: false` removes the option and closes any link already open.
- `web.public_link.ttl_minutes` sets its fixed lifetime (default 120, from 1 to 480).
- `web.public_link.protocol` chooses how cloudflared connects: `http2` (the default), `quic` or `auto`.

Enter bot tokens and other secrets on the host's own dashboard, not through the public link.

**Discord server emoji show as broken images in Settings → Status emojis.**
Fixed in 2.2: the page now allows Discord's emoji images. Reload the page after upgrading.

**`/dashboard` used to give me a link with a token. Now it gives a code?**
Yes. The link opens the sign-in page; type the code (one use, 5 minutes). `/dashboard revoke` signs every browser out.

**Can I enter a bot token in the browser?**
Yes. In 2.2, Settings → Connections asks for the token, checks it with the platform and shows the bot's name before saving. It is stored in `~/.agend/.env` and never shown again. The change still needs confirmation (#1423).
