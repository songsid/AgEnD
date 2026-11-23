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
(`?done=all`: every done main task, for the Done column's "All"), each project's numbers over all its cards, and is a
handful of statements whatever its size (`views()`, `projectStats()`). A project: its main tasks by status (or as a list), the toolbar's search and filters, drag to move or reorder,
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
  history lines that only repeat a comment or a log entry are dropped from it. No API, schema or column changed.
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
  assignee, priority, size); project and people (project — or a sub task's main task — and dispatched by); flow
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
  no version, as before.
- **The toolbar.** Board | List, search, Filter and Display are one row (`TaskToolbar`). The view, grouping, order and
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
  an instance the dashboard shows. A reply to a particular comment is not offered: a comment has no "replies to" field, and no API or
  stored data changed. The stream starts on the page's left edge, like the sub tasks and the spec above it.
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

A field an action does not take is refused by name and nothing is written (#3195). Projects (#3195, the user's decision
9af8d799): `create_project` (name, description) creates one; `update` with `project` (the project's id, or null /
`"none"`) moves a main task into, between or out of projects when the agent may edit that card (unassigned, its own,
its creation or one it dispatches), its sub tasks following; `move_project` (`ids` + `project`) does that for several,
each card moved or refused on its own with a line per card. Archived projects are refused; a project's lead, renaming
and archiving stay the person's.

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
instance hears what someone else did to a card that is its own, or that it handed out. #2801: only a change of status
or assignee is news, and each change goes to one instance — the one that acts next. A comment and a confirmation wake
nobody (the card lists new comments for its assignee: `mine`, `get`), but for the answer to a busy assignee's blocked
question, kept on the card as a comment (#2303): its assignee is told (answer kept) while the card is still blocked —

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

Never its own write, never a finished card (but for a cancel), never a name that is not one of the
fleet's instances. `TaskBoard.wakeHolds` drops what no longer stands — at the end of the write and again when it goes
out: a card finished meanwhile, no longer the instance's, a question already answered, a card wrapped up meanwhile.
What asks the instance to act holds only while it can (#2303 review): `ready` while the card is open with nothing
left to wait for, `start` and `answered` while it is in progress, `sent back` while it is back with the instance.

**Sending** (`src/task-board-waker.ts`). The fleet gathers an instance's news for 10 s into one `[Task board]` notice:
a line per card, each reason with its own words and who did it; a main task assigned with its sub tasks is one line;
more than three assignments at once (a whole plan) are a count ("You were assigned 6 main tasks (M-11–M-16) and 9 sub
tasks… one at a time, by priority"). The notice is AgEnD's own (`admitSystemNotice`: sender AgEnD, not a person's
words) and the delivery outbox holds it until the instance can take it, across a fleet restart too. News still
gathering when the fleet stops is lost; the card keeps it (`mine`, the comments new to its assignee). Blocked cards
with an instance dispatcher still wait for you on Home, marked as asked first.

- **Told already (#2785 (c), widened by #2801).** News an instance made — an assignment, a block, an answer, a move to
  review — is dropped when that instance messaged the one it concerns naming the card (or, for a sub task, its main
  task) about it: for an assignment from up to 2 minutes before it (a delegate_task often comes first), for anything
  else only from the change on (an earlier message did not tell what came after it). News not yet told that way waits
  up to 2 minutes from the change for such a message (`TOLD_WINDOW_MS`), then goes. A cancel is told at once and never
  folded; a person's change is told without waiting.
- **Superseded (#2801).** A notice's outbox key ends with the cards it names (`:cards=<uuid>,…`). When a write changes
  a card's status or assignee (`BoardChange.changed`), a notice still waiting (queued or retrying, never begun) that
  names it is withdrawn once every card on it has changed since it was admitted (`TaskBoard.lastChangeAt`): `cancelled`,
  "superseded: its card changed again", still readable in `delivery_status` and Fleet traffic. What still concerns the
  instance is told anew from the change. A notice from before #2801 (no cards in its key) is never withdrawn.

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

## Next

- **Step 3, rest.** Each instance's board work on its details page (and a list of every instance's on the board).
