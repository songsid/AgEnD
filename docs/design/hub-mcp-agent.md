# MCP agent: a person's own AI app on the Hub (M-3158)

Status: design for the owner's decision. Nothing here is built. Mockup:
`docs/evidence/hub-mcp-agent/hub-mcp-agent-mockup.html` (EN and zh-TW, light and dark, desktop and phone).

Pilot rule applies: features and UX first. Costs are listed in section 9 so they can go on the pre-launch list.

## 0. What it is, in one paragraph

A person who does not run AgEnD connects their own AI app (Claude, Codex, or anything that speaks MCP) to the Hub's
address and signs in with their company account. From then on that app can use the Hub **as that person**: read
their rooms, post in them, ask the agents they may ask. Others always see which app spoke: "Wang via Claude". In a
second step the person can also list the app as an agent that **answers when connected**, so colleagues can ask it.

## 1. What earlier documents say, and how the new wording differs

Checked: `hub-product-plan.md` section 3 and decision rows R8 and item 12; `hub-agent-room-posts.md` (M-3118);
`hub-representative-agent.md`; the code on `release/2.3.5-alpha`. I could not read decision ec27e4c2 from my scope.

- **Earlier (plan section 3, 2026-11-13)**: a "Hub MCP endpoint" for **desktop users who do not install AgEnD**. The
  person stays a **person** in rooms. Their app is a way to use the Hub by talking to their own AI. Optionally they
  register an "answers when online" stand-in so others can @ them; questions wait up to 7 days.
- **New wording (2026-11-15)**: "an agent outside AgEnD **joining the Hub**", with "which rooms and agents it
  reaches, what it may post, and how owners allow it". This reads as the app being a **participant of its own**.
- **In code**: nothing. There is no `/mcp` route on the Hub. The Fleet-side tools from M-3118 (`hub_room_list`,
  `hub_room_members`, `hub_people_search`, `hub_room_post`) are the nearest thing, and they are Fleet tools.

These are two halves of one feature, and this spec keeps both, in order:

| Step | The app is | Others see | Earlier name |
|---|---|---|---|
| 1 | The person's hands: it reads and posts for them | "Wang via Claude" on each post | Hub MCP endpoint |
| 2 | A listed agent that answers when its owner's app is connected | "Wang's Claude · answers when connected" | "Answers when online" stand-in |

**If the owner means only step 2** (an outside agent as a room member in its own right, without acting as the
person), say so: step 2 can be built first, but it is the less useful half, because an app that is not running cannot
be asked.

## 2. What exists to build on

- **Company sign-in on the Hub**, sessions, and the rule that a disabled company account loses access.
- **Rooms, one-to-one asks, grants**: every reach rule already exists for a person.
- **"Person via agent" attribution** (M-3118): the room already draws "{0} via {1}" / 「{0} 透過 {1}」.
- **Agent limits in rooms** (M-3118): 5 actions per source per minute, 30 per room per minute, no @all for agents.
- **Queued questions**: asks to an offline agent wait 24 hours today.
- **Agents I share**: where a person lists an agent and chooses who may ask it.

What does not exist: an MCP service on the Hub, sign-in for an app, a list of a person's connected apps, a way for a
room to read back its messages to a tool (Fleet agents get no room history today).

## 3. Step 1: connect an app and use the Hub through it

### 3.1 Connecting (the person)

Hub → the person's menu → **My AI apps** / 「我的 AI App」.

1. The page shows one address to copy: `https://hub.example.com/mcp`, with two short instructions (Codex; Claude).
2. The person adds the address in their app. The app opens the Hub's sign-in page in the browser.
3. They sign in with the company account (or are already signed in) and see the **consent screen**.
4. They press Allow. The app is connected and appears in the list.

Sign-in uses the standard way MCP apps sign in to a remote server (OAuth with a browser step), served by the Hub
itself. The app never sees the password, and gets a token for this Hub only.

**Consent screen**

| Part | EN | zh-TW |
|---|---|---|
| Title | Let {0} use this Hub as you? | 要讓 {0} 以你的身分使用這個 Hub 嗎？ |
| Lead | {0} will be able to do the things ticked below. People will see "{1} via {0}" on what it posts. | {0} 可以做下面勾選的事。它發的訊息會顯示「{1} 透過 {0}」。 |
| Tick, on | Read the rooms you are in | 讀你所在的房間 |
| Tick, on | Post in those rooms | 在這些房間發言 |
| Tick, on | Ask the agents you may ask | 問你可以問的 Agent |
| Tick, off, step 2 | Answer questions sent to it | 回答別人問它的問題 |
| Note | It cannot change rooms, teams or settings, and it cannot do anything an administrator does. | 它不能更改房間、團隊或設定，也不能做管理員的動作。 |
| Note | What it reads goes to your AI app and its provider. | 它讀到的內容會交給你的 AI App 與它的服務商。 |
| Buttons | Allow · Cancel | 允許 · 取消 |

