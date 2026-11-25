# Updates people actually take (M-3762)

**Status:** design for review (Prism, Lumen), then the user's approval. No code before that.
**Asked by:** the user, 11-25, through the leader.
- Most people don't know `/update`.
- Like Windows Update, they press "Later", because they're afraid their agents' work will stop or the update will break something.
- The web has an update notice, but General's is easy to miss.

The user wants:
- **(A)** a one-press update they can trust.
- **(C)** an update that is required below a minimum version.

The leader added triggers, a pre-flight check and never-auto rules. All of them are in this doc.

**In short:**
- One card, in General's chat and on the web, offers **Update when idle**. AgEnD then:
  1. checks the machine can update itself safely;
  2. waits until every agent is idle;
  3. backs up the install and the fleet's state;
  4. updates;
  5. proves the new version is healthy;
  6. lets the agents resume.
- If the health proof fails, AgEnD goes back to the previous version on its own.
- A **signed release index**, published with every release, tells a fleet without installing anything:
  - whether its version is known-bad or below the security floor (a required, scheduled update);
  - whether a newer build covers the CLIs it runs (a recommended update);
  - what a Hub needs;
  - how far behind it is (a reminder only).
- Nothing updates on its own while:
  - an agent works;
  - an admin pause window is on;
  - a rehearsal runs;
  - the pre-flight check fails;
  - the signed index can't be read.

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
- G1. The update is offered where people already look (General's chat and the web), as a choice they can make in one press, in words that answer the fear: *your work continues; if it breaks, it comes back*.
- G2. That promise is true: a wait for idle, a backup that includes state, a health proof after start, automatic rollback, and work resumed.
- G3. A version that is known to be bad or insecure does not stay installed for long: a required update, scheduled and announced, that never runs blind.
- G4. A fleet whose CLIs have moved past what its build knows gets a newer build that knows them.
- G5. A machine that can't update itself safely is never tried; the admin is told exactly why and what to fix.

**Non-goals**
- Updating the agents' own CLIs. That path is separate (the audited CLI ledger, "Update" in Accounts and Runtime).
- Switching channels (beta ↔ stable) from chat or the web. That stays as today.
- The Windows Runtime's own updater (`runtime-update-controller.ts`). It already waits for idle and rolls back. This design only reports it.
- Changing what a Hub may do: it stays advice plus the owner-opted-in request.

---

## 3. A — one-press update that is safe

### 3.1 The card

One card per offered version replaces General's daily "Run: /update" post.
- **General's chat:** a message with buttons, like the Hub recommendation's **Update now** today. It is edited in place as the update moves on, not reposted.
- **The web:** the banner line, Settings → Version and update, and a **Needs you** item.
- All three are the same object, and an answer on one shows on the others.

```
🆕 AgEnD v2.4.1 is ready (you have v2.4.0)
Your agents' work continues: AgEnD waits until they're all idle,
restarts in about a minute, and they pick up where they left off.
It backs up first; if the new version doesn't start properly,
it goes back to v2.4.0 on its own.
What's new: <one line, from the release notes>
[ Update when idle ]  [ Not now ▾ ]  (Tomorrow · Next week · Skip this version*)
                      * not offered for a required update (§5)
```
zh-TW (glossary: 管理員, Agent):
```
🆕 AgEnD v2.4.1 已可更新（目前 v2.4.0）
Agent 的工作不會中斷：AgEnD 會等所有 Agent 都閒下來，
重新啟動約一分鐘，之後從原處接著做。
更新前會先備份；新版沒有正常啟動的話，會自動回到 v2.4.0。
這版的新功能：<一行>
[ 閒下來時更新 ]  [ 先不要 ▾ ]（明天・下週・跳過這個版本*）
```

- **Update when idle** is the one primary action. **Update now** moves into the ▾ menu, for an admin who knows the agents can stop. Even then it says how many agents are working and that they will resume, and it still runs pre-flight, backup, health proof and rollback.
- **Not now** is stored on the server (per fleet), not in one browser. It is a delay, not a mute: the card comes back after it, and §5 decides whether "Skip this version" is offered at all.
- **Cadence:** a card when a version first qualifies, then at most a reminder a week. Never the daily repost of today.
- **General itself is told** (one fleet-context line while a card is open), so "what's this update?" in chat gets a real answer and General can offer the button again.
- **Non-admins** see nothing, as today.
- **States** (the same card, edited):
  - Waiting for idle — "3 agents are working; it starts when they're done."
  - Backing up
  - Updating — "step n of 5"
  - Checking the new version
  - Done — "v2.4.1 · 5 of 5 agents back, work resumed"
  - Rolled back — "v2.4.1 didn't start properly; you're on v2.4.0 again and nothing else changed. We've noted it; you can try again later."
  - Can't update here — §4: the reason and the fix, and the card falls back to notify-only.

### 3.2 The flow (one updater for every entry: card, web, `/update`, Hub request, scheduled)

1. **Pre-flight** (§4). On a failure, stop here: say why, and give the fix.
2. **Wait for idle**, using the durable `IdleUpdateQueue`, today's Hub path made general.
   - Idle becomes stricter than `hubUpdateIdle`: add scheduled jobs due within the next 10 minutes, `hasWorkLease`, and open task-board work an agent has claimed and is running. An agent waiting on a person counts as idle, because an update doesn't lose a question.
   - The card shows who is busy.
   - It waits up to the admin's limit (default 24 h), then says so and offers **Update now** or **Keep waiting**.
3. **Backup**:
   - the package copy (today);
   - plus **a state snapshot**: `fleet.yaml`, the AgEnD home's databases (scheduler, task board, settings, Hub member), and the instance state files. These are copied with SQLite's online backup, not file copies, to `<home>/backups/update-<from>-<to>-<ts>/`.
   - Logs, attachments and CLI session stores are excluded.
   - The last two are kept.
4. **Install and restart**: today's updater, unchanged.
5. **Health proof** (new). **The updater process stays alive** after `agend restart`, detached outside the fleet's cgroup as today, and watches for up to 5 minutes:
   - the fleet process is up and has not restarted;
   - the web's health route answers;
   - each agent that was running before is back to ready or the same state;
   - each chat adapter is connected;
   - no new crash notices.
6. **Commit or roll back**:
   - **Pass:** delete the older backups, write the result, and edit the card.
   - **Fail:** restore the package and unit (today) and **the state snapshot**, restart the old version, prove it the same way, and edit the card to Rolled back.
   - Data written by the new version during those few minutes is lost on a rollback, and the card says so in one line. Messages that arrived are kept, because the chat platforms keep them.
   - A version that rolled back is marked on this fleet: no automatic retry until a newer version, or until an admin presses Try again.
7. **Resume**: today's checkpoint and `working-recovery`, then one line in General: "Updated to v2.4.1; carrying on."

### 3.3 Where `/update` and the web's Update fit

- Chat `/update` and the web's **Update now** become the same card with the same flow.
  - `/update` posts the card, with **Update when idle** focused.
  - `/update now` keeps today's immediate path, still with pre-flight, backup, health proof and rollback.
- `agend update` (CLI) runs pre-flight and offers `--when-idle`. Plain `agend update` stays immediate (an operator at a shell), but now takes the state backup and holds for the health proof.

---

## 4. Pre-flight: can this machine update itself safely?

This runs before **every** update: one-press, scheduled, required, Hub-requested or CLI. Its result is also shown on its own in Settings → Version and update, as "Updates on this machine: ✓ ready" or "✗ needs attention" with the list.
- On **any failure** AgEnD does not try, says exactly why and what to fix, and that fleet falls back to **notify only** until the check passes.
- It re-runs on every attempt and once a day with the version check.

| # | Check | How (builds on §1.3) | If it fails: what the admin is told |
|---|---|---|---|
| P1 | **This is the install that runs** | `runningInstall` = global (not a checkout), and `resolveInstalledAgend` resolves. `npmForRunningInstall` finds an npm whose `npm root -g` is the running package. PATH's `agend` is the same file (today only checked *after* installing: moved to before). | "This AgEnD runs from a source checkout / another copy than the one npm would update. Update it with git, or run the fleet from the global install." |
| P2 | **One fleet, one install** | Scan the known Node managers' global roots (the list `npmForRunningInstall` already walks) for other `@songsid/agend` installs. For each other install, read its `fleet.lock` / unit, and look for other `agend` units and plists (`agend*.service`, `com.agend.*`) whose `ExecStart` or program is another binary. Read the `AGEND_HOME` of each live fleet (`/proc`, the unit's Environment). | "Two AgEnD installs live under this user: v2.4.0 in ~/.nvm/…/22 (this fleet) and v2.3.9 in /usr/local (fleet at ~/.agend-test, running). Updating one could restart or confuse the other. Remove the one you don't use, or give each its own user." The paths are shown to the admin only, never on public surfaces. |
| P3 | **The service will restart it** | `startedByServiceManager`. The unit is loaded with no pending daemon-reload (`restart-guard.ts`). On Linux, user lingering is on for a user unit; a system unit needs the updater to be root. On macOS, the plist is loaded and matches. | Not a service: "AgEnD isn't running as a service, so it couldn't come back on its own after an update. Run `agend service install`." Linger off: "…`loginctl enable-linger <user>`." |
| P4 | **It may write the install** | `W_OK` on the npm root and prefix (`hubUpdateCanInstall` today). **No silent nvm/sudo route** for an automatic update. | "Updating needs write access to /usr/local/lib/node_modules (owned by root). Reinstall AgEnD with the one-line installer (user-owned Node), or run `sudo agend update` yourself." |
| P5 | **Not pinned or vendored** | The package is a symlink (`npm link`), or lives inside another project's `node_modules`, or its version is pinned by an admin setting (`updates.pin`, new). | "This AgEnD is pinned to v2.4.0 (Settings) / linked from a development folder. Automatic updates are off for it." |
| P6 | **Room to update** | Free space in the npm prefix and the AgEnD home of at least 3 × the package size, plus the state backup size. Uses `statfs` (absent today). | "Updating needs about 900 MB free on /home; there's 210 MB. Free some space and try again." |
| P7 | **The update source answers** | `npm ping` against the registry the install uses (today in the CLI only), plus the signed index (§5) fetched and verified. | "The update source can't be reached from this machine (network or proxy). AgEnD will tell you about updates but won't update itself." |
| P8 | **Nothing else is updating or being tested** | No `update-in-progress.json` and no install lock held. **New:** a rehearsal or manual-test marker. `AGEND_REHEARSAL=1` / `AGEND_E2E=1` in the fleet's environment, or `<home>/.no-auto-update` (a file a tester or rig drops). | "A rehearsal / manual test is running here; updates wait until it ends." |
| P9 | **The platform is one we update** | Docker (`/.dockerenv`, cgroup) means the image is updated, not AgEnD inside it. Windows paired / Runtime mode has its own updater; the fleet only reports. | "AgEnD runs in a container; update the image (docs link)." / "This computer's AgEnD Runtime updates itself; nothing to do here." |
| P10 | **The target runs here** | Today's `preflightUpdate`: the target's `engines` and bundled-runtime pins against the Node it will run on. | "v2.5.0 needs Node 22.14 or newer; this machine has 20.11. Install a newer Node (link)." |

