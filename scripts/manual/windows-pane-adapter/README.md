# Windows pane adapter probes

These are manual acceptance harnesses for #2954. They never start the live fleet, use its tmux socket, or call systemd. Some start an isolated in-process Fleet/Daemon and a private pane host in the explicitly approved scratch folder. Build TypeScript and runtime assets into a dedicated directory first. The native controllers below are deliberately restricted to the approved `C:\Users\changhansung\agend-adapter-proto` tree; obtain explicit authorization before a signed-in run. They are not unattended user diagnostics.

`native-screen.mjs` runs on native Windows Node with inert CLI-shaped fixtures through a private PATH and private provider homes. It checks two simultaneous panes in the same cwd, separate instruction arguments and screens, Unicode, paste, resize, owned exit, reconnect after client death, host-death receipts, enrollment retirement, actual-version refusal and the command-line limit. Removing the production worker's length guard must fail its oversized-launch assertion **below** Windows' own hard limit; removing its final version gate must fail the newer-version control. No installed coding CLI or account is used. The WSL `native-screen-controller.mjs` stages the standalone runtime, records the code-bundle digest/source commit and removes the scratch tree after confirmed completion.

`remote-native-controller.mjs` and `remote-native-runner.mjs` exercise real pairing HTTP and the outbound authenticated WebSocket against a scratch coordinator. The native side runs the packaged ConPTY worker with inert providers/private homes. They compare fingerprints, approve the exact claim, run two panes, enforce the machine cap, refuse an arbitrary executable field, replace the coordinator connection, reject duplicate input, rotate the credential while preserving panes, and verify exact terminal snapshots after explicit revocation. Credentials are kept only in the private runtime profile, never printed. Cleanup closes the owned host before removing the scratch profiles. This is loopback transport acceptance, not certification of a particular Tailscale or SSH deployment.

`fleet-native-controller.mjs` with `fleet-native-runner.mjs` uses signed-in native Codex and Claude and ordinary FleetManager, lifecycle, Daemon, transcript monitor and scoped MCP. It forbids coordinator tmux process boundaries and exec fallback. Its only outbound replacement records a fixed reply canary in place of sending it to a real chat account. The default mode proves reply/response-written ACK, reply guard, progress, resident reattachment without input replay and a new launch retaining the same Codex session, then confirmed pane exit followed by the existing exec worker continuing each same saved conversation. `safety` adds `fleet-native-safety.mjs` for scratch read-only/workspace enforcement and cwd writes with parent/sibling file writes refused despite scratch-local widening settings, plus a separate shell permission request denied through the ordinary permission-card controls. `detached-empty` opens no CLI: it proves the actual detached host launch and same-host reattachment, then checks its exact executable/command/birth identity before terminating only that empty scratch host.

Example commands from the worktree (the compiled package also needs the ordinary UI/instruction assets):

```sh
npx tsc --outDir .artifacts/pane-full-package/dist
node scripts/build-runtime-assets.mjs .artifacts/pane-full-package/dist/runtime-assets .artifacts/pane-full-package/dist
node scripts/build-runtime.mjs .artifacts/pane-stage4-bundle .artifacts/pane-full-package/dist
node scripts/manual/windows-pane-adapter/native-screen-controller.mjs
node scripts/manual/windows-pane-adapter/remote-native-controller.mjs
# Requires separate signed-in authorization and an exclusive CLI window:
node scripts/manual/windows-pane-adapter/fleet-native-controller.mjs .artifacts/pane-full-package/dist safety
node scripts/manual/windows-pane-adapter/fleet-native-controller.mjs .artifacts/pane-full-package/dist detached-empty
```

`source-receipt.mjs` records `sourceHead`, whether tracked source was clean, and the standalone code-bundle hash where applicable. Final evidence must name a clean exact head and the rebuilt bundle; a WIP receipt is component evidence only. Controllers save fixed metadata and booleans, not raw screens, tool arguments or conversation copies. The CLI retains its own normal history. A failed or unconfirmed cleanup retains only its owned scratch reservation for explicit inspection; do not erase an uncertain process outcome to make a test green.

`status-session.mjs` and `status-session-controller.mjs` are signed-in manual probes. They require separate authorization to use the person's native CLI. The controller keeps raw captures in its in-memory pipe and prints only fixed diagnostic categories, UUIDs and boolean evidence. Its default Codex run submits `/status`, with no model turn; `--turn` adds one fixed read-only canary turn. `--claude` uses the worker-reserved session UUID instead. `--trust-scratch` may be used only after approval for the exact scratch path; it verifies the displayed path and cursor before each single key. A successful trust choice leaves the provider's ordinary scratch-folder trust entry in place. It never edits an account config or credential file by hand.

