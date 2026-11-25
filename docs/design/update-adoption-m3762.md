# Updates people actually take (M-3762)

**Status:** design, revision 3. It folds in Lumen's and Prism's reviews of revisions 1 and 2 (§10). The user approves it before any code.
**Asked by:** the user, 11-25, through the leader.
- Most people don't know `/update`.
- Like Windows Update, they press "Later": they fear their agents' work will stop or that the update will break something.
- The web has an update notice; General's is easy to miss.

The user wants:
- **(A)** a one-press update they can trust;
- **(C)** an update that is required below a minimum version.

The leader added triggers, a pre-flight check and never-auto rules.

**In short**
- **One card per fleet**, in General's chat and on the web, edited to the newest version. Its main button is **Update when idle**. The card says two things, and both are true for that machine:
  - your agents finish what they're doing, then AgEnD restarts for a few minutes and they carry on;
  - where the setup allows it, a new version that doesn't start properly is replaced by the old one again.
- **Pre-flight** decides what this machine may do:
  - **update by itself** (scheduled, required, automatic);
  - **only on an admin's press**, with honest words about what isn't protected;
  - **not at all**: the identity of the install or its data can't be proven.
  It always says why, and what to fix.
- **Phase 1 changes words and timing only, not the machinery.** The card, a wait for idle on the queue that exists, a server-side **Not now**, and only the promises today's updater already keeps.
- **Phase 2 makes the stronger promise true:**
  - a quiescence barrier;
  - one coherent snapshot, taken while no writer runs;
  - a quarantined trial of the new version, with no outside effects;
  - an attempt journal that survives the rollback.
- **A signed release index**, published with every release, lets a fleet learn about newer builds without installing them. It covers:
  - known-bad versions and the security floor: a required update, which can't be deferred past its deadline;
  - CLI drift, from each build's audited-CLI ledger;
  - what a Hub needs;
  - how far behind the fleet is (a reminder only).
  The index binds the exact package bytes, only ever moves forward, and fails safe: if it is unverified, the fleet is notified and nothing is forced.

---

## 1. Today: the inventory

Captures are from the real web app, en and zh-TW, desk and phone. They are in `docs/evidence/update-surfaces-m3762/`, made by `scripts/manual/update-surfaces-m3762/capture.mts` at `592178b52` (`src` clean, 20/20). The page draws each state from the server's own `/ui/update` shape; nothing is installed.

### 1.1 How a new version is found
- `npm view @songsid/agend version` (`dist-tags` for a prerelease) runs once an hour after start, then every 24 h (`fleet-manager.ts` `checkForUpdates`). An admin can also press **Check for updates**, at most once a minute.
- The channel comes from the installed version: alpha → `@alpha`, other prereleases → `@beta`, a release → `@latest` (`update-check.ts` `installedChannel`).
  - A beta is never offered a stable.
  - An alpha is shown a newer stable but can't install it from the web or chat.
- The result is kept **in memory only**, so a restart forgets it until the next check.
- **There is no setting** for automatic updates, the channel or the check interval.

### 1.2 Where it is shown

| Surface | Who | What it says (en / zh-TW) | What the button does | Capture |
|---|---|---|---|---|
| **General's topic post** (Discord/Telegram) | Everyone in General's topic | "🆕 AgEnD {0} available (current: {1})! Run: /update" / 「🆕 AgEnD {0} 可更新（目前：{1}）！執行：/update」 (`locale.ts` `update.available_current`) | No button: the person must know to type `/update`. It is **posted again on every daily check** while behind (no de-duplication). | Text only (not on the web) |
| **Web-only fleet Notice** (no chat) | Admins, in Notices | "AgEnD {0} is available (current: {1}). Update it from the web: Update now on the banner, or Settings → Advanced → Version and update." | Once per version. It is worded in the fleet's language when recorded, so a zh-TW viewer reads English. | `…-9-notice` |
| **Web banner (update line)** | Admins only ("only admins see this") | "AgEnD v{0} is available (current v{1})" · **Update now** · **Later** | **Later** hides it in *this browser* until another version (localStorage); the server never knows. On a phone the zh-TW line wraps inside the version ("v2.4.0-" / "beta.24）"). | `…-1-offer` |
| **Confirmation** | Admins | "This installs v{0} ({1}), then restarts AgEnD. Every Agent stops briefly and comes back on its own." · **Update and restart** | Starts at once, **with no wait for idle**. | `…-2-confirm` |
| **Settings → Advanced → Version and update** | Admins | Current version, Update line, Latest, Last checked · **Update now** · **Check for updates** | Same dialog. | `…-3-settings` |
| **Running / failed / done** lines | Admins | "Downloading and installing v{0}… Step 2 of 4 …" / "Update failed: the update source could not be reached. AgEnD is still v{0}; nothing was changed." / "AgEnD is up to date (v{0})." | Try again, See the full log. | `…-4/5/6` |
| **Hub recommendation** | Admins (web); General's topic every 7 days | "Example Hub recommends AgEnD v{0} (current v{1}) · Some Hub features need it." | **Update now** (pinned to that version), **Later** (24 h). | `…-7-hub` |
| **Read-only session** | Non-admins | Nothing (only a "reload this tab" line when the tab is older than the server). | — | `…-8-readonly` |
| **Chat `/update`** (Discord slash / Telegram) | Fleet admins of that adapter | Progress edits one message: "📦 Updating AgEnD… → ⬇️ … → Installed v{0} — restarting fleet → 🔄 Stopping fleet… → 🚀 Starting fleet… → ✅ Update complete — v{0} · {1}/{2} agents ready" | **No confirmation and no idle wait.** | Text only |
| **Web chat `/update`** | Admins | Opens the same confirmation as the banner. | — | (as `-2-confirm`) |
| **`agend update` CLI** | Whoever runs it | npm ping → target → downgrade refusal → Node preflight → the target's own installer → verify → restart | Agents get `-y` required. | Text only |
| **Tip 132** | Everyone | "Use `/update` after active work reaches a safe point…" | — | — |
| **Hub-requested update** (opt-in, Settings → Hub) | Fleet owner | "…asked to update this Fleet to AgEnD v{2}. It will start when your agents are idle." | **The only path today that waits for idle**, up to 24 h. | — |

