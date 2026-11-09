import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RUNTIME_AUTOSTART_FILE, RUNTIME_INSTANCE_FILE, RUNTIME_LOG_KEEP, RUNTIME_LOG_MAX_BYTES, RUNTIME_STOP_REQUEST_FILE, RotatingLog, captureProcessOutput, clearInstanceMarker, clearStopRequest,
  discoverRuntimeProfiles, launchBackgroundRuntime, noteRuntimeProfile, powershellStartScript, readAutostartPreference, readBackgroundState, readInstanceMarker, readRuntimeInstance,
  reportBackgroundState, requestRuntimeStop, runtimeDataRoot, runtimeLogDirectory, runtimeProfileLabel, stopRuntimeInstance, watchStopRequest, writeAutostartPreference, writeInstanceMarker,
  RUNTIME_BACKGROUND_STATE_PREFIX, backgroundStateFile, pruneBackgroundStates, RUNTIME_LAUNCH_ID_ENV, clearBackgroundState } from "../src/runtime-background.js";

/**
 * the pieces that keep the Windows Runtime in the background: a log with a size limit that rotates, one instance per profile (the profile lock),
 * a stop request in place of a signal, and a launcher that detaches the process and waits (a bounded time) until it says it is connected.
 */
const roots: string[] = [];
function scratch(): string { const root = mkdtempSync(join(tmpdir(), "agend-runtime-background-")); roots.push(root); return root; }
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe test path"); rmSync(root, { recursive: true, force: true }); }
});
const lockFile = (directory: string, pid: number, extra: Record<string, unknown> = {}): void => writeFileSync(join(directory, "runtime.lock"), JSON.stringify({ pid, bootId: "boot", ...extra }));

describe("profile names and folders", () => {
  it("names the default profile, a per-server profile and a custom folder, and no two folders share a name", () => {
    const home = scratch(), base = join(home, ".agend-runtime");
    expect(runtimeProfileLabel(base, home)).toBe("default");
    expect(runtimeProfileLabel(join(base, "profiles", "fleet.example.test-8445"), home)).toBe("fleet.example.test-8445");
    const a = runtimeProfileLabel(join(home, "work", "one"), home), b = runtimeProfileLabel(join(home, "other", "one"), home);
    expect(a).toMatch(/^custom-one-[a-f0-9]{8}$/); expect(b).toMatch(/^custom-one-[a-f0-9]{8}$/); expect(a).not.toBe(b);
    expect(runtimeProfileLabel(join(home, "work", "one"), home)).toBe(a);                     // stable
    expect(runtimeProfileLabel(join(base, "profiles", "..", "..", "x y&z"), home)).toMatch(/^custom-x_y_z-[a-f0-9]{8}$/);   // file-name safe
    for (const label of [runtimeProfileLabel(join(base, "profiles", "a b"), home), a]) expect(label).toMatch(/^[A-Za-z0-9._-]+$/);
  });
  it("keeps two server profiles apart when their folder names are too long to keep whole: the label carries the complete profile identity", () => {
    const home = scratch(), base = join(home, ".agend-runtime"), host = "a".repeat(63);
    const one = join(base, "profiles", `${host}.example.test-8443`), two = join(base, "profiles", `${host}.example.test-9443`);
    const a = runtimeProfileLabel(one, home), b = runtimeProfileLabel(two, home);
    expect(a).not.toBe(b); for (const label of [a, b]) { expect(label).toMatch(/^[A-Za-z0-9._-]{1,64}$/); expect(label).toMatch(/-[a-f0-9]{8}$/); }
    expect(runtimeProfileLabel(one, home)).toBe(a);                                                      // stable
    const env = { LOCALAPPDATA: join(home, "local") };
    expect(runtimeLogDirectory(env, home, one)).not.toBe(runtimeLogDirectory(env, home, two));
    // a name that is kept whole keeps its plain label, and replaced characters do not make two names one
    expect(runtimeProfileLabel(join(base, "profiles", "fleet.example.test-8445"), home)).toBe("fleet.example.test-8445");
    expect(runtimeProfileLabel(join(base, "profiles", "a b"), home)).not.toBe(runtimeProfileLabel(join(base, "profiles", "a_b"), home));
  });
  it("puts logs under %LOCALAPPDATA%\\agend-runtime\\logs\\<profile>, or the same place under the home folder when there is none", () => {
    const home = scratch();
    expect(runtimeDataRoot({ LOCALAPPDATA: join(home, "local") }, home)).toBe(join(home, "local", "agend-runtime"));
    expect(runtimeLogDirectory({ LOCALAPPDATA: join(home, "local") }, home, join(home, ".agend-runtime"))).toBe(join(home, "local", "agend-runtime", "logs", "default"));
    expect(runtimeDataRoot({}, home)).toBe(join(home, "AppData", "Local", "agend-runtime"));
  });
});

