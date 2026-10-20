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

1. **own the prefix first** (Prism r1): before anything in the prefix is touched, the installer claims it — the lock
   record is written aside and `link()`ed into place (whole or not at all). A live `agend-install` holds it → stop
   (exit 75), nothing changed. One whose writer is gone, or that cannot be read, is taken over: takers go one at a time
   (a `.takeover` claim held for milliseconds), and under it the lock is re-read and only the very bytes judged stale are
   moved — a lock a live installer took since is never moved. The prefix stays this installer's through the repair, the
   install, its retry and the rollback; the repair never reads or moves a lock;
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
   the user's host, whose session had ended. A hand-started fleet gets no unit (#1631) and only an upgrade restarts it;
7. writes each step to the update marker (`downloading` → `installed` / `failed` with the reason) — **only a marker it
   owns** (Prism r1): the one the `agend update` that started it wrote (`AGEND_UPDATE_OWNER_PID`), or one whose writer is
   gone (the user's stuck "downloading"), claimed only once the prefix is this installer's. A marker a live process
   writes — a running update's, a new fleet's — is never changed, and a refused installer touches no one else's.

**npm is provably idle** (Sentinel's rule from #2267 c284ce9d, refined twice): `ps -A -o pid=,ppid=,args=` shows no npm
whose command changes installed packages (`install`/`i`/`add`, `uninstall`/`rm`, `update`, `link`, `ci`, `dedupe`,
`prune`, `rebuild` and their aliases). npm retitles itself `npm <command> <args>` without flags, so `-g` is invisible and
any such npm counts; argv as started still shows flags, and a flag's value is skipped (`npm --prefix /x install` is an
install). An npm whose command cannot be told for sure counts as busy. Commands that cannot reify a prefix — `exec`/`npx`,
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
| Package preimage copy + restore (#1450 C6) | **Replaced** on the new path by "reinstall the previous version" (npm already keeps the old package when its own install fails). Still used by the compat path. | A release that installs but does not run must not leave the host without `agend`. |
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
  - Prism r1 interleavings (the installer's logic, npm and `agend` stubbed, a real prefix): a live installer that takes
    a stale lock over between this one's judgment and its takeover keeps its lock byte for byte (75); during repair,
    every install, the retry and the rollback the lock is this installer's and a peer is refused; a takeover claim left
    by a killed taker is replaced, a live one respected;
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
