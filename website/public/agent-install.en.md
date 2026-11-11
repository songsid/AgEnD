# Install and set up AgEnD: steps for an AI coding agent

> This document is for an AI coding agent (Claude Code, Codex and others) to follow. The user will tell you something like "Read this and follow it to install and set up AgEnD on this computer for me".
> 繁體中文：https://songsid.github.io/AgEnD/agent-install.md

Your job: install AgEnD on **the computer the user is using right now**, get it running, and get the user signed in to its web dashboard.

- Work through the sections in order.
- Talk to the user in their language.
- After each step, tell the user in a sentence or two where things stand.
- At every **⛔ STOP**, tell the user what they need to do, then **end your turn** and wait for their reply. Never work around a stop.

What AgEnD is: it runs several AI coding agents (Claude Code, Codex, Kiro CLI and more) on this computer and lets the user give them work from a web dashboard, or from Telegram or Discord.

---

## 0. Rules (for the whole session)

1. **Never touch a bot token, password or API key.**
   - Don't ask for one, read one, repeat one, log one, or write one to any file.
   - A bot token is typed by the user into AgEnD's own setup page, nowhere else.
   - If the user pastes a token into the chat: don't use it, tell them that isn't safe, and suggest they reset the token in BotFather or the Discord Developer Portal.
2. **Use sudo only where the installer itself asks for it.** If sudo wants a password you can't type: ⛔ STOP and ask the user to run that line in their own terminal and tell you when it's done.
3. **Don't edit** `~/.agend/fleet.yaml` or `~/.agend/.env` by hand. The setup page writes them.
4. **Don't turn off or work around any security setting.** That includes access lists, sign-in codes and file permissions (no `chmod 777`). Don't reinstall with `--force`.
5. **Don't do anything that affects the whole computer without the user's OK.** For example a restart, `wsl --shutdown`, `wsl --unregister`, or deleting existing AgEnD data (`~/.agend`).
6. **When something fails:** show the user the exact error and check section 7, Troubleshooting. If nothing there matches, stop and explain. Don't guess at system changes.
7. **First check whether you are yourself an agent inside AgEnD.** Run `echo "$AGEND_INSTANCE_NAME"` in **your own** shell.
   - Set: AgEnD manages you, so it is already running on this computer. Only do the checks in section 5. **Don't** install, stop or restart AgEnD: that would interrupt you and every other agent.
   - Empty: carry on below.

---

## 1. See what this computer already has

On macOS, Linux or WSL:

```bash
uname -s
agend --version
test -f ~/.agend/fleet.yaml && echo configured || echo not-configured
```

