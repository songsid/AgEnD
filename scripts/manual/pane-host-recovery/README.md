# Pane shutdown and recovery proof

Run only with approval for the signed-in Windows Codex account and an exclusive CLI test window. Never use another person's runner/profile or the live fleet. This rig creates its own `agend-adapter-proto/recovery-*` Windows folder, a new paired profile, and a loopback coordinator in `.artifacts`. It uses no systemd or tmux server, changes no account settings and copies no credentials. One minimal read-only model turn is sent. Raw captures/transcript records stay in memory.

After committing the source, building and merging the required alpha fixes:

```sh
npm run build
node scripts/build-runtime.mjs .artifacts/runtime-bundle
node scripts/manual/pane-host-recovery/acceptance.mjs
```

The exact-source receipt checks a real ConPTY pane through the authenticated paired runtime, host-origin reattach despite a deliberately removed scratch coordinator snapshot, relay/coordinator restarts without input replay, positive exit while the coordinator is down, no-launch tombstone reuse after capacity becomes available, same-session resume, empty-host shutdown, and a new host boot on switch-on. Provider version changes, unexpected screens or unconfirmed input fail closed. No other CLI/fleet/profile is signalled. Cleanup uses the exact private enrollment's authenticated host protocol, never a process-name sweep. It verifies every observed scratch host exited before removing the scratch profile. Failed cleanup retains the owned scratch and reports that fact.

The snapshot loss is a deliberate modification of this rig's own coordinator metadata, not a live store edit. Fixture tests additionally cover busy/unpinned reattachment, an in-flight launch versus shutdown, persistence failure, foreign exit scope and unknown outcomes; those remain reserved and receive no replay or startup keys. This is a focused paired transport/CLI proof, not a complete chat/Settings acceptance.
