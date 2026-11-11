import * as fixturePrivacyFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeClientStore as Store } from "../src/runtime-client-store.js";
import type { BackgroundLaunchOptions, BackgroundLaunchResult } from "../src/runtime-background.js";

const world = vi.hoisted(() => ({ pair: vi.fn(), enroll: vi.fn(), started: vi.fn(), startError: undefined as unknown, stopReason: undefined as unknown, endAtOnce: false, stopFailures: 0, stopCalls: 0, clients: [] as { stop(): Promise<void> }[], boot: "b".repeat(64) }));
vi.mock("../src/runtime-pane-boot.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/runtime-pane-boot.js")>(), readPaneSystemBootId: async () => world.boot }));
vi.mock("../src/runtime-client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/runtime-client.js")>(),
  pairRuntime: world.pair, enrollRuntime: world.enroll, rotateRuntimeCredentials: vi.fn(),
  RuntimeClient: class {
    stopReason: unknown; private done: (() => void) | undefined;
    constructor(private readonly options: { store: Store; report?: (text: string) => void }) { world.clients.push(this); }
    async start() { world.started(this.options.store.directory); if (world.startError) throw world.startError; this.options.report?.("Connected to AgEnD."); this.stopReason = world.stopReason; }
    async stop() { world.stopCalls++; if (world.stopFailures > 0) { world.stopFailures--; throw new Error("An account process was not confirmed ended"); } this.done?.(); }
    waitUntilStopped() { return world.endAtOnce ? Promise.resolve() : new Promise<void>(resolve => { this.done = resolve; }); }
  },
}));
vi.mock("node:readline/promises", () => ({ createInterface: () => ({ question: async () => "ABCD-EFGH", close() {} }) }));

import { RuntimeClientStore, RuntimeProfileInUseError } from "../src/runtime-client-store.js";
import { runtimeMain } from "../src/runtime-cli.js";
import { RUNTIME_AUTOSTART_FILE, RUNTIME_BACKGROUND_ENV, RUNTIME_INSTANCE_FILE, RUNTIME_LAUNCH_ID_ENV, RUNTIME_STOP_REQUEST_FILE, RotatingLog, clearBackgroundState, readAutostartPreference, readBackgroundState, runtimeLogDirectory, runtimeProfileLabel, writeAutostartPreference, writeInstanceMarker } from "../src/runtime-background.js";
import { runtimeCommandName } from "../src/runtime-cli-background.js";
import { RUNTIME_SERVER_FILE } from "../src/runtime-connection.js";
import { autostartTaskName, type AutostartService } from "../src/runtime-autostart.js";
import { generateEnrollToken } from "../src/runtime-enrollment.js";

/**
 * `connect` and `start` move the Runtime to the background and end; `--foreground` and `run` keep it in the window; one Runtime runs per profile
 * (a second start says so and ends with exit status 0); `status`, `stop`, `restart`, `logs` and `autostart` manage it; and the detached process itself writes
 * its log, tells the launcher when AgEnD welcomed it and ends on a stop request.
 */
const A = "https://fleet.example.test:10443", FP = "ab".repeat(32);
const roots: string[] = [], platform = Object.getOwnPropertyDescriptor(process, "platform")!;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-runtime-cli-background-")); roots.push(root);
  const home = join(root, "home"), program = join(root, "zip"); mkdirSync(home); mkdirSync(program);
  // A managed install: <root>\bin\agend-runtime.cmd is the shim and its folder is on PATH, so the messages say plain `agend-runtime`.
  const install = join(root, "install"), cli = join(install, "1.0.0+abc", "dist", "runtime-cli.js"); mkdirSync(join(install, "bin"), { recursive: true }); writeFileSync(join(install, "bin", "agend-runtime.cmd"), "@echo off\r\n");
  const base = join(home, ".agend-runtime"), env = { LOCALAPPDATA: join(root, "local"), Path: join(install, "bin") };
  return { root, home, program, base, env, cli };
}
const pairTo = (directory: string, server = A, name = "Office PC"): Store => { const store = new RuntimeClientStore(directory); store.saveCredentials({ server, machineId: "11111111-2222-4333-8444-555555555555", credential: "a".repeat(64), name }); return store; };
const lockFile = (directory: string, pid: number): void => writeFileSync(join(directory, "runtime.lock"), JSON.stringify({ pid, bootId: "boot" }));
const pipe = (text: string): Readable & { isTTY?: boolean } => Readable.from([text]);
let output = "", launches: BackgroundLaunchOptions[] = [], launchResult: BackgroundLaunchResult, autostartCalls: string[] = [], autostartFails = false, taskExists = true;
const autostart: AutostartService = {
  async enable(input) { autostartCalls.push(`enable ${input.label} ${input.profile}`); if (autostartFails) throw new Error("Windows did not create the sign-in task"); },
  async disable(label) { autostartCalls.push(`disable ${label}`); return taskExists; },
  async exists() { return taskExists; },
};
const seams = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) => ({ cliPath: f.cli, autostart, launch: async (options: BackgroundLaunchOptions) => { launches.push(options); return launchResult; }, stopTimeoutMs: 400, watchMs: 20,
  instance: { alive: (pid: number) => pid === 4242 || pid === process.pid, reusedPid: async () => undefined, systemBootId: async () => undefined }, ...extra });
