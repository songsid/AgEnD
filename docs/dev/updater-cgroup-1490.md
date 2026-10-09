# Chat updater cgroup rehearsal (#1490 row 37)

A detached process gets its own process group, but stays in its parent's systemd
cgroup. Both chat update handlers previously launched the verified installed
AgEnD through a detached shell. `KillMode=mixed` therefore killed the updater
when its own service restart reached forced cleanup, before activation returned.

The launch helper now selects an independent same-user transient **scope** for
Linux service callers. Scope activation completes before the shell runs; it
keeps the caller's environment and cwd. Systemd 240–253 passes scope argv
literally; 254+ receives `--expand-environment=no`. Unknown cgroup state or an
unverified launcher refuses. A scope launch error never falls back to detached
execution in the original cgroup. This does not loosen fleet stop or restart
ownership checks. Scope execution and environment semantics are documented in
[systemd v252's implementation](https://github.com/systemd/systemd/blob/v252/src/run/run.c)
and [the v255 command reference](https://github.com/systemd/systemd/blob/v255/man/systemd-run.xml),
which dates the expansion flag to v254.

## Native evidence

[Hosted disposable VM run 37987831656](https://github.com/songsid/AgEnD/actions/runs/37987831656)
executed the production `resolveUpdateLaunch` leaf and inert Node children only.
It installed a real private runtime-linked user unit, reloaded its real user
manager and confirmed its loaded fragment and `KillMode=mixed`. The fixture used
`Type=simple` and a **2 s** stop grace, which tests the cgroup mechanism; it does
not claim the production 300 s stop timing.

| Case | Observed outcome |
|---|---|
| Detached updater, external stop | Updater killed; stop took 2,157 ms. |
| Detached updater restarts its own unit | Updater killed before restart returned; replacement unit active. |
| Actual scope planner, same restart | Updater in a different cgroup; restart returned 0; updater survived. |
| Scope argv/environment/cwd | Quoted `$HOME`/semicolon/space path, literal environment and cwd preserved. |
| Unrelated private child | Survived all three controls. |
| Cleanup | Own unit and scopes stopped, runtime link disabled, user manager reloaded. |

All 38 checks and all four cleanup checks passed. The exact sanitized
[receipt](evidence/1490-updater-cgroup.json) records the source/probe hashes.
The probe-only branch used an already registered dispatch workflow path, replaced
there with just the Linux job; the main Mac workflow was unchanged. The new
`updater-cgroup-rehearsal.yml` keeps that Linux job dispatch-only for future runs.
Earlier probe trials failed on fixture path/WorkingDirectory validation and are
excluded from this successful receipt.

No actual fleet, adapter, backend CLI, account, tmux, service on the operator's
host, or operator database was used. Mac launch behavior is unchanged; this is
Linux evidence. The real-Mac release rehearsal obligation for the earlier
activation changes remains separate.

## Limits and rollback

A system service whose same-user manager is unavailable needs a host-shell
update. Scope isolation does not survive host shutdown or a stopped user manager.
Linux cgroup detection uses the process-visible kernel paths; a cgroup namespace
that hides an enclosing host unit is outside this proof. There is no guarantee
that arbitrary external service-manager edits are atomic with launch.

Reverting this change restores detached chat updates and their known cgroup
risk. It does not undo an update already performed; there is no data migration.