- **Order:** P1–P5 and P9 are about the machine, cheap, and cached for the day. P6–P8 and P10 are re-checked at every attempt.
- **Result:** structured `{ ok, checks: [{ id, ok, reason, fix }] }`.
  - The web shows it as a list.
  - General's card shows the first failure and "and 2 more" with a link.
  - Each reason is a fixed vocabulary code (as the Hub's `no-permission`, `not-service`…), never raw error text.

---

## 5. C — when an update is due

### 5.1 The signed release index (how a fleet learns about newer builds without installing them)

Each release publishes, next to its npm package, a **release manifest**, and each channel has an **index** that lists them.
- Both are signed with an **Ed25519 release key** whose public half is compiled into every build. The build carries a list, so the key can be rotated: a new build carries the old and new keys for a while.
- The private key stays with the publish step, guarded like the npm token. Who holds it is **decision D4**.

```jsonc
// <site>/releases/<channel>/index.json   (+ index.json.sig)
{
  "schema": 1, "channel": "beta", "issuedAt": "2026-11-25T12:00:00Z", "expiresAt": "2026-12-02T12:00:00Z",
  "latest": "2.4.0-beta.25",
  "releases": [ { "version": "2.4.0-beta.25", "publishedAt": "…", "manifest": "2.4.0-beta.25.json", "sha256": "…" }, … ],
  "floor": { "version": "2.4.0-beta.20", "reason": "security", "advisory": "…", "deadlineHours": 72 },
  "knownBad": [ { "versions": ">=2.4.0-beta.21 <2.4.0-beta.23", "kind": "lockup", "summary": "Agents could stall after a Discord reconnect", "fixedIn": "2.4.0-beta.23", "deadlineHours": 168 } ],
  "hubMinMember": null
}
// <site>/releases/<channel>/2.4.0-beta.25.json   (+ .sig) — that build's own facts
{
  "version": "2.4.0-beta.25", "channel": "beta", "engines": { "node": ">=22.14" },
  "auditedCli": { "claude-code": ["2.1.316", "…", "2.1.333"], "codex": ["…"], "kiro-cli": ["…"] },   // = src/cli-audited.ts of that build
  "vendorChanges": [ { "id": "claude-login-2026-11", "cli": "claude-code", "from": "2.1.330", "summary": "New sign-in screen" } ],
  "notes": { "en": "one line", "zh-TW": "一行" }
}
```

- **Where it lives:** the docs site (GitHub Pages) under `releases/`, mirrored as GitHub release assets. The publish workflow writes and signs both from the build's own `src/cli-audited.ts` and the release notes, so the ledger in the manifest is exactly the shipped one.
- **How a fleet reads it:**
  - With the daily version check: fetch `index.json` and its signature, check the signature against the compiled keys, then `expiresAt` and `issuedAt` against the clock (a skew of more than 1 day counts as invalid).
  - Then fetch only the manifests it needs: the newer releases on its channel, newest first. Each is checked against the index's `sha256` and its own signature.
  - The last good index is kept on disk (`<home>/update-index.json`).
- **Fail-safe:** if the index can't be fetched, is unsigned or wrongly signed, or has expired:
  - no automatic or required update runs;
  - plain notices keep working from npm as today;
  - Settings shows "Couldn't verify the update list since <time>".
  - A cached index may still drive *reminders* until it expires, never a forced update.

### 5.2 Triggers

| # | Trigger | Decided from | Kind |
|---|---|---|---|
| T1 | **Known-bad version**: lockups, data errors, security | the index's `knownBad` matches the running version | **Required**: scheduled, with a deadline (§5.3) |
| T2 | **Below the security floor** | running < `floor.version` | **Required** (the C floor) |
| T3 | **CLI drift** (the user's main C input) | an installed backend CLI version that the agents run (from the `--version` probe AgEnD already does, `versionOf`) is **not** in this build's `AUDITED_CLI_VERSIONS`, **and** a newer release on the same channel lists it in `auditedCli` | **Recommended, strongly**: the card says "Claude Code updated itself to 2.1.334; AgEnD v2.4.1 knows its screens, this version may get stuck on them." Under the "automatic when idle" policy (§6) it schedules itself. |
| T3b | **CLI drift, nothing covers it yet** | not in this build's ledger, in no newer manifest, and N or more releases past this build's newest audited one (`claude-code` 5, others 2: cadences differ, Claude ships about one 2.1.x a day, Kiro about one a month) | **Notify only**: "Claude Code 2.1.338 is 6 versions past what AgEnD has checked; no AgEnD version covers it yet. If an agent gets stuck, pin Claude Code to 2.1.333 in Accounts." |
| T4 | **Vendor login or API change** | a `vendorChanges` entry in a newer manifest matches an installed CLI, or the fleet sees the symptom (an unknown sign-in screen or API error the build can't read) and a newer manifest names a change for that CLI version | Same as T3: "a newer build supports it" |
| T5 | **Hub needs a newer member** | the paired Hub's `hubMinMember` (the Hub's own setting, carried in its recommendation, already signed by the pairing) | **Recommended**: reminder or scheduled, by policy, as today's Hub recommendation |
| T6 | **Staleness** | stable 2 or more versions behind on its channel, or 30 days or more since a newer stable | **Reminder only**, at most weekly |

When several apply, the strongest kind wins, and the card names every reason ("Required: fixes a security issue in your version · also covers Claude Code 2.1.334").

### 5.3 A required update (T1/T2)

- **Card and banner:** "AgEnD v2.4.0 has a security issue (summary). It will update to v2.4.1 when your agents are next idle, by Thu 18:00 at the latest." Buttons: **Update when idle (now)** and **Pick a time**. There is no **Skip**; **Not now** only moves the time within the deadline.
  - zh-TW: 「AgEnD v2.4.0 有安全問題（摘要）。會在 Agent 下次閒下來時更新到 v2.4.1，最晚 週四 18:00。」
- **Schedule:**
  - From the index's `deadlineHours` (default 72 h for security, 168 h for a lockup or data issue): the update runs at the first idle moment.
  - From 24 h before the deadline the banner and General's card show a countdown.
  - **At the deadline it still waits for idle** (never kills work), but stops accepting **Not now**, and Needs you turns red.
- **It still never runs when** a §6 never-rule holds. It waits for the rule to clear and says which rule.
- **If pre-flight fails,** the required update can't happen. The admin is told the reason, the fix and that the version is unsafe, every day until it's fixed. It never runs blind.

---

## 6. Rules and controls

**Never update automatically** (a scheduled, required, CLI-drift or Hub-triggered update; the admin's own press is told but may override the first two):
1. while any agent is working (the stricter idle of §3.2);
2. inside an admin-set **pause window** (Settings → Version and update: days and hours, e.g. weekdays 09:00–18:00; a required update waits for the window to end);
3. during a rehearsal or manual test (P8);
4. when the signed index can't be fetched or verified (§5.1);
5. when pre-flight fails (§4);
6. when this version already rolled back on this fleet (no retry loop) until a newer version or an admin's Try again;
7. within 6 h of a release being published, for anything but a required update (a short soak; the publish can be pulled).

**Admin policy** (Settings → Version and update; `fleet.yaml` `updates:`):
- `updates.mode`:
  - `auto-when-idle`: recommended updates (T3–T5) schedule themselves at idle.
  - `ask` (default, **D1**): one-press card.
  - `notify`: card without buttons, for admins who update by hand. Required updates still schedule (**D3**).
- `updates.pause`: the windows.
- `updates.pin`: a version, which turns automatic updates off and shows the pin.
- `updates.maxIdleWait`: default 24 h.

---

## 7. Decisions for the user

| # | Question | Recommended |
|---|---|---|
| D1 | Default `updates.mode` for existing and new fleets | **`ask`** for everyone now. Move new installs to `auto-when-idle` after a beta of proof. |
| D2 | Required-update deadline | **72 h** security, **7 days** lockup/data, from the index |
| D3 | Does `notify` (or a pin) stop a required update? | **No.** It is announced and scheduled, a pin shows a warning, and only a failing pre-flight or never-rule holds it. |
| D4 | Who holds the release signing key; where the index lives | The publish step's secret store (like the npm token); the docs site + release assets |
| D5 | State snapshot on rollback: restore it (losing the few minutes of new data) or keep the new data | **Restore** (a schema the old version can't read is worse), and say so on the card |
| D6 | General's card cadence | First qualification, then weekly; required: daily in the last 24 h |
| D7 | CLI drift (T3) under `ask`: card only, or schedule? | **Card only** under `ask`; schedule under `auto-when-idle` |
| D8 | Hub minimum member version (T5): remind or schedule? | **Remind** (the Hub advises; the owner decides), schedule only under `auto-when-idle` |
| D9 | Should P2 (two installs) block, or warn and continue? | **Block** automatic updates; an admin's own press may continue after reading the list |

---

## 8. Phases (each a PR series with its own review and captures)

1. **The card and the safe flow** (A):
   - the card in General and on the web, with server-side Not now;
   - one updater for every entry;
   - the general idle queue;
   - pre-flight P1–P10;
   - the state backup;
   - the post-start health proof and its rollback.
   - This alone answers the user's "people press Later".
2. **The signed index** (C): the publish workflow writes and signs it; the fleet fetches, verifies and caches it; T1/T2 required updates; T6 reminders.
3. **CLI drift and vendor changes** (T3/T3b/T4) and the Hub minimum (T5).
4. **`auto-when-idle`** as a policy, after a beta of evidence.

A rehearsal (as S-233's) proves each phase on a real install, including a forced rollback and a two-install machine for P2.

## 9. Risks

- **The health proof wrongly fails and rolls back a good update.** Each signal has a generous window, and a rollback is reported with its reason. Two rollbacks of the same version across fleets (via Hub reports, later) are a release signal.
- **Restoring the state snapshot loses work.** The window is minutes and announced (D5). Task-board and scheduler writes in that window are the main loss.
- **A key leak** would let someone mark a version "required" toward their own published version. That doesn't help an attacker: only npm-published `@songsid/agend` versions are ever installed, and the index only names a version. Rotation (§5.1) is the recovery.
- **More automation in a path that can stop the fleet.** Mitigated by the never-rules, pre-flight and the soak, and by keeping `ask` the default (D1).
