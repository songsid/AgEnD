# Task board: projects, main and sub tasks, the person's confirmation

Status: step 1 (#2246) — the board's model and rules, the Fleet › Tasks page, and the `task` tool on the board (an
agent reads its work, moves its cards and hears the person's send-back reason). Step 2 — wakes; step 3 — the person in
the chat. Both below.
Ported from taskhall (任務會所), a board an AgEnD fleet ran beside AgEnD; its rules are kept, its plumbing is AgEnD's.

## Why

The fleet's task board was a flat list: a title, a description, a priority, an assignee; claim, done. Multi-step work
did not fit it, and nothing in it waited for the person:

- An outcome the person wants ("a leaderboard") is several steps, often for several instances (a developer and a
  reviewer; a server and a client). The steps need an owner each and an order, and the outcome needs its progress.
- An instance that finishes work marked it done itself. Work the person has to accept needs to stop and wait for them.
- An instance whose context is reset, or another instance taking over, needs the state of the work on the card, not
  in a conversation that is gone.

## Model

| | |
|---|---|
| Project | A group of related work, created by the person (name, description, archived). |
| Main task (M-n) | An outcome. In a project, or in none ("No project": every `task` tool task for now). |
| Sub task (S-n) | A step of a main task; not split further. Its project is its main task's. |

Cards keep the `tasks` table's columns and add: `code` (M-n / S-n, never reused), `kind`, `project_id`, `parent_id`,
`scope`, `acceptance` (a checklist, JSON), `context`, `state`, `blocked_reason`, `size`, `needs_review`, `version`,
`sort`, `started_at`, `submitted_at`, `done_at`, `seen_entry_id`. `description` is the card's goal; `depends_on` stays
a JSON array of task ids. New tables: `task_projects`, `task_entries` (comments, the progress log, send-back and
confirm notes), `task_events` (history: who changed what, from what, to what) and `task_counters`.

Statuses are the tool's (`open`, `claimed`, `blocked`, `done`, `cancelled`) plus `review`: finished, waiting for the
person. The page names them To do, In progress, Blocked, Waiting for you, Done.

Field limits (code points) keep a card cheap for an agent to read: title 100, goal 300, scope 600, acceptance 10 ×
150, context 1000, state 500 in at most 5 lines, blocked reason 400, result 1000, comment 4000.

## Rules (scheduler/task-board.ts)

One rule set for every writer — the page, the `task` tool, a script. The actor is a person, an instance, a script
or the board itself.

- **The person's confirmation.** `needs_review` cards stop at `review` when finished. A main task opened by a person
  needs review unless they untick it; an instance cannot open one that skips it, and only a person clears the flag.
  Only a person moves a card from `review` to `done` (an approve note when they add one) or sends it back (a reason,
  stored as a send-back entry the assignee reads first). On the `task` tool, `done` (or `update status=done`) on such
  a card is `review`. Only a person reopens finished work — including by adding a sub task to a done main task.
- **Main tasks follow their sub tasks.** With sub tasks (not cancelled), a main task is `open` until one starts,
  `claimed` while they run, and `review` (or `done`, when it skips review) when all are done. An instance moves the
  sub tasks, not the main task: it may block it, resubmit it after a send-back with a result, or cancel one it opened.
  A new sub task reopens a finished main task. Cancelling a main task cancels its unfinished sub tasks; restoring it
  brings back what the cancel took down.
- **Instances move their own cards.** Claiming takes an unassigned card (it becomes the instance's) or its own, never
  another's; finishing takes a result, and unchecked acceptance items a reason; putting a card back clears its
  assignee; an instance edits only cards it owns or opened (anyone comments); it cannot drop someone else's unfinished
  dependency or reopen a finished card. A person moves anything; only the reasons are required of them.
- **Dependencies.** Only `done` meets a dependency — a cancelled one still holds, as the `task` tool always had it —
  and a sub task also waits for its main task's. Cycles, counting the main/sub waits, are refused.
- **Versions.** Every content change bumps `version`; a write carrying an older version is refused (409, with who
  changed the card last). Reordering does not bump it.
- **The `task` tool on the board's cards.** A card in a project, a sub task, one with sub tasks or one waiting for
  the person holds an instance to these rules through the tool too (claim, done and update go through the same
  move checks; result and priority are its owner's; reassigning is its owner's or creator's). The tool's own tasks
  outside all of that move as they always have. `id` takes a card number; `list` counts `review` as live.
- **Taking a card back out of review.** An instance that withdraws its own card from `review` says why: the reason is
  a comment on the card ("withdrawn from review: …"), so the card never leaves the person's queue silently.
- **Comments an assignee has not seen.** Comments and send-backs by others after the assignee's last write are new to
  it; its next write returns them first (`notes`), so a comment posted mid-task is never acknowledged unread.
- **Words.** A refusal carries a stable `code` (`forbidden`, `invalid`, `conflict`, `not_found`), a `key` naming the
  sentence and its `args`; a write's notes are `{ text, key, args }`. Agents read the English `text`; the page says
  each `key` in the person's language (`tasks.err.*`, `tasks.note.*`) and falls back to the text for one it lacks.

## Who is the person

A dashboard request is the person only through a signed-in session (`via: "session"`) on the dashboard itself. The
header token is the CLI's or a script's, and any agent on the machine can read the token file; a token request is the
actor `script` ("web-token"), held to an instance's rules. The board's own routes (`/ui/tasks/board`,
`/ui/tasks/cards…`, `/ui/tasks/projects…`) refuse token writes (403); the old `/ui/tasks` routes keep working for
scripts, under the rules. Guests reach none of these routes (not in GUEST_ROUTES), and the `tasks` stream event is not
sent to them.

**The temporary public link reads the board and changes nothing.** Confirming, sending back, cancelling and assigning
are the person's authority, which the public link never carries (docs/web-dashboard.md). Over the link the gateway
passes only the board's reads (`GET /ui/tasks/board`, `/ui/tasks/cards/<id>`, `/ui/tasks/search`); a write that
reaches the board anyway is refused (403 `not_over_public_link`) — the old task list's create and update
(`POST /ui/tasks`, `/ui/tasks/<id>`) too, since they write the board's rows — and a request through the gateway is
never the person (actor `script`, "public-link"). The page says it is read-only there and shows no write controls.

**Instances kept out of sight.** Over the public link the board leaves out the cards whose assignee or creator is an
instance with `cross_instance_visibility: hidden` (in lists, search and by number); a project's numbers still count
them. On the dashboard itself the person sees every card: hiding is about what instances and outsiders see, and the
board is the person's record.

## Storage and other releases

All schema changes are additive. `migrate()` runs on every open (every `agend` CLI command opens the file) and only
reads unless there is work: it adds missing columns (a concurrent "duplicate column" from the CLI opening the file at
the same moment is fine) and the tables, and takes the write lock only to seed a missing counter, to number rows without
a `code` (in the order opened: rows from before the board, and rows a release without the board wrote since), or to
let a main task catch up with sub tasks moved meanwhile (`reconcile()` reads first). A second open does not wait for
another connection's write (tested).

A release without the board reads and writes the same rows and ignores the new columns; `review` is a status it does
not know. Its prune knows no projects: after a rollback it deletes finished board cards past `retention_days`, leaving
their entries and events. Before rolling back, raise `retention_days`; the next prune here clears what an old one left.
`scripts/data-downgrade-phase.mjs` runs 2.1.12 against board data (docs/downgrade-compatibility.md).

**Retention** (`retention_days`) is the board's too. It prunes old finished work with no project (the tool's own tasks
among it, and a no-project main task with its sub tasks once all of them are finished and old), and in an archived
project a finished main task with its sub tasks once all of them are old. Nothing a live card depends on is pruned;
an active project keeps its record. Each chunk is one immediate transaction, deleting the tasks with their entries and
events; the prune then drops entries and events whose task is gone.

**The board's revision** is a counter (`task_counters` 'R') moved by every committed change. The `tasks` stream event
carries it with the card numbers touched; a board read returns it, and a read that sends the revision it has
(`?rev=`) gets `{ unchanged: true }` instead of the board.

## The page (Fleet › Tasks)

`fleet-tasks.js` (Home and a project's board), `fleet-task-card.js` (one card in the app's dialog),
`fleet-task-common.js` (words, requests, moves, marks). Home: what waits for the person (confirm, send back, answer),
then the projects (with % done) and No project. A board read carries live cards and the last 14 days' finished ones
(`?done=all`: every done main task, for the Done column's "All"), each project's numbers over all its cards, and is a
handful of statements whatever its size (`views()`, `projectStats()`). A project: its main tasks by status, a filter by
assignee, drag to move or reorder, a main task's sub tasks inside its tile. A card: every field edits in place with the
version it started from; a 409 shows the newer card with the draft still open, and saving again overwrites. `?card=M-3`
opens a card. Bars are SVG rects (the CSP allows no style attribute).

- **Live.** A `tasks` stream event older than the board on screen is ignored; otherwise the page asks again (once per
  burst, 250 ms) with its revision, and is sent the board only when it moved. Same on a stream reconnect.
- **Moves keep their text.** Every move sends the version the person saw. When an agent changed the card meanwhile
  (409), a typed reason is not lost: the card is read again and the person is asked once more, the text in place.
- **Without a mouse.** A tile's title is its button (the tile is not a button around buttons): Enter opens the card,
  Alt+←/→ moves it to the status before or after, Alt+↑/↓ within its column. The card's dialog has Move to… and a
  Position row (up, down) — reordering on a phone, where HTML5 dragging does not fire.
- **The public link** shows the board with a read-only note and no write controls (see above).

## Agents: the `task` tool on the board

`src/task-board-tool.ts`, behind both of the tool's doors (MCP over IPC, `agend-agent task` over HTTP). New actions
`mine`, `move`, `projects`; `create` / `update` naming a board field go through the board (an `update` with fields and
a `status` is one write: a refused move leaves the fields as they were); `get` of a board card and `list` by `project`
/ `parent` answer with the card or a line per card. The answers are plain text (`src/scheduler/task-board-text.ts`):
an agent reads a card in a dozen short lines, not a JSON record. The tool's own tasks are answered as before; list rows
carry `code`.

The loop the person's confirmation needs closes through the tool: `done` on a held card answers that it waits for the
person; `mine` lists "sent back to you" with the reason; `get` shows the comments new to the assignee and the latest
few, a send-back marked "(sent back)"; and every claim, done or update returns the board's notes (the new comments
first). The tool's description, the `agend-agent` instructions and the default workflow template say so. Board moves
are in the activity log like the tool's claims and completions.

## Product direction: acting on the web

The fleet's rule so far: act in the chat (Discord, Telegram); the web presents the same derived state. A board breaks
it on purpose, and #1267 (a Kanban) left that to the person. What this PR takes, and what it leaves to the chat:

- **Agents keep working in the chat and the tool.** Nothing an instance does needs the web: it reads and moves its
  cards with the `task` tool, and hears about them in its conversation (step 2).
- **The person acts where the work is laid out.** Creating, editing, reordering and confirming several cards is what a
  board is for; doing it by chat command would mean reading card numbers back. The page acts only through a signed-in
  session on the dashboard itself, never the public link, and every write goes through the same rules as the tool's.
- **Confirmation should not be web-only.** Step 3 brings the cards that wait for the person to the chat: Needs you and
  the fleet's channel, with Confirm and Send back (a reason) as buttons. Until then a card waiting for review is a
  board-only question; the maintainers decide whether that ships before step 3.

## Step 2: wakes (next PR)

Each committed write says which instances heard news about their own cards from someone else: assigned, sent back
(with the reason), commented (with the text), its blocked question answered, started for it, or every card it waited
for done (direct dependents, and the sub tasks of a main task that waited). Never its own write, never the board's
catch-up, never a finished card; "assigned" and "start" wait for the card's dependencies. The fleet gathers an
instance's news for a few seconds into one `[Task board]` message, delivered like a schedule's (sender `task-board`,
waiting for the instance to be idle) and tried again a few times. Not durable across a fleet restart: the card keeps
the news (`mine`, the comments new to its assignee). Cancelling a main task tells the other assignees whose sub tasks
it took down.

## Next

- **Step 3 — the person in the chat.** Cards waiting for review or blocked in Needs you and the fleet's notification
  channel, with Confirm / Send back there; a daily summary; importing a taskhall database; durable wakes through the
  delivery outbox.
