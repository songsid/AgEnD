# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Upgrade Notes
- **[Removed] The `gemini-cli` backend (#1280).** It had been deprecated, and the date its warning named has passed.
  `backend: antigravity` replaces it: the same Google sign-in, through agy. A config that still names `gemini-cli` is
  now refused rather than run, at the instance level, the fleet default, or a ClassicBot channel or default:
  - **`agend validate`** and Settings report it as an error that names the instance and says to set
    `backend: antigravity`. A fleet.yaml reload that still contains it is refused as a whole, with that message.
  - **After `agend update`** the fleet starts as usual. That one instance does not start: its topic gets a notice
    saying why and what to set, and it is not retried. Every other instance comes up normally. AgEnD never swaps in
    another backend by itself: changing which CLI and which account an instance runs on is your call.
  - `/login gemini-cli` and `agend backend doctor gemini-cli` say the same instead of installing or checking it.
    `agend backend trust`, which only pre-trusted Gemini CLI folders, is removed.

### Added
- **How much of a bot-to-bot message is posted in the topics: full, summary or hidden (#1302).** Cross-instance
  messages are posted in the instance topics so people can follow along, and in a busy fleet they bury the
  conversation. `cross_instance_visibility` now sets it: `full` (the default, exactly as before), `summary` (the same
  posts, one line each: who sent it to whom and the task summary or the opening words) or `hidden` (none). Set it for
  the fleet under `defaults`, with the new fleet-admin `/visibility full|summary|hidden` (Telegram General topic and
  Discord, saved to `fleet.yaml`), or in Settings, which also has a per-agent override. Each topic follows its own
  instance; a change applies at once. Delivery, the Mirror Topic and General are not affected in any mode.
- **An alpha channel, separate from beta and stable (#1259).** A `vX.Y.Z-alpha.N` tag now publishes to npm `@alpha`.
  Before, every tag without `-beta` went to `@latest`, so the first 2.2 alpha would have reached every stable user.
  The publish workflow now maps tags strictly: `vX.Y.Z` → `@latest`, `-beta.N` → `@beta`, `-alpha.N` → `@alpha`.
  Any other tag fails before anything is built, and `@latest` never moves backwards. On the client, `agend update`
  (and chat `/update`) keeps an alpha install on `@alpha`. There is a new `agend update --alpha`, and the "update
  available" notice tells an alpha about newer alphas and stables, never about a beta. Beta and stable installs
  behave as before. The old manual `scripts/publish.sh` is removed: a release is a pushed tag.
- **When the soonest rate-limit reset ticket expires, on the ticket line (#1232, #1244).** Codex's "Rate limit resets:
  2 available" now says when the first of those tickets expires — "Rate limit resets: 2 available · 🎫 Nearest expiry:
  10/22 (in 16d 6h)" — in `/usage`, the View usage panel and `get_usage`'s text, read from Codex's own ticket list
  (`expiresAt` on that metric). A ticket without an expiry is skipped, and with none the line shows the count as
  before. It is an expiry, not a reset: an unused ticket is lost. (The per-backend "⏳ Next reset" line that
  2.1.12-beta.2 added under #1232 was a misreading of the request and is gone, `nextResetAt` with it; each window
  still shows its own "resets in".)
- **Agents can send stickers on Discord and Telegram (#1226).** Three tools, the same on both platforms:
  `list_stickers` (`{ id, name, emoji_or_tags, format }` each, no image URLs), `preview_stickers` (up to 8, downloaded
  for the agent to Read; an animated sticker with no still picture is marked `preview_unavailable`), and a new
  `stickers` field on `reply` (up to 3; `text` may then be omitted). Underneath, each platform works its own way:
  Discord lists the stickers of the server the instance's channel is in (a bot cannot send another server's) and sends
  them on the same message as the text; Telegram lists a sticker set — named in the call or set as the connection's
  `options.sticker_sets` — and sends the text first, then each sticker in order. Every sticker is checked before
  anything is sent, so one that cannot be sent is an error, not a reply that silently arrives without it. Also on the
  agent CLI: `agend-agent stickers`, `sticker-preview`, and `reply … --sticker <id>`.
- **Codex capacity detection hardened against glyph changes and scrollback (#1215).** The capacity row must be the
  live transcript item (last item above the composer, nothing newer) both when the "keep going" nudge is armed and
  when it is accepted — a quotation or scrollback line still notifies the user but never injects. The capacity
  pattern no longer accepts box-drawing chrome (`│ …` popup/table rows are `So` too); quota, rate-limit and auth
  patterns share one `CODEX_STATUS_GLYPH` constant so the next glyph change cannot break them the way #1208 broke
  capacity, and occurrence counting is unified into one counter. The nudge now says to continue only if the last
  request is unfinished. Pane stays the capacity authority; the session-store seam stays observation-only.
- **Interrupted turns resume across restarts when the CLI itself stayed idle (#1209).** When a channel turn is
  armed, the daemon writes a one-shot `in-flight-turn.json` marker (with a TurnFingerprint checkpoint); whatever
  survives a restart is, by construction, an interrupted turn. After boot and CLI spawn, a pure gate decides once:
  crash-loop boots stay clean (#835), cancelled turns never resume (cancel deletes the marker, #1199), a delivery
  still owned by the durable outbox is left to that path, and the seam verdict rules out double-driving — CLI
  re-engaged or conversation switched means skip, unknown holds through the flush grace (one bounded wait, then
  deny), and only a quiet seam outside the grace injects one bounded continuation tied to the original correlation
  (never a re-paste). The marker is consumed before gating, so a second boot never repeats; completion paths clear
  it through the reply guard, a delivered reply clears it even before the idle edge, and a resumed continuation
  never re-arms (truly episode-once). A cancel, stop, pause or respawn during the grace hold stales the gate, so
  nothing is injected after the user already stopped it. Backends without a seam reader resolve to unknown and
  never continue.
- **Unified detection-signal seam for cross-restart turn questions (#1209, #1217a, #1210, #1215).** A new read-only
  observation layer (`src/backend/session-signals.ts`): per-backend `TurnFingerprint` readers that discover the
  workspace's session in the CLI's own store — claude-code (newest project transcript plus its newest timestamped
  tail entry; the tail itself is usually timestamp-less bookkeeping), codex (exact-cwd thread from `state_5.sqlite`
  opened read-only plus the rollout tail) and muse (cwd-matched session plus `recorded_at`) — with a
  backend-agnostic `compareFingerprints` checkpoint diff answering `reengaged` / `quiet` / `unknown`. Only a TURN
  counts: turn-kind filtering keeps bookkeeping writes (cost-state tails, token-count frames,
  workspace-branch observations, bare mtime touches) from reading as re-engagement. Daemon-caused writes are
  excluded on both the mtime and the tail path (plus a 2 s tail skew for entry-ts vs flush-mtime reorder), a
  changed session id counts as reengaged, and a 10 s flush grace withholds `quiet` as `unknown` right after the
  daemon's own write (a CLI that re-engaged but has not flushed yet briefly looks quiet). `readinessFromStore`
  always returns `unknown`: the pane stays the idle/busy authority and existing detection is untouched.
  kiro-classic schema coverage is deferred. Reads are synchronous — resolve fingerprints off the fleet event loop,
  never inside a tool handler. Residual, by design and bounded: an engagement that flushes after a compare is
  caught by the next checkpoint compare, never fabricated by this one.
- **A ClassicBot channel can run on a second subscription (#1220).** A channel in `classicBot.yaml` now takes
  `backend_options.<backend>.credential_profile`, as a `fleet.yaml` instance does — e.g. a classic codex bot on
  `credential_profile: personal`. Its agent is launched on that profile, `get_usage` / `/usage` count it under that
  subscription's row (`Codex (personal)`), and `kiro_engine_status` reports it. Before, the key was silently dropped
  and every classic channel was counted on the shared login. An empty or `null` value is the shared login, also over a
  profile inherited from the fleet defaults. A profile name AgEnD cannot use stops that channel's agent from starting
  rather than running it on another login. Only `codex` and `kiro-cli` have profiles; on another backend the profile
  is reported and ignored. Changing it — in `classicBot.yaml` or in the fleet defaults it inherits, on the next poll or
  a reload — restarts that channel's agent: fresh for kiro, whose other subscription holds other conversations, as for
  a fleet instance.

### Changed
- **Docs: the shipped 2.1.10 and 2.1.11 entries have their own CHANGELOG sections (#1295).** They had stayed under
  `[Unreleased]`; each entry now sits under the first release whose tag contains the commit that added it, Upgrade Notes
  included, and `docs/development.md` lists cutting the section as a release step.
- **Docs: the `wiki/` directory is retired; `docs/` is the single source (#1279).** Its still-useful pages were rewritten
  against the current code and moved into `docs/development.md` (Releases and CI, Release notes style) and four new pages
  in `docs/design/` (channel delivery, ClassicBot reply routing, command permissions, memory layering); the rest was
  deleted and stays in git history. Five superseded docs moved to `docs/archive/` with a header saying what replaced them,
  and the status lines of the `docs/design/` notes now match what shipped.
- **`list_emojis` is lighter (#1226).** Server emojis no longer come with image URLs unless `with_image_urls` is set
  (`preview_emojis` shows the ones an agent wants to look at), and `name`, `limit` and `primary_only` narrow the list —
  on a busy server one call used to cost ~10k characters of context for an agent that needed one emoji. The emoji and
  sticker tool calls now get the shared 30 s budget instead of a fixed 10 s, so a preview that downloads several
  pictures is not cut short.

### Fixed
- **A relative `systemPrompt` / `workflow` `file:` path means the instance's working directory (#1314).** It was
  read against the fleet process's current directory: `~/.agend` under the installed service, the shell's directory
  after a manual `agend fleet start`. So one fleet.yaml could load another file, or none, depending on how the fleet
  was started, and a missing file silently dropped the instructions. Now:
  - `~/` and absolute paths are used as given; anything else is relative to the instance's `working_directory`.
  - For one release, a file found only at the old location is still used, with a warning naming both paths and one
    notice in the instance's topic.
  - A file that is missing, unreadable or over 256 KiB is logged with its path and error, never its contents.
  - Config validation warns about a reference that names no file.
  - `systemPrompt` is split on commas only when a part is a `file:` reference: an inline prompt such as "You are Kuro,
    a careful reviewer" stays one paragraph (it used to become two).
- **Settings → Defaults language: no longer pins locale to English on any unrelated save (#1310).** The language `<select>` had no "unset" option, so with `defaults.locale` absent the picker fell to its first choice (en). Any save — even an unrelated one like changing log_level — therefore wrote `locale: en` to fleet.yaml, pinning the UI language and disabling timezone/locale auto-detect. The picker now has an explicit **"Auto (follow system)"** option as the first entry that maps to *unset*. Only changed fields reach the API (`changedFields` against baseline); choosing Auto sends `null` to remove the key.
- **Corrected security, permissions and access documentation (#1275).** Removed the nonexistent IPC secret handshake and generated Bash denylist; documented default permission bypass, persisted access precedence, platform-specific command roles, and the actual dashboard/public View/Host/agent-token boundaries. Documentation only; runtime behavior is unchanged.
- **kiro-cli 2.28.0's "Classic is being deprecated" prompt no longer blocks a legacy instance at launch (#1308).**
  2.28.0 asks before every Classic session, even one launched with AgEnD's pinned `--legacy-ui --agent-engine=v1`:
  "Switch to 3.0 and upgrade my agent configs" or "Remind me later". AgEnD did not recognise it, so the instance sat
  on it. It now answers "Remind me later", moving one verified step off "Switch to 3.0" and pressing Enter only once
  the cursor is seen on "Remind me later". Anything else is held for a human and reported. "Switch to 3.0" is never
  chosen: it makes 3.0 the machine-wide default and reruns the session there, a one-way move. kiro asks again after
  its 7-day snooze. kiro-cli 2.27.x does not show this prompt.
- **Muse session discovery no longer reads whole session logs (#1228).** Finding the workspace's session used to
  `readFileSync` all of every candidate `session.jsonl` before slicing the 64KB head that names the working
  directory — slow when sessions grow long. Both `MuseBackend.getSessionId` and the detection-seam `museFingerprint`
  now go through a shared bounded `readFileHeadSync` (open + stream-decode the first 65,536 characters + close)
  with results identical to the old full read (the bound is decoded characters, not bytes, so multibyte heads
  stay discoverable).
- **Delivery reactions leave agent reactions alone on Telegram (#959).** Status updates now track ownership of the bot's one reaction slot and share a per-message queue with agent reactions. A late status skips when ownership is unknown (including after adapter replacement or an ambiguous API failure), even if the agent chose the same emoji as the old status. General fallback delivery also retains the original chat/thread metadata; Discord topic routing remains unchanged.
- **Corrected `checkout_repo` and `get_usage` tool descriptions (#1296).** The `checkout_repo` description said "read-only worktree" and "instance name or absolute path"; the handler (`daemon.ts`) rejects non-path sources and creates a detached-HEAD worktree, not an enforced read-only mount. The `get_usage` description listed only Claude/Codex/Grok/Kiro; Muse and Antigravity were missing. Both are now accurate. Agents that read tool descriptions to decide how to use them saw wrong information.
- **Config now warns when `context_guardian.max_age_hours` or `grace_period_ms` is set (#1296).** Context rotation was removed; these keys are retained for backwards compatibility but have no effect. Setting either one now produces a validator warning: "no effect; context rotation was removed".
- **A tool step being written when AgEnD starts watching is no longer lost (#1250).** #1221 made AgEnD read a CLI's
  transcript only up to the last complete line. The point it starts from still went to the file's current size. If
  the CLI was half-way through writing an entry at that moment (a first attach, an instance restart, a delivery
  checkpoint), the rest of that entry was skipped as unreadable and its tool progress never showed. Every such
  starting point is now the last complete line, for Claude, Codex and Kiro alike.
- **Kiro outage picker notice is actionable again, interaction IPC is quiet, dead gate removed (#1219).**
  The parked-dialog notice for a generic `dialog` kind (e.g. the Kiro model-unavailable picker) again carries its
  code-owned description — "model unavailable, choose a replacement" — instead of the generic "waiting for your
  input"; specific kinds (permission, login, …) keep their category text. `publishInteraction` no longer re-emits
  and re-broadcasts an unchanged snapshot on every observation (phase/kind/reason/episode/stale/suspected keyed;
  clocks excluded, final state never lost). The unreachable pre-probe `delivery_idle_gate` staleness check is gone;
  the live post-probe fence stays.
- **No more false memory alerts on macOS (#1257).** On a Mac, AgEnD no longer posts the "Host memory pressure"
  notice and no longer slows or holds agent starts for memory. Its free-memory and swap figures are not a pressure
  signal there: macOS adds swap files as it needs them, so a nearly full swap is normal, and a 16 GB Mac with 2.8 GB
  available was being told to start agents one at a time. The samples are still written to the log. Using macOS's own
  memory-pressure level instead is tracked in #1256. Linux is unchanged.
- **`agend-agent reply … --sticker` follows the same rules as the MCP reply (#1254).** For an agent on
  `agent_mode: cli`, a sticker this channel cannot send is checked before anything goes out and comes back as the
  reply's error: another server's sticker on Discord, or something that is not a Telegram sticker id. Before, the
  reply went straight to the adapter. A reply with stickers is also no longer treated as a duplicate of the same text
  sent without them while that one is still in flight. Both paths now build the duplicate check the same way.
- **No more duplicate replies from an early reply-drop recovery (#1241).** On claude-code the reply completion guard
  used to fire on the first idle-looking pane while the agent was still composing its first answer, pasting a
  `[system:reply-required]` prompt the agent later answered a second time. Recovery now waits until the turn proves
  itself over: the first idle edge only arms a 60 s confirmation window (work observed after the edge, a delivered
  reply, or cancel dissolves it), and the prompt goes out only when steady idle persists past the window with no
  reply. An edge with no work observed since the turn armed is held outright. Genuine misses still recover (#750),
  at most a minute later — and the recovery prompt now says to do nothing if the message was already answered.
- **Claude transcript events survive partial writes (#1221).** Tool progress and activity now wait for a record's
  terminating newline before advancing the read offset. A record flushed across polls is read once when complete,
  including after a monitor restart; complete final records still appear immediately. The shared Codex/Kiro JSONL
  tailer uses the same byte boundary, preserving UTF-8 text split across writes.
- **Claude's API retries are seen again (#1239).** While Claude Code retries a failing request
  (`✻ 429 … · Retrying in 4s · attempt 4/10`), AgEnD posts a notice and keeps the turn as running. Since #1101 that
  only worked on screens without a status line. With one, which AgEnD always sets, Claude leaves `esc to interrupt`
  out of the footer, and the check relied on that hint. A live retry therefore read as idle with no notice, and a long
  wait could retire Cancel mid-turn. The row is now told live by where it sits: in the spinner's place, directly above
  the composer. A finished, interrupted or quoted row is still history, and the final rows (`Request rejected (429)`,
  repeated 529, an invalid configured key) are recognised as before. Also, Claude's own Bash permission prompt is
  held again when a long working directory wraps its second option onto two rows.
- **The web login page's sign-in code box is on screen at 100% zoom (#1242).** On a `/login` web terminal the terminal
  sized itself before the "Sign-in code" row appeared and then kept that size: its bottom rows, the CLI's
  `Paste code here` prompt among them, ran under the row and covered it. The box was there, but could not be seen or
  clicked until a zoom change re-fitted the terminal. The terminal now re-fits whenever its own area changes and never
  draws past it, so the prompt and the box are both visible at any window size.
- **Switching an instance's backend no longer leaves it unable to start (#1217).** A session id now belongs to the
  backend that made it (`session-id.backend` next to it). On the first start under a different backend, the old id is
  set aside (`session-id.abandoned-<ts>`, as before) and the new CLI starts fresh, instead of being asked to resume a
  conversation it never had. `update_instance_config` now restarts a running instance, fresh, when its `backend`
  changes. Before, the change was saved and the old CLI kept running until something else restarted it. Three related
  gaps made such a failure permanent, and they are closed too:
  - each backend names the words that prove its session is gone, e.g. muse's "retained session not found";
  - the count of unproven resume failures is kept in the instance directory, keyed by session id. Every start builds
    a new Daemon, so it used to stay at "attempt 1/3" forever and never reached the fresh start after three;
  - Claude's "Background work is running" exit prompt is recognised. Deliveries hold on it, and stop and pause cancel
    it with Escape and stop the process, never choosing one of its options.
- **Discord slash commands: fewer "The application did not respond", and none silent (#1231).** A slash command is
  now acknowledged before anything else is read. When the acknowledgement fails, the command is not run (you were told
  it did not respond, and running it would do it twice on a retry) and you are told so: privately, or in the channel.
  When another session of the same bot already answered it, this one stays silent. An acknowledgement later than 1.5 s
  logs where the time went (delivery vs the acknowledgement itself), the fleet logs every event-loop stall of 1 s or
  more, and the config validator warns when two connections share one bot token. Findings, including what is not a
  cause (presence updates, message volume on its own): `docs/design/1231-discord-slash-ack.md`.
- **Waiting for input is visible (#812).** `describe_instance`, `list_instances`, and status APIs expose a confirmed `awaiting_input` presentation alongside the unchanged execution state and a static interaction category. A second fresh capture confirms a prompt; observations older than 15 seconds are explicitly unverified without releasing safety holds. Claude's captured four-option Bash permission menu is held for a human with no keys sent. Generic terminal hints remain suspected, and editor coverage is not claimed. The 500ms confirmation and 15s freshness values are sandbox-tested policies, not live CLI guarantees.
- **An idle delivery to a Claude / Grok / Muse instance is no longer recorded `delivered` just because the pane printed something (#758).**
  Those CLIs have no readable input row, so an ordinary submission was confirmed by any output after Enter — which a redraw that
  wiped the paste produces too, and the outbox said `delivered` for a message that never arrived. The ✅ is unchanged, but the
  row is now finished by the CLI's own transcript: the delivery's marker found → `delivered` (`transcript-marker`, or
  `transcript-marker-queued` when the CLI holds it queued); the transcript read on the last look for a whole 10 s and the marker
  still absent → `uncertain` (`unverifiable-no-transcript-marker`, so a ⚠️ and a `[system:delivery-outcome]`; nothing is re-pasted,
  the message may still land); transcript unreadable, or a backend with none (Grok, Muse, Gemini, …) → today's `delivered`,
  labelled `output-edge-only; submission-unverifiable`. The wait runs after the pane lock is released, but the fleet lane and
  the shared pump budget stay held until the verdict (successes settle in about a second; a lost paste holds its lane for the
  bounded ~10 s window). Steer, native-queue, Codex, Kiro and raw pastes are untouched.
- **Instance logs no longer read the whole file into memory (#1206).** `get_instance_logs` read `output.log` synchronously in
  full before tailing it, so a multi-MB pipe-pane log blocked the event loop and could blow the 30 s IPC budget. It now reads
  backwards from the end in bounded chunks (at most 1 MB scanned, async), so I/O stays flat no matter how large the log grows.
  Logs that fit the bound keep an exact line count; larger ones return the tail with the count marked unknown and a note saying
  so. A tail with no line break in the scanned window returns its last segment flagged partial instead of an empty answer.
  A failed pipe-pane attach at startup now warns instead of vanishing silently.

## [2.1.11] - 2026-10-05

### Upgrade Notes
- **[Behaviour change] A Codex "model is at capacity" error is now answered with "keep going", not a restart (#905).**
  The old retry restarted the instance after 30 / 60 / 120 s, but a restarted Codex resumes at an empty prompt and
  nothing re-sent the failed turn, so the "retrying" notice promised something that never happened and the work sat
  there. Now the user is told (as before), and about a minute later AgEnD tells the agent "keep going" (繼續) — its
  context is still live, nothing is re-read, the model is not changed. Once per capacity error, and only into a screen
  that has not changed since: if the pane moved on, a person typed, the agent started working, a message is queued,
  the instance was stopped / paused / respawned or the user cancelled, the nudge is dropped. It is timed on the
  monotonic clock (a wall-clock step changes nothing). A second capacity error right after the nudge is a new episode.
  Up to 3 nudges are sent per 30 minutes; the next capacity error after that pauses the instance, as before.
- **[Behaviour change] `agend update` keeps an install on its channel; a beta is never moved to the stable line
  without asking.** With no flag, `agend update` used to install `@latest` whatever was installed, so on a beta it
  could go back to an older stable — and AgEnD's own notice told beta users to run exactly that. It now follows
  the installed version: a prerelease (`x.y.z-beta.N`, or any `x.y.z-<pre>`) updates from `@beta`, a release from
  `@latest`. `/update` in chat no longer decides this itself (it read the version next to its own code, which a
  source checkout reports as `1.22.0`, and sent `--beta` only when that contained "beta"): it runs a plain
  `agend update`, and the installed CLI decides. An update that would go back to an older version is refused
  unless `--stable`, `--version` or `--force` asks for it. New: `agend update --stable` switches a beta install to
  the stable release. A beta user told that a newer stable is out is now told to use `--stable`. The update
  installs exactly the version it checked (`@songsid/agend@2.1.11-beta.3`, not the `@beta` tag, which can move in
  between), and `agend update --version <v>` now works — it used to be read as `agend --version`, print the
  version and install nothing.
- **[Behaviour change] OpenCode instances now start without permission prompts, like every other backend.**
  OpenCode asks before it reads a path outside the project (`Access external directory /tmp`), reads a `.env`, or
  does what your own config marks `ask`; every other backend AgEnD runs already had its skip-permissions switch,
  so an OpenCode instance that opened `/tmp/image.jpg` sat on the prompt until a human answered. AgEnD now
  launches OpenCode with `--auto` (it answers every ask "once"; **an explicit `deny` in your config still
  denies**) when the binary's own `--help` lists it (OpenCode 1.17 and newer). An older OpenCode gets no launch
  switch at all — its only form, the `OPENCODE_PERMISSION` env, would override your own `deny` rules — so its
  prompts are answered at runtime instead. **A prompt that is on screen is answered with "Allow once"** (one
  Enter, nothing remembered); AgEnD used to press Right+Enter, i.e. "Allow always". If it got as far as the
  "Always allow" confirmation, Escape cancels back to the prompt. While a prompt is on screen the pane takes
  no delivery and is not treated as stuck, and agent text, a composer draft or a transcript that merely quotes
  the prompt no longer receives a key. `skipPermissions: false` turns the launch switch off (and the runtime
  answer stays on). A stop that arrives while a launch is being prepared now cancels that launch.
- **[Behaviour change] The legacy chat-relay `/login` mode is removed (#1139).** `login.mode: relay` was the
  pre-2.1.6 way to sign in (AgEnD drove the login CLI in a tmux window and relayed its menus, authorization URL
  and text prompts through chat); `/login` has run in the token-gated browser terminal by default since 2.1.5
  and `/login code` has had no entry point since #1137. **A fleet.yaml that still sets `login.mode: relay` keeps
  loading** — the setting is ignored, with one warning in the log; remove it. Nothing else changes for `/login`
  (web terminal, device-code, public link) or for installing a CLI. A provider-picker button from before the
  upgrade now answers "expired" when tapped.

### Added
- **A CLI dialog that ignores AgEnD's answer is now reported within about 15 seconds, for every backend.** AgEnD
  answers a runtime dialog (a permission prompt, a trust prompt, a picker) by pressing its keys; when the SAME
  dialog — the very same request, character for character (OpenCode names the request from its prompt block, so a
  ticking status line around it does not matter; other CLIs are compared whole-screen) — is still up right after
  the keys, three answers in a row, the instance's topic and the fleet are
  told once ("not taking AgEnD's answer… answer it by hand", with a note when deliveries are held). Before, a
  dialog that held deliveries was reported only after a minute, and one that did not (kiro trust, muse/grok tool
  approval, agy survey) was never reported and was simply re-answered every 5 s forever. The notice names the
  dialog by its fixed description and a count, never anything from the pane, and is sent once per episode (again
  only after the dialog went away and a new one ignores the answer). A prompt that was answered and replaced by a
  fresh one (a burst of tool prompts, or the next queued request of a different target) is not "stuck", and now also
  restarts the one-minute parked clock instead of inheriting it. Limits: two requests that look exactly alike, one
  right after the other, cannot be told apart from the screen and read as an ignored answer; and a screen that
  changes by itself where the CLI cannot name the request (a ticking timer) is never proof either way: it is not
  reported by this check, and the one-minute "parked" report of a dialog that holds deliveries keeps running as
  before (only a dialog that is gone, or a request the CLI positively names as different, restarts that clock).
  After the report AgEnD does not stop answering: it answers the SAME request only every 30 seconds instead of every 5
  (queued requests that merely look alike each still get their answer, just slowly — a truly ignored dialog is pressed
  far less), and a different request, the dialog going away, or a respawn restores the normal pace with a fresh count.
- **General hears when kiro-cli can no longer run a kiro instance.** When the installed kiro-cli refuses a kiro
  instance as configured (#1109) — at start, or at a respawn after kiro-cli replaced itself — every General now
  also gets `[system:kiro-incompat]` as an agent: which instances stopped, kiro's reason, that their
  conversations are intact, and to load the new `kiro-engine-migration` skill. ClassicBot kiro instances count
  too. It is held in the delivery outbox for up to 14 days until each General takes it (the same kiro-cli may
  have stopped General too; ordinary deliveries keep their 24 hours), and sent once per day per refusal. The
  operator's plain notice is unchanged.
- **`kiro_engine_status` tool** (read-only; worker, standard and general profiles): each kiro instance's
  (ClassicBot ones included) `kiro_ui` and credential profile, the engine flags its next launch would use or
  kiro's reason for refusing it, its prepared launches (kiro-cli and AgEnD version per change, from the engine
  ledger) and its V3 session. It runs no process: it reads the kiro-cli compatibility the last kiro launch
  probed, and says when that was.
- **`kiro-engine-migration` skill for General:** what a kiro incompatibility means, that a stopped instance's
  conversation is intact, what to tell the user, and what never to do (restart it to "try again", change
  `kiro_ui`, run kiro-cli, touch `~/.kiro`). The migration itself is not available yet, and the skill says so.
- **A kiro engine ledger, the baseline for the coming V1 → V3 move.** Every kiro launch is recorded in
  `<data dir>/kiro-engine-ledger.json` (owner-only): the instance's working directory and credential profile,
  the kiro-cli version, the AgEnD version, the UI and the engine flags AgEnD pinned — the last launch plus one
  history row per change. It sits outside the instance directory so `replace_instance` does not erase it. It
  never stops a launch: a ledger that cannot be written is skipped.
- **A V3 kiro instance resumes only the V3 session it owns, by id.** kiro's `--resume` on V3 takes the
  newest conversation in the directory from any engine and converts a classic one into a new V3 copy on every
  launch. A V3 instance now starts fresh, and its next launch takes up the session that fresh launch made —
  only when that is certain: created after the fresh start, owned by nobody (ownership is an exclusive claim
  under `<data dir>/kiro-v3/`), and with no other V3 instance in the same directory waiting for its own. After
  that it resumes that session by id while its claim is held; a skipped resume gives it up. A fresh start
  is recorded before the launch, and one that cannot be recorded refuses the launch rather than risk resuming
  the session it gave up later. Anything less certain starts fresh again,
  so two V3 instances sharing a working directory each start fresh. A classic conversation reaches V3 only
  through an explicit migration. `kiro_ui: v3` itself is still refused by validation until V3 runs unattended
  (#849).

### Fixed
- **Cancel stops reply recovery too (#1199).** The cancel button and `/cancel` now mark the current human turn before interrupting the CLI, so an intentional stop no longer triggers the missing-reply warning or asks the agent to produce another conclusion. Replies already being delivered still settle normally; new messages retain their own reply guard. A cancelled recovery's late failure and a cancelled paste's late success cannot restart that turn.
- **A restart no longer re-sends a Claude Code message that was already delivered (#1205).** After a restart the daemon looks for
  each in-flight delivery's marker in the CLI's transcript, and only a marker at the very start of a user entry counted. Claude Code
  stores every pasted message as `<pasted_content id="…">` + the text, so the marker was never at the start and was never found:
  a delivered message looked like "complete transcript, no marker" and, with the old CLI gone, was retried — the same message
  delivered twice. The CLI's own wrapper, in exactly that shape and for Claude Code only, is now accepted in front of the marker,
  which must still lead the body inside it; any other prefix, a quote, or another backend's entry still does not count.
- **Codex's "Selected model is at capacity" is detected on 0.159.2 and 0.160.0 again (#1208).** Those versions print the rejection as
  `■ Selected model is at capacity. Please try a different model.`, but the detector was written against `⚠`, so the capacity notice never
  came, the "keep going" nudge never armed, and the turn just ended in the generic missing-reply path. Any one status symbol (`■`, `⚠`,
  `⚠️`, …) may now open the line; a bullet, dash, quote marker or number still may not, and the sentence must still be the whole line
  from column 0, so prose that mentions model capacity triggers nothing. Detection only — what happens after a match is unchanged.
- **Telegram ClassicBot's `/start` reply says to @mention the bot (#1196).** "Agent started" and "already has an active
  agent" led with `/chat`, the Discord way; on Telegram you talk to a ClassicBot by @mentioning it, and the reply now
  says so. Discord's replies are unchanged, and so is what reaches the agent.
- **A steer into a busy Claude / Grok / Muse instance is `delivered`, not `uncertain` (#1197).** Those CLIs have no readable input
  row, and the idle→busy edge that proves an ordinary submission cannot exist in a pane that is already busy, so every durable
  steer used to end `uncertain` — a ⚠️ for the operator and a `[system:delivery-outcome]` for the sender, for a steer that had
  landed (it was not an IPC timeout: `send_to_instance` returns at once and nothing waits). Now a steer whose own trusted
  `message_id` is on the pane after its successful Enter — more often than before the paste, no dialog, same spawn and window — is
  `delivered`, with the evidence `steer-accepted-marker-on-pane; input-row-unreadable`: accepted into the live turn's input,
  not proof the model has read it (`delivery_status` already shows `delivery_mode: steer`). Anything less stays `uncertain`.
  Also: the steer banner now follows the delivery marker instead of preceding it, so a steer can be proved from the CLI
  transcript after a restart.
- **A Codex turn that runs long with nothing new on screen is no longer declared stuck (#1188).** The live status row's
  own elapsed counter (`• Working (5m 51s • esc to interrupt)`) now counts as proof of life: a counter that moved since
  the last look keeps the turn "working", however long the rest of the pane stayed the same. Before, the 10-minute
  stuck check stamped "the pane changed" with the time of the last output event — minutes old — so a healthy long turn
  was flagged (hang notice, then a restart attempt that "timed out" while the original process kept running). A pane
  whose counter stands still for the stuck timeout is still declared stuck. Also: the daemon's "last change" time never
  moves backwards, and the stuck deadline follows the latest sign of life instead of re-firing at once.
- **The #978 idle escape hatch no longer treats a quoted "esc to interrupt" as a running turn (#991).** It now uses the
  same precise live-status-row match as the rest of the daemon (any title, whole row, column zero): a real status row
  still blocks it, an indented quote or a prose mention in a reply does not.
- **Crash-loop recovery now honours the request to start without resuming (#835).**
  The daemon reads recovery intent before clearing it; failed or superseded starts
  that never reach the reader preserve it. Normal starts keep resuming as before.
- **A Codex footer with the native `Goal achieved (…)` status is recognised again (#1190).** Codex 0.159.2 paints its Goal
  status between the context item and the warnings (`Context 32% left    Goal achieved (1h 6m)    ⚠ 1 warning · f2 to
  view`); the "Context first" footer grammar had no place for it, so the idle composer could not be proved, stranded-input
  recovery ran out and deliveries to that instance failed (`Idle footer not recognised` / `retries exhausted`). Anything
  after the context item that is set apart by a column gap is now footer chrome, whatever Codex calls it or in whatever
  language (`Goal achieved (1h 6m)`, `Goal usage: 90 seconds.`, `Goal complete; time used: 90 seconds.`, `Goal 사용량: 45초.`,
  a field it has not shipped yet), and a Goal field is recognised even set off by a single space — no `session-id`
  status item needed. The same rule applies to a `tui.status_line` you configured (`model · Context 46% left    Goal …`),
  and its readiness pattern is built from the same grammar. A draft or a transcript line
  that merely starts with "Context 32% left" is still not a footer.
- **muse: a message after a cancel is no longer glued to the cancelled one (#829).** Cancelling a muse turn puts the
  interrupted prompt back into muse's input box, and the next delivery was pasted after it, so both were sent as one
  message and the cancelled work ran again. Before pasting, AgEnD now reads muse's input box and empties it with
  muse's own delete keys, one line at a time, checking the screen after each. It clears only a draft that is exactly
  one of AgEnD's own recent pastes to that same CLI process, drawn the way muse wraps it; looking like an AgEnD message
  is not enough, and a collapsed `[Pasted Content N chars]` (whose content cannot be seen) is never cleared. Anything
  else is left alone and stops the clearing, and so does a box that will not empty or a screen that cannot be read:
  the delivery fails and can be retried, and nothing is pasted onto the text. A stop, cancel or respawn while it clears ends the attempt with nothing sent. Other backends send no
  extra keys.
- **macOS no longer mistakes low free RAM for memory pressure.** Native, bounded async
  `vm_stat`/`sysctl` probes estimate reclaimable RAM and read swap; first/stale starts
  wait at most two seconds, with a 30-second shared cache. Unavailable Mac measurements
  now show unknown and neither warn nor slow starts; Linux behaviour is unchanged.
  The estimate can undercount reclaimable RAM, and failed Mac probes temporarily leave
  memory-pressure protection unavailable. Fixture-tested on Linux; live macOS user validation
  is pending. The native-probe commit can be reverted while keeping the unknown policy.
- **The `/login` browser terminal no longer kills the sign-in when you copy, and shows where the code goes.** Pressing
  Ctrl+C to copy the link sent an interrupt that ended `claude auth login` (exit 130); the paste and Enter that followed hit a
  dead session. Now Ctrl+C with text selected copies in every web terminal, and on the login page a Ctrl+C with nothing
  selected (and the Ctrl-C button) is off — Stop still cancels; the installer terminal keeps its Ctrl+C. The CLI echoes
  nothing of the code you paste, so it looked as if nothing had happened: the login page now has a code box that sends the
  code and Enter once and says so (the code is never logged). A code the server refuses ends the command; the page now
  says the code was rejected (expired, already used, pasted twice, or from another attempt) and to start `/login` again,
  instead of "exited with code 1".

### Security
- **Discord slash commands now follow one command table (#1148).** Where a command applies and who may use it is
  declared in one place (`src/command-table.ts`) instead of in two copied handlers; the 🔒 in a command's menu
  description is generated from it, so the label can no longer disagree with the rule. It sits behind the
  authorization door added earlier and can only narrow what the door allowed. The levels are *anyone*,
  *channel admin* (in a fleet channel a fleet admin; in a ClassicBot channel a fleet admin **or** a ClassicBot
  admin), *fleet admin* and *ClassicBot admin*. Behaviour changes:
  - **`/stop`** in a ClassicBot channel needs a ClassicBot admin on Discord, as it always did on Telegram. On Discord it
    was open to everyone; a fleet admin who is not also a ClassicBot admin can no longer stop a ClassicBot channel
    there, and never could on Telegram.
  - **`/compact`** on Discord needs a channel admin (it was labelled 🔒 but had no check on Discord). Telegram is not
    changed by this: it still needs a ClassicBot admin in a ClassicBot chat, and has no check in a fleet topic.
  - **`/save`** needs the admin of the channel's own kind (it asked for a ClassicBot admin even in fleet channels,
    so a fleet admin was refused there and a ClassicBot admin could paste into a fleet instance).
  - **`/pause`, `/wake` and `/collab`** in a ClassicBot channel now also accept a fleet admin on Discord (they accepted
    only a ClassicBot admin). Telegram is not changed: its ClassicBot `/pause` and `/wake` still need a ClassicBot admin.
  - **`/start`** is not changed on either platform, and the table now says so instead of "anyone": Discord checks the
    guild allowlist and nothing else; Telegram checks the user allowlist in a private chat, and the group allowlist
    **and** a ClassicBot admin in a group. The table marks it as decided by its handler.
  - The table has a Telegram column for the cells where Telegram's handlers differ from Discord's, and a test
    (`tests/command-gates-by-platform.test.ts`) drives the real Telegram handlers against it.
  - **`/stop` and `/dashboard` now show the 🔒** they always deserved; `/model`, `/effort`, `/clear` and the
    admin-only commands are unchanged for everyone who could use them.
  - A command that does not apply where it was typed (for example `/ctx` in a channel with no agent) is refused with
    one line saying so, before anything runs; a command that is no longer registered gets an answer instead of
    "the application did not respond".
  Typed `/commands` (as opposed to slash commands) are covered by a follow-up change.
- **Discord slash commands now go through an authorization door (#1148).** AgEnD registers its slash commands
  globally, so every guild the bot is in — and every DM with it — shows the same menu, and the lock emoji in a
  description is only a label. Until now a slash command skipped the allowlist that guards the same words typed
  as a message and never looked at which guild or DM it came from (only `/start` did): anyone who shared any
  server with the bot could `/steer`, `/compact` or `/cancel` a fleet instance or read `/sysinfo`. Now, before
  any command runs: a **DM is refused**; a command from **another guild** is honoured only for a registered
  ClassicBot channel or `/start` (which still checks `allowed_guilds`); and in a fleet channel the caller must be
  someone the **typed-message path would also hear** — the access policy of the adapter that owns the channel's
  instance (an explicit fleet admin always speaks). ClassicBot channels stay open to everyone, as before.
- **`/update`, `/doctor`, `/dashboard` and `/collab` (in a fleet channel) now require a fleet admin of the adapter
  the command came through, and an empty `allowed_users` means nobody.** They used to read the *primary* channel's
  list (`channels[0]`, not the adapter in use) and, for `/update`, `/doctor` and `/collab`, treat an empty list as
  "everyone" — so on a fleet without one, anyone able to type a slash command could run `agend update` on the
  host — while the typed `/update` treated empty as "disabled". Slash and typed now agree. **If you rely on these
  commands, list yourself under that adapter's `access.allowed_users`.**

## [2.1.10] - 2026-10-03

### Upgrade Notes
- **[Behaviour change] One tap for a public `/login` link — AgEnD gets cloudflared itself (#1137).**
  The kiro-cli and claude-code login confirmation now offers **I understand (temporary public link)**,
  **I understand (local network)** and **Cancel** without any configuration: `web_terminal.tunnel.allow_public`
  no longer has to be set, and `allow_public: false` is now the host's switch to turn public links off
  (no button, nothing downloaded). Pressing the public button is still the consent, every login, and the
  consent now warns that anyone with the link and its token can use that login terminal until it ends.
  If no `cloudflared` is on `PATH`, AgEnD downloads Cloudflare's official build into
  `~/.agend/bin` (no sudo, never system-wide): a pinned version, checked against a pinned SHA256 and
  re-checked before every use; a mismatch is deleted and nothing runs. Linux (x86-64, arm64, arm, x86) and
  macOS are covered. If cloudflared cannot be obtained, nothing is opened and the local link is still
  there. Everything else about the public link is unchanged: two private messages for the link and the
  token, fail-closed, a time limit, never logged. Discord and Telegram alike.
- **[Behaviour change] `/install-cli` is gone: `/login` installs a missing CLI, then signs in (#1131).**
  One command for "make this CLI work", so a guild with several AgEnD bots shows one entry per bot
  and there is nothing to mistype (`/install`, `/login-cli`). `/login`'s picker lists every backend
  the fleet can install or sign in to, each labelled with what a click does: an installed CLI signs
  in; a missing one is installed (its official script, verified on PATH) and signing in follows by
  itself. `/login <backend>` does the same, and `/login cancel` also stops an install — those are
  the only forms (`/login code` and a short-lived `reinstall` are gone, #1137). `opencode` and
  `muse` install but have no sign-in flow; `/login gemini-cli` still installs Gemini CLI, which the
  picker does not offer. The Discord slash command and the Telegram menu entry `/install_cli` are
  removed. Typing `/install-cli` (or `/install_cli`) still works in 2.1.10 — it says where the
  command went and runs `/login <backend>` — and will be removed in 2.1.11.
- **[Behaviour change] grok signs in with a code in the chat; claude-code can use the public link (#1137).**
  `grok login` is a device-code sign-in (grok 1.0.46 shows a URL and a code, then only waits), so
  `/login grok` now posts the URL and code in the chat, like codex, instead of opening a browser
  terminal. Its sign-in is also recognised again on grok 1.0.46, which reports "Signed in as …".
  claude-code's sign-in pastes a code back into its terminal, so finishing it from a phone needs
  that terminal: the public link (`web_terminal.tunnel.allow_public`) is now offered for
  claude-code as well as kiro-cli.
- **[Behaviour change] A paused instance now wakes by itself when another instance sends it work
  (#1129).** `delivery_worker` defaults to `wake_only` instead of `off`. Under `off`, a task delegated
  to an instance that had been paused across a fleet restart waited until someone ran `/wake`, with
  no sign it was stuck. Now the wake coordinator wakes it the way `/wake` does: backoff on failure,
  a notice after three failures in a row, and never for an instance paused because its login failed.
  With `warm_cap` set, waking for queued work may exceed the cap by `warm_overflow` (default 2), and
  a `/wake` or message to a paused instance is refused, instead of going over the cap, when the cap
  and overflow are full and no idle instance can be paused. An explicit `delivery_worker: off`
  keeps the old behaviour.
- **[Behaviour change] Crash dumps stay small, and systemd stops restarting a fleet that keeps
  failing (#1113).** On WSL every crash is piped to the WSL crash collector, which ignores
  `LimitCORE`, so kiro-cli and the fleet itself left core dumps of about 1 GB and 450 MB in
  `%TEMP%\wsl-crashes`. The systemd unit now sets `CoredumpFilter=0`, so a dump is a few KB;
  the setting is inherited by the tmux server and every CLI the fleet starts. `LimitCORE=0`
  covers systems that write core files directly. `TimeoutStartSec` goes from unlimited to
  15 minutes. `StartLimitIntervalSec=30min` and `StartLimitBurst=4` stop systemd from
  restarting a fleet that has failed four times in 30 minutes; before, a start took minutes,
  so the old 5-in-10-seconds limit never tripped, and under host memory exhaustion the
  watchdog killed and systemd restarted the fleet indefinitely. **A plain
  `systemctl --user restart com.agend.fleet` counts toward that limit; `agend restart` runs
  `reset-failed` first and is not affected.** `agend restart` (which `agend update` runs)
  adds these to an older unit, reloads systemd and checks that `CoredumpFilter=0` was
  loaded, refusing to restart otherwise — except on systemd older than 246, which does not
  know the setting and only gets a warning. Values you set yourself are left alone.
- **[Behaviour change] kiro instances are pinned to their engine on every launch, and
  refused rather than moved when that is impossible (#1109).** kiro-cli 3.0 (October
  2026) deprecates the classic UI and may default to its V3 engine; kiro also offers a
  "switch to 3.0" prompt whose answer is saved for the whole machine. An instance's
  conversation lives in its engine's store, and moving between engines forks it one
  way. AgEnD now launches `kiro_ui: legacy` as `--legacy-ui --agent-engine=v1` and
  `kiro_ui: tui` as `--tui --agent-engine=v2` (flags outrank saved settings), reading
  what each kiro-cli accepts from its version — or, for anything newer than 2.27, from
  its own `chat --help` (2.3's `--agent-engine` took `rust|kas`, so it gets
  `--legacy-ui` alone). A kiro-cli that can no longer run an instance on its engine is
  not started: one notice says why, and there is no automatic retry; a kiro-cli
  replaced under a running instance is caught at its next respawn. A missing selector
  in `--help` is never taken as proof of an old binary. The "switch to 3.0" and
  "upgrade your agent configs" launch prompts are answered with the choice that changes
  nothing, one key at a time and only on a cursor AgEnD has seen there; any other state
  of them (an unrecognised cursor, "Don't ask again", a key that did not move it) is
  held for a human with deliveries blocked. kiro-cli older than 2.21 or newer than 2.27
  gets a one-time notice; it still starts.
- **[Behaviour change] One broken MCP server no longer stops every kiro instance (#1111).**
  AgEnD launched kiro-cli with `--require-mcp-startup`, which exits (code 3) when ANY
  enabled MCP server fails to start. That includes the servers you configured yourself
  in `~/.kiro/settings/mcp.json`, so a third-party server that broke on kiro-cli 2.27
  kept every kiro instance from starting. kiro now starts like claude and codex do: a
  failing server of yours only loses its own tools (kiro shows it as `✗` in the pane).
  Whether AgEnD's own fleet server connected is checked by the daemon instead, for every
  backend: if a CLI has been up for 90 seconds and AgEnD's MCP server never connected,
  the instance reports that it has no agend tools and, with `mcp_auto_restart` (the
  default), restarts once idle to retry. A server that connects late retracts the report.
- **[Behaviour change] Tunnels reach Cloudflare over http2 and wait up to a minute.** The cloudflared provider now
  passes `--protocol http2` by default (QUIC/UDP 7844 is blocked on many corporate networks and VMs, where cloudflared
  otherwise spends a long time failing over or never connects) and probes readiness through Cloudflare's public
  resolvers (1.1.1.1 / 1.0.0.1) with the system resolver as fallback; the startup budget goes from 30 s to 60 s. This
  applies to `agend setup --tunnel` too. Set `web_terminal.tunnel.protocol: quic` (or `auto`) to keep cloudflared's own
  choice for the login tunnel.
- **[Behaviour change] The `/login` browser terminal applies the same `Host` rule.** Each
  `/login` opens a short-lived listener of its own. It checked that
  `Origin` equals `Host` — which a DNS-rebinding page satisfies by construction — and
  answered to any `Host`. It now refuses, with the same 403 on every path and on the
  WebSocket upgrade, any name that is not `localhost`/`127.0.0.1`/`[::1]`, the fleet
  `hostname:` or a `web.allowed_hosts` entry (the setting the dashboard already uses).
  **If you open the terminal link through a reverse proxy or a LAN address, add that
  name to `web.allowed_hosts`.** The listener can also be told one more exact name, and
  to set its cookie `Secure` from that name rather than from `X-Forwarded-Proto`; nothing
  uses that yet (it is the groundwork for exposing a login terminal through a tunnel).
- **[Behaviour change] The dashboard now refuses requests whose `Host` is not a
  name it knows.** The health/dashboard server listens on 127.0.0.1, but that does
  not stop DNS rebinding: a web page can point its own domain at 127.0.0.1 and
  read, from script, the routes that need no cookie — including `/view`'s live
  terminal capture (`/api/pane/*`). The one thing such a page cannot change is
  the `Host` the browser sends, so every route (`/health` and `/agent` included)
  now answers 403 unless `Host` is `localhost`, `127.0.0.1`, `[::1]`, your fleet
  `hostname:`, or a name listed in the new `web.allowed_hosts`. The port is not
  compared. **If you reach the dashboard through a reverse proxy or a port
  forward that presents another name, add that name to `web.allowed_hosts`**;
  the first refusal of each name is logged in `fleet.log` with that hint. The
  CLI, `agend web`, `/dashboard` and every internal caller use loopback names and
  are unaffected.

### Added
- **`/login` says which fleet it belongs to.** Every AgEnD bot in a Discord guild registers its own
  `/login`, so the slash menu listed identical commands and a picker could come from another fleet
  than the one you meant. Its description now ends with the fleet's label, and the backend picker
  shows `🖥 Fleet: <label>`. The label is `fleet_label` in fleet.yaml, by default
  the host name (plus the AgEnD home's name when it is not `~/.agend`).
- **Finish a `kiro-cli` `/login` from your phone: optional public link
  (`web_terminal.tunnel.allow_public`, default off).** When enabled, the login confirmation offers
  **Open public link** beside **Local link only**; the press is the consent, per login. A Cloudflare Quick
  Tunnel fronts only that login's terminal; the public link and the access token go to the requester as two
  private messages (never the channel); a failed delivery, a failed or lost tunnel, a cancel, a timeout or a
  shutdown all close the tunnel before the next login can start, and a tunnel that cannot be confirmed
  stopped is announced and blocks further tunnels. The tunnel's public name is never logged. Needs
  `cloudflared` on `PATH`. See "Finishing a /login away from the machine" in `docs/configuration.md`.

### Fixed
- **A rejected Discord slash command registration is reported (#1131).** It was swallowed without a
  log line, and Discord keeps the previous command list when it rejects one, so a new or changed
  command could silently never appear. The fleet now logs every registration (the command
  count, or Discord's error code and message) and tells General once when Discord rejects it.
- **Button prompts never fail silently (#1133).** On Discord, a backend chooser with more than five
  backends could not be posted at all: Discord allows five buttons to a row, and all of them were
  in one. Buttons are now laid out in rows of five. A chooser or confirmation that cannot be posted
  now says so instead of reporting "chooser posted" or stopping at "Starting…". A click that cannot
  act — the prompt expired, it is not your prompt, or you are not a fleet admin — now tells you why,
  privately (an ephemeral message on Discord, the button's answer on Telegram). Telegram answers a
  click once the fleet has decided, so a failed answer no longer loses the click. When an outcome
  cannot be written into the prompt it is posted as a message, and a click nothing handles is
  logged.
- **Discord: the `/login` backend buttons respond to clicks (#1131).** A picker posted by
  the native slash command was bound to the channel, while Discord reports every button click by
  guild and channel, so each click was rejected as a mismatch and nothing happened. Buttons now carry
  the same address their clicks report. A picker posted in a channel outside the bot's main server
  (slash commands are accepted there) is now clickable too; any other button from such a channel is
  still ignored, and is logged instead of dropped silently. Slash replies also use `flags` instead of
  discord.js's deprecated `ephemeral` option, and the client listens for `clientReady`.
- **`agend update` / `/update` to 2.1.10-beta.2 failed with "fleet restart failed" on systemd hosts,
  and left the old fleet running (#1113 hotfix).** systemd 249 silently ignores `CoredumpFilter=`
  in a unit file, so beta.2's check that systemd had loaded `CoredumpFilter=0` refused every
  `agend restart`. The check is gone (a loaded value other than 0 is only reported). On Linux the
  fleet now sets its own `/proc/self/coredump_filter` to 0 at startup, and every CLI launch sets it
  in the pane's shell first — so crash dumps stay a few KB on any systemd, including in a tmux
  server the fleet did not start. `AGEND_KEEP_COREDUMP_FILTER=1` turns this off (processes keep the
  mask they inherit, which is not necessarily a full dump). `agend update` also restarts a fleet
  that started before the installed version instead of reporting "already up to date" — only a
  process confirmed by its command line to be the fleet; a stale `fleet.pid` naming any other
  process is never restarted or signalled — so a fleet left behind by a failed restart catches up.
- **A fleet started with a throwaway `HOME` no longer joins the real fleet's tmux server (#1126).**
  Only the user's real `~/.agend` (from the password database, not `$HOME`) uses tmux's default
  socket (if that database cannot be read, no home is the default). Before, a fleet run with `HOME` and `AGEND_HOME` both pointed at a scratch directory
  counted as "default", attached to the live `agend` server, and its startup cleanup killed the
  live fleet's windows as orphans. Nothing changes for an unset `AGEND_HOME`, one set to your real
  `~/.agend`, or any other custom value: each keeps the socket it had.
- **Dashboard responses can no longer be framed, sniffed or cached.** Every
  response from the dashboard/health server now carries `X-Frame-Options: DENY`,
  `Content-Security-Policy: frame-ancestors 'none'` (the pages have buttons that
  restart instances, so a framed page could be clicked through),
  `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` (routes that set
  their own Cache-Control, such as the SSE stream and avatars, keep it).

### Security
- **Instance directories are now 0700 (and existing ones are fixed at startup).** `<data dir>/instances/<name>`
  holds `agent.token` and the IPC socket, but was created with the process umask — typically 0775, so
  group-writable and traversable by every user on the machine (the files inside were already 0600, the
  directory was the open door). New instance directories are created 0700; on start the fleet makes the
  `instances` directory and each instance directory under it 0700 once, logs a single line saying so, and
  never touches anything inside them (a file you put there keeps its mode). Symlinks and directories owned by
  someone else are left alone and named in a warning. The "IPC socket parent directory is world-accessible"
  warning, which fired on every instance start and was never acted on, now fires only for a directory that is
  still open and could not be fixed, once per directory. **If another user or service relied on reading an
  instance directory through group access, give it access explicitly — the group no longer has it.** (#1118)

## [2.1.9] - 2026-10-02

### Upgrade Notes
- **The systemd unit stops the fleet, not every CLI at once (#908).** With
  systemd's default `KillMode=control-group`, stopping or updating the service
  sent SIGTERM to the fleet, the tmux server and every CLI at the same moment,
  before the fleet could quit them one by one. On WSL kiro-cli aborted into a
  core dump of about 1 GB each time. New units use `KillMode=mixed`, and
  `agend restart` (which `agend update` runs) adds it to an existing unit and
  reloads systemd before restarting (#1070). If the line cannot be written, or
  systemd still has another mode loaded after the reload, the restart is
  refused with what to do, instead of stopping the fleet the old way (#1073).
  A `KillMode` you set yourself is left alone.
- **Restarting a paused instance now wakes it (#1075).** It used to come back
  still paused, and after a fleet restart nothing woke it. If the start fails,
  it stays paused and can be woken again.
- **New opt-in delivery setting `delivery_worker` (default `off`; #1075,
  #1078, #1079).** `off` keeps every delivery path as it was. See Added for
  `wake_only` and `on`. With either, `defaults.warm_overflow` (default 2) is
  how far `warm_cap` may be exceeded to wake a target for queued work.

### Added
**Cross-instance messages wake a paused instance reliably (opt-in,
`delivery_worker: wake_only`; #1078).** A message to an instance paused across
a fleet restart used to stay queued at attempt 0 until someone woke it by
hand. A wake coordinator now wakes a paused target when queued work is
waiting, through the same single wake an operator's `/wake` uses. It retries
with backoff, tells both topics after repeated failures, and never wakes an
instance paused for a login failure. It also keeps the number of awake
instances within `warm_cap` plus `warm_overflow`. Each instance can be set
separately.

**Per-instance delivery worker (canary, `delivery_worker: on`; #1079).** For an
instance set to `on`, one worker owns its delivery lane: it waits until the
CLI accepts input, by the daemon's own account, then claims, hands off and
waits for the result, one message at a time. Ownership moves only when nothing
is in flight, and a lost connection after typing began never lets the next
message overtake the unfinished one.

**Persona emoji for photos and attachments (#1080, #1082).** The stamp a bot
puts on a photo or file it saved (📸 / 📎, 👌 / 👍 on Telegram) is now two more
`status_emojis` keys, `photo` and `attachment`, settable in Settings and with
`set_persona_emoji`.

**Every instance can see server emojis (#1081, #1083).** `general` can now
list, preview and set its own stamp; `minimal` can list and preview. ClassicBot
instances get the server emojis from `list_emojis` and can use
`preview_emojis`; only `set_persona_emoji` refuses them and points to
Settings.

**`/status` merges State and adds Model (#1052).** The State column combines
paused, stopped or crashed with the execution state, and Model shows the live
model, the same one `/ctx` reports. The IPC column is gone, and `agend ls`
uses the same State icons.

**`agend delivery scan-forged-envelopes` (#995).** It scans a kiro instance's
own transcript for fleet message envelopes naming real instances and checks
each message id against the durable delivery record. It reports any that the
fleet never delivered. It fails closed on anything it cannot read.

**Quits are logged with their reason and caller (#1030).** A Codex that exits
without relaunching is now reported.

### Fixed
- **Claude Code's first run no longer stops at the trust dialog or quits
  there (#1074).** Its confirm dialogs ignore keys for a moment after they
  appear, so a quick Down then Enter could land on "No, exit". Trust and
  bypass are now answered step by step on a verified cursor. The onboarding
  screens (theme, security notes, terminal setup) are recognised instead of
  being mistaken for a ready prompt, and the login screen is checked before
  readiness.
- **Woken instances stay awake for their work (#1075).** Work from other
  instances now counts as activity, and a woken instance starts its idle timer
  afresh. An instance busy only with delegated tasks used to pause again a
  second after every wake. Start, stop, wake and restart of one instance now
  run one at a time, so a late start can no longer take over from a newer one.
- **grok tells the operator to run `grok update` (#1066).** This replaces
  failing quietly when the server refuses an outdated CLI.
- **Codex remote login offers only device authentication (#1072).**
- **A CLI installed with `/install-cli` can be used by `/login` without
  restarting the fleet (#1059).**
- **A login-error match that cannot be verified pauses the instance only if
  it is still on screen when the turn ends (#1044).** A muse turn past its
  first minute still reads as busy (#1045).
- **The injected envelope no longer repeats a `task_summary` that only echoes
  the message (#1037).**
- **Security:** workspace paths can no longer inject shell commands, and
  identity settings can no longer write to object prototypes (#1061).
  Persona-emoji tools act only on an instance's own config entry (#1062,
  #1065). `list_emojis` and `preview_emojis` refuse inherited names such as
  `constructor` (#1083).

## [2.1.8] - 2026-09-30

### Upgrade Notes
- **Codex instances keep their app-server runtime directories private (#1034).**
  Each instance's `CODEX_HOME` used to mirror `~/.codex/app-server-daemon` and
  `~/.codex/app-server-control` as links, so a Codex that starts its managed
  daemon failed with "socket directory path exists and is not a directory", and
  a daemon started through the link would have been your own, with your
  config. The first start after upgrading removes only the links AgEnD created
  (an exact match on the target), leaves real directories and your own links
  alone, and never touches `~/.codex`. Sessions and the session database stay
  shared. Rolling back is safe: private directories are kept and nothing is
  deleted.

### Added
**An agent can pick its own persona emoji (#1039).** In a channel with several bots every
one stamped the same ✅ on the messages it handled. `list_emojis` shows an
instance what it may use: the standard emojis its platform takes and, on
Discord, the server emojis its bot can react with. `set_persona_emoji` then
sets its own `delivered` stamp (or another status it names) in its
`status_emojis` override, the way `set_display_name` sets its name. The value
is checked the way Settings checks it: Telegram's reaction set on Telegram,
one emoji only, and a server emoji only from a server the bot is in. The
bundled `persona-emoji` skill walks a worker through it. ClassicBot instances
have no per-instance stamps, and the tool says so.
A name and an id say nothing about what a server emoji looks like, so
`preview_emojis` downloads up to 8 of them and returns a local image path for
each, which the agent reads before picking (#1040). The fleet builds the CDN
address from the id of an emoji the bot can use, never from anything the
agent passes, and keeps only small PNGs.

**The Settings emoji picker lists every server the bot can draw on (#1021).**
Besides the connection's own server, it now lists the other servers the bot
is in that ClassicBot's `allowed_guilds` admits, grouped by server, primary
first. A server that refuses its list shows the reason without hiding the
others. Reacting with another server's emoji needs the bot's Use External
Emojis permission in that channel, and the picker says so.

**`/sysinfo` shows each backend CLI's version (#1027)** — Claude Code, Codex,
Kiro CLI, Grok, Antigravity and Muse — from the existing CLI-environment cache.
A stale value stays visible while it refreshes, and the refresh probes run in
a worker thread so a slow CLI cannot block the fleet.

### Fixed
- **Messages reach a Codex instance whose idle footer lacks the Context item
  in about 10 seconds instead of 70 (#1035).** The fleet's own idle wait,
  before a delivery reaches the instance, now accepts the same strict evidence
  as the instance-side fallback below, so it no longer waits out its full
  minute first.
- **A codex instance whose idle footer lacks the Context item no longer waits for ever for its
  first message (#1031).** After a restart, codex sometimes draws its idle composer without the
  `Context N% left` status item (seen on a resumed session whose footer showed only
  `⚠ 2 warnings · f2 to view`). The first delivery after a restart needs a recognised footer,
  so it waited 30 minutes, failed as retryable, and waited again: one instance sat on a queued
  task for seven hours. When the footer is the only thing missing, AgEnD now uses the same
  structural evidence it already uses to call an unknown screen idle. All of it is required:
  an empty input box, no busy row, queued input or known picker, no resume load on screen, the
  same screen for 10 seconds, and a terminal ready for input. It logs a warning when it does.
- **Codex instances resume their own session even when their session database is private (#1028).**
  If `~/.codex` had no session database yet when an instance first started (for example, AgEnD
  was the first thing to run Codex on the machine), Codex created a private one in that
  instance's home and kept using it. AgEnD looked only in the shared home, found nothing, and
  every restart fell back to `codex resume --last` or a fresh start, with a "could not be read"
  warning. AgEnD now reads the database the instance's Codex actually uses, and falls back to
  the shared one only when the instance has none. It stays read-only.
- **A Codex launch that starts a new conversation says so when this workspace
  had one (#1053).** When the resume lookup finds nothing, AgEnD starts fresh,
  and until now said nothing — "never had a conversation" and "the lookup
  missed it" looked the same, which is how #1028 went unnoticed. The launch
  now checks Codex's own rollout files for an interactive conversation of this
  directory with a turn in it, and if there is one, the instance's topic is
  told a new conversation was started and how to continue the earlier one
  (`codex resume <id>`). A workspace that never had a conversation stays quiet.
- **muse instances are no longer paused and `/quit` mid-task by a false
  sign-in error (#1042).** The muse sign-in pattern matched a bare `401`, and
  muse's diff view numbers its rows: editing line 401 of any file was read as
  an expired login, the pause waited for the turn to end, and AgEnD sent
  `/quit` before the agent could commit or report ("Quit when idle" in the
  pane is the description of muse's `/quit`). The pattern now needs one of
  muse's own sign-in sentences, on a row that is not the conversation's or a
  diff's.
- **The kiro transcript poll no longer stalls the whole fleet (#1048).** Every
  kiro instance polls its transcript every 2 seconds, and each poll opened
  kiro's conversation store (over 1 GB on a lived-in machine) and read every
  conversation of its workspace in full to learn whether anything had changed.
  With 13 kiro instances that was about 100 ms of blocking work every round on
  the fleet's event loop: Discord `/ctx` missed its 3-second deadline, the View
  stopped streaming, and a local request took up to 16 seconds. The poll now
  keeps one read-only handle and learns about changes from the index and the
  record header alone: 0.25 ms per round on the same store.
- **Settings › "Restart AgEnD" now shows that it is restarting, and cannot be pressed twice (#1024).**
  The restart really happened, but the button stayed enabled, the panel kept saying "Saved —
  restart AgEnD to apply" while AgEnD was going down, and nothing watched for it to come back —
  so people pressed it again. The click handed the *finished* job it was holding to the watcher,
  whose loop only runs while a job is "running", so it returned at once and re-drew a fresh
  button. It now disables and relabels the button the moment it is pressed ("Restarting…"), asks
  for one confirmation and posts one request, watches the job the server moved to "running",
  shows "Restarting AgEnD…" with an explanation, keeps polling through the seconds when the
  server is unreachable, and reports "Changes applied" and refreshes the page once AgEnD is back.
  A refused restart gives the button back with the reason.
- **Settings › Start / Stop / Pause / Wake on an agent show that they are working (#1024).** They were
  fire-and-forget (a failed stop said nothing, and a second press sent a second request). While
  one is in flight the agent's buttons are disabled and the pressed one reads "Working…", only one
  action per agent runs at a time, and a failure is reported.
- **Codex 0.158 and 0.159 are supported; deliveries wait out a 0.159 resume again (#1025).** Right
  after a restart Codex draws its composer about a second before input is live, and AgEnD
  holds deliveries until then. 0.159 redrew the header without its box, which the hold
  depended on, so on 0.159 a message sent straight after a restart could land during the
  load. The hold now recognises both header layouts. It is also tied to AgEnD's own launch
  state rather than to the screen alone: it applies only after AgEnD launched a resume, and
  it stops once the load has been seen to end or the screen has not changed for 30 seconds.
  So a conversation that quotes the loading screen cannot hold deliveries. AgEnD also launches Codex with
  `features.instant_interrupt` off: 0.159's opt-in setting makes new input steer the running
  reply instead of queueing behind it. Codex before 0.159 lists that key as "ignored" among
  its startup warnings; nothing else changes. On 0.158, instances that run with approvals
  on (`--full-auto`, i.e. `skipPermissions: false`) may see a new approval prompt for
  elevated commands. The default launch bypasses approvals and is unaffected.
- **Settings › Connections & Bots rows no longer break words or clip (#1022).** Since v2.1.7 each
  row (bot type, id, token env var, group/guild, access mode, allowed users, token status,
  connection state, Settings button) was a non-wrapping flex row, so every item shrank and
  wrapped inside its own box — "存取模式:" and "設定" split mid-word, chips became two lines —
  and the tail ("Connected") was clipped by the card. Items now keep their own text on one
  line, the row wraps *between* items when it is too long, and the token-status / state /
  Settings cluster stays together at the end. Long values (env names, user ids) break
  anywhere rather than widen the row. CSS/markup layout only; nothing about the data or the
  Settings button changed. Checked in Chromium at nine widths (1280–390 px) in both languages.
- **Settings › status emojis: every preview value now says where it comes from (#1023).** A report
  said that after picking Received and Queued, the 👀 "moved" to Processing. Nothing moved and
  nothing was mis-stored — the editor binds every value to its status name, and the request
  it sends carries exactly the keys that were picked (`{"received":…,"queued":…}`). 👀 is simply
  the built-in for Received, Processing *and* Progress prefix, and only non-default values were
  labelled, so the 👀 left under Processing looked like a displaced one. Built-in values now
  carry a "default" tag next to the "connection" / "agent" ones. A regression test drives the
  page's real editor code through every pair of picks (in both orders) and asserts each value
  lands on, previews as, and is stored under its own status name.

## [2.1.7] - 2026-09-30

### Upgrade Notes
- **[Behaviour change] Codex instances resume their own conversation, not a
  sibling worktree's (#984).** Codex 0.157's `codex resume --last` picks the
  newest session of the whole git repository, so AgEnD instances on worktrees of
  one repo were taking each other's sessions: a "conversation is open in another
  app" lock screen while the other instance ran, or its conversation silently
  continued here. AgEnD now reads Codex's session database read-only and runs
  `codex resume <id>` for the newest session recorded for exactly this
  instance's working directory. What changes for you:
  - An instance whose sessions are in its own directory resumes the same
    conversation as before.
  - A **new** instance in a repository that other Codex instances already use
    starts a **new** conversation instead of inheriting a sibling's.
  - If the session database cannot be read (for example after a Codex schema
    change), AgEnD starts a new conversation when another Codex instance shares
    the repository, and falls back to `codex resume --last` when none does; either
    way the instance's topic gets a notice. Earlier conversations are never
    deleted and can be resumed by hand with `codex resume <id>`.
  - Nothing is migrated and AgEnD writes no Codex state. A conversation that was
    already taken over before this release (for example a fork created from the
    lock screen) stays where Codex recorded it: check it, and archive a wrong
    fork in Codex, before restarting an affected instance.
- **Delivery-status emojis are configurable, and the filter now keys on who
  reacted (#1005).** A human reaction is never swallowed as a status stamp any
  more, whatever emoji it uses; only the fleet's own bots' stamps are filtered.
  A fleet that does not configure `status_emojis` keeps the built-in set.

### Added
**Delivery-status emojis can be configured per platform and per agent
(#1005).** `status_emojis` on a connection (`channels[].options`) or on an
instance sets the received / queued / processing / delivered / failed stamps
and the progress prefix, including Discord server emojis (`<:name:id>`).
Values are checked the way each platform accepts them — Telegram only takes
its fixed reaction set — and an unusable one falls back to the default with a
warning. The instructions' "don't react with these" list follows the resolved
set. Settings has an emoji picker with a live preview resolved by the same
code the bots react with, listing the server's custom emojis fetched with the
bot token (unavailable ones are shown but cannot be picked).

**Requests that require a reply are tracked until they get one (#926).** A
`requires_reply` request is recorded durably; when the reply is overdue the
owner is reminded and the requester is told, instead of the request quietly
expiring.

**Cross-instance delivery goes through a durable outbox (#929).** Messages
between instances are admitted to an on-disk outbox before they are sent,
reconciled after a restart, and can be looked up with `delivery_status`
(including silent schedules, which are admitted as raw pastes).

**A peer message can be verified by its message id (#856).** Each delivered
message carries an id and a payload digest, and `delivery_status` confirms
whether a given message was really delivered by the fleet — the check to make
before acting destructively on another instance's word.

**`/view` has a sidebar filter** and a more readable usage panel (#999).
`agend ls` collects its rows concurrently and no longer waits on one slow
instance (#997). Shell completion says when `bash <TAB>` will not work, can
install itself, and reports its status (#1003).

### Fixed
- **Codex resumes real sessions again (#1017).** The exact-directory lookup
  introduced for #984 only accepted threads with `has_user_event = 1`, which no
  real Codex 0.157 session carries, so every restart silently started a new
  conversation. A thread is now resumable once any turn ran in it, checked
  against Codex's own rollout when the listing is empty.
- **Codex session-lock and resume-directory screens no longer stall delivery
  silently (#984).** Codex's "This conversation is open in another app (r retry /
  f fork)" screen and its "Working directory · resume" picker matched nothing, so
  startup assumed the screen was ready and messages waited 30 minutes in the idle
  gate before failing. Both are now held: delivery stays blocked, the operator is
  told, and AgEnD never presses `r`, `f` or a picker option for you.
- **Codex's "switch model" nudge on a rate limit is turned off in fleet
  instances (#1008)** (`notice.hide_rate_limit_model_nudge` in each instance's
  config); the screen is still held, never answered, if it appears anyway.
- **Codex's Context status item is found in any status-line position and is
  verified to be in the status line (#931, #978),** with a warning when it
  cannot be added; a status row whose title is the model's reasoning reads as
  busy on every readiness path (#964); no-context readiness and a stale
  capacity baseline are fixed (#947, #949).
- **GitHub credentials stay out of worktree remotes (#855, #963).** Worktrees
  no longer get a token embedded in their remote URL, and an existing one gets
  an advisory warning.
- **Usage survives a failed fetch (#719):** a transient error shows the
  last good numbers instead of blanking the panel; fetch and startup probes are
  bounded and single-flight (#720, #724, #725).
- **Reactions:** a delivery-status emoji replaces the previous one instead of
  stacking (#868), statuses are only ever added and unreacted when leaving ❌
  (#972), a reaction counts as completing a reply (#877), and the reply-drop
  recovery prompt offers "react or reply" (#960).
- **grok's weekly-limit screen is held** instead of being answered (#992);
  **muse's idle check is anchored to the live input box** (#958); **fleet
  restart progress edits are throttled** and retried on Discord 429s (#965).

## [2.1.6] - 2026-09-26

### Upgrade Notes
- **[Behaviour change] Agents no longer get every tool by default (#804).** An instance
  with no `tool_set` in `fleet.yaml` used to be handed all 47 of AgEnD's tools,
  including `create_instance`, `delete_instance`, `deploy_template` and
  `update_fleet_defaults`. Nobody chose that; it was what "unset" meant. The
  default is now `worker`: talk to people and to peers, read everything, do the
  work — and none of the verbs that run the fleet.

  **What you may need to do.** Instances that genuinely coordinate — a team
  lead, a General-like dispatcher, anything that restarts or creates other
  agents — need `tool_set: coordinator` on the instance (or in `defaults`).
  **On first start after upgrading, AgEnD tells you which ones**: it reads the
  last thirty days of activity and names the instances that have actually used
  a tool a worker no longer gets, with what they used. Instances that merely
  delegate are not on that list, because `delegate_task` stays with the worker
  and they lose nothing.

  **Nothing is rewritten for you.** An explicit `tool_set: full` is still
  honoured exactly as written, including `defaults.tool_set: full` — which also
  means a fleet with that line keeps every agent on every tool until the line is
  changed. The notice says so rather than editing your file.

  The profiles are `worker` (default) ⊂ `coordinator` (set by hand) and `full`;
  `standard` and `minimal` are unchanged. `general` remains an identity rather
  than a choice: it comes from `general_topic` and is still refused if written
  by hand.

  One gap to know about: General cannot set `tool_set` for you today — its
  `update_instance_config` tool has no such field, so the value is dropped
  silently. Mark coordinators through Settings or by editing `fleet.yaml`
  (#814).
- **[Behaviour change] Codex instances get a short `CODEX_HOME` (#953).** Codex
  0.157 puts a socket under `CODEX_HOME`, and for instances with long names
  the path exceeded the Unix socket limit. Each instance's home moves to
  `~/.agend/cx/<hash>/` on first use after upgrading; the move is automatic
  and idempotent.
- **Codex resumes with `codex resume --last` again (#933).** The explicit
  per-instance session resume of #913 was reverted; its pane detection for
  Codex 0.155/0.156 (#914) was kept.
- **`kiro_ui: v3` is refused** until kiro's v3 interface can run unattended
  (#850): measured on kiro-cli 2.23.0 it stopped at a migration dialog and a
  trust screen whose default is "No, exit".
- **Switching an agent's subscription starts a new conversation (#798)** — kiro keeps
  its conversations in the same `data.sqlite3` as its login, so a different
  credential profile is a different set of conversations and there is nothing to
  resume. The first launch after a switch skips resume outright, and the new
  session is handed a summary of what the old one was doing (the reply reports
  `conversation_carried_over: false` and `handover_chars`). Say anything that
  must survive verbatim in the channel before switching.
- **Switching to a credential profile that has never been logged in is refused (#798)**
  — kiro-cli does not start a signed-out session, it stops at a sign-in prompt
  and waits, so the agent would sit on a login screen until its startup budget
  expired and then restart into the same screen. The error carries the command
  to log the profile in. Going back to the default login is never refused.
- **A busy health port no longer terminates whatever `fleet.pid` names (#792)** — the takeover used to signal that pid on sight, and a stale or wrong entry names whatever holds it now. The target's command line is checked first, and when it cannot be confirmed the signal is not sent. `fleet.lock` also records whether a fleet or the setup page owns it, so the two refuse each other in both directions instead of one stealing the lock from the other.
- **Dashboard and Settings links now exchange their token for a session cookie (#786)** — opening a link redeems `?token=` once, sets an `HttpOnly; SameSite=Strict` cookie, and redirects to the same page without the token, so the credential stays out of the address bar, browser history and any log that records request URLs. `X-Agend-Token` still works for scripts and the CLI, but a URL token is no longer accepted for a write. `agend web-token rotate` revokes every issued link and cookie at once.
- **Fewer changes ask for a full AgEnD restart (#787)** — "restart AgEnD" used to appear for every cold fleet default, including `backend` and `model`, which the agents absorb by restarting. It is now limited to settings read once when a subsystem is constructed (channel bindings, `health_port`, `defaults.locale`, `cost_guard`, `webhooks`, `daily_summary`, and the two scheduler keys the scheduler captures at startup).
- **A failed self-restart needs the change applied again (#789)** — if the restart cannot be launched, its row is marked failed and the job is finished rather than left open for another attempt. Press Apply again to get a fresh job whose fleet row can be restarted. This is the fail-closed side of "one restart per job": a job whose launch failed must not stay a reusable restart button.

### Added
**Tool access is decided by the fleet, not by what a model happens to be shown (#804).**
Every route into AgEnD's tools — the MCP tool list, a `tools/call` naming a tool
directly, a write straight to the instance's socket, and `POST /agent` — now
passes one permission table checked on the server side. Before, only the first
of those consulted a tool list at all, so narrowing an instance's profile saved
tokens without denying anything. A refused call says which profile the instance
is running under and what to do instead, because the agent reads the error as an
instruction.

**One fleet can now run on more than one subscription of the same backend (#795–#798).** An
instance carries `backend_options.<backend>.credential_profile: <name>`, and
instances naming the same profile share one login while instances naming
different profiles have different ones. An instance with no profile is
untouched: nothing is added to its launch and no directory is created, so a
fleet that does not use this cannot be affected by it. Implemented for
`kiro-cli`; the mechanism is one record per backend (`CREDENTIAL_HOMES`), not a
kiro-shaped design.

A profile lives in `~/.agend/credential-profiles/<backend>/<profile>` and is
logged in once from the host. Only the login is duplicated — kiro's
multi-gigabyte runtimes are symlinked back to the shared copy, so a second
subscription costs megabytes. The credential store itself is never a symlink,
because SQLite follows a linked database to its target and would leave the
profile sharing the login it exists to separate.

General can create an agent on a subscription or move one between them, in plain
language, and `/usage`, `get_usage` and the dashboard show **one row per
subscription** rather than one per backend — `Kiro (work)` beside
`Kiro (personal)`, each read from its own store and never added together. A
profile that is configured but not yet logged in still gets a row, reading
"Signed out", because that is the row you need to see while setting a second
subscription up.

Settings now applies changes as a job you can watch (#788). `POST /api/settings/apply` returns one row per affected agent and `GET /api/settings/apply/:jobId` is the authority on it; the job is stored on disk, so a change that restarts AgEnD itself no longer takes the answer down with it. The client generates the idempotency key before its first attempt, so the retry that follows a lost response rejoins the original job instead of applying everything twice.

The panel can restart AgEnD itself (#789) for a change only a fresh process can adopt, behind its own confirmation, its own idempotency key, and a rate limit of one restart per 10 minutes and three per hour that is written to disk before anything is launched. The restart is announced in the chat channel first and is refused if it cannot be announced, so a panel restart is never invisible to the people who would notice it was not them.

**Codex can use credential profiles too (#806).** A Codex profile swaps only
`auth.json`; sessions, the session database and caches stay shared, so
switching accounts does not have to start a new conversation. `/usage` shows
`Codex (work)` and `Codex (personal)` as separate rows.

**Meta Muse Code is a supported backend (`backend: muse`, #827).** Each
instance gets its own MCP configuration (#903), and muse's subscription usage
is relayed from its response stream into `/usage` (#894).

**The Settings panel was rebuilt (#785–#792).** Rows with modals, an advanced
drawer and a global search; a guided four-step quickstart; a pre-fleet setup
page with safe takeover and locking; and the page gate moved to an HttpOnly
session cookie with Origin checks and token rotation. Connections can rotate
their bot token securely (#864) and rebind to a verified guild or group
(#870), and provider API keys are verified before they are saved (#873).

**The setup page can be reached from a phone through a cloudflared tunnel
(#799–#803).** Every tunnel needs its own confirmation on a terminal — there
is no flag, env var or config that pre-answers it — and the warning says what
passes through Cloudflare. Without cloudflared, the command says so and gives
the local alternative.

**Discord bot activity shows usage (#866),** refreshed eagerly, scoped per
adapter and in a compact form (#891, #901, #921). `/model` has a
"🔄 Refresh models" item (#887), a Claude Code usage-limit pause is reported with
its automatic resume time (#820), `/ctx` shows the auto-pause setting and pause state (#952), and
the daemon logs why a CLI died and whether AgEnD stopped it (#942). Every
instance may now manage its own schedules; scheduling for others stays with
coordinators (#896). The documentation site moved to Astro Starlight, in
English and zh-TW (#825, #832).

### Fixed
- **Codex 0.155, 0.156 and 0.157 are supported (#914, #953).** Their pane
  layouts are recognised, and the folder-trust prompt at startup is handled
  safely (#919).
- **Codex usage limits:** "Continue with Luna Reserve" is chosen automatically
  on the usage-limit menu and the pane stays alive after it (#945, #940), the
  first delivery waits for the reserve to settle (#941), usage shows the
  reserve as "Luna Reserve" even at 0% (#937), and a model-capacity error
  backs off and restarts instead of pausing the instance (#905).
- **Codex:** the Context item is injected into status-line configs that quote
  their keys (#931), and false delivery failures during wake are gone (#918).
- **kiro:** the first delivery stays pending until its submission is proven
  (#934), busy turns are drained before a fleet stop (#938), and the
  unavailable-model picker is held and escalated (#925).
- **muse:** the idle gate is no longer blocked by muse's periodic redraw
  (#932), the second Enter muse asks for is sent (#831), an idle usage snapshot
  is kept (marked stale) while its windows stand (#904), and the usage relay
  resumes directly and notifies when recovery is exhausted (#899).
- **Claude Code's dangerous-command dialog heals itself:** it is denied
  automatically and the agent is told (#881).
- **Delivery and replies:** the resume wait is measured by progress, not wall
  clock (#869); late Cancel buttons are retired (#784) and armed prompts are
  retired on shutdown (#840); a refused artifact tells the agent how to send
  it (#885) and a reply reports the ids of the messages that carry its
  attachments (#836); Discord truncation keeps markdown fences intact (#838);
  a transient tmux `load-buffer` failure is retried (#841).
- **Configuration and access:** a state file that overrides `fleet.yaml`
  access is reported (#833); schedules keep the reply adapter they were
  created on (#844) and refuse a non-string target or id instead of crashing
  (#898); `list_models` honours the one-hour CLI-environment freshness window
  (#902); onboarding keeps the install result and discovers login backends
  (#859); Kiro Pro shows as unlimited (#892); Codex usage sources are split
  and unavailable presence rows hidden (#875); all loggers share one pino
  transport (#845).

## [2.1.5] - 2026-09-16

### Upgrade Notes
- **`/restart full` with empty `allowed_users` is now fail-closed** — previously, an empty `allowed_users` list in fleet.yaml would allow any user to perform admin operations. This release treats an empty list as "no one allowed," requiring explicit population of the allowlist. Review your fleet.yaml before upgrading if you rely on admin commands (#726).
- **Multi-adapter fleets: reply context requires adapter binding** — in fleets running more than one channel adapter (e.g., Telegram + Discord), if `last-chat.json` was written by an older version and lacks an `adapterId` field, the first reply after restart will fail with "no adapter bound" until an inbound message re-establishes the world binding. This is intentional: failing is safer than routing a chat id through the wrong platform's bot. Single-adapter fleets are unaffected (#752).
- **[Behaviour change] Readable backends now fail on unverifiable deliveries** — when a delivery cannot be proven to have left the input row (baseline confirmation fails three times and no unique signature is detected), the daemon reports ❌ instead of relying on output signals to guess ✅. The principle is "fail rather than guess"—users see the failure and can retry. This affects Codex and Kiro; Claude Code and Antigravity are unaffected because they have reliable submission signals (#757, #759).
- **[Behaviour change] Topic disappearance triggers quarantine, not deletion** — when a Discord gateway outage or channelDelete event makes a topic appear missing, the daemon now quarantines the instance (revokes its route, preserves all data) instead of automatically deleting the instance and its worktree. Destructive removal requires explicit authorization via the dashboard confirmation dialog or the `delete_instance` tool. This prevents data loss during transient adapter disconnects (#765, #766, #767).
- **Classic cold fields still require restart** — the new fleet-wide behavior switches (`tool_progress`, `reply_completion_guard`) hot-apply to fleet topics and to Classic channels that already exist. However, ClassicBot "cold" fields—`backend`, `model`, `effort`, and `working_directory`—still require an instance restart (or `/stop` + `/start`) to take effect; SIGHUP alone does not restart Classic instances. This matches the previous behavior and avoids mid-conversation backend swaps (#775).

### Added
The `/login` slash command introduced in 2.1.4 received significant enhancements this release. Login now runs inside the token-gated web terminal, providing a secure browser-based authentication flow for all backends. Codex uses device-auth mode for headless environments. After a successful login, the system reports the result immediately without waiting for instances to restart, and the restart carries a visible deadline so users know when to expect their fleet back online. An inline "re-login" button now appears alongside auth-failure alerts, letting operators fix expired credentials with a single tap instead of typing the command (#715, #717, #729, #733, #748).

The new `/install-cli` command lets operators install CLI backends remotely, and ClassicBot instances now recover automatically after a backend login instead of requiring manual intervention (#733).

The `/ctx` command now displays the configured reasoning effort alongside the model (#738). The `list_instances` MCP tool adopts progressive disclosure: the initial response shows a compact fleet summary with counts by backend, status, and tag, plus guidance on how to drill down. Query parameters (`tags`, `backend`, `status`, `name`) filter the list, and `describe_instance` returns full details for a single instance. Claude Code's live model (read from the statusline) is included when available, and `get_instance_logs` is capped at 200 lines by default to protect against runaway context consumption (#740).

The web dashboard now shows richer instance metadata. The detail header and sidebar hover tooltip display the live model (aligned with `/ctx` parsing), configured effort with a "(configured)" label, backend, and the instance's display name when set. The `/ui/instance/:name` and `/api/profiles` endpoints include the new `model_source`, `effort_source`, `context_pct`, and `display_name` fields so external tools can distinguish live versus configured values (#762, #764, #770).

`/restart full` performs a complete process reload from chat, service-aware and single-flight. The systemd handoff timeout outcome is now tracked correctly, and the reload is fenced against standalone updates so a mid-flight `agend update` cannot race (#726).

Two fleet-wide behavior switches are now exposed in Settings and fleet.yaml. `tool_progress` controls whether the working bubble lists tools as they run (off by default; set to `standard` for semantic labels or `verbose` for command previews). `reply_completion_guard` enables the silent-reply-drop protection from #750; it defaults to `true` and can be disabled per-instance if it interferes with a specific workflow. Both switches resolve through the same channel → classicBot defaults → fleet defaults → hard default chain used by other Classic settings, and hot-apply via SIGHUP or Settings edits without requiring a restart (#775).

### Fixed
This release addresses several silent-message-loss scenarios that could cause user messages to vanish without error.

**[P0 data-loss fix] Discord gateway outages could destroy instances and worktrees.** During a temporary adapter disconnect, the topic-cleanup poller and `channelDelete` handler misinterpreted the missing topic as permanently deleted and automatically removed the instance, deleted its git worktree, and rewrote fleet.yaml—even though the topic still existed on Discord. One user lost 8 instances and 2 worktrees before the bug was identified. The fix is fail-closed: the adapter topology probe now returns a three-state result (present / missing / unknown) where "missing" requires positive evidence from the provider. Cleanup actions use the owning adapter, a single-flight snapshot, and a generation fence; bulk missing results trip a circuit breaker. Automatic topic-missing and channelDelete handling now performs non-destructive quarantine only (revoke route, preserve everything). Destructive `removeInstance` and worktree deletion require an unforgeable authorization token that only the dashboard confirmation dialog or `delete_instance` can issue (#765, #766, #767). **This bug also affects v2.1.4.**

**Codex first-delivery strand after restart or wake.** After a restart or wake, the first message could be swallowed by the CLI's pane redraw, yet the daemon reported ✅. The root cause was that Enter was absorbed by the redraw and the daemon trusted an output signal that never corresponded to actual submission. The fix binds submission verification to backend capability: readable backends must positively prove that text left the input row. A new `InputUnavailableTransient` capability handles Codex 0.154.0's `Resuming session…` transient period, during which Enter is absorbed. Four gates and a generation fence ensure that no delivery is confirmed until the CLI is genuinely ready to receive input (#757, #759, #760, #761).

The Kiro ready-state detector now distinguishes transcript residue from text genuinely stranded in the input row, eliminating false delivery failures that reported ❌ when the message had actually been sent (#736). Kiro CLI 2.14+ prints the agent name in brackets before the prompt (e.g., `[Agent Name] ❯`); the detector recognises this format (#746). When a Kiro session's token expires, the CLI falls back to a sign-in screen. AgEnD now detects that screen structurally (not just by keyword) and withdraws any auth-suspicion flag when a follow-up probe clears. Misidentifying this screen would suppress hang notifications and disable MCP auto-restart—**not** block deliveries—so the fix restores monitoring accuracy rather than unblocking a delivery path (#746, #747).

Codex could report a delivery as successful even when the message was never submitted. The root cause was a race between the input-row snapshot and the actual paste: the daemon saw text in the input area, assumed it had been sent, and returned success. The fix ties submission evidence to the specific paste and explicitly submits any stranded text instead of re-pasting. Additionally, deliveries are now held while the Codex update picker owns the pane, and a message still sitting in the input row is never confirmed as delivered (#745).

A startup timeout no longer abandons a session. Previously, if an instance took too long to start, the daemon would give up and create a fresh session, silently discarding the conversation history. Now the session is preserved and renamed so it can be recovered manually (#737).

Claude Code turns that end without a platform-acknowledged reply are now detected. When this happens, the daemon posts a neutral status message ("the agent did not reply; retrying once") and injects a one-shot recovery prompt asking the model to send its conclusion. If the recovery turn also fails to deliver a reply, the turn ends with an explicit "unrecovered reply drop" notice rather than silent loss. This addresses the root cause of issues #664, #662, and #649 (#750).

The `/model` command now re-probes a stale CLI environment so newly released models appear without requiring a cold start (#721). The `/update` command guarantees terminal progress delivery, fixing cases where the final status message was lost (#722). The usage panel no longer hangs when one provider is slow; each vendor's collection is bounded independently (#718).

Two notification bugs are fixed: fleet-wide notices now post to a channel instead of failing silently, and scheduled notices route to their source chat correctly (#732). The warmup reload notice no longer tells a resume-reloading backend to reload its instructions when it is already doing so (#727). The web terminal now hands out paths with a trailing slash so relative assets resolve correctly (#729). A flaky web-terminal integration test is stabilised (#742).

Cross-channel-world message routing is hardened. When a schedule fires and its reply coordinates belong to a different channel world—for example, a schedule created in a Telegram group targeting a Discord instance—those coordinates are no longer seeded as the target instance's reply context. Previously this caused the instance to send every subsequent channel reply to Discord using a Telegram chat id, producing continuous "Unknown Channel" errors for tens of minutes until a real user message overwrote the stale context. Additionally, the Discord adapter now returns an explicit error when it receives a chat id that clearly belongs to another platform (negative numbers indicating Telegram groups, or numbers too short to be Discord snowflakes), rather than the opaque `10003 Unknown Channel`. In multi-adapter setups where no world is specified, the system now reports a routing error instead of guessing the first available adapter (#752, #753).

The dashboard and `/view` sidebars now show the raw instance name as the primary label, with the display name (when different) as a secondary line below. Previously, the display name replaced the instance name entirely, which lost the stable identifier needed to correlate entries with fleet.yaml and logs. Both lines truncate independently, and the change is purely visual—sorting, click targets, and API payloads are unaffected (#774).

## [2.1.4] - 2026-09-07

### Upgrade Notes
- **fleet.yaml auto-slim is inheritance, not deletion** — fields stripped from instance configs now follow `defaults`. Changing a default later will change those instances too.
- **Owner-adapter fail-closed** — when the adapter that owns a topic goes down, that topic's inbound access is fail-closed (warn log). Previously, another adapter might have accepted the message.
- **`/login` Org SSO not yet supported** — the `/login` slash command is beta; organization SSO flows are a known limitation.

### Added
- **`/login` slash command** — re-authenticate a CLI backend from Telegram/Discord without SSH-ing to the host. Runs a pre-check first and asks for confirmation if the existing auth is still valid, so a working login is never thrown away by accident. After a successful login, instances that were running are restarted so they pick up the new credentials (#611, #613, #614, #617).
- **`/install-cli` slash command** — install a CLI backend on the host remotely, and wired into quickstart. Install commands corrected to the vendors' current ones: kiro-cli via the `curl` installer (was Homebrew) and codex via the official standalone installer (was npm) (#619–#621, #624).
- **`/clear` slash command** — wipe an instance's context. **Admin only, and it requires pressing a confirmation button first** — the destructive action never fires on the command alone (#529, #549).
- **`/steer` slash command + tool progress display** — `/steer <message>` interjects into a turn already running, and the working bubble can list the tools as they run. **`tool_progress` defaults to `off` (opt-in)** so an upgrade does not start broadcasting tool activity into channels; set `standard` for semantic labels or `verbose` to add command previews, from fleet.yaml or the web Settings dropdown (#560, #563, #577, #616).
- **`/btw` slash command** — ask a side question without interrupting the current task. **Claude Code only**; other backends decline explicitly instead of silently dropping the message (#584–#586).
- **`/tips` daily tips** — a 300-tip library (100 beginner / 100 intermediate / 100 advanced) delivered as occasional in-chat cards with Got it / Confused buttons. **Only beginner tips are shown by default.** Advanced tips unlock after 60 tips are dismissed, or immediately when an admin runs `/tips advanced on` — they are never shown unasked. Tips can be filtered by the backends actually in use (#587, #588, #590–#594, #599, #603, #605–#609, #622).
- **`list_models` MCP tool** — agents can enumerate the models a backend really offers instead of guessing. `scope` distinguishes an instance-accurate catalog from the account-wide one, which matters because an instance on a custom provider can offer a different set (#573).
- **Codex custom providers** — `backend_options.codex.provider` points one instance at an alternative provider, available from `create_instance` and documented in a General skill (#545, #552, #553).
- **Cross-backend skill publishing** — skills are published to all six backends in each one's native format, with role-based distribution (General / Worker / Classic) and an MCP payload kept under 2 KB (#554, #555, #557, #558).
- **fleet.yaml auto-slim** — saving strips instance fields that merely repeat a fleet default, plus a one-time migration. **This is inheritance, not deletion**: a stripped field now follows `defaults`, so changing a default later also changes those instances. Identity and routing fields (`working_directory`, `topic_id`, `channel_id`, …) are always kept explicit (#569).
- **Complete zh-TW interface** — 325 locale keys and a typed locale module; no user-facing string is hardcoded English any more (#595).
- **`agend install` activates the service itself** — no manual `systemctl` step after installing. `agend uninstall` now asks for confirmation before removing anything, and `agend doctor` reports system diagnostics (#570, #580).
- **`agend completion install`** — tab completion for bash and zsh (#537).
- **Interactive prompt handling** — when a CLI stops on a sudo/confirmation prompt, AgEnD posts Confirm/Cancel buttons and can ask General to assist, with the buttons nonce-protected and admin-gated (#530, #535).
- **CLI exit and update visibility** — a normally-exited CLI offers Restart/Ignore instead of going quiet, and `/update` shows live progress with elapsed time (#533, #534).
- **OpenCode session resume** — sessions resume properly via CLI JSON discovery with an idle checkpoint, replacing the `--continue` path that hijacked the global session and lost MCP and instructions (#525, #526, #543, #544).
- **Antigravity MCP wiring + persistent workspace** (#618).
- **Usage panel trimmed to what you use** — `/usage` and the web view hide backends this fleet has no login for (#579).
- **CI runs build and tests** — plus gitleaks scanning on push and an explicit permissions block (#524).

### Fixed
- **Expired logins reported honestly** — an expired session is detected as an auth problem instead of being misreported as a stopped MCP server, and no longer raises a "stuck instance" alert on every scan when only re-logging in can help. Codex's startup "Update available!" prompt is also prevented, so a fleet restart no longer leaves every Codex instance waiting on a keypress (#602, #614, #615).
- **Codex SQLite sidecars** — WAL/SHM/journal files are no longer symlinked away from their database, which could split one SQLite database across two homes; legacy links are healed on start (#564).
- **Pane state accuracy** — Kiro no longer reads a stale spinner in scrollback as "working"; Antigravity's cosmetic footer redraw no longer flapped instance state ~52k times a day; Claude Code's cancel button and bubble no longer vanish mid-turn on bare spinner frames; Codex's `›` idle prompt is recognised (#551, #572, #576, #601, #610).
- **Cancel button** — retired correctly after the first message following a restart, and cancelling now clears the pending delivery queue instead of leaving queued work to arrive later (#575, #584).
- **Tool progress history kept** — when a turn ends, the bubble keeps its tool list as a read-only record and only the button is removed; the retained message is labelled as history rather than still claiming to be in progress (#565, #566).
- **ClassicBot fixes** — adapter migration detects the ID domain and self-repairs, `set_display_name`/`set_description` write to the right store, and `update_instance_config` points at the correct tool for Classic instances (#550, #568, #598).
- **Media delivery** — images arrive from Discord reply references and forwarded messages, embed downloads no longer fire on plain URL auto-embeds, Telegram stickers are normalised, and a 📷 reaction is no longer injected as context (#532, #536, #588, #589).
- **Claude Code session resume** — project paths containing dots or underscores encode correctly, and a runtime `/model` switch survives a restart (#538, #539).
- **Schedules use the right persona** — a scheduled message posts as the correct Discord bot in a multi-bot setup (#582).
- **Health check resumes after background-session recovery** (#541).
- **Agent instruction fixes** — instructions now explain how to call `react` and `edit_message`, distinguish a CLI subagent from `create_instance`, and avoid AgEnD's delivery-status emoji. **Instruction changes take effect after a fleet restart**, not immediately (#559, #562, #626).
- **Documentation** — Telegram and Discord bot setup guides (EN + zh-TW), command/config gaps from the 2026-08-13 audit, corrected tool_set counts, de-identified screenshots, and Gemini deprecation labels (#523, #546, #547, #571, #574).
- **ClassicBot Yes/No buttons** — access requests now show inline Yes/No buttons for approval, replacing the text-only workflow (#690).
- **`/sysinfo` fleet summary** — shows instance counts (running/paused), fleet memory, and system memory. Platform-aware formatting: Telegram uses markdown tables, Discord uses plain lines. Summary split to multiple lines for mobile readability (#695, #696, #697).
- **`/install-cli` backend chooser** — bare `/install-cli` (no argument) now shows a backend selection menu instead of an error (#687).
- **Cross-instance steer** — `delegate_task` and `send_to_instance` can now use `steer: true` to inject a mid-turn supplement into a target instance's current turn (#701).
- **Antigravity survey and model discovery** — handles survey prompts and parses TSV model lists (#683).
- **`/sysinfo` resources section** — adds links to documentation, tips, and GitHub (#679).
- **Session management skills** — new General skill documents cross-backend session management and Kiro SQLite recovery (#684, #685).
- **Usage i18n** — AI usage displays are localized; zh-TW duration/binding/rate-limit polish (#665, #675).
- **Codex capacity detection** — detects and reports model capacity errors (#666).
- **Cross-instance message size cap** — oversized messages (>12KB default) are rejected with a clear error instead of being silently truncated (#671).

### Fixed (continued, beta.36–57)
- **ClassicBot allow-list comparison** — IDs are now compared as strings, fixing mismatches caused by JavaScript number precision loss on large Discord snowflakes. Unmatchable IDs are reported to the operator at startup (#691, #692).
- **Fleet error notification** — a fleet error that couldn't be delivered no longer silences the notification queue for ten minutes (#693).
- **tmux paste buffer flake** — test isolation for large pastes vs truncated ones (#694).
- **Discord code-fence split** — cross-instance previews and chunked sends no longer emit a dangling code fence (#698).
- **Classic cross-instance reply** — Classic instances can now reply to cross-instance work requests (#699).
- **Kiro delivery safety** — stops pasting into a busy-but-quiet Kiro pane, verifies submission, and recovers stranded text. The Enter-drop gate no longer has fail-open holes; blank/unreadable panes never prove readiness (#686, #688).
- **Kiro startup resilience** — multiple rounds of hardening: dispose rejected daemons, serialize outage hand-off, wake budget, delayed retries for unattended starts, 20-minute outage memory with positive clearing (#689).
- **tmux storm resilience** — coordinates recovery during tmux storms; preserved deliveries and window crash classification (#674).
- **Discord gateway self-heal** — detects stale gateways and triggers reconnect; preserves native resume recovery; exposes aggregate heartbeat health (#673, #676).
- **Tips button Telegram** — canonicalizes Telegram button context for proper routing (#682).
- **Usage display trim** — hides unused scoped limits from usage display (#681).
- **Kiro CLI version flags** — gates launch flags by CLI version; memoizes compatibility probe (#680).
- **MCP replacement recovery** — a CLI-replaced MCP server no longer restarts a healthy instance; re-checks the idle gate when replacement grace expires (#663, #668).
- **Network family timeout** — preserves longer network attempt overrides; fixed stale Telegram socket handling (#658, #659, #660).
- **CLI help consistency** — help output is now consistent and current (#661).
- **Claude Code trust/delivery hardening** — detects malformed tool-call fragments and attempts reply recovery; detects model fallback and shows live model from statusline in `/ctx`; hardens claude.json updates and detects corrupt-config modal; blocks delivery while parked on a fatal startup screen; tightens error patterns (#648, #650, #651, #652, #653, #654, #655, #656).
- **Codex update prompt** — prevents the "Update available!" prompt from blocking startup (#657).

### Fixed (continued, beta.60–63)
- **`agend health` paused classification** — paused instances are no longer misreported as "Tmux window missing / degraded". Paused status now has its own count in output (`N healthy, M issues, K stopped, P paused`) and does not degrade fleet health (#704).
- **Webhook delivery determinism** — webhooks are now picked up deterministically by the per-instance primary adapter, so multi-adapter setups no longer lose webhooks to the wrong adapter (#707).
- **Inbound access by owner adapter** — access checks are performed by the adapter that owns the topic (before claim). **When the owner adapter is down, that topic's inbound is fail-closed** (warn log emitted). Prevents messages being accepted by the wrong adapter (#710).
- **Claude resume dialog fail-safe** — the "Resume from summary" dialog is never delivered to during restart, preventing silent context loss from accidentally selecting resume (#711).
- **MCP liveness fix** — multiple MCP processes (Codex sub-agents, Claude subagents) no longer cause false "MCP died" reports due to single-slot PID tracking. IPC-layer reachability is now used; recovery clears the notification (#712).
- **`/login` and `/install-cli` beta label** — these commands are marked as beta in help and command menus (#713).

## [2.1.3] - 2026-08-07

### Added
- **tmux 3.7b compatibility** — removed `-r` (read-only) flag from control client, which conflicted with tmux 3.7's new read-only enforcement. Added adaptive paste settle for timing differences (#519, #521).
- **View UI overhaul** — CLI backend icons per instance; instance tooltips with i18n; `/usage` reordered Claude→Codex→Grok→Kiro→Antigravity (#511–513, #514).
- **MCP dead proxy reply** — when the MCP server is unreachable, the daemon can forward agent pane output as a response. **Opt-in only** (`mcp_proxy_reply: true`); default `false` because raw pane output may contain secrets. Cross-instance inbound never triggers this (#515–516).
- **tmux mouse scroll** — `agend attach` enables mouse mode; scroll up to read history (#508).
- **Discord forwarded images** — images from forwarded messages and embeds are now delivered. Fixed `discord.js` messageSnapshots API (no `.message` wrapper) (#505, #518).

### Fixed
- **Kiro Enter retry** — defensive Enter is re-sent on every delivery, not just the first (#504).
- **claude-code classic crash** — fixed crash when tmux window name collides with existing window (#503).
- **Codex session symlink** — migrates legacy session paths; co-located symlinks for CLI and daemon (#507).
- **ctx% > 100%** — parser now reads the real title bar instead of matching chat content (#509).
- **Bot @mention preserved** — `@BotName` kept as `@BotName (you)` in context (#510).
- **TG command menu** — command registration corrected (#517).

## [2.1.2] - 2026-08-06

### Added
- **`/usage` slash command** — check AI subscription usage directly from chat. Shows Claude, Codex, Kiro, Antigravity, and Grok quota in each platform's native rich format (progress bar). Same permission as `/ctx` (no admin gate).
- **`get_usage` MCP tool** — agents can query their own subscription usage. Also available as `agend-agent usage` for CLI-mode agents.
- **AI Usage Panel in `/view`** — 📊 button shows usage panel for all configured backends. Disable with `web.usage_panel: false`.
- **`/effort` slash command** — adjust AI reasoning effort at runtime (low/medium/high/xhigh/max). TG: inline keyboard. DC: select menu. Admin only. Supported across all 6 backends. Codex effort levels are per-model.
- **`get_effort` MCP tool** — query current effort level and strategy. `/status` shows effort column.
- **Reactions as context** — DC/TG reactions are stored in a database and included in the next turn's context, not forwarded as messages. Both directions (user→agent, bot→user). ~~`defaults.reactions_enabled` controls this.~~ **[correction, 2026-08-13]** No such toggle was ever implemented — `reactions_enabled` has zero references in source history; this feature is unconditionally on. Treat the original wording as a documentation error, not a removed feature.
- **Live progress line** — while an agent works, the delivery status message shows the running tool name and elapsed time. Configurable: `defaults.progress_min_elapsed` (seconds, default 30). Shows Kiro's running tool read directly from the pane.
- **Tab completion** — `agend attach <tab>` completes instance names (bash and zsh).
- **Fleet memory report** — `agend ls` footer shows fleet-wide memory total.
- **MCP auto-restart on idle** — when an MCP server dies, AgEnD waits for the instance to go idle then restarts it automatically (crash-loop guard + restart mutex).
- **Singleton fleet startup** — `fleet.lock` prevents duplicate fleet processes from starting.
- **Fleet event loop unblocked** — child processes (sdNotify, etc.) no longer block the main event loop. Watchdog ping is async.
- **Restart progress in General** — live progress of fleet startup: version, instance count, paused list.
- **Startup skips paused queue** — paused instances are excluded from startup launch queue (~50s faster on large fleets).
- **Interactive prompt detection** — detects stalled sudo/Y-N prompts and notifies General.

### Fixed
- **At-least-once message delivery** — cross-instance and scheduled messages retry up to 3 times; final failure is visible to the agent.
- **Cancel button lifecycle** — 4 safety nets (dead daemon, restart, silent reporter, 24h cap). Fixed: spinner, double-observe, post-before-delete ordering, restart mutex, grace retirement.
- **Reply dedup** — 60-second window prevents duplicate replies caused by rate-limit timeouts.
- **General coordinators always warm** — General and multi-channel generals cannot be auto-paused.
- **Delivery routing** — replies use the configured adapter; classic instances route through their bound adapter.
- **pane write serialisation** — all writes into a tmux pane are serialised to prevent interleaving.
- **SQLite hardened** — busy timeouts, corrupt-tolerant event log, bounded query history.
- **Fleet health honest** — `/health` returns 503 when any instance is degraded. `READY=1` is only sent after all generals are up.
- **Error isolation** — one instance's crash no longer takes down the fleet process. ClassicBot errors route to General.
- **Kiro login failure** — no longer misreported as a rate limit.
- **Dashboard token persistent** — `/dashboard` URLs remain valid after fleet restart.
- **agy busy pattern** — Antigravity now has a real busy pattern instead of always-true.
- **Grok/Claude/Codex pattern fixes** — idle detection for edge cases, model error detection, annual key reading.
- **Dead window cleanup** — stale tmux window registrations are retired automatically.
- **Startup dialog guard** — user messages are not pasted into startup dialogs.
- **Secret file mode warning** — warns when a credentials file cannot be made owner-only.

### Changed
- **Cross-instance delivery** — fire-and-queue (non-blocking) instead of awaiting delivery, reducing caller wait time.
- **`defaults.effort`** — new config field for default effort level.
- **`defaults.progress_min_elapsed`** — seconds before live progress shows (default 30).
- **`web.usage_panel`** — show/hide usage panel in `/view` (default `true`).

## [2.1.1] - 2026-07-29

### Added
- **AI usage panel on /view** — 📊 button opens a panel showing live subscription usage for the CLI backends logged in on this machine (Claude session/weekly %, Codex windows/credits, Grok weekly pool, Kiro monthly + bonus/gift credits and Amazon Q subscription). New `GET /api/ai-usage` endpoint (5-min cache); disable with `web.usage_panel: false`. Claude/Codex/Grok provider logic vendored from ai-usage-board/OpenUsage (MIT, see `src/usage/LICENSE.md`); Kiro provider is original research.
- **Kiro TUI effort skill** — general-knowledge skill for Kiro's effort selector in TUI mode.

### Fixed
- **SIGHUP startup window** — startup requests during SIGHUP reload are protected.
- **Reload reconcile safeguard** — aborts reconcile if N→0, empty config, or >50% instance drop detected.
- **Root user Codex PATH** — PATH fallback for Codex when running as root.

## [2.1.0] - 2026-07-27

### Added
- **`/model` slash command** — change backend model from chat. Admin-only. TG: inline keyboard menu. DC: select menu. Shows current model, gives instant feedback.
- **Startup CLI-env probe** — auto-discovers available models at startup and caches per-backend.
- **Auto-Pause/Wake** — idle instances pause after `auto_pause_after` minutes (opt-in, default: disabled). Messages auto-wake paused instances. `general` instance never pauses.
- **Tri-state execution state** — Idle/Working/Stuck shown in `agend ls`, MCP `list_instances`, `/api/fleet`.
- **Adapter startup isolation** — adapters launch in parallel with independent retry; one failing adapter no longer blocks others.
- **Event-driven pane monitor** — uses tmux control mode `%output` events instead of 5-second polling; near-zero idle CPU.
- **Adaptive startup concurrency** — reads `os.freemem()` at startup to limit parallel instance launches on low-RAM machines.
- **Warm cap (LRU evict)** — `warm_cap` config limits resident (warm) instances; excess idle instances auto-pause.
- **Grok Build backend** — full support for Google's Grok CLI: crash recovery, context %, quit key (Ctrl+Q), Web UI, MCP with ASCII-sanitized key.
- **`/model` MCP tools** — `update_instance_config`, `update_fleet_defaults` for runtime config updates.
- **Pause/wake MCP tools** — `pause_instance`, `wake_instance`, `stop_instance`, `get_fleet_status`, `get_instance_logs`, `get_fleet_config`.
- **Cross-instance idle gate** — outbound messages wait for target instance to be idle before delivery.
- **One-shot schedules** — `create_schedule({ at: "ISO-datetime", ... })` fires once and self-deletes.
- **Silent schedules** — `create_schedule({ silent: true, ... })` pastes directly to pane without channel post.
- **ClassicBot backend picker** — `/start` shows backend select menu with install status.
- **Settings page** — structured UI for fleet.yaml/classicBot.yaml with form↔YAML dual-pane sync.
- **Config validator** — `agend validate` CLI + `validate_config` MCP tool.
- **Shared logger** — single root pino transport + child loggers (saves hundreds of MB + threads).
- **Pause freeze monitors** — paused instances stop all timers/watchers (near-zero overhead).
- **Kiro per-instance UI mode** — `kiro_ui: legacy | tui | v3` in fleet.yaml.

### Fixed
- `auto_pause_after` defaults to 0 (opt-in, user must enable).
- `[C]` prefix removed from classic instance display names.
- Cross-instance `[from:]` header shows sender `display_name`.
- Classic instances appear in `agend ls`, `/status`, and Web View roster.
- Grok: ASCII-sanitize MCP server key (CJK key → 0 tools).
- Adapter binding race on restart.
- Kiro lambda prompt recognized as ready pattern.
- Stuck alerts gated on pending inbound work.
- `fleet.log` includes date stamp.
- Unicode instance names (Chinese ClassicBot channels).
- CLI reply uses persisted context after restart.
- agy: auto fresh-restart on unknown model key.
- Idle state invalidated when CLI pane dies.

### Changed
- **Grok Build** — removed experimental markers; now stable.
- **Shared logger** — replaces per-instance worker threads.

## [2.0.11] - 2026-07-08

### Added
- **`/dashboard` command** — admin-only, returns View/Settings/WebUI URLs. DC: ephemeral reply. TG: spoiler-wrapped token.
- **Settings Web Page (`/settings`)** — structured config editor with form ↔ YAML dual-pane sync, validate-before-write.
- **Config Validator** — `agend validate` CLI + `validate_config` MCP tool. Validates channels, instances, backends, access.
- **Web View enhancements** — sidebar drag-sort (SQLite), group by tag, `agend view` CLI, open GET access (no token needed).
- **Same-channel multi-bot ClassicBot** — composite key routing, owner-wins dedup, auto migration, restart rebind.
- **Quickstart persona bot** — "Add persona bot (Discord)" option with 7-step flow.
- **Multi-bot token adapter** — per-channel Discord bot identities.

### Fixed
- **DC general invalid topic_id** — skip + warn + unbind instead of crash loop.
- **Channel missing access field** — defaults to open instead of crash.
- **Avatar DB path** — stores filename (not absolute path); placeholder on missing avatar.
- **`/view` ctx%** — hide when 0 or null.
- **Auto-General** — only primary adapter creates/claims general.
- **React per-adapter** — `reactMessageStatus` uses instance-bound adapter.
- **Warmup false trigger** — skip on first run, defer when idle, add "do not reply".

## [2.0.10] - 2026-07-03

### Added
- **Quickstart auto-installs system service** — asks at end of quickstart, one-step setup.

### Fixed
- **Double fleet race condition** — restart no longer falls back to detached spawn when systemd service exists.
- **WSL Windows PATH filter** — systemd service `Environment=` filters Windows PATH entries.
- **`IS_SANDBOX=1` for root** — systemd service adds env var for claude-code v2.1+ compatibility.

### Changed
- **Remove CI GitHub Release step** — leader writes release notes manually.

## [2.0.9] - 2026-07-02

### Fixed
- **`/ctx` regex for Kiro CLI v3** — matches new λ prompt format (`26% λ !>`).

## [2.0.8] - 2026-07-02

### Added
- **Cancel button** — inline 🛑 button on every inbound message. Track-all design (per-button Map), cross-instance cancel via `correlation_id`, 5-minute idle backstop.
- **Delivery status UX** — 👀 received → ⏳ processing → ✅ done (or ❌ failed). Boolean delivery result with backoff.
- **Discord built-in** — Discord adapter merged into core; no separate plugin install needed.
- **`/save` for fleet topics** — kiro-cli uses `/chat save`, claude-code uses `/export`.
- **`/cancel` command** — slash command alternative to inline button (TG + DC).
- **Model pass-through** — unknown model names passed to CLI with warning instead of silently dropped.
- **Log rotation** — `fleet.log` + inbox rotated via copytruncate on daily timer.

### Fixed
- **`--continue` crash loop** — break loop when resume fails + stop single instance without killing fleet.
- **DC forum thread-aware** — editMessage, deleteMessage, and reactions find messages in forum-topic threads.
- **Health-check null retry** — re-confirms null pane status before declaring crash.
- **TG bare slash ignore** — bare `/` commands in Classic groups no longer trigger errors.
- **DC adapter error isolation** — Discord errors no longer crash the fleet process.
- **Classic collab image path** — surface saved image path as `image_path` on trigger.
- **Cancel button async race** — bounded delete retry, retire by correlation_id.

### Changed
- **Fleet stop performance** — faster stop for large instance counts.
- **`/ctx` scrollback** — robust tmux fallback for kiro-cli.

## [2.0.5] - 2026-06-24

### Added
- **`agend doctor mcp`** — fleet-wide MCP health check (IPC connectivity, config paths, duplicates, binary PATH).
- **TG Classic `/ctx`** — show context usage in classic mode.
- **`/start` notifications to General** — unauthorized DC guilds and TG private chat users trigger an alert to General.
- **Decision filtering** — instances only see fleet-scope + same-project decisions (not all fleet decisions).

### Fixed
- **TG Classic @mention broken by auto-collab** — auto-collab on `/start` now Discord-only; TG classic @mention works correctly again.
- **TG private chat reply 'thread not found'** — `thread_id` no longer incorrectly passed as `message_thread_id` in private chats.
- **`/compact` slash lost** — unified via IPC `raw_paste`; uses `tmux send-keys -l` (literal mode).
- **DC Fleet `/compact` blocked** — no longer incorrectly blocked by classic-only check.
- **Hang detector false positives reduced ~73%** — only flags when pending inbound message exists.
- **claude-code background session conflict** — auto-recovery with re-entry guard instead of crash loop (#79).
- **Crash loop error message** — now distinguishes from 'rate-limited' in notifications.
- **Chat-log timezone** — uses local timezone instead of UTC.
- **install.sh EEXIST** — cleanup error on suzuke→songsid package name upgrade.
- **Export includes classicBot.yaml** — previously missing from `agend export`.
- **Removed soul.md + CLAUDE.md from repo** — accidentally committed files removed.
- **MCP env decision filtering** — passes only filtered decisions, not all fleet decisions.

## [2.0.3] - 2026-06-21

### Added
- **Unified `/update`** — both TG and DC spawn `agend update` (detached); auto-detects beta version and uses `--beta` flag accordingly.
- **DC Fleet slash commands** — `/status`, `/sysinfo`, `/restart`, `/ctx`, `/compact`, `/collab` now available as Discord slash commands (parity with TG).
- **TG Fleet `/ctx` `/compact` `/collab`** — registered in forum bot menu; works in General topic and instance topics.
- **TG Classic `/compact`** — admin-only command to compact classic instance context.
- **TG Classic `/ctx`** — show context usage in classic mode.
- **Fleet `/collab`** — allow bot/webhook messages in fleet topics (TG + DC). Fleet open mode bypasses bot message filter.
- **DC auto-collab on `/start`** — Discord `/start` auto-enables collab mode for the new instance.
- **Instance warmup** — auto-trigger context loading (steering + skills) after spawn; waits for instance to reach idle before marking ready.
- **`agend ls` status indicators** — shows Idle/Busy/Crashed/Stopped per instance in real-time.
- **Fleet ready version** — show AgEnD version in "Fleet ready" startup notification.
- **🔒 Admin markers** — slash command descriptions use 🔒 prefix for admin-only commands.

### Fixed
- **Health port retry loop** — prevent infinite health check retry with re-entry guard flag (#44).
- **`/update` beta auto-detect** — correctly spawns `agend update --beta` when current version is a beta release.
- **DC `/collab` fleet topic permission** — fleet topic `/collab` now correctly requires `allowed_users` permission.
- **DC slash commands duplicate** — `compact` was registered twice causing all commands to fail silently; deduplicated.
- **`/status` performance** — removed serial tmux capture fallback (too slow with 48+ instances); now uses statusline.json only.
- **General topic `/ctx`** — TG General topic (threadId=undefined) now correctly routes to handleInstanceCommand.

## [2.0.2] - 2026-06-17

### Added
- **TG Rich Message receive** — grammy middleware intercepts Rich Message (Bot API 10.1), extracts text for bot-to-bot @mention communication.
- **Multi-channel auto-detect** — each adapter gets its own General instance; unbound generals adopted by topic_id match.
- **`channel_id` field** — explicit binding of General instances to specific adapters.
- **Quickstart live add platform** — add a second platform while fleet is running (systemd restart preferred, fallback detached spawn).
- **`agend stop/start` fallback** — works on machines without D-Bus/systemd (PID kill / direct fleet start).
- **`/sysinfo` version display** — shows AgEnD version in system info table.
- **`/status` context percentage** — tmux capture fallback matches `agend ls` behavior.
- **Multi-channel skill** — General knowledge for dual-platform setup guidance.
- **Memory best practice** — steering rules: Decision (short) → soul.md (full) → skill (on-demand).
- **Configuration & commands docs** — complete fleet.yaml/classicBot.yaml reference + all slash commands.
- **Reply tool instruction** — all instances know to output "." after reply tool to avoid kiro-cli error.

### Fixed
- **TG ClassicBot chat-log** — non-@mention messages now correctly recorded (was empty due to text clearing).
- **TG ClassicBot bot reply logging** — agent outbound replies written to chat-log.
- **TG ClassicBot error notifications** — classic instances receive error alerts via routing table fallback.
- **Bot-to-bot @mention (TG)** — isBotMessage filter allows bot messages with @ourBot mention; Rich Message text extraction.
- **Duplicate general on add platform** — adopt unbound generals instead of creating duplicates.
- **`/restart` admin check** — mode:open no longer allows unauthorized users to restart fleet.
- **Discord `general_channel_id` required** — quickstart loops until provided (prevents broken routing).
- **Unclosed code fences** — stripped before CLI paste to prevent input hang.
- **TG `/chat` removed from menu** — not implemented for TG classic, use @mention instead.

### Changed
- **grammy 1.44.0** — upgraded for Bot API 10.1 support.
- **`assignTopicIds`** — uses `channel_id` → channels config type for platform detection (not name heuristic).

## [2.0.1] - 2026-06-15

### Added
- **Telegram Rich Messages** — grammy 1.44.0, auto-detects markdown tables/code blocks/headings → sendRichMessage with fallback.
- **`/update` + `/doctor` commands** — available in both TG and Discord (admin only). /doctor runs backend diagnostics.
- **systemd watchdog** — Type=notify, WatchdogSec=60, sd_notify via systemd-notify command.
- **Non-blocking startup** — generals start first → READY=1 → remaining instances in background.
- **Daily update check** — fleet daemon checks npm for new versions every 24h, notifies General.
- **Admin reject notification** — non-admin /start or /stop triggers notification to General with user info.
- **Workspace path guard** — create_instance rejects dangerous paths (`.`, `~`, `/`).
- **npm link auto-detect** — `agend update` detects and removes stale npm link before install.
- **install.sh link removal** — readlink fallback to detect npm-linked old versions.
- **Slash command prefixes** — [Fleet] / [ClassicBot] in TG+DC command descriptions.
- **kiro-cli error detection** — "having trouble responding" triggers rate_limit notification.
- **`/status` + `/sysinfo` rich tables** — markdown table output for TG Rich Message rendering.

### Fixed
- **systemd startup kill** — NotifyAccess=all + TimeoutStartSec=0 for 50+ instance fleets.
- **Classic group unbound message** — no longer shows "not bound to an instance" in classic groups.
- **`agend update` message** — says `agend start` instead of `agend fleet start`.
- **Collab empty log** — skip empty bot messages in collab chat log.
- **`/doctor` command path** — uses `agend backend doctor` with fleet default backend.

### Changed
- **Versioning** — jumped from v0.0.23 to v2.0.0. New versioning starts from v2.x.
- **PR flow** — all changes go through feature branch → PR → merge. Branch protection on main.
- **CI auto GitHub Release** — stable tags auto-create GitHub Release with generated notes.

## [2.0.0] - 2026-06-15

Same content as v0.0.23. Version bump to establish new major version baseline.

## [0.0.23] - 2026-06-12

### Added
- **Permissions matrix** — `docs/permissions.md` documents all commands × platforms × access levels.

### Fixed
- **TG classic `botUsername` never set on primary adapter** — `isBotMentioned` was always false. Now correctly sets `world.botUsername` in the `started` event handler and registers listeners before `adapter.start()`.
- **TG `/start@other_bot` triggers all bots** — commands with `@suffix` targeting another bot are now ignored entirely.
- **TG `/start` `/stop` `/raw` admin lock** — group-mode `/start` and `/stop` now require `admin_users`. `@bot /raw` also requires admin.
- **`allowed_guilds: {}` (non-array) breaks access** — non-array values are now treated as "allow all" instead of rejecting everything.

## [0.0.22] - 2026-06-12

### Fixed
- **Classic instance proactive reply** — daemon no longer blocks `reply` tool when no prior inbound message exists. Fleet-manager's classicBot channelId fallback now correctly routes outbound messages.

## [0.0.21] - 2026-06-12

### Added
- **Mention rules in fleet instructions** — all instances now know how to `<@USER_ID>` mention Discord users/bots and `@username` for Telegram. Extracted from `id:` field in inbound messages.

## [0.0.20] - 2026-06-12

### Added
- **User ID in inbound messages** — format now includes `id:USER_ID` for mention support. Agents can `<@ID>` to mention Discord users or use Telegram mention syntax.

### Fixed
- **Classic instance reply fallback** — classic channel agents can now reply even after fleet restart. Falls back to `classicBot.yaml` channelId when `topic_id` is unavailable.

## [0.0.19] - 2026-06-11

### Fixed
- **agy model discovery skill** — clarify that effort suffix (Medium/High/Low/Thinking) is not part of the model name.

## [0.0.18] - 2026-06-11

### Added
- **Model compatibility check** — `defaults.model` only applies to backends that recognize the model name pattern. Incompatible models are silently skipped (e.g. `claude-opus-4.6` won't be passed to Codex).

## [0.0.17] - 2026-06-11

### Added
- **Antigravity CLI backend** — full support for Google's `agy` CLI. Uses CLI mode by default (no MCP). Non-hidden workspace at `~/agend-workspaces/`, instructions in `.agents/agents.md`, trust prompt auto-dismiss.
- **IPC + adapter auto-reconnect** — IPC disconnect retries with exponential backoff then every 60s indefinitely. Adapter fatal errors (Telegram polling init, Discord gateway) also auto-restart with same strategy. Dead tmux panes are auto-respawned.
- **Beta update channel** — `agend update --beta` installs from `@beta` npm dist-tag. CI publishes with `--tag beta` when git tag contains `-beta`.
- **PSS memory reporting** — `agend ls` uses Proportional Set Size from `/proc/<pid>/smaps_rollup` instead of RSS to avoid shared page double-counting.
- **Parallel instance stop** — shutdown uses concurrency 5 for faster fleet stop. Systemd timeout extended accordingly.
- **Configurable context_lines** — per-channel chat log injection depth in classicBot.yaml. Set 0 to disable.
- **Model support in classicBot.yaml** — per-channel model override.
- **Access mode "open"** — allows all users without an allowlist.
- **Fleet memory total** — `agend ls` footer shows instance count and total memory.
- **`agend update` command** — full lifecycle: sudo/nvm detection, npm install, service restart, health check.
- **GitHub Actions CI/CD** — ci, publish, and gitleaks workflows.
- **Workspace git init** — auto-created workspaces get `git init` for CLI backend project root detection.
- **`/agent` endpoint auth bypass** — POST /agent uses instance-level token, skips web UI token check.
- **agy `--model` flag** — pass model selection to antigravity CLI.
- **General-knowledge refactor** — split into `steering/` (always loaded core rules) + `skills/` (on-demand with YAML frontmatter). Reduces General's default context usage.
- **Dynamic model discovery** — skills teach General to run CLI commands (`agy models`, `/model`) instead of hard-coded model lists.

### Fixed
- Install script: auto-detect sudo, nvm-aware PATH, build-essential for native modules, /usr/local/bin symlinks only as root.
- Discord: stickers no longer treated as photo attachments; collab mode chat log includes attachment filenames.
- Daemon: unified log rotation; stale context rotation references removed from prompts.
- Update: kill old fleet process before restart; run daemon-reload before systemctl restart.
- Discord react: use `threadId` instead of `chatId` (guild ID) for 👀, ⏳, ✅ reactions.
- `agend update` restart: add `reset-failed` before `systemctl start` to handle post-kill failed state.
- Cross-instance silence: allow agents to stay silent when they have nothing to add.
- Default `context_lines` reduced from 10 to 5.

### Performance
- Parallel instance stop with concurrency 5.
- Staggered restart notifications.
- Discord `react()` uses single REST PUT instead of 3 sequential API calls (fetchChannel → fetchMessage → react). ~1s → ~300ms.
- 👀 auto-react moved before `setTopicIcon`/`archive`/`processAttachments` for instant feedback.

### Deprecated
- **gemini-cli** — sunset 2026-06-18. Warning shown on fleet start.

## [1.24.0] - 2026-04-21

### Added
- **Discord quickstart UX** — plugin check, channel selection, options output.

### Fixed
- Health check stops when instance directory is removed externally.
- NaN crash on non-numeric input; plugin check uses `npm list -g`.

## [1.23.0] - 2026-04-20

Phase 1–4 of the security/reliability fix plan (`docs/fix-plan.md`) closes here. 36 individual fixes/refactors across 7 PRs (#33, #38, #39, #40, #41, #42, #43, #44).

### Security
- **Phase 1 boundaries** (PR #33) — per-instance `/agent` token, zod validation on all `/ui/*` mutations, template var sanitization, tar entry validation, symlink resolution for `project_roots`, branch/logPath argument injection hardening, `web.token` 0o600.
- **Telegram apiRoot allowlist** (P3.3, `9a7b16b`) — prevents bot-token exfil via attacker-controlled `apiRoot`.
- **Webhook HMAC-SHA256 signing** (P3.1, `e65b97c`) — outbound webhooks now signed; receivers can verify origin.
- **STT requires explicit opt-in** (P3.4, `1fc513e`) — voice transcription no longer activates from env var alone; needs `stt.enabled: true` in `fleet.yaml`.
- **`/update` hardened** (P3.6, `740c202`, `d38a583`) — empty `allowed_users` rejects `/update` entirely; two-step token confirm (8 hex, 60s TTL); version pin during install; auto-rollback on health check fail; supersede notifications.
- **`access-path` rejects path traversal in instance names** (P4.3, `d5d41b7`) — whitelist `^[A-Za-z0-9._-]+$`, rejects `..` / `/` / `\` / NUL.
- **`.env` file mode 0o600** (P4.4, `49a4328`) — wizard writes credential files with restrictive permissions + chmod fallback.
- **CORS tightened, Bearer auth supported** (P3.5, `b180232`) — wildcard CORS removed; web API accepts `Authorization: Bearer <token>` header.
- **`paths.ts` md5 → sha256** (P4.5, `1f91c3c`) — eliminates FIPS / scanner alerts. Custom `AGEND_HOME` users will see tmux session/socket suffix change once on upgrade.

### Fixed
- **Telegram 409 polling cap** (P3.2, `c67f776`) — caps retries to 30 to prevent infinite poll loops.
- **Topic archiver persistence** (P2.6, `f134a66`, `42d5d1f`) — archived topic state now persists across restarts via atomic write of `<dataDir>/archived-topics.json`.
- **IPC single-line buffer cap 10MB → 1MB** (P3.7, `d446384`) — overflow rejected with structured error instead of OOM.
- **Tmux pane cache invalidation on control-mode reconnect** (P2.1, `e967bbb`).
- **TranscriptMonitor reentry guard** (P2.4, `65be144`) — prevents overlapping `pollIncrement` runs.
- **Scheduler catch-up for missed runs within 24h** (P2.3, `01e1e32`, `24d6f8a`).
- **Cost-guard daily-cap reset on session rotation** (P2.2, `875a0b2`) — `warnEmitted`/`limitEmitted` flags now reset properly so post-rotation sessions don't silently exceed daily cap.
- **SSE dead client eviction + socket error handling** (P2.5, `ae2a810`) — `broadcastSseEvent` no longer breaks the loop on a dead client write; `req.on("error")` now cleans up client set on ECONNRESET.
- **Drop redundant sleep+reconnect after instance start** (P2.7, `872547b`) — `startInstance` await chain already guarantees IPC ready; secondary `connectIpcToInstance` was pure dead code.
- **Cost-guard DST handling** (P2.8, `3c9ff9f`) — `msUntilMidnight` now uses `Intl.DateTimeFormat` + binary search instead of `setHours(24,0,0,0)`, so DST spring/fall transitions don't shift the daily reset by ±1h.
- **MessageQueue flood-control backoff reset** (P3.8, `3474c04`) — backoff now actually resets after status_update drop instead of staying at ~30s.

### Changed
- **`fleet-manager.ts` decomposed** (P4.1, PR #43) — 2842 → 1658 lines (-1184). Four new modules:
  - `fleet-dashboard-html.ts` (442 lines) — dashboard HTML constant
  - `fleet-instructions.ts` (168 lines) — `GENERAL_INSTRUCTIONS` + `ensureGeneralInstructions`
  - `fleet-rpc-handlers.ts` (387 lines) — IPC + HTTP CRUD dispatch
  - `fleet-health-server.ts` (326 lines) — `startHealthServer` + `getUiStatus` + `extractWebToken`

  All modules use a Context-injection pattern: each declares a narrow `XxxContext` interface, FleetManager `implements` it, and exported functions take `this` as their first arg.
- **`daemon.handleToolCall` factored** (P4.2, `e6a9596`) — extracted `dispatchFleetRpc(fleetReqId, broadcast, timeoutMs, timeoutMessage, respond)` helper. `handleToolCall` 182 → ~120 lines, daemon.ts -51 lines net.
- **`validateTimezone` unified** (P4.4, `49a4328`) — `scheduler/scheduler.ts` no longer duplicates the validator; imports the canonical version from `config.ts`.

### Docs
- **`docs/fix-plan.md` Phase 1–4 closed** — all P-items either ✅ or moved to **Deferred / Future Work** (logger rotation, cost-guard tiebreaker — both feature-class, not fix-class).
- **`docs/p4.1-split-plan.md` archived** — record of the four-module decomposition strategy.
- **`docs/issue-evaluations.md` added** — analysis of open issues #24 (usage-limit notify) and #8 (default topic preset) with effort/tradeoff breakdowns for future planning.

## [1.22.1] - 2026-04-19

### Fixed
- **Discord attachment download** — `downloadAttachment()` now actually works. Attachments are fetched from the Discord CDN and written to `inboxDir` during `messageCreate` (before the CDN URL expires), and `downloadAttachment()` returns the local path. Also: image attachments are classified as `photo` (enables auto-download on the agent side), filenames are prefixed with the Discord attachment ID to prevent collisions, downloads run in parallel across a message's attachments, failures are logged instead of silently swallowed, and `stop()` cleans up any undrained files. Closes #27.

## [1.22.0] - 2026-04-18

### Added
- **`agend ls` shows Kiro CLI context usage** — for instances running Kiro backend, the listing now reports current context window consumption alongside the other status columns.
- **`agend ls` shows system memory usage** — top-of-listing summary includes host memory pressure so fleet operators can spot memory-starved boxes at a glance.
- **Install script WSL detection** — `install.sh` now detects WSL and avoids picking up a Windows-side `node` on the Linux PATH, which previously caused silent failures during first-run setup.

### Changed
- **Install script URL uses GitHub Pages** — README one-liner points at `https://suzuke.github.io/AgEnD/install.sh` (the official hosted copy) instead of a raw GitHub URL.

### Docs
- **Install one-liner surfaced in both READMEs and the website hero** — previously only documented in the CHANGELOG.
- **WSL installation notes added to README**.
- **Website zh-TW hero tightened** — dropped shipping-speak (`交付`) in favor of dispatcher vocabulary consistent with the rest of the page.

## [1.21.7] - 2026-04-17

### Changed
- **MCP tool schemas unified on zod** — every outbound tool now has a zod schema in `src/outbound-schemas.ts`; `src/channel/mcp-tools.ts` derives `inputSchema` via `z.toJSONSchema()`. Hand-written JSON Schema removed. Required fields now reject empty strings (`minLength: 1`) where the old handlers relied on truthy checks.
- **Outbound handlers validate at entry** — all 18 handlers in `src/outbound-handlers.ts` run `safeParse` before doing work; the ~35 unchecked `args.X as string` casts are gone. `wrapAsSend` also takes a schema, so `request_information` / `delegate_task` / `report_result` get the same guarantees.

## [1.21.6] - 2026-04-17

### Security
- **Web API surface hardening** (H1, H2, H7)
- **Auth, path safety, and leak fixes** across the daemon (H3, H4, H5, H6)
- **Backend command hardening** — model name validation and env value quoting in `buildCommand()`
- **CLI helpers** — avoid shell invocation and redact tokens from `ps` output
- **Scheduler hardening** — timezone whitelist, file count cap, lightweight mode guard
- **Kiro MCP wrapper permissions** — `wrapper.sh` tightened to `0o700` (owner-only)
- **Outbound error sanitization** — tool errors returned to agents strip `$HOME` paths and truncate at 300 chars before exposure

### Fixed
- **Discord expired interaction crash** — adapter now catches expired-interaction errors to prevent daemon crash (upstream PR #26)
- **Scheduler overlapping fires** — atomic update prevents double-firing when two ticks race

### Changed
- **Fleet-manager error observability** — previously swallowed errors are now logged; adapter notices promoted to higher severity

## [1.21.5] - 2026-04-15

### Added
- **Error state warning on `send_to_instance`** — when the target instance is rate-limited, paused, or in crash loop, the sender receives a warning in the tool response (#24)
- **Codex weekly limit detection** — detects "less than N% of your weekly limit" warning and notifies via Telegram (action: notify)

### Fixed
- **MCP server orphan detection via ppid polling** — primary orphan detection now uses `process.ppid` polling (5s interval) instead of stdin EOF, which fails on macOS due to a libuv/kqueue bug that causes CPU spin instead of emitting `'end'`
- **Fleet-level tmux server circuit breaker** — 2+ tmux server crashes in 5 minutes pauses all instance respawns for 30s, preventing thundering herd
- **Process tree kill on spawn failure** — `killProcessTree()` sends SIGTERM to the entire process group (CLI + MCP server) before killing the tmux window
- **Sliding window crash detection** — replaced `rapidCrashCount` (broken by backoff delays > 60s) with `crashTimestamps` sliding window: 3+ crashes in 5 minutes triggers pause

## [1.21.4] - 2026-04-14

### Fixed
- **MCP server orphan cleanup on crash respawn** — daemon reads `channel.mcp.pid` and kills orphan MCP server before spawning new CLI
- **stdin EOF detection for MCP server** — added `process.stdin.on('end'/'close'/'error')` listeners and PID file mechanism (later superseded by ppid polling in v1.21.5)

## [1.21.3] - 2026-04-14

### Fixed
- E2E: mock CLI crash should exit with code 1, not 0

## [1.21.2] - 2026-04-13

### Fixed
- **Delay writing prev-instructions until session established** — prevents change detection from failing on retry when first spawn attempt fails
- E2E: update workflow-template test assertions for new heading behavior

## [1.21.1] - 2026-04-13

### Fixed
- **Kiro CLI 2.0.0 support** — updated ready pattern and startup dialogs for new TUI; fixed false "not found" match

## [1.21.0] - 2026-04-13

### Added
- **CLI mode** — `agent_mode: cli` config switches from MCP tools to HTTP-based agent CLI endpoint
- **Agent CLI endpoint** — HTTP-based alternative to MCP tools for backends that don't support MCP well
- **Idle task nudge** — automatically nudges idle instances with pending tasks from the task board

### Fixed
- Kiro: auto-dismiss trust-all-tools TUI confirmation on startup
- OpenCode: don't add `--continue` when skipResume is true

## [1.20.4] - 2026-04-12

### Added
- **Auto-dismiss interactive prompts** — backend-defined startup and runtime dialogs are automatically dismissed (trust folders, resume pickers, rate limit model switches)
- **systemPrompt file: paths** — supports comma-separated `file:` paths and YAML arrays for multi-file prompt modularization

### Fixed
- Claude Code: add session resume prompt to startup dialogs
- Instructions: avoid empty Development Workflow heading when workflow content has its own headers
- Handle EADDRINUSE on health server — kill old process and retry
- Discord onboarding: 10 UX pain points fixed
- Kiro: use single-quoted env exports in MCP wrapper to prevent backtick/dollar interpretation

## [1.20.2] - 2026-04-11

### Added
- **`agend health`** — fleet health diagnostics via HTTP endpoint (`/health`, `/status`)
- **Communication efficiency rules** in workflow template — structured task flow, silence = agreement, batch points

### Fixed
- OpenCode skipResume not honored + restart notification mismatch
- Safe worktree cleanup when directory is not a valid git worktree

### Changed
- Communication protocol refactored — reduce ack spam with structured task flow

## [1.20.0] - 2026-04-10

### Added
- **`replace_instance` tool** — atomically replace an instance with a fresh one, collecting handover context from the daemon's ring buffer
- **ContextGuardian simplified** — removed max_age timer, state machine, and all restart triggers. Pure monitoring only.

### Fixed
- Skip snapshot injection when `--resume` succeeds on crash recovery
- Clean stale MCP entries on instance removal + writeConfig

## [1.19.1] - 2026-04-10

### Fixed
- **3 UX pain points** — instructions reload on restart, config reload on single instance restart, Web UI create instance missing fields

## [1.19.0] - 2026-04-09

### Added
- **Fleet templates** — `deploy_template` / `teardown_deployment` / `list_deployments` for reusable fleet configurations
- **Configurable staggered startup** — `startup.concurrency` and `startup.stagger_delay_ms` in fleet.yaml defaults
- **Backend column** in fleet status and MCP `list_instances`

### Changed
- `agend logs` consolidated — reads fleet.log directly
- `agend fleet status` and `agend ls` merged into single command

### Fixed
- Clean up orphaned tmux windows on fleet startup
- Prevent quit command race condition during fleet stopAll

## [1.18.0] - 2026-04-08

### Added
- **Unified additive system prompt injection** — all 5 backends now use `--append-system-prompt-file` (Claude Code), steering files (Kiro), or equivalent. Fleet instructions no longer override built-in prompts.

### Fixed
- Always kill tmux window on instance stop/delete
- OpenCode uses "instructions" not "contextPaths" in opencode.json

## [1.17.5] - 2026-04-08

### Added
- **Crash output capture** — captures tmux pane content on crash for diagnostics
- **tmux server crash detection** — distinguishes server-level crash from single window crash

### Fixed
- Kiro MCP env isolation — wrapper script approach replaces process.env pollution
- Kiro MCP transport handshake failure — stdin race condition
- Graceful shutdown via quit command before killing tmux window
- Distinguish normal exit (code 0) vs crash by exit code in health check
- Pre-trust codex workspace + add trust dialog pattern
- Fleet start `--instance` delegates to running daemon via HTTP API

## [1.17.3] - 2026-04-07

### Added
- **Per-instance memory usage** in `agend ls`
- **Channel-aware replies** — pass source in inbound meta + fix format passthrough

### Fixed
- Codex MCP shell escaping + stale snapshot injection on restart

## [1.17.1] - 2026-04-07

### Added
- **tmux socket isolation** for custom AGEND_HOME — prevents conflicts between multiple AgEnD installations

## [1.17.0] - 2026-04-07

### Added
- **`AGEND_HOME` env var** — configurable data directory (default: `~/.agend`)

### Fixed
- Kiro CLI crash loop on restart — skipResume + tmux cleanup

## [1.16.2] - 2026-04-07

### Fixed
- Crash respawn orphan cleanup must not block spawnClaudeWindow

## [1.16.1] - 2026-04-07

### Fixed
- Prevent tmux server death during concurrent context rotation
- P2 code review improvements

## [1.16.0] - 2026-04-07

### Fixed
- P0+P1 code review findings (security, error handling, edge cases)

## [1.15.8] - 2026-04-06

### Fixed
- Codex uses `resume --last` (per-CWD scoped, no SQLite dependency)

## [1.15.6] - 2026-04-06

### Fixed
- Kiro resume uses boolean `--resume` flag

## [1.15.5] - 2026-04-06

### Fixed
- Error monitor scans only after last prompt marker (reduces false positives)

## [1.15.3] - 2026-04-06

### Fixed
- stop() cleanup + IPC reconnect on restart (#14, #12)

## [1.15.1] - 2026-04-06

### Added
- **Auto-inject active decisions** into MCP instructions via env var
- `/update` topic command for refreshing instance configuration

## [1.15.0] - 2026-04-06

### Added
- Webhook notifications for fleet events (rotation, hang, cost alerts)
- HTTP health endpoint (`/health`, `/status`) for external monitoring
- Structured handover template with validation and retry on context rotation
- Permission relay UX improvements (timeout countdown, "Always Allow" persistence, post-decision feedback)
- Topic icon auto-update (running/stopped) + idle archive
- Filter out Telegram service messages (topic rename, pin, etc.) to save tokens

### Changed
- **Crash recovery tries --resume first** — on crash respawn, attempts `--resume` to restore full conversation history before falling back to fresh session + snapshot injection

### Fixed
- Minimal `claude-settings.json` — only AgEnD MCP tools in allow list, no longer overrides user's global permission settings

## [1.14.0] - 2026-04-07

### Added
- **Plugin system + Discord adapter extraction** — Discord adapter moved to standalone `agend-plugin-discord` package; factory.ts supports `agend-plugin-{type}` / `agend-adapter-{type}` / bare name conventions; main package exports (`/channel`, `/types`) enable third-party plugins
- **Web UI Phase 2: full control dashboard** — instance stop/start/restart/delete with name confirmation, create instance form (directory optional, backend auto-detect), task board CRUD, schedule management, team management, fleet config editor (form-based with sensitive field masking)
- **Web UI layout: Fleet vs Instance** — sidebar "Fleet" entry for fleet-level tabs (Tasks, Schedules, Teams, Config); instance tabs limited to Chat + Detail; cross-navigation links between fleet and instance views
- **Web UI UX improvements** — toast notifications, loading states, cron human-readable descriptions, larger status dots, empty state guidance, cost labels, website-consistent styling (#2AABEE accent, Inter + JetBrains Mono fonts)
- **Backend auto-detection** — `GET /ui/backends` scans PATH for installed CLIs; Create Instance dropdown shows installed/not-installed status
- **Instance-specific restart** — `agend fleet restart <instance>` via fleet HTTP API (`POST /restart/:name`)
- **Bootstrap install script** — `curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash`
- **project_roots enforcement** — `create_instance` rejects directories outside configured roots

### Fixed
- **Web UI reply context** — first web message no longer causes "No active chat context"; uses real Telegram group_id/topic_id
- **Web↔Telegram bidirectional sync** — web messages forwarded to Telegram with `🌐` prefix; Telegram messages pushed to Web UI via SSE
- **SSE instant status refresh** — action buttons update immediately after stop/start/restart/delete
- **.env override** — `.env` file values unconditionally override inherited shell environment variables
- **tmux duplicate session race** — `ensureSession()` handles concurrent parallel startup
- **Create Instance form** — directory optional with dynamic topic_name requirement

### Changed
- **discord.js removed from core dependencies** — only needed when `agend-plugin-discord` is installed
- **Web API extracted to `web-api.ts`** — reduces fleet-manager.ts size; all `/ui/*` routes in dedicated module
- **Auth unified** — all Web UI endpoints (including restart) require token authentication

## [1.13.0] - 2026-04-06

### Added
- **Web UI Phase 2: full control dashboard** — create/delete instances, task board CRUD (create, claim, complete), schedule management (create, delete), team management (create with member checkboxes, delete), fleet config viewer (read-only, sanitized)
- **Web UI styling** — aligned with website design: Telegram blue `#2AABEE` accent, Inter + JetBrains Mono fonts, dark theme, rounded cards, toast notifications, loading states
- **Bootstrap install script** — `curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash` for one-line setup (Node.js via nvm, tmux, agend, backend detection)
- **project_roots enforcement** — `create_instance` rejects directories outside configured `project_roots` boundary
- **Auth unification** — all Web UI endpoints (including restart) require token authentication

### Fixed
- **Web UI reply context** — first message from Web UI no longer causes "No active chat context" error; uses real Telegram group_id/topic_id
- **Instant status refresh** — instance action buttons update immediately after stop/start/restart/delete via SSE
- **Web↔Telegram bidirectional sync** — web messages forwarded to Telegram topic with `🌐` prefix; Telegram messages pushed to Web UI via SSE

### Documentation
- Full documentation audit: 20+ missing features added across all docs
- Website redesigned with Spectra-inspired dark-first design

## [1.12.0] - 2026-04-06

### Added
- **Web UI dashboard** — `agend web` launches browser-based fleet monitoring with live SSE updates and integrated chat UI with bidirectional Telegram sync
- **agend quickstart** — simplified 4-question setup wizard replacing `agend init` as the recommended onboarding path
- **project_roots enforcement** — `create_instance` validates working directory is under configured `project_roots` boundary
- **HTML Chat Export** — `agend export-chat` exports fleet activity as self-contained HTML with date filtering (`--from`, `--to`)
- **Mirror Topic** — `mirror_topic_id` config for observing cross-instance communication in a dedicated topic

### Fixed
- **Parallel startup** — handle tmux duplicate session race when spawning many instances simultaneously
- **.env priority override** — `.env` file values now properly override inherited shell environment variables
- **Web UI chat sync** — bidirectional message sync between Web UI and Telegram

### Documentation
- README revamped with hero section, feature highlights, architecture diagram, and "How it works" flow
- Quick Start updated to use `agend quickstart` command
- Full documentation audit: features.md, cli.md, configuration.md updated with all v1.11.0-v1.12.0 features

## [1.11.0] - 2026-04-05

### Added
- **Kiro CLI backend** — new backend for AWS Kiro CLI (`backend: kiro-cli`). Session resume, MCP config, error patterns, models: auto, claude-sonnet-4.5, claude-haiku-4.5, deepseek-3.2, and more
- **Built-in workflow template** — fleet collaboration workflow auto-injected via MCP instructions. Configurable via `workflow` field in fleet.yaml (`"builtin"`, `"file:path"`, or `false`)
- **Workflow split: coordinator vs executor** — General instance gets full coordinator playbook (Choosing Collaborators, Task Sizing, Delegation Principles, Goal & Decision Management). Other instances get slimmed executor workflow (Communication Rules, Progress Tracking, Context Protection)
- **`create_instance` systemPrompt parameter** — agents can pass custom system prompts when creating instances (inline text only)
- **Fleet ready Telegram notifications** — `startAll` and `restartInstances` send "Fleet ready. N/M instances running." to General topic with failed instance reporting
- **E2E test framework** — 79+ tests running exclusively in Tart VMs. Mock backend with `pty_output` directive for error simulation. T15 workflow template tests, T16 failover cooldown tests
- **Token overhead measurement** — test script (`scripts/measure-token-overhead.sh`) and report. Full profile: +887 tokens (0.44% of 200K context, $0.003/msg)
- **Codex usage limit detection** — "You've hit your usage limit" error pattern (action: pause)
- **MockBackend error patterns** — `MOCK_RATE_LIMIT` and `MOCK_AUTH_ERROR` for E2E testing

### Fixed
- **Crash recovery snapshot restore** — write snapshot on crash detection (not just context rotation); replace single-consume file deletion with in-memory `snapshotConsumed` flag so file persists for daemon restart recovery (#11 related)
- **Codex session resume** — `CodexBackend.buildCommand()` now uses `codex resume <session-id>` when session-id file exists (#11)
- **Rate limit failover loop** — 5-minute cooldown on failover-type PTY errors prevents repeated triggering when error text persists in terminal buffer (#10)
- **PTY error monitor hash dedup** — record pane hash at recovery time; suppress same error on same screen to prevent stale re-detection loops
- **CLI restart wait** — replace fixed 1s delay between bootout/bootstrap with dynamic polling (up to 30s) for process exit. Fixes "Bootstrap failed: Input/output error" with many instances
- **CLI attach interactive selection** — fuzzy match ambiguity now shows numbered menu instead of error
- **CLI logs ANSI cleanup** — enhanced `stripAnsi()` handles cursor movement, DEC private modes, carriage returns, and remaining control characters
- **`reply_to_text` in agent messages** — user reply-to context now included in formatted messages pasted to agent
- **General instructions per-backend** — auto-create writes correct file based on `fleet.defaults.backend` (CLAUDE.md, AGENTS.md, GEMINI.md, .kiro/steering/project.md)
- **General instructions on every start** — `ensureGeneralInstructions()` called on every `startInstance` for general_topic instances, not just auto-create
- **Builtin text English-only** — all system-generated text translated from Chinese to English (schedule notifications, voice message labels, general instructions)
- **General delegation principles** — rewritten for coordinator role: delegate proactively with specific conditions instead of "do it yourself"

### Changed
- Fleet start/restart notifications unified to "Fleet ready. N/M instances running." format, sent to General topic
- `buildDecisionsPrompt()` dead code removed (intentionally disconnected in v1.9.0)
- `getActiveDecisionsForProject()` removed from fleet-manager (dead code)

### Documented
- OpenCode MCP instructions limitation (v1.3.10 doesn't read MCP instructions field)
- Kiro CLI MCP instructions limitation (unverified)
- Token overhead report (EN + zh-TW) with reproducible test script

## [1.10.0] - 2026-04-05

_Intermediate release, changes included in 1.11.0 above._

## [1.9.1] - 2026-04-03

### Fixed
- Session snapshot now injected on health-check respawn — crash/kill recovery also gets context restored
- Snapshot paste includes "do NOT reply" instruction to prevent model from attempting an IPC reply that times out

## [1.9.0] - 2026-04-03

### Breaking Changes
- **System prompt injection replaced with MCP instructions.** Fleet context, custom `systemPrompt`, and collaboration rules are now injected via MCP server instructions instead of CLI `--system-prompt` flags. This change was necessary because:
  - Claude Code: `--system-prompt` was passed a file path as literal text instead of file contents — the fleet prompt was **never correctly injected** since inception
  - Gemini CLI: `GEMINI_SYSTEM_MD` overwrites the built-in system prompt and breaks skills functionality
  - Codex: `.prompt-generated` was dead code — written to disk but never read by the CLI
  - OpenCode: `instructions` array was overwritten instead of appended, breaking existing project instructions
- **Impact on existing setups:**
  - `fleet.yaml` `systemPrompt` field is preserved — it now injects via MCP instructions instead of CLI flags
  - `.prompt-generated`, `system-prompt.md`, `.opencode-instructions.md` files are no longer generated
  - Each CLI's built-in system prompt is no longer overridden or modified
  - Active Decisions are no longer preloaded into the system prompt — use `list_decisions` tool on demand
  - Session snapshots (context rotation) are now delivered as the first inbound message (`[system:session-snapshot]`) instead of being embedded in the system prompt

## [1.8.5] - 2026-04-03

### Fixed
- Unified log and notification format to `sender → receiver: summary` style across all cross-instance messages
- Task/query notifications now show the full message body; report/update notifications show only the summary

## [1.8.4] - 2026-04-03

### Fixed
- Cross-instance notification format: `sender → receiver: summary` for clarity
- General Topic instances no longer receive cross-instance notification posts
- Reduced cross-instance notification noise — sender topic post removed; target notification uses `task_summary` when available

## [1.8.3] - 2026-04-03

### Added
- **Team support** — named groups of instances for targeted broadcasting
  - `create_team` — define a team with members and optional description
  - `list_teams` — list all teams with member details
  - `update_team` — add/remove members or update description
  - `delete_team` — remove a team definition
  - `broadcast` now accepts a `team` parameter to target all members of a named team
  - `teams` section in `fleet.yaml` for persistent team definitions

## [1.8.2] - 2026-04-03

### Added
- `working_directory` is now optional in fleet.yaml — auto-created at `~/.agend/workspaces/<name>` when missing
- `create_instance` `directory` parameter is now optional (auto-workspace created when omitted)

### Fixed
- Context-bound routing now runs before IPC forwarding in topic mode (prevented "chat not found" errors)
- Telegram: `thread_id=1` correctly treated as General Topic (no message thread)
- Scheduler initializes before instances start, so active decisions load correctly on fleet spawn

## [1.8.1] - 2026-04-03

### Added
- `reply`, `react`, `edit_message` are now context-bound — `chat_id` and `thread_id` are no longer required in tool calls; the daemon fills them from the active conversation context
- Backend error pattern detection via PTY monitoring — auto-notify on rate limits, auth errors, and crashes
- Auto-dismiss runtime dialogs (e.g. Codex rate limit model-switch prompts)
- Model failover — auto-switch to backup model on rate limit (statusline + PTY detection)

### Fixed
- Recovery notification sent after PTY error monitor detects and handles an error
- Error monitor false positives reduced; invalid `chat_id` auto-corrected from context

## [0.3.7] - 2026-03-27

### Added
- `delete_instance` MCP tool for removing instances
- `create_instance --branch` — git worktree support for feature branches
- External adapter plugin loading — community adapters via `npm install ccd-adapter-*`
- Export channel types from package entry point for adapter authors
- Discord adapter (MVP) — connect, send/receive messages, buttons, reactions
- Per-instance restart notifications in Telegram topics after graceful restart

### Fixed
- `start_instance`, `create_instance`, `delete_instance` added to permission allow list
- Worktree instance names use `topic_name` instead of directory basename to avoid Unix socket path overflow (macOS 104-byte limit)
- `create_instance` with branch no longer triggers false `already_exists` on base repo
- postLaunch stability check replaced with 10s grace period
- Restart notification uses `fleetConfig.instances` + IPC push
- Discord adapter TypeScript errors resolved

## [0.3.6] - 2026-03-27

### Fixed
- Prevent MCP server zombie processes on instance restart
- Harden postLaunch auto-confirm against edge cases

## [0.3.5] - 2026-03-26

### Added
- Per-instance model selection via `create_instance(model: "sonnet")`
- Instance `description` field for better discoverability in `list_instances`
- Auto-prune stale external sessions from sessionRegistry (every 5 minutes)
- AgEnD landing page website (Astro + Tailwind, bilingual EN/zh-TW)
- GitHub Actions workflow for website deployment
- Security considerations section in README

### Changed
- Simplify model selection — only configurable via `create_instance`, not per-message
- Use single `query_sessions_response` for session pruning

### Fixed
- Security hardening — 10 vulnerability fixes (path traversal, input validation, etc.)
- Send full cross-instance messages to Telegram instead of 200-char preview truncation
- Remove IPC secret auth — socket `chmod 0o600` is sufficient and simpler

## [0.3.4] - 2026-03-26

### Changed
- Remove slash commands (`/open`, `/new`, `/meets`, `/debate`, `/collab`) — General instance handles project management via `create_instance` / `start_instance`
- Remove dead code: `sendTextWithKeyboard`, `spawnEphemeralInstance`, meeting channel methods

## [0.3.3] - 2026-03-25

### Fixed
- Correct `statusline.sh` → `statusline.js` in test assertion

## [0.3.2] - 2026-03-25

### Added
- Channel adapter factory with dynamic import for future multi-platform support
- Intent-oriented adapter methods: `promptUser`, `notifyAlert`, `createTopic`, `topicExists`
- "Always Allow" button on Telegram permission prompts
- Per-instance `cost_guard` field in InstanceConfig
- `topology` property on ChannelAdapter (`"topics"` | `"channels"` | `"flat"`)

### Changed
- Channel abstraction Phase A — remove all TelegramAdapter coupling from business logic (fleet-manager, daemon, topic-commands now use generic ChannelAdapter interface)
- CLI version reads from package.json instead of hardcoded value
- Schedule subcommands now have `.description()` for help text

### Fixed
- Shell injection in statusline script — replaced bash with Node.js script
- Timezone validation in setup wizard and config (Intl.DateTimeFormat)
- `max_age_hours` default aligned to 8h across setup-wizard, config, and README
- `pino-pretty` moved from devDependencies to dependencies (fixes `npm install -g`)
- `toolStatusLines` cleared on respawn to prevent unbounded growth
- Try-catch for `--config` JSON.parse in daemon-entry
- Dead code `resetToolStatus()` removed
