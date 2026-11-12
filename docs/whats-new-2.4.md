# What's new in AgEnD 2.4

[繁體中文](whats-new-2.4.zh-TW.md)

2.4 is in preview on the alpha line (`2.4.0-alpha.N`). This page is for people coming from 2.3.5. It lists what 2.4 adds and what behaves differently after you upgrade. Three of the larger parts are new kinds of setup: agents on Windows computers (the Windows Runtime), a fleet used only from the browser (web-only), and AgEnD Hub, which is experimental and off unless you turn it on.

## Before you upgrade

- **Moving from 2.3.5 to the alpha.** The first time, run this on the AgEnD computer:

  ```bash
  agend update --alpha
  ```

  From 2.3.5 this is an ordinary upgrade. Once you are on the alpha line, **Update** in the dashboard or `/update` in General keeps you on it.
- **AgEnD brings its own tmux.** From 2.4, AgEnD runs its agents in its own tmux 3.8, on its own socket, and no longer uses the `tmux` installed on the computer. On the first start after the upgrade, every agent restarts once and carries on its conversation. `tmux attach` no longer shows the agents: use `agend attach <name>`, or `agend tmux <command>` for anything else. Your `~/.tmux.conf` does not apply to AgEnD's tmux. Keep the system `tmux` installed: going back to 2.3.5 needs it. Details: [AgEnD's own tmux](bundled-tmux.md).
- **Going back to 2.3.5.** Run:

  ```bash
  agend rollback 2.3.5
  ```

  It stops the fleet, closes AgEnD's own tmux, checks that it is gone, and only then installs 2.3.5 and starts it. Do not use `agend update --stable` or a plain `npm install` to go back: AgEnD's tmux can keep running, and 2.3.5 then refuses to start its agents.
- **Open dashboard tabs.** Reload a tab that was open before the upgrade once.

## Chat

### Two agents side by side (split chat)

On a computer with a wide window (1200 px or more), you can talk to two agents at once.

- In an agent's chat, open **⋯ → Split chat** and choose the second agent. Or, while an agent is open, use the **⋯** beside another agent in the sidebar and choose **Open beside**. The keyboard shortcut is Ctrl+\ (⌘\ on a Mac).
- Each pane is a whole chat: its own message box and its own **Chat**, **View**, **Log** and **Settings** tabs. The pane you are working in is marked **Active**. The sidebar, text size and usage controls follow it. Ctrl+Alt+\ (Ctrl+⌘\ on a Mac) moves to the other pane.
- A pane's **⋯** menu has **Side by side** or **Top and bottom**, **Swap positions**, **Focus the other pane** and **Close this pane**.
- **Quote into the other pane.** Select text in one pane and choose **Quote into the other pane: *name*** (next to **Quote**). The text goes into the other agent's message box as a quote. Nothing is sent until you press Send.
- On a narrower window only one pane shows, with a tab for each agent. The two agents you had open are remembered.

### Reasoning effort

