# kiro-cli 2.36.0 → 2.37.0 audit (static)

Decision ffb8104e; the upstream watch's precheck was MAJOR (hard=3). **Static only:** both release tarballs were extracted into scratch, and kiro-cli-chat's Rust strings and its zstd TUI frames were compared. No kiro binary was run. The offline rig could not reach these screens either: without a login, every kiro UI stops at sign-in.

| tarball | sha256 |
|---|---|
| 2.36.0 kirocli-x86_64-linux.tar.gz | `ede3772e2340b60758c45ba25fe0fed54aa4c3af87d038b1b70fa7ba2e139cb2` |
| 2.37.0 kirocli-x86_64-linux.tar.gz | `02c49873ba64285f34048aac377ccf0b546b5627f39dd775bae9fa306112ff19` |

## The precheck's three missing literals: the prompt was REMOVED, not reworded
- **2.36.0**, `crates/chat-cli/src/launch/auto_migrate.rs`:
  - The interactive prompt "You're on Kiro CLI V3 … Your agent configs are still in the V2 format. Upgrade them to run on V3? They'll keep working in V2." with "Enable auto-upgrade" / "Not now … I'll do it later".
  - Plus "Agent upgrade prompt failed, skipping".
- **2.37.0**: none of it remains. In its place is a printed, non-interactive hint: "… in the V2 format and may not work as expected on V3. To upgrade it/them, run kiro-cli settings chat.enableAutoAgentUpgrade true". That setting already existed in 2.36.0, default true.
- **TUI frames:** identical counts for every one of these strings in both versions.
- **Evidence:** [kiro-cli-chat-agent-upgrade.strings.txt](kiro-cli-chat-agent-upgrade.strings.txt).
- **AgEnD:** `KIRO_AGENT_UPGRADE` / `KIRO_AGENT_UPGRADE_V2_FORMAT` cannot fire on 2.37.0. They stay, because hosts on ≤2.36 can still show the prompt; tests/kiro-2.30.0-audit.test.ts and kiro-engine-failsafe-1109 cover them. The hint trips nothing (tests/kiro-2.37.0-audit.test.ts).

## New in 2.37.0: the Kiro CLI 3.0 launch machinery (not handled yet)
Evidence: [kiro-cli-chat-v3-launch.strings.txt](kiro-cli-chat-v3-launch.strings.txt).
- **A new launch prompt** in `crates/chat-cli/src/launch/v3_launch_prompt.rs`: "Kiro CLI 3.0 is here. The new V3 agent brings workflows, simplified permissions, cloud sessions, sandbox, specs, and more. … V2 no longer receives new features and will be removed in January."
  - Options: "Switch to V3", "Stay on V2, remind me later", "Stay on V2, don't ask again", "Keep V2". The display order cannot be proven statically.
  - Per the telemetry text, the prompt is for existing V2 users who never pinned an engine; users who pinned V2 get a "3.0 launch notice" whose dismissal is "Keep V2".
  - In 3.0 launch mode the default engine is V3.
  - New state keys `v3Launch.*` and a new setting `chat.launch30`.
- **"Kiro CLI 3.0 no longer runs Classic (the v1 engine), so this run ignores the Classic selection."** and "Kiro CLI 3.0 no longer includes Classic …"
- **Storage markers** (`conversations_v2` and its queries) are unchanged.
- **AgEnD has no detector for the new prompt,** and AgEnD pins legacy instances with `--legacy-ui --agent-engine v1`, which 2.37.0's `--help` still lists. Whether 3.0 launch mode is on by default or gated cannot be read from strings.
- **Follow-ups pending the user's OK:** a hold-only detector for the prompt and notice, so Enter never confirms "Switch to V3"; and the Classic-ignored line treated as a fatal startup screen for a v1-pinned instance.
- **kiro 2.37.0 is NOT marked audited.** It needs a real migration rehearsal (a login, the user's per-batch OK).