const call = (argv: string[], f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) => runtimeMain(argv, { home: f.home, programDirectory: f.program, env: f.env, background: seams(f), ...extra } as never);
function setTty(value: boolean): void { Object.defineProperty(process.stdin, "isTTY", { value, configurable: true }); Object.defineProperty(process.stdout, "isTTY", { value, configurable: true }); }
beforeEach(() => {
  world.pair.mockReset(); world.enroll.mockReset(); world.started.mockReset(); world.startError = undefined; world.stopReason = undefined; world.endAtOnce = true; world.clients.length = 0;
  output = ""; launches = []; autostartCalls = []; autostartFails = false; taskExists = true; launchResult = { kind: "started", pid: 777, connected: true };
  world.enroll.mockImplementation(async (options: { server: string; store: Store; name: string }) => { options.store.saveCredentials({ server: options.server, machineId: "99999999-2222-4333-8444-555555555555", credential: "b".repeat(64), name: options.name }); });
  world.pair.mockImplementation(async (options: { server: string; store: Store; name: string }) => { options.store.saveCredentials({ server: options.server, machineId: "88888888-2222-4333-8444-555555555555", credential: "c".repeat(64), name: options.name }); });
  Object.defineProperty(process, "platform", { value: "win32" }); setTty(false);
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(chunk => { output += String(chunk); return true; });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform); vi.restoreAllMocks();
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test path"); rmSync(root, { recursive: true, force: true }); }
});