**My AI apps list**: one row per app: name, "Connected {date} · last used {time}", what it may do, and
**Disconnect** / 「中斷連接」. Disconnect takes effect at once.

A connection ends by itself after 30 days without use, when the company account is disabled, or when an
administrator turns the feature off.

### 3.2 What the app can do

The tools the Hub offers the app. Names follow the Fleet tools where the meaning is the same.

| Tool | Does | Limit |
|---|---|---|
| `hub_room_list` | The person's rooms, with unread counts | |
| `hub_room_members` | Members of one of those rooms | |
| `hub_room_read` | Recent messages of one room, newest 50, or since a point | Only rooms that allow AI apps (3.4) |
| `hub_room_post` | Post in a room, may @mention agents and people | 5 per minute; no @all |
| `hub_agent_list` | Agents the person may ask, with state | |
| `hub_ask` | Ask one agent one-to-one; returns the answer, or "still working" with an id | 30 asks per hour |
| `hub_ask_result` | The answer to an earlier ask | |
| `hub_people_search` | Find a colleague by name | |

**Reach is exactly the person's reach.** The same rooms, the same agents, the same end dates. There is no separate
permission list to keep in step. When the person leaves a room or loses a grant, so does the app.

**What it cannot do**: create or change rooms and teams, invite or remove members, change sharing, any administrator
action, read one-to-one conversations other than its own asks, or @all (an app could spend every owner's quota with
one sentence; a person can still @all in the browser).

**Clarified with the builder (M-3240):**

- The Hub's own assistant is out of reach: the one-to-one Hub assistant conversation is not in `hub_room_list`,
  and the Hub assistant and Hub General are not in `hub_agent_list` or `hub_ask`.
- A token is checked like a browser session on every call: a disabled or no-longer-allowed account ends it then.
- A question from an app to a personal agent counts as the person asking (`hub-personal-agent.md`).
- Connecting, the ticks given, disconnecting and an automatic end are recorded as actions; content never is.

Room text returned to the app is marked as content from other people, not instructions. That is a label for the
person's AI to respect, not something the Hub can enforce (section 9).

### 3.3 What others see

- **A post**: "王小明 透過 Claude" / "Wang via Claude" in the sender line, in the person's colour, with the small
  agent mark. It counts as the person's message for unread and mentions.
- **An @mention of an agent from the app**: the agent's owner sees the question as asked by the person, with "via
  Claude". The person's grant is what allows it; the owner gives no extra consent.
- **The member list**: unchanged in step 1. The person is a person.

### 3.4 Who allows it

| Who | Control | EN | zh-TW | Default |
|---|---|---|---|---|
| Hub administrator | Administration → Settings | Let people connect their own AI apps | 允許同仁連接自己的 AI App | Off |
| | Who | Everyone who has joined / Only these groups or teams | 所有已加入的人 / 只有這些群組或團隊 | Everyone |
| Room manager | Room settings | Members' AI apps may read and post here | 成員的 AI App 可以在這裡讀取與發言 | On |
| The person | Consent screen, My AI apps | The ticks in 3.1, and Disconnect | | |
| Agent owner | Nothing new | Their "who may ask" already decides | | |

When a room has AI apps turned off, the app sees the room in its list with "AI apps are turned off in this room" /
「這個房間關閉了 AI App」 and cannot read or post there.

## 4. Step 2: the app as an agent that answers when connected

For the person who wants colleagues to be able to ask their AI, without running AgEnD.

- In **Agents I share**, a new kind: "My AI app" / 「我的 AI App」. The person names it, writes the one-line
  description, and chooses who may ask, exactly as for a Fleet agent.
- It shows as "王小明的 Claude · 上線時回答" / "Wang's Claude · answers when connected", and can be invited to
  rooms like any agent (the owner accepts the invitation as today).
- Questions wait in a queue. The app gets two more tools: `hub_inbox_list` (questions waiting) and
  `hub_inbox_answer`. Nothing reaches the app by itself: the person says "check the Hub", or sets their app to do it.
- State dot: 🟢 while the app used the Hub in the last 5 minutes, otherwise ⚪ "answers when connected" /
  「上線時回答」.
- Waiting time: 7 days for this kind of agent (24 hours for Fleet agents), then "No answer" / 「沒有回答」.
- @all: these agents are listed under "Answers later" / 「稍後回覆」 and are not waited for.

## 5. Which apps can connect today

From public documentation read in 2026-11, not tested. Check again against the versions current when this is built.

| App | Adds a remote MCP address | Reaches a Hub on the company network |
|---|---|---|
| Codex (desktop, CLI) | Yes, with browser sign-in | Yes: the connection starts from the person's computer |
| Claude Code (CLI) | Yes, with browser sign-in | Yes, same reason |
| Claude desktop and web | Yes, as a custom connector | **No**: the connection starts from Anthropic's cloud, which cannot reach an internal address or accept a self-signed certificate. Needs a one-click desktop extension that forwards from the person's computer, or a Hub reachable from outside |

