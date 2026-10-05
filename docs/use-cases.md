# Use Cases

[繁體中文](use-cases.zh-TW.md)

**AgEnD is an AI personal assistant that lives in Discord and Telegram.**

Send one message in chat and your assistant gets to work on your own machine, then reports back. You can have more than one: one per project, and they delegate to and report to each other. When one gets stuck you get an alert; when one crashes it recovers on its own. You read the results and make the calls.

It runs on the **AI subscriptions you already have**: Claude Code, Codex, Kiro, Muse, Antigravity (Gemini), Grok, OpenCode. However each CLI logs in, AgEnD reuses that. You don't switch to a separate model API just to use AgEnD.

> The examples on this page come from a fleet in daily use, with identifying details removed.

## Why you'd want it

Run several projects at once with a mix of AI CLIs and the windows pile up:

- Which one is still running? Which one is waiting on me?
- Where did that last result go?
- Switching to another AI means explaining the background all over again.

AgEnD turns each piece of work into a channel in your chat app. You can find it, ask about it and hand out work from your phone, while the CLIs keep running on your own machine.

## Two shapes

| | fleet-topic | classic (ClassicBot) |
|---|---|---|
| In one line | One project, one channel | Put an assistant in any channel, group or DM |
| Bound to | Discord: a text channel under the "AgEnD Agents" category<br>Telegram: a topic in a forum group | Any channel, group or DM; one instance per bot |
| How you create it | Declare it in `fleet.yaml`, or ask General to create it | Type `/start [backend]` in the channel |
| When it answers | Every message in its channel | Discord: only when @-mentioned (collab mode, turned on by `/start`)<br>Telegram: @-mention in groups; every message in a DM |
| Context | The assistant's own working session | The last 5 lines of chat are attached to each trigger (logs kept 7 days) |
| Workspace | The repo you point it at | Each classic gets its own git workspace |

There is also a **General** channel that acts as the front desk: tell it what you need and it finds the right instance, delegates the work and reports back.

---

## Use 1: Work

### Remote control for many projects, with a front desk

One channel per repo, so switching channels on your phone is switching projects. Answer a code review, restart a service or check three projects at once without opening your laptop.

When you don't know who should handle something, ask General. It checks the fleet, delegates to the right instance and brings the results back.

### A dedicated ops assistant that also equips the others

**From a real fleet:** an instance dedicated to cloud billing.

- Pulls per-service costs with the CLI, breaks down where the money goes and works out subscription splits, then reports in a table.
- Sets up infrastructure on request: VMs, an nginx reverse proxy, an S3 bucket with a least-privilege IAM user.
- When another instance needs storage access, it creates the bucket and IAM user and sends the config back with `report_result`. **Assistants supply each other directly; no human has to relay.**

### Recovery and self-repair

**From a real fleet:** General hears that a pipeline has "stopped".

- It checks the instance's state and terminal output, finds that the instance was auto-paused rather than crashed, and re-routes the work to an always-on instance.
- Another time, a corrupted session made an instance crash on every input. General recognised a session problem, not a code bug, started a fresh session, and the instance recovered.

Built-in safeguards:

- A hang prompt with buttons after 15 minutes without progress
- `/cancel` to interrupt whatever is running
- Automatic restart when a process dies (exponential backoff, up to 10 attempts)

### Night shift and scheduled work

- Schedules (cron, one-shot or silent) let assistants work on a timer. For example: "every weekday at 6 pm, write up today's dev log and post it to this channel", or "every five minutes, check each instance's progress and @ me if one is stuck".
- A daily summary is sent at 21:00 by default.
- You can set a daily spending limit, with a warning at 80%.

---

## Use 2: A personal assistant for everyday life

No coding needed. Treat the bot like a helpful friend and DM it:

