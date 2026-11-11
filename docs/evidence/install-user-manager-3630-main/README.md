# #3630 / M-2882 — install user-manager diagnostics (main)

`agend install` used to catch a failed `systemctl --user daemon-reload` and print another command requiring the same unavailable connection. The new preflight reuses `getSystemdServiceState` and `privateSocketPath` before activation or stopping a hand-started Fleet. It distinguishes a stopped user manager, an active manager with both connection paths missing, and an unverified state. A reachable manager with an inactive/missing Fleet unit continues ordinary activation.

The recovery is advice only. An active manager with both paths missing gets a manual **restart**, with the warning that Fleet, every agent and all other services under that user stop. A stopped manager gets **start**. Non-root commands use `sudo`; unknown state gets `status`, not a guessed restart. Existing linger/start preparation is unchanged. No automatic manager restart, timeout increase, unit-directive change, or parked layered-repair implementation (#2882 / M-2181) is included.

EN and zh-TW show the lasting WSL fix before temporary recovery, only when `WSL_DISTRO_NAME` or `/proc/version` identifies WSL. The [upstream issue](https://github.com/microsoft/WSL/issues/13143) records the missing-socket failure and fix in 2.6.0; the [2.6.0 release](https://github.com/microsoft/WSL/releases/tag/2.6.0) describes systemd user-session fixes. The text follows the leader's approved wording. See `active-zh-TW.txt`, `active-en.txt` and the stopped-manager counterparts.

## Checks

- Original main `cf7f4b88945c7f2c70036874f907bf4da690a9fb`: the four real-source CLI regression cases fail with assertion errors, not fixture/loader failures. Their `systemctl` is a recorder stub; HOME and data are isolated. `fail-first.log` and receipt record this negative control.
- Candidate: **133/133** across `install-user-manager-3630`, `service-installer`, `cli-machine-lines-2390`, `systemd-container-guard-3041`, and `update-busless-1804`. New suite **14/14**, including ordinary reachable-manager activation, file-only install, unknown/one-socket states, both UID privileges, both WSL detection sources, non-WSL omission and unchanged generic Linux/macOS hints.
- `npm run typecheck` and `npm run typecheck:tests`: pass. Changelog assembly validation and shell syntax: pass.
- **12/12** independent guard reversals cause assertion failures; source restored, new suite **14/14** again. `mutations.json` names every reversal and failure count. Reproduce with `node scripts/manual/install-user-manager-3630/mutations.mjs` (run only in an owned clean checkout).

The receipts identify a **pre-commit modified tree**, with exact product, test and harness bindings. They do not claim execution from a later commit. CLI transcripts normalize the disposable fixture directory name and trailing blank lines; the assertions and container output are unchanged.

## Safe container rehearsal

`bash scripts/manual/install-user-manager-3630/rehearse.sh` uses the existing binfmt guard, no `--privileged`, no network, private network/cgroup namespaces, container-owned `/run` tmpfs and read-only source mounts. Host netns and binfmt listings compare equal afterwards; the owned container is removed by the trap. It neither modifies host networking nor runs a host test Fleet.

This run uses an existing **Ubuntu 22.04.5 / Node 22.23.3** image with systemd and dbus. It models the **consequence** of the reported Ubuntu 24.04 / WSL 2.5.7 bug by unlinking only the two container-owned sockets while `user@0.service` remains active. It does not reproduce the WSL kernel bug or validate the user's upgraded machine.

`container.log` shows baseline and candidate output. An inert `sleep infinity` service remains alive after the candidate refuses activation, proving diagnosis did not restart its manager. Only the separately invoked manual recovery restarts the manager, interrupts the old inert process, recreates both sockets, and starts a fresh inert service. The CLI-written real Fleet definition is replaced with the inert unit **before** recovery. No AgEnD Fleet, agent, real account, pilot or directory was started or changed.

## Risk and rollback

The extra state reads are existing bounded read-only systemctl probes. If connectivity/state cannot be verified, installation leaves the unit written but refuses activation and asks for inspection. Recovery commands interrupt user services only when the person runs them; the warning is explicit. Reverting this patch restores the old diagnostic/activation behavior; there is no data/schema migration.
