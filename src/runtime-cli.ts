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
import { assertCredentialProfileCli, assertCredentialProfileName, credentialLoginRequired, credentialProfilesRoot, credentialProfileReport, listCredentialProfileNames,
  rememberCredentialStatus, requireCredentialProfile, withCredentialProfile, type CredentialProfileCli } from "./runtime-credential-profiles.js";
import { findCli, nativeCliEnvironment, probeCredentialProfileStatus, type CredentialProfileAnswer, type NativeCliExecutable } from "./windows-cli-worker.js";
import type { AccountIdentity } from "./claude-auth-status.js";
import { spawn } from "./child-process.js";
import { createRuntimeProfile, listRemovalLeftovers } from "./runtime-profile-ownership.js";
import { appendAudit, describeRemoteSwitches, type AuditEntry, type RemoteSwitchState, isRemoteSwitchName, parseSwitchDuration, readRemoteSwitches, setRemoteSwitch } from "./runtime-remote-setup.js";

const HELP = `AgEnD native Windows runtime

  agend-runtime --version
  agend-runtime connect --server https://agend.example.com [--name NAME] [--profile DIRECTORY] [--credential-profile NAME]
  agend-runtime run [--profile DIRECTORY]
  agend-runtime status [--profile DIRECTORY]
  agend-runtime rotate [--profile DIRECTORY]
  agend-runtime disconnect [--profile DIRECTORY]
  agend-runtime login claude-code NAME [--profile DIRECTORY]
  agend-runtime profile list [--profile DIRECTORY]
  agend-runtime profile default (NAME | --clear) [--profile DIRECTORY]
  agend-runtime remote-setup status [--profile DIRECTORY]
  agend-runtime remote-setup (accounts | install) (on | off) [--for 2h] [--profile DIRECTORY]

connect asks for a one-time pairing code, waits for approval in AgEnD, then runs in the foreground.
Connection-ready downloads include the server address; double-click connect-agend.bat to connect or reconnect.
run reconnects an existing profile. Press Ctrl+C to stop. disconnect forgets a stopped local profile;
revoke the machine in AgEnD Settings to invalidate its credential centrally.
rotate replaces a stopped profile's machine credential without pairing again. Stop run/connect first.
HTTP is accepted only for loopback, for example an SSH-forwarded localhost endpoint.
CLI login, workspaces and devices stay on this computer. No CLI login data is uploaded.

Several Claude accounts on one computer: login creates a named sign-in under <profile>\\credential-profiles\\claude-code\\NAME and runs
"claude auth login" for it, here, in this terminal. AgEnD only ever sends a profile NAME, never a folder; a name that does not exist or is
not signed in is refused, never replaced by another account. connect --credential-profile NAME (or profile default NAME) makes NAME this
pairing's default for agents that do not choose one in AgEnD. Only names and "signed in or not" are reported to AgEnD.

Remote setup: two switches, both OFF, decide whether AgEnD's administrators may, from the dashboard, add and sign in Claude accounts here
("accounts": sign in, sign out and remove profiles that this Runtime created) or install a CLI here ("install"). They are set only on this
computer; AgEnD cannot change them. --for 2h turns a switch off by itself after that time. Each such request is recorded in audit.jsonl in this
profile folder: who, when, which profile, the outcome, never a sign-in code, link, account address or output. Your own Claude sign-in
(~\\.claude) and any profile this Runtime did not create are never changed from AgEnD.
`;
/** Same lock proof as run: a Windows restart's boot id and a reused PID must not leave a stale lock that blocks disconnect or rotate. */
async function lockProfile(store: RuntimeClientStore, name: string): Promise<() => void> {
  if (process.platform !== "win32") return store.lock(name);
  const systemBootId = await readPaneSystemBootId();
  return store.lock(name, systemBootId, await reusedRuntimeLockPid(store.lockHolder()));
}
export interface RuntimeMainOptions {
  /** Folder holding agend-server.json; defaults to the extracted Runtime folder. */ programDirectory?: string; home?: string; env?: NodeJS.ProcessEnv;
  /** Test seams: whether a profile folder is signed in, and the interactive `claude auth login`. Production asks the Windows CLI itself. */
  probeLogin?: (cli: CredentialProfileCli, directory: string) => Promise<boolean | null>;
  /** Test seam for the same check with the account in it. Wins over `probeLogin`. */
  probeStatus?: (cli: CredentialProfileCli, directory: string) => Promise<CredentialProfileAnswer>;
  runLogin?: (executable: NativeCliExecutable, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
}
function interactiveLogin(executable: NativeCliExecutable, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(executable.command, [...executable.args, ...args], { env, shell: false, stdio: "inherit" });
    child.on("error", fail); child.on("close", code => done(code ?? 1));
  });
}
function signInLabel(loggedIn: boolean | null): string { return loggedIn === true ? "signed in" : loggedIn === false ? "not signed in" : "not checked"; }
/** `ab***@example.com · team`, or `API key`: the same masked identity AgEnD shows; never the full address. */
function identityLabel(identity: AccountIdentity | undefined): string { return !identity ? "" : identity.apiKey ? "API key" : [identity.maskedEmail, identity.plan].filter(Boolean).join(" · "); }
export async function runtimeMain(argv = process.argv.slice(2), options: RuntimeMainOptions = {}): Promise<void> {
  const env = options.env ?? process.env, home = options.home ?? homedir();
  if (argv.length === 1 && argv[0] === "--version") { process.stdout.write(`${JSON.stringify(readRuntimeInfo(), null, 2)}\n`); return; }
  if (!argv.length || argv.includes("--help") || argv[0] === "help") { process.stdout.write(HELP); return; }
  const [command, ...args] = argv;
  if (!["connect", "run", "status", "disconnect", "rotate", "profile", "login", "remote-setup"].includes(command)) throw new Error("Unknown runtime command. Use agend-runtime --help.");
  const flags: Record<string, string> = {}, positional: string[] = [], takesNames = command === "profile" || command === "login" || command === "remote-setup";
  for (let index = 0; index < args.length;) {
    const key = args[index];
    if (takesNames && key === "--clear" && flags[key] === undefined) { flags[key] = "true"; index++; continue; }
    if (takesNames && !key.startsWith("--") && positional.length < (command === "remote-setup" ? 2 : 2)) { positional.push(key); index++; continue; }
    const value = args[index + 1];
    if (!["--server", "--name", "--profile", "--credential-profile", ...(command === "remote-setup" ? ["--for"] : [])].includes(key) || !value || value.startsWith("--") || flags[key] !== undefined) throw new Error("Invalid runtime arguments. Pairing codes must be entered interactively, never in command arguments.");
    flags[key] = value; index += 2;
  }
  if (command !== "connect" && (flags["--server"] || flags["--name"])) throw new Error("--server and --name are used only by connect");
  if (command !== "connect" && flags["--credential-profile"]) throw new Error("--credential-profile is used only by connect; use profile default NAME to change it later");
  const explicitProfile = flags["--profile"] || env.AGEND_RUNTIME_HOME;
  const defaultProfile = resolve(join(home, ".agend-runtime"));
  let bundledServer: string | undefined;
  // Only connect needs a valid bundled address; run/status/rotate/disconnect just use it to find the same profile.
  if (!flags["--server"]) { try { bundledServer = readBundledRuntimeServer(options.programDirectory); } catch (error) { if (command === "connect") throw error; } }
  // Without an explicit profile, a bundled server that differs from the default profile's pairing gets its own profile under it.
  const choice = explicitProfile ? undefined : chooseRuntimeProfile(defaultProfile, bundledServer, command === "connect");
  const store = new RuntimeClientStore(resolve(explicitProfile || choice!.directory));
  // A pairing's profiles live in that pairing's own folder: approving a pairing lets that fleet use the profiles signed in here, and no other fleet.
  const credentialRoot = credentialProfilesRoot(store.directory);
  const probeStatus = (cli: CredentialProfileCli, directory: string): Promise<CredentialProfileAnswer> => options.probeStatus ? options.probeStatus(cli, directory)
    : options.probeLogin ? options.probeLogin(cli, directory).then(loggedIn => ({ loggedIn })) : probeCredentialProfileStatus(cli, directory);
  /**
   * Makes a profile this pairing's default, safely against a removal that AgEnD may be carrying out in the Runtime at the same moment (another process,
   * so there is no lock to take). The folder is looked at again immediately before the write, and once more after it: a profile that was taken away in
   * between (a removal renames the folder first) puts the default back as it was and says so. The Runtime's removal looks at the default again after its
   * own rename, so one of the two always notices the other.
   */
  const setDefaultChecked = (name: string, before: string | undefined): void => {
    assertCredentialProfileName(name);
    requireCredentialProfile(credentialRoot, "claude-code", name);
    store.setCredentialDefault(name);
    try { requireCredentialProfile(credentialRoot, "claude-code", name); }
    catch { try { store.setCredentialDefault(before); } catch { /* the error below is what matters */ } throw new Error(`Credential profile "${name}" is being removed or is gone, so it was not made the default. Check agend-runtime profile list.`); }
  };
  if (command === "remote-setup") {
    const [what, state] = positional, usage = "Usage: agend-runtime remote-setup status | remote-setup (accounts | install) (on | off) [--for 2h] [--profile DIRECTORY]";
    if (Object.keys(flags).some(key => key !== "--profile" && key !== "--for")) throw new Error(usage);
    if (what === "status" && positional.length === 1 && flags["--for"] === undefined) { process.stdout.write(`${describeRemoteSwitches(readRemoteSwitches(store.directory))}\n`); return; }
    if (positional.length !== 2 || !isRemoteSwitchName(what) || (state !== "on" && state !== "off") || (flags["--for"] !== undefined && state !== "on")) throw new Error(usage);
    const forMs = flags["--for"] === undefined ? undefined : parseSwitchDuration(flags["--for"]);
    // What is recorded: which switch, on or off, and when a timed switch ends; first as an attempt, then as what really happened.
    // ON: the attempt is written first and must be written (no record, no change); the switch is set; then the result is written. If that last line
    // cannot be written the switch is put back off, so a switch is never left on without its record. A failed change is recorded as failed, never as ok.
    // OFF must always work (fail open): the switch is turned off first, and the record is best effort, with a note when it was not written.
    const now = Date.now(), until = forMs === undefined ? undefined : new Date(now + forMs).toISOString();
    const entry = (outcome: "started" | "ok" | "failed"): AuditEntry => ({ actor: "local", action: "switch", switch: what, outcome, detail: state, ...(until ? { until } : {}), ...(outcome === "failed" ? { reason: "failed" as const } : {}) });
    const notRecorded = "Note: the audit log (audit.jsonl in this profile folder) could not be written, so this change is not recorded there. The switch is being turned off anyway.\n";
    let result: RemoteSwitchState;
    if (state === "on") {
      try { appendAudit(store.directory, entry("started"), now); }
      catch { throw new Error("The audit log (audit.jsonl in this profile folder) cannot be written, so the switch was not turned on. Fix that file or folder and run this again."); }
      try { result = setRemoteSwitch(store.directory, what, true, forMs, now); }
      catch (error) { try { appendAudit(store.directory, entry("failed")); } catch { /* the failure itself is what is thrown */ } throw error; }
      try { appendAudit(store.directory, entry("ok")); }
      catch {
        // The switch was set but its record could not be completed: put it back off, and say "off" only if the saved switch is READ BACK as off. If that
        // cannot be shown (the write failed, or the file still says on) the outcome is unconfirmed and the person is told exactly that.
        let confirmedOff = false;
        try { setRemoteSwitch(store.directory, what, false, undefined, now); confirmedOff = !readRemoteSwitches(store.directory, now)[what].on; } catch { confirmedOff = false; }
        if (confirmedOff) {
          try { appendAudit(store.directory, entry("failed")); } catch { /* best effort */ }
          throw new Error("The audit log (audit.jsonl in this profile folder) could not be written after the switch was set, so the switch was turned off again. Fix that file or folder and run this again.");
        }
        try { appendAudit(store.directory, { ...entry("failed"), reason: "unconfirmed" }); } catch { /* best effort */ }
        throw new Error(`The audit log (audit.jsonl in this profile folder) could not be written after the "${what}" switch was turned on, and turning the switch back off could not be confirmed (unconfirmed: the switch may still be on). Run agend-runtime remote-setup ${what} off, and inspect remote-setup.json and audit.jsonl in this profile folder.`);
      }
    } else {
      try { result = setRemoteSwitch(store.directory, what, false, undefined, now); }
      catch (error) { try { appendAudit(store.directory, entry("failed")); } catch { /* best effort */ } throw error; }
      try { appendAudit(store.directory, entry("ok")); } catch { process.stderr.write(notRecorded); }
    }
    process.stdout.write(`${what}: ${result.on ? "on" : "off"}${result.until !== undefined ? `, turns off by itself at ${new Date(result.until).toLocaleString()}` : ""}\n`);
    if (result.on) process.stdout.write(what === "accounts"
      ? "AgEnD administrators can now add, sign in, sign out and remove Claude accounts that this Runtime creates on this computer. The sign-in stays on this computer, and anyone who can sign in to this Windows user can use it. Your own Claude sign-in is not touched.\n"
      : "AgEnD administrators can now install the Claude Code and Codex versions that this Runtime's own list pins, into this Runtime's folder only.\n");
    return;
  }
  if (command === "login") {
    if (process.platform !== "win32" && !options.runLogin) throw new Error("Signing in to a Claude account here needs native Windows Node, under the Windows user whose Claude Code this Runtime uses.");
    const [cli, name] = positional;
    if (positional.length !== 2 || Object.keys(flags).some(key => key !== "--profile")) throw new Error("Usage: agend-runtime login claude-code NAME [--profile DIRECTORY]");
    const kind = assertCredentialProfileCli(cli), { directory } = createRuntimeProfile(credentialRoot, kind, assertCredentialProfileName(name));
    const executable = options.runLogin ? { path: "claude", command: "claude", args: [] } : await findCli(kind);
    if (!executable) throw new Error("Claude Code is not installed on this Windows computer. Install it, then run this again.");
    process.stdout.write(`Signing in "${name}". Claude Code opens its own sign-in; the result is kept only in\n  ${directory}\nand is never uploaded to AgEnD.\n`);
    const code = await (options.runLogin ?? interactiveLogin)(executable, ["auth", "login"], withCredentialProfile(nativeCliEnvironment(env), kind, directory));
    const answer = await probeStatus(kind, directory);
    // Remembered (account included) so a running Runtime reports the new account to AgEnD by itself within seconds.
    rememberCredentialStatus(credentialRoot, kind, name, answer);
    if (code !== 0 || answer.loggedIn !== true) throw new Error(`Credential profile "${name}" is ${answer.loggedIn === false ? "not signed in" : "not confirmed as signed in"} yet (claude auth login exited with ${code}). Run the same login command again.`);
    process.stdout.write(`Credential profile "${name}" is signed in${answer.identity ? ` (${identityLabel(answer.identity)})` : ""}. Choose it for an agent in AgEnD Settings, or make it this pairing's default: agend-runtime profile default ${name}\n`);
    return;
  }
  if (command === "profile" && positional[0] === "list") {
    if (positional.length !== 1 || Object.keys(flags).some(key => key !== "--profile")) throw new Error("Usage: agend-runtime profile list [--profile DIRECTORY]");
    const names = listCredentialProfileNames(credentialRoot, "claude-code");
    // A removal that could neither finish nor be undone leaves its folder under a temporary name, with a sign-in possibly still in it. It is listed
    // here and nowhere else, and is never deleted or put back by the Runtime: that is for the person at this computer.
    const leftovers = listRemovalLeftovers(credentialRoot, "claude-code");
    for (const name of leftovers) process.stdout.write(`${name}\tLEFT OVER from a removal or sign-out that could not finish, in ${join(credentialRoot, "claude-code")}. It may still hold a sign-in. To finish removing it, delete that folder yourself; to keep it, rename it to its profile name. Nothing does either for you.\n`);
    if (!names.length) { if (!leftovers.length) process.stdout.write("No credential profiles yet. Create one: agend-runtime login claude-code NAME\n"); return; }
    for (const name of names) {
      let answer: CredentialProfileAnswer = { loggedIn: null };
      try { answer = await probeStatus("claude-code", requireCredentialProfile(credentialRoot, "claude-code", name)); } catch { /* shown as not checked */ }
      rememberCredentialStatus(credentialRoot, "claude-code", name, answer);
      process.stdout.write(`${name}\t${signInLabel(answer.loggedIn)}${answer.identity ? `\t${identityLabel(answer.identity)}` : ""}\n`);
    }
    return;
  }
  if (command === "profile") {
    // Only `default` is left here; `list` returned above. It changes which sign-in this pairing uses for agents that do not choose one.
    if (positional[0] !== "default" || positional.length > 2 || Object.keys(flags).some(key => key !== "--profile" && key !== "--clear") || (flags["--clear"] !== undefined) === (positional.length === 2)) throw new Error("Usage: agend-runtime profile list | profile default (NAME | --clear)");
    // No profile lock: the default is one atomic file, the Runtime reads it fresh for every run and terminal (and watches it), so this works while
    // the Runtime is running and takes effect there at once. A terminal that is already open keeps the profile it started with.
    if (flags["--clear"]) { store.setCredentialDefault(undefined); process.stdout.write("This pairing no longer has a default credential profile. Agents that choose none use this Runtime's own Claude sign-in again.\n"); return; }
    const name = assertCredentialProfileName(positional[1]), directory = requireCredentialProfile(credentialRoot, "claude-code", name);
    const answer = await probeStatus("claude-code", directory);
    rememberCredentialStatus(credentialRoot, "claude-code", name, answer);
    if (answer.loggedIn !== true) throw credentialLoginRequired("claude-code", name, answer.loggedIn);
    const before = store.credentialDefault(); setDefaultChecked(name, before);
    process.stdout.write(`Default credential profile for this pairing: ${name}.${before && before !== name ? ` (was ${before}; a conversation started under another account cannot be resumed under this one.)` : ""}\nA running Runtime uses it from the next run or new terminal; a terminal that is already open keeps the profile it started with.\n`);
    return;
  }
  if (command === "status") {
    const credentials = store.credentials();
    let credentialProfile: string | undefined; try { credentialProfile = store.credentialDefault(); } catch { /* status must still report the rest */ }
    process.stdout.write(`${JSON.stringify({ runtimeInfo: readRuntimeInfo(), profile: store.directory, paired: !!credentials, ...(credentials ? { server: credentials.server, machineId: credentials.machineId, name: credentials.name } : {}),
      credentialProfiles: credentialProfileReport(credentialRoot, credentialProfile),
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
    // Before a one-time pairing code is asked for or spent: a profile that does not exist or is not signed in stops here.
    const wantedProfile = flags["--credential-profile"];
    if (wantedProfile !== undefined) {
      const directory = requireCredentialProfile(credentialRoot, "claude-code", assertCredentialProfileName(wantedProfile));
      const answer = await probeStatus("claude-code", directory);
      rememberCredentialStatus(credentialRoot, "claude-code", wantedProfile, answer);
      if (answer.loggedIn !== true) throw credentialLoginRequired("claude-code", wantedProfile, answer.loggedIn);
    }
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
  if (command === "connect" && flags["--credential-profile"] !== undefined) {
    const before = store.credentialDefault(); setDefaultChecked(flags["--credential-profile"], before);
    process.stdout.write(`Credential profile for agents that do not choose one: ${flags["--credential-profile"]}${before && before !== flags["--credential-profile"] ? ` (was ${before})` : ""}\n`);
  }
  const client = new RuntimeClient({ store, credentialProfilesRoot: credentialRoot, report: text => process.stdout.write(`${text}\n`) });
  const stop = (): void => {
    void client.stop().catch(error => {
      // An account process was not confirmed ended: the Runtime keeps its lock, so say so and let the next Ctrl+C try again.
      process.exitCode = 1; process.stderr.write(`${error instanceof Error ? error.message : "Runtime stop was not completed"}. Press Ctrl+C to try again.\n`);
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await client.start(); await client.waitUntilStopped(); }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  // AgEnD ended the connection and someone has to act: that is a failure (non-zero exit), never a silent normal exit.
  if (client.stopReason) throw new Error(describeRuntimeStop(client.stopReason));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runtimeMain().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Runtime failed"}\n`); process.exitCode = 1; });
}