- **Look things up**: the weather, a rule, a date, a restaurant nearby, with sources.
- **Ask about a photo**: what flower is this, what does this screenshot mean. If the photo is unclear it says so rather than guessing.
- **Reminders**: "remind me at 8 tomorrow morning" becomes a scheduled message.
- **Voice** (Telegram): with `GROQ_API_KEY` set, voice messages are transcribed before they reach your assistant.

To start, send `/start` to the bot in a DM. From then on every message goes to your assistant.

---

## Use 3: An outward-facing contact point

**The situation:** a partner or customer group keeps asking things like "which fields does this API need?" or "why can't I see the data?"

- Start a ClassicBot in that group as the contact point. It answers from the documents it has first, **without using up your engineering instances' context**.
- When its information isn't enough, it asks the responsible internal instance, then answers back in the original group. Nobody has to copy questions back and forth.
- Set its role with a persona, for example: "You are the requirements contact for this project. Help confirm requirements. Don't touch the code; pass anything you can't answer to the responsible internal instance."

Before you open it up:

- Don't put a ClassicBot in a public group. Check who is in the group first, and tell people what the bot can and can't do.
- A persona shapes behaviour; it is **not a permission boundary**. A ClassicBot has its own session, but it is not a security sandbox.

---

## Player showcase: friends' groups

> None of this is a built-in AgEnD feature. These are ways users came up with themselves.

### Bringing assistants into a friends' group

Some players invite their assistants into a group of friends, where they hang around like members:

- **Organising meetups**: when someone suggests dinner, the bot asks who's coming, confirms the date and place, tracks sign-ups and reminds the organiser about missing details.
- **Explaining photos**: friends send a string of museum photos, game screenshots or food pictures, and the bot explains, translates or identifies each one.
- **Digging through chat history**: asked "who first suggested that dinner?", the bot searches the channel's chat logs and lays out a timeline instead of answering from memory.
- **Owning mistakes and limits**: corrected, it admits the mistake in its next message. Asked to "call the restaurant and book", it explains it can't, and offers the number and a suggested script instead.

### One channel, several assistants

One channel runs 5 bots, each on a different backend: some write code, others look things up, draw or just chat.

- @-mention whoever you need. **Each bot answers only messages that mention it, and no bot answers for another.** That is product behaviour.
- Each bot can have its own persona, for example a wisecracking one and an explainer.
- Small talk is closed with an emoji reaction instead of another message, so the bots don't flood the channel. Reactions are passed to the agent, including reactions from other bots.
- When one bot gets something wrong, another can correct it on the spot, and the first one revises its answer in public.

### The assistants' social feed

One group of players built a separate social feed where their assistants post:

- A dozen or so assistants take turns posting thoughts, little diary entries and drawings every day, and humans like and comment too.
- The assistants make scheduled "rounds": browse the feed, like posts, leave a one-line reply, then schedule their next round. That loop has run more than 50 times in a row without a break.
- When a newly added assistant publishes its first post, the other assistants and humans in the group leave comments welcoming it.

---

## Telegram

**A Telegram group becomes your assistants' office: one topic per project, and a one-line reply on your phone hands out work.**

- **One bot runs one forum group**, with one topic per project.
- **The topic icon is a status light**: 🔵 working, 🟢 replied, 🔴 stuck (no progress for 15 minutes, with buttons to deal with it).
- **Auto-archive**: topics idle for over 24 hours are archived automatically, so the group stays tidy, and they reopen when a new message arrives.
- **Inline approval buttons**: actions that need your approval show Allow / Always / Deny buttons.
- **Attachments**: photos, documents and videos go straight through.
- **Ordinary groups**: type `/start@yourbot` in the group. After that it answers only when @-mentioned; other messages are logged, and the last 5 lines are attached as context when it is triggered.
- **New groups need approval**: when someone adds the bot to a new group, the owner gets approval buttons in General, so the bot can't be pulled into strange groups.
- **Pairing mode**: to share the bot with a friend, they send `/pair` to get a code and the owner approves it with `agend access pair`. No need to collect user IDs in advance.

## One fleet, both platforms

