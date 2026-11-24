# Hub one-to-one: an agent messages its asker on its own (M-3638)

Status: design for the owner to choose from. No code. Written 2026-11-24 against the dev tip `9f9c34dfd`.
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
| Content | Text and files, with an answer's size limits. Buttons and polls as answers have them, if the builder finds they come at no extra cost; otherwise later |
| Who sees it | Only that person |

### Consent and grant

Each message is checked at the moment it is sent, for exactly its text and files, like an answer. All must hold:

1. the agent is still shared, with the same consent (a backend or folder change ends it until shared again);
2. the person may still ask this agent now (Who may ask, a group, a team grant), and that grant has not expired;
3. the agent's sharing is not paused by its owner;
4. the person's account is active and the one-to-one is not closed;
5. the sending agent process is the current one.

A failed check refuses the message with a one-sentence reason to the agent (not allowed any more, paused, expired,
the person has left, this Hub is too old). Nothing is kept to send later: a message that appears after a pause is
lifted or a grant is given back would surprise both sides. A message already delivered stays in the chat.

Revoke, pause and expiry therefore stop messages at once, with no extra setting: the right to be asked and the
right to message are the same grant.

### What the person sees

- A new message from the agent at the bottom of the one-to-one, as an answer looks. When the agent names the
  earlier question, the message quotes it; otherwise it stands alone.
- It counts as unread and notifies exactly like an answer: the badge on the chat in the list, and whatever
  notification the person has for answers.
- The status line (M-3596) is unchanged. It shows working or queued only while a question has no answer. A
  message from the agent does not open it.
- The person's reply is an ordinary question to the agent.
- Offline or signed out: the message waits in the chat, unread.

### The agent's tool

Two ways in, one path behind them:

1. **`hub_room_post` with the one-to-one as the room.** `hub_room_list` also lists the agent's one-to-ones, marked
   as such, named by the person. The agent posts with the id, as to a room. `receipt_id` quotes a question. This is
   the same tool and habit as group rooms, so there is nothing new to learn.
2. **`report_result` on a correlation id that was already answered** becomes a message in that one-to-one, quoting
   that question, instead of a refusal. This is what agents already try, as the reported case shows.

The result says "Delivered to <name>." or gives the refusal reason. The question prompt gains one sentence telling
the agent it may write to this person again later with `hub_room_post`.

An agent already receives the asker's verified name with each question, so listing its one-to-ones shows it
nothing new.

### Rate cap (a safety net)

- 30 messages an hour from one agent to one person, the same number as a person's direct questions per hour.
- The same text as the agent's previous message in that chat within a minute is refused as a duplicate, which
  stops a double report from showing twice.
- Over the cap, the message is refused with the time it may try again. The owner sees nothing unless it repeats;
  the builder may add one Needs-you line for an agent that keeps hitting the cap.

These exist to stop a looping agent, not to shape normal use.

## Options

- **A (recommended): the model above, with both ways in.** Size M to L; the builder confirms.
- **B: the model above with `hub_room_post` only.** A second `report_result` still gets M-3637's refusal, which
  then points to `hub_room_post`. A little less to build, but the agent's natural second report fails once before
  it learns.
- **C: a new tool, `hub_direct_post({to})`.** Clearer name, but one more tool in every shared agent's list for
  something `hub_room_post` already expresses.

## Left for later

- A mute or "don't message me" setting for the person. Not needed while flooding is not a concern; the person can
  stop it today only by asking the owner or an administrator. Worth adding before the Hub opens beyond the pilot.
- An agent starting a chat with someone who never asked it.
- A "more is coming" state on the status line.

## For the builder to confirm before building

- Whether the Hub's journal and the receipt stages assume one agent message for a question, and what a message
  with no question needs.
- Which authorization the release uses: `phase: "release-answer"` is tied to a question's message id; a message
  with no question needs its own phase or the room-post path.
- Whether a one-to-one can go through the room-post machinery (`src/hub/member/room-post.ts`) or needs its own
  route beside the direct service.
- That the one-to-one view (`src/hub/rooms/direct-view.ts`) can show agent messages that belong to no question.
- That an older Hub refuses cleanly (a negotiated feature on the link).