- **The effort chip is always shown.** For an agent whose CLI has an effort setting, the chat header shows its effort even when none is set (**auto**, the CLI's own default). Click it to change it.
- **The choices follow the model.** Each model offers only the levels it takes, read from the CLI's own model list. For example, some Claude models stop at `high`, and some have no effort setting at all.
- **On a phone**, `/model` lists each model with its effort. **›** opens that model's levels; choosing one switches the model too, if needed.
- **In Settings.** An agent's **Settings → Runtime & model** has a **Reasoning effort** field under the model. **Model default** means nothing is set. A running agent uses the new level at once (Codex restarts the agent for it).
- **Shorter model lists.** For Claude Code, the model list shows only the models your account offers. A 1M-context version is listed only where the model supports it. Other CLIs show **Common**, then **More models**.

### Also in chat

- The message box keeps its width when the agent starts or stops working. **Stop** is now in the "working" bar above it.
- **Files & changes** (an agent's **⋯**) shows the folder the agent works in, read-only, and the files it changed. For a local Claude Code or Codex agent, **Follow agent** shows each file as the agent reads or edits it.

## Agents and settings

- **The agent page is now "Settings"** (it was Details), and its **System prompt** is now **Agent instructions**, under **Basic info**. **Agent defaults** is now **Shared agent settings**.
- **Export an agent, or start one from a file.** In an agent's **Settings → Basic info**, next to **Agent instructions**: **Export** writes this agent's settings (description, tags, instructions, model, tool set, behaviour) to a file you can share. **Load template** reads such a file, shows what it will fill in and what it skips, and fills the form; you still press **Save**. Accounts, folders, channel IDs, API keys and permissions are never written to the file. More: [Export and Load template](features.md#exporting-an-agents-settings-and-loading-a-template).
- **New agent: choose its account.** When you create an agent on this computer, the **Account** field picks which signed-in account it uses from its first start.

## AI accounts

**Settings → Agents → AI accounts and API keys** has one card per CLI, with every account on this computer.

- **Add, remove, sign out.** **+ Add account** creates a named account and starts its sign-in. **Disconnect** signs it out with the CLI's own logout. **Remove** deletes it. Each account shows which agents and ClassicBot rooms use it.
- **Choose an account** for an agent in its **Account** field, or for several at once with **Move agents here** on an account. **Fleet default** is the account agents use when they name none.
- **A ClassicBot room's account.** A room's settings → **Runtime & model** now has the same **Account** field. Saving restarts that room on the new account. Only that room's lines in `classicBot.yaml` change; your comments and the other rooms stay as they were. **Move agents here** lists the rooms too.
- **Keep connection alive.** An account no agent uses goes stale, because a CLI renews its sign-in only while it runs. Tick **Keep connection alive** and AgEnD checks it about once a day and renews it with the CLI's own tools. **Needs you** tells you when it must be signed in again.
- **Install or update a CLI from the page.** A CLI that is not installed has **Install**. An installed one that is older than the version AgEnD has checked has **Update to *version***. Both run the CLI's official installer, pinned to that version. **Antigravity is the exception:** it has no pinned version, so its button is **Update to latest (not audited by AgEnD)** and installs the newest release Google serves, which AgEnD has not checked. CLIs that update themselves (Muse) show the versions and no button.
- **No false "sign-in ended" warnings.** A Claude sign-in's stored end date is not a real deadline, so AgEnD no longer warns from it. It warns only when a sign-in really cannot be renewed.

## Task board

- **Tells the dispatcher when an assignee stops.** If an agent holding a card crashes and does not come back, is paused (sign-in ended, usage limit, errors), looks stuck, waits on a prompt for 10 minutes, or stays quiet for 60 minutes, the agent that handed out the card gets one message. It gets a second one when the assignee is working again. A card you handed out yourself shows in **Needs you**. AgEnD only tells: it never restarts or reassigns anything. Change the times in **Settings → Shared agent settings → Advanced → When an assignee stops**. More: [When an assignee stops](features.md#when-an-assignee-stops).
- **List view and filters, Insights, and a card menu.** **Display** shows a project as a board or a list. **Insights** counts the cards per assignee, status, priority or size. Right-click a card for its menu.
- **Agents can create projects** and move main tasks between them.

## Web-only fleets and sign-in

A fleet with no Discord or Telegram connection can now do everything from the browser.

- **Use it from outside.** On the AgEnD computer, open **Settings → Access & security → Owner verification**. Set up an authenticator app (Google Authenticator, Microsoft Authenticator or another one that shows 6-digit codes), then turn on **Allow connections from outside**. The public link opens, and signing in through it asks for the app's code.
- **A web-only fleet can have a General.** Tick **General** on one agent in its settings.
- **Sign in with just your code.** On a new browser, type the 6-digit code from your own authenticator app. There is no name to type. This works on chat fleets too, for every admin who has set up an app.
- **Sign in with another device.** A new device's sign-in page can show an 8-character code. Approve it on a device that is already signed in, under **Devices & sign-in → Add device**. One box on the sign-in page takes either kind of code.
- **Confirm changes from any device.** A signed-in admin's **Apply now** confirms a held Settings change from any device, the public link included. Each admin can turn on their own switch to be asked for their authenticator code when they confirm away from the AgEnD computer.
- **Access & security opens on an overview:** who is signed in (sign a device out), the ways in from outside (close the public link), your owner verification, and links to the Hub, Windows computers and AI accounts.

## Windows computers (Windows Runtime)

Agents can now run on Windows itself, on the AgEnD computer or on other Windows PCs, in the same fleet as your other agents. See [Remote Windows runtime](remote-runtime.md) and [Windows CLI preview](windows-cli-preview.md).

- **Switch it on in Settings → Runtime:** **Use this PC's Windows CLIs** and **Allow other Windows PCs to pair**. Both are off by default.
- **Connect a computer with one command.** **Settings → Runtime → Connect a computer** shows a PowerShell command that works once, for 15 minutes. Paste it on the other PC (or give it to an AI agent there): it installs the Runtime and connects that PC, with no pairing code. Treat the command like a password while it is valid. The Runtime keeps running in the background and reconnects when you sign in to Windows. A pairing code is still under **Manual options**.
- **Windows agents** use the same chat, settings, teams and schedules as the others. Claude Code and Codex agents can keep their own Windows terminal and conversation. General can run on a paired Windows PC too.
- **Accounts and installs on the PC.** Settings can list a paired PC's Claude Code accounts, and install or update Claude Code, Codex, OpenCode or Antigravity there, once that PC's owner allows it on the PC itself. Updates are pinned to the versions AgEnD checked, except Antigravity's, which goes to the latest release (not audited by AgEnD).
- **Runtime updates.** A paired Runtime can update itself from your AgEnD, and waits until it is idle to switch.

## AgEnD Hub (experimental, off by default)

A Hub lets colleagues in a company ask each other's agents questions, after signing in with their company (Active Directory) account. Nothing changes unless someone sets up a Hub with `agend hub init` or in **Settings → Hub**. Connecting a Fleet needs one input: the Hub's address, then **Sign in with company account**. After 2.4.0-alpha.1, a Hub administrator lets colleagues join from one **Let colleagues join** card: turn joining on, choose the AD groups, and copy one sentence to send. Join codes come later. How it works, step by step: [Connect a Fleet to a Hub](hub-join.md). Group permissions: [Hub group permissions](hub-group-permissions.md).

## Office

- Admins can set level titles once for every office, in **Settings → Web dashboard**.
- A skin pack can give each character its own speech-bubble lines, and send idle people to visit other areas now and then.
- **Dialogue** in the Office bar shows speech in a visual-novel style box (off by default, per browser).

## Install and commands

- **`agend tmux <command>`** runs a tmux command on AgEnD's own tmux, for example `agend tmux ls`.
- **`agend web`** signs this computer's browser in by itself (its code lasts five minutes, as before). On WSL it opens the sign-in page and you type the code it prints. On a new install, the first code that `agend web --code` prints in a terminal (not on WSL) lasts an hour, and works only from this computer.
- **`agend build-info`** shows which build is installed.
- **Desktop shortcuts.** `agend shortcuts` adds the dashboard and restart launchers on a Linux desktop too. The Windows shortcuts show the AgEnD icon.
- `agend rollback` finds the npm that manages this install. The installer no longer stops at system package questions.

## Known issues

- **ClassicBot room accounts.** If you wrote a room in `classicBot.yaml` on one line (`{…}`), saving its account from Settings rewrites those lines in the usual multi-line form. The values and comments are kept.
- **Old tabs.** A dashboard tab opened before the upgrade can show a mix of old and new pages. Reload it once.

## Full changelog

- [CHANGELOG.md](CHANGELOG.md)
- [CHANGELOG.zh-TW.md](CHANGELOG.zh-TW.md)