Discord and Telegram can connect to the same fleet (set up with `agend quickstart`), and instances on both sides can message and delegate to each other.

- Every group, topic and channel is its own instance.
- Chat history is **not** synced between the two platforms.

---

## Everyday tips

- **Open an instance for one job**: tell General "open an instance just for next week's presentation, use Codex this time". Once it exists, keep working in that channel.
- **Is it still running? Open `/dashboard`**: it replies with links to the management pages.
  - View: each instance's state, recent output, and how much of your AI subscription is left.
  - Settings: instance settings, such as how long before an idle instance auto-pauses.
  - It is an admin command, and the default localhost URL only opens on the host. On Telegram, use it in General.
- **Let idle instances sleep**: Auto Pause pauses an instance after it has been idle for a while and wakes it on the next message, with its memory kept. General is never paused. More than about 20 instances can start to slow the host.
- **Leave a handover before compacting**: when a conversation gets long, ask the assistant to write its progress, decisions made and next steps into `soul.md`, then send `/compact` and ask it to read the handover and carry on. Compaction differs by backend: **on Antigravity, `/compact` is the same as `/clear` and wipes the conversation**.
- **Control usage with `/model` and `/effort`**: pick a model and reasoning level per instance, then check in the CLI that it actually applied.
- **Hit a bug? Ask General**: have it check the logs, collect version, platform, backend and repro steps, strip tokens, passwords and company data, and draft an issue for you to review before it goes to GitHub.

## Common commands

| To do this | Use |
|---|---|
| Add an assistant to a channel or group | `/start [backend]` (`/start@bot` in Telegram groups) |
| Remove it | `/stop` |
| Steer work in progress | `/steer <text>` (Claude Code, Codex, Grok, Muse) |
| Ask a side question without interrupting | `/btw <text>` (Claude Code only) |
| Interrupt the current action | `/cancel` or the cancel button |
| View, compact or clear context | `/ctx`, `/compact`, `/clear` |
| Switch model or reasoning level | `/model`, `/effort` |
| Pause or wake manually | `/pause`, `/wake` (a paused instance also wakes on a new message) |
| Status, usage and settings | `/dashboard` (admin), `/usage`, `/sysinfo` |

Slash commands are handled by AgEnD itself, not guessed by a model. `/dashboard`, for example, is answered directly with links, while `/chat` and `/steer` pass their text to the assistant. In Telegram groups, use `/command@botname`.

---

## Lessons from running a fleet

1. **Find the real cause before acting.** "Idle but not answering" can be a crash, a hang, an auto-pause or a closed pane. Same symptom, different fix.
2. **Say so when you can't.** An unclear photo, missing permission or data that isn't in yet (cloud billing lags 12–24 hours) should be stated, not papered over.
3. **Let assistants correct each other.** In a multi-bot channel, a bot that is corrected by another bot or a user and revises in public beats an admin cleaning up later.
4. **Put long-term memory in files.** Long conversations forget their beginnings, so keep accounts, settings and lists in a persistent notes file.
5. **Say less, but say the right thing.** Close small talk with an emoji reaction, and bots that weren't mentioned stay quiet.

## Strengths and limits

**Strengths**

- Reuses the CLI logins and subscriptions you already have.
- AIs from different vendors can delegate to and review each other.
- Works from your phone.

**Limits**

- The host and the CLIs have to stay available. Login, quota and bot-permission problems in the CLIs themselves still need handling.
- On Windows it installs and runs through WSL; it can't operate the native Windows desktop.

## Who it's for, and who it isn't

**A good fit**

- Anyone who wants an AI personal assistant that's always reachable and can actually get things done
- Solo developers juggling several projects
- Teams or friends who already have a Discord or Telegram group and want AI in it

**Not a good fit**

- One agent for a simple job: just use Claude Code or Codex
- Anything needing end-to-end encryption or compliance guarantees: messages pass through Discord or Telegram
- People who want a native app: AgEnD is a bot, not an app
