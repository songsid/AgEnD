# Task board: projects, main and sub tasks, the person's confirmation

Status: step 1 (#2246) — the board's model and rules, the Fleet › Tasks page, and the `task` tool on the board (an
agent reads its work, moves its cards and hears the person's send-back reason). Step 2 — agents working together: wakes,
who handed a card out (its dispatcher), one card at a time, wrapping a main task up before the person confirms it, and
who works on a main task now (taskhall's later rules). Step 3 — the person in the chat. Below.
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
`sort`, `started_at`, `submitted_at`, `done_at`, `seen_entry_id`, and (step 2) `dispatcher` with `dispatcher_kind`.
`description` is the card's goal; `depends_on` stays
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
- **Who handed it out (step 2).** A card's dispatcher is the person who opened it on the dashboard, or the instance
  that opened it for another one (a lead handing out work); a sub task takes its main task's; an instance's card for
  itself has none, and cards from before step 2 have none. A dispatcher is set like a field (an instance names one; a
  person can name themselves). An instance dispatcher edits the card, and answers its blocked question: blocked →
  in progress with the decision as the comment (a `move` reason counts), which its assignee reads.
- **One card at a time (step 2).** An instance has one board card in progress: starting another — claiming, resuming a
  blocked one, taking one back from review — while one is in progress is refused (finish it, or block it with the
  question). Blocked cards and main tasks that follow their sub tasks do not count; the `task` tool's own tasks are not
  limited, nor is a person, and `task done` of an open card (claimed on its way to done) passes. `mine` warns when
  several are in progress (a person moved them there).
  - *Cards an instance opened for itself* (it created it, it is the assignee, nobody handed it out) neither count nor
    are limited: a reviewer opens one per review and runs several (#2303's busy-fleet check: 142 refusals in a week,
    79 of them a reviewer's, if the fleet's work had been board cards). A sub task it splits off a card handed to it
    takes that card's dispatcher, so it counts.
  - *`board_cards_at_once`* (per instance, a whole number of at least 1, default 1; docs/configuration.md) raises the
    limit for a role that works on several handed-out cards. The fleet reads it at each claim.
  - *A dispatcher's answer* to a blocked card whose assignee is at its limit does not start the card: the answer is
    kept on it as a comment (the assignee is told), the card stays blocked, and the assignee resumes it when it has
    room (#2303 review).
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

**Instances kept out of sight.** Over the public link the board leaves out the cards whose assignee, creator or
dispatcher is an instance with `cross_instance_visibility: hidden` (in lists, search and by number); a project's numbers
still count them. A visible card follows the same rule for what it shows around it (#2303 review): its sub tasks, its
main task (also a search hit's main task title), and the comments, logs and history such an instance left on it —
which also do not count in a card's comment numbers, name its last comment, or make search find it (#2304 review). On the dashboard itself the person sees every card: hiding is about what instances and outsiders see, and the
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

Step 2's `dispatcher` / `dispatcher_kind` columns: a release from before step 2 neither reads nor writes them (its
`UPDATE` leaves them as they are), so dispatchers survive a downgrade and the upgrade after it. A card opened while
downgraded has none: back on step 2, its blocked question goes to nobody first (the person sees it on Home), until a
dispatcher is set on it.

**Retention** (`retention_days`) is the board's too. It prunes old finished work with no project (the tool's own tasks
among it, and a no-project main task with its sub tasks once all of them are finished and old), and in an archived
project a finished main task with its sub tasks once all of them are old. Nothing a live card depends on is pruned;
an active project keeps its record. Each chunk is one immediate transaction, deleting the tasks with their entries and
events; the prune then drops entries and events whose task is gone.

**The board's revision** is a counter (`task_counters` 'R') moved by every committed change. The `tasks` stream event
carries it with the card numbers touched; a board read returns it, and a read that sends the revision it has
(`?rev=`) gets `{ unchanged: true }` instead of the board. On the dashboard a board built for a revision serves every tab that reads it (#2296): every
open Tasks page reads the board again after each change, and they all get the same board, so it is built once per
(revision, `done=all`, minute — the 14-day window moves). Over the public link a read is filtered per request (instances
kept out of sight) and is built each time.

## The page (Fleet › Tasks)

`fleet-tasks.js` (Home and a project's board), `fleet-task-card.js` (one card in the app's dialog, as a drawer),
`fleet-task-common.js` (words, requests, moves, marks). Home: what waits for the person (confirm, send back, answer),
then the projects (with % done) and No project. A board read carries live cards and the last 14 days' finished ones
(`?done=all`: every done main task, for the Done column's "All"), each project's numbers over all its cards, and is a
handful of statements whatever its size (`views()`, `projectStats()`). A project: its main tasks by status, a filter by
assignee, drag to move or reorder, a main task's sub tasks inside its tile. A card: every field edits in place with the
version it started from; a 409 shows the newer card with the draft still open, and saving again overwrites. `?card=M-3`
opens a card. Bars are SVG rects (the CSP allows no style attribute); a bar fills with done work only — the percentage beside it (#2299: a project whose only card was blocked drew a full red bar at 0 %) — and the chips name what is blocked or waiting.

- **Live.** A `tasks` stream event older than the board on screen is ignored; otherwise the page asks again (once per
  burst, 250 ms) with its revision, and is sent the board only when it moved. Same on a stream reconnect.
- **Moves keep their text.** Every move sends the version the person saw. When an agent changed the card meanwhile
  (409), a typed reason is not lost: the card is read again and the person is asked once more, the text in place.
- **Without a mouse.** A tile's title is its button (the tile is not a button around buttons): Enter opens the card,
  Alt+←/→ moves it to the status before or after, Alt+↑/↓ within its column. The card's dialog has Move to… and a
  Position row (up, down) — reordering on a phone, where HTML5 dragging does not fire.
- **taskhall's looks.** On a desk a card opens as a drawer from the right edge (the app's dialog with `drawer`: focus,
  Esc and the backdrop as before), its fields in a grey block; a phone keeps the bottom sheet. The columns reach the
  bottom of the page (a card drops anywhere down a column). Tiles are white with a shadow and a bold title; a bar on the
  left only while a card is under way (in progress, blocked, waiting for you); a size in a box. Who works on a card has
  a round initial: an instance's in its identity colour (#1958), a person's grey.
- **Who works on what (step 3).** `GET /ui/tasks/work` (`?instance=` for one): each instance's `myWork` — what its
  `task mine` reads — for the fleet's instances and anyone else holding a live card, drawn in one `views()` read. Over the
  public link an instance kept out of sight is not listed, nor a card that names one. The board's **Instances** drawer
  (`fleet-task-work.js`, taskhall's): by team as the sidebar groups them, working ones first, then those with cards;
  each line says what the card is to it (sent back, in progress, blocked, waiting for you, owns, can start, waiting on)
  and opens it. It is read again on each board change. An instance's Details page reads its own once.
- **The public link** shows the board with a read-only note and no write controls (see above): a card's project, priority, size and review are text, not disabled controls (#2299).
- **Toasts** are a manual popover (the top layer): a toast raised while a card's dialog is open is above its backdrop, not dimmed under it. On a phone the board's toasts come in above the tabs (an older confirmation gives way to two newer toasts; an error stays), not over its title and search; while a card's sheet is open, at the top (#2299).
- **Wrapped up before you confirm (step 2).** A main task goes to review by itself when its last sub task is done —
  often a reviewer's — before its owner ticked its definition of done or wrote its result. Such a card shows "To fill
  in", the waiting row and the card say what is missing, and Confirm asks first (send it back, or confirm anyway with
  an optional note). Agents read the same in `get` and `mine`.
- **Who works on a main task now (step 2).** Its owner is not always the one at work (a review step is the
  reviewer's): a main task with sub tasks shows the sub task in progress and its worker, else a blocked one, else the
  next one that can start; waiting for you, it says so. The owner is in the tooltip; the card has a "Now" row.

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

## Step 2: wakes

**Who hears what** (`TaskBoard.settleWakes`, read from a write's events once it is all written, still inside it): an
instance hears what someone else did to a card that is its own, or that it handed out —

| News | Who | When |
|---|---|---|
| assigned | the assignee | a board card opened for it, or given to it (once the card can start); not the `task` tool's own tasks, which are handed over with a message of their own (`delegate_task`) |
| start | the assignee | someone else moved its open card to in progress |
| sent back | the assignee | the person sent it back from review, with the reason |
| answered | the assignee | its blocked question answered (by the person or its dispatcher), with the answer |
| comment | the assignee | a comment by someone else (once the card can start) |
| ready | the assignee | every card it waited for is done — by hand or by the board's own move |
| decide | the dispatcher | its card got blocked on a question: ask the person, answer it on the card |
| to confirm | the dispatcher | its card went to the person for confirmation: tell them (and what it still lacks) |
| approved | the assignee and the dispatcher | the person confirmed it, with their note |
| wrap up | the main task's owner | it went to review by itself, its definition of done or result still missing |
| cancelled | the assignee | someone else cancelled it — or its main task, taking it down — with why |

Never its own write, never a finished card (but for a confirmation or a cancel), never a name that is not one of the
fleet's instances. `TaskBoard.wakeHolds` drops what no longer stands — at the end of the write and again when it goes
out: a card finished meanwhile, no longer the instance's, a question already answered, a card wrapped up meanwhile.
What asks the instance to act holds only while it can (#2303 review): `ready` while the card is open with nothing
left to wait for, `start` and `answered` while it is in progress, `sent back` while it is back with the instance; a
comment only while its assignee has not read it (any write of its own on the card since shows it the comment, as the
`task` tool's answer, and counts it as seen).

**Sending** (`src/task-board-waker.ts`). The fleet gathers an instance's news for 10 s into one `[Task board]` notice:
a line per card, each reason with its own words and who did it; a main task assigned with its sub tasks is one line;
more than three assignments at once (a whole plan) are a count ("You were assigned 6 main tasks (M-11–M-16) and 9 sub
tasks… one at a time, by priority"). The notice is AgEnD's own (`admitSystemNotice`: sender AgEnD, not a person's
words) and the delivery outbox holds it until the instance can take it, across a fleet restart too. News still
gathering when the fleet stops is lost; the card keeps it (`mine`, the comments new to its assignee). Blocked cards
with an instance dispatcher still wait for you on Home, marked as asked first.

## Step 3: the person in the chat

The product rule the board's web actions bent (see "Product direction") is restored for what waits on the person:
confirming and sending back work, and answering a blocked card, happen in the chat too — where "Needs you" already is
(docs/design/1386-needs-you-inbox.md).

- **Items.** Cards in review that need the person's confirmation, and blocked cards, are Needs you items of type `task`
  (`TaskBoard.waitingForPerson`), under the card's assignee — so each chat world lists the cards of its own instances.
  A line names the card and what it asks (the question) or lacks ("not wrapped up: …"). A card an instance handed out
  (its dispatcher) is listed on the web only: that instance tells the person in the chat (the `to_confirm` and
  `decide` wakes), and the list does not say it twice. A card nobody is assigned is the web's only too.
- **Buttons.** The live message carries, for at most three cards: **Confirm** and **Send back** on a card waiting for
  confirmation, **Answer** on a blocked one — capabilities minted per render like Acknowledge (bound to the world,
  chat, thread and message, a fleet admin of that world, the card still that world's, 15 minutes), and carrying the
  card's version: a newer card renders again, and a stale click is told so.
- **Words by reply.** Send back and Answer need words, which a button cannot carry: the bot posts a prompt in the same
  place ("Send back M-3 (@ann): reply to this message with what needs to change"), and the clicker's reply to it — that
  admin's only, within 10 minutes — is the reason or the answer. The inbound handler hands such a reply to the hub
  after access control and the dedup claim and before routing; anything else (another person, another message, a
  lapsed prompt) flows on to the instance as before. The outcome is said as a reply to the reply.
- **Its boundaries (#2306 review).** One prompt per world, card, person and verb at a time, reserved before the send and
  released when it fails or lapses; at most 32 open at once. A prompt keeps whose card it is and its world as it was
  (connection, place, notice room): if the instance moved to another world, the connection was replaced or the room
  changed — while the prompt was on its way or after — it takes no reply. A reply is found by where its prompt is,
  whichever bot received it (a sibling bot in a shared Discord guild may get it first), and judged by the prompt's
  world's admins. Over the public link a task item whose card the board hides there (a hidden assignee, creator or
  dispatcher) is left out of `/ui/poll`'s Needs you; the link's page has no stream.
- **Who acts.** The person, named by the platform (`person: <username>`), through the board's rules — the same as a
  signed-in page; the web's Needs you list links each card to its dialog.

- **The daily summary** (`task-board-summary.ts`, taskhall's): once a day at `defaults.task_board.summary_at`
  (default 09:00, the fleet's zone; `off`), each world's General gets what waits for the person and what is blocked now,
  what got done and what was opened since the last summary, and each active project's progress — its own instances'
  cards (a card no world's instance holds goes to the primary world), and the projects one of them is in; each of its
  Generals shows the same text in the web chat. The clock looks every minute; the mark (`task-board-summary.json` in
  the data directory: the local date, the end of the time covered) is written before sending, so a send that fails is
  not repeated every minute. At most once a calendar day; a missed one goes out when the fleet is back that day,
  covering since the last one (at most a week); a quiet day sends nothing; the first day only marks. The web chat's
  line carries the card numbers it names (`cards`, kept on disk with the row): over the public link `/ui/poll` and
  `/ui/history` withhold it while one of them is hidden there, read when asked, or is no longer on the board (#2341
  review).

## Next

- **Step 3, rest.** Each instance's board work on its details page (and a list of every instance's on the board).