describe("connect and start: background by default, in the window only on request", () => {
  it("connect launches the background Runtime for a paired profile and ends: no client runs in this process", async () => {
    const f = fixture(); pairTo(f.base);
    await call(["connect", "--server", A], f);
    expect(launches).toHaveLength(1); expect(launches[0].store.directory).toBe(f.base); expect(launches[0].cliPath).toBe(f.cli);
    expect(world.started).not.toHaveBeenCalled();
    expect(output).toMatch(/connected and running in the background \(default, process 777\)\. Closing this window does not disconnect it\./);
    expect(output).toMatch(/agend-runtime status/); expect(output).toMatch(/agend-runtime stop/); expect(output).toMatch(/agend-runtime logs/);
  });
  it("pairing code, fingerprint and approval happen in this window first; the Runtime only moves to the background afterwards", async () => {
    const f = fixture(), order: string[] = []; setTty(true);
    world.pair.mockImplementation(async (options: { server: string; store: Store; name: string; report?: (text: string) => void }) => { order.push("pair"); options.report?.("Pairing fingerprint: AAAA. Compare it…"); options.store.saveCredentials({ server: options.server, machineId: "88888888-2222-4333-8444-555555555555", credential: "c".repeat(64), name: options.name }); });
    await call(["connect", "--server", A], f, { background: seams(f, { launch: async (options: BackgroundLaunchOptions) => { order.push(`launch:${options.store.credentials()?.name ? "paired" : "unpaired"}`); return launchResult; } }) });
    expect(order).toEqual(["pair", "launch:paired"]); expect(output).toContain("Pairing fingerprint"); expect(world.started).not.toHaveBeenCalled();
  });
  it("the one-time token route joins in this process (token on stdin) and then moves to the background, with no console", async () => {
    const f = fixture(), token = generateEnrollToken();
    await call(["connect", "--server", A, "--enroll-stdin", "--server-fingerprint", FP], f, { stdin: pipe(token + "\r\n") });
    expect(world.enroll).toHaveBeenCalledTimes(1); expect(launches).toHaveLength(1); expect(world.started).not.toHaveBeenCalled();
    expect(JSON.stringify(launches.map(({ store, ...rest }) => rest))).not.toContain(token); expect(output).not.toContain(token);
  });
  it("--foreground keeps the Runtime in this window, never launches anything and never touches autostart; its end is reported", async () => {
    const f = fixture(); pairTo(f.base);
    await call(["connect", "--server", A, "--foreground"], f);
    expect(launches).toHaveLength(0); expect(world.started).toHaveBeenCalledWith(f.base); expect(autostartCalls).toEqual([]);
    expect(readAutostartPreference(f.base)).toBeUndefined(); expect(output).toMatch(/AgEnD Runtime stopped\./);
  });
  it("run stays in its window as before (and has no --foreground of its own)", async () => {
    const f = fixture(); pairTo(f.base);
    await call(["run"], f); expect(launches).toHaveLength(0); expect(world.started).toHaveBeenCalledWith(f.base);
    await expect(call(["run", "--foreground"], f)).rejects.toThrow(/Invalid runtime arguments/);
  });
  it("start launches an already paired profile without pairing, without asking for anything, and does not turn autostart on by itself", async () => {
    const f = fixture(); pairTo(f.base);
    await call(["start", "--profile", f.base], f);
    expect(launches).toHaveLength(1); expect(world.pair).not.toHaveBeenCalled(); expect(world.enroll).not.toHaveBeenCalled(); expect(autostartCalls).toEqual([]);
  });
  it("start on a profile that is not paired says what to do first and fails", async () => {
    const f = fixture();
    await expect(call(["start", "--profile", join(f.root, "none")], f)).rejects.toThrow(/not paired yet.*connect-agend\.bat/); expect(launches).toHaveLength(0);
  });
  it("says so when the Runtime started but has not connected yet, and when it could not start at all (exit status 1)", async () => {
    const f = fixture(); pairTo(f.base);
    launchResult = { kind: "started", pid: 9, connected: false }; await call(["connect", "--server", A], f);
    expect(output).toMatch(/started in the background \(default, process 9\) but has not connected yet.*keeps trying by itself.*agend-runtime logs/s);
    launchResult = { kind: "failed", message: "This computer was revoked in AgEnD Settings." };
    await expect(call(["connect", "--server", A], f)).rejects.toThrow("This computer was revoked in AgEnD Settings.");
  });
  it("a Runtime that is already there is reported as already running, with exit status 0, and nothing is launched", async () => {
    const f = fixture(), store = pairTo(f.base); lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242);
    for (const argv of [["connect", "--server", A], ["start", "--profile", f.base]]) { output = ""; await call(argv, f); expect(output, argv.join(" ")).toMatch(/already running for this profile \(default, process 4242, in the background\)\. Nothing was started\./); }
    expect(launches).toHaveLength(0);
    launchResult = { kind: "already-running", pid: 31 };       // the race: it appeared after the check
    rmSync(join(store.directory, "runtime.lock")); output = ""; await call(["start", "--profile", f.base], f);
    expect(output).toMatch(/already running for this profile \(default, process 31\)/);
  });
  it("a lock whose process is gone is no Runtime: the start goes ahead", async () => {
    const f = fixture(), store = pairTo(f.base); lockFile(store.directory, 5555); await call(["start", "--profile", f.base], f);
    expect(launches).toHaveLength(1);
  });
});

describe("one Runtime per profile, in a window too", () => {
  it("connect --foreground and run find the Runtime that is running and end with 'already running' instead of an error", async () => {
    const f = fixture(), store = pairTo(f.base); lockFile(store.directory, 4242);
    for (const argv of [["connect", "--server", A, "--foreground"], ["run"]]) { output = ""; await expect(call(argv, f), argv.join(" ")).resolves.toBeUndefined(); expect(output).toMatch(/already running for this profile \(process 4242\)\. Nothing was started\./); }
    expect(world.started).not.toHaveBeenCalled();
  });
  it("if the profile lock turns out to be held when the client starts (two starts raced), that is 'already running' as well; any other failure is still a failure", async () => {
    const f = fixture(); pairTo(f.base);
    world.startError = new RuntimeProfileInUseError(31337, f.base, false, join(f.base, "runtime.lock"));
    await expect(call(["run"], f)).resolves.toBeUndefined(); expect(output).toMatch(/already running for this profile \(process 31337\)/);
    world.startError = new Error("Invalid runtime lock; inspect it before restarting");
    await expect(call(["run"], f)).rejects.toThrow(/Invalid runtime lock/);
  });
});