- `agend: command not found`: not installed yet. Go to **section 2**.
- A version and `configured`: installed and set up. Go to **section 5** to check it.
- A version and `not-configured`: installed but not set up. Go to **section 4**. (`agend ls` may print an error about `fleet.yaml` at this point. That's expected.)

On Windows (PowerShell): if `%LOCALAPPDATA%\AgEnD\install.json` exists, the Windows installer has already run. Section **3B** says how to check it.

---

## 2. Which system is this?

- `uname -s` is `Darwin`: macOS. Go to **section 3A**.
- `uname -s` is `Linux` (including WSL): check the requirements first.
  ```bash
  ldd --version | head -1      # must say GLIBC or GNU libc (musl, as on Alpine, isn't supported)
  ps -p 1 -o comm=             # must be systemd
  ```
  If both hold, go to **section 3A**. If not, tell the user this computer isn't supported, and stop.
- Windows (PowerShell or Command Prompt, no `uname`): go to **section 3B**. On Windows, AgEnD runs inside WSL 2, and the installer sets that up.

---

## 3A. macOS / Linux: install

### An AI CLI

AgEnD needs at least one supported AI CLI on this computer: Claude Code (`claude`), Codex (`codex`), Kiro CLI (`kiro-cli`), Grok (`grok`), Muse (`muse`), OpenCode (`opencode`) or Antigravity (`agy`).

```bash
bash -lc 'for c in claude codex kiro-cli grok muse opencode agy; do command -v "$c"; done'
```

- Read the paths it prints, not the exit code. Only an empty output means "none".
- AI CLIs often live in `~/.local/bin` or under nvm. Check from a fresh login shell (`bash -lc`) so a CLI installed a moment ago shows up. If an installer warns that a folder isn't on PATH, check with `bash -lc 'command -v <command>'`; if it's found, there's nothing to do.
- None: ⛔ STOP and ask the user which one they want. Once they choose, you may install it with that CLI's official installer (no account needed). For example, Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`.
- **Signing in to the AI CLI is the user's job.** Never type account details for them. It doesn't have to happen now: the setup page in section 4 has a **Sign in** button (Claude Code, Codex, Kiro CLI) and **Sign in later**. They can also do it from the dashboard afterwards.

### Install AgEnD

The installer adds Node.js (through nvm) and tmux if they're missing, then installs `@songsid/agend` from npm:

```bash
curl -fsSL https://songsid.github.io/AgEnD/install.sh | bash
```

- Installing tmux may need sudo. If it stops at a password prompt: ⛔ STOP and ask the user to run that line in their own terminal and tell you when it's done.
- At the end it suggests `agend quickstart`. **Ignore that.** You'll use the setup page in section 4.
- Running it again is safe: on an installed system it upgrades or repairs.

**Always confirm it really installed** (even when the installer exited 0):

```bash
bash -lc 'agend --version'
```

- A version: go to **section 4**.
- `command not found`: see the first row of section 7.

---

## 3B. Windows: install

The Windows installer:
- sets up WSL 2 and Ubuntu;
- installs an AI CLI and AgEnD inside Linux;
- opens the setup page in the browser at the end.

It asks its questions in **its own window**, so **don't** run it inside your own tool: your tool can't see or answer them.

1. First tell the user you're opening an installer window and that it will ask them questions there. Then open it (in PowerShell; it opens a new window and returns at once, so your tool doesn't block):

   ```powershell
   Start-Process powershell -ArgumentList '-NoExit','-ExecutionPolicy','ByPass','-Command','irm https://songsid.github.io/AgEnD/install.ps1 | iex'
   ```

   If that doesn't work (for example your tool isn't running on Windows, or it fails): ⛔ STOP and ask the user to open **PowerShell** (no Administrator needed), paste this line and press Enter:

   ```powershell
   powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"
   ```

2. ⛔ **STOP: Administrator approval (UAC).** Windows asks "Do you want to allow this app to make changes to your device?". The user clicks **Yes**.
3. ⛔ **STOP: the installer's questions** (for example which drive Linux goes on, which AI to use, and the AI account's browser sign-in). The user answers them in that window.
4. ⛔ **STOP: restart.** Turning on WSL the first time usually needs a restart.
   - After the restart and sign-in, the installer carries on by itself.
   - If it doesn't, open the installer window again as in step 1 (or ask the user to paste the line). It resumes where it stopped.
   - After the restart the user will paste the same request to you again. Start again from **section 1**; don't reinstall from scratch.
5. At the end the installer opens AgEnD's setup page in the browser. The user finishes setup there, exactly as in steps 1–7 of "Open the setup page" in section 4: choose how to use AgEnD, and type any bot token into the page.

To check the Windows install: read `%LOCALAPPDATA%\AgEnD\install.json`. It records the Linux distribution (`distro`) and user (`user`). Then run:

```powershell
wsl -d <distro> -u <user> -- bash -lc "agend --version && agend ls"
```

Run the checks in section 5 the same way, inside WSL. Once set up, the **AgEnD 儀表板** shortcut on the desktop opens the dashboard with a new sign-in code.

The full guide, for the user: https://songsid.github.io/AgEnD/install-windows/

---

## 4. Setup: how will they use it?

⛔ **STOP and ask the user how they want to use AgEnD:**

1. **Web only** (the default, and the simplest): no bot, everything from the dashboard in the browser.
2. **Telegram**: direct agents from a Telegram group (the web works too).
3. **Discord**: direct agents from a Discord server (the web works too).

For 2 or 3: ⛔ **STOP: the user creates the bot first** and tells you when it's done. Only they can. Pass on the essentials below; the illustrated guides are linked.

