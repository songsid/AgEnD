/**
 * the commands and flows that keep the Windows Runtime in the background: `connect` and `start` launch it detached, `status`, `stop`, `restart`,
 * `logs` and `autostart` manage it, and `runBackgroundInstance` is what the detached process itself runs. Split from runtime-cli.ts so that file stays the
 * argument parser and the pairing flow.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RuntimeProfileInUseError, type RuntimeClientStore } from "./runtime-client-store.js";
import { RUNTIME_CONNECTED_REPORT } from "./runtime-client.js";
import { readPaneSystemBootId, reusedRuntimeLockPid } from "./runtime-pane-boot.js";
import { createAutostartService, autostartTaskName, type AutostartService } from "./runtime-autostart.js";
import { RUNTIME_BACKGROUND_ENV, RotatingLog, captureProcessOutput, clearInstanceMarker, clearStopRequest, discoverRuntimeProfiles, forgetRuntimeProfileNote, launchBackgroundRuntime,
  noteRuntimeProfile, readAutostartPreference, readRuntimeInstance, reportBackgroundState, runtimeLogDirectory, runtimeProfileLabel, stopRuntimeInstance, watchStopRequest, writeAutostartPreference,
  writeInstanceMarker, type BackgroundLaunchOptions, type BackgroundLaunchResult, type InstanceDeps, type KnownProfile, type RuntimeInstance } from "./runtime-background.js";

export interface BackgroundSeams {
  /** The `runtime-cli.js` that is running; the launcher starts this file. */
  cliPath?: string;
  launch?: (options: BackgroundLaunchOptions) => Promise<BackgroundLaunchResult>;
  autostart?: AutostartService;
  instance?: InstanceDeps;
  /** How long `stop` and `restart` wait for the Runtime to end, and how long a launch waits for "connected". */
  stopTimeoutMs?: number;
  waitMs?: number;
  /** How often the background Runtime looks for a stop request. */
  watchMs?: number;
}
export interface BackgroundContext { env: NodeJS.ProcessEnv; home: string; cliPath: string; execPath: string; seams: BackgroundSeams; write: (text: string) => void }
const out = (context: BackgroundContext, text: string): void => context.write(`${text}\n`);
function instanceDeps(context: BackgroundContext): InstanceDeps {
  // One read of the Windows boot identity for every profile a command looks at (it starts PowerShell).
  let boot: Promise<string | undefined> | undefined;
  return { systemBootId: () => boot ??= readPaneSystemBootId(), reusedPid: holder => reusedRuntimeLockPid(holder), ...(context.seams.instance ?? {}) };
}
const autostartService = (context: BackgroundContext): AutostartService => context.seams.autostart ?? createAutostartService();
const logFor = (context: BackgroundContext, store: RuntimeClientStore): RotatingLog => new RotatingLog(runtimeLogDirectory(context.env, context.home, store.directory));