describe("the log: a size limit, and rotation", () => {
  it("adds a timestamp to each line, marks errors, and ignores empty lines", () => {
    const log = new RotatingLog(scratch(), { now: () => Date.UTC(2026, 10, 8, 3, 0, 0) });
    log.write("Connected to AgEnD.\n\nsecond line\r\n"); log.write("it broke", "error");
    expect(readFileSync(log.file, "utf8")).toBe("2026-11-08T03:00:00.000Z Connected to AgEnD.\n2026-11-08T03:00:00.000Z second line\n2026-11-08T03:00:00.000Z ERROR it broke\n");
  });
  it("rotates to .1 when the next write would pass the limit, keeps only the configured number of old files, and never passes the total bound", () => {
    const directory = scratch(), log = new RotatingLog(directory, { maxBytes: 400, keep: 3 });
    for (let index = 0; index < 200; index++) log.write(`line ${index} ${"x".repeat(40)}`);
    const files = readdirSync(directory).sort();
    expect(files).toEqual(["runtime.log", "runtime.log.1", "runtime.log.2", "runtime.log.3"]);
    for (const file of files) expect(statSync(join(directory, file)).size).toBeLessThanOrEqual(400);
    // the newest line is in the live file, and older files hold older lines
    expect(readFileSync(log.file, "utf8")).toContain("line 199");
    expect(readFileSync(log.rotatedFile(1), "utf8")).not.toContain("line 199");
    const number = (file: string): number => Number(/line (\d+)/.exec(readFileSync(join(directory, file), "utf8"))![1]);
    expect(number("runtime.log.3")).toBeLessThan(number("runtime.log.2")); expect(number("runtime.log.2")).toBeLessThan(number("runtime.log.1"));
  });
  it("is bounded by (keep + 1) * maxBytes with the real defaults", () => {
    expect((RUNTIME_LOG_KEEP + 1) * RUNTIME_LOG_MAX_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
    const directory = scratch(), log = new RotatingLog(directory);
    for (let index = 0; index < 40; index++) log.write(`${"y".repeat(100_000)}`);
    expect(statSync(log.file).size).toBeLessThanOrEqual(RUNTIME_LOG_MAX_BYTES); expect(existsSync(log.rotatedFile(1))).toBe(true);
  });
  it("another process's lines count: the size comes from the file each time", () => {
    const directory = scratch(), one = new RotatingLog(directory, { maxBytes: 300, keep: 1 }), two = new RotatingLog(directory, { maxBytes: 300, keep: 1 });
    for (let index = 0; index < 20; index++) { one.write(`a ${"x".repeat(30)}`); two.write(`b ${"x".repeat(30)}`); }
    expect(statSync(one.file).size).toBeLessThanOrEqual(300); expect(readdirSync(directory).sort()).toEqual(["runtime.log", "runtime.log.1"]);
  });
  it("empties a live file that cannot be rotated once it is twice the limit, and never throws", () => {
    const directory = scratch(), log = new RotatingLog(directory, { maxBytes: 100, keep: 1 });
    writeFileSync(log.file, "z".repeat(500));
    mkdirSync(log.rotatedFile(1));                      // a folder where the rotated file must go: the rename fails
    expect(() => log.write("hello")).not.toThrow();
    expect(statSync(log.file).size).toBeLessThan(100);
  });
  it("tail reads back through the rotated files, oldest first, and returns what exists", () => {
    const log = new RotatingLog(scratch(), { maxBytes: 200, keep: 2 });
    for (let index = 0; index < 12; index++) log.write(`n${index} ${"x".repeat(30)}`);
    const tail = log.tail(5); expect(tail).toHaveLength(5);
    expect(tail.map(line => /n(\d+)/.exec(line)![1])).toEqual(["7", "8", "9", "10", "11"]);
    expect(new RotatingLog(scratch()).tail(5)).toEqual([]);
  });
  it("captures what a process writes to stdout and stderr, and puts the streams back", () => {
    const log = new RotatingLog(scratch()), written: string[] = [];
    const target = { stdout: { write: ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write }, stderr: { write: (() => true) as typeof process.stdout.write } };
    const original = target.stdout.write, callback = vi.fn();
    const restore = captureProcessOutput(log, target);
    target.stdout.write("hello\n", callback); target.stderr.write(Buffer.from("bad\n"));
    expect(written).toEqual([]); expect(callback).toHaveBeenCalled();
    const text = readFileSync(log.file, "utf8"); expect(text).toMatch(/ hello\n/); expect(text).toMatch(/ ERROR bad\n/);
    restore(); expect(target.stdout.write).toBe(original);
  });
});

describe("what a profile remembers", () => {
  it("keeps the instance marker only for the process that wrote it", () => {
    const directory = scratch();
    expect(readInstanceMarker(directory)).toBeUndefined();
    writeInstanceMarker(directory, 4242, 1000, "1.2.3"); expect(readInstanceMarker(directory)).toEqual({ version: 1, pid: 4242, startedAt: 1000, mode: "background", runtimeVersion: "1.2.3" });
    clearInstanceMarker(directory, 1); expect(existsSync(join(directory, RUNTIME_INSTANCE_FILE))).toBe(true);
    clearInstanceMarker(directory, 4242); expect(existsSync(join(directory, RUNTIME_INSTANCE_FILE))).toBe(false);
    writeInstanceMarker(directory, 5); clearInstanceMarker(directory); expect(existsSync(join(directory, RUNTIME_INSTANCE_FILE))).toBe(false);
    writeFileSync(join(directory, RUNTIME_INSTANCE_FILE), '{"version":1,"pid":"x"}'); expect(readInstanceMarker(directory)).toBeUndefined();
  });
  it("remembers whether autostart was chosen: never chosen is not the same as off", () => {
    const directory = scratch();
    expect(readAutostartPreference(directory)).toBeUndefined();
    writeAutostartPreference(directory, true); expect(readAutostartPreference(directory)).toBe(true);
    writeAutostartPreference(directory, false); expect(readAutostartPreference(directory)).toBe(false);
    writeAutostartPreference(directory, undefined); expect(readAutostartPreference(directory)).toBeUndefined(); expect(existsSync(join(directory, RUNTIME_AUTOSTART_FILE))).toBe(false);
  });
  it("finds the default profile, the per-server ones, and a custom one it was told about, and nothing that is not a Runtime profile", () => {
    const home = scratch(), env = { LOCALAPPDATA: join(home, "local") }, base = join(home, ".agend-runtime");
    expect(discoverRuntimeProfiles(env, home)).toEqual([]);
    mkdirSync(join(base, "profiles", "a-443"), { recursive: true }); mkdirSync(join(base, "profiles", "empty"), { recursive: true });
    writeFileSync(join(base, "profiles", "a-443", "connection.json"), "{}");
    const custom = join(home, "preview-profile"); mkdirSync(custom); writeFileSync(join(custom, "connection.json"), "{}"); noteRuntimeProfile(env, home, custom);
    const ghost = join(home, "gone"); noteRuntimeProfile(env, home, ghost);                        // told about, but it does not exist
    expect(discoverRuntimeProfiles(env, home).map(profile => profile.label).sort()).toEqual(["a-443", "default", runtimeProfileLabel(custom, home)].sort());
    expect(discoverRuntimeProfiles(env, home).find(profile => profile.label === "a-443")!.directory).toBe(join(base, "profiles", "a-443"));
  });
});

describe("is a Runtime running for this profile", () => {
  const alive = (...pids: number[]) => (pid: number): boolean => pids.includes(pid);
  it("has none when there is no lock, or the lock's process is gone", async () => {
    const store = new RuntimeClientStore(scratch());
    expect(await readRuntimeInstance(store, { alive: alive() })).toEqual({ state: "stopped" });
    lockFile(store.directory, 4242); expect(await readRuntimeInstance(store, { alive: alive() })).toEqual({ state: "stopped" });
  });
  it("tells a background Runtime (its marker names the lock's process) from one in a window", async () => {
    const store = new RuntimeClientStore(scratch()); lockFile(store.directory, 4242);
    expect(await readRuntimeInstance(store, { alive: alive(4242) })).toEqual({ state: "running", pid: 4242, mode: "foreground" });
    writeInstanceMarker(store.directory, 4242, 5000);
    expect(await readRuntimeInstance(store, { alive: alive(4242) })).toEqual({ state: "running", pid: 4242, mode: "background", startedAt: 5000 });
    writeInstanceMarker(store.directory, 9999, 5000);                                              // a marker left by another process is not believed
    expect((await readRuntimeInstance(store, { alive: alive(4242) })).mode).toBe("foreground");
  });
  it("on Windows, a lock from before the last restart or one whose number another program reuses is not a running Runtime", async () => {
    const store = new RuntimeClientStore(scratch()); lockFile(store.directory, 4242, { systemBootId: "a".repeat(64) });
    const base = { alive: alive(4242), platform: "win32" as const };
    expect((await readRuntimeInstance(store, { ...base, systemBootId: async () => "b".repeat(64), reusedPid: async () => undefined })).state).toBe("stopped");
    expect((await readRuntimeInstance(store, { ...base, systemBootId: async () => "a".repeat(64), reusedPid: async () => 4242 })).state).toBe("stopped");
    expect((await readRuntimeInstance(store, { ...base, systemBootId: async () => "a".repeat(64), reusedPid: async () => undefined })).state).toBe("running");
    expect((await readRuntimeInstance(store, { ...base, systemBootId: async () => undefined, reusedPid: async () => undefined })).state).toBe("running");   // unknown is never "gone"
  });
  it("never creates or removes the lock", async () => {
    const store = new RuntimeClientStore(scratch()); lockFile(store.directory, 4242);
    const before = readFileSync(join(store.directory, "runtime.lock"), "utf8");
    await readRuntimeInstance(store, { alive: alive() }); expect(readFileSync(join(store.directory, "runtime.lock"), "utf8")).toBe(before);
    rmSync(join(store.directory, "runtime.lock")); await readRuntimeInstance(store, { alive: alive(4242) }); expect(existsSync(join(store.directory, "runtime.lock"))).toBe(false);
  });
});

describe("stop: a request file instead of a signal", () => {
  it("is consumed once by the Runtime that watches for it, and only then does it stop", async () => {
    vi.useFakeTimers();
    const directory = scratch(), stop = vi.fn(), unwatch = watchStopRequest(directory, stop, 100);
    vi.advanceTimersByTime(500); expect(stop).not.toHaveBeenCalled();
    requestRuntimeStop(directory, 1);
    expect(JSON.parse(readFileSync(join(directory, RUNTIME_STOP_REQUEST_FILE), "utf8"))).toEqual({ version: 1, at: 1 });
    await vi.advanceTimersByTimeAsync(150); expect(stop).toHaveBeenCalledTimes(1); expect(existsSync(join(directory, RUNTIME_STOP_REQUEST_FILE))).toBe(false);
    unwatch(); requestRuntimeStop(directory); vi.advanceTimersByTime(1000); expect(stop).toHaveBeenCalledTimes(1);   // the caller ended the watch: nothing more is consumed
    clearStopRequest(directory); expect(existsSync(join(directory, RUNTIME_STOP_REQUEST_FILE))).toBe(false);
  });
  it("keeps watching after an attempt, so a shutdown that was not confirmed can be asked again, and never runs two attempts at once", async () => {
    vi.useFakeTimers();
    const directory = scratch(); let release: () => void = () => {}, calls = 0, running = 0, overlap = 0;
    const stop = vi.fn(async () => { calls++; running++; overlap = Math.max(overlap, running); await new Promise<void>((resolve, reject) => { release = calls === 1 ? () => reject(new Error("an account process is still running")) : resolve; }).finally(() => { running--; }); });
    const unwatch = watchStopRequest(directory, stop, 100);
    requestRuntimeStop(directory, 1); await vi.advanceTimersByTimeAsync(150); expect(stop).toHaveBeenCalledTimes(1);
    requestRuntimeStop(directory, 2); await vi.advanceTimersByTimeAsync(500);
    expect(stop, "a request during an attempt waits for it").toHaveBeenCalledTimes(1); expect(existsSync(join(directory, RUNTIME_STOP_REQUEST_FILE))).toBe(true);
    release(); await vi.advanceTimersByTimeAsync(150);                                   // the first attempt fails: the waiting request is taken
    expect(stop).toHaveBeenCalledTimes(2); expect(existsSync(join(directory, RUNTIME_STOP_REQUEST_FILE))).toBe(false);
    release(); await vi.advanceTimersByTimeAsync(300); expect(overlap).toBe(1);
    unwatch();
  });
  it("stop waits until the lock's process is gone, and says not-running when there is nothing to stop", async () => {
    const store = new RuntimeClientStore(scratch());
    expect(await stopRuntimeInstance(store, { deps: { alive: () => false } })).toBe("not-running");
    lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242);
    let polls = 0;
    const outcome = await stopRuntimeInstance(store, { deps: { alive: () => polls < 3 }, sleep: async () => { polls++; if (polls === 1) expect(existsSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE))).toBe(true); }, pollMs: 1 });
    expect(outcome).toBe("stopped"); expect(existsSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE))).toBe(false);
  });
  it("gives up with a timeout while the Runtime is still there, and refuses a Runtime that runs in a window", async () => {
    const store = new RuntimeClientStore(scratch()); lockFile(store.directory, 4242);
    await expect(stopRuntimeInstance(store, { deps: { alive: () => true } })).rejects.toThrow(/runs in a window.*Ctrl\+C/);
    writeInstanceMarker(store.directory, 4242);
    expect(await stopRuntimeInstance(store, { deps: { alive: () => true }, timeoutMs: 30, pollMs: 5 })).toBe("timeout");
  });
  it("asks again while the Runtime is handing over to a new version, so a request is not lost in the hand-over", async () => {
    const store = new RuntimeClientStore(scratch()); lockFile(store.directory, 4242); writeInstanceMarker(store.directory, 4242);
    const asks: number[] = []; let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await stopRuntimeInstance(store, { deps: { alive: () => now < 7000 }, sleep: async () => { now += 1000; if (existsSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE))) { asks.push(now); rmSync(join(store.directory, RUNTIME_STOP_REQUEST_FILE)); } }, pollMs: 1, timeoutMs: 60_000 });
    expect(asks.length).toBeGreaterThanOrEqual(3);
  });
});