describe("autostart: on by default after the first background connect, and the person's choice is kept", () => {
  it("turns the sign-in task on for this profile the first time connect succeeds, and says how to turn it off", async () => {
    const f = fixture(), store = pairTo(f.base);
    await call(["connect", "--server", A], f);
    expect(autostartCalls).toEqual([`enable default ${f.base}`]); expect(readAutostartPreference(store.directory)).toBe(true);
    expect(output).toMatch(/starts again by itself when you sign in to Windows \(turn that off: agend-runtime autostart disable\)/);
    await call(["connect", "--server", A], f); expect(autostartCalls).toHaveLength(1);                // once the choice exists, connect leaves it alone
  });
  it("is turned on only for a Runtime that is connected: not while the one just started is still connecting, not for a window's Runtime, not when another start won the race", async () => {
    const f = fixture(), store = pairTo(f.base);
    launchResult = { kind: "started", pid: 9, connected: false }; await call(["connect", "--server", A], f);
    expect(autostartCalls, "still connecting").toEqual([]); expect(readAutostartPreference(store.directory)).toBeUndefined(); expect(output).not.toMatch(/starts again by itself/);
    lockFile(store.directory, 4242);                                                                    // a Runtime in a window (no background marker)
    await call(["connect", "--server", A], f); expect(autostartCalls, "a window's Runtime").toEqual([]); expect(readAutostartPreference(store.directory)).toBeUndefined();
    rmSync(join(store.directory, "runtime.lock")); launchResult = { kind: "already-running", pid: 31 };
    await call(["connect", "--server", A], f); expect(autostartCalls, "the race").toEqual([]);
    lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242);                         // a background Runtime that is already up: connected
    await call(["connect", "--server", A], f); expect(autostartCalls).toEqual([`enable default ${f.base}`]); expect(readAutostartPreference(store.directory)).toBe(true);
  });
  it("never turns it back on after the person turned it off", async () => {
    const f = fixture(), store = pairTo(f.base); writeAutostartPreference(store.directory, false);
    await call(["connect", "--server", A], f); expect(autostartCalls).toEqual([]); expect(output).not.toMatch(/starts again by itself/);
  });
  it("a refusal from Windows is a warning, not a failed connect", async () => {
    const f = fixture(); pairTo(f.base); autostartFails = true;
    await expect(call(["connect", "--server", A], f)).resolves.toBeUndefined();
    expect(output).toMatch(/Autostart could not be turned on: Windows did not create the sign-in task/); expect(output).toMatch(/connected and running in the background/);
    expect(readAutostartPreference(f.base)).toBeUndefined();                                          // so the next connect tries again
  });
  it("is one task per profile: a per-server profile gets its own label", async () => {
    const f = fixture(); pairTo(f.base, "https://other.example.test:1"); setTty(true);
    writeFileSync(join(f.program, RUNTIME_SERVER_FILE), JSON.stringify({ server: A }));
    await call(["connect"], f);
    const label = runtimeProfileLabel(join(f.base, "profiles", "fleet.example.test-10443"), f.home);
    expect(autostartCalls).toEqual([`enable ${label} ${join(f.base, "profiles", "fleet.example.test-10443")}`]); expect(label).toBe("fleet.example.test-10443");
  });
  it("autostart enable | disable | status work on a named profile, and disable keeps it off", async () => {
    const f = fixture(), store = pairTo(f.base);
    await call(["autostart", "enable", "--profile", f.base], f); expect(readAutostartPreference(store.directory)).toBe(true); expect(output).toMatch(/Autostart is on for default.*no administrator rights/s);
    output = ""; await call(["autostart", "status", "--profile", f.base], f); expect(output).toMatch(/Autostart for default: on\./);
    output = ""; await call(["autostart", "disable", "--profile", f.base], f); expect(readAutostartPreference(store.directory)).toBe(false); expect(output).toMatch(/Autostart is off for default: the scheduled task was removed/);
    expect(autostartCalls).toEqual([`enable default ${f.base}`, "disable default"]);
    await expect(call(["autostart", "nonsense", "--profile", f.base], f)).rejects.toThrow(/Usage: agend-runtime autostart/);
    mkdirSync(join(f.root, "unpaired")); await expect(call(["autostart", "enable", "--profile", join(f.root, "unpaired")], f)).rejects.toThrow(/not paired yet/);
    await expect(call(["autostart", "enable", "--profile", join(f.root, "nowhere")], f)).rejects.toThrow(/no Runtime profile folder .*nowhere.*Known profiles: default/s); expect(existsSync(join(f.root, "nowhere"))).toBe(false);
    await expect(call(["stop", "--profile", "nope"], f)).rejects.toThrow(/no Runtime profile (named|folder) "nope"/); expect(existsSync(resolve("nope"))).toBe(false);
  });
});