**What makes people press Later, as the inventory shows:**
1. **"Every Agent stops briefly"** is the only promise. Nothing says the work continues, and nothing waits for a safe moment: Update now restarts mid-task.
2. **General's post is a command to type**, repeated daily. It is easy to scroll past and teaches people to ignore it.
3. **Nothing says what happens if it breaks.** The rollback that does exist (below) is never mentioned.
4. **Later is per-browser and forever** for that version. Nothing ever escalates, even for a broken or insecure version.

### 1.3 What the update already does (the mechanics this design builds on)

- **Resume.** Agents' sessions are checkpointed and resumed. An agent that was mid-work gets a `[system:working-recovery]` prompt with cause `update` (`working-recovery.ts`; `resume_interrupted_work`, default true).
- **Wait for idle (Hub path only).** `IdleUpdateQueue` (`update-idle.ts`) is durable in SQLite, waits up to 24 h and re-checks idle right before the launch.
  - Idle is `hubUpdateIdle` (`fleet-manager.ts`): no restarts or IPC in flight, no pending idle-gated delivery, every running agent's execution state `idle`, no approval prompt waiting.
  - It does **not** count scheduled jobs, task-board work, the outbox backlog or `hasWorkLease`.
- **Backup.** A copy of the installed package, with its `node_modules` and bundled runtime, goes to `<prefix>/.agend-rollback/<ver>-<ts>/` with its bin links (`package-preimage.ts`). The service unit or plist bytes are kept too.
  - **Not backed up:** `fleet.yaml`, the AgEnD home's data, the SQLite databases, or anything the new version migrates.
  - The release installer (`agend-install.cjs`) takes the copy only when a service exists, and on failure reinstalls the old version from npm (which needs the network).
- **Health check and rollback.** The proof is the service manager's:
  - systemd `READY=1` from the fleet;
  - or launchd running the expected program;
  - plus the package verification (`verifyInstalledPackage`: bin realpaths, the PATH `agend` is the same file, `--version`, better-sqlite3 opens, tmux).
  - If verification or activation fails, the package and unit are restored and the old service restarts.
  - **There is no rollback once the new fleet has started and then misbehaves** (crash loop, agents never ready). The 15-minute update marker only quiets crash alerts.
  - A detached (non-service) fleet gets no service rollback at all.