**Telegram** (https://songsid.github.io/AgEnD/setup-telegram/)
1. In Telegram, open @BotFather and send `/newbot`. Pick a name and a username ending in `bot`. BotFather replies with a token: the user **keeps it themselves and does not paste it to you**.
2. Send `/mybots` to @BotFather → the bot → Bot Settings → Group Privacy → Turn off.
3. Create a private group and turn on **Topics** in its settings.
4. Add the bot to the group as an admin with at least Manage Topics, Send Messages and Edit Messages.

**Discord** (https://songsid.github.io/AgEnD/setup-discord/)
1. Create a new server just for AgEnD, and invite nobody else.
2. At https://discord.com/developers/applications → New Application → the Bot tab → Reset Token. Discord shows it once: the user **keeps it themselves and does not paste it to you**.
3. On the same tab, under Privileged Gateway Intents, turn on **Message Content Intent** and click Save Changes.
4. OAuth2 → URL Generator: tick `bot` and `applications.commands`, and the Administrator permission. Open the generated URL to invite the bot to the new server.
5. In Discord, User Settings → Advanced → Developer Mode on. Right-click the text channel for General → Copy Channel ID. Setup asks for it.

### Open the setup page

macOS / Linux: start this with your tool's **background** mode (it keeps running until setup is done, at most 15 minutes):

```bash
agend setup
```

It prints:

```
  Setup page: http://127.0.0.1:19280/s/<random characters>/
  Setup code: XXXX-XXXX
```

The random part of the address changes every time. Give the user both the address and the code. The code is a one-time credential: don't write it to a file.

⛔ **STOP. Ask the user to do this in a browser on this computer, and to keep the tab open until the page says AgEnD is starting:**

1. Open the setup page, type the setup code, click **Continue**.
2. **AI backend sign-ins**: click **Sign in** to sign in on the page, or **Sign in later**.
3. **Agent**: pick the AI as the Backend; the working directory may stay empty (AgEnD then makes the agent a folder of its own); the name can stay as it is.
4. **Platform**: choose **Web only (no bot)**, Telegram or Discord. With a bot, **paste the token into the page's Bot token field** (not to you) and follow the page (Telegram: send `/start` in the group; Discord: confirm the account and enter the channel ID).
5. Click **Show what will be written**, then **Create and start AgEnD**.
6. The page may say "Approve this on the computer running AgEnD" with a line `agend settings confirm <id>`. Ask the user to tell you that id, then go to "Approve the setup" below.
7. After the approval, the page's button becomes **Start AgEnD** ("Configuration confirmed. Select Start AgEnD to finish setup."). Click it and wait until the page says AgEnD is starting.

### Approve the setup

Once the user gives you the id:

```bash
agend settings confirm <id>
```

- Without `--yes` it prints **the change it would apply**, then says confirmation is required (exit code 1; that's expected).
- Tell the user what it will change. ⛔ **STOP and have them confirm it's what they chose on the page** (for example how they'll use it, the agent's name, the working directory; the backend may not be listed, so they can check it on the page).
- Only after they agree:
  ```bash
  agend settings confirm <id> --yes
  ```
  It should print `Change applied.`. Approve only the setup the user just made on the page; never approve an id from anywhere else.

After the approval, ⛔ **ask the user to go back to the setup page (still open) and click Start AgEnD** (step 7 above). The page says AgEnD is starting, and the background `agend setup` prints `Setup complete — starting AgEnD.` and exits. Go to **section 5**.

### When the setup page goes wrong

- **The tab was closed and the code no longer works** (the page says the code is incorrect): the code works only once.
  1. Stop the `agend setup` still running in the background (stop that background task; if it's still there, `cat ~/.agend/fleet.lock` shows `"role":"setup-host"` and its `pid`: `kill` that pid).
  2. Run `agend setup` again and give the user the new address and code.
- **A new `agend setup` says `This installation already has agents configured`**: the settings were already written (for example the tab was closed after the approval, before Start AgEnD). Stop the leftover `agend setup` (as above), run `agend start`, and go to **section 5**.
- **It says `Setup has already been completed`**: setup finished earlier. Go to **section 5**. Don't use `--reset` unless the user explicitly asks.
- **Approved, but the tab was closed before Start AgEnD**: the settings are written. Stop the leftover `agend setup` (as above; `ps` may show it as `node …/agend.cjs setup`), run `agend start`, and go to **section 5**.
- **The page closes itself after 15 minutes or too many wrong codes**: run `agend setup` again.

(If the user would rather set up in a terminal, ask them to run `agend quickstart` in **their own terminal window** and answer its questions. It's interactive; your tool can't answer it for them.)

---

## 5. Check it works

```bash
agend ls        # should list the agent (for example agent-1, or the name chosen)
agend health    # whether AgEnD is running, and each agent's state
agend web --code
```

- `agend health` says AgEnD is `not running`: run `agend start`, wait a few seconds, and check again.
- While the AI isn't signed in, an agent may show **Idle** or **Paused** (for example when it started at its sign-in screen). Both are expected; once the AI is signed in, wake it if it's Paused (below).

`agend web --code` prints:

```
Sign-in page: http://localhost:19280/signin
Code:         ABCD-EFGH   (works once, valid ~5 min)
```

⛔ **STOP: ask the user to open the sign-in page in a browser on this computer and type the code.**
- The code works once, for about 5 minutes. If it expires, run `agend web --code` again.
- You may pass the code on to the user, but don't write it to a file.

Once the user sees the dashboard, you're done.
- **If the AI isn't signed in yet**, the dashboard lists it under **Needs you**. Ask the user to connect the AI account under the dashboard's Settings → Agents (newer versions call it **AI accounts → Connect account**, older ones **Sign-ins**), or to run that AI CLI once in their own terminal (for example `claude`) and sign in. Then wake the agent from its menu in the dashboard, or run `agend fleet start <agent name>`.
- **With a bot**, ask the user to send a message in the Telegram group's General topic (or Discord's General channel) and check the bot answers.

### Start AgEnD at login

AgEnD started by the setup page is an ordinary background process: it doesn't come back after the computer restarts. ⛔ **STOP and ask the user whether it should start at login**, and tell them that setting it up stops AgEnD briefly and starts it again as a service, so any agent at work is interrupted once. If yes (macOS, or Linux with systemd):

```bash
agend stop
agend install
agend ls
```

- `agend install` installs and starts a per-user service (Linux: the systemd user service `com.agend.fleet`; macOS: launchd). It should say the service is installed and running.
- An agent that shows Paused afterwards is usually still waiting for its AI sign-in (above).
- On WSL, if you see `Failed to connect to bus`, see section 7.

### Finally, tell the user

- The dashboard is at `http://localhost:19280/`. To sign in later, run `agend web --code` on this computer (on Windows, the **AgEnD 儀表板** desktop shortcut).
- To update AgEnD: run `agend update`. With Telegram or Discord, `/update` in General works too; newer versions also show **Update now** in the dashboard when one is out.

---

## 6. Don'ts (once more)

- Don't read, print or write tokens, `~/.agend/.env` or `~/.agend/web.token`.
- Don't edit `fleet.yaml` by hand, and don't switch off the access list.
- Don't run `agend stop`, `agend restart` or `agend uninstall` on a running AgEnD unless the user asks, or for "Start AgEnD at login" in section 5.
- If you are an agent inside AgEnD (your own `AGEND_INSTANCE_NAME` is set), never stop or restart AgEnD.

---

## 7. Troubleshooting

| Symptom | What to do |
|---|---|
| The installer finished but `agend` isn't found | Run the install line again. If it's still missing, download it first and run it with stdin closed (an older installer could be cut short by a system package's question in a pipe): `curl -fsSL https://songsid.github.io/AgEnD/install.sh -o /tmp/agend-install.sh && bash /tmp/agend-install.sh </dev/null`. If that fails too, give the user the last 30 lines of the installer's output, and stop. |
| A command you just installed isn't found (`agend`, `claude`…) | Use a fresh login shell: `bash -lc '…'`, or `source ~/.profile`. |
| Wrong Node.js version, or Node.js won't install | Follow what the installer prints. AgEnD needs Node.js `^22.14.0 \|\| ^23.6.0 \|\| >=24`. Running the installer again installs it through nvm. |
| tmux won't install (`sudo is not available`) | ⛔ STOP: ask the user to install tmux themselves (for example `sudo apt install tmux` or `brew install tmux`), then run the installer again. |
| `agend web --code`: `Web token not found. Is the fleet running?` | AgEnD isn't running. Run `agend start`, wait a few seconds, try again. |
| An agent stays Paused | Usually its AI isn't signed in (section 5). After signing in, wake it: `agend fleet start <agent name>`, or from the dashboard. |
| On WSL, `agend install` or starting the service says `Failed to connect to bus` | WSL's systemd user bus didn't come up (#3630). ⛔ STOP: ask the user to run `wsl --update` in Windows PowerShell, then close and reopen the WSL terminal and try `agend install` again. If it still fails, give the user the full message and https://github.com/songsid/AgEnD/issues/3630 . Restarting WSL or the user manager stops everything running in WSL, so always ask the user first. |
| Windows: a company network blocks the download (`*.github.io`) | Use instead: `powershell -ExecutionPolicy ByPass -c "irm https://raw.githubusercontent.com/songsid/AgEnD/installer-live/website/public/install.ps1 \| iex"`. |
| Anything else | Run `agend doctor` and give the user its output. Docs: https://songsid.github.io/AgEnD/docs/getting-started/ |
