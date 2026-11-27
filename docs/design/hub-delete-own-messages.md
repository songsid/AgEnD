# Hub: people can delete their own messages (M-3885)

Status: design for the owner; no code; build after 2.4.0. Written 2026-11-27 against the dev tip `0aff702d8`.
The facts about today's behaviour are the rooms builder's reading of the code (file and line given to me on the
card's thread); I did not re-read them.

## Why

The owner decided on 2026-11-27 that messages in Hub rooms and one-to-ones stay readable after sharing stops.
Then a person needs a way to take back what they wrote.

## The rule in one line

**You can delete what you wrote. A room's manager can remove anything in their room. A deleted message leaves one
grey line where it was, and its text and files are gone from the Hub at once.**

## 1. Who may delete what

| Message | Its author | The room's managers | The agent's owner | Anyone else |
|---|---|---|---|---|
| A person's post in a room | Delete | Remove | — | — |
| A person's question in a one-to-one | Delete | n/a | — | — |
| An agent's answer or post in a room | (the agent has no delete) | Remove | Delete | — |
| An agent's answer or message in a one-to-one | (the agent has no delete) | n/a | Delete | The asker: see Q3 |
| System lines ("Alex joined", "Office turned on") | — | — | — | — |
| The room assistant's answers | — | Remove | n/a | — |

- **No time limit.** The owner's words were "delete their own later".
- **A Hub administrator has no extra power here.** To remove something in a room they join it as a manager, which
  the room already records with a line. One power, one trail.
- **Agents cannot delete.** An agent that could erase its own answers could erase its own trail. Its owner is
  the accountable person and deletes for it.
- **No editing.** Edit is a different feature (it needs a history); this card is delete only.

## 2. What everyone sees

- The message's place is kept. Its content is replaced by one grey line, with the original time:
  - by its author: "Alex deleted this message." / 「Alex 已刪除這則訊息。」
  - by a manager: "A room manager removed this message." / 「房間管理員已移除這則訊息。」
  - an agent's, by its owner: "Notes' answer was deleted by its owner." / 「Notes 的回答已由擁有者刪除。」
- Files, pictures, buttons, polls and reactions on it are gone. A pin on it is removed.
- A reply that quoted it keeps its own text and shows "deleted message" where the quote was.
- The room list's last-message line never shows the deleted text.
- Deleting asks once: "Delete this message for everyone? Its text and files are removed from the Hub. This can't
  be undone." One confirm, no undo.
- Where: the message's own menu (Reply, Pin, Copy…), as the last item, in the warning colour.

## 3. What is removed, and what is not

**Removed from the Hub at once:** the text, the files, the choices of its buttons or poll, its reactions. Search
no longer finds it. It is never sent to an agent as context again.

**Kept:** that a message was there, who wrote it, when, who deleted it and when. Nothing of its content.

**Cannot be taken back (and the confirm sentence must not promise it):**

- An agent that already received the message has it in its own conversation. See section 5.
- A notification already shown on a phone or sent to a chat app.
- Anything a person copied.

## 4. A question that is still being answered

- Deleting a question that no agent has started on withdraws it: no answer comes.
- Deleting a question an agent is working on: the answer still arrives, as a reply to a deleted message. Stopping
  an agent mid-turn is a different power and is not added here.

## 5. The agent owner's Fleet

**What a room question leaves on the owner's Fleet today** (the builder's reading):

| Copy | Where | Can the Hub reach it later? |
|---|---|---|
| The question, its files' names and a few recent posts of other people as context | The Fleet's own encrypted record of room questions. Nothing ever removes a row from it | Not today. The Hub has no "take back" message to a Fleet |
| The files | The agent's inbox folder, named after the message | Not today |
| The same text | The agent's own conversation (its CLI's transcript) | No, and AgEnD does not own that transcript |
| The owner's own chat (web, Discord, Telegram) | Not copied there | n/a |
| A search index on the Fleet | There is none | n/a |

**Proposed:**

1. A new, negotiated notice from the Hub to each Fleet that was sent the message: "this message was deleted".
   An older Fleet does not get it, and the grey line is unchanged either way.
2. On it, the Fleet removes the question from its record once the question is finished, and removes the files it
   fetched for it.
3. The agent's conversation is not rewritten. The agent gets one line: the person deleted that message; do not
   quote or use it again. That is a request to a model, not a guarantee.
4. **Out of reach, said plainly:** a deleted post that was sent to an agent only as *context* for someone else's
   question. The Fleet does not record which posts a context came from. From the moment of deletion it is never
   sent as context again.

**Found on the way, worth its own small card:** the Fleet's record of room questions is never pruned. It should
follow the same number of days as the Hub's content retention, whether or not anything is deleted.

## 6. Retention

The Hub already removes a message's text and files after the retention period (7 days by default) and keeps the
row. A deleted message reaches the same end state earlier, plus the record of who deleted it. Deleting uses the
same removal the daily sweep uses, for one message, at once. The audit's copy of the text is the same stored
text, so it goes too; the audit keeps the action.

**Today an expired message shows badly, and the same fix covers both:** in a room it is an empty bubble with a
name and a time and no explanation; in a one-to-one the question is an empty bubble and the answer vanishes; the
room list's last line goes blank. With this design:

- deleted: the grey line that says who deleted it;
- expired: a grey line "This Hub no longer keeps this message (older than 7 days)." / 「這個 Hub 已不再保存這則訊息（超過 7 天）。」;
- the room list's last line reads "Message deleted" / "Message no longer kept", never blank.

## 7. Audit

One action entry per deletion: who, when, which room, which message (by id), and in what capacity (author,
room manager, agent's owner). Never the content. It follows the audit's own retention.

## 8. Phases (after 2.4.0)

| # | Card | Size |
|---|---|---|
| D1 | Delete your own post in a room and your own question in a one-to-one: the grey line, text and files removed, pins, reactions, buttons and polls closed, quotes, the room list line, the audit entry, withdrawing an unstarted question. With it: the "no longer kept" line for expired messages | M |
| D2 | A room manager removes any message; an agent's owner deletes its answers and its own-initiative messages | S |
| D3 | The "deleted" notice to Fleets: the Fleet drops its record of the question and the fetched files, and tells the agent in one line | M |
| D4 | The Fleet's record of room questions follows the retention days | S |

What a delete has to touch on the Hub, from the builder's list: the stored text, the files, reactions, pins,
buttons with their votes and result post, replies that quote it, the agent's delivery and thread records that
point at it, the read markers (a sequence in rooms, a message id in one-to-ones), and the audit's content
reference. Search and the room list's last line are read live, so they follow by themselves.

An answer's author in the data is the shared agent, with the person who owned it at the time. "The agent's owner"
in section 1 means that person, or the agent's owner now.

## Questions for the owner

| # | Question | Recommendation |
|---|---|---|
| Q1 | May a room's manager remove other people's messages? | **Yes.** A room needs someone who can take down a mistake or something that should not be there |
| Q2 | May an agent's owner delete the agent's answers? | **Yes.** The owner is accountable for what the agent said |
| Q3 | In a one-to-one, may the asker delete the agent's answer to their own question? | **Yes, together with the question** ("Delete question and answer"). The answer usually repeats what they asked. In a room: no, the answer belongs to the room |
| Q4 | Does the grey line name who deleted it? | **Yes** for the author and "a room manager" without a name for a manager; the audit has the name |
| Q5 | A time limit? | **None** |
