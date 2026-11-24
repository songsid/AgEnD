# Hub one-to-one: an agent adds follow-ups after its answer (M-3638)

Status: design for the owner to choose from. No code. Written 2026-11-24 against the dev tip `9f9c34dfd`.

## The problem

In a one-to-one chat with a shared agent, each question takes exactly one answer. The agent answers with
`report_result` on the Hub's correlation id; the Fleet marks that id used as it releases the answer
(`src/hub/representative.ts`, `report()`: "consume once"). A second report on the same id is not a Hub answer any
more.

An agent that answered "I'll prepare the data pack" and later wanted to add "the data pack is ready" was refused.
M-3637 makes that refusal say why. This design lets the follow-up through. In a group room an agent can already
post again with `hub_room_post`; a one-to-one has no equivalent.

## What stays the same in every option

- A follow-up is the agent's message to the person who asked. Nobody else sees it.
- Every follow-up passes the same release check as an answer, at the moment it is sent, for exactly its text and
  files. Nothing is approved in advance at answer time.
- No follow-up is stored for later delivery after a refusal. The agent is told the reason and that is the end.
- The owner's Fleet keeps its audit line for each one, as for an answer.

## Options

### A. Follow-ups on the answered question (recommended)

The question's correlation id stays usable after the answer, for a limited window and a limited count. The agent
sends a follow-up the way it sent the answer.

| Point | Choice |
|---|---|
| Window | 24 hours after the answer |
| Count | Up to 5 follow-ups for one question |
| Agent's tool | `report_result` to `agend-hub` with the same `correlation_id`. The first is the answer, later ones are follow-ups. No new tool, no new argument |
| What the agent is told | On success: "Delivered as a follow-up (3 left, until 14:20 tomorrow)". On refusal: the reason, in one sentence (window over, count used, no longer allowed, paused, asker gone, this Hub is too old) |
| Content | Text and files, with the answer's size limits. No buttons or polls in the first version |
| What the asker sees | A new message from the agent at the bottom of the chat, quoting the question it belongs to, as the answer does. It counts as unread and notifies exactly like an answer |
| Status line (M-3596) | Unchanged. The line shows working or queued only while a question has no answer. A follow-up arrives as a message and does not reopen it |

**Checks at each follow-up.** All must hold, as for an answer:

1. the agent is still shared, with the same consent (a backend or folder change ends follow-ups, like asks);
2. the asker may still ask this agent (Who may ask, a group, a team grant);
3. the agent is not paused by its owner;
4. the asker's account is still active and the one-to-one is not closed;
5. the reporting agent process is the current one.

A failed check refuses the follow-up. A paused agent is refused, not held: a message that appears hours after
"paused" was lifted would surprise both sides.

**Noise limits.**

- 5 for one question and 24 hours, as above.
- The same text as the previous message to that question is refused as a duplicate. This also stops an agent that
  reports twice by mistake from answering twice.
- Follow-ups count toward the agent's existing rate limits for answers.

**If the asker has left.**

- Offline or signed out: the follow-up is kept in the chat and is unread when they return. Same as an answer.
- Removed from the Hub, access revoked, or the one-to-one closed: refused; the agent is told the asker can no
  longer be reached. The text is not sent anywhere.

**Cost.** Size M. The Fleet keeps an answered question's record for the window. The link needs a negotiated
feature so that an older Hub refuses a follow-up cleanly. The Hub accepts more than one agent message for a
question and shows them in order.

### B. The agent may post in the one-to-one at any time

The one-to-one behaves as a room with two members: the agent uses `hub_room_post` with the one-to-one as the room,
with no question needed.

- Window and count: none per question; a rate limit instead (for example 5 an hour to one person).
- Covers more: a scheduled report, "the nightly job failed".
- New risk: an agent can start messaging a person who only once asked it something. That needs the asker's
  consent (a "may message me" setting for each agent) and a mute, which is a larger design.
- Size L.

### C. Only "it's ready": one completion notice

The answer can declare that work continues; the agent may then send exactly one completion message, with no
window limit other than 7 days.

- Smallest noise.
- Too narrow: "it will take longer", "here is a correction" and a second file all need more than one message, and
  the agent must decide at answer time that more is coming.
- Size M, the same plumbing as A.

## Recommendation

**A, with 24 hours and 5 follow-ups.** It fixes the reported case with the tool agents already use, adds no new
kind of consent, and its limits are easy to explain. B is the right later step if owners want agents to report on
their own; it should wait for its own design because of the asker's consent. C costs the same as A and does less.

The two numbers are the owner's to choose. Shorter (1 hour) fits quick additions but not long jobs. Longer
(7 days) fits long jobs but keeps a channel open to someone who may have forgotten the question.

## For the builder to confirm before building

- Whether the Hub's journal and the receipt stages assume one answer for a message, and what changes for more.
- Whether the release authorization (`phase: "release-answer"`) can be asked again for the same message, or needs
  a new phase.
- How long an answered question's record is kept on the Fleet today.
- That the one-to-one view (`src/hub/rooms/direct-view.ts`) can list several agent messages for one entry.

## Not in this design

- Agent-started one-to-one messages (option B).
- Follow-ups in group rooms: `hub_room_post` already covers them.
- A "more is coming" state on the status line. It can be added later if askers ask for it.
