# Hub one-to-one: an agent messages its asker on its own (M-3638)

Status: the owner chose the direction on 2026-11-24; this is the design to build. No code. Written 2026-11-24 against the dev tip `9f9c34dfd`.
Revised the same day on the owner's direction: follow the ClassicBot model, where an agent posts into the person's
chat whenever it has something. A short follow-up window is no longer the main option, and flooding is not a
concern for now.

## The problem

In a one-to-one chat with a shared agent, each question takes exactly one answer. The agent answers with
`report_result` on the Hub's correlation id; the Fleet marks that id used as it releases the answer
(`src/hub/representative.ts`, `report()`: "consume once"). A second report on the same id is not a Hub answer any
more.

An agent that answered "I'll prepare the data pack" and later wanted to add "the data pack is ready" was refused.
M-3637 makes that refusal say why. A ClassicBot in a Discord or Telegram chat has no such limit: it replies into
its chat whenever it has something. In a Hub group room an agent can also post again with `hub_room_post`. Only
the Hub one-to-one is limited to one answer.

## The model

**A one-to-one is a chat the agent can post into at any time, as long as the person may still ask it.** A question
is not needed first each time, and there is no window after an answer.

| Point | Choice |
|---|---|
| Where | Only a one-to-one that already exists: the person opened it and has asked this agent at least once. An agent cannot start a chat with someone who never asked it |
| When | Any time, while every check below holds |
| Content | Text and files, with an answer's size limits. Buttons and polls in phase 2 |
| Who sees it | Only that person |

### Consent and grant

Being allowed to ask an agent means agreeing to receive its messages in that one-to-one. There is no separate
opt-in prompt. The person has two ways out, both in the one-to-one's "…" menu:

- **Mute this agent's own messages.** While on, the agent can still answer the person's questions, but a message
  it sends on its own is refused, and the agent is told the person turned them off. The person turns it back on
  in the same place. Refusing is chosen over delivering silently, so nothing piles up unseen.
- **Close the chat**, as today. It stops everything until the person opens it again.

Each message is checked at the moment it is sent, for exactly its text and files, like an answer. All must hold:

1. the agent is still shared, with the same consent (a backend or folder change ends it until shared again);
2. the person may still ask this agent now (Who may ask, a group, a team grant), and that grant has not expired;
3. the agent's sharing is not paused by its owner;
4. the person's account is active (not removed from the Hub) and the one-to-one is not closed;
5. the person has not muted the agent's own messages;
6. the sending agent process is the current one.

A failed check refuses the message and returns the reason to the agent in one sentence: not allowed any more,
paused, expired, the person has left, the chat is closed, the person turned messages off, or this Hub is too old.
Nothing is kept to send later: a message that appears after a pause is lifted or a grant is given back would
surprise both sides. A message already delivered stays in the chat.

Revoke, pause and expiry therefore stop messages at once, with no extra setting: the right to be asked and the
right to message are the same grant.

### What the person sees

- A new message from the agent at the bottom of the one-to-one, as an answer looks. In phase 1 it stands alone;
  quoting an earlier question comes in phase 2.
- It counts as unread and notifies exactly like an answer: the badge on the chat in the list, and whatever
  notification the person has for answers.
- The status line (M-3596) is unchanged. It shows working or queued only while a question has no answer. A
  message from the agent does not open it.
- The person's reply is an ordinary question to the agent.
- Offline or signed out: the message waits in the chat, unread.

### The agent's tool

**`hub_room_post` with the one-to-one as the room.** One tool, the same as for group rooms.

- `hub_room_list` also lists the agent's one-to-ones, marked as such and named by the person. The agent posts
  with the id.
- The result says "Delivered to <name>." or gives the refusal reason.
- The question prompt gains one sentence: the agent may write to this person again later with `hub_room_post`,
  and gives the one-to-one's id.
- A second `report_result` on an answered correlation id keeps M-3637's refusal, which now names `hub_room_post`
  and the id to use. Turning that second report into a message is left to phase 2: it needs answered ids kept
  with no end date, and one way in is simpler to explain and to test.

An agent already receives the asker's verified name with each question, so listing its one-to-ones shows it
nothing new.

### Rate cap (a safety net)

- 30 messages an hour from one agent to one person, the same number as a person's direct questions per hour.
- The same text as the agent's previous message in that chat within a minute is refused as a duplicate, which
  stops a double report from showing twice.
- Over the cap, the message is refused with the time it may try again. The owner sees nothing unless it repeats;
  the builder may add one Needs-you line for an agent that keeps hitting the cap.

These exist to stop a looping agent, not to shape normal use.

## Phases

**Phase 1 (aimed at size M).**

- `hub_room_post` into an existing one-to-one, text and files.
- `hub_room_list` lists the agent's one-to-ones.
- The six checks, with the reason returned to the agent.
- The message shows in the one-to-one, unread and notified like an answer.
- The person's mute in the "…" menu.
- The rate cap and the duplicate check.
- M-3637's refusal and the question prompt name `hub_room_post`.

**Phase 2.**

- A second `report_result` on an answered id becomes a message.
- Quoting a question (`receipt_id`), buttons and polls.
- A Needs-you line for the owner when an agent keeps hitting the cap.

**Not planned.**

- An agent starting a chat with someone who never asked it.
- A "more is coming" state on the status line.

If the builder finds that a one-to-one cannot reuse the room-post machinery, phase 1 is larger than M. The mute
is then the part to move to phase 2, since closing the chat already gives the person a way out.

## For the builder to confirm before building

- Whether the Hub's journal and the receipt stages assume one agent message for a question, and what a message
  with no question needs.
- Which authorization the release uses: `phase: "release-answer"` is tied to a question's message id; a message
  with no question needs its own phase or the room-post path.
- Whether a one-to-one can go through the room-post machinery (`src/hub/member/room-post.ts`) or needs its own
  route beside the direct service.
- That the one-to-one view (`src/hub/rooms/direct-view.ts`) can show agent messages that belong to no question.
- That an older Hub refuses cleanly (a negotiated feature on the link).
