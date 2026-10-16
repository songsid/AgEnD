---
title: "What's new in 2.2"
description: "What changed for people coming from AgEnD 2.1: web chat, one list of what needs you, more than one Claude account, a bundled Node, and smoother upgrades."
---

AgEnD 2.2 adds a web app next to Telegram and Discord. You can talk to your agents from a browser, see everything that is waiting on you in one place, and run a second Claude account. The fleet also brings its own Node and survives upgrades on more kinds of hosts. This page is for people coming from 2.1.x; it lists what you will notice, with links to the details.

## Upgrade in one step

- **From 2.1.12 on Linux or macOS:** send `/update` in General, or run `agend update` on the host. The fleet restarts on 2.2, and General gets a short note about what is new. This covers Linux with glibc 2.28 or newer and systemd (WSL included, with systemd on), and macOS 11 or newer, on x64 or arm64.
- **From 2.1.0–2.1.11, or on any other platform:** follow the [upgrade guide](https://github.com/songsid/AgEnD/blob/main/docs/upgrade-2.2.md)'s manual steps.
- **While it runs,** the chat shows each step (download, install, restart), and a failure says which step failed and why. From 2.2 on, a failed update also names the update log.

## Chat with your agents in the browser

- **Sign in with a one-time code.** Send `/web` in General. Choose **💻 AgEnD computer** to sign in on the machine running AgEnD, or **🌐 Other device** for a phone or another computer through a temporary public link. A code works once, for five minutes. No link carries a password any more.
- **The same conversation as your topic.** What you write on the web reaches the agent exactly as a Telegram or Discord message would. For a fleet topic the chat platform sees it too; a ClassicBot room does when `web_echo: true` is set. The history is still there after a reload or a fleet restart.
- **A real chat.** It shows Markdown, tables and highlighted code. You can send files of any type, up to 50 MB each and 100 MB per message by default (`web.upload_max_file_mb` / `web.upload_max_total_mb`); images and media preview inline. It shows where each message got to, shows when the agent is working, and has a **Stop** button. It also shows reply buttons and polls the agent offers, and mentions the way Discord and Telegram show them.
- **HTML previews.** When an agent sends a page, you can open it in a panel beside the chat. Previews are off until you turn them on; the choice then applies on every device where you are signed in, but never on the public link. The preview runs on its own isolated address.
- **Works on a phone.** Swipe to open the sidebar; light and dark themes; keyboard and screen-reader support.
- **No chat platform needed.** A fleet can run from the web dashboard alone. Setup in the browser takes bot tokens and invites a Discord bot. Once AgEnD already runs one connection, it adds another without a restart.

See the [web dashboard guide](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.md), or the [Web Guide](/AgEnD/docs/web-guide/) on the website.

## Everything that needs you, in one list

**Needs you** collects every prompt, permission request, sign-in, crashed agent and unconfirmed delivery across your bots. It is a live message in General, and a page in the web app. Something you handle anywhere, whether in Discord, Telegram or the web, leaves every list. See [Needs you](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.md#needs-you-uineeds).

## More than one Claude account

- **Credential profiles for Claude Code.** An instance can run on another claude.ai account with `backend_options.claude-code.credential_profile`, as Codex and kiro-cli can. Sign a profile in from chat with `/login claude-code <profile>`. Usage shows one row per profile, and switching an agent to another profile keeps its conversation. See [credential profiles](https://github.com/songsid/AgEnD/blob/main/docs/configuration.md#credential-profiles-multiple-subscriptions-of-one-backend).
- **Switch an agent's CLI from chat.** `/backend` moves an instance to another backend, then lets you pick the model and effort, with one restart.

## See what your fleet is doing

- **Usage.** The usage panel (◔) shows the remaining quota of each subscription, on the right of a wide screen.
- **Log tab** (opt-in, `web.log_tab: true`). It shows an instance's prompts, replies and tool calls step by step, with secret values masked, for Claude Code and Codex.
- **Fleet pages.** Edit schedules and teams on the web. An org chart shows who does what, a cache page shows how often each agent's prompt cache expires, and each instance has a Details page.

## AgEnD brings its own Node

On Linux (glibc 2.28 or newer) and macOS 11 or newer, x64 or arm64, AgEnD installs and runs on its own Node 22.23.3, whatever Node is on your PATH. You no longer have to upgrade Node yourself. Elsewhere it needs Node 22.14 or newer. See the [upgrade guide](https://github.com/songsid/AgEnD/blob/main/docs/upgrade-2.2.md#1-before-you-upgrade).

## Upgrades that hold up on real hosts

- **macOS:** an update started from an agent's own pane finishes; it no longer leaves the fleet stopped halfway.
- **Linux, root fleets with a system unit:** the update now moves the unit to the new release, so the fleet really runs 2.2.
- **Hosts without a user session bus, or with a custom `AGEND_HOME`:** the service is updated and restarted correctly.
- **From 2.2 on, a refused install says why.** An update run by 2.2 or later shows AgEnD's own reason in chat instead of npm's bare "code 1". The hop from 2.1.12 still runs 2.1.12's updater.

## Safer by default

- **Sign-ins are revocable.** They use one-time codes and server-side sessions instead of tokens in URLs. `/web revoke` signs every browser out.
- **Sensitive Settings changes are proposals.** A fleet admin confirms them in chat, or with `agend settings confirm <id>` on the host.
- **ClassicBot approval.** An empty ClassicBot allow list no longer opens a bot to everyone: new rooms ask General for approval.

## Removed and unsupported

- **The `gemini-cli` backend is gone** (since 2.1.12). Use `backend: antigravity`: it is the same Google sign-in, through agy.
- **Not supported:** musl Linux such as Alpine, Linux without systemd, and native Windows (use WSL with systemd). AgEnD may still install there, but it is not tested. The [upgrade guide](https://github.com/songsid/AgEnD/blob/main/docs/upgrade-2.2.md#1-before-you-upgrade) lists workarounds.

For every change, see the [changelog](https://github.com/songsid/AgEnD/blob/main/docs/CHANGELOG.md).
