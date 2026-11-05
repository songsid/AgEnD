#!/usr/bin/env node
/** Minimal Windows runtime entry point; deliberately independent of the full AgEnD CLI. */
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { RuntimeClient, describeRuntimeStop, pairRuntime, rotateRuntimeCredentials } from "./runtime-client.js";
import { RuntimeClientStore, validateRuntimeServer } from "./runtime-client-store.js";
import { readRuntimeInfo } from "./runtime-build-info.js";
import { readPaneSystemBootId, reusedRuntimeLockPid } from "./runtime-pane-boot.js";
import { chooseRuntimeProfile, readBundledRuntimeServer, resolveRuntimeServer, runtimeServerProfile } from "./runtime-connection.js";

const HELP = `AgEnD native Windows runtime

  agend-runtime --version
  agend-runtime connect --server https://agend.example.com [--name NAME] [--profile DIRECTORY]
  agend-runtime run [--profile DIRECTORY]
  agend-runtime status [--profile DIRECTORY]
  agend-runtime rotate [--profile DIRECTORY]
  agend-runtime disconnect [--profile DIRECTORY]

connect asks for a one-time pairing code, waits for approval in AgEnD, then runs in the foreground.
Connection-ready downloads include the server address; double-click connect-agend.bat to connect or reconnect.
run reconnects an existing profile. Press Ctrl+C to stop. disconnect forgets a stopped local profile;
revoke the machine in AgEnD Settings to invalidate its credential centrally.
rotate replaces a stopped profile's machine credential without pairing again. Stop run/connect first.
HTTP is accepted only for loopback, for example an SSH-forwarded localhost endpoint.
CLI login, workspaces and devices stay on this computer. No CLI login data is uploaded.
`;
/** Same lock proof as run: a Windows restart's boot id and a reused PID must not leave a stale lock that blocks disconnect or rotate. */
async function lockProfile(store: RuntimeClientStore, name: string): Promise<() => void> {
  if (process.platform !== "win32") return store.lock(name);
  const systemBootId = await readPaneSystemBootId();
  return store.lock(name, systemBootId, await reusedRuntimeLockPid(store.lockHolder()));
}
export interface RuntimeMainOptions { /** Folder holding agend-server.json; defaults to the extracted Runtime folder. */ programDirectory?: string; home?: string; env?: NodeJS.ProcessEnv }
export async function runtimeMain(argv = process.argv.slice(2), options: RuntimeMainOptions = {}): Promise<void> {
  const env = options.env ?? process.env, home = options.home ?? homedir();
  if (argv.length === 1 && argv[0] === "--version") { process.stdout.write(`${JSON.stringify(readRuntimeInfo(), null, 2)}\n`); return; }
  if (!argv.length || argv.includes("--help") || argv[0] === "help") { process.stdout.write(HELP); return; }
  const [command, ...args] = argv;
  if (!["connect", "run", "status", "disconnect", "rotate"].includes(command)) throw new Error("Unknown runtime command. Use agend-runtime --help.");
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--server", "--name", "--profile"].includes(key) || !value || value.startsWith("--") || flags[key] !== undefined) throw new Error("Invalid runtime arguments. Pairing codes must be entered interactively, never in command arguments.");
    flags[key] = value;
  }
  if (command !== "connect" && (flags["--server"] || flags["--name"])) throw new Error("--server and --name are used only by connect");
  const explicitProfile = flags["--profile"] || env.AGEND_RUNTIME_HOME;
  const defaultProfile = resolve(join(home, ".agend-runtime"));
  let bundledServer: string | undefined;
  // Only connect needs a valid bundled address; run/status/rotate/disconnect just use it to find the same profile.
  if (!flags["--server"]) { try { bundledServer = readBundledRuntimeServer(options.programDirectory); } catch (error) { if (command === "connect") throw error; } }
  // Without an explicit profile, a bundled server that differs from the default profile's pairing gets its own profile under it.
  const choice = explicitProfile ? undefined : chooseRuntimeProfile(defaultProfile, bundledServer, command === "connect");
  const store = new RuntimeClientStore(resolve(explicitProfile || choice!.directory));
  if (command === "status") {
    const credentials = store.credentials();
    process.stdout.write(`${JSON.stringify({ runtimeInfo: readRuntimeInfo(), profile: store.directory, paired: !!credentials, ...(credentials ? { server: credentials.server, machineId: credentials.machineId, name: credentials.name } : {}),
      rotationPending: !!credentials?.pendingCredential, blocked: store.blocked(), jobs: store.list().map(job => ({ id: job.task.id, seq: job.seq, status: job.task.status, uncertain: job.uncertain })) }, null, 2)}\n`);
    return;
  }
  if (command === "disconnect") {
    const unlock = await lockProfile(store, "disconnect");
    try { store.forgetCredentials(); process.stdout.write("Local connection forgotten. Revoke the machine in AgEnD Settings to invalidate its credential centrally.\n"); }
    finally { unlock(); }
    return;
  }
  if (command === "rotate") {
    const unlock = await lockProfile(store, "rotate");
    try { await rotateRuntimeCredentials({ store }); process.stdout.write("Runtime machine credential rotated. Run agend-runtime run to reconnect; no pairing is needed.\n"); }
    finally { unlock(); }
    return;
  }
  if (process.platform !== "win32") throw new Error("This runtime preview must run with native Windows Node, under the Windows user whose CLIs it uses.");
  if (command === "connect") {
    const current = store.credentials();
    const target = flags["--server"] ?? bundledServer ?? current?.server;
    const server = validateRuntimeServer(resolveRuntimeServer(flags["--server"], bundledServer, current?.server, target && runtimeServerProfile(defaultProfile, target), flags["--profile"] && resolve(flags["--profile"])));
    process.stdout.write(`AgEnD server: ${server.origin}\n`);
    if (choice?.separate) process.stdout.write(`This computer's default profile is paired with ${choice.defaultServer}; using a separate profile for this server:\n  ${store.directory}\nThe same connect-agend.bat reuses it. The existing pairing is untouched.\n`);
    if (!current) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Pairing requires an interactive terminal. The code must not be supplied in arguments or environment variables.");
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      let code: string;
      try { code = await readline.question("One-time pairing code from AgEnD Settings: "); } finally { readline.close(); }
      const controller = new AbortController();
      const abort = (): void => controller.abort(); process.once("SIGINT", abort);
      try { await pairRuntime({ server: server.origin, name: flags["--name"] || hostname(), code, store, signal: controller.signal, report: text => process.stdout.write(`${text}\n`) }); }
      finally { process.removeListener("SIGINT", abort); }
    }
  }
  const client = new RuntimeClient({ store, report: text => process.stdout.write(`${text}\n`) });
  await client.start();
  const stop = (): void => { void client.stop().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await client.waitUntilStopped(); }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  // AgEnD ended the connection and someone has to act: that is a failure (non-zero exit), never a silent normal exit.
  if (client.stopReason) throw new Error(describeRuntimeStop(client.stopReason));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runtimeMain().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Runtime failed"}\n`); process.exitCode = 1; });
}
