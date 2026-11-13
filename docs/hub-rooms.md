# Hub rooms and 1:1 chats

> Not released yet. Rooms are coming in a Hub update; this page describes the
> planned behaviour, not what you see today.

The Hub has two kinds of conversation: a **Chat** is 1:1 — you
and one agent; a **Room** is several people plus several agents. The list on
the left has a **Rooms** group (one row per room: its first letter, its name,
"3 people · 12 agents") and an **Agents** group (one per 1:1 chat: the
agent's name, its owner, a status dot). **Hub assistant** sits last in the
Agents group. **+ New chat** and **+ New room** start either kind; without
room-opening permission there is no **+ New room**.

**+ New room** asks for a name (required, up to 60 characters), members
(search people, teams, or AD groups), agents (yours join at once; someone
else's go as an invitation), and a switch for the room assistant. **Create**
enters the room; its first line reads "Manager Wang created this room."

## @ an agent and @ all

Type `@` to ask an agent. The menu lists **@All agents** ("12 will all
answer"; a room can limit this to managers), **@Room assistant** ("Provided
by the Hub"), each agent with its owner and status dot, and the room's
people (@-ing a person only nudges them — no agent answers because of it).

Picking **@All agents** previews who will answer now: "12 agents, 9 online,
3 will answer after they come online". A fixed note under the box:
"Messages with no @agent are seen only by people in the room; agents will
not answer." Lines starting with `/` are plain text; slash commands don't
apply here.

Under a message that @-ed agents, a progress line updates live. One agent
reuses the familiar Waiting → Delivered → Answered marks. Several agents
show "Answered 7 · working 2 · reply later 3", then "All 12 answered".
Answers arrive as replies under that message; more than 3 start folded
behind "Show the other 7". An offline agent appears last as "report-bot
(Ann Wu) · answers after they come online" and its answer lands in the same
thread.
After 24 hours with no answer: "No answer". The room assistant's answers
use a light-green bubble and read "Based on this room's recent
conversation". While agents work, a bar reads "project-helper is working on
it" (never with tool steps). If a message can't go out, the reason is shown
where it was typed — e.g. "Only a room manager can @All agents in this
room.", "You are no longer in this room.", "This room is archived; you
can't send messages."

## Who sees what

Every message shows its author; your own sit on the right with no name. An
agent reads "project-helper · Lin Xiaohua's agent"; the room assistant
reads "Room assistant · Provided by the Hub". The Members panel's "Who can
see this" section says it plainly: "Everyone in the room sees every message
and answer. An @agent reads the recent conversation."

A 1:1 chat is visible only to you — though the agent's owner sees what you
asked ("Only you see this chat. The agent's owner sees what you asked.").
The Hub administrator sees the room list but cannot see a room's
content from the list; joining a room as its manager (which posts a notice
in the room) is the only way in: "Room content is not visible here."

## Inviting agents (owner consent)

Adding someone else's agent sends an **Invitation**: the agent joins only
after its owner agrees. The owner sees it in the "Invitations · 2" row and
on their "My shared agents" page: "Manager Wang invited your agent
“project-helper” to the room “Weekly lead meeting”" and "The 3 people in
the room can @ it there; everyone in the room sees its answers." — with
**Agree** and **Decline**. Agreeing shows a join line in the room and adds
the room under "In these rooms" on the agent's page, with "Leave this
room".

An invitation waits 7 days, then lapses; the room manager sees
"Invitation expired" and can invite again. A paused agent shows "Paused" in
every room and returns by
itself when sharing resumes — no re-invite needed.

## The room assistant

**Room assistant** is a member of exactly one room, named "Room assistant"
("Idle · provided by the Hub"). It answers only when @-ed, and it
reads that room's 30 most recent messages. After several agents answer an
**@All agents** message, a "Ask the room assistant to summarise" link sends
"@Room assistant, summarise the answers above" for you.

When it can't answer, its dot turns yellow ("Cannot answer right now")
and the message says "The room assistant cannot answer right now. Try again
later." or "The room assistant is busy in another room; it will answer
later." One-to-one, the same assistant appears as **Hub assistant**, last
in the Agents group: a private chat — "It cannot read your computer or
other rooms." Your Hub administrator switches the assistant on per Hub.

## Who is online

The Members panel counts heads: "Members · 3 (online 2)", "Agents · 12
(online 9)", then the room assistant if there is one. Dots use the same
colours as the Fleet sidebar: people are green "Online" or grey "Offline";
agents green "Idle", blue "Working", yellow "Paused" (with the reason —
"Out of quota", "Waiting to sign in", "Waiting for approval"), grey
"Offline" or grey "Needs an AgEnD update"; the assistant green "Idle", blue
"Working", yellow "Cannot answer right now". Someone who will answer
when online reads grey "Answers when online" and is sorted last; more than 8
agents
fold behind "… 7 more". Tapping an agent shows its owner and status with
"@ it here", "Chat with it one-to-one" (only if you may ask it), and — for
a Room manager — "Remove from room".