describe("status, stop, restart and logs", () => {
  it("status lists every profile with its state, process, server and autostart, and --json says the same for a program", async () => {
    const f = fixture(), one = pairTo(f.base), two = pairTo(join(f.base, "profiles", "preview.example.test-8445"), "https://preview.example.test:8445", "Second PC");
    lockFile(one.directory, 4242); writeInstanceMarker(one.directory, 4242, Date.UTC(2026, 10, 8, 3, 0, 0)); writeAutostartPreference(one.directory, true);
    await call(["status"], f);
    expect(output).toMatch(/^default\n {2}state: {6}running in the background \(process 4242, since /m); expect(output).toMatch(/server: {5}https:\/\/fleet\.example\.test:10443 \(this computer: Office PC\)/);
    expect(output).toMatch(new RegExp(`autostart: {2}on \\(scheduled task "${autostartTaskName("default")}"\\)`)); expect(output).toMatch(/^preview\.example\.test-8445\n {2}state: {6}not running/m);
    expect(output).toContain(runtimeLogDirectory(f.env, f.home, one.directory));
    output = ""; await call(["status", "--json"], f);
    const json = JSON.parse(output) as { runtimeInfo: unknown; profiles: Record<string, any>[] };
    expect(json.profiles.map(profile => profile.label)).toEqual(["default", "preview.example.test-8445"]);
    expect(json.profiles[0]).toMatchObject({ paired: true, server: A, name: "Office PC", background: { state: "running", pid: 4242, mode: "background" }, autostart: { enabled: true, task: true } });
    expect(json.profiles[1]).toMatchObject({ paired: true, server: "https://preview.example.test:8445", background: { state: "stopped" } });
    expect(JSON.stringify(json)).not.toContain("a".repeat(64));                                        // no credential
    void two;
  });
  it("status names a profile by label or by folder, and says plainly when there is none", async () => {
    const f = fixture(); await call(["status"], f); expect(output).toMatch(/No AgEnD Runtime profile was found/);
    const one = pairTo(f.base); pairTo(join(f.base, "profiles", "b-1"), "https://b.example.test:1");
    output = ""; await call(["status", "--profile", "b-1"], f); expect(output).toMatch(/^b-1\n/); expect(output).not.toMatch(/^default\n/m);
    output = ""; await call(["status", "--profile", one.directory], f); expect(output).toMatch(/^default\n/);
  });
  it("stop asks the background Runtime to stop and waits until it is gone", async () => {
    const f = fixture(), store = pairTo(f.base); lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242);
    let gone = false; const alive = (pid: number): boolean => pid === 4242 && !gone;
    setTimeout(() => { expect(existsSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE))).toBe(true); gone = true; }, 60);
    await call(["stop"], f, { background: seams(f, { instance: { alive, reusedPid: async () => undefined, systemBootId: async () => undefined } }) });
    expect(output).toMatch(/default: stopped\./); expect(existsSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE))).toBe(false);
  });
  it("stop says so when nothing runs, tells a profile with autostart on that it comes back at sign-in, and does not turn autostart off", async () => {
    const f = fixture(), store = pairTo(f.base); await call(["stop"], f); expect(output).toMatch(/No Runtime is running, so there is nothing to stop\./);
    lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242); writeAutostartPreference(store.directory, true);
    let gone = false; setTimeout(() => { gone = true; }, 40); output = "";
    await call(["stop"], f, { background: seams(f, { instance: { alive: (pid: number) => pid === 4242 && !gone, reusedPid: async () => undefined, systemBootId: async () => undefined } }) });
    expect(output).toMatch(/starts again when you sign in to Windows/); expect(readAutostartPreference(store.directory)).toBe(true);
  });
  it("stop fails with a plain message when the Runtime does not end in time", async () => {
    const f = fixture(), store = pairTo(f.base); lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242);
    await expect(call(["stop"], f)).rejects.toThrow(/Not every Runtime was stopped\./); expect(output).toMatch(/did not stop within 0 seconds|did not stop within/); expect(output).toMatch(/Task Manager/);
  });
  it("with several Runtimes running, stop and restart refuse to guess: name one or use --all", async () => {
    const f = fixture(), one = pairTo(f.base), two = pairTo(join(f.base, "profiles", "p-2"), "https://p.example.test:2");
    for (const store of [one, two]) { lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242); }
    await expect(call(["stop"], f)).rejects.toThrow(/Several Runtimes are running: default \(.*\), p-2 \(.*\)\. Name one with --profile, or use --all to stop every one\./);
    await expect(call(["restart"], f)).rejects.toThrow(/use --all to restart every one/);
    await expect(call(["stop", "--all", "--profile", "p-2"], f)).rejects.toThrow(/--all and --profile cannot be used together/);
    expect(launches).toHaveLength(0);
  });
  it("--all stops every one that runs (an AGEND_RUNTIME_HOME in the environment does not narrow it)", async () => {
    const f = fixture(), one = pairTo(f.base), two = pairTo(join(f.base, "profiles", "p-2"), "https://p.example.test:2");
    for (const store of [one, two]) { lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242); }
    let gone = false; setTimeout(() => { gone = true; }, 60);
    await call(["stop", "--all"], f, { env: { ...f.env, AGEND_RUNTIME_HOME: one.directory }, background: seams(f, { instance: { alive: (pid: number) => pid === 4242 && !gone, reusedPid: async () => undefined, systemBootId: async () => undefined } }) });
    expect(output).toMatch(/default: stopped\./); expect(output).toMatch(/p-2: stopped\./);
  });
  it("restart stops the Runtime and starts it again with the installed version; with nothing running it starts nothing", async () => {
    const f = fixture(), store = pairTo(f.base);
    await call(["restart"], f); expect(output).toMatch(/No Runtime is running, so there is nothing to restart\. Start one with agend-runtime start\./); expect(launches).toHaveLength(0);
    lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242);
    let gone = false; setTimeout(() => { gone = true; rmSync(join(store.directory, "runtime.lock")); }, 40); output = "";
    await call(["restart"], f, { background: seams(f, { instance: { alive: (pid: number) => pid === 4242 && !gone, reusedPid: async () => undefined, systemBootId: async () => undefined } }) });
    expect(output).toMatch(/default: stopped; starting it again with the installed version\./); expect(launches).toHaveLength(1); expect(launches[0].cliPath).toBe(f.cli);
    expect(output).toMatch(/connected and running in the background/);
  });
  it("a Runtime in a window is never stopped or restarted from here", async () => {
    const f = fixture(), store = pairTo(f.base); lockFile(store.directory, 4242);
    await expect(call(["stop"], f)).rejects.toThrow(/Not every Runtime was stopped/); expect(output).toMatch(/runs in a window, not in the background\. Press Ctrl\+C in that window/);
    expect(launches).toHaveLength(0); expect(existsSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE))).toBe(false);
  });
  it("logs prints the end of the profile's log, a --tail of it, and says plainly when there is none", async () => {
    const f = fixture(), store = pairTo(f.base);
    await call(["logs"], f); expect(output).toMatch(/No log yet for default/);
    const log = new RotatingLog(runtimeLogDirectory(f.env, f.home, store.directory)); for (let index = 0; index < 30; index++) log.write(`event ${index}`);
    output = ""; await call(["logs"], f); expect(output.trim().split("\n")).toHaveLength(30);
    output = ""; await call(["logs", "--tail", "3"], f); expect(output.trim().split("\n").map(line => line.replace(/^\S+ /, ""))).toEqual(["event 27", "event 28", "event 29"]);
    await expect(call(["logs", "--tail", "0"], f)).rejects.toThrow(/--tail takes a number/); await expect(call(["logs", "--tail", "abc"], f)).rejects.toThrow(/--tail takes a number/);
    pairTo(join(f.base, "profiles", "p-2"), "https://p.example.test:2");
    await expect(call(["logs"], f)).rejects.toThrow(/Several profiles have a log\. Choose one with --profile: default \(.*\), p-2 \(/);
  });
  it("disconnect stops a background Runtime first, forgets the pairing, and removes the sign-in task and what the profile remembered", async () => {
    const f = fixture(), store = pairTo(f.base); lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242); writeAutostartPreference(store.directory, true);
    let gone = false; setTimeout(() => { gone = true; rmSync(join(store.directory, "runtime.lock")); }, 40);
    await call(["disconnect"], f, { background: seams(f, { instance: { alive: (pid: number) => pid === 4242 && !gone, reusedPid: async () => undefined, systemBootId: async () => undefined } }) });
    expect(output).toMatch(/Stopping the Runtime that runs in the background \(process 4242\) first/); expect(output).toMatch(/Local connection forgotten/);
    expect(existsSync(join(store.directory, "connection.json"))).toBe(false); expect(autostartCalls).toEqual(["disable default"]);
    expect(existsSync(join(store.directory, RUNTIME_AUTOSTART_FILE))).toBe(false); expect(existsSync(join(store.directory, RUNTIME_INSTANCE_FILE))).toBe(false);
    expect(output).toMatch(/sign-in task that started this Runtime was removed/);
  });
  it("disconnect keeps a person's \"autostart off\": after disconnect and a new connect the sign-in task is not made again", async () => {
    const f = fixture(), store = pairTo(f.base); writeAutostartPreference(store.directory, false);
    await call(["disconnect"], f);
    expect(existsSync(join(store.directory, "connection.json"))).toBe(false); expect(readAutostartPreference(store.directory)).toBe(false);   // the choice outlives the pairing
    autostartCalls.length = 0; pairTo(f.base); output = "";
    await call(["connect", "--server", A], f);
    expect(autostartCalls).toEqual([]); expect(output).not.toMatch(/starts again by itself/); expect(readAutostartPreference(store.directory)).toBe(false);
  });
  it("disconnect still forgets a preference that was on (or never chosen), so a new pairing starts afresh", async () => {
    for (const before of [true, undefined]) {
      const f = fixture(), store = pairTo(f.base); writeAutostartPreference(store.directory, before);
      await call(["disconnect"], f); expect(readAutostartPreference(store.directory)).toBeUndefined();
    }
  });
  it("disconnect that cannot stop the Runtime in time changes nothing", async () => {
    const f = fixture(), store = pairTo(f.base); lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242);
    await expect(call(["disconnect"], f)).rejects.toThrow(/did not stop in time, so nothing was disconnected/);
    expect(existsSync(join(store.directory, "connection.json"))).toBe(true); expect(autostartCalls).toEqual([]);
  });
});

