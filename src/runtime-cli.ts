#!/usr/bin/env node
/** Minimal Windows runtime entry point; deliberately independent of the full AgEnD CLI. */
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { RuntimeClient, pairRuntime } from "./runtime-client.js";
import { RuntimeClientStore, validateRuntimeServer } from "./runtime-client-store.js";

const HELP = `AgEnD native Windows runtime

  agend-runtime connect --server https://agend.example.com [--name NAME] [--profile DIRECTORY]
  agend-runtime run [--profile DIRECTORY]
  agend-runtime status [--profile DIRECTORY]
  agend-runtime disconnect [--profile DIRECTORY]

connect asks for a one-time pairing code, waits for approval in AgEnD, then runs in the foreground.
run reconnects an existing profile. Press Ctrl+C to stop. disconnect forgets a stopped local profile;
revoke the machine in AgEnD Settings to invalidate its credential centrally.
HTTP is accepted only for loopback, for example an SSH-forwarded localhost endpoint.
CLI login, workspaces and devices stay on this computer. No CLI login data is uploaded.
`;
export async function runtimeMain(argv = process.argv.slice(2)): Promise<void> {
  if (!argv.length || argv.includes("--help") || argv[0] === "help") { process.stdout.write(HELP); return; }
  const [command, ...args] = argv;
  if (!["connect", "run", "status", "disconnect"].includes(command)) throw new Error("Unknown runtime command. Use agend-runtime --help.");
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--server", "--name", "--profile"].includes(key) || !value || value.startsWith("--") || flags[key] !== undefined) throw new Error("Invalid runtime arguments. Pairing codes must be entered interactively, never in command arguments.");
    flags[key] = value;
  }
  if (command !== "connect" && (flags["--server"] || flags["--name"])) throw new Error("--server and --name are used only by connect");
  const store = new RuntimeClientStore(resolve(flags["--profile"] || process.env.AGEND_RUNTIME_HOME || join(homedir(), ".agend-runtime")));
  if (command === "status") {
    const credentials = store.credentials();
    process.stdout.write(`${JSON.stringify({ paired: !!credentials, ...(credentials ? { server: credentials.server, machineId: credentials.machineId, name: credentials.name } : {}),
      blocked: store.blocked(), jobs: store.list().map(job => ({ id: job.task.id, seq: job.seq, status: job.task.status, uncertain: job.uncertain })) }, null, 2)}\n`);
    return;
  }
  if (command === "disconnect") {
    const unlock = store.lock("disconnect");
    try { store.forgetCredentials(); process.stdout.write("Local connection forgotten. Revoke the machine in AgEnD Settings to invalidate its credential centrally.\n"); }
    finally { unlock(); }
    return;
  }
  if (process.platform !== "win32") throw new Error("This runtime preview must run with native Windows Node, under the Windows user whose CLIs it uses.");
  if (command === "connect") {
    if (!flags["--server"]) throw new Error("connect requires --server with the AgEnD HTTPS origin");
    const server = validateRuntimeServer(flags["--server"]);
    const current = store.credentials();
    if (current && current.server !== server.origin) throw new Error("This profile is paired with another server. Stop and disconnect it, or choose another --profile.");
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
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runtimeMain().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Runtime failed"}\n`); process.exitCode = 1; });
}