Native Codex runs with `--no-daemon`. Each pane therefore owns its own app-server process tree instead of depending on a shared background daemon. Its agent role is supplied through the invocation's `developer_instructions` config slot. This supplements the provider's built-in model instructions and leaves project AGENTS files untouched; for this managed invocation it replaces any user-configured value of that **same developer-instructions slot**. It writes no profile file or account config. Roles are not merged into a shared project file: two agents may work in the same directory with different identities.

Windows bounds apply to the entire escaped command line, including the CLI launcher, paths and MCP arguments. The worker refuses commands over 30,000 UTF-16 units before starting the CLI. It never truncates role instructions or switches to a shared-file fallback. Claude uses a private launch-local append-instructions file.

These probes complement focused lifecycle/security tests and real private-tmux parity. Their receipts do not claim a physical Windows reboot, a real ARM64 host, every provider sandbox/network policy, or real Discord/Telegram delivery. The combined PR requires clean exact-head evidence before review; the final whole-alpha user-story acceptance remains a separate run. The exec adapter remains the default.

### Older-alpha upgrade and host-loss recovery (#2976)

With explicit signed-in Windows approval and an exclusive Codex window, build both the pre-#2975 source at `9268bc304` and this head, then run `scripts/build-runtime.mjs .artifacts/runtime-bundle` in each worktree. From the clean current worktree:

```
node scripts/manual/pane-host-recovery/upgrade-acceptance.mjs ../pane-upgrade-before paired
node scripts/manual/pane-host-recovery/upgrade-acceptance.mjs ../pane-upgrade-before local
```

The controller creates a fresh approved scratch folder/profile and loopback coordinator, uses the real default relay/link and the old/new compiled managers, and submits one read-only Codex canary. It preserves the profile while upgrading the client, verifies the old-host hold, then force-ends **only its freshly created, path-verified scratch host tree** to reproduce abrupt loss. It checks independent create, exact admin recovery, unchanged old MCP ledger, same-session resume and no canary replay. A second abrupt loss keeps the manager/lifecycle binding alive and proves that a fresh endpoint’s exact exit retires the permanently dead old local relay before resuming again. It never touches another acceptance rig. Provider records/captures stay in memory. Each owned UUID is archived with the supported Windows `codex archive` command after its processes stop; archive results and scratch cwd are included in the metadata receipt. No separate CODEX_HOME is used. A failed cleanup/archive retains the owned scratch for inspection. This is a host-tree-loss proof, **not** a physical Windows reboot; OS-boot proof changes and conservative missing-proof holds are covered offline.

A displayed Codex UUID can be ephemeral until its first turn: `codex archive` then returns a refusal because neither a rollout nor an index row exists. The controller checks only the exact UUID against bounded provider filenames/index metadata after its process exits and records such IDs as `unmaterialized`, never as archived. It does not create a turn merely to make an empty UUID archivable, and never removes provider files by hand. Exact scratch-cwd headers identify any written test sessions omitted from a failed startup's receipt.

### Never-written Claude session recovery (#2984)

With the same signed-in approval and exclusive Windows CLI window, run
`node scripts/manual/windows-pane-adapter/fleet-native-controller.mjs dist session-recovery`.
It starts and stops Claude before any model turn, checks the runner's positive absence proof and one automatic fresh session, then stops that unwritten replacement and proves repeated starts hold in Needs you without another automatic reset. An exact admin decision chooses a fresh conversation. The ordinary Fleet/Daemon path then delivers minimal turns to both Claude and Codex while idle, busy and just resumed; resident reattachment must send no startup input. The old pin remains in the private intent receipt. After positive process/host close, the harness archives its own Codex test UUID using the supported CLI and records the ID; it never edits provider files or uses a separate CODEX_HOME.

`stale-session-tab.mjs` serves the actual pre-upgrade and current recovery components in a real headless browser against the production instance API and a private inert manager/host. The old tab must fail safely with refresh guidance and no pin change; after reload there is one new-conversation action, and its exact confirmation changes the pin. This uses no Windows CLI or real fleet. Install Playwright only in a private test dependency directory and pass `AGEND_PLAYWRIGHT` / `PLAYWRIGHT_BROWSERS_PATH` for this opt-in smoke; it is not a runtime dependency.