describe("the detached Runtime itself (run with the background switch)", () => {
  const ID = "ab12cd34ef56ab78cd90ef12";
  const background = (f: ReturnType<typeof fixture>, launchId: string | null = ID) => ({ ...f.env, [RUNTIME_BACKGROUND_ENV]: "1", ...(launchId ? { [RUNTIME_LAUNCH_ID_ENV]: launchId } : {}) });
  const logOf = (f: ReturnType<typeof fixture>): string => { const file = join(runtimeLogDirectory(f.env, f.home, f.base), "runtime.log"); return existsSync(file) ? readFileSync(file, "utf8") : ""; };
  const word = (f: ReturnType<typeof fixture>) => readBackgroundState(f.base, ID);

  it("writes its output to the profile's log instead of the window, and tells the launcher (state file, under the launch's id) when AgEnD welcomed it", async () => {
    const f = fixture(); pairTo(f.base);
    await call(["run", "--profile", f.base], f, { env: background(f) });
    expect(logOf(f)).toMatch(/AgEnD Runtime starting in the background \(process \d+\)\./); expect(logOf(f)).toMatch(/ Connected to AgEnD\.\n/);
    expect(word(f)).toMatchObject({ launchId: ID, status: "ready", pid: process.pid });
    expect(output).toBe("");                                                                           // nothing reached the window
  });
  it("without a launch id (started by hand with only the switch) it still runs in the background but has nobody to tell", async () => {
    const f = fixture(); pairTo(f.base);
    await call(["run", "--profile", f.base], f, { env: background(f, null) });
    expect(logOf(f)).toMatch(/ Connected to AgEnD\./); expect(word(f)).toBeUndefined();
  });
  it("stays up until a stop request arrives, then stops the way Ctrl+C would, ends normally and leaves no marker or request behind", async () => {
    const f = fixture(), store = pairTo(f.base); world.endAtOnce = false; lockFile(store.directory, process.pid);
    const run = call(["run", "--profile", f.base], f, { env: background(f) });
    await vi.waitFor(() => expect(existsSync(join(store.directory, RUNTIME_INSTANCE_FILE))).toBe(true));      // it holds the lock, so it claims the marker
    expect(JSON.parse(readFileSync(join(store.directory, RUNTIME_INSTANCE_FILE), "utf8"))).toMatchObject({ version: 1, pid: process.pid, mode: "background" });
    writeFileSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE), JSON.stringify({ version: 1, at: 1 }));
    await expect(run).resolves.toBeUndefined();
    expect(logOf(f)).toMatch(/Stop requested \(agend-runtime stop\); stopping\./); expect(logOf(f)).toMatch(/process ended/);
    expect(existsSync(join(store.directory, RUNTIME_INSTANCE_FILE))).toBe(false); expect(existsSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE))).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });
  it("a first stop that is not confirmed leaves the Runtime up and watching: the next stop request retries and ends it, one attempt at a time", async () => {
    const f = fixture(), store = pairTo(f.base); world.endAtOnce = false; world.stopFailures = 1; world.stopCalls = 0; lockFile(store.directory, process.pid);
    let settled = false; const run = call(["run", "--profile", f.base], f, { env: background(f) }).then(() => { settled = true; });
    await vi.waitFor(() => expect(existsSync(join(store.directory, RUNTIME_INSTANCE_FILE))).toBe(true));
    writeFileSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE), JSON.stringify({ version: 1, at: 1 }));
    await vi.waitFor(() => expect(world.stopCalls).toBe(1)); await vi.waitFor(() => expect(existsSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE))).toBe(false));
    await new Promise(resolve => setTimeout(resolve, 100)); expect(settled, "the Runtime is still up after the failed stop").toBe(false);
    writeFileSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE), JSON.stringify({ version: 1, at: 2 }));      // agend-runtime stop asks again
    await expect(run).resolves.toBeUndefined();
    expect(world.stopCalls).toBe(2); expect(existsSync(join(store.directory, RUNTIME_INSTANCE_FILE))).toBe(false);
  });
  it("a stop request left over from before it started does not stop it", async () => {
    const f = fixture(), store = pairTo(f.base); world.endAtOnce = false; writeFileSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE), JSON.stringify({ version: 1, at: 1 }));
    let settled = false; const run = call(["run", "--profile", f.base], f, { env: background(f) }).then(() => { settled = true; });
    await new Promise(done => setTimeout(done, 150)); expect(settled).toBe(false);
    writeFileSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE), JSON.stringify({ version: 1, at: 2 })); await run;
  });
  it("another Runtime already holds the profile: it says so to the launcher, writes it down and leaves the other one's marker alone", async () => {
    const f = fixture(), store = pairTo(f.base); lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242, 77);
    await call(["run", "--profile", f.base], f, { env: background(f) });
    expect(word(f)).toMatchObject({ launchId: ID, status: "already-running", pid: 4242 }); expect(world.started).not.toHaveBeenCalled();
    expect(logOf(f)).toMatch(/already runs for this profile \(process 4242\); this one did not start/);
    expect(JSON.parse(readFileSync(join(store.directory, RUNTIME_INSTANCE_FILE), "utf8"))).toMatchObject({ pid: 4242, startedAt: 77 });
    world.started.mockClear(); clearBackgroundState(store.directory); rmSync(join(store.directory, "runtime.lock"));          // the lock appears only when the client starts: the race
    world.startError = new RuntimeProfileInUseError(31, store.directory, false, join(store.directory, "runtime.lock"));
    await call(["run", "--profile", f.base], f, { env: background(f) }); expect(word(f)).toMatchObject({ status: "already-running", pid: 31 });
  });
  it("an end AgEnD caused (revoked, refused…) is written to the log and leaves a non-zero exit status", async () => {
    const f = fixture(); pairTo(f.base); world.stopReason = { kind: "revoked" }; const code = process.exitCode;
    try {
      await call(["run", "--profile", f.base], f, { env: background(f) });
      expect(process.exitCode).toBe(1);
      expect(logOf(f)).toMatch(/ERROR This computer was revoked in AgEnD Settings -> Runtime/);
      expect(word(f)).toMatchObject({ status: "ready" });                                               // it had told the launcher it connected; its later end is in the log and the exit status
    } finally { process.exitCode = code; }
  });
  it("a start that fails before it connected tells the launcher why", async () => {
    const f = fixture(); pairTo(f.base); world.startError = new Error("Runtime start was cancelled"); const code = process.exitCode;
    try { await call(["run", "--profile", f.base], f, { env: background(f) }); expect(word(f)).toMatchObject({ launchId: ID, status: "failed", message: "Runtime start was cancelled" }); expect(process.exitCode).toBe(1); }
    finally { process.exitCode = code; }
  });
  it("puts the streams back when it ends", async () => {
    const f = fixture(); pairTo(f.base); const before = process.stdout.write;
    await call(["run", "--profile", f.base], f, { env: background(f) }); expect(process.stdout.write).toBe(before);
  });
  it("the same run without the switch is an ordinary window run: output in the window, no log, no word to anyone", async () => {
    const f = fixture(); pairTo(f.base);
    await call(["run", "--profile", f.base], f, { env: { ...f.env, [RUNTIME_LAUNCH_ID_ENV]: ID } }); expect(output).toMatch(/Connected to AgEnD\./); expect(logOf(f)).toBe(""); expect(word(f)).toBeUndefined();
  });
});

