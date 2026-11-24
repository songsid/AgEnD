---
name: task-board
description: The task board (`task` tool) in full — cards, sub tasks, review, dispatcher, blocked cards, projects, paging
roles: [general, worker]
---

## Actions

- **create** — a new task. Naming a board field (project, parent, acceptance, scope, size, …) makes it a board card.
- **list** — paged compact rows by default; follow `next_cursor` with the same filters. `filter_status` includes done/cancelled;
  `verbose: true` returns full records; `detail: true` the legacy full answer. Only the legacy detail/verbose lists cap an
  unfiltered result at 100; filters lift that cap. `stale: true`: claimed cards whose assignee stopped.
- **get** — compact title/status/version by default; `detail: true` for the goal, checklist and comments (the full card as
  text). Read it before you do the work.
- **claim** — assign it to yourself.
- **done** — mark it complete, from open or claimed. A card that waits for confirmation goes to `review` instead: the person
  confirms the cards they handed out, the dispatcher an agent's card, finishing it from review with `done`.
- **update** — status, priority, assignee, or the board fields: `state`, `log`, `comment`, `check` / `uncheck`, `project`
  (a main task's project id, or null to take it out; you may move a main task you can edit; sub tasks follow).
- **mine** — your work, including what was sent back and why: start here after a reset.
- **move** — to a status; blocked/cancelled need a `reason`, finishing needs a `result`.
- **projects** (each with its id), **create_project** (name, description; changing or archiving a project is a person's),
  **move_project** (`ids` + `project`: several main tasks, each moved or refused on its own).
- **watch** / **unwatch** (`id`, `watcher`) — follow a card yourself, or name another instance on a card you may edit
  (see Following below).

Ids accept an 8-hex prefix or a card number (M-3, S-4). Write actions return `{id, status, updated_at}` (an update also the
saved value of each field it named) and the board's notes (a reason it was sent back, a comment you had not seen) when there
are any. A field an action does not take is refused by name, and nothing is changed. Answers are text.

## Working with cards

- Main tasks **M-n** are an outcome (the person confirms the ones they handed out); their sub tasks **S-n** are your steps.
- Open a main task for multi-step work you are asked for; split a big one into sub tasks (`create` with `parent`,
  `depends_on` for order).
- Keep `state` current: done / next / watch out.
- One card in progress at a time: finish it or block it (with the question) before the next; with many, follow `mine`'s order.
- Finish: a sub task → `done`; a main task → `review` (one nobody else confirms — your own — goes straight to `done`).
  Sent back → read why (`get`), fix, resubmit.
- Opening a card for someone else makes you its dispatcher (or name one: `dispatcher`). A blocked card you handed out comes
  to you: ask the person, then move it back to `claimed` with the decision as the comment.
- A `[Task board]` notice is news on your cards: act on them with this tool.

## Comments and mentions

- A comment on your card by someone else, or an `@<instance name>` naming you in a comment on any card, wakes you with a
  `[Task board]` notice that says who wrote it and what. Reply on that card (`update` with a `comment`) only if it asks or
  needs something, not to thank. When a person wrote it, the notice says so: no `@` is needed to answer them.
- To wake an instance, write `@<its instance name>` in your comment (an `update`'s or a `move`'s); the answer says whom it
  will wake. A name in backticks or a code block is never read as a mention.
- Agents answering each other on a card wake each other for at most 4 turns (a person's comment lifts it); a comment never
  wakes its writer, and one comment wakes at most 5 instances (the card's assignee included).
- If your answer says `contact_held`, your conversation needs a contact approval to reach other instances: the comment
  stays on the card and wakes nobody else. Reach them with `send_to_instance`, which asks for the approval.

## Following a card

- The instance that handed a card out (its dispatcher), the instances that watch it and the leader of its project hear, in a
  `[Task board]` notice that says why, when it is finished, waits for confirmation, is sent back, is blocked or changes
  hands — never the one who did it. Step in (comment, reassign, open the next card) only if it needs you.
- The answer to your own change says whom it told, so no message of yours is needed. Agents changing one card back and
  forth tell no one after 6 changes in 30 minutes, until a person touches it.
- `watch` follows a card (a main task's watchers also hear its sub tasks), at most 10 per card.
