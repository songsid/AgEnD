/** Fixed program assets only. Prepared at build time; Linux installations load no Windows native module. */
export const RUNTIME_PANE_ASSETS = [
  { name: "@xterm/headless", version: "6.0.0", files: ["package.json", "LICENSE", "lib-headless/xterm-headless.js", "lib-headless/xterm-headless.mjs"] },
  { name: "@xterm/addon-serialize", version: "0.14.0", files: ["package.json", "LICENSE", "lib/addon-serialize.js", "lib/addon-serialize.mjs"] },
  { name: "node-pty", version: "1.1.0", files: [
    "package.json", "LICENSE", "CONPTY-LICENSE", "CONPTY-NOTICE.md", "lib/index.js", "lib/windowsConoutConnection.js", "lib/eventEmitter2.js", "lib/types.js", "lib/windowsTerminal.js", "lib/utils.js",
    "lib/worker/conoutSocketWorker.js", "lib/conpty_console_list_agent.js", "lib/interfaces.js", "lib/windowsPtyAgent.js", "lib/shared/conout.js", "lib/terminal.js", "lib/unixTerminal.js",
    ...["win32-x64", "win32-arm64"].flatMap(platform => ["conpty.node", "conpty_console_list.node", "conpty/OpenConsole.exe", "conpty/conpty.dll"].map(file => `prebuilds/${platform}/${file}`)),
  ] },
] as const;
export const RUNTIME_PANE_MODULES = ["runtime-pane-output.js", "local-pane-stage.ps1", "runtime-pane-stdio.js", "runtime-pane-stdio-protocol.js", "runtime-pane-protocol.js", "runtime-pane-mcp-protocol.js", "runtime-pane-mcp-relay.js", "windows-pane-mcp.js", "runtime-pane-link.js", "runtime-pane-private.js", "runtime-pane-private.ps1", "runtime-pane-service.js", "runtime-pane-assets.js", "runtime-pane-host.js", "runtime-pane-screen.js", "runtime-pane-store.js", "runtime-pane-boot.js", "runtime-pane-native.js", "runtime-pane-config.js", "runtime-pane-transcript.js", "runtime-pane-transcript-protocol.js", "transcript-records.js", "transcript-needles.js", "transcript-turns.js", "runtime-pane-process.js", "runtime-pane-worker.js", "runtime-pane-job-owner.js", "runtime-pane-job.ps1"] as const;

/** node-pty@1.1.0 npm prebuilds (lockfile integrity), bundled ConPTY 1.23.251008001. */
export const PANE_NATIVE_SHA256: Readonly<Record<string, string>> = {
  "prebuilds/win32-x64/conpty.node": "ee8f4e6f4dad71939eecfda11de249400e34bfefe4c8b48af13f3b5476f4035b",
  "prebuilds/win32-x64/conpty_console_list.node": "879dd94cfc79f1e263a00077597ae9448a5394b7d193381aaa50d992a1f91090",
  "prebuilds/win32-x64/conpty/conpty.dll": "7c7430632052ff703540b68371ec43821820aa1335d8e11dfbcd9ff00e9daaed",
  "prebuilds/win32-x64/conpty/OpenConsole.exe": "d1fe7faa62f9e955e2ac2371f95d7e5513df4d496255097158f979c94782c5fc",
  "prebuilds/win32-arm64/conpty.node": "25a06916c5cb1a3aac7acc401424d8e6a6a9e8eea441a3604cd657a0619555cd",
  "prebuilds/win32-arm64/conpty_console_list.node": "fda76b16afb3bf9a4de085c943b5fb4138ecbeb08e8254c09d5555ea5426bd4e",
  "prebuilds/win32-arm64/conpty/conpty.dll": "b6cca5f1081111f59e5255eec043d924ebd11a86d09986c0d121b680540b3380",
  "prebuilds/win32-arm64/conpty/OpenConsole.exe": "b7763ba27e80d5e84f9e60d1368ec2ddb25dfd10283336c0c9f3f252d35cb2f8"
};