describe("how the commands are typed in the messages", () => {
  const exists = (...paths: string[]) => (path: string) => paths.includes(path);
  it("says agend-runtime when the installer's bin folder is on PATH, the file that starts it when it is not, and node + the script for a layout without a shim", () => {
    const cli = join(sep, "i", "1.0.0+abc", "dist", "runtime-cli.js"), shim = join(sep, "i", "bin", "agend-runtime.cmd");
    expect(runtimeCommandName(cli, { Path: `C:\\x;${join(sep, "i", "bin")}` }, exists(shim))).toBe("agend-runtime");
    expect(runtimeCommandName(cli, { PATH: "C:\\x" }, exists(shim))).toBe(`"${shim}"`);
    expect(runtimeCommandName(cli, {}, exists())).toBe(`node.exe "${cli}"`);
    const zipShim = join(sep, "zip", "agend-runtime.cmd"); expect(runtimeCommandName(join(sep, "zip", "dist", "runtime-cli.js"), {}, exists(zipShim))).toBe(`"${zipShim}"`);
  });
});

// This suite models an admitted NTFS boundary; dedicated privacy tests retain the real gate and refusal ordering.
vi.mock("../src/runtime-pane-private.js", async original => ({ ...await original<typeof import("../src/runtime-pane-private.js")>(), protectRuntimeProfileDirectorySync(directory: string) {
  const fs = fixturePrivacyFs;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Unsafe profile fixture");
} }));
