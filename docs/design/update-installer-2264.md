# #2264 — one installer: install, upgrade and repair are the target release's own program

Author: agend-dev-claude-t1519896892392083558 (independent proposal; adjudicated by Fable). Draft PR: see the PR that adds
this file.

## 1. Root cause (the user's host: WSL, root, nvm prefix `/root/.nvm/versions/node/v22.23.2`)

| What the user saw | Why (code path, evidence) |
|---|---|
| Telegram stuck at "⬇️ 下載及安裝中... (22s)", then `agend: command not found` | `/update` → `systemd-run --user --scope … agend update` (update-launch.ts `resolveUpdateLaunch`) → `npm install -g` (update-install.ts:286, no timeout). The scope and the fleet both live in **root's user manager `user@0`**. Root has **no linger** (nothing in AgEnD ever runs `loginctl enable-linger`; the Windows installer keeps root alive only with a `sleep infinity` session), so when that session or the WSL VM went away, `user@0` was torn down with npm **mid-reify**: npm had already moved the old package to its retire sibling and not yet finished the new one. `bin/agend` led nowhere. The only writers of the chat message (the old fleet's poller and `watchUpdateLaunch`) died in the same teardown, so nothing ever wrote a final state. |
| `npm install -g` → `ENOTEMPTY` renaming `@songsid/agend` → `@songsid/.agend-RmEK4vIL` | npm's retire name is **deterministic**: `.<name>-` + 8 alphanumerics of sha1(path) (`@npmcli/arborist/lib/retire-path.js`). The sibling the killed npm left is exactly the name every later npm tries to rename into → every `npm install -g` fails until it is removed. AgEnD never cleans it (no code touches `.agend-*`; only a chat hint, shown only if the old fleet is alive). The "Removing obsolete agend-plugin-discord … removed 26 packages" line is install.sh's unrelated pre-step. |
| After `rm .agend-*`: "the install lock …/.agend-install.lock cannot be read as a lock", recovery `npm install -g @songsid/agend@2.1.12` | The updater writes the lock with `writeFileSync(…, { flag: "wx" })` — create, then write: killed in between (or the VM stopped before the write reached disk) it is **empty/truncated**. AgEnD's **postinstall** (`launcher/install-admission.cjs` `admit`) refuses every install while a lock cannot be parsed (`:146`) — so a corrupt lock **blocks a manual `npm install -g`** until removed by hand. The "2.1.12" is a **hard-coded constant** (`launcher/old-updater-note.cjs:31`); the note fires because a fresh `update-in-progress.json` exists, which it attributes to *2.1's* updater — wrong for a 2.2 `/update`, and a downgrade advice. |
| After `rm` of the lock: `agend start` → "Failed to connect to bus … refusing to start a detached duplicate" | Same root cause as row 1: no linger → no `user@0` → no `/run/user/0`; a non-login shell also has no `XDG_RUNTIME_DIR`. `startService` (service-installer.ts) runs `systemctl --user start` and the CLI refuses a detached duplicate (cli.ts:1970). The user's `loginctl enable-linger root` + `XDG_RUNTIME_DIR=/run/user/0` is exactly the missing piece. |

**In one line:** the fleet and its updater run in a user manager that nothing keeps alive; when it dies mid-install, npm's
deterministic retire sibling and a half-written lock then refuse every repair, the recovery text points at the wrong
version, and `agend start` cannot reach the manager that would have kept all of this from happening.

## 2. The proposal: one installer, run from the target release

```
npm exec --yes --package @songsid/agend@<target> -- agend-install [--upgrade]
```

`launcher/agend-install.cjs` (new, ~400 lines, plain Node built-ins, old-Node syntax) is the **only** install logic:

1. **own the prefix first** (Prism r1, r2): before anything in the prefix is touched. Between these installers it is
   announce-then-check, and nothing of another installer is ever moved to decide it (r2: any takeover of one shared
   lock path can move a newer owner's lock by a reader that judged an older one). Each installer writes an entry of its
   own, `<prefix>/.agend-install.d/<pid>-<random>` (whole: written aside and linked), then lists the others; one whose
   writer runs → it withdraws its own entry and refuses (exit 75), nothing changed. Of two that race, the later lister
   sees the earlier one, so two are never admitted (both may refuse: run again). An entry whose writer is gone has a name
   no one else will write, so it is moved to quarantine without a race. The admitted installer then also holds
   `<realpath(prefix)>/.agend-install.lock`, the lock updaters from before #2264 take — **by their rules** (Prism r3: they
   do not read `.agend-install.d`, so moving their lock even for a moment breaks their exclusion): its record is in their
   format (pid + start time), so a running old updater sees a live holder and waits; a holder is judged as they judge it
   (live / stale / unknown, start ticks or start time — unknown blocks); a stale lock is moved only by the holder of their
   `<lock>.reclaim` marker, under which the lock can change only by its own (gone) holder — re-read, then moved; nothing
   is ever moved aside to be judged afterwards. A reclaim marker left by a dead updater is never taken automatically
   (their rule). One addition: a lock that cannot be read (created, never filled — the user's) counts as stale only when it
   is proven that no process has it open: their create-then-write holds the file open from `open(wx)` to the write, and
   no one can open it to write it again. Linux: every `/proc/<pid>/fd` of the file owner's processes, matched by device
   and inode (a non-dumpable process — sd-pam, ssh-agent — whose descriptors cannot be read is skipped unless its
   command line names node or agend, then: unknown); macOS: `lsof`; anything that cannot be told blocks — only a
   definite "gone" (ENOENT: the process exited, the descriptor closed) is skipped, never a permission or I/O error
   (Prism r5: `/proc/<pid>/fd` is behind ptrace checks). A descriptor whose target cannot be stat'ed (a security
   module: CI runners refuse `stat /proc/<pid>/fd/0`) is skipped only when its link names no file on disk (a pipe, a
   socket, an anonymous inode, a terminal or `/dev/null`). A process none of whose descriptors may be inspected (target
   and link both EACCES: the kernel's ptrace check on a process with other credentials — CI has one) is treated as a
   non-dumpable one: skipped unless its command line names node or agend. A refusal names the path and error it met. Checked when
   judged and again under `.reclaim` right before the move. Age is no evidence (Prism r4: a writer paused a minute
   between open and write is still admitted when it resumes). The prefix
   stays this installer's through the repair, the install, its retry and the rollback; the repair never reads or moves
   a lock;
2. **repair** npm's leftovers, **only when npm is provably idle** (below): npm's retire sibling `@songsid/.agend-*` is put
   back when it is the only whole copy of AgEnD (`agend` runs again immediately; a partial new package in its place goes
   to quarantine), any other sibling and npm's retired bin links `bin/.agend-*` go to quarantine. **Nothing is deleted**:
   quarantine is `<prefix>/.agend-quarantine/<time>-<pid>/`, kept as evidence;
3. `npm install -g @songsid/agend@<its own version>`; one retry, only if a second repair changed something;
4. **prove** `<prefix>/bin/agend --version` is that version. When npm failed, first ask whether the previous version
   still runs (`<prefix>/bin/agend --version`): if it does, nothing else is done and the answer says "vX is still
   installed and runs — nothing was changed". Only when it does not (or the new one does not prove itself) is the
   previous version reinstalled from the registry, and the answer says it "was reinstalled and runs";
5. root under nvm: link `agend` and `node` into `/usr/local/bin` (moved here from install.sh);
6. **the service stays under the manager it has** (Prism r1), as `agend restart` picks it: the legacy system unit, else
   the user unit or the launchd job. The new release's `agend install --no-activate` refreshes that definition without
   starting anything (a legacy system unit is refreshed in place — never a second, user unit), then the fleet is
   restarted (`agend restart --yes`) when it runs, or started (`agend start`) when its service is installed but stopped —
   the user's host, whose session had ended. A hand-started fleet gets no unit (#1631) and only an upgrade restarts it.
   **When the new service does not come up, it rolls back (#2420)**, as the 2.2 updater's C6 path did: before npm, on a
   host with a service and a previous AgEnD, the installed package is copied to `<prefix>/.agend-rollback/` (with its
   node_modules: the bundled Node, the runtime receipt and key) with its bin links, and the unit/plist bytes are kept.
   If the refresh, the restart or the start fails — and, under launchd, also when they exit 0 but the fleet does not
   come up (launchd does not wait for it; a fleet that exits at start is restarted by KeepAlive forever): the job must run
   the pid `fleet.pid` names and `/health` answer with its startup complete (or that pid run steadily for a minute), and
   a job started again is a fleet that exited — then whatever the manager still runs or starts is stopped and must be
   proven stopped (else nothing is rolled back and the copy is kept, named), the previous package, bin links and
   definition go back (`daemon-reload`; launchd's activation plan removed), and the previous service is started again if
   it ran before (left stopped, and said so, if it did not). A failure that never stopped the fleet (the same pid still
   runs) restores the package and definition without touching it. The answer says what is true: "Rolled back: the
   previous package (vX) and <the unit> were restored; the previous service is running (pid N). The update did not
   succeed", or what could not be done. A hand-started fleet is not rolled back (2.2 neither: its ownership cannot be
   proven). On success the copy is removed. The copy needs free space the size of the installed package with its Node
   (~235 MB); without it the update refuses before npm ("Not updating: the installed AgEnD could not be copied aside for
   a rollback (…). Nothing was changed"). A copy whose installer died before its clean-up (`<version>-<time>-<pid>`, that
   pid gone) is removed by the next installer once it owns the prefix; one a rollback kept on purpose (its answer names
   it) carries a `kept.txt` and is never pruned, nor are 2.2's updater's copies (it prunes its own);
7. writes each step to the update marker (`downloading` → `installed` / `failed` with the reason) — **only a marker it
   owns** (Prism r1): the one the `agend update` that started it wrote (`AGEND_UPDATE_OWNER_PID`), or one whose writer is
   gone (the user's stuck "downloading"), claimed only once the prefix is this installer's. A marker a live process
   writes — a running update's, a new fleet's — is never changed, and a refused installer touches no one else's.

**npm is provably idle** (Sentinel's rule from #2267 c284ce9d, refined twice): `ps -A -o pid=,ppid=,args=` shows no npm
whose command changes installed packages (`install`/`i`/`add`, `uninstall`/`rm`, `update`, `link`, `ci`, `dedupe`,
`prune`, `rebuild` and their aliases). npm retitles itself `npm <command> <args>` without flags, so `-g` is invisible and
any such npm counts. argv as started still shows flags, and a flag is read the way npm reads it (r2): one that takes a
value consumes the next word whatever it says (`npm --prefix run install` is an install), one that takes none consumes
nothing, and an unknown one may be either — every reading is kept, and the npm is idle only if every reading's command
cannot reify. An npm whose command cannot be told for sure counts as busy. Commands that cannot reify a prefix — `exec`/`npx`,
`view`, `run`, … — are not counted, which is also why this installer's own `npm exec` ancestor needs no exemption (an
`npm install` ancestor is busy like any other). "Any npm" would have made every real AgEnD host busy: fleets run their
MCP servers as long-lived `npm exec mcp-remote …`. A process list that cannot be read (ps fails, an unparseable row, our
own pid missing) is **not** idle.

Callers:
- **`agend update`** becomes a thin launcher: choose the target (channel, downgrade guard, preflight — unchanged), mark
  the update, `npm exec … agend-install --upgrade --target <version>`, return its exit code. The installed package's
  install/verify/activate code is no longer on this path. Only a known target whose `bin` names `agend-install`
  (`npm view <target> bin`) goes this way: `npm exec --package <a release without it>` would run whatever
  `agend-install` PATH has (Prism r1), so an older target — `--stable`/`--version` back to a release from before this
  one — takes the compatibility path, and `--target` makes any other installer refuse.
- **`npm exec` and the bundled Node:** npm hoists `@songsid/agend-node-*` out of `<pkg>/node_modules` in its exec
  cache, so the postinstall did not find it at its exact path and, with a Node older than 22 running npm, refused —
  the update stopped before the installer started (found on the real Mac, Node 20). Under `npm exec`
  (`npm_command=exec`) a copy without the runtime at its exact path is not refused and gets no receipt: it only runs
  its installer, whose `npm install -g` proves the runtime where AgEnD is installed.
- **install.sh** (and so install.ps1, which runs it) ends with the same `npm exec … agend-install`. `AGEND_VERSION`
  picks a version or tag (`AGEND_VERSION=beta`). Releases from before the installer fall back to `npm install -g`.
- **The repair** for any broken host — including the user's — is re-running the one-liner. Every fix hint now says so.

### Steps today vs after (what is deleted)

| Today (2.2/2.3 `agend update`, 2.1.12+ layers) | After |
|---|---|
| updater (old code) in a scope → preflight → **nvm route?** → **prefix lock (wx) + install token** → **package preimage copy** → `npm install -g` → **postinstall admission (token/lock)** → verify (identity, PATH, `--version`, launcher selection, native DB in 2 threads) → **unit rewrite through the new bin** → activation proof (busless peer bus) → restart → nvm **system-copy retire** | `agend update` → preflight → `npm exec <target> agend-install --upgrade` → lock (installer-only) → repair → `npm install -g` → `--version` proof (else previous back) → `agend install --no-activate` + `agend restart`/`start` (new code) |
| A manual `npm install -g` can be refused by a lock | Never (the postinstall reads no lock) |
| Service: `agend install --no-activate` + `agend restart` through the verified bin | `agend install --no-activate` + `agend restart` (running) / `agend start` (stopped), under the manager the service has |
| Recovery text: `npm install -g @songsid/agend@2.1.12` | `curl -fsSL https://songsid.github.io/AgEnD/install.sh \| AGEND_VERSION=<target> bash` |

### Layers since 2.1.12 (leader's list): deleted, simplified, kept

| Layer | Decision | Threat that justifies what stays (a94a1bab) |
|---|---|---|
| Prefix install lock (#1449, #1950) | **Simplified**: only `agend-install` instances exclude each other; stale or unreadable is taken over; written atomically. | Two installers reifying one prefix at once (npm has no lock of its own; concurrent reify corrupts it). |
| Postinstall admission + install token (#1450 C1) | **Deleted** (`admit`, `AGEND_INSTALL_TOKEN` gate). | — (it is what turned a corrupt lock into a blocked install) |
| 2.1.12 note (old-updater-note.cjs, #1487) | **Deleted** (file and its uses in postinstall/preinstall). | — (2.1's updater is out of support; the generic repair covers it) |
| Package preimage copy + restore (#1450 C6) | **Replaced** on the new path by "reinstall the previous version" (npm already keeps the old package when its own install fails). Still used by the compat path. **Brought back for the service (#2420)**: a new service that does not come up restores the copy, the unit/plist and the previous service (step 6). | A release that installs but does not run must not leave the host without `agend`; one whose service does not come up must not leave the fleet down on it. |
| Verify depth (identity / PATH / launcher / native DB ×2) | **Simplified** on the new path to `<prefix>/bin/agend --version`; the bundled-Node + DB proof stays where it already runs on every install: the postinstall. | A release that cannot open its database on this host (Node/ABI) must not replace a working one. |
| Bundled Node + sh launcher (#1450) | **Kept** (untouched). | nvm/system Node switching under the fleet (the reason #1450 exists); not part of this failure. |
| Service unit rewrite on every update (#1743, #1804, OOMPolicy) | **Kept, moved**: it is the new release's own `agend install --no-activate` under the manager the service has (a legacy system unit stays one), then `agend restart`/`start`, which turn linger on. | A unit that still names the old program/home after an update (#1743). |
| Busless activation proof (#1804) | **Not used** on the new path (the restart goes through `agend restart`, which now finds the user manager itself). Kept for the compat path. | — |
| Obsolete plugin removal (#1832) | **Deleted** (Fable's review: install.sh's step goes, and it is not moved into the installer). | — (2.1-era plugin packages; a host that still has one keeps it, as any npm package). |
| nvm route + system-copy retire (#1660, 2.1-era layouts) | **Kept as the compatibility path**: only when the npm prefix is not writable (sudo needed) does `agend update` keep today's code. The system copy is retired **only for a confirmed 2.1 layout** (the copy the updater runs from is 2.1.x), never from "nvm" or "root" alone — a 2.2+ system copy is kept and the answer says so. | Hosts whose global prefix needs sudo. |

## 3. Requirements, one by one

- **No lock can break PATH or the chain to the installed version.** The postinstall no longer reads a lock; the
  installer's lock only waits for another live installer (exit 75, chat told) and is never left half-written; a stale or
  unreadable one is moved to quarantine by the next run.
- **Leftover self-heal.** Every run of the installer — `agend update` and the one-liner — owns the prefix first, then
  repairs (npm provably idle, see §2): npm's sibling put back (when it is the only whole copy), everything else quarantined, never
  deleted. With another npm changing packages on the host, npm's leftovers are left alone and the answer says so.
- **Busless start/restart + linger for root.** `src/user-systemd.ts` `ensureUserSystemd()` runs before every
  `systemctl --user` the CLI issues. Commands that change state (install, start, restart) turn linger on
  (`loginctl enable-linger`), root asks for `user@0`, and the manager's socket is waited for; a query (status, stop)
  only fills in `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` and never changes the host. Linger is what keeps the
  manager — and an update running in it — alive past the session that started it.
- **Re-running the one-liner is the repair.** It runs the same installer; tested on the user's exact state.
- **The chat progress always reaches a final state.** The installer writes `installed`/`failed` with the reason; the
  new fleet adopts any non-terminal marker at boot (unchanged) and, new, says when the version it runs is not the one the
  update aimed for ("The update to vX did not finish: AgEnD is running vY. To finish it, run the installer again: …").
  With linger, the fleet comes back on its own after a teardown, so that final message is posted.
- **Recovery text with the right version.** Every fix hint is the one-liner with `AGEND_VERSION=<the target>`.

## 4. The user's requirement: the update flow lives in the installer

- `agend update` = resolve target + `npm exec --yes --package @songsid/agend@<target> -- agend-install --upgrade
  --target <target>` (pinned to the version, npm's integrity checks; only a target that ships `agend-install`). The installer runs from npm's exec cache, not from the global
  prefix it replaces — it is never rewritten under itself (why the old updater preloaded its imports, cli.ts:1693).
- install.sh / install.ps1 end in the same entry point → install, upgrade and repair are **one code path**.
- The installed package's updater shrinks to that launcher + the compat path (prefix needs sudo, or a target from
  before the installer).
- **Bootstrap** (a host whose current updater is old): its next update still runs the OLD updater once. That run
  `npm install -g`s the new release and then calls **the new binary** for `agend install --no-activate` and
  `agend restart` — new code: linger on, user manager found. The new release's postinstall no longer refuses on a lock,
  and the new fleet's boot reports a version that did not land. From the update after, `agend update` is the thin
  launcher. A host broken by an old updater mid-npm is repaired by the one-liner (the newest installer).

## 5. Tests (this PR)

- `tests/agend-install-2264.test.ts` — **real npm** in a scratch prefix, fake releases as tarballs (offline):
  - *as left*: npm's real retire sibling (sha1 name) + retired bin link + partial new package + truncated lock + marker
    at "downloading" → `agend` does not run, and a plain `npm install -g` fails **ENOTEMPTY** (the user's step 1);
  - *one run of the target's installer* via `npm exec --package <release> -- agend-install --upgrade` → working
    `agend` v2, no sibling, no retired bin link, no lock, `agend install --no-activate` then `agend restart --yes`
    called, marker `installed` v2 — **no manual step**;
  - the user's host after the session ended (unit installed, fleet stopped), the one-liner → `install --no-activate`
    then `start`;
  - killed before anything new was written → the old AgEnD is put back first, then updated; a partial new package
    (package.json and bin map written, bins not yet) loses to the whole old copy, which is quarantined, not deleted;
  - another npm installing on the host → npm's leftovers untouched (said), npm fails as before;
  - npm fails while the previous version still runs → nothing else done, said so;
  - a hand-started fleet (no unit) → no unit made (#1631), only the restart;
  - npm idleness: `npm exec` (own ancestor, mcp-remote servers, behind flags with values) idle; any changing npm
    (titled, `node …/npm-cli.js`, behind `--prefix /x`, or an ancestor) busy; a command that cannot be told busy; an
    unreadable process list busy;
  - admission (the installer's logic, npm and `agend` stubbed, a real prefix): two installers in both orders of
    announce and check — never both admitted, a refused one withdraws only its own entry; **12 real processes** racing
    for one prefix, each running again when refused — all 12 get a turn, no two admissions overlap, every entry
    withdrawn afterwards; an entry whose writer is gone
    quarantined; a live pre-#2264 lock refuses; with **the real old `acquireInstallLock`** (src/install-lock.ts) and real
    processes: an old updater that takes the stale lock over after the new installer judged it keeps its lock byte for
    byte and a third (old) one is refused — never two admitted (Prism's interleaving); while the new installer holds
    `.reclaim` an old updater cannot take over, and afterwards reads the new installer as the live holder; a live or a
    dead reclaim marker refuses; a pid that now belongs to another process is stale; an unreadable lock that a real
    process created with `open(wx)` and still holds is refused however old (its write then lands in the lock it
    claimed), moved once its writer is gone; "cannot be told" refuses; EACCES/EIO on the
    writer's `/proc` entry, a descriptor, its descriptor list or the lock itself → refused (also when only the check
    under `.reclaim` meets it), EIO on any other process's list → refused; during repair, every install, the retry and the rollback the prefix is this
    installer's and a peer is refused;
  - the service per manager (legacy system unit, user unit, launchd job; running → `install --no-activate` +
    `restart --yes`, stopped → + `start`; hand-started → restart on upgrade only);
  - the marker: a refused installer leaves another update's marker (and an abandoned one) byte for byte, and fails
    only its own `agend update`'s; a live writer's marker is never claimed, a dead one's is; a marker replaced mid-run
    is left as it is;
  - `--target` naming another version → refused, nothing done; `agend update` with a target whose bin has no
    `agend-install` → the compat path, never `npm exec` (fleet-control-audit-1120);
  - the postinstall under `npm exec` with the runtime hoisted away and Node 20 → not refused, no receipt; the same
    under `npm install` → refused (launcher-1450);
  - a release that does not prove itself → the previous one is reinstalled and runs; the marker says why;
  - a live installer's lock → exit 75, nothing changed;
  - the postinstall/preinstall read no lock and carry no 2.1.12 note;
  - `ensureUserSystemd` (the user's steps 3–4): linger on, manager up, env filled; a query only fills the variables;
    already fine → nothing run; linger refused → reported.
  - `agend update`'s compat path keeps a 2.2+ system copy (nvm-retire-cleanup-warning-1660).
- **Real systemd** (the 2.2.5 rehearsal image, root, linger off, `user@0` stopped, no XDG/bus): before,
  `systemctl --user` → "Failed to connect to bus"; after `ensureUserSystemd()` → `{lingerEnabled, managerUp}`, and
  `systemctl --user is-system-running` → `running`.
- Updated: fix-hint tests (the one-liner with the target), tests of the deleted admission/2.1.12 note removed, the bin
  map and install.sh parity.

## 6. Not in this draft (follow-ups if chosen)

- **The sudo route** (npm prefix not writable): run the same `agend-install` under sudo and delete the second code path
  (the compat updater: nvm route, system-copy retire, update-install.ts) — one installer everywhere (Fable's review).

- Delete the now-unused updater code on the default path (update-install.ts verify/preimage, service-activation's
  busless proof) once the compat path is narrowed — kept here to keep the diff reviewable.
- launchd (Mac) needs no linger; the installer's service step is `agend install --no-activate` + `restart`/`start`,
  same as Linux.
- Rehearsal legs: Linux systemd user, WSL-as-root stand-in (root container), Mac launchd; the user's Windows run last.