- **Which install is running** (this is what pre-flight builds on, §4):
  - `runningInstall` (`update-dispatch.ts`) tells a global package from a checkout.
  - `npmForRunningInstall` accepts an npm only if its `npm root -g` resolves to the running package. It tries the install's own `bin`, the running Node's npm, PATH, then nvm, Volta, fnm, asdf, Homebrew and `/usr/bin`.
  - `resolveInstalledAgend` needs `<prefix>/bin/agend` and the package bin to resolve to the same file.
  - On Linux, `fleet-service-owner.cjs` proves the live fleet from `fleet.lock` and `/proc` (uid, argv, `AGEND_HOME`, the unit's `MainPID`, cgroup and `WorkingDirectory`). It refuses "outside" or "unknown". On macOS it always answers `none`.
  - `restart-guard.ts` / `service-activation.ts` require the loaded unit or plist to start the verified binary.
  - `install-lock.ts` allows one updater per npm prefix. Two homes on one prefix exclude each other; **two prefixes never do**.
- **Not detected today:**
  - a second fleet under another `AGEND_HOME` on another prefix;
  - several Node versions as such;
  - Docker;
  - a vendored or pinned copy;
  - disk space;
  - a rehearsal or manual test;
  - a source checkout, which is **not refused**: it updates whatever PATH's npm has installed globally.

---

## 2. Goals and non-goals

**Goals**
- G1. The update is offered where people already look, as one choice they can make in one press. Its words answer the fear and are **exactly true** for that machine.
- G2. On a machine where it can be proven, the promise is real: a quiescence barrier, a coherent backup, a trial with no outside effects, automatic rollback, and work resumed.
- G3. A version known to be bad or insecure can't be deferred past a deadline, and the update is never attempted blind.
- G4. A fleet whose CLIs have moved past what its build knows gets a newer build that knows them, and that build breaks no other agent.
- G5. A machine that can't update itself safely is never tried automatically. Where the install or its data can't be identified, it is not tried at all. The admin is told exactly why and what to fix.

**Non-goals**
- Updating the agents' own CLIs. That path is separate: the audited ledger, and "Update" in Accounts and Runtime.
- Switching channels (beta ↔ stable) from chat or the web.
- The Windows Runtime's own updater. It already waits for idle and rolls back; this design only reports it.
- Changing what a Hub may do: it stays advice plus the owner-opted-in request.

---

## 3. A — one-press update

### 3.1 The card (one per fleet)

There is **one card per fleet**, not one per version.
- It is edited to the newest qualifying version. On beta a new version comes almost daily, and a card per version would bring back today's daily post.
- It lives in three places, and they are the same object: an answer on one shows on the others.
  - General's chat: a message with buttons, edited in place.
  - The web: the banner line, and Settings → Version and update.
  - **Needs you**, only for a required update or a failure (rolled back, can't update). An ordinary offer there would teach people that Needs you can wait.

```
🆕 AgEnD v2.4.1 is ready (you have v2.4.0). <one line: what's new>
Your agents finish what they're doing first, then AgEnD restarts for a few minutes and they carry on.
If the new version doesn't start, it returns to v2.4.0 by itself.          ← Phase 2, class Self only (§3.3); Phase 1 says less (§3.2)
[ Update when idle ]  [ Pick a time ]  [ Not now ]
```
zh-TW (glossary: 管理員, Agent):
```
🆕 AgEnD v2.4.1 已可更新（目前 v2.4.0）。<一行：這版的新功能>
Agent 會先把手上的事做完，接著 AgEnD 重新啟動幾分鐘，之後繼續工作。
新版沒有正常啟動的話，會自己回到 v2.4.0。          ← 只在第二階段、§4 判定為 Self 時才寫；第一階段的說法較保守（§3.2）
[ 閒下來時更新 ]  [ 選個時間 ]  [ 先不要 ]
```

- **Update when idle** is the primary action.
- **Pick a time** offers tonight, tomorrow morning, or a chosen hour. It still waits for idle once that time comes.
- **Not now** is one choice, kept on the server for the fleet. The card returns **a week after the admin's last answer**, whatever versions come in between. There is no "Skip this version": an admin who wants updates off sets a pin (§6).
- **While it waits for idle**, the card shows who is working ("waiting for: Example helper, writer"). It keeps **Update now** and **Pick a time**, because a busy fleet may never be idle.
  - **Update now** says how many agents are working and that they resume where they were. It still runs pre-flight and every check.
- **The second sentence is shown only where it is true** (§4's classes, and the phase). Elsewhere it is replaced:
  - **Phase 1**, on a service install: "If the new version doesn't start, AgEnD tries to put v2.4.0 back; if it can't, it tells you how to recover." (§3.2: best effort);
  - a non-service install, in Phase 1 and 2: "There's no automatic way back on this setup: if the new version doesn't start, start AgEnD again (Settings shows how)";
  - after the trial has committed (§3.3, step 7): "If something is wrong afterwards, Go back to v2.4.0 is in Settings".
- **Non-admins** in General's topic see the card. Pressing a button gets only them a short reply: "Only a fleet admin can update AgEnD." No state changes.
- **General itself is told** with one fleet-context line while the card is open, so "what's this update?" gets a real answer.
- **States** (the same card, edited):
  - Waiting for idle
  - Scheduled for 22:00
  - Updating — "a few minutes"
  - Checking the new version
  - Done — "v2.4.1 · 5 of 5 agents back, carrying on"
  - Rolled back — "v2.4.1 didn't start properly; you're on v2.4.0 again. Messages that arrived meanwhile are delivered now."
  - Can't update here — §4's reason and fix
  - Needs a hand — §3.3, a terminal manual-recovery state.

### 3.2 Phase 1 — only the promises that are true today

Phase 1 answers the user's "people press Later" with changes to words and timing, not to the machinery:
- the card and its server-side Not now;
- one entry for every path: card, web, chat `/update`, the Hub request, Pick a time;
- **wait for idle on today's `IdleUpdateQueue`**, made general beyond the Hub path;
- pre-flight (§4) gating every path;
- today's updater, unchanged.

The second sentence is then **best effort**, and says so (§3.1):
- On a **service install**, a package that fails to verify or start is restored, along with its unit (`package-preimage.ts`, `service-activation.ts`).
- A new version can **migrate state and then fail** before it proves its start. Today's package rollback has no state backup, so it can't promise that the old version works with that state. In that case the card goes to "Needs a hand", with the log and the recovery steps.
- Elsewhere the sentence is replaced, as in §3.1.

Phase 1 promises no state backup and no rollback after a successful start. Its rollback is the package's own, best effort.

**Phase 1 doesn't depend on the signed index (Phase 3).**
- P7 is `npm ping` only.
- The never-rule on an unverified index (§6, rule 4) and required updates (§5.3) apply once the running build has Phase 3.
- Before that, updates come from npm as today, as one-press or idle-waited updates. Nothing updates automatically: that mode is Phase 5.

### 3.3 Phase 2 — a real update transaction

The full flow runs only on a machine in class **Self** (§4). Both the running version and the target must speak this transaction (from-version ≥ V_tx, the first release to ship it). Otherwise the fleet stays on Phase 1's promises and the card says so.

1. **Re-prove identity under locks** (§4.2). Take the prefix lock, the home lock and the service lock, and hold them through step 8. The cached pre-flight result is for display only.
2. **Quiescence barrier: wait first, then fence and check again.** Fences never hold back the work that has to finish for the fleet to become idle.
   1. **Wait for an idle candidate, without fences.** Every agent is idle by `hubUpdateIdle` plus `hasWorkLease`, with no in-flight delivery or tool call. An agent waiting on a person counts as idle. Replies, completions and inter-agent messages that existing work needs flow as normal. A scheduled job **never counts as busy**, so a job every five minutes can't keep a fleet from ever updating.
   2. **Open the attempt journal** (step 3), before any fence.
   3. **Fence and check again, atomically** (one critical section in the fleet's event loop):
      - new inbound messages (chat, web, Hub, `send_to_instance`) go into the journal's **update inbox** and are not dispatched;
      - no new task-board claims;
      - a scheduled job that comes due is recorded as *deferred by update*;
      - then idle is checked again. If anything is busy now, the fences open, the held items are **handed back** (below), and the update goes back to waiting (substep 1).
   4. **Abandon or time out.** If the wait passes the admin's limit (default 24 h, `maxIdleWait`), or the attempt is cancelled, the journal records *abandoned*. Everything held is handed back **to the running fleet**, in arrival order: the inbox is dispatched normally, and the deferred jobs run then. The card offers **Update now** or **Keep waiting**.
3. **Attempt journal**, opened before anything changes. It lives **outside everything that is restored**, at `<home>/.update-journal/`. It holds:
   - the attempt id;
   - the proven install identity (§4.2);
   - the from- and to-artifact (package name, version and integrity, §5.1);
   - the pre-update **health baseline**: which adapters were connected and which agents were running;
   - the update inbox and the deferred jobs;
   - the stage and the outcome.

   A version that rolled back is marked here, so it isn't retried automatically, and a rollback can never erase its own failure record. On fleet start, an attempt left mid-stage (the updater crashed, the power went) is resumed by its recorded stage: finish the rollback, or move to manual recovery.
4. **Stop the old fleet, then snapshot.** Once the old fleet has exited and every writer is closed (proven: the fleet PID gone, `fleet.lock` released, no other process holding the databases), copy the state as files:
   - every SQLite database checkpointed, with its WAL;
   - `fleet.yaml` and the instance state files.

   That is one coherent snapshot, because nothing is writing. The package copy is taken as today.
5. **Install** the verified artifact (§5.1 binds the bytes), then **start the new version in trial mode** (quarantine):
   - adapters connect, but inbound goes to the update inbox, not to agents;
   - **no outbound sends**, apart from editing the update card;
   - the scheduler stays fenced;
   - **agents' CLIs are not started**, so their session stores are untouched;
   - database migrations run.
   - **Every writer of fleet state is gated, not only startup.** In trial mode each writer either writes into the attempt journal or is refused before it acknowledges anything:
     - adapter cursors and inbound go to the journal;
     - every **mutating web or Hub API** (settings, authorization, sessions including revocations and sign-outs, task board, Hub member changes) answers **503 "AgEnD is updating; try again in a few minutes"**, with `Retry-After`, before any write.

     So nothing accepted during the trial can be undone by a rollback. A revoked session, for example, is never reactivated by the restored snapshot: the revocation was refused and the person retries it.

   **The gap between the old fleet's exit and the trial's start** (seconds) has **no listener**. The doc doesn't promise a queue for it. The boundary is per surface:
   - **Web.** Requests fail. The page already shows "AgEnD is restarting" and retries.
   - **Hub.** The Hub holds what it sends to an offline member until it reconnects, as today.
   - **Telegram.** Unconfirmed updates stay with the platform (long-poll) and are read on reconnect.
   - **Discord.** The gateway doesn't replay. On start the fleet (trial or old) **reads each bound channel's history since its last-seen message id** and admits what it missed into the inbox. Phase 2 adds this catch-up; until it exists, the card says "a message sent in Discord during the restart may need sending again".
   - **`send_to_instance`** from another fleet process. Refused while the fleet is down; the sender's delivery already retries.
6. **Health proof**, against the baseline, for up to 5 minutes:
   - the process stays up, with no restart loop;
   - the web's health route answers;
   - the migrations finished;
   - every adapter that was connected before connects again. An adapter that was already down before doesn't count against the new version.
   - The updater process stays alive outside the fleet's cgroup, as today, to judge this.
7. **Commit or roll back**:
   - **Commit:**
     1. mark the journal committed;
     2. leave trial mode;
     3. start the agents (checkpoint and `working-recovery`, as today);
     4. deliver the update inbox in order;
     5. run the deferred jobs;
     6. keep the snapshot for 7 days.

     An agent that doesn't come back after the commit is reported. It is **not** an automatic rollback: by then work may have happened. **Go back to v2.4.0** is offered in Settings, as an explicit choice that names what is lost.
   - **Roll back** (the trial failed):
     1. stop the new fleet and prove every writer has gone;
     2. restore the package, the unit and the snapshot files together;
     3. start the old version.

     The old version starts its agents, delivers the update inbox and runs the deferred jobs, so the trial produced no outside effects that would need undoing. The journal records the failure.
   - **Manual recovery** (the old version also fails its proof): the journal says so, the service stays stopped, and the card and Needs you say "Needs a hand", with the log and the exact command to run.
8. **Release the locks**, and post one line in General: "Updated to v2.4.1; carrying on."

The plain `agend update` CLI, run by an operator at a shell, takes the same transaction when the machine is in class Self. `--now` skips the drain wait but not the barrier.

---

## 4. Pre-flight: can this machine update itself safely?

### 4.1 Three outcomes, not pass or fail

| Class | Meaning | Who may update | What the card says |
|---|---|---|---|
| **Self** | Every check below passes and is proven | Scheduled, required, automatic, and admin presses | Both sentences; Phase 2 when it ships |
| **Admin only** | The install and its data are proven, but this setup can't bring itself back, or the update needs an admin's hand | **Only an admin's own press.** Nothing scheduled or automatic. A required update becomes a daily, red notice, never a silent install. | Second sentence replaced by the honest one. A **fix button** where the product can do it. |
| **Stop** | The install, its home, its service or its shared data can't be proven, or the update can't succeed here | **No one**, until fixed. Overrides can't reach this class. | The reason and the fix, every time |

| # | Check | How | Class if it fails | The admin is told |
|---|---|---|---|---|
| P1 | **This is the install that runs** | `runningInstall` = global (not a checkout). `resolveInstalledAgend` resolves. `npmForRunningInstall` finds an npm whose `npm root -g` is the running package. PATH's `agend` is the same file (today only checked after installing; moved to before). | **Stop** | "This AgEnD runs from a source checkout / another copy than the one npm would update. Update it with git, or run the fleet from the global install." |
| P2 | **One fleet per install and per home, proven** | Identity under locks (§4.2): this home's live fleet is this package. No *other* live fleet uses this home, or this package with another home. Other `agend` units and plists, and the conventional global roots, are scanned as a **diagnostic**, never as proof. | **Stop** if ownership is unknown or state is shared. **Admin only** if another install is proven disjoint (its own home, prefix and service). | "Two AgEnD installs live under this user: v2.4.0 in ~/.nvm/…/22 (this fleet) and v2.3.9 in /usr/local (fleet at ~/.agend-test, running). They share ~/.agend: updating one could break the other. Give each its own home, or remove one." |
| P3 | **The service will restart it** | `startedByServiceManager`. The unit is loaded with no pending daemon-reload. Linux: lingering is on for a user unit; a system unit needs a root updater. macOS: the plist is loaded and matches. | **Admin only** | "AgEnD isn't running as a service, so it can't bring itself back after an update." Button: **Install as a service** (new; it runs `agend service install` for the admin). Lingering off: **Turn on** (the existing `user-systemd` step), else the command. |
| P4 | **It may write the install** | `W_OK` on the npm root and prefix. **No silent nvm or sudo route.** | **Admin only**, from a shell with `sudo`. The web and chat card shows **no update button** for it, only the words. | "This update needs administrator rights on that computer: run `sudo agend update` in a terminal there, or reinstall with the one-line installer (a user-owned Node) so AgEnD can update itself." |
| P5 | **Not a linked or vendored copy** | The package is a symlink (`npm link`), or sits inside another project's `node_modules`. | **Admin only** (today's warning on press) | "This AgEnD is linked from a development folder; an update replaces the link." |
| P6 | **Room to update** | `statfs`: free space in the prefix and home of at least 3 × the package size, **plus the snapshot size from Phase 2** (Phase 1 takes no snapshot and doesn't count it). | **Stop** (until freed) | "Updating needs about 900 MB free on /home; there's 210 MB." |
| P7 | **The update source answers** | `npm ping` against the install's registry. From Phase 3, also the signed index fetched and verified (§5.1). | **Stop** for this attempt (notify only) | "The update source can't be reached from this machine (network or proxy)." |
| P8 | **Nothing else is updating or being tested** | No `update-in-progress.json`, no lock held, no unfinished journal attempt. **New:** a rehearsal or test marker: `AGEND_REHEARSAL=1` / `AGEND_E2E=1` in the fleet's environment, or `<home>/.no-auto-update`. | **Stop** while it lasts | "A rehearsal / manual test is running here; updates wait until it ends." |
| P9 | **The platform is one we update** | Docker (`/.dockerenv`, cgroup); Windows paired or Runtime mode. | **Stop** (the image or the Runtime updates itself) | "AgEnD runs in a container; update the image." / "This computer's AgEnD Runtime updates itself." |
| P10 | **The target runs here** | Today's `preflightUpdate`: the target's `engines` and runtime pins against the Node it will run on. | **Stop** for that target | "v2.5.0 needs Node 22.14 or newer; this machine has 20.11." |

- **A pin is not a pre-flight check.** It is a policy (§6), so it never makes a machine look broken.
- The **result is shown on its own** in Settings, before any update is offered: "Updates on this machine: ✓ can update itself", "◐ updates on your press only (why)" or "✗ can't update (why)".
- Reasons use fixed codes, never raw error text.

### 4.2 Identity is proven at the moment of change, under locks

Pre-flight's daily result is **only a diagnostic**. Before every mutation (install, snapshot, restore), the updater re-proves the whole tuple while holding the locks:
- the package (realpath, prefix, `npm root -g`, bin realpaths);
- the home (`AGEND_HOME`);
- the loaded service (unit or plist, `ExecStart` or program, no pending reload);
- the live fleet (PID, its start time and boot id, executable, Node and argv `fleet start`, cgroup or `MainPID`);
- the shared state.

The locks are:
- **the prefix lock** (today, `install-lock.ts`);
- **the home lock**, a new `<home>/.update.lock` that a second fleet on the same home also takes before starting;
- **the service lock**, taken around reload, start and stop.

Ownership that can't be proven is **Stop**, never Admin only:
- a lock with no known owner;
- macOS's `none` from `fleet-service-owner`;
- a detached fleet with an unknown home;
- a prefix shared by an unproven home.

The same proof runs again before a rollback, so the rollback can't land on someone else's install.

---

## 5. C — when an update is due

### 5.1 The signed release index

Each release publishes, next to its npm package:
- a **release manifest**;
- for each channel, an **index** listing the releases.

Both are signed and published on the docs site, mirrored as GitHub release assets. The publish workflow writes them from the build itself, so the ledger in a manifest is exactly that build's `src/cli-audited.ts`.

```jsonc
// releases/<channel>/index.json (+ .sig)
{ "schema": 1, "channel": "beta", "generation": 418, "issuedAt": "…", "expiresAt": "…",
  "latest": "2.4.0-beta.25",
  "releases": [ { "version": "2.4.0-beta.25", "manifest": "2.4.0-beta.25.json", "sha256": "…" } ],
  "floor": { "id": "SEC-2026-03", "version": "2.4.0-beta.20", "dueAt": "2026-11-28T10:00:00Z", "summary": "…" },
  "knownBad": [ { "id": "BAD-2026-07", "versions": ">=2.4.0-beta.21 <2.4.0-beta.23", "kind": "lockup", "summary": "…", "fixedIn": "2.4.0-beta.23", "dueAt": "…" } ],
  "hubMinMember": null }
// releases/<channel>/<version>.json (+ .sig)
{ "package": "@songsid/agend", "version": "2.4.0-beta.25", "channel": "beta",
  "integrity": "sha512-…",                 // npm's dist.integrity for that exact tarball
  "platforms": ["linux", "darwin"], "engines": { "node": ">=22.14" },
  "auditedCli": { "claude-code": ["…", "2.1.333"], "codex": ["…"] },
  "vendorChanges": [ { "id": "claude-login-2026-11", "cli": "claude-code", "from": "2.1.330" } ],
  "notes": { "en": "…", "zh-TW": "…" } }
```

**What a fleet accepts:**
- **The signature.** Ed25519, by an **operational** key that the current **trust epoch** authorizes for this channel (below). A signature by the recovery key, or by any key in the wrong role, is refused.
- **Freshness and replay**, scoped to `(epoch, channel)`:
  - The index carries `epoch` and `generation`. It is accepted only if its epoch is the fleet's current epoch, and its generation is at least the highest accepted **in that epoch and channel**.
  - **An equal generation must carry the same digest.** The fleet persists the digest per generation, so the same number with different content is refused.
  - The high-water marks are persisted in the attempt journal's directory, outside any restore. An older index is refused even when it is validly signed and unexpired, so it can't undo newer advice.
  - Validity is bounded: `expiresAt` at most **14 days** after `issuedAt`. An index is refused once it has expired, or when `issuedAt` is more than **1 hour in the future**: clock tolerance is separate from age. An index issued days ago stays valid until it expires.
- **The artifact binding.** An update installs only a target whose manifest is in the accepted index (by `sha256`) and meets **all** of these:
  - same package and channel;
  - this platform;
  - a version higher than the running one and than any version already rolled back here. **The one exception is an admin's explicit Try again**: it may target exactly the artifact that rolled back (the same `integrity`), once per press. Every other check in this list, and §4, still applies. Automatic and scheduled updates never retry it;
  - not in `knownBad`;
  - its `engines` met.

  The updater **downloads the tarball, checks it against the manifest's `integrity`**, and only then runs any installation code, installing from that verified file rather than by name.
- **Fail-safe.** If the index is unreachable, unsigned, refused or expired:
  - nothing automatic or required runs;
  - plain notices continue from npm, as today;
  - Settings says "Couldn't verify the update list since <time>".

**Keys, roles and trust epochs** (decision D4). Both kinds of key are Ed25519, and their roles never mix:
- **Operational keys** sign indexes and manifests, and nothing else.
- **The recovery key** is offline, compiled into every build, and signs only **trust-epoch records**: `releases/trust/epoch-<n>.json` + `.sig`, `{ epoch: n, issuedAt, channels, operationalKeys: [publicKey…], revoked: [publicKey…] }`.
  - Epoch 0 is the operational key compiled into the build.
  - The fleet fetches and verifies epoch records **on their own path, independently of any index**, so a poisoned or refused index never blocks recovery.
  - It accepts epoch n+1 only from the recovery key, and only above its current epoch. It persists the current epoch outside any restore.
  - **A new epoch resets the generation high-water marks.** So an index signed by a stolen key with an enormous generation ("generation poisoning") is undone by the next epoch, along with the key's revocation. Legitimate indexes then start again at generation 1 in the new epoch.

What a **stolen operational key** can do, until it is revoked:
- force an update to a **release that is still published**, including a bad one that isn't yet listed in `knownBad`;
- force repeated disruptive updates.

What it can't do:
- install anything npm hasn't published under `@songsid/agend`;
- skip the integrity binding;
- go backwards.

Limits that reduce the harm:
- at most **one required update per 24 h** per fleet;
- every required update shows **who says it's required and why** (§5.3).

Recovery is a new trust epoch signed by the recovery key: it revokes the key, names its successor and resets the high-water marks. Old clients trust it because the recovery key is compiled in. Losing **both** keys has no automatic recovery: a fleet then needs an admin to update by hand to a build with new keys. The doc says so plainly.

### 5.2 Triggers

| # | Trigger | Decided from | Kind |
|---|---|---|---|
| T1 | **Known-bad version** (lockups, data errors, security) | `knownBad` matches the running version | **Required** (§5.3) |
| T2 | **Below the security floor** | running < `floor.version` | **Required** |
| T3 | **CLI drift** | below | **Recommended**; it schedules itself only under `auto-when-idle` |
| T3b | **CLI drift that nothing covers yet** | drifted, in no newer manifest, and N or more releases past this build's newest audited (claude-code 5, others 2) | **Notify only**: "…6 versions past what AgEnD has checked; no version covers it yet. If an agent gets stuck, pin Claude Code to 2.1.333 in Accounts." |
| T4 | **A vendor sign-in or API change** | a newer manifest's `vendorChanges` matches an installed CLI version, or the fleet sees an unknown sign-in screen or API error, and a newer manifest names a change for it | As T3 |
| T5 | **The Hub needs a newer member** | the paired Hub's `hubMinMember`, carried in its signed recommendation | **Recommended**: a reminder, or scheduled only under `auto-when-idle` |
| T6 | **Staleness** | stable 2 versions, or 30 days, behind | **Reminder only**, at most weekly |

**T3, defined safely:**
- **Which versions.** Use the version of the binary each agent **actually runs**: each instance's resolved executable, `--version` → `versionOf`, and the paired Windows Runtime's report for its agents. Never the version on PATH.
- **What counts as drift.** A version is drift only if it is **newer than this build's newest audited release** of that CLI. Missing from the ledger alone isn't drift: it may be an older, unaudited version.

**Picking one target, for every trigger:** take the newest release on this channel that satisfies **all** of these at once:
- the floor and `knownBad` (never a bad target);
- this machine's runtime and engines;
- **every CLI version in use stays covered.** A version the running build already audits must stay in the target's ledger, so the target can't fix one agent's drift by breaking another's audited CLI;
- the Hub minimum, if any.

From those, prefer one that covers the most drifted CLIs.
- If **none** satisfies the constraints, notify only, and name what's missing.
- When several triggers apply, the card names every reason, but **there is only one target**, and it meets all of them.

### 5.3 A required update (T1/T2)

**Deadlines are durable.** Each advisory has a stable `id` and an absolute `dueAt` in the index. Its first-seen time and due time are persisted in the journal's directory, and a later index can only bring `dueAt` sooner. A daily refresh, a restart, a rollback and **Not now** can't extend it.

**The card and banner say who requires it and why:**
- "AgEnD's publisher marked v2.4.0 unsafe: (summary, advisory SEC-2026-03). It updates to v2.4.1 as soon as your agents are idle. After Thu 18:00 it can't be postponed."
- zh-TW: 「AgEnD 發行方已將 v2.4.0 標為不安全：（摘要，公告 SEC-2026-03）。Agent 一閒下來就會更新到 v2.4.1；週四 18:00 之後就不能再延後。」

**Buttons:**
- **Update when idle**;
- **Pick a time**, which must fall before `dueAt`.

There is no Not now after `dueAt`, and no Skip.

**The deadline is the end of deferral, not a promise to have installed by then.** After it:
- the update runs at the first moment it is allowed: idle, outside the pause hours, and pre-flight in class Self;
- Needs you turns red.

The card never claims a time it can't keep.

**A machine in class Admin only or Stop** can't take a required update by itself. It gets a red Needs you item and a card every day, with the reason, the fix and the fact that the version is unsafe.

Settings shows, **before any of this happens**, that "the publisher can mark a version unsafe; such updates can be delayed but not skipped", so the first required update isn't a surprise.

---

## 6. Rules and controls

**Never automatically** (a scheduled, required, CLI-drift or Hub-triggered update):
1. while the quiescence barrier can't be reached: an agent working, or work in flight (§3.3, step 2);
2. inside an admin-set **pause window**. A required update waits for the window to end;
3. during a rehearsal or test (P8);
4. when the signed index can't be verified (§5.1). This applies once the running build has Phase 3; before it, there is no automatic update at all;
5. in pre-flight class Admin only or Stop (§4);
6. toward a version that already rolled back here (from the journal), until a newer version. An admin's explicit **Try again** is the one exception, for that exact artifact (§5.1);
7. within 6 h of publication, except a required update (a short soak, during which the publish can be pulled);
8. more than one required update per 24 h (§5.1).

**Settings**, for a first-time admin, has two controls:
- **Updates:** *Ask me* (default, D1) / *Automatically when idle*;
- **Don't update during:** days and hours.

**Under Settings → Version and update → Advanced** (collapsed, so the default view keeps its two controls), also in `fleet.yaml` as `updates.*` (the standing rule: every setting is editable in Settings):
- **Pin to a version** (`updates.pin`): no update is offered, and a banner shows the pin. What a pin does to a **required** update is D3. With the recommended (b), the pin stops it too, and a red notice stays in Needs you and the banner until the pin is removed;
- **Longest wait for idle** (`updates.maxIdleWait`, default 24 h).

---

## 7. Decisions for the user

| # | Question | Recommended |
|---|---|---|
| D1 | Default mode for existing and new fleets | **Ask me** for everyone; *Automatically when idle* only after a beta of evidence |
| D2 | Required-update deferral window | **72 h** for security, **7 days** for lockups and data errors, as `dueAt` in the index |
| D3 | **Does a pin stop a required update?** Some sites need a true off switch; without one, they will fake a failing pre-flight. | Options: (a) no, a pin only delays offers; (b) yes, but a red notice stays until unpinned; (c) yes, silently. **Recommended: (b)**, a real off switch that stays visible. |
| D4 | Signing keys: who holds the operational key (the publish step's secret store) and the offline recovery key (the user, offline); where the index lives (docs site + release assets) | As stated |
| D5 | Phase 2: rollback restores the snapshot | Yes. The trial has no outside effects (§3.3), so nothing is lost. After the commit, **Go back** is a manual choice. |
| D6 | Card cadence | One card per fleet. It reappears a week after the admin's last answer; required updates daily in the last 24 h. |
| D7 | CLI drift under *Ask me* | The card only. It schedules under *Automatically when idle*. |
| D8 | Hub minimum member version | A reminder; it schedules only under *Automatically when idle* |
| D9 | Two installs (P2) | Unknown or shared means **Stop**; proven disjoint means **Admin only** |

---

## 8. Phases

Each phase is its own PR series, with review and captures.

1. **The card and honest timing** (A, Phase 1):
   - one card per fleet with server-side **Not now**;
   - one entry for every path;
   - wait for idle on today's queue;
   - **Pick a time**;
   - pre-flight classes P1–P10, with identity re-proven at launch and the fix buttons;
   - Settings' two controls and the "Updates on this machine" line.

   This alone answers "people press Later". Its promises are today's.
2. **The update transaction** (A, Phase 2): the barrier and fences, the attempt journal and update inbox, stop-then-snapshot, trial mode, the baseline health proof, commit or rollback or manual recovery, and the home and service locks.
3. **The signed index** (C): the publish workflow, the keys and recovery, freshness, the artifact binding, T1/T2 required updates with durable deadlines, and T6.
4. **CLI drift and vendor changes** (T3/T3b/T4), the Hub minimum (T5), and the single-target rule.
5. ***Automatically when idle*** as a mode, after a beta of evidence.

A rehearsal (like S-233's) proves phases 2–4 on real installs: a forced trial failure, a crash mid-update, two installs sharing a home, and a replayed old index.

## 9. Risks

- **A wrong health verdict rolls back a good update.** The trial is short and has no outside effects, so a false rollback costs minutes, not data. It is compared against the pre-update baseline, so an adapter that was already down isn't blamed. Rollbacks are reported with their reason.
- **The barrier holds messages for a few minutes.** They wait in the update inbox and are delivered in order; the card says "messages that arrive meanwhile are delivered after".
- **Key compromise:** see §5.1. The limits there and the recovery key bound the harm; losing both keys needs a manual update.
- **More automation in a path that can stop the fleet.** *Ask me* stays the default. *Automatically when idle* comes last, and every automatic path needs class Self.

## 10. Changes by revision

### Revision 2 (the review of `89d60061b`)

| Review point | Where it is answered |
|---|---|
| Lumen 1: a non-service fleet would lose its update | §4.1: three classes; Admin only keeps the admin's press, with honest words and fix buttons |
| Lumen 2: a card per version is the daily post again | §3.1: one card per fleet, back a week after the last answer |
| Lumen 3, 4: promises that must be exact | §3.1: "a few minutes", the second sentence only where true. §5.3: the deadline ends deferral. Buttons: Update when idle and Pick a time |
| Lumen 5, 6, 7, 8, 9 | §3.1: one Not now, no Skip (the pin). Needs you only for required updates and failures. §6: two Settings controls. Update now and Pick a time stay while waiting. Two sentences |
| Lumen 10: Phase 1 too large | §3.2, §8: Phase 1 changes words and timing only, with today's promises |
| Lumen 11, 12, 14 | §3.1: a non-admin's press. §5.3: who requires it and why, and Settings shows it beforehand. D3 a real question. The zh space fixed |
| Prism 1: quiescence and a coherent snapshot | §3.3, steps 2, 4, 5: fences and drain; snapshot after the old fleet exits; trial quarantine. The scheduler is fenced, not counted as busy |
| Prism 2: external effects and the inbox | §3.3, steps 2, 5, 7: the update inbox in the journal; trial mode with no outbound and no agents; writers proven gone before restore |
| Prism 3: the journal outside the snapshot | §3.3, step 3: the attempt journal, crash recovery, manual recovery, the health baseline |
| Prism 4: identity proven at the moment of change | §4.2: re-proof under prefix, home and service locks before every change and every rollback; unproven means Stop |
| Prism 5: bind the artifact; be honest about keys | §5.1: manifest `integrity`, verified tarball, target constraints; operational and recovery keys; what a stolen key can and can't do |
| Prism 6: freshness and durable deadlines | §5.1: `generation` high-water mark, future-clock tolerance apart from age. §5.3: advisory ids, `dueAt`, persisted |
| Prism 7: pin and override contradictions | §4.1, §6: a pin is a policy, not a pre-flight check. D3, D9 |
| Prism 8: safe T3 targets | §5.2: actual binaries; drift = newer than audited; one target meeting every constraint, never regressing another agent's CLI |

### Revision 3 (Prism's second review of `b9cd7b2f3`, and Lumen's revision-2 nits)

| Point | Where |
|---|---|
| Prism R2-1: fences must not block the drain; journal before fences; hand-back on abandon | §3.3 step 2: wait without fences, open the journal, then fence and re-check atomically; abandon hands everything back in order |
| Prism R2-2: the surviving ingress owner; trial write gates | §3.3 step 5: each writer journals or is refused with 503 before it acknowledges (incl. session revocation); the stop→start gap is stated per surface (web retry, Hub hold, Telegram long-poll, Discord history catch-up, sender retry) |
| Prism R2-3: Phase 1's promise; P7 and the signature rule feature-gated | §3.1, §3.2: best effort, "Needs a hand" after a migrate-then-fail. §3.2, P7, §6 rule 4: index rules from Phase 3 |
| Prism R2-4: poisoned freshness | §5.1: Ed25519 roles; trust epochs signed by the recovery key, fetched independently; high-water per (epoch, channel), reset by a new epoch; equal generation needs the same digest; 14-day validity bound |
| Prism R2-5: Try again is reachable | §5.1 exception for the exact failed artifact; §6 rule 6 |
| Prism R2-6: operator settings in the UI | §6: Advanced in Settings (pin, longest wait), and `fleet.yaml` |
| Lumen nits | §6 pin follows D3's option; P6 counts the snapshot from Phase 2; P4 has no button on the card |