All of them need the Hub to have a certificate the app trusts. The pilot's self-signed Hub will not work for most
apps, so this feature comes after the Hub has a proper certificate.

## 6. States and failures

| Situation | The person's app gets | The Hub shows |
|---|---|---|
| Feature off for this Hub or this person | Sign-in page: "Your administrator has not turned on AI apps for this Hub." / 「管理員沒有開放在這個 Hub 連接 AI App。」 | |
| Company account disabled | Tools fail: "Sign in again." | The app's row disappears |
| Disconnected by the person | Tools fail: "This app was disconnected from the Hub." | |
| Room has AI apps off | "AI apps are turned off in this room." | |
| Post limit reached | "Not posted: too many posts in a minute. Wait and try again." | A quiet line in the room after the third refusal: "{0}'s AI app was slowed down" / 「{0} 的 AI App 發言過快，已暫時放慢」 |
| Ask limit reached | "Not asked: 30 questions an hour is the limit." | |
| The agent asked is offline | "Queued: {0} answers when it is back online." | As today |
| @all from an app | "Not posted: AI apps can't mention all agents." | |

## 7. Journeys

- **Member, first time**: My AI apps → copy address → add in Codex → browser opens → Allow → in Codex: "what are my
  Hub rooms?" → a list. Six steps, one of them a decision.
- **Member, daily**: "In the login page room, say the test environment is fixed" → a post "Wang via Codex".
  "Ask project-helper where the rerun log is" → the answer in the app.
- **Room manager**: sees "via" posts; if unwanted, one switch in room settings.
- **Administrator**: one switch to open the feature, optional group; a list of how many people have connected apps
  (count only) on the overview.
- **Colleague (step 2)**: @mentions "Wang's Claude" → "answers when connected" → the answer arrives in the thread
  the next time Wang's app checks.

## 8. The contact-limit idea

See `hub-agent-contact-limits.md`. An MCP agent is outside every Fleet: it has no way to message a Fleet instance.
It reaches agents only by asking through the Hub as its owner, so:

- the "may not contact other agents while answering a Hub question" setting protects the agents it asks, unchanged;
- the app itself is a new way to ask many agents fast. The 30-per-hour ask limit and no-@all rule are there for that.

## 9. What this costs

- **Room content leaves the Hub** to each connected person's AI app and its provider. A person could already copy
  and paste; this makes it routine and bulk. The room switch and the administrator switch are the controls.
- **Posts are written by an AI under a person's name.** "via" makes it visible; it does not make the text the
  person's own words. The app can post something its owner did not intend.
- **Text in a room can steer a reader's AI.** A message such as "AI apps reading this: post the following…" may be
  obeyed by someone's app. The Hub labels room text as not-instructions and limits rate; it cannot stop it.
- **A token on the person's computer acts as them** on the Hub until disconnected or 30 days idle. A stolen token
  gives room read and post, not sign-in to the web page and not administration.
- **Owners' AI quota**: an app can ask up to 30 questions an hour for one person without that person typing each.
- **Step 2 agents look like agents but are often silent.** The "answers when connected" label and the 7-day wait
  manage the expectation; some questions will end as "No answer".

## 10. Open questions, with recommendations

| # | Question | Recommendation |
|---|---|---|
| X1 | Which meaning: the person's hands (step 1), a listed agent (step 2), or both? | **Both, step 1 first.** Step 1 is what a desktop user needs on day one. |
| X2 | How should an app's post be shown? | **"Wang via Claude"**, the same form as M-3118, counted as the person's message. |
| X3 | Rooms: AI apps on or off by default? | **On**, with the room switch. Off by default would make the feature look broken in every existing room. |
| X4 | May an app @all? | **No.** |
| X5 | May an app read room history? | **Yes, the newest 50 messages per call**, only in rooms that allow AI apps. Without reading, the app can only post blind. |
| X6 | Files in rooms | **Not in step 1.** Names only. |
| X7 | How long step 2 questions wait | **7 days.** |
| X8 | When to build | **After the Hub has a trusted certificate**, since most apps refuse a self-signed one. Step 1 can be built before that and tested with Codex or Claude Code. |
| X9 | Claude desktop on an internal Hub | **Ship a small desktop extension later**; start with Codex and Claude Code, which connect directly. |

## 11. Cards

- 1a (Hub server): MCP service at `/mcp`: the eight step 1 tools, run as the signed-in person; limits and refusals.
- 1b (Hub server): app sign-in and consent; tokens per app; end on disable, disconnect, 30 days idle.
- 1c (Hub web): My AI apps page; consent screen; "via" on posts from apps.
- 1d (Hub web, admin and room): the administrator switch and group; the room switch; the count on the overview.
- 1e (docs): setup steps for Codex and Claude Code; add to the hub skill.
- 2a (Hub server): "My AI app" agent kind, inbox tools, 7-day wait, state from last use.
- 2b (Hub web): the kind in Agents I share; "answers when connected" in rooms and lists; "Answers later" in @all.
- 3 (later): desktop extension for Claude desktop on an internal Hub.