/** How to type this Runtime's command on this computer: `agend-runtime` when the installer's bin folder is on PATH, else the file that starts it. */
export function runtimeCommandName(cliPath: string, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string {
  const versionFolder = dirname(dirname(cliPath));
  const shims = [join(dirname(versionFolder), "bin", "agend-runtime.cmd"), join(versionFolder, "agend-runtime.cmd")];
  const shim = shims.find(path => exists(path));
  if (!shim) return `node.exe "${cliPath}"`;
  const folder = dirname(shim).replace(/[\\/]+$/, "").toLowerCase();
  const onPath = String(env.Path ?? env.PATH ?? "").split(";").some(entry => entry.trim().replace(/[\\/]+$/, "").toLowerCase() === folder);
  return onPath ? "agend-runtime" : `"${shim}"`;
}
function manageLines(context: BackgroundContext, store: RuntimeClientStore): string[] {
  const name = runtimeCommandName(context.cliPath, context.env);
  return [`  Check it:      ${name} status`, `  Stop it:       ${name} stop`, `  Read its log:  ${name} logs   (${runtimeLogDirectory(context.env, context.home, store.directory)})`];
}

/* ------------------------------------------------------------------ launching */

export interface LaunchInput { store: RuntimeClientStore; /** Turn the sign-in task on when this profile never chose (connect and start-after-pairing do; the task's own `start` does not). */ enableAutostartByDefault: boolean }
/**
 * Starts the profile's Runtime in the background unless one already runs for it. Exit status for the caller: 0 when a Runtime is running afterwards
 * (started, still connecting, or already there), and a thrown error when it could not be started or stopped before it connected.
 */
export async function launchInBackground(context: BackgroundContext, input: LaunchInput): Promise<void> {
  const { store } = input, label = runtimeProfileLabel(store.directory, context.home), log = logFor(context, store);
  const existing = await readRuntimeInstance(store, instanceDeps(context));
  let pid: number | undefined = existing.pid;
  if (existing.state === "running") {
    log.write(`start: a Runtime already runs for this profile (process ${existing.pid}); nothing started.`);
    out(context, `AgEnD Runtime is already running for this profile (${label}, process ${existing.pid}${existing.mode === "foreground" ? ", in a window" : ", in the background"}). Nothing was started.`);
  } else {
    noteRuntimeProfile(context.env, context.home, store.directory);
    const launch = context.seams.launch ?? launchBackgroundRuntime;
    const result = await launch({ store, cliPath: context.cliPath, execPath: context.execPath, env: context.env, log, ...(context.seams.waitMs !== undefined ? { waitMs: context.seams.waitMs } : {}) });
    if (result.kind === "failed") throw new Error(result.message);
    if (result.kind === "already-running") out(context, `AgEnD Runtime is already running for this profile (${label}${result.pid ? `, process ${result.pid}` : ""}). Nothing was started.`);
    else {
      pid = result.pid;
      out(context, result.connected
        ? `AgEnD Runtime is connected and running in the background (${label}, process ${result.pid}). Closing this window does not disconnect it.`
        : `AgEnD Runtime was started in the background (${label}, process ${result.pid}) but has not connected yet. It keeps trying by itself, and closing this window does not stop it. If it stays offline, run ${runtimeCommandName(context.cliPath, context.env)} logs to see why.`);
    }
  }
  if (input.enableAutostartByDefault && readAutostartPreference(store.directory) === undefined) {
    try { await enableAutostart(context, store); }
    catch (error) { out(context, `Autostart could not be turned on: ${error instanceof Error ? error.message : "unknown error"}`); }
  }
  if (pid) for (const line of manageLines(context, store)) out(context, line);
  const preference = readAutostartPreference(store.directory);
  if (preference === true) out(context, `  It starts again by itself when you sign in to Windows (turn that off: ${runtimeCommandName(context.cliPath, context.env)} autostart disable).`);
}

/* ------------------------------------------------------------------ autostart */

export async function enableAutostart(context: BackgroundContext, store: RuntimeClientStore): Promise<void> {
  const label = runtimeProfileLabel(store.directory, context.home);
  await autostartService(context).enable({ label, profile: store.directory, cliPath: context.cliPath, execPath: context.execPath, workFolder: runtimeLogDirectory(context.env, context.home, store.directory) });
  writeAutostartPreference(store.directory, true);
  noteRuntimeProfile(context.env, context.home, store.directory);
}
export async function disableAutostart(context: BackgroundContext, store: RuntimeClientStore): Promise<boolean> {
  const removed = await autostartService(context).disable(runtimeProfileLabel(store.directory, context.home));
  writeAutostartPreference(store.directory, false);
  return removed;
}

/* ------------------------------------------------------------------ choosing profiles */

export interface Selection { explicit?: string; connectionProfile?: string }
/**
 * The profiles a management command acts on. A name given with --profile (or AGEND_RUNTIME_HOME) is a profile label shown by `status` or a folder; with
 * --connection-dir it is the profile that folder's address picks. With none of them, every profile this computer knows.
 */
function targets(context: BackgroundContext, selection: Selection): { profiles: KnownProfile[]; chosen: boolean } {
  const known = discoverRuntimeProfiles(context.env, context.home);
  if (selection.explicit) {
    const byLabel = !/[\\/:]/.test(selection.explicit) ? known.find(profile => profile.label === selection.explicit) : undefined;
    const directory = byLabel?.directory ?? resolve(selection.explicit);
    // A name or folder that is not a Runtime profile is an error, not a new empty profile (opening a profile creates its folder).
    if (!existsSync(directory)) throw new Error(`There is no Runtime profile ${byLabel ? "named" : "folder"} "${selection.explicit}" on this computer. ${known.length ? `Known profiles: ${describeChoice(known)}.` : "agend-runtime status lists them once one is connected."}`);
    return { profiles: [{ label: runtimeProfileLabel(directory, context.home), directory }], chosen: true };
  }
  if (selection.connectionProfile) return { profiles: [{ label: runtimeProfileLabel(selection.connectionProfile, context.home), directory: resolve(selection.connectionProfile) }], chosen: true };
  return { profiles: known, chosen: false };
}

/* ------------------------------------------------------------------ status, stop, restart, logs, autostart */

export interface ProfileStatus { label: string; profile: string; instance: RuntimeInstance; autostart: { enabled: boolean | undefined; task: boolean | undefined; taskName: string }; logs: string }
/** `describe` adds the profile's own details (pairing, jobs, credential profiles); this adds what belongs to running in the background. */
export async function profileStatus(context: BackgroundContext, store: RuntimeClientStore, deps: InstanceDeps): Promise<ProfileStatus> {
  const label = runtimeProfileLabel(store.directory, context.home);
  let task: boolean | undefined;
  if (process.platform === "win32" || context.seams.autostart) { try { task = await autostartService(context).exists(label); } catch { task = undefined; } }
  return { label, profile: store.directory, instance: await readRuntimeInstance(store, deps), autostart: { enabled: readAutostartPreference(store.directory), task, taskName: autostartTaskName(label) },
    logs: runtimeLogDirectory(context.env, context.home, store.directory) };
}
function sinceText(at: number | undefined): string { return at ? `, since ${new Date(at).toLocaleString()}` : ""; }
export function formatProfileStatus(status: ProfileStatus, details: { server?: string; name?: string; paired: boolean; blocked: boolean }): string {
  const state = status.instance.state === "running"
    ? `running ${status.instance.mode === "background" ? "in the background" : "in a window"} (process ${status.instance.pid}${sinceText(status.instance.startedAt)})`
    : "not running";
  const autostart = status.autostart.enabled === false ? "off"
    : status.autostart.task === true ? `on (scheduled task "${status.autostart.taskName}")`
    : status.autostart.enabled === true ? (status.autostart.task === false ? "on, but the scheduled task is missing: run autostart enable again" : "on")
    : "not set up yet";
  return [`${status.label}`, `  state:      ${state}`,
    `  server:     ${details.paired ? details.server ?? "?" : "not paired yet"}${details.paired && details.name ? ` (this computer: ${details.name})` : ""}`,
    `  autostart:  ${autostart}`, ...(details.blocked ? ["  jobs:       an unfinished job is recorded in this profile; see status --json"] : []),
    `  profile:    ${status.profile}`, `  logs:       ${status.logs}`].join("\n");
}
function describeChoice(profiles: KnownProfile[]): string { return profiles.map(profile => `${profile.label} (${profile.directory})`).join(", "); }
function unknownProfile(): Error { return new Error("No AgEnD Runtime profile was found on this computer. Connect one first (connect-agend.bat or the install command from AgEnD Settings -> Runtime), or name a folder with --profile."); }

export interface ManageInput { command: "status" | "stop" | "restart" | "logs" | "autostart"; selection: Selection; all: boolean; tail?: number; action?: string;
  openStore: (directory: string) => RuntimeClientStore;
  /** status: the profile's own details as the `status --json` entry; the background part is added here. */
  describe: (store: RuntimeClientStore) => Record<string, unknown> & { paired: boolean; blocked: boolean; server?: string; name?: string };
  json: boolean; runtimeInfo: unknown }
export async function manageBackground(context: BackgroundContext, input: ManageInput): Promise<void> {
  const deps = instanceDeps(context), { profiles, chosen } = targets(context, input.selection);
  if (input.command === "status") {
    if (!profiles.length) { if (input.json) out(context, JSON.stringify({ runtimeInfo: input.runtimeInfo, profiles: [] }, null, 2)); else out(context, "No AgEnD Runtime profile was found on this computer. Connect one with connect-agend.bat or the install command from AgEnD Settings -> Runtime."); return; }
    const entries: { status: ProfileStatus; details: ReturnType<ManageInput["describe"]> }[] = [];
    for (const profile of profiles) { const store = input.openStore(profile.directory); entries.push({ status: await profileStatus(context, store, deps), details: input.describe(store) }); }
    if (input.json) { out(context, JSON.stringify({ runtimeInfo: input.runtimeInfo, profiles: entries.map(({ status, details }) => ({ ...details, label: status.label, background: { state: status.instance.state, ...(status.instance.pid ? { pid: status.instance.pid } : {}), ...(status.instance.mode ? { mode: status.instance.mode } : {}), ...(status.instance.startedAt ? { startedAt: status.instance.startedAt } : {}) },
      autostart: status.autostart, logs: status.logs })) }, null, 2)); return; }
    out(context, entries.map(({ status, details }) => formatProfileStatus(status, details)).join("\n\n"));
    return;
  }
  if (!profiles.length) throw unknownProfile();
  if (input.command === "logs") {
    if (profiles.length > 1) throw new Error(`Several profiles have a log. Choose one with --profile: ${describeChoice(profiles)}.`);
    const store = input.openStore(profiles[0].directory), log = logFor(context, store), lines = log.tail(input.tail ?? 50);
    if (!lines.length) { out(context, `No log yet for ${profiles[0].label} (${log.directory}). A Runtime that runs in the background writes it.`); return; }
    out(context, lines.join("\n"));
    return;
  }
  if (input.command === "autostart") {
    if (profiles.length > 1) throw new Error(`Several profiles exist. Choose one with --profile: ${describeChoice(profiles)}.`);
    const store = input.openStore(profiles[0].directory), label = profiles[0].label, name = runtimeCommandName(context.cliPath, context.env);
    if (input.action === "enable") {
      if (process.platform !== "win32" && !context.seams.autostart) throw new Error("Autostart uses the Windows Task Scheduler and needs native Windows.");
      if (!store.credentials()) throw new Error("This profile is not paired yet, so there is nothing to start at sign-in. Connect it first.");
      await enableAutostart(context, store);
      out(context, `Autostart is on for ${label}: the Runtime starts by itself when you sign in to Windows (scheduled task "${autostartTaskName(label)}", your own account, no administrator rights). Turn it off: ${name} autostart disable`);
    } else if (input.action === "disable") {
      const removed = await disableAutostart(context, store);
      out(context, `Autostart is off for ${label}${removed ? ": the scheduled task was removed" : " (there was no scheduled task)"}. The Runtime keeps running if it is running; it will not start again by itself after you sign out. Turn it on: ${name} autostart enable`);
    } else {
      const status = await profileStatus(context, store, deps);
      out(context, `Autostart for ${label}: ${status.autostart.enabled === false ? "off" : status.autostart.enabled === true ? (status.autostart.task === false ? "on, but the scheduled task is missing (run autostart enable again)" : "on") : "not set up yet (it turns on the first time connect succeeds in the background)"}.`);
    }
    return;
  }
  // stop and restart act on Runtimes that run, and never on more than one by surprise.
  const running: { profile: KnownProfile; instance: RuntimeInstance }[] = [];
  for (const profile of profiles) { const instance = await readRuntimeInstance(input.openStore(profile.directory), deps); if (instance.state === "running") running.push({ profile, instance }); }
  const verb = input.command === "stop" ? "stop" : "restart";
  if (!running.length) { out(context, `No Runtime is running${chosen ? " for that profile" : ""}, so there is nothing to ${verb}.${input.command === "restart" ? ` Start one with ${runtimeCommandName(context.cliPath, context.env)} start.` : ""}`); return; }
  if (running.length > 1 && !input.all) throw new Error(`Several Runtimes are running: ${describeChoice(running.map(row => row.profile))}. Name one with --profile, or use --all to ${verb} every one.`);
  let failure: Error | undefined;
  for (const { profile, instance } of running) {
    const store = input.openStore(profile.directory);
    try {
      if (instance.mode === "foreground") throw new Error(`${profile.label}: the Runtime (process ${instance.pid}) runs in a window, not in the background. Press Ctrl+C in that window.`);
      const outcome = await stopRuntimeInstance(store, { deps, ...(context.seams.stopTimeoutMs !== undefined ? { timeoutMs: context.seams.stopTimeoutMs } : {}) });
      if (outcome === "timeout") throw new Error(`${profile.label}: the Runtime (process ${instance.pid}) did not stop within ${Math.round((context.seams.stopTimeoutMs ?? 30_000) / 1000)} seconds. It may be finishing work; run ${runtimeCommandName(context.cliPath, context.env)} stop again, or end that process in Task Manager.`);
      if (input.command === "stop") {
        out(context, `${profile.label}: stopped.`);
        if (readAutostartPreference(store.directory) === true) out(context, `  It starts again when you sign in to Windows. To keep it off: ${runtimeCommandName(context.cliPath, context.env)} autostart disable`);
      } else {
        out(context, `${profile.label}: stopped; starting it again with the installed version.`);
        await launchInBackground(context, { store, enableAutostartByDefault: false });
      }
    } catch (error) { failure ??= error instanceof Error ? error : new Error("The Runtime could not be stopped"); out(context, error instanceof Error ? error.message : "The Runtime could not be stopped"); }
  }
  if (failure) throw new Error(`Not every Runtime was ${input.command === "stop" ? "stopped" : "restarted"}.`);
}

/** What `disconnect` does beyond forgetting the pairing: ends the background Runtime first (there is no window to close), then removes the sign-in task. */
export async function stopForDisconnect(context: BackgroundContext, store: RuntimeClientStore): Promise<void> {
  const deps = instanceDeps(context), instance = await readRuntimeInstance(store, deps);
  if (instance.state !== "running" || instance.mode !== "background") return;
  out(context, `Stopping the Runtime that runs in the background (process ${instance.pid}) first…`);
  const outcome = await stopRuntimeInstance(store, { deps, ...(context.seams.stopTimeoutMs !== undefined ? { timeoutMs: context.seams.stopTimeoutMs } : {}) });
  if (outcome === "timeout") throw new Error(`The background Runtime (process ${instance.pid}) did not stop in time, so nothing was disconnected. Run ${runtimeCommandName(context.cliPath, context.env)} stop, then disconnect again.`);
}
export async function removeAutostartForDisconnect(context: BackgroundContext, store: RuntimeClientStore): Promise<void> {
  const label = runtimeProfileLabel(store.directory, context.home);
  try {
    if (process.platform === "win32" || context.seams.autostart) { if (await autostartService(context).disable(label)) out(context, "The sign-in task that started this Runtime was removed."); }
  } catch (error) { out(context, `The sign-in task could not be removed: ${error instanceof Error ? error.message : "unknown error"}`); }
  // A person who turned the sign-in task off keeps it off: only a preference that was never chosen (or was "on") goes back to "never chosen", so a later connect starts afresh.
  if (readAutostartPreference(store.directory) !== false) writeAutostartPreference(store.directory, undefined);
  clearInstanceMarker(store.directory); forgetRuntimeProfileNote(context.env, context.home, store.directory);
}

/* ------------------------------------------------------------------ the background Runtime itself */

export interface BackgroundRun { run: (report: (text: string) => void) => Promise<void> }
/**
 * What the detached `run` process does around the normal Runtime: its output goes to the log, a stop request ends it the way Ctrl+C would, the launcher is told
 * when AgEnD welcomed it (or that it failed, or that another Runtime already holds the profile) through the state file, and the marker `status` reads is kept while it runs.
 */
export async function runBackgroundInstance(context: BackgroundContext, store: RuntimeClientStore, body: BackgroundRun, runtimeVersion?: string): Promise<void> {
  const log = logFor(context, store), restore = captureProcessOutput(log);
  // A crash prints its stack to a stderr nobody reads here; the log is where someone will look. The monitor only observes: Node still ends the process as it would.
  const crashed = (error: Error): void => log.write(`The Runtime crashed: ${error.stack ?? error.message}`, "error");
  process.on("uncaughtExceptionMonitor", crashed);
  let unwatch = (): void => {}, markerTimer: ReturnType<typeof setInterval> | undefined, told = false;
  const tell = (message: Parameters<typeof reportBackgroundState>[2]): void => { if (!told) { told = true; reportBackgroundState(store.directory, context.env, message); } };
  try {
    const existing = await readRuntimeInstance(store, instanceDeps(context));
    if (existing.state === "running" && existing.pid !== process.pid) {
      process.stdout.write(`A Runtime already runs for this profile (process ${existing.pid}); this one did not start.\n`);
      tell({ status: "already-running", ...(existing.pid ? { pid: existing.pid } : {}) });
      return;
    }
    clearStopRequest(store.directory);
    process.stdout.write(`AgEnD Runtime starting in the background (process ${process.pid}).\n`);
    const finished = body.run(text => { process.stdout.write(`${text}\n`); if (text === RUNTIME_CONNECTED_REPORT) tell({ status: "ready", pid: process.pid }); });
    // Listeners for SIGINT/SIGTERM are in place once `run` has been called, so a stop request can end the Runtime the same way Ctrl+C does.
    unwatch = watchStopRequest(store.directory, () => { process.stdout.write("Stop requested (agend-runtime stop); stopping.\n"); process.emit("SIGTERM", "SIGTERM"); }, context.seams.watchMs ?? 1000);
    // The marker says "this PID is a background Runtime"; it is written only once this process holds the profile lock, so a second start that loses the race never claims it.
    markerTimer = setInterval(() => { if (store.lockInfo()?.pid === process.pid) { writeInstanceMarker(store.directory, process.pid, Date.now(), runtimeVersion); if (markerTimer) clearInterval(markerTimer); markerTimer = undefined; } }, 200);
    markerTimer.unref();
    await finished;
    process.stdout.write("This AgEnD Runtime process ended (it was stopped, or handed over to an updated version).\n");
  } catch (error) {
    if (error instanceof RuntimeProfileInUseError) {
      process.stdout.write(`A Runtime already runs for this profile (process ${error.pid}); this one did not start.\n`);
      tell({ status: "already-running", pid: error.pid });
    } else {
      const message = error instanceof Error ? error.message : "The Runtime failed";
      process.stderr.write(`${message}\n`); process.exitCode = 1;
      tell({ status: "failed", message });
    }
  } finally {
    unwatch(); if (markerTimer) clearInterval(markerTimer); process.off("uncaughtExceptionMonitor", crashed);
    clearInstanceMarker(store.directory, process.pid); restore();
  }
}
export { RUNTIME_BACKGROUND_ENV };
