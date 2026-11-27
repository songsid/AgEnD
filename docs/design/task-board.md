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
| Project | A group of related work (name, description, archived), created by the person or an agent; only the person changes or archives one (#3195). |
| Main task (M-n) | An outcome. In a project, or in none ("No project": every `task` tool task for now). |
| Sub task (S-n) | A step of a main task; not split further. Its project is its main task's. |

Cards keep the `tasks` table's columns and add: `code` (M-n / S-n, never reused), `kind`, `project_id`, `parent_id`,
`scope`, `acceptance` (a checklist, JSON), `context`, `state`, `blocked_reason`, `size`, `needs_review`, `version`,
`sort`, `started_at`, `submitted_at`, `done_at`, `seen_entry_id`, and (step 2) `dispatcher` with `dispatcher_kind`.
`description` is the card's goal; `depends_on` stays
a JSON array of task ids. New tables: `task_projects`, `task_entries` (comments, the progress log, send-back and
confirm notes), `task_events` (history: who changed what, from what, to what) and `task_counters`.

Statuses are the tool's (`open`, `claimed`, `blocked`, `done`, `cancelled`) plus `review`: finished, waiting for the
person. The page names them To do, In progress, Blocked, To confirm, Done; a card in review says whom it waits for (#2756:
"Waiting for you" only for the person's own hand-outs, else "Waiting for <agent>").

Field limits (code points) keep a card cheap for an agent to read: title 100, goal 300, scope 600, acceptance 10 ×
150, context 1000, state 500 in at most 5 lines, blocked reason 400, result 1000, comment 4000.

## Rules (scheduler/task-board.ts)

One rule set for every writer — the page, the `task` tool, a script. The actor is a person, an instance, a script
or the board itself.

- **Who confirms (#2434).** `needs_review` cards stop at `review` when finished. The person confirms the cards they
  handed out (`dispatcher_kind = 'person'`, #2426's rule for a blocked card): a main task opened by a person needs
  review unless they untick it, and only a person clears the flag, moves the card from `review` to `done` (an approve
  note when they add one), sends it back (a reason, stored as a send-back entry the assignee reads first) or hands it
  to someone else. A card an agent handed out is the agents' own: its main task needs no review unless asked for
  (`needs_review: true`), and then its instance dispatcher — or, when nobody handed it out, its assignee — confirms it,
  sends it back or clears the flag; a person may too. Cards already in review from before #2434 (every agent's main
  task then needed review) are finished that way as they are: nothing is rewritten. On the `task` tool, `done` (or
  `update status=done`) on such a card is `review`, unless the caller is the one who confirms it. Only a person
  reopens finished work — including by adding a sub task to a done main task. A card opened on the board carries
  `on_board` (#2434): before, a main task's default review marked it as the board's rather than a plain `task`.
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
  it; its next write returns them first (`notes`), so a comment posted mid-task is never acknowledged unread. Since
  comments wake (see "Comments and mentions"), the assignee is also told of one as it is written.
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
board is the person's record. A card number is read the same way: over the link a card is not numbered by what points at it. A
visible sub task's `parentId` (the card's read, the board's, the work drawer's, the search's) and the `parent` of its "created"
event read as none when its main task is kept out of sight, as its `parent` already did — the card number alone says there is a
main task. So do a card's `dependsOn` and `unmetDeps` (the number is left out of the list; over the link the read adds `hiddenUnmet`,
how many unfinished dependencies were left out, so a card that waits for a card kept out of sight still shows its clock, is not
counted as ready, and says "waits for a card that is not public" — how many, never which; the dashboard and an admin session have
no such field), an "updated" event's `changes.dependsOn` (left out of both its lists; a change that is then the same on both sides
is not shown, nor an event with nothing left) and the `cascade` / `restored` of a sub task's "moved" event (the main task it was
taken down with; the key is dropped). Free text a person typed — a title, a goal, a comment — is not read for card numbers.
Nothing changes on the dashboard or for an admin session.

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

Comment status and unread add one column, two tables and an index: `task_entries.wakes`, `task_card_reads`, `task_reads_floor` and `idx_task_entries_at` ("Comment status", "Unread"); handoffs add one more table, `task_handoffs` ("Handoffs"). A release without them neither reads nor writes them; its prune leaves the marks of a pruned card behind and the next prune here sweeps them.

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

`fleet-tasks.js` (Home and a project's board), `fleet-task-card.js` (one card as a page of its own), with
`fleet-task-edit.js` (editing in place: a text, the title, the checklist, a property's chip), `fleet-task-activity.js`
(the timeline and the comment box) and `fleet-task-create.js` (the quick create); `fleet-task-view.js` (the toolbar and
the list), `fleet-task-menu.js` (a card's menu, stepping), `fleet-task-common.js` (words, requests, moves, marks). Home: what waits for the person (confirm, send back, answer),
then the projects (with % done) and No project. A board read carries live cards and the last 14 days' finished ones
(`?done=all`: every done main task, for the Done column's "All") and each project's numbers over all its cards. **M-3668 (the user, 11-24):** with `defaults.task_board.archive_after_days`
(default 3; 0 = never) a main task done or cancelled that many days ago is archived — a view rule on `done_at`, nothing
changes in the database: the board read carries finished main tasks only until then (`archiveAfterDays` says how long),
the projects' numbers leave archived ones out and count them (`archived`, and `doneWeek`: done in the last 7 days),
`GET /ui/tasks/archive?project=&before=&assignee=` pages a project's archived main tasks newest first, and search and a
card's page say `archived`. Moving one to To do reopens it (its status, not its age, decides). The Done column shows its
newest 20 at a time (fleet-task-archive.js). #4428 review: an archived main task's sub tasks leave the board with it; the
Archive leaves out what the public link hides before it pages (`leaveOut`), so its cursor, total and assignees never tell
of such a card; and a page's same-revision read (`?rev=`) is answered `unchanged` only with the `epoch` it read
(`boardEpoch()`: how many finished cards have passed the archive line, this week's and the recent window's), since time
moves a card across them with no write. Over the public link the epoch and the projects' numbers leave out the hidden
instances' cards (and a hidden main task's sub tasks), as the board read does. Settings → Shared agent settings →
Advanced has the archive age. Either way a board read is a handful of statements whatever its size
(`views()`, `projectStats()`). A project: its main tasks by status (or as a list), the toolbar's search and filters, drag to move or reorder,
a main task's sub tasks inside its tile. A card: every field edits in place with the version it started from; a 409
shows the newer card with the draft still open, and saving again overwrites. `?card=M-3` opens a card. Bars are SVG rects (the CSP allows no style attribute); a bar fills with done work only — the percentage beside it (#2299: a project whose only card was blocked drew a full red bar at 0 %) — and the chips name what is blocked or waiting.

- **Live.** A `tasks` stream event older than the board on screen is ignored; otherwise the page asks again (once per
  burst, 250 ms) with its revision, and is sent the board only when it moved. Same on a stream reconnect.
- **Moves keep their text.** Every move sends the version the person saw. When an agent changed the card meanwhile
  (409), a typed reason is not lost: the card is read again and the person is asked once more, the text in place.
- **Without a mouse.** A tile's title is its button (the tile is not a button around buttons): Enter opens the card,
  Alt+←/→ moves it to the status before or after, Alt+↑/↓ within its column. A tile and a list row also have a ⋯ button
  that opens the card's menu (Move to…): a phone has no right click and HTML5 dragging does not fire there. The card's
  page has a Status chip and a Position row (up, down).
- **The card is a page.** It replaces the board in the tab instead of a drawer
  over it, so a desk's width is used: a main column (title, the spec, the agent's block, sub tasks, then the activity —
  comments, progress log and history merged into one timeline, oldest first, with the comment box last) and a side column
  of properties that stays in view; one column on a phone (≤ 899 px, the app's breakpoint). On a desk the page has no maximum width, as the board's page has none: the properties column is `clamp(300px, 22vw, 460px)`, the label column `clamp(7rem, 6vw, 10rem)` and the main column takes the rest; only a line of prose (a field's text, a comment's words) stops at 72rem, so a long text never becomes one line across a wide screen. The merge is the page's: the card API still returns `comments`, `logs` and `history` apart, and the
  history lines that only repeat a comment or a log entry are dropped from it — except a change of the card's watchers (a
  `logged` event carrying `data.watchers`, which has no log entry of its own): it stays, as "changed watchers: +ops,
  −dev-b" (a true minus sign, so a narrow line does not split it from the name) in the same line style, under the History filter. No API, schema or column changed.
- **The page, laid lighter.** Only layout and style: no API, schema, permission or stored value changed,
  and every field is still readable and editable. (1) *The spec folds what is empty.* Goal, scope, definition of done (a sub
  task's acceptance) and context are fields only while they hold text; an empty one is a **+ Add** button in one row under
  them (a writer's way in; over a read-only link an empty one is not there at all). A button opens its field in place with
  the focus (`open` on `EditableText` / `Checklist`, `useInlineEdit`'s `open`/`onClose`); closed still empty — Esc, or leaving
  it unchanged — it folds back into its button, and a saved one is a field like the rest (also a filled one whose text is
  emptied). The page keeps which ones it opened, per card. (2) *The agent's handoff is apart from the spec.* **State** and
  **Result** (written by the assignee, `fleet-task-run.js` `AgentRun`) are in the same block as the **Agent activity**
  block, marked with the accent's straight bar and a tint: while there is nothing to show (no state, no result, the assignee
  not running) it is one line — "Not started: dev-b will update this once it takes the card", the idle note, the work being in the
  sub tasks, or "No state or result written yet" — with the buttons for the two fields and the way to the conversation; with
  a state or result, or while the assignee works, it opens: who, state, **Open conversation**, the live steps, the fields. (3) *The
  sub tasks are a bordered list*: a header with done / total (the card's own `progress`) and the shared `ProgressBar`, the rows,
  and the quick-create line last (same `QuickAdd`). (4) *The properties are three groups* with a thin line between: core (status,
  assignee, priority, size); project and people (project — or a sub task's main task — leader, dispatched by, watchers); flow
  (**Needs my confirmation** as a switch, the app's `.s-ui-toggle` look, then dependencies, and the position arrows where
  they apply). The "Now" row is gone (the sub task list says it). (5) *Mark blocked* — a main task that follows its sub
  tasks, by hand — moved to the header toolbar, beside Previous / Next, the copy-link button and ⋯ (which keeps Cancel); the
  note that the status follows the sub tasks is a chip at the right edge of the row above the title, which also has the card's
  number and status. (6) *A phone* (one column): title, spec, the agent's line, sub tasks, properties, activity — the grid's areas
  are that order. (7) *One invisible grid.* Nothing is drawn; every labelled row of the main column — the spec fields, the agent's
  State / Result, the sub tasks — has the same two columns, a label (`--tp-label`) and its value, a label on its value's first
  baseline (`tc-field` is `h3` + `.tc-field-body`), so the texts start on one vertical line. What a hover or edit box takes (its
  padding and border, `--tp-inset`) hangs out into the gutter by a negative margin, so the text, not the box, is on the line (the
  agent's block takes its own padding off its label column, so its values are on the same line). A sub task is a row of four
  columns (status, number, title, who); a timeline line is four columns (mark, who, words, time) with its words on the value
  column; in the side column a chip's text is on the value column's edge. On a phone the label is above its value, the left edge
  the same. (8) *The timeline is read for progress.* A comment has no box: its author and time on a line, the text under the
  name, drawn by the chat's own renderer (`AgendChatRender.renderMarkdown`: it escapes first, so nothing in a comment makes a
  tag of its own; a stored comment is still the plain text it was). A progress note is a line in the text colour; the history is
  the quietest thing on the page — small, grey, the actor not bold, no bar even for an agent's — and a run of the same line from
  the same hand is one line "×N" with the latest time (`collapseEvents`, only history lines merge). A day change is a thin
  separator (Today / Yesterday / a date), only when the list spans more than one day (`dayLabel`).
- **A card in the address.** The open card is `?card=` in the page's address, beside `?tp=` and `?tf=`. Opening a card
  from the board adds one history entry, so Back returns to the board or the list (its scroll and the card's tile focus
  come back); opening another from the card (a sub task, a dependency) adds one more, and "Back" on the page goes all the
  way (the entry's state counts the cards deep); stepping to the previous / next card replaces. A link opens the card
  directly, and Back then drops the parameter.
- **Edit in place, saved when you leave.** A property is a chip that opens a menu (the app's `Menu`); a choice saves at
  once. A text opens as a box on a click: leaving the box or Ctrl+Enter saves, Esc drops it — and the blur that follows
  an Esc, or a switch to another window, saves nothing. Every save keeps the version the edit started from. After a 409
  the box stays open with a line saying the card changed and two answers (Overwrite, Discard my change): leaving the box
  never overwrites silently. Chip saves go one after another, each on the version the one before left. A comment carries
  no version, as before. What is typed while a save is still on its way is newer than what the server holds, so it is kept: when the save succeeds the box stays open on that text (a box left meanwhile saves it now) and its save is pinned to the revision that first save produced, read from its answer (`pin`), not to whatever the page reads later, so a write by someone else after it is a conflict (the page asks, as in any 409) and never silently overwritten; only an unchanged box closes. The page's permission is one value, `writable = !boardReadOnly()` in the Tasks tab: a guest and a read-only session over the public link get a page with nothing that edits, creates or moves a card; an admin session over the link writes as itself.
- **The toolbar.** Board | List, search, Filter and Display are one row (`TaskToolbar`). While the board's columns do not fit the window (`.tb-scroll` scrolls sideways; a platform may hide its scrollbar until it is used) it ends with ‹ › buttons that scroll them (`ColumnScroll`, `scrollReach`): shown only while some column is out of sight, the one with nothing to reach dimmed with `aria-disabled` so it keeps the focus. The view, grouping, order and
  direction (`agend_tasks_display`), the filters (`agend_tasks_filters`, also `?tf=`), the folded list groups
  (`agend_tasks_collapsed`, per project) and the search (`agend_tasks_query`) are kept on the device; a value an older build stored
  still reads, an unknown one falls back to its default. Needs you is a filter field (`waits:you`, the rule of Waiting for
  you). The list's header sorts by ID, Title, Priority, Assignee or Updated; the same column again reverses it.
- **The board's cards.** Layout and style, and one write the page already had: no API,
  schema or stored value changed. (1) *Wider, as tall as the content.* A project's page — its board and its list alike — is no longer held to the
  Fleet page's 1240 px (Home keeps it): it fills the content area with the same side margins. In the list the title column takes
  the extra width while number, priority, assignee and time keep theirs. On the board a column is `minmax(272px, 360px)` with
  `grid-auto-flow: column`, so however many statuses
  there are a card is never squeezed — more columns than fit scroll sideways
  (at 1440 px with the sidebar four of the five columns show, at 1920 px all five, each 314 px). A tile is as tall as its content;
  what keeps one from running away is a cap on two rows: the title takes two lines, the status one, the rest cut with "…" and the
  whole text in the tooltip (a blocked reason, a long title). (2) *The status line says one thing* (`tileStatus`, pure): why it is
  stuck (its own reason, else a blocked sub task) → whom it waits for → what is running (the agent's mark and/or the sub task in
  progress) → what is next → the sub tasks' progress; a card with nothing to say has no row. When it is not the progress, the sub
  tasks' count (done/total, red once one is blocked) is a small button in the foot that opens the list. A blocked or waiting card
  says it in its text colour (`--danger`, `--warn`). In the list a running row's "Running" mark leads the title (after the number,
  in the title's cell) instead of sitting among the tags at the right. (3) *No bar on the left edge*, in any status, on the board's tiles (the
  list's rows never had one; the card page's agent block keeps its own).
  (4) *The assignee's avatar is a button* (`fleet-task-owner.js`, tile and list row): it opens the card page's picker
  (`assigneeItems`: nobody, each instance, Other…) as the card menu draws it, fixed under the button so the columns' scroll box
  does not clip it; a choice is one write with the version the tile was drawn at (`assignTo`, shared with the ⋯ menu): a 409 says
  the card changed while choosing and reads the board again, any other error is the host's words. The card stays shut (the click
  is the avatar's), the keyboard works (Enter, Esc closes and gives the focus back). It is not a button on a finished card (the page
  does not offer it either), nor to a viewer whose writes the host refuses (`boardReadOnly`: a guest, or a session over the public
  link that is not an admin's — an admin session over the link writes as itself, M-3278); the avatar still shows its card.
  (5) *Pointing at the avatar shows the instance's card* after a short pause (the keyboard's focus at once; Esc, a click, a scroll
  or leaving hides it; one at a time; none when the focus comes back from the picker it opened): its state (running / needs you /
  looks stuck / idle / offline), what it is doing (the card in progress, "Working on S-2 …"), how many cards it holds (finished ones
  and a main task that follows its sub tasks not counted), and two facts the page has: whether it leads the project and who
  dispatched the card. It is built only from the board the viewer was sent and the instances the dashboard shows them: an instance
  they do not see has no state line, and a dispatcher that is an instance they do not see is not named — over the link the board has
  already left out the cards of instances kept out of sight, so counts and the "doing" line cannot name one either. On a main task
  whose sub tasks are someone else's, the avatar is the main task's owner and the sub tasks' people follow it after a "›".
  (6) *On the card's page the activity is a stream.* The heading and the filter stay on top; under them
  two kinds of thing, by what they are: **what is said** — each comment and each progress note (the same card, a "Progress" tag on
  the note) — is a card of its own (1px, `--r-md`, `--surface`, 16px inside, 12px apart; a head with the avatar — an instance's with
  its state dot, the dashboard's `dotState`, and none for an instance the viewer does not see —, the name, an "Agent" badge for an
  agent, the time with its whole time on hover; the text under the name, the chat's Markdown; no coloured bar at an agent's card).
  The avatar is 28px and, with the name, one button that shows **the board's own info card** (`OwnerCard`, one component for
  both): pointing at it after a short pause, the keyboard's focus at once, a tap on a phone; the pointer may go from the avatar into
  the card (a short grace), Tab reaches its "Open Agent page" link, a tap outside, Esc, a scroll or a resize closes it and Esc gives the
  focus back. An instance's card is the state, what it is doing, how many cards it holds and whether it leads the project, with the
  link to its Agent page (`detailsPath`); a person's is the name and "Person", no link. Over a read-only link (a public link, a guest) the
  card still reads but has no link (the Agent page needs a sign-in), and an instance the viewer does not see has no button and
  no card — its name is the entry's own, nothing more. The comment's text is formatted as the instance chat's window formats
  a message — the same renderer (headings, lists, links, inline code, tables with borders, a JSON or any other code block coloured
  by the chat's own tokens) and the same code frame: the language, Wrap and Copy in its header, a block of more than 30 lines folded
  until "Show all N lines", the Wrap choice kept under the chat's key; a progress note stays one plain line, its "Progress" tag and
  filter explain themselves on hover ("a one-line work note an agent or member wrote down — not a comment");
  **what the system did** is a thin row (no box, `--fs-xs`, secondary colour: a mark — a status change's is the status's —, a
  sentence the name leads, "dev-a changed status from To do to In progress", the time), and every run of them between two cards, of
  any length — one line too, and the first run — is one "› N activities" button ("1 activity" for one) — an arrow and a word, no fill, border or rounding like the rows under it; pointing at it only turns the text to the primary colour, the keyboard's focus keeps its ring —, closed at first (a run of equal lines is still one line ×N; the History filter, which
  asks for them, never folds). The comment box is the stream's last card (its text area without a box of its own, Send inside at the
  bottom right); without a box (a read-only page) the stream is alone. Nothing here names what the viewer does not see: the stream is
  built from the entries the host sent (over the link it has already left out a hidden instance's), and a state dot is drawn only for
  an instance the dashboard shows. A comment has a tools row of its own (a reaction button and a ⋯ menu), a reply is drawn under its thread's first comment, and
  the box ends with a chip saying whom the comment is for — all of it is "Comment threads" below. The stream starts on the page's left edge, like the sub tasks and the spec above it.
  (7) *Dressed as Settings is.* Tasks reused no part of Settings' look and read as a second product; its shared pieces are now
  Settings' own, by the same classes and tokens (no colour of its own): a page head is `.s-page-head` — a 24px title with its
  badge (`.s-scope` for Archived), the project's description as the muted lead (`.s-page-lead`), the actions at the right — on
  Home and on a project; the search field is `.s-search`'s (surface fill, `--r-sm`, no border, the focus ring); the list is the
  Agent page's list — one rounded bordered container on `--surface`, its header row and each group's heading on `--surface-2`,
  rows between thin lines, 16px inside; a project's tile and the card page's properties box are Settings' card
  (1px border, `--r-md`, 20px inside, no shadow; the activity's heading is sentence-case at `--fs-lg`; the activity itself is the stream of (6)). What Settings has no
  counterpart for stays: the board's columns and white tiles (the Kanban convention taskhall's looks keep), the segmented
  Board / List switch (as the Fleet tabs are), the pills.
- **A phone.** The board shows one status at a time (the switch is hidden on a desk; every column is drawn, a class
  shows the current one), starting at the first of To confirm, In progress, Blocked, To do, Done that has cards.
- **The comment box's @.** Typing `@` completes with the fleet's instance names (those with the board off are listed,
  disabled; a name no longer in the fleet is not) and only types `@<name> ` into the text. What an @ does to that
  instance is the board's business, which reads the same plain text; the box sends the comment as typed. The list
  follows the board's reading (`task-board-mentions.ts`): none right after a letter, digit, `_`, `.`, `-`, `@`, `/` or
  `\`, none inside inline code or a fenced block (`mentionAt`, with the board's `withoutCode`), and when the text after
  the caret would run the name on into a longer instance name, the box adds a space of its own, so the name typed is the
  name read. A test runs both over a battery of texts (`tests/task-board-page.test.ts`: whatever the box offers, the board's parser reads as that instance). The word at the
  caret and its replacement are one function for this `@` and the chat's `#` (`src/ui/trigger-complete.js`: `triggerAt` /
  `insertAtTrigger`, a rule per trigger character; `mentionAt` / `insertMention` and `taskRefAt` / `insertTaskRef` are it with
  their trigger), so a rule fixed for one list is fixed for both.
- **taskhall's looks.** The columns reach the bottom of the page (a card drops anywhere down a column). Tiles are white with a shadow and a bold title; no bar on the
  left edge, in any status — the column says the status, a stuck or waiting card says it in the colour of its text; a size in a box. Who works on a card has
  a round initial: an instance's in its identity colour (#1958), a person's grey.
- **Who works on what (step 3).** `GET /ui/tasks/work` (`?instance=` for one): each instance's `myWork` — what its
  `task mine` reads — for the fleet's instances and anyone else holding a live card, drawn in one `views()` read. Over the
  public link an instance kept out of sight is not listed, nor a card that names one. The board's **Instances** drawer
  (`fleet-task-work.js`, taskhall's): by team as the sidebar groups them, working ones first, then those with cards;
  each line says what the card is to it (sent back, in progress, blocked, waiting for you, owns, can start, waiting on)
  and opens it. It is read again on each board change. An instance's Details page reads its own once.
- **What the agent is doing.** `fleet-task-run.js`. A card in `claimed` whose assignee is an instance the
  viewer sees and that is working (the dashboard's own `exec` / `awaiting`, live by the `activity` event) is "running":
  a mark on its tile and list row, a main task's from its in-progress sub tasks (the strongest), and an **Agent
  activity** block on the card's page (who, their state, **Open conversation** → `/ui/chat/<instance>`). The match is an
  inference, not a record: AgEnD has no run per card (an instance is one continuing session), and nothing was added to
  record one. It is exact while the assignee has that one card in progress (`board_cards_at_once` defaults to 1); with
  several (`inProgressBy` over the board's cards — the rule of `inProgress()`), no card says "running", each says "Busy
  · N cards", and the page says what it cannot know. The board reads the dashboard's store once (`useRunContext`), only for the instances that have a card in
  progress, and redraws when one of their states changes: a tile or a row subscribes to nothing. The live steps are the chat's own feed (`observeActivity`, `GET
  /ui/steps?chat=1`, live by `steps_tick`), held only while the card's page is open and its assignee is working, drawn
  by the chat's `ActivityBlock` from the steps since the card was last moved to `claimed`: for an admin session, with
  the instance's `tool_progress` not `off` and Show activity on — otherwise the state alone (with a line saying so when
  it is the agent's `tool_progress` that is off). Not used on purpose: `instance_activity` (the statusline's one-line tool label) — it is not
  governed by `tool_progress` and carries commands, which a read-only viewer must not see — and a transcript per
  finished card: the transcript is one continuing session read within a byte limit, so an old card's window may not be
  there; a finished card gets the conversation link only. The timeline's entries carry `authorKind` / `actorKind`
  already; an instance's are tagged **Agent**. No API, schema or column changed; a viewer who cannot see the instance,
  a card nobody has and an older server's entries (no kind) show as before.
- **The public link** shows the board with a read-only note and no write controls (see above): a card's project, priority, size and review are text, not disabled controls (#2299).
- **Toasts** are a manual popover (the top layer), above any dialog's backdrop (the board's asks — a reason, an answer, a name — are dialogs). On a phone the board's toasts come in above the tabs (an older confirmation gives way to two newer toasts; an error stays), not over its title and search (#2299).
- **Wrapped up before you confirm (step 2).** A main task goes to review by itself when its last sub task is done —
  often a reviewer's — before its owner ticked its definition of done or wrote its result. Such a card shows "To fill
  in", the waiting row and the card say what is missing, and Confirm asks first (send it back, or confirm anyway with
  an optional note). Agents read the same in `get` and `mine`.
- **Who works on a main task now (step 2).** Its owner is not always the one at work (a review step is the
  reviewer's): a main task with sub tasks shows the sub task in progress and its worker, else a blocked one, else the
  next one that can start; waiting for you, it says so. That is the tile's status line, and the avatar in its foot is the main task's own owner (what the page's Assignee chip changes) — the sub tasks' people, when they are not the owner, follow it after a "›".

## Agents: the `task` tool on the board

`src/task-board-tool.ts`, behind both of the tool's doors (MCP over IPC, `agend-agent task` over HTTP). New actions
`mine`, `move`, `projects`; `create` / `update` naming a board field go through the board (an `update` with fields and
a `status` is one write: a refused move leaves the fields as they were); `get` of a board card and `list` by `project`
/ `parent` answer with the card or a line per card. The answers are plain text (`src/scheduler/task-board-text.ts`):
an agent reads a card in a dozen short lines, not a JSON record. The tool's own tasks are answered as before; list rows
carry `code`.

**The command line has every action and field the tool has**: `agend-agent task`
`create | list | get | claim | done | update | move | comment | mine | projects | create-project | move-project | watch | unwatch`.
Each field of the tool's `ACTION_FIELDS` is a flag (`--project`, `--parent`, `--scope`, `--acceptance` (repeat), `--context`,
`--needs-review` / `--no-needs-review`, `--size`, `--dispatcher`, `--depends-on`, `--state`, `--log`, `--comment`, `--check`,
`--uncheck`, `--version`, `--stale`, `--detail`, `--limit`, `--cursor`, …); the words that always had a place keep it. The client only
builds the same arguments: the fleet answers them by the one set of rules — the agent token and the tool profile, the dashboard
switch, who may edit a card, a `version` that is not the card's now (refused, nothing written), one card in progress, a field an action
does not take (refused by name) — so a CLI-mode agent is no more and no less able than an MCP one. `tests/agent-cli-task-board.test.ts`
runs the real client against the real `/agent` endpoint, and fails when a field is added to the tool and not to the command line.

A field an action does not take is refused by name and nothing is written (#3195). Projects (#3195, the user's decision
9af8d799): `create_project` (name, description) creates one; `update` with `project` (the project's id, or null /
`"none"`) moves a main task into, between or out of projects when the agent may edit that card (unassigned, its own,
its creation or one it dispatches), its sub tasks following; `move_project` (`ids` + `project`) does that for several,
each card moved or refused on its own with a line per card. Archived projects are refused; a project's lead, renaming
and archiving stay the person's.

Where a new main task goes when an agent's `create` names no project: counting the projects
that are not archived — none: no project, as always; one: that project; several: the one the caller leads, when it leads
exactly one of them, else `create` is refused with the projects listed and nothing is written, so the agent asks the person and
creates again — or, when nobody can answer (a scheduled or automated run), creates it with `project: "none"`. A project named (id
or name) is taken as given, `null` / `"none"` is a deliberate no project, and a blank string counts as nothing said. A sub task follows its main task and is never asked; a person's create (the dashboard) is never asked.
The answer to a main task's create says where it went and why ("the board's only project, chosen for you", "you lead this
project") and what to tell the person (`#M-n` opens the card in the chat, then the project's name). A card left in no project on a
board that has projects also says: ask which project it belongs to, move it once they say, and keep the rule in `soul.md` — the
agent's own memory — so the next such card goes there. A plain `create` that lands
in a project this way stays unassigned, as a plain task is.

The loop the person's confirmation needs closes through the tool: `done` on a held card answers that it waits for the
person; `mine` lists "sent back to you" with the reason; `get` shows the comments new to the assignee and the latest
few, a send-back marked "(sent back)"; and every claim, done or update returns the board's notes (the new comments
first). The tool's description, the `agend-agent` instructions and the default workflow template say so. Board moves
are in the activity log like the tool's claims and completions.

## Files on a card, and Markdown

The person reads the card — its result, its timeline, its files — not the agent's chat and not a path on the agent's machine. An
agent once finished a step with "design document: `/data/workspaces/planner/survivor-design.md`" and the person could open nothing.

**Files.** An agent puts what it made ON the card, under the comment of the write that brings it: `attach: [paths]` on `update` and
`move`, the `attach` action, `agend-agent task attach M-3 FILE…` / `--attach FILE`. The write is one: status, result, comment and
files, all or nothing (a failure after the files moved puts them back to staging).
- *The agent's side reads.* `src/task-attach-client.ts`, in the CLI and in the instance's daemon: each file by `readAgentFile` (inside
  the agent's working directory, no symlink, not under AgEnD state, within 10 MiB), then staged on the fleet in parts (`action: "upload"`,
  an internal action; parts of 360 KiB, each answered before the next — the fleet IPC's line is 1 MiB, the agent endpoint's body
  512 KiB). The write then carries the staged ids as `uploads` in place of the paths: the fleet never opens a path an agent names, and a
  raw `attach` that reaches it is refused with what to use. A write the fleet REFUSES (a card at its limit, a stale `version`) gives the
  staged files back (`release`, internal too), so a write tried again and again never fills the instance's room of 20 staged files; what a
  client that died never gave back leaves after 30 minutes.
- *The fleet keeps.* `src/scheduler/task-files.ts`: `<AGEND_HOME>/task-files/<card uuid>/<id>` (0600 in a 0700 folder; the name on disk
  is the id), staged files in `task-files/pending/` for 30 minutes, held for their writer only. Limits (`src/task-file-limits.ts`):
  10 MiB a file, 20 files and 50 MiB a card, 10 files a write. The type is read from the bytes (`sniffUpload`, the chat's own): a picture,
  text, or any other file as an opaque document; markup (HTML, SVG) is never typed as a page.
- *The board knows.* Table `task_attachments(id, task_id, entry_id, name, mime, kind, size, sha256, author, author_kind, at)`, a file
  hanging under its comment (`entry_id`); a write with files and no words leaves the line `📎 name, name`. `CardView.attachmentCount`,
  `CardDetail.attachments`, a "files on the card" line in the card text an agent reads. A comment's wake is the comment's: a file wakes
  nobody a comment would not. Retention prunes a card's rows and folder with it; the prune also sweeps a folder or staged file nobody holds.
- *The page serves.* `GET /ui/tasks/files/<id>`: read with the card (any session that may read it); over the public link a hidden
  instance's card, its main task's sub task and a file a hidden instance wrote are "no such file", as an unknown id. Always a
  download — an image as an image, text as `text/plain`, everything else `application/octet-stream` with `attachment`, `nosniff`, the
  sandboxing CSP and no caching; never HTML from the dashboard's origin. The file is opened with `O_NOFOLLOW` (a symlink put where it
  was is not followed) and must be a regular file of the size the table holds. Windows has no `O_NOFOLLOW` (Node leaves the constant
  undefined, so the flag is 0 there): the `isFile` check on the opened descriptor and the size check stand alone — which is enough, as
  nothing an agent can write is under `task-files/` (reserved in `agent-file-read.ts`; the fleet alone writes it). What the page shows of a file it reads on a click, as the chat
  does: a picture; Markdown through the chat's renderer; text, CSV, JSON, code as plain text; an `.html` file in the chat's sandboxed
  preview frame (the device must allow previews; not over the public link, except to an admin session there).

**Markdown.** A card's goal, scope, context, state, result and blocked reason are READ as the chat reads a message (`fleet-task-md.js`:
the chat's renderer, which escapes first; code blocks decorated as the chat's). Reading only: the stored text is the same, the edit box
is plain text, a click on the words opens it. A progress `log` line stays one plain line. The limits are the same on purpose (an agent
reads the whole card): a long content goes in a comment (4000 characters) or a file.

**Reporting.** Written in the default workflow (Progress Tracking), the CLI reference, the `task-board` skill and, once, to an agent
already running (`agent-whats-new`): a short Markdown `result`, the content as a comment written for the person (what it is, how to open it),
and the finished file with `attach` — **not the working files**: usually one, at most three, never source, modules, config, logs or drafts; a
web prototype is ONE `.html` with its CSS and JS inline (the source stays in the workspace or branch, linked in the comment); short text goes in
the comment, a file is for what is too long or must be a file; the same file is not attached twice unless it changed. Never only a path.
An agent once attached all six source files of a game with "run `python3 -m http.server`" as the explanation: a pile of parts. The answer to a
write that attaches more than 3 files, or an `.html` beside `.js` / `.css`, carries one reminder line (`attachHint`); the write goes through.
Not told by guessing: the fleet does not turn a path in an agent's text into a file (that would let one sentence of text point the fleet
at any path). The answer to a write whose result, comment, state, log, goal, reason or scope names a path on the agent's machine (and
brought no file) carries one note saying the person cannot open it and how to attach (`pathHint`).

**Other releases.** All additive: the table is new, `tasks` and `task_entries` are unchanged, and a comment's event data is the same
unless it brought files. A release without this ignores the table and the folder, shows a file's comment as the line `📎 name`, and its
prune deletes a card without its rows and files; the next prune here sweeps them (like `task_watchers`).

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
instance hears what someone else did to a card that is its own, or that it handed out. #2801: only a change of status
or assignee is news, and each change goes to one instance — the one that acts next. A confirmation wakes nobody (the
work is finished); a comment, which #2801 had made news for nobody (the card listed new comments for its assignee:
`mine`, `get`), wakes again — its assignee, and each instance it names (see "Comments and mentions"); and a card's progress also goes to its followers (see "Following a card"). The answer to a
busy assignee's blocked question, kept on the card as a comment (#2303), tells its assignee (answer kept) while the card
is still blocked —

| News | Who | When |
|---|---|---|
| assigned | the assignee | a board card opened for it, or given to it (once the card can start); not the `task` tool's own tasks, which are handed over with a message of their own (`delegate_task`) |
| start | the assignee | someone else moved its open card to in progress |
| sent back | the assignee | the person sent it back from review, with the reason |
| answered | the assignee | its blocked question answered (by the person or its dispatcher), with the answer |
| answer kept | the assignee | its dispatcher answered while it works on another card: the answer waits on the card, which stays blocked until it resumes it |
| ready | the assignee | every card it waited for is done — by hand or by the board's own move |
| decide | the dispatcher | its card got blocked on a question: ask the person, answer it on the card |
| to confirm | the dispatcher | its card waits for its confirmation (#2434), with what it still lacks — also when it went there by itself |
| wrap up | the main task's owner | it went to review by itself, its definition of done or result still missing — only when no instance dispatcher is told to confirm it |
| cancelled | the assignee | someone else cancelled it — or its main task, taking it down — with why |
| comment | the assignee | someone else commented on its card, with the words (not while the card is finished or still waits on its dependencies, and not once the assignee has read the comment with a write of its own) |
| mention | the instance named | a comment names it with `@<instance>`, whoever's card it is and whatever its state, with the words |
| progress | the card's followers | a card finished, went to review, was sent back, was blocked or changed hands, with who did it and the words (see "Following a card") |

Never its own write, never a finished card (but for a cancel and a mention), never a name that is not one of the
fleet's instances. `TaskBoard.wakeHolds` drops what no longer stands — at the end of the write and again when it goes
out: a card finished meanwhile, no longer the instance's, a question already answered, a card wrapped up meanwhile.
What asks the instance to act holds only while it can (#2303 review): `ready` while the card is open with nothing
left to wait for, `start` and `answered` while it is in progress, `sent back` while it is back with the instance,
`comment` while the assignee has not read it.

**Sending** (`src/task-board-waker.ts`). The fleet gathers an instance's news for 10 s into one `[Task board]` notice:
a line per card, each reason with its own words and who did it (several comments on one card in the window: the last
is quoted and the line says "+N earlier comments: task get <card>", so it never reads as the only one); a main task
assigned with its sub tasks is one line; more than three assignments at once (a whole plan) are a count ("You were assigned 6 main tasks (M-11–M-16) and 9 sub
tasks… one at a time, by priority"). The notice is AgEnD's own (`admitSystemNotice`: sender AgEnD, not a person's
words) and the delivery outbox holds it until the instance can take it, across a fleet restart too. News still
gathering when the fleet stops is lost; the card keeps it (`mine`, the comments new to its assignee). Blocked cards
with an instance dispatcher still wait for you on Home, marked as asked first.

- **No "told already".** What an agent does to a card is told the way what a person does is: after the 10 s
  gather, and nothing later. #2785 (c) dropped an assignment's line when its assigner had also messaged the assignee about
  the card (29 of 31 such notices on the host, −12 s … +24 s apart: the same dispatch arrived twice), and #2801 widened
  that to every change an instance makes, holding the notice up to 2 minutes (`TOLD_WINDOW_MS`) for such a message and
  dropping it when one came. Both were cuts in notice volume. They were two things made
  one: a message is what an agent says to someone, and an agent that wants to tell someone something @mentions them in a
  comment; the card's change is the program's own notice, so it always goes and never waits for or yields to a message. It
  covers every kind of news the rule covered — assignment, start, send-back, answer, block, review, progress for followers,
  comments and mentions — and the machinery is removed (`foldToldNews`, `messagedAbout`, `toldWindowMs`, `namesCard`, the
  outbox's `recentTextsFrom`). Kept: the gather merges a card's changes into one notice; a notice still waiting is
  withdrawn when its card changed again (#2801, below); the loop guards' counts; nobody is told of what they did themselves.
  A cancel and a person's change were never held and are still told after the gather only.
- **Superseded (#2801).** A notice's outbox key ends with the cards it names (`:cards=<uuid>,…`). When a write changes
  a card's status or assignee (`BoardChange.changed`), a notice still waiting (queued or retrying, never begun) that
  names it is withdrawn once every card on it has changed since it was admitted (`TaskBoard.lastChangeAt`): `cancelled`,
  "superseded: its card changed again", still readable in `delivery_status` and Fleet traffic. What still concerns the
  instance is told anew from the change. A notice from before #2801 (no cards in its key) is never withdrawn.

## Comments and mentions

**The rule.** A comment is news: it wakes the card's assignee when someone else wrote it, and an `@<instance name>` in
it wakes the instance named, whether or not the card is its own. Both go through the same `[Task board]` notice, the
10 s gather and the outbox as every other piece of news (Step 2). Confirmation notes still wake
nobody. **Why.** #2801 took the comment notice out to cut notice volume (163 a week, most of them repeats on busy cards:
"a comment sends nothing"). #4335 decided that the board should be a place where
people and agents talk the way they do in an issue tracker: a comment or an `@mention` reaches the one it is for, so
the person can steer an agent from its card and agents can bring each other in, without a side message
(`send_to_instance`) that names the card. What keeps it from the old noise: only the assignee and the instances named
are told — never the dispatcher or everyone on the card; never the writer; never an assignee that already read the
comment; and agent-to-agent wakes are capped (below).
`defaults.task_board.comment_wakes: false` brings #2801's rule back as it was.

**Who and when** (`TaskBoard.routeComment` at the write, `settleWakes` and `wakeHolds` at its end).
- *Assignee, `comment`.* Not the writer; not an assignee with the task board off (no tool to act on a notice with); not
  for the answer to a blocked question (`answered`, `answer kept` carry it) or a card the `task` tool opened for itself
  (not on the board). `wakeHolds`: not while the card is finished, not while it is open and still waits on what it
  depends on (it reads the comment when it can start, as it learns of its assignment then), and only while the comment
  is still unread — the assignee's own write marks the comments so far as seen, so a comment it has read by the time the
  notice goes out is dropped.
- *Mentioned instance, `mention`.* Any instance in `fleetConfig.instances`, not the writer, not one with the task board
  off; whatever the card's state, finished too — it was asked for by name. It may comment on any card, so it can answer.
  A mentioned assignee gets one `mention`, not a `comment` as well. A *person* whose name is also an instance's name
  is not that instance: their `@name` wakes it (only an instance's own `@name` is ignored as a self-mention).
- *What the notice says of the writer.* When a *person* wrote the comment or the mention, the notice ends with "(a person reads the card; no
  @ needed)": an agent that answered "@web-user" (the name in "web-user mentioned you") only got "no such instance, nobody was woken". An
  instance's comment does not say it, since an `@` may rightly answer it; a script's neither. Several comments gathered in one window say it for the
  last writer's kind (`Wake.byPerson`, kept per reason).
- *Said, not refused.* The writer's notes (`task` tool answer; the dashboard's `said`) tell who will be woken
  (`comment_wakes`), and what was not: `mention_off` (task board off), `mention_unknown` (no such instance; at most three
  shown), `mention_cap`, `comment_chain` (below). Nothing is rejected: the comment is kept either way. The dashboard
  shows only the notes its page lists for people (`PERSON_NOTES`), so these are for agents for now.

**Reading `@name`** (`src/scheduler/task-board-mentions.ts`, pure text → names; every rule has a test).
1. `@` at the start of the text or after anything but a letter, digit, `_`, `-`, `.`, `@`, `/` or `\` (so addresses,
   paths and `@@` are not mentions; brackets, quotes, punctuation, spaces and CJK text before it are fine).
2. The name ends at the end of the text or at a character that cannot continue a name: ASCII letters, digits, `_` and
   `-` continue it, and so does `.` when a name character follows (`@svc.v2`); a sentence's closing `.` does not, and
   CJK text after the name ends it. So `@lead,` / `@lead.` / `@lead請看` are `lead`; `@lead-2` is `lead-2`, never `lead`.
3. Case-insensitive; an exact-case instance wins over one that differs only by case; a name that fits several equally
   names none. The longest name wins (`dev-a` over `dev`).
4. Text between backticks (inline or fenced) is never read — the way to name an instance without waking it.
5. One instance once per comment, in the order first written. A comment's `@word` that is no instance is only a hint.

**Loop guard.** Instances (and scripts, held to an instance's rules) can wake each other: `A: @B …` wakes B, whose reply
`@A …` wakes A. So an *agent's* comment wakes someone only while `agentCommentRun(card) ≤ AGENT_COMMENT_CHAIN` (4 turns).
The run is the agents' comments on the card within `AGENT_COMMENT_WINDOW_MS` (30 min), newest first and every one of them
(no fixed page: notes that wake nobody must not push the turns before them out of what is read), back to the last
entry a person wrote (a comment, a send-back or a confirmation); of those, only the ones that woke someone count — the
comment names an instance other than its writer, or the card's assignee *when it was written* was an instance other than
its writer — so an agent's note to itself on its own card is skipped, and a change of writer starts the next turn: one
agent writing again before anyone answered it is one turn, since a loop needs someone to answer. A comment is read as
it was written: the text again for its `@names`, and the card's own assignment events (`assigned`: from, to; the first
one after the comment says who had the card before it) for its assignee — never today's assignee, or handing the card to
one of the two talking would turn the other's comments into notes to itself and lift the guard. Plain comments count as
well as mentions: a loop can run through the assignee alone (`lead: ok` wakes dev-a, `dev-a: @lead done` wakes lead).
An agent's send-back or log neither counts nor breaks the chain. Past the limit the comment is kept and wakes nobody
(`comment_chain` says so to its writer) until a person writes on the card or the older comments leave the window. It is
computed from the card's own `task_entries` — no counter, no new column. An agent's comment also wakes at most
`MAX_COMMENT_WAKES` (5) instances in all, each counted once: the card's assignee, when it hears the comment (a dispatcher's answer kept for it
included), takes one place
whether or not it is named and wherever its name is, and the other instances named share the rest in the order written.
A person's comment has neither limit.

**Contact rules.** A comment, an `@` mention and a follower's progress carry an agent's own words to another instance, so
they meet the rules a peer message meets: while an active Hub contact window restricts the writer (M-3160, whatever its
origin), or its conversation has an origin that needs a contact approval (M-3384, `ContactAuthService.needsApplication`:
unknown, mixed, or not an administrator's), its words wake no other instance by the board. The board asks it per recipient as it writes
(`setContactGate`; `contact_held` / `progress_contact_held` tell the writer, who is pointed to `send_to_instance`, where
the application and any standing grant are), and the waker asks again as the notice goes out (a writer restricted
during the gather: its words are left out, the board's own news on the card still goes). A wake names the writers whose
words it carries (`principals`); the fleet stamps each one's origin as the write commits, the waker keeps every snapshot of
every write it merges (within a card and across the notice's cards), and the recipient inherits each when the notice is
admitted, as `admitDurableDelivery` does for a peer's message. A person's words are not held to it,
and the board's own news (an assignment, a send-back, a question to its dispatcher) is unchanged.

*Per card only.* The guard bounds the talk on one card; it is not a global or per-instance rate limit. Two agents
that move from card to card, mentioning each other, get up to 4 turns on each, so the total is bounded by the number
of cards they can touch, not by the guard. That is a deliberate trade: a global ceiling would silence legitimate work
on a busy fleet, and an agent that spends turns this way is also bounded by the board's other rules (one card in
progress at a time, the dispatcher alerts of #3647). A fleet that wants none of it sets
`defaults.task_board.comment_wakes: false`; a global or per-instance rate limit is a follow-up if upstream wants one.
The 10 s gather applies as before, and nothing waits past it: an agent's comment is told after the gather like any other news,
whether or not its writer also messaged the instance.

**Compatibility.** Wakes are read from a write's events as it commits (Step 2), never from stored comments: opening a
database from before this rule wakes nobody, and comments written before it are never told. No column or table is added by this rule
(`task_entries` and `task_events` are written as they always were: the event keeps its `text` only), so a release
without the rule reads the same database. The stored comments, the `task` tool's `comment` field and the dashboard's
comment box are unchanged; `@` autocomplete in the box is the Tasks page's, and it needs only to insert the same plain
`@<instance name>`.

## Comment threads

Status: comment threads, after #4367. A comment is no longer a card's last word: it can be answered, reacted to, corrected, folded away, deleted and linked to, and a person says whom a comment is for.

**Data** (all additive, `migrate()`; a release without it neither reads nor writes any of it):
- `task_entries` gains `parent_id` (the comment this one answers — the one it was written under, not the thread's first), `edited_at`, `deleted_at` + `deleted_by`, `resolved_at` + `resolved_by` (on a thread's first comment) `notify` (JSON `{ to, assignee, at }`, written with every new comment: `at` the instances its words `@`-named when it was written, `to` and `assignee` whom its writer addressed — kept so the loop guard counts them even after the words change) and `author_key` (a person's stable dashboard key, never returned by a read). A new table `task_entry_reactions(entry_id, emoji, by, by_kind, who, at)`, one row per (comment, emoji, reactor): `who` is the reactor's identity — `key:<the person's dashboard key>` when the session has one, else `name:<name>` — and `by` the name shown.
- The history's `commented` event now also names its `entry`. Edits, reactions, resolving and deleting write **no** `task_events` row — a release that does not know an event type prints it as the line it is — but each is a change the page and the board's revision hear (`SignalType`), so every open page redraws.
- `Entry` (the card read's `comments`) carries `parentId`, `editedAt`, `deleted: { at, by }`, `resolved: { at, by }` and `reactions: [{ emoji, by: [{ name, kind }] }]`, each only when it has a value: an entry nobody touched has exactly the fields it had. The card read also says `viewer` — who an admin session writes as — so the page knows which comments are the viewer's.

**Rules** (`TaskBoard.editComment / deleteComment / react / resolveThread`, `updateCard`'s `replyTo` and `to`):
- *Edit* is its author's (person or instance), of a live `comment` entry (not a send-back or a confirmation). **Who the author is**: the same kind and, for a comment that kept its writer's key, the same key — two accounts that are both "web-user" because neither set a name are not each other, one who renamed themselves still is themselves, and a session with the same name and no key (or another key) is not the author of a keyed comment. Only a comment with no key — one written before keys were kept, an instance's, a script's — falls back to the kind and the name, which cannot tell two sessions of one name apart. With no people kept at all every session is the one operator (the same key), so every "web-user" is the author of every "web-user" comment — there is no identity to tell them apart. The card read marks each comment, and each reaction chip, `mine` for the viewer (so the page offers Edit only on theirs and presses only their chips). It changes `text`, sets `edited_at`, keeps the stored `@` names (adding the ones the new words bring), and rewrites the copy in the history's event: the event that names the comment's entry, and for an older one (it names none) the single line by the same author with the same words closest in time to the comment, never several — so editing or deleting one "ok" leaves the card's other "ok" lines alone. The card's version does not move.
- *Delete* is the author's, or a person's (an administrator's dashboard session; an instance or a script only deletes its own). The words go from the row and the history's copy, the reactions and the files that came with it go, and the entry stays: `text` is empty, `deleted_at` is set, and the replies under it still have something to hang from. A release without threads reads it as an empty comment. **A notice that quotes the comment is called back while it can be** (`Wake.entries`, `wakeHolds`, `TaskBoardWaker.recalled`): news still gathering (the waker's 10 s window) reads the comment again as it goes out, so it says the edited words and leaves a deleted comment (and what a reply quoted of one) out; a notice already handed to the delivery outbox whose key names the comment (`task-board:…:comments=12:cards=…`) is withdrawn while it still waits there (the instance is offline or paused, the delivery not yet attempted) and what of it still stands — an assignment it also carried, another comment — is told anew in a notice with the words as they are now. **It cannot be called back once the instance has it** (delivered), nor, after a restart, replaced: the withdrawn notice is then simply gone and the card keeps the news. A notice queued before this release has no comments in its key and is left as it is.
- *React* is anyone's who may read the card, one emoji per reactor per comment (`INSERT OR IGNORE` on the reactor's `who`: a person's key, so two accounts of one name each have their own chip and neither can take the other's back), each takes back only their own. It is one emoji and nothing else (emoji, joiners, variation selectors, skin tones, flags and keycaps, at most 16 code points: never markup), and a comment carries at most 20 different ones.
- *Resolve* folds a thread: only on its first comment (a reply is refused: `resolve_root_only`; so is a first comment that was deleted: `comment_deleted`), by anyone who may comment, opened again the same way.
- *Reply* (`replyTo`) names one of this card's comments that has not been deleted; otherwise the write is refused whole (`comment_not_found`, `comment_deleted`), nothing is written. A comment that is not on this card cannot be answered or changed through it.
- Counts and reads skip a deleted comment: the card's `commentCount` and `lastComment`, `newComments` (what the assignee has not seen), `task mine`, and search (the words are gone anyway).

**Whom a comment wakes** (the rules of "Comments and mentions", with the recipient the writer chose added; the loop guard, the 5-instance cap, the contact rules and the board-off and unknown-name notes are the same code, `routeComment`):
- `to` (a list of instance names, at most 5; the dashboard's chip names one) is optional. **Absent: the old rule** — the card's assignee and each `@name`. **Given: the card's assignee hears the comment only if it is on `to`** (`to: []` is "notify no agent"; an `@name` in the words still wakes). An instance on `to` is woken as a *mention* — `X mentioned you in a comment` — wherever the card stands. The card's assignee on `to` is told as the old rule's *comment* (it can act on it now); on a card that is finished or still waiting on what it depends on, where that rule tells nobody, it is a mention instead, since the writer asked for it by name: what the chip says is what happens. The dashboard sends `to` naming a card's assignee on a card that waits only when the person chose it in the chip (below): with the chip left as it starts, it sends no `to`, the old rule applies and `wakeHolds` keeps the comment from waking the assignee until the card can start.
- A *reply that chose no `to`* also tells the author of the comment it answers, when that is an instance other than the writer, besides the old rule's assignee and `@names`. The notice says which comment it answers (`replying to c12 (lead): "…"`). The page's reply box names that author in its chip (`to`), so it wakes it the same way.
- **Changed defaults** (what differs from #4367, so nobody finds it by surprise): (1) *A reply wakes the instance it answers* — for a person's reply and an agent's alike, in any state of the card (a finished card, one still waiting on another), as a mention for the card's assignee on a card where its comment would not wake it. #4367 woke only the assignee and the `@names`. It is held to the same limits as every comment wake, unchanged: an agent's reply is a turn of the 4-turn agent chain (a person's write resets it), at most 5 instances are woken by one comment, the 30-minute window of the loop guard counts, and `comment_wakes: false` brings #2801's rule back. (2) *The dashboard's comment box starts at the card's assignee* (the chip) and so sends `to`; before, it sent none and the old rule applied. For a card in progress or open and ready that is the same wake. For a finished card it is no one (the chip starts at "No agent notified"), as before. For a card still waiting on another card it is held back, as before (the chip says so), unless the person chooses the assignee.
- *Edit*: nobody is woken, **except** an instance the new words `@`-name that the old ones did not, and only that one (never the assignee by the old rule), held to the same guard. *React, resolve, delete*: nobody.
- The loop guard reads what was **stored** when a comment was written, never its words as they are now: a comment counts as an agent's turn when its stored `at` (the `@` names of its words as written) or `to` names an instance other than its writer, or (old rule) its assignee was an instance other than its writer. So deleting a comment, or editing its `@` out, does not take its turn out of the count — on a card nobody holds, two agents `@`-ing each other and deleting each comment as they go are still stopped at the fifth turn. An edit keeps the stored `at` and adds the names it brings; a row from before `at` was stored (its `notify` has none) is read from its words, as it always was, and an edit of such a row first stores what its old words named. Two agents answering each other with `reply_to` and no `@` stop at the same 4 turns.
- `task` tool (both doors): `update` takes `reply_to` (a number as `get` shows it: `c12`, `#12` or `12`), and the new action `edit_comment` (`id`, `comment_id`, `comment`) changes a comment of the agent's own. There is no tool-level `to`: `to` is already the tool's status field. `task get` with `detail` shows each comment's number, "(edited)" and "(reply to c12)", and not a deleted one.

**Who sees what.** Over the public link a read-only session sees none of it written (every route is an admin session's; the page offers only Copy and Copy link). A hidden instance's comments are left out as before; so are its reactions, its name as the one who resolved or deleted, and a reply to its comment reads as a comment of its own (nothing says what it answered). An admin session over the link sees the board whole, as it does everywhere (M-3278).

**The page** (`fleet-task-thread.js`, `fleet-task-activity.js`): each comment's head ends with a reaction button and a ⋯ menu (the app's `Menu`) — Reply, Add reaction, Edit (the author's), Resolve / Reopen thread (a thread's first comment), Copy (the Markdown as written), Copy link (`?card=M-12#c42`), Delete (asks first). A reply is a card of its own under its thread's first comment, indented; a resolved thread is one line (`Resolved thread · Resolved by Ann · …`) that opens again; a deleted comment is a line saying so; reactions are the chat's chip, the viewer's own accented and pressable to take it back; the address `#c42` opens the card, scrolls to that comment and lights it for a moment (a resolved thread opens first). "Create a sub task from this comment" is a follow-up.
- *The recipient chip* sits under the comment box (and a reply box): "dev · starts when sent", or "No agent notified". It starts as the card's assignee when that is an instance the board can wake and the card is live — "No agent notified" for a person, no assignee, an instance with the task board off, or a finished card (a comment on finished work is rarely an order; choosing someone still wakes them) — and, in a reply, as the author of the comment it answers when that is an instance the board can wake. It follows the default until the person chooses. On an open card that still waits on another card (a hidden one counts) the chip names the assignee but says "dev · won't wake until the card is ready" (its tooltip: the card's assignee reads the comment when the card can start, and an `@name` or choosing it in the list wakes it now) and the page sends **no** `to` — #4367's rule — until the person chooses someone, the assignee included, which sends `to`. Its list: the assignee, who handed the card out, the watchers, the project's (or board's) leader, every other instance of the fleet — each once; one with the task board off is listed, not choosable — and "No agent notified". Otherwise the page always sends `to`. A reaction chip and the quick set's choices, and the "Hide the thread" button of a resolved thread, are a 44 px box (`--tap`) on a touch screen or a phone.

**Other releases.** Columns and the table are added in place and read as NULL / empty on every older row. A release without threads reads an edited comment as its new words, **a deleted one as an empty comment**, a reply as a comment, and writes comments without the new columns (which read as "no parent, no recipients"); its prune leaves the reactions of a pruned card behind and the next prune here sweeps them. Probed against the previous release's source and by `scripts/data-downgrade-phase.mjs` (docs/downgrade-compatibility.md).

## Comment status

Status: comment status, on the comment threads. Before it, a comment that woke an agent said nothing until the agent answered: the person could not tell whether it had been read or was being worked on, nor why nothing happened when it was refused (the board's notes reached only the writer's answer, once).

**Data** (additive, `migrate()`; a release without it neither reads nor writes it): `task_entries.wakes` (TEXT, JSON): for a comment written for instances, a list of `{ to, why, at, key?, skip? }` — `to` the instance, `why` as what (`assignee`: the card's assignee hears it by the old rule; `addressed`: the recipient the writer chose; `mention`: an `@name` in the words), `at` when it was routed, `key` the delivery outbox's key of the notice that carried it, or `skip` why it was not woken: `board_off`, `contact_held`, `loop_guard`, `unknown` (no such instance — the typo case), `cap`, `wakes_off` (`defaults.task_board.comment_wakes: false`), `not_waiting` (the card no longer waits on it when the news went out), `not_taken` (the fleet could not queue the notice), `lost`. Null for a comment nobody was written for, and for every older one. No event, no revision: it is the comment's own record.

**How it is kept.** `routeComment` — the one place that decides whom a comment wakes — now also returns whom it meant and could not wake (`CommentAudience.refused`), and `commented()` writes both with the comment. `settleWakes` marks `not_waiting` for an instance the comment meant but no wake of the write carries (`wakeHolds`). The waker (`TaskBoardWaker`, 10 s after the write) tells the board what became of each card's news as it goes out (`deps.settled`): handed to delivery under the key (`wakeHanded`: every comment of the card waiting to be told to that instance now carries it — a window of comments is one notice), or not sent and why (`board off while it gathered`, `contact rules`, `holds`, `not taken`). Neither call is a board write. A notice withdrawn because a comment it quoted was edited or deleted ("Comment threads") and told anew carries the keys it replaces (`Wake.replaces`, `deps.settled`'s `replaces`): the comments it carried (`wakeHanded(…, replaces)`) follow the new notice, so an edited comment's line goes on saying where the notice that carries its new words stands.

**How far it got** is read, not stored: `DeliveryOutbox.noticeProgress(keys)` (state, `consumed_at` — #1201, the CLI's own transcript shows the instance took it up — never the notice's text) and `wakeViews` in `web-api.ts` build, per recipient, one of `sending` (not handed over yet: 10 s), `queued` (handed over, not taken: offline, paused, busy), `delivered`, `read` (consumed), `failed`, `uncertain`, `withdrawn` (the card changed again, so the notice was dropped for the newer one, #2801), `skipped` (+ `skip`), or `unknown` (the outbox no longer has the row: nothing is said). A comment not handed over two minutes after it was routed is `skipped: lost` (the fleet stopped while it gathered; the card keeps the comment).

**The card read** carries `wakes: [{ to, why, state, skip?, at, readAt? }]` on those comments, **only for a session that can write** (it is the writer's feedback) and never of an instance kept out of sight; no key, delivery id or text. A read-only session, on the link or not, has no `wakes`.

**Live.** The fleet sends the SSE event `task_wakes { ids: [card numbers] }` — and nothing else — when the waker settled a card's news or when a delivery of a task board notice changed state or was consumed (`DeliveryOutbox` `state` / `consumed`). An open card page reads the card again; while any comment has a notice on its way (under 3 minutes old, `sending`, `queued` or `delivered`) it also reads it every 5 s on its own, so a page that polls, or missed the ping, still moves.

**Known limits.** (1) What the waker settles is per card and instance, not per comment (`wakeHanded` / `wakeDropped` apply to every comment on the card still waiting to be told to that instance): the notice is one message for the window, so the `key` is right for all of them; but `contact_held` is judged by the writer's origin, so if two writers' comments sit in one window and only one may reach the instance, both are marked the same. Rare; `settled` could carry the comment numbers if it ever matters. (2) A comment that is `delivered` but not yet `read` is "on its way" for the page's own re-read only for 3 minutes; if the transcript confirms consumption later, a page without the stream ping stays at *Delivered* until it is reloaded. The stream's `task_wakes` ping moves it; the polling page is the edge case.

**The page** (`fleet-task-wake.js`): under a comment written for an instance, a line per instance in the person's words — *Sent to test* → *test read it* → *test is working…* → *test replied* (a link to the reply) — or *test is offline — it gets this when it is back*, *test was not woken: its task board is off*, and so on. "Working" and offline/paused are the page's own inference from the instance's state (the same as the card's "Running", `instanceStates`, #4346): an agent is one continuing session, so *working* says it is busy, not that it is on this very comment (the line's tooltip says so). *Replied* is a later comment by that instance (not a person's, not a deleted one). A line that settled well (read, delivered, replied) is dropped from a comment older than a day; a failure or a refusal is always shown.

## Unread

Status: unread, on the comment status. A person can leave the Tasks page and not know that an agent answered, mentioned them, or handed a card back. Notices (a web-only fleet's system events, one fleet-wide read mark, no link to a card) and Needs you (a state — "this card waits for you" — and `task_board` is off by default) do not say that, so the board keeps a small per-person mark of its own.

**What counts as news for the person P** (`scheduler/task-board-unread.ts`; others' words only — P's own are never news, nor is a deleted comment). **Who P is:** a name and, when the session has one, the person's stable dashboard key. P's marks are kept under the key (`key:…`; the name alone, `name:…`, only for a session with none), so two accounts that are both "web-user" do not share what they have read, and "P's own comment" or "a comment under one of P's" is decided by the key the comment kept when it was written (a comment with no key — written before keys were kept, an instance's — by the name, which cannot tell two same-named sessions apart):
- `reply`: a comment under one of P's comments (`parent_id`);
- `mention`: a comment whose words `@`-name P (the board's `@` rules: not in code, not part of an address);
- `answer`: the first comment by an instance after a comment of P's that woke it (`wakes`, above) — the answer P was waiting for, which an agent writes without `reply_to`;
- `review` / `blocked`: the card now waits for P to confirm or answer (`waitsForPerson`) and someone else put it there since P last opened it.
Only a comment of the last 30 days (`UNREAD_WINDOW_DAYS`) on a card that is not cancelled can be news. The window is in the query itself: the first comment inside it is found by `idx_task_entries_at` (an additive index on `task_entries(at)`), and the range of comment numbers the query reads starts there, so a card nobody opens does not keep every unread query (one per open page per `tasks` ping) walking its history since the person's floor; a finished card still counts (an agent often answers as it finishes). Everything else on a card — the progress log, history, other comments — is not unread. (Whether the card is one P commented on or owns would widen this to "all activity on my cards"; that is left open, below.)

**Data** (additive): `task_card_reads(person, task_id, seen_entry, seen_event, at)` — one mark per person and card, moving only forward; `task_reads_floor(person, entry_floor, event_floor, at)` — written the first time a person is asked, so an old history is never unread (`person` is `key:<the dashboard key>` or `name:<name>`, as above); and the index `idx_task_entries_at`. Nothing else is stored: what is unread is worked out from the comments, `wakes` and the history against the mark. Pruning a card drops its marks. A release without it ignores both tables.

**API** (an admin session's own, by the key it writes as — its name where it has none): `GET /ui/tasks/unread` → `{ enabled, total, cards: { "M-12": { n, reasons, entries, at, by } } }` (`enabled: false`, nothing else, for a read-only session; never cached; no comment text); `POST /ui/tasks/cards/<id>/read` marks the card (everything on it so far) and answers with the new state; a read-only session is refused (403), a card kept out of sight is 404.

**The page.** `task-unread.js` keeps the answer in the app store (`taskUnread`) and reads it again on the stream's `tasks` and `task_wakes` pings, on a reconnect, when the tab is shown and once a minute (a page that polls hears no ping). It is shown as: a number on the **Fleet row of the sidebar** (a phone's drawer has no counts, M-3166: the Tasks page says it there), a **dot with the number on a card's tile and row** (a main task counts its sub tasks'), a **strip at the top of Home and of a project's board** (the first five cards: "dev answered you · +1 more · 2 min ago"), and on the card page a **"New" tag on each new comment**. **Opening a card marks it read** a moment after it is shown (at once when the tab comes to the front); the tags stay until the card is left.

**Left open** (nothing below is built; each is cheap to add on this): browser desktop notifications (Web Notifications, the person turns them on — `notifyOn` of Needs you is the model); a message in a chat channel (Telegram / Discord) when an agent answers; the scope — only what is addressed to the person (above), or every activity on a card they commented on or own; a `(N)` in the tab title (Needs you already has one).

## Live state and handoffs

Status: live state and handoffs, on the comment status and the agent's activity (#4346). Two questions about a main task (M-2, an RPG game with S-1 → S-2 → S-3): "In progress" is a *status* — it does not mean an agent is working — and S-1 → S-2 switched over with nothing on the card to say how. Layout, style and one additive table; no new event type, no revision of its own.

**How a sub task is taken over (what the board does today, unchanged).**
1. S-2 *depends on* S-1 (`dependsOn`; a sub task also waits for its main task's dependencies). While S-1 is not `done` S-2 shows "Waits for S-1" (`unmetDeps`) and nothing is sent to S-2's assignee (an assignment is held while a card waits: `wakeHolds`).
2. S-1 is finished — by its agent, or confirmed by the person from review. In the same write the board settles its wakes: every open card that waited only for S-1 and has an assignee is `ready` (`wakeReady`); the main task's own status moves (below).
3. After the 10 s gather the fleet sends S-2's assignee one `[Task board]` notice ("everything it waited for is done — you can start it") through the delivery outbox, as AgEnD's own notice: held until the instance can take it (offline, paused, busy), across a restart too.
4. **Nothing starts S-2 by itself.** The assignee reads the notice and claims it (`task claim` / a move to `claimed`; one card at a time: it finishes or blocks its current card first). That claim is S-2's "In progress", and it is the assignee's own write. The notice says so (`claim it first (task claim S-2), then start`), and so do `task get` on a card that can start and the default workflow's "Progress Tracking".
5. The main task follows its sub tasks (`deriveMain`): open until one starts, in progress while any has started and not all are done, in review (or done, when it skips review) when all are. That is the chip "it has sub tasks, its status follows them". A main task's own history therefore says only *its* moves ("changed status … (automatic)"), never a sub task's — which is why the hand-over was invisible.

**Data** (additive, `migrate()`; a release without it neither reads nor writes it). `task_handoffs(id, task_id, instance, why, after_id, at, notice_key, skip)`: one row for each wake of a write that tells an instance its card can be started — `ready` (everything it waited for is done; `after_id`: the card whose finishing readied it) or `assigned` (given to it while it could start) — written in the same transaction as the write that caused it (`recordHandoffs`, after `wakeHolds`, so a wake that does not stand leaves nothing). Nothing for an assignee that is no instance of the fleet (it is never told) or a card nobody holds. It is not a `task_events` row (a release that does not know an event type prints it as the line it is) and moves no revision.

**How it is kept.** The waker settles the news it carries per kind, as the comment status does: `settled({ kind: "handoff", key | skip })` — handed to delivery under the outbox key, or not sent: `board_off` (the instance's task board is off), `not_waiting` (the card started, or changed hands, while the news gathered — `wakeHolds` no longer holds the reason), `not_taken` (the fleet could not queue it), `lost` (read, not stored: a row not handed over two minutes after it was made). A notice that carries both a comment's words and a handoff settles each its own way: a comment held back by the contact rules (`contact_held`) does not hold back the hand-over. `handoffHanded` / `handoffDropped` only fill a row that is still waiting (no key, no skip), and answer with the sub task's number *and its main task's*, so the open pages of both read again.

**How far it got** is read like a comment's (`noticeState`, shared with `wakeViews`): `sending`, `queued`, `delivered`, `read` (the CLI's own transcript shows the instance took it, #1201), `failed`, `uncertain`, `withdrawn`, `skipped` (+ `skip`), `unknown` (the outbox no longer has the row: nothing is said). Never a key, delivery id or the notice's text.

**The card read** gains two fields, both additive. `subEvents` (a main task's): the moves of its sub tasks, newest 80, oldest first — `{ id, at, actor, actorKind, card, title, data: { from, to, auto?, reason? } }` — read by every session; over the public link the moves of a sub task kept out of sight and of an instance kept out of sight are left out, as the card's own history is (`hiddenCode`, `hiddenName`). `handoffs`: the handoffs of the card and, for a main task, of its sub tasks, `{ id, card, to, why, after, at, state, skip?, readAt? }`, **only for a session that can write** (the delivery's state is the writer's feedback, as `wakes` is), never of an instance kept out of sight, and with `after` (the card whose finishing readied it) read as none when that card is kept out of sight from the viewer (the page then says "S-2 can start → handed to dev"). A card with none has no field. The live ping is the comment status's: `task_wakes { ids }` names the sub task and its main task (card numbers only), when the waker settled a handoff or the delivery moved; an open page also reads the card every 5 s while a handoff is on its way (under 3 minutes old).

**What "running" means.** The same inference as the card's "Running" (#4346), nothing stored: a sub task in `claimed` whose assignee is an instance the viewer sees and is working (`runOf`, `instanceStates`). An agent is one continuing session, so *working* says it is busy — with several cards in progress each says "busy with N cards" and none says "running". The state is read from the dashboard's store, which the stream keeps live (`activity`, `status`).

**Working before the claim.** A plan's S-11 had no dependency, so the board told its assignee at once — "assigned to you by test. Read it with: task get S-11" — and its agent read the card and began (twelve tools, six minutes: the whole game in one file) **without calling `task claim`**. The board shows work only on a card in `claimed`, so S-11 stayed "To do", its hand-over row said "dev is working… (this card is not started yet)" and nothing turned: the person had to open the instance to learn it was at work. Three things, none of which moves the card for the agent:
- *The source.* The notice that hands a card over — `assigned`, `ready`, a whole plan — says to claim it first (`task claim S-11`), then start; `task get` of a card that can start says how it starts; the default workflow says to claim before starting on a card. An agent is still free not to; the board never claims for it.
- *The inference* (`runUnclaimed`, fleet-task-run.js): an **open** card that can start (no unmet dependency, none the viewer cannot see) **that the board handed to its assignee** (`handedAt`, below), whose assignee is an instance the viewer sees, **working**, with **no card in progress** and **no other open card it could start**, and that did not **start working before the card was handed over** (as far as this page saw it: `workStartOf`, an idle → working it watched; a page opened on an instance already at work has no start and does not hold that against the card) — then what it is doing is probably this card. An agent that is only chatting is not taken for it: a card the board never told it about (no `handedAt`: assigned before the hand-overs were kept, or its notice held back) is no evidence, and neither is work that began before the hand-over. Its run is `{ instance, state: "working", unclaimed: true }`; `runOf` returns it for the open card and, for a main task that follows its sub tasks, among its sub tasks' (a claimed one first, and while the main task is itself still open). Not with a card in progress (that is its work), not with two open cards (nothing says which), not while the notice is still on its way, failed or withdrawn (`handoffAllows`: the instance has not got it, so its work is not this); a read-only session, which has no record of the notice, gets the inference without that test. `handedAt` is a field of the card view (an open card only, additive, present only with a value): when the board last handed the card to its current assignee — the newest `task_handoffs` row whose instance is the assignee, one statement for a whole board read, and only a time (nothing of the notice's delivery, so any session that reads the board has it). `readyOpenBy(cards)` is the board's second map beside `inProgressBy`, computed from the board read's `cards` — every project's live cards, not filtered by the project or the toolbar and not paged (`boardCards`: the board keeps no page; only finished cards age out, and an instance's open and claimed cards are always in it); the board's one read of the store (`useRunContext`) now also follows the instances that have an open card they could start.
- *Where it shows.* The same running state as a claimed card — the step ("dev · Run python3 … (not claimed yet)"; the state alone without steps, with the permissions above) — on the sub task's row (its title shimmers, with the label "Not claimed yet" beside it), in the main task's "Agent activity", in the handoff row of the activity (in place of where the notice stands: "working… (not started yet)" is gone, a working instance is no longer called working beside a card "not started"), as "Running · not claimed" (dashed edge) beside the status and on the board's tile and row (the tile lights up as for a claimed card), and on the sub task's own page with a line saying it has not claimed the card. After `UNCLAIMED_GRACE_MS` (90 s since the card was handed over, else since it last changed) it is flagged ("still not claimed", the warning colour, and a tooltip: ask it to claim it, or move the card to In progress yourself): a 30 s clock (`CLOCK_MS`) redraws the row while — and only while — a "not claimed yet" label is on the page, so it turns without waiting for the store to change (up to 30 s after the 90 s). When it claims, the line is the plain running line; when it stops without claiming, the notice's own state is all that is said.

**The page** (`fleet-task-flow.js`; `fleet-task-run.js`, `fleet-task-activity.js`, `fleet-task-card.js` call it).
- *What a sub task says* is in its own row (inside the row's button, so the whole row still opens the card) and takes no line of its own. Every state has a sentence (`subLine`'s `text`: the main task's block lists it, and it is the first line of the row's tooltip) and, but for a running one, a short label (`chip`) beside the title: **running** — what the agent is doing, "game-dev · Edit src/game.js", else its state, "game-dev · Running": the row is tinted as a running board row is and its **title shimmers** — a light sweeping over the text in the page's text colour and accent, nothing new in colour, and still (no animation, the tint stays) with `prefers-reduced-motion`; **busy** ("Busy · 2 cards"), **waiting for you**, **looks stuck**, **idle** (the card is in progress, its agent is not working); **blocked** with its reason in the tooltip; **waits for S-1** (a dependency the viewer cannot see is counted, never named); and for an open card that can start: **ready**, then — with the handoff record — **handed to game-dev** → *delivered* → ***read*** → running, or why it did not get there: *offline*, *paused* (the tooltip: it gets this when it is back / resumed), *not sent*, *not sure it arrived*, *not told* (its task board is off, the notice could not be queued, the notice was lost). A handoff to a former assignee is not the baton now. Offline and paused are the page's inference from the instance's state, as under a comment; a read-only session has no record of the notice, so an open card says only "Ready" (tooltip: "Ready — game-dev has not started it yet"). The step is not drawn in the row — the main task's "Agent activity" lists it, and a phone has no tooltip, so the row shows the shimmer and the label only.
- *The step line* is the chat's own activity feed (`observeActivity`, `GET /ui/steps?chat=1`, live by `steps_tick`), held only for the instances that are running a sub task (one feed each, however many rows), and drawn as the chat's activity block draws its live line (`stepLine`, or the backend's phase when no call runs). **Same permissions as #4346**: only an admin session (the server decides; `data-chat-activity`), with the agent's `tool_progress` not `off`, its backend offering steps, and Show activity on in this browser — otherwise the state alone, and nothing is read. `instance_activity` (the statusline's label) is still not used: it is not governed by `tool_progress`.
- *The main task's "Agent activity"* no longer says only "The work is in its sub tasks": it lists up to four lines, the strongest first — running, waiting for you, stuck, busy, blocked, handed on, idle — each with the sub task's number (a button that opens it) and "+N more". What only waits, or is ready with nobody told, is the row's label, not the block's; with nothing going on the block is its one quiet line as before. A sub task's page says where its own hand-over stands in its agent line ("game-dev read it — waiting for it to start", "Waits for S-1").
- *"Running" beside the status* (`tp-idrow`): `runOf` for the card — for a main task, its running sub tasks' (the strongest). The board's tile and row already said it (#4346).
- *The activity* of a main task gains the sub tasks' moves as history lines that name the sub task ("S-2 · changed status from To do to In progress") and each handoff as a row of its own, never folded into "N activities": "S-1 done → handed to game-dev to start S-2" with, under it, where it stands — and, once the card was started, "game-dev started S-2" — or just "S-2 started" when someone other than the instance it was handed to moved it (a person, another instance: the page never says the baton-holder did what it did not). It is in All and History. A session that cannot write has the moves and no handoff row.

**Known limits.** (1) The handoff is recorded when the board decides to tell the instance, not when it hears it: with several sub tasks becoming ready in one write, each has its own row but the waker sends one notice per instance and window — all of them carry the same key. (2) An older card, handed before this release, has no row: its label says "Ready" without the notice's state. (3) "Read" is the CLI's evidence only (#1201); a backend that cannot confirm a read stays at "delivered". (4) The board's tile does not show a failed handoff (the board read carries no handoffs): the card's page does.

## Following a card

**The rule.** The instances that follow a card hear how it moved on, as a `[Task board]` notice (reason `progress`): it was
**finished**, went to **review**, was **sent back**, was **blocked**, or **changed hands**. Nothing else is progress — not a
start, an edit, a log line, a reorder, a cancel or a comment (comments are "Comments and mentions"). The notice carries the
card's number and title, what happened, who did it, the words that came with it (the result, a send-back's or a block's
reason) and why the instance hears it ("you handed it out", "you watch it", "you lead its project"), and says to step in
(comment, reassign, open the next card) only if it needs you. **Why.** A card finished, or blocked by the person, told nobody
(#2801: "a confirmation wakes nobody"), so a project's leader had to be asked, or look, to learn what was done. #4335 asked
 that finishing or progress can wake the instance that coordinates — a project leader — without a
person calling it.

**Who follows** (`TaskBoard.followersOf`), in this order of reason when one instance is several of them:
1. *Its dispatcher*, when it is an instance: the instance that opened it for another one (this reuses the existing
   concept — the creator or assigner — and adds no field). A sub task takes its main task's.
2. *Its watchers*: instances set on the card by the person, by the instance itself or by someone who may edit the card
   (`task watch` / `unwatch`, `POST /ui/tasks/cards/<id>/watchers`); at most 10 per card. A main task's watchers follow its
   sub tasks too.
3. *Its leader*: the lead of its project (`task_projects.lead_instance`, #2352 — until now only the lane for Needs you's
   buttons), else the board's leader, `defaults.task_board.leader` in fleet.yaml, which also leads the cards in no project.

Never: the instance that made the change; the card's assignee (it has its own news); a name that is not a fleet instance, or
an instance with the task board off; a card the `task` tool opened for itself (not on the board). A card the person opened has
no instance dispatcher — nobody hears it was finished unless it has a watcher or a leader. The board's own catch-up (a main task
settling after a release without the board moved its sub tasks) tells nobody.

**Not twice.** A dispatcher's own news outranks it: an instance told `decide` (blocked on a question for it) or `to_confirm`
(a card waiting for its confirmation) is not also told `progress` for the same change. An instance that is dispatcher, watcher
and leader hears once. Everything goes through the same 10 s gather, the delivery outbox and the withdrawals as every other notice (an agent that also
messaged the follower naming the card has not told it in the board's place: the notice goes,).

**Loop guard.** A follower that is also an agent can change the card in answer (send it back, hand it on), which its other
followers hear. Counting the progress changes agents (anything but a person) made on the card within 30 minutes, back to the last
event a person caused on it (`TaskBoard.agentProgressRun`, from the card's own `task_events`: no counter, no column; it reads only
moves, reassignments and a person's events, so an agent's log lines and comments, however many, cannot push changes out of the
count), the followers
are told only while the count is `AGENT_PROGRESS_CHAIN` (6) or fewer; past it the change is kept and tells no follower, and the
writer's answer says so (`progress_chain`), until a person touches the card or the older changes are 30 minutes old. A person's
changes are never limited. The guard holds *followers* only: the assignee's and the dispatcher's own news (sent back, to confirm,
decide) are the board's older rules and are as they were. It is separate from the comment guard (4 turns): each counts its own
kind, so a card cannot be kept awake by alternating them without limit — each is bounded by the person's next touch.

**Said, not refused.** The writer's answer lists who will be told (`progress_wakes`: "lead (dispatcher), ops (leader)"), so an
agent need not message them.

**Watchers** are rows in `task_watchers (task_id, instance, added_by, at)`. Setting them is not a change of the card's content: it
does not bump the card's `version` (a page editing the card is not told it conflicts) but moves the board's revision, and the card's
history says who started or stopped a watch (a `logged` event: `watchers: +ops, -dev-b`, with the names also as `watchers.added` /
`watchers.removed`). It writes no log entry or comment: an entry's text is shown and searched by every reader, and a hidden instance's
name in it would reach a read-only viewer over the public link, while an event is checked value by value and dropped whole when it
names a hidden instance. A person changes anyone's; an instance its own on any board card,
and another's only on a card it may edit (assignee, creator, dispatcher, or an unassigned card). A name must be a fleet instance with
the task board on (an instance that left the fleet can still be removed). The card's detail (`GET /ui/tasks/cards/<id>`) lists them
(`watchers`); over the public link a read-only session does not see hidden instances among them.

**On the page.** A card's page lists them in its property column, under *Project and people* (*Leader*, *Dispatched by*, then *Watchers*;
`fleet-task-follow.js` — `LeaderRow` and `WatchersRow`). *Watchers*: one chip per instance with a ✕, and an Add menu of the fleet's other instances — one with the
task board off is listed greyed with why (the board refuses it), and at ten the menu gives way to the reason; a sub task shows its
main task's watchers as "Also from M-n", read-only, since they follow it too. A write is `POST …/watchers` with no `version` (a watch is
not an edit), then the card and the board are read again; a refusal is the page's toast in its own words (`tasks.err.watcher_unknown`,
`watcher_board_off`, `watchers_max`, `watch_not_board`). *Leader*: the project's lead, else the board's default, with which of the two it
is — read-only (the lead is set on the project, the default in fleet.yaml) — and, when it would hear nothing of this card, why: it has the
card itself, it is not in the fleet, its task board is off, or the fleet's notices are off. The card's read gained three fields for this,
all additive: `leader` (`{ name, via: "project" | "board" }` or null; `TaskBoard.leaderOf`, the lookup `followersOf` uses), `inheritedWatchers`
(a sub task's main task's) and `followsProgress` (`progress_wakes`). Over the public link a hidden instance is named in none of them (a hidden
leader reads as none, as a hidden project lead does, and its hint is the neutral "nobody is named", not a way to set one), and a sub
task whose main task is kept out of sight reads no inherited watchers at all. An older page ignores the new fields; this page reads an older board's card without them.

**Switch.** `defaults.task_board.progress_wakes: false` turns all of this off at once (comments and mentions, and every other
notice, are unchanged). It is on by default, read at each write: #4335 asked for it, and it tells only instances that already
have a reason to follow a card. A project's lead, until now only the Needs you lane, now also hears its project's progress.

**Compatibility.** Wakes are read from a write's events as it commits, never from stored data: opening a database from before this
rule tells nobody anything about old events. The one addition is the `task_watchers` table (`CREATE TABLE IF NOT EXISTS` on open;
a release without it ignores it, and its prune leaves watchers of a pruned card behind, which the next prune here sweeps). No column
changes, and a watch writes only a `logged` event (a release without this shows its `text` as it shows any log line's).

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
  signed-in page; the web's Needs you list links each card to its page.

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

## Cards in the chat

An instance's web chat can refer to a card, and the agent is handed it. Nothing about it is stored: a reference is text.

- **The reference is the card's number in the text.** `#M-3` / `#s3`: a `#`, the letter in either case, an optional hyphen, the
  number — after any character, not inside a longer word, a path, a URL or a decimal. A bare `M-3` is *not* a reference (an
  upstream-style `M-3304` in a sentence must not pull in a card that has that number). `#` is the page's trigger because it does not
  collide with anything the chat already types — `/` is the command palette, and Fleet › Tasks' comment box completes `@` with
  instance names — and it reads as "a card number" as it does elsewhere. The rule is one regular expression in three
  places (`src/chat-task-refs.ts`, `src/ui/chat-task-refs.js`, the renderer `src/ui/shared/chat-render.js`); a test holds them to one
  list of cases. A number in a fenced block, an inline `code` span, the label of a link or a URL is no reference: the server
  reads the text without those (`proseOf`, the renderer's own order) before it looks for numbers, and a test holds the cards
  handed to the agent to exactly the chips the renderer draws, for every case.
- **Typing `#`.** The composer asks `GET /ui/tasks/refs?q=` (`TaskBoard.suggest`: a number's start, then the title; the latest
  changes for nothing typed; hidden instances' cards left out over the public link) and offers the cards in the command palette's own
  list. Choosing puts `#M-3 ` in the draft. A guest has no board and is offered nothing. Where the list opens and what
  goes in are the same function as the comment box's `@` (`src/ui/trigger-complete.js`, the trigger `#`).
- **The chip.** A person's message or an agent's reply (never the Hub's) that names a card is drawn with a chip — number, title, status
  (the board's pill) — linking to `/ui/fleet?card=<number>`. The page asks `GET /ui/tasks/refs?codes=` once per number and again
  after a `tasks` stream event; until the answer arrives, or when the number is no card, the text stays text. Who wrote the
  message does not change what may be shown: the answer leaves out a hidden instance's card over the public link, so an
  agent's `#M-3` for such a card stays the text it was (no title, status or owner reaches the viewer). Only `user` and `agent`
  rows are read; a status line or the activity timeline is not.
- **The agent writes the same number.** An agent points at a card with `#M-3` in its reply, never a URL it builds (a
  `localhost` address does not open from another machine or a phone). It is one sentence, written once
  (`TASK_CARD_REF_HINT`, `src/dashboard-permissions.ts`) and shown wherever the `task` tool is described: the tool's description
  (MCP mode, every runtime), the end of the Task Board commands in `agent-cli-instructions.md` (CLI mode: a slot the prompt fills, dropped
  with the commands when the board is off) and, once, the what's-new notice (an agent already running keeps the description it
  loaded). An agent reads one of the first two, so the steady cost is one sentence; the task-board skill and the workflow
  template do not repeat it (a test pins each surface).
- **The agent.** `POST /ui/send` reads the numbers in the typed text, reads those cards from the board *now*, and puts a block under
  the person's words in the message it delivers (`[Task cards this message refers to]`, a line per card as `task get` writes it,
  and how to read one in full). The last line is in the form *this* instance can use, on every runtime — a native (Windows) agent
  included, which has the `task` tool: `task get M-n (detail: true)` for an MCP instance, `agend-agent task get M-n --detail` for
  `agent_mode: cli`; an instance whose `tool_set` leaves `task` out (`minimal`, in either mode: the CLI is refused the same way) is
  told it has no task tool, so it does not try one it would be refused (`chat-task-refs.ts`'s `taskReadWay`). Not for a guest, a line that starts with `/` (a command for the CLI, `/raw`'s exact paste), an instance
  whose task board is switched off (it is told nothing of the board: only the person's words go), or a card a hidden instance
  holds over the link; a sub task whose main task is hidden there does not name it (`sub task`, not `sub task of M-n`). The chat's own copy, the
  channel echo and the delivery receipt's "what was typed" stay the person's words. A number with no card adds nothing and fails
  nothing. Telegram and Discord messages take another path (`FleetManager`'s inbound handler) and are unchanged.
- **Compatibility.** No column, table or stream field is new; a chat stored by an older version reads as before, and an older AgEnD
  shows `#M-3` as text. The native (Windows) runtime's retry check compares the person's words, so a card that moved between a send
  and its retry is still the same send.

## Next

- **Step 3, rest.** Each instance's board work on its details page (and a list of every instance's on the board).