const ID = "ab12cd34ef56ab78cd90ef12";
/** What the launcher does about Windows: it asks PowerShell to start the process; this stands in for that and records what was asked. */
function fakeStart(pid = 7000) {
  const calls: { script: string; env: Record<string, string | undefined>; cwd: string }[] = [];
  const start = vi.fn(async (input: { script: string; env: Record<string, string | undefined>; cwd: string }) => { calls.push(input); return { pid }; });
  return { start, calls };
}
const reply = (directory: string, state: Record<string, unknown>): void => writeFileSync(join(directory, backgroundStateFile(String(state.launchId ?? ID))), JSON.stringify({ version: 1, launchId: ID, pid: 7000, at: 1, ...state }));
describe("the PowerShell that starts the Runtime", () => {
  const input = { execPath: "C:\\Program Files\\nodejs\\node.exe", cliPath: "C:\\Users\\me\\AppData\\Local\\agend-runtime\\1.0.0+abc\\dist\\runtime-cli.js", profile: "C:\\Users\\me\\.agend-runtime" };
  it("uses Start-Process (no inherited handle), hidden, with the profile as its folder, and prints the new process id", () => {
    const script = powershellStartScript(input);
    expect(script).toContain("Start-Process -FilePath 'C:\\Program Files\\nodejs\\node.exe'"); expect(script).toContain("-WindowStyle Hidden -PassThru");
    expect(script).toContain(`-ArgumentList '"${input.cliPath}" run --profile "${input.profile}"'`); expect(script).toContain(`-WorkingDirectory '${input.profile}'`);
    expect(script).toContain("[Console]::Out.Write('AGEND_PID=' + $p.Id)"); expect(script).toContain("$ErrorActionPreference = 'Stop'");
  });
  it("carries no pairing code, token or credential: the profile folder is the only thing it names", () => {
    const script = powershellStartScript(input); expect(script).not.toMatch(/--server|--enroll|--code|token|credential|fingerprint/i);
    expect(script.match(/run --profile/g)).toHaveLength(1);
  });
  it("escapes a single quote in a path the PowerShell way, and refuses a double quote or a line break with a way out", () => {
    expect(powershellStartScript({ ...input, profile: "C:\\O'Neil\\p" })).toContain("-WorkingDirectory 'C:\\O''Neil\\p'");
    for (const bad of ['C:\\a"b', "C:\\a\nb"]) expect(() => powershellStartScript({ ...input, profile: bad })).toThrow(/--foreground/);
  });
});
describe("the Runtime's word to its launcher (the state file)", () => {
  it("is written only for a start that has a launch id, as a small private file naming that id", () => {
    const directory = scratch();
    reportBackgroundState(directory, {}, { status: "ready" }); expect(readdirSync(directory)).toEqual([]);
    reportBackgroundState(directory, { [RUNTIME_LAUNCH_ID_ENV]: "not hex!" }, { status: "ready" }); expect(readdirSync(directory)).toEqual([]);
    reportBackgroundState(directory, { [RUNTIME_LAUNCH_ID_ENV]: ID }, { status: "failed", message: "revoked" }, 5);
    expect(readdirSync(directory)).toEqual([`${RUNTIME_BACKGROUND_STATE_PREFIX}${ID}.json`]);
    expect(readBackgroundState(directory, ID)).toEqual({ version: 1, launchId: ID, pid: process.pid, status: "failed", message: "revoked", at: 5 });
    expect(readBackgroundState(directory, "ff".repeat(12))).toBeUndefined();                  // another launch's id reads another launch's file
    clearBackgroundState(directory, ID); expect(readBackgroundState(directory, ID)).toBeUndefined();
  });
  it("does not believe a malformed file", () => {
    const directory = scratch();
    for (const bad of ['{"version":2}', '{"version":1,"launchId":"zz","pid":1,"status":"ready"}', '{"version":1,"launchId":"' + ID + '","pid":"x","status":"ready"}', '{"version":1,"launchId":"' + ID + '","pid":3,"status":"fine"}', "not json"]) {
      writeFileSync(join(directory, backgroundStateFile(ID)), bad); expect(readBackgroundState(directory, ID), bad).toBeUndefined();
    }
  });
  it("a launch removes its own file once it has read it, never someone else's, and prunes only leftovers older than ten minutes", () => {
    const directory = scratch(), old = join(directory, backgroundStateFile("cc".repeat(12))), mine = join(directory, backgroundStateFile("dd".repeat(12)));
    writeFileSync(old, "{}"); writeFileSync(mine, "{}"); utimesSync(old, new Date(Date.now() - 11 * 60_000), new Date(Date.now() - 11 * 60_000));
    pruneBackgroundStates(directory); expect(existsSync(old)).toBe(false); expect(existsSync(mine)).toBe(true);   // a launch in progress keeps its file
    writeFileSync(join(directory, "autostart.json"), "{}"); clearBackgroundState(directory); expect(readdirSync(directory)).toEqual(["autostart.json"]);   // nothing but the state files
  });
});
describe("starting a background Runtime", () => {
  const options = (store: RuntimeClientStore, extra: Record<string, unknown> = {}) => ({ store, cliPath: "cli.js", execPath: "node.exe", env: { PATH: "p", KEEP: "1" }, launchId: ID, pollMs: 1, sleep: async () => {}, alive: () => true, ...extra });
  it("asks PowerShell to start it, with the background switch and this launch's id in the environment and the profile as the folder, and answers when the Runtime says it is connected", async () => {
    const store = new RuntimeClientStore(scratch()), fake = fakeStart(); let polls = 0;
    const launched = await launchBackgroundRuntime(options(store, { start: fake.start, sleep: async () => { if (++polls === 3) reply(store.directory, { status: "ready" }); } }) as never);
    expect(launched).toEqual({ kind: "started", pid: 7000, connected: true });
    expect(fake.calls).toHaveLength(1); expect(fake.calls[0].cwd).toBe(store.directory);
    expect(fake.calls[0].env).toEqual({ PATH: "p", KEEP: "1", AGEND_RUNTIME_BACKGROUND: "1", AGEND_RUNTIME_LAUNCH_ID: ID });
    expect(fake.calls[0].script).toContain(`run --profile "${store.directory}"`); expect(polls).toBeGreaterThanOrEqual(3);
  });
  it("carries no pairing code, token or credential: only the profile folder is passed", async () => {
    const store = new RuntimeClientStore(scratch()), fake = fakeStart();
    store.saveCredentials({ server: "https://a.example.test", machineId: "11111111-2222-4333-8444-555555555555", credential: "c".repeat(64), name: "PC" });
    reply(store.directory, { status: "ready" });
    // a word from an earlier start is not this start's word: the file is cleared first, and only this launch's id counts
    const answer = await launchBackgroundRuntime(options(store, { start: async (input: { script: string; env: Record<string, string | undefined>; cwd: string }) => { fake.calls.push(input); reply(store.directory, { status: "ready" }); return { pid: 7000 }; } }) as never);
    expect(answer.kind).toBe("started"); expect(JSON.stringify(fake.calls)).not.toContain("c".repeat(64));
  });
  it("ignores a word that is not this launch's, and a stale one left from before", async () => {
    const store = new RuntimeClientStore(scratch()), fake = fakeStart(); reply(store.directory, { launchId: "ee".repeat(12), status: "failed", message: "old" });
    let polls = 0;
    const launched = await launchBackgroundRuntime(options(store, { start: fake.start, waitMs: 20, sleep: async () => { if (++polls === 1) writeFileSync(join(store.directory, backgroundStateFile("ff".repeat(12))), JSON.stringify({ version: 1, launchId: "ff".repeat(12), pid: 1, status: "failed", at: 1 })); await new Promise(done => setTimeout(done, 5)); } }) as never);
    expect(launched).toEqual({ kind: "started", pid: 7000, connected: false });
  });
  it("keeps two launches that start at the same moment apart: the loser's word does not overwrite the winner's", async () => {
    const store = new RuntimeClientStore(scratch()), winner = "aa".repeat(12), loser = "bb".repeat(12);
    // both launchers are waiting; the loser's Runtime finds the lock held and says so, and the winner's Runtime says it is connected, in either order
    for (const order of [[winner, loser], [loser, winner]]) {
      clearBackgroundState(store.directory);
      const results = await Promise.all([winner, loser].map(launchId => launchBackgroundRuntime(options(store, { launchId, waitMs: 2000, pollMs: 5, sleep: (ms: number) => new Promise<void>(done => setTimeout(done, ms)), start: async () => {
        setTimeout(() => reportBackgroundState(store.directory, { [RUNTIME_LAUNCH_ID_ENV]: launchId }, launchId === winner ? { status: "ready", pid: 7000 } : { status: "already-running", pid: 7000 }), order.indexOf(launchId) * 15 + 5);
        return { pid: 7000 };
      } }) as never)));
      expect(results[0]).toEqual({ kind: "started", pid: 7000, connected: true });                // the winner is told it is connected, never "not connected yet"
      expect(results[1]).toEqual({ kind: "already-running", pid: 7000 });
    }
  });
  it("reports 'already running' and a failure with the Runtime's own words", async () => {
    const store = new RuntimeClientStore(scratch());
    expect(await launchBackgroundRuntime(options(store, { start: async () => { reply(store.directory, { status: "already-running", pid: 55 }); return { pid: 7000 }; } }) as never)).toEqual({ kind: "already-running", pid: 55 });
    expect(await launchBackgroundRuntime(options(store, { start: async () => { reply(store.directory, { status: "failed", message: "revoked" }); return { pid: 7000 }; } }) as never)).toEqual({ kind: "failed", message: "revoked" });
  });
  it("fails at once, with the next step, when the process is gone before it said anything, or PowerShell could not start it", async () => {
    const store = new RuntimeClientStore(scratch()), fake = fakeStart();
    expect(await launchBackgroundRuntime(options(store, { start: fake.start, alive: () => false }) as never)).toMatchObject({ kind: "failed", message: expect.stringMatching(/stopped before it connected.*agend-runtime logs/) });
    expect(await launchBackgroundRuntime(options(store, { start: async () => ({ error: "Access is denied" }) }) as never)).toMatchObject({ kind: "failed", message: expect.stringMatching(/could not be started in the background: Access is denied\. Use connect --foreground/) });
    expect(await launchBackgroundRuntime(options(store, { start: async () => ({}) }) as never)).toMatchObject({ kind: "failed", message: expect.stringMatching(/no process was created/) });
    expect(await launchBackgroundRuntime(options(store, { start: fake.start, cliPath: 'C:\\a"b.js' }) as never)).toMatchObject({ kind: "failed", message: expect.stringMatching(/--foreground/) });
  });
  it("stops waiting after a bounded time and says it is started but not connected yet", async () => {
    const store = new RuntimeClientStore(scratch()), fake = fakeStart();
    const launched = await launchBackgroundRuntime(options(store, { start: fake.start, waitMs: 30, sleep: async () => { await new Promise(done => setTimeout(done, 10)); } }) as never);
    expect(launched).toEqual({ kind: "started", pid: 7000, connected: false });
  });
  it("writes what happened to the profile's log", async () => {
    const store = new RuntimeClientStore(scratch()), log = new RotatingLog(scratch());
    await launchBackgroundRuntime(options(store, { log, start: async () => { reply(store.directory, { status: "ready" }); return { pid: 7000 }; } }) as never);
    expect(readFileSync(log.file, "utf8")).toMatch(/Background Runtime started \(process 7000, connected\)/);
  });
});
