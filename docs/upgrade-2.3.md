# Upgrading from 2.2 to 2.3

[繁體中文](upgrade-2.3.zh-TW.md)

This page lists what to do, in order, when you move from 2.2.x (2.2.5 or 2.2.6) to 2.3.0. To see what 2.3 adds, read [What's new in 2.3](whats-new-2.3.md). The full list of changes is in the [CHANGELOG](CHANGELOG.md).

## 1. Before you upgrade

- **Free space: about 235 MB more than a normal install.** Before it changes anything, the update saves a copy of the installed version, with its Node, so that it can roll back. It keeps that copy while npm installs the new version. On the disk where npm installs AgEnD, keep about 235 MB free for the copy, on top of what the install itself needs. If that copy cannot be made, the update stops before it changes anything. The space for the install itself is not checked in advance, so leave room for it too.
- **Node.** Nothing changes from 2.2. On Linux (glibc) and macOS, x64 or arm64, AgEnD brings its own Node. 2.3 pins Node 22.23.4.
- **Supported hosts.** Also unchanged from 2.2: macOS, or Linux with glibc and systemd.

## 2. Update

### From the host

```bash
agend update
```

The update runs the new version's own installer. It refreshes the service settings and restarts the fleet. You do not need to run `agend install` afterwards.

**On root or WSL-style hosts, add one step (#2369).** On 2.2.x, `agend update` may be run from a shell without `XDG_RUNTIME_DIR`: a plain `wsl` shell, `docker exec`, cron, or root. From such a shell it cannot reach the systemd user service, and it falls back to 2.2.x. Run it like this instead:

```bash
XDG_RUNTIME_DIR=/run/user/$(id -u) agend update
```

Rerunning the official install command also works. The running fleet is not affected either way. You will not need this step again once you are on 2.3.

### From Discord or Telegram

Send `/update` in General.

This works from 2.2.6 on root and WSL-style hosts too: the extra step above is only for `agend update` run from a shell on the host.

### If something gets in the way

- **Another install is running.** If another AgEnD install or update holds the install lock, the new one stops before changing anything and says why. Let the other one finish, then run the update again.
- **An install was interrupted.** Run the install command again. It repairs what the interrupted install left behind.

## 3. If the new version does not start: rollback

If the new service does not come up, the update tries to put the previous version back:
- the previous package, with its bundled Node;
- the previous systemd unit (user or system) or launchd plist;
- the previous service, if it was running before. A service that was stopped stays stopped.

It restores only what it can prove was there before. When it cannot, it keeps the recovery copies and prints what to check. Either way, the update ends with an error, and its message says whether the previous version is running again. If the recovery was incomplete, follow the steps it prints.

On macOS (launchd), an update counts as done only once the new fleet is actually running.

## 4. What changes on the first start of 2.3

| What | 2.3 default | How to change it |
|---|---|---|
| Task board cards in chat ("Needs you") | Off | `needs_you.task_board: true` |
| Task board daily summary | Off | `defaults.task_board.summary_at: "09:00"` (a 24-hour time in the fleet's time zone) |
| A new `fleet.yaml` | Written with `defaults.dashboard.task_board: false` | Settings, or per agent with `dashboard` |
| An existing `fleet.yaml` | Not rewritten; the task board stays available | Same as above |
| Canvas Worker effects | Experimental, off | Settings → Web appearance → Experimental |
| CLI language | From `defaults.locale`. If it is unset: Chinese on a UTC+8 host, English otherwise | `defaults.locale: en` or `zh-TW` |
| ClassicBot rooms | Echo web chat (`🌐 web · <name>: …`) | `web_echo: false` in `classicBot.yaml`, or untick **Web echo** in the room's Settings |
| `agend fleet start` / `agend fleet stop` on a host with a service | Hand over to `agend start` / `agend stop` | `agend fleet start --direct`, from your own shell (not from an agent session) |

Other things that change on the first start:
- **The service files are repaired.** On Linux, the unit gets `NotifyAccess=all`. Without it, systemd never receives the ready signal and restarts the fleet every 15 minutes. The update writes the setting, then checks the value that systemd actually loaded. It also checks the loaded `OOMPolicy`.
- **Your dashboard sign-in stays.** A browser signed in to the dashboard directly is still signed in after the upgrade. There is one exception: another AgEnD on the same host may have replaced this browser's sign-in cookie before the upgrade. In that case, sign in once more. A public-link sign-in does not carry over: it lasts only as long as that link, and a restart opens a new one. From 2.3 on, each fleet's cookie has its own name.
- **Some commands are renamed or removed.**
  - `agend restart` is the one full restart. `agend fleet restart` now runs it, and will be removed in 2.4.
  - Removed: `agend schedule trigger`, `agend fleet logs` (use `agend logs`), `/install-cli` in chat (use `/login`), and `agend install --activate`. Typing one of them shows the command to use instead.

## 5. After upgrading: a quick check

```bash
agend --version   # 2.3.0
agend ls          # every instance listed, and running
agend doctor      # service, runtime and backend checks
```

Then open the dashboard (`/web` in General). Your instances should be there, and each one's chat should open.
