---
title: "What's new in 2.3"
description: "What changes for people coming from AgEnD 2.2.x: how to update and what to check first, the command renames, and the new features by area: task board, global search, Office view, custom domains for public links, and steadier updates and restarts."
---

<p align="center">
  <img class="dark:sl-hidden" src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/readme/hero-light.webp" width="880" alt="The AgEnD web dashboard, with made-up demo data: a sidebar of six agents with their status, a chat with the agent Pixel that shows a table of bundle sizes, a code block, a chosen “Ship it” reply button, an attached report and a usage panel with five AI providers. Beside it, an illustration of a phone showing the same conversation, with the Discord and Telegram logos.">
  <img class="light:sl-hidden" src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/readme/hero-dark.webp" width="880" alt="The AgEnD web dashboard, with made-up demo data: a sidebar of six agents with their status, a chat with the agent Pixel that shows a table of bundle sizes, a code block, a chosen “Ship it” reply button, an attached report and a usage panel with five AI providers. Beside it, an illustration of a phone showing the same conversation, with the Discord and Telegram logos.">
</p>

AgEnD 2.3 is the stable release. This page is for people coming from 2.2.x (2.2.5 and 2.2.6 in particular). It starts with what to do when you upgrade, then lists the command changes, then the new features grouped by area. For what 2.2 added, see [What's new in 2.2](/AgEnD/docs/whats-new-2-2/).

## Upgrade from 2.2.x

The steps, in order, are in the [upgrade guide](https://github.com/songsid/AgEnD/blob/main/docs/upgrade-2.3.md). In short:

- **How to update:** send `/update` in General, or run `agend update` on the host. The update installs 2.3, checks it, and restarts the fleet. The chat shows each step, and a failure says which step failed.
- **Root or WSL-style hosts (#2369):** if you run `agend update` from a shell with no `XDG_RUNTIME_DIR` (a plain `wsl` shell, `docker exec`, cron, or root), 2.2.x cannot reach the systemd user service and rolls itself back to 2.2.x. Run this instead:

  ```bash
  XDG_RUNTIME_DIR=/run/user/$(id -u) agend update
  ```

  Or re-run the official install command. Once you are on 2.3 you no longer need this step.
- **Automatic rollback (#2420):** if the new service does not start, the update tries to put the previous version back: its package, its service settings and, if it was running, its service. It does so only where it can prove what was there before; otherwise it keeps the recovery copies and tells you what to check. Its message says whether the previous version is running again and that the update did not succeed; if the recovery was incomplete, follow the steps it prints. From 2.3 on, an update on macOS (launchd) counts as successful only once the fleet is actually running. Upgrading a Mac from 2.2.x is the exception: 2.2.x's own updater can report success without 2.3 running and does not roll back, so check that the fleet came up; if not, `npm i -g @songsid/agend@2.2.6` then `agend restart` ([details](https://github.com/songsid/AgEnD/blob/main/docs/upgrade-2.3.md#on-a-mac-check-that-the-fleet-came-up-2481), #2481).
- **Disk space:** keep about 235 MB free on top of what the install itself needs. The rollback keeps a copy of the version you are upgrading from while the new one installs, and a copy with its Node is about that size. If that copy cannot be made, the update stops before it changes anything (#2420); the install's own space is not checked in advance.
- **Later updates use the new version's own installer (#2264):** `/update` and `agend update` run the target version's `agend-install --upgrade`, so install, upgrade and repair take the same path. An interrupted install is repaired by running the install command again. If another install or update holds the install lock, the new one stops before changing anything and says why: let the other one finish, then run it again.
- **Service settings are fixed on upgrade:** on Linux, the unit gets `NotifyAccess=all` (#2331), without which the fleet was restarted every 15 minutes. `OOMPolicy` is checked too (#2446). The update reports the values systemd actually loaded.
- **Dashboard sign-in carries over (#2403):** a browser signed in to the dashboard directly stays signed in. The exception: if another AgEnD on the same host replaced this browser's sign-in cookie before you upgraded, sign in once more. A public-link sign-in does not carry over: it lasts only as long as that link, and a restart opens a new one.
- **Defaults that change after the upgrade:**
  - **Task board in chat:** cards that need you are not shown in General's Needs you list until you set `needs_you.task_board: true` (#2425). The daily summary is sent only when you set `defaults.task_board.summary_at`.
  - **New fleets:** a new `fleet.yaml` gets `defaults.dashboard.task_board: false` (#2391). Your existing file is not rewritten, and the task board works as before.
  - **Canvas Worker effects are experimental and off** (#2275). Turn them on in **Settings → Web appearance**. The built-in ambient effects, such as falling petals and click stars, are not affected.
  - **CLI language follows `defaults.locale`** (#2404). If it is not set, a host at UTC+8 uses Chinese, and the machine-read lines stay in English.
  - **Service hosts (#2356):** on a host where the AgEnD service is installed, `agend fleet start` and `agend fleet stop` hand over to `agend start` and `agend stop`, so no second fleet runs beside the service.
- **Known issues:**
  - On WSL, `/login` occasionally leaves the main process stuck until the watchdog restarts it (#1880). The cause is still under investigation.
  - On Codex, a silent schedule sometimes shows "could not confirm delivery" even though it was delivered. It is not sent again (#2301).

## Command changes

| In 2.2 | In 2.3 |
|---|---|
| `agend fleet start` (whole fleet) | `agend start`. `agend fleet start <name>` still starts one instance |
| `agend fleet stop` (whole fleet) | `agend stop`. `agend fleet stop <name>` still stops one instance |
| `agend fleet restart` | `agend restart`. The old form still runs it, is deprecated, and goes away in 2.4 |
| `agend fleet status` | `agend ls --resources`. `agend ls` (also `agend status`) shows the instances |
| `agend fleet logs` | `agend logs`. The old form is removed |
| `agend schedule trigger` | Removed. Use `agend schedule enable` or the Task Board |
| `/install-cli` in chat | Removed. Use `/login` |
| `agend install --activate` | Removed. Activation is the default. Use `--no-activate` to only write the service file |
| `/dashboard` in chat | Still works, deprecated. Use `/web` |
| Windows desktop shortcuts | `agend shortcuts` (inside WSL) makes or updates them |

Typing a removed command prints the new one.

## New features

### Fleet and tasks

<p align="center">
  <img src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/whats-new-2.3/task-board.webp" width="760" alt="The task board, with made-up demo data: the Leaderboard project with one card each in To do, In progress and Blocked; the blocked card shows its question.">
  <img src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/whats-new-2.3/office.webp" width="760" alt="The Office view, with made-up demo data: a pixel-art office with rooms called Work, Lounge, Help desk and Nap corner; the desks are free and three demo agents wait in the Lounge.">
</p>

- **Task board** (`Fleet → Tasks`): a board of projects, main tasks (M-n) and subtasks (S-n). A main task follows its subtasks' progress. Cards support dependencies, comments and history, and you can drag and filter them. The public link shows the board read-only.
  - **Agents work from it:** an agent is notified when a card is assigned to it, sent back, answered, commented on, confirmed or cancelled. Changes within 10 seconds are grouped into one message. Each agent works on one card at a time.
  - **Who confirms:** only cards you handed out wait for your confirmation (#2434). A card an agent handed out is confirmed by that agent. If that agent is deleted, its cards go back to you (#2451).
  - **In chat:** set `needs_you.task_board: true` and the cards waiting on you (to confirm, or stuck) appear in General's Needs you list, where you can confirm, send back or reply.
  - **Daily summary:** set `defaults.task_board.summary_at` (for example `"09:00"`, in the fleet's timezone) to get it. It is off until you set it.
- **Office view** (`Fleet → Org chart → Office`, #2399): the fleet drawn as a pixel-art office. Each team is a room and each agent has a desk. Working agents type, idle ones drink tea, paused ones sleep, and an agent waiting on you raises a hand. Messages between agents fly down the corridor. Two styles, Desks and Studio. Admins can add, rename, delete and furnish offices. Read-only sessions and the public link can only look; guests do not see the org chart or the Office view.
- **Restart and startup:**
  - `agend restart` is the one full restart. It goes through systemd, launchd or the detached fleet, whichever runs AgEnD. `agend restart <name>` restarts one instance now (#2356).
  - The dashboard opens while agents are still starting, and shows each agent's progress (#2398).
  - `startup.concurrency` really starts that many instances at once. Under memory pressure they still start one at a time (#2288).
  - Under memory pressure, deferred start-up no longer causes a restart loop (#2461).
  - When an agent's Claude Code session dies of out-of-memory twice in a row, it stops as crashed and tells you, instead of restarting over and over (#2015, #2035).
  - Creating an agent, or changing a fleet-wide setting, no longer restarts every agent (#2317).
- **Faster dashboard:** state updates are about 4 times faster, and about 7 times faster with several tabs open (#1956).

### Web dashboard

<p align="center">
  <img src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/whats-new-2.3/chat-sending.webp" width="460" alt="A message in the web chat marked “Sending…” while it is on its way.">
  <img src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/whats-new-2.3/usage-compact.webp" width="300" alt="The usage panel in compact mode, with made-up demo data: five accounts across Claude, Codex and Kiro.">
</p>

- **Global search** (Ctrl+K, or ⌘K): finds chat messages, messages between agents and tasks, grouped by agent. Click a result to jump to the message. In a chat, Ctrl+F searches only that agent. You can filter by agent or team, time and source, or show only what you said. Fleet admins can search, on this machine or over the public link (`web.search.public_link: false` keeps it off the link); guests cannot (#2486). The index keeps 90 days by default (`web.search.retention_days`).
- **Chat:**
  - **Reply to a message:** hover and press ↩, right-click, swipe left on a phone, long-press, or press R. A reply sent from the web is a native reply on Discord and Telegram too (#2281).
  - **Reactions:** an agent can react to a web message with an emoji, for example when a message needs only an acknowledgement (#2305).
  - **Send states:** a message appears grey as soon as you send it, and turns normal when the agent receives it. If sending fails, you can retry, put the text back in the box, or delete it. Images and files show their own upload progress. A retry within 10 minutes is recognised and not delivered twice; AgEnD keeps that record in memory only, so after a restart a retry may arrive again.
  - **Images** can be zoomed and dragged (#2333). **Undo and redo** work in every text field (Ctrl/⌘+Z, Ctrl+Shift+Z) (#2342). On a desktop, the input box is one line shorter (#2215).
- **Appearance:**
  - An agent's theme can colour the whole page, its sidebar, title bar and right column. Override it in **⋯ → page colours** (#2196).
  - The identity card is one button in the chat header (#2217).
  - **Custom app icon:** **Settings → Web appearance → App icon** (#2308). Your picture is the one that **Add to Home Screen** shows.
- **Usage panel:**
  - A **Compact / Full** switch next to the title. Compact groups accounts by provider, a few lines per account: name, plan and reset time, then a bar and a percentage for its shorter and longer window where it has them (under two days, such as 5 hours, and two days or more, such as a week or a month). Antigravity gets a line per quota pool. Your choice follows you to each device.
  - Each Claude login has its own row, including the default account and every profile (#2236). An account that is used up shows 100% and its reset time. A rate-limited account shows "Rate limited".
  - If numbers cannot be read, the panel keeps the last ones and marks them "stale · cached at HH:MM", instead of flashing "could not load" (#2236, #2385).
  - Antigravity shows its plan name, and the right Gemini quota for paid plans. Gemini 4 Argon has its own line (#2240).
- **Canvas Worker effects (experimental, off by default):** with `web.experimental.canvas_worker` on (or the switch in **Settings → Web appearance**), you can upload effects, place them in chat or on your own page, and let an agent place its own through a tool. They run in an isolated worker that cannot reach the page's content or the input boxes (#1629).

### Remote access and security

- **Public link on your own domain (named tunnel, #2307):** set `web.public_link.hostname` and a Cloudflare tunnel token in **Settings**, and the public link keeps the same address every time, so a home-screen shortcut on your phone keeps working. The token is only set or cleared, never shown back, and never written to the log. A wrong format is reported at once (#2344).
  - **Lifetime:** with your own domain, `ttl_minutes` can be 1 to 10080 (7 days), or `0` for no expiry (#2448). A quick tunnel is capped at 480 minutes.
  - **Reopen after a restart:** `web.public_link.auto_open` (off by default) reopens the link after a fleet restart, for the admin who opened it last. It works only with your own domain.
- **Verified browser authority on your own domain (#2453):** `web.verified_authority.named_link` (off by default) lets a browser that you confirm act with your account, through your own domain only. A quick tunnel can never qualify.
- **Settings changes from a verified page (#2170):** if your account is an admin of the connection a change affects, the change that was held back applies directly.
- **Two AgEnD dashboards in one browser** no longer sign each other out (#2396).
- **Dependencies:** the bundled Node is 22.23.4 (#2405). `npm audit` reports no vulnerabilities for production or development packages (#2408). Two ReDoS patterns are fixed (#2416). `~/.agend` is always created with mode 0700, and an older, group-writable one is tightened on the next start (#2435).

### Settings and per-agent limits

- **Per-agent dashboard switches (#2391):** `dashboard: { appearance, task_board, web_settings }`, set on one agent or in `defaults`. An agent whose switch is off cannot use the tools for that part of the dashboard. Set on an agent, it overrides the default for that agent only.
- **Sign in to a backend from the dashboard (#2233):** from Settings' sign-in controls, the `/backend` menu, Needs you, and the banner on each page.
- **Dashboard-only fleets:** the Settings page can create the first agent without a chat bot.

### Backends

- **Codex:**
  - When Codex gives up after its 429 retries, AgEnD asks it to carry on after 30, 60 and 120 seconds, up to three times (#2282). "Quota exceeded" is treated as a used-up quota, and the agent pauses.
  - `agend doctor` has a "Codex package" row that warns when the installation is incomplete (#2357).
- **Claude Code:** the idle cold-start prompt is answered automatically, so the agent no longer waits on it (#2268).
- **kiro-cli 2.33:** with `--trust-all-tools`, the "Trust this workspace?" prompt is answered automatically.
- **Grok:** a quota or rate-limit word in code or chat no longer counts as a used-up quota (#2324). An open background watcher no longer queues messages (#2334).

### Language

- **Dashboard and bot messages:** the confirmation cards, buttons, server messages on the web and the `/login` terminal page are in Chinese when the language is `zh-TW` (#2390).
- **CLI:** `agend` messages follow `defaults.locale` (see the upgrade notes above).

### Other fixes

- **Problem reports:** a report file with secrets removed, plus a prefilled GitHub link (#2258).
- **Settings with YAML anchors:** when connections share settings through anchors and aliases, editing one in Settings changes only that connection (#2208). A connection without `mode` no longer widens confirmation to every connection (#2211).
- **Offline restart:** if the network is down when you restart or update, "Fleet ready" is sent once the connection is back (#2213).
- **`agend ls` and attach menus** align Chinese labels correctly.

## Still true from 2.2

- The `gemini-cli` backend is gone (since 2.1.12). Use `backend: antigravity`.
- musl Linux such as Alpine, Linux without systemd, and native Windows are not supported. On Windows, run AgEnD in WSL with systemd. See [Getting Started](/AgEnD/docs/getting-started/#install).

For every change, see the [changelog](https://github.com/songsid/AgEnD/blob/main/docs/CHANGELOG.md).
