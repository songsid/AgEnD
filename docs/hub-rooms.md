# Hub rooms and 1:1 chats

> Not released yet. Rooms are coming in a Hub update; this page describes the
> planned behaviour, not what you see today.

On the Hub, **Chats** holds two kinds of conversation. **Chat** is 1:1 — you
and one agent. **Room** is several people plus several agents. The list on
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

Type `@` to ask an agent. The menu lists **@All agents** ("12 of them will
answer"; a room can limit this to managers), **@Room assistant** ("Provided
by the Hub"), each agent with its owner and status dot, and the room's
people (@-ing a person only nudges them — no agent answers because of it).

Picking **@All agents** previews who will answer now: "9 of 12 agents are
online, 3 will answer when online". A fixed note under the box: messages
with no @ are visible only to the room's people, and no agent answers them.
Lines starting with `/` are plain text; slash commands don't apply here.

Under a message that @-ed agents, a progress line updates live. One agent
reuses the familiar Waiting → Delivered → Answered marks. Several agents
show "Answered 7 · In progress 2 · Reply later 3", then "All 12 answered".
Answers arrive as replies under that message; more than 3 start folded
behind "Show the other 7". An offline agent appears last as "report-bot
(Ann Wu) · will answer when online" and its answer lands in the same thread.
After 24 hours with no answer: "No answer". The room assistant's answers
use a light-green bubble and read "Based on the recent conversation in this
room". While agents work, a bar reads "project-helper is working" (never
with tool steps). If a message can't go out, the reason is shown where it
was typed — e.g. "Only the room manager can @all agents in this room.",
"You are no longer in this room.", "This room is archived and read-only."

## Who sees what

Every message shows its author; your own sit on the right with no name. An
agent reads "project-helper · Lin Xiaohua's agent"; the room assistant
reads "Room assistant · Provided by the Hub". The Members panel's "Who can
see" section says it plainly: everyone in the room sees every message and
answer, and an @-ed agent reads the recent conversation.

A 1:1 chat is visible only to you — though the agent's owner sees what you
asked ("This chat is visible only to you. The agent's owner sees what you
asked."). The Hub administrator sees the room list but never any room's
content: "You cannot see any room's content here."

## Inviting agents (owner consent)

Adding someone else's agent sends an **Invitation**: the agent joins only
after its owner agrees. The owner sees it in the "Invitations · 2" row and
on their "My shared agents" page — "Manager Wang invites your agent
"project-helper" to the room "Weekly lead meeting" — the room's 3 people
can @ it there; its answers are visible to everyone in the room" — with
**Agree** and **Decline**. Agreeing shows a join line in the room and adds
the room under "Rooms it's in" on the agent's page, with "Leave this room".

An invitation waits 7 days, then lapses ("Invitation expired" in the room;
invite again). A paused agent shows "Paused" in every room and returns by
itself when sharing resumes — no re-invite needed.

## The room assistant

**Room assistant** is a member of exactly one room, named "Room assistant"
("Available · Provided by the Hub"). It answers only when @-ed, and it
reads that room's 30 most recent messages. After several agents answer an
**@All agents** message, a "Ask the room assistant to summarise" link sends
"@Room assistant, summarise the answers above" for you.

When it can't answer, its dot turns yellow ("Temporarily unable to answer")
and the message says "The room assistant can't answer right now, try again
later." or "The room assistant is busy in another room and will answer
later." One-to-one, the same assistant appears as **Hub assistant**, last
in the Agents group: a private chat that "can't read your computer, or any
other room." Your Hub administrator switches the assistant on per Hub.

## Who is online

The Members panel counts heads: "Members · 3 (2 online)", "Agents · 12
(9 online)", then the room assistant if there is one. Dots use the same
colours as the Fleet sidebar: people are green "Online" or grey "Offline";
agents green "Ready", blue "Working", yellow "Paused" (with the reason —
"Quota exhausted", "Waiting for sign-in", "Waiting for approval"), grey
"Offline" or grey "AgEnD update needed"; the assistant green "Ready", blue
"Working", yellow "Temporarily unable to answer". Someone who will answer
when online reads grey "Reply later" and is sorted last; more than 8 agents
fold behind "… 7 others". Tapping an agent shows its owner and status with
"@ it here", "Chat 1:1 with it" (only if you may ask it), and — for a Room
manager — "Remove from room".
