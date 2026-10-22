# Bounded OOM recovery (#2015 / #2035, 2.4)

## Root cause and scope

All pane CLIs and tool children inherit the fleet service’s cgroup. With systemd’s default `OOMPolicy=stop`, one child OOM stops the unit. #2018 (`1037488ecb54c9a602a0dd09c92e609b64aca622`) already changed generated units and missing-key refresh to `continue`. This patch adds actual loaded-policy reporting to the shared post-reload inspection, not a second migration or another startup gate. It reports `continue`, warns truthfully about loaded `stop`/`kill` and their fragment/drop-ins, or reports unknown. Explicit restart-hardening overrides remain untouched; a full install still writes AgEnD’s generated unit as before.

The daemon treats a dead CLI as a generic crash. It checkpoints and resumes the retained session. Startup reaching ready does not establish that this session will survive its next work. The generic retry/rapid-crash limits eventually stop the loop but do not explain repeated OOMs. Neither the issue nor this patch proves transcript size caused a historical incident.

## Rules and their failure modes

1. Capture an identifiable primary CLI while alive from the pane PID already returned by the liveness read. Follow at most four unambiguous shell/env links, verify parent/start identity and require the initial Linux PID namespace. Never search arbitrary tool descendants. This prevents a helper or a container PID from being confused with the primary CLI.
2. On exit 137, require an exact PID/comm kernel OOM victim record in the observed launch interval and current boot. Check disappearance/same-generation zombie before and after the asynchronous journal read. Bound the read to one second, 256 KiB, 256 records and five minutes; share one reader across simultaneous deaths. Aggregate cgroup counters, pressure, transcript size and 137 alone are not proof. Missing or uncertain evidence leaves ordinary recovery unchanged. The code observes deaths; it never kills a workload for memory.
3. Count consecutive confirmed deaths for the backend’s known session ID. A plain crash, a different/unknown session or an existing successful fresh launch breaks the streak; healthy ticks after a resume do not. After two, stop supervision in the existing crashed state, emit the existing General/web Log supervision-ended notice, and let Needs you expose the crashed instance. This is not an idle pause: queued work must not auto-wake it. The notice tells the person to free memory and explicitly retry or choose a fresh session.
4. Preserve session IDs and provider transcripts. Do not add auto-fresh, durable recovery intents, a new approval flow or new buttons. The previously reverted #2229 approach stays reverted. Explicit instance/fleet restart starts a new recovery attempt; the count is not persisted.
5. Tie pending evidence and recovery awaits to the captured health owner/tmux generation. Stop, pause or replacement voids the old continuation. This prevents an old death from stopping or launching a replacement instance.

## Limits and decisions

Only Claude Code currently supplies the per-instance session identity used by this guard. Codex/Kiro return no ID; Muse/Grok choose by cwd, which does not establish pane ownership. These backends keep ordinary recovery. macOS is not classified: there is no reliable cheap exact-PID jetsam collector here. Nested PID namespaces, unknown primary/session, unobserved fast deaths, unreadable journals, clock/identity uncertainty and truncated evidence also retain ordinary recovery. No classification is inferred merely from a cgroup OOM increment. This deliberately prefers a missed classification to stopping an unrelated session. Current procfs generation checks do not implement pidfd-based historical PID ownership.

Per-command memory caps remain deferred. The CLI starts tool commands; delegated per-instance cgroups would change service ownership, shutdown and accounting. No universal limit or proactive host process killer is introduced.

There is deliberately no uptime/time-window reset: two definitive same-session OOMs stop recovery even if days apart. Uptime alone does not show repeating this session is safe, and stopping preserves the person’s choice rather than guessing a new timeout. An ordinary crash, a different/unknown session or an existing fresh launch clears the streak.

The public restart path stops/removes the old Daemon (`InstanceLifecycle.stopInTransition`) and constructs a new one (`startInTransition`), so its count starts empty. Merely clearing `healthCheckPaused` or waking/reusing the same Daemon retains its count; `beginSpawn` cannot reset it because automatic resumes also use it. A fleet process restart also loses the in-memory count.

A common server account outside `adm`/`systemd-journal` cannot read kernel records. Then this guard is inert and the ordinary crash policy still applies. Read-only diagnostic: `journalctl --kernel --boot=0 --no-pager --lines=1`. If it reports insufficient access, ask the administrator about kernel-journal visibility; AgEnD does not elevate or change group membership.

## Verification and rollback

Focused tests exercise real Daemon health/spawn ownership with inert native boundaries and synthetic proc/journal evidence. They cover first-resume/second-stop, unchanged transcript, unknown/ordinary/helper deaths, session changes, bounded/shared readers, PID reuse/namespaces, and stop/replacement during evidence/backoff. Service tests inspect the loaded policy after notify repair, warning-only overrides/unknowns, and the pane PID producer/consumer. Independent mutations remove the stop, namespace, exact-victim, owner, loaded-value and pane-PID protections; each must fail a semantic assertion.

The manual [systemd 249 rehearsal](../../scripts/manual/oom-recovery/README.md) uses a private networkless capped container, real persistent user unit and real memory-hog child. It checks loaded `continue`, missing-key restart/target-installer refresh, a `stop` negative control and main-process `Restart=on-failure`. A sibling mock backend must still reply. The session-specific collector cannot be exercised as a host-namespace collector in Docker: its fake-evidence suites are explicitly separate from the real kernel OOM legs.

Build/postbuild and test typecheck run in capped private units. Full CI and parity review remain merge gates. Revert this PR to remove the new guard/reporting; no session data or durable marker needs rollback. #2018’s pre-existing `continue` policy remains. A stopped instance needs an explicit restart after rollback.
