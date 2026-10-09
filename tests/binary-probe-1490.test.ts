import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1490 (2.2 audit): `/ui/backends` ran `execFileSync("which", …)` once per backend, seven in a row with a 2 s timeout
 * each, on the fleet's event loop, on every request. These pin the replacement: `which` as an asynchronous child with
 * a deadline, an answer reused for a TTL on a monotonic clock, concurrent probes sharing one answer, a fresh probe for
 * `/login`, and (#1498 review) a bound on stuck lookups: every caller answers by the deadline, and a hung lookup costs
 * one process per binary until it really exits, never one per request.
 */

const hooks = vi.hoisted(() => ({ sync: [] as string[], spawn: null as null | ((...a: any[]) => any), spawned: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const record = <F extends (...a: any[]) => any>(name: string, fn: F) =>
    ((...a: Parameters<F>) => { hooks.sync.push(`${name} ${String(a[0])}`); return fn(...a); }) as F;
  return {
    ...real,
    execFileSync: record("execFileSync", real.execFileSync),
    execSync: record("execSync", real.execSync),
    spawnSync: record("spawnSync", real.spawnSync),
    spawn: (...a: any[]) => { hooks.spawned++; return hooks.spawn ? hooks.spawn(...a) : (real.spawn as any)(...a); },
  };
});

const { BinaryProbe, binaryProbe, spawnWhich, spawnProbeCommand, BINARY_PROBE_TTL_MS, PROBE_DEADLINE_MS } =
  await import("../src/binary-probe.js");
const { handleWebRequest } = await import("../src/web-api.js");
type ProbeChild = import("../src/binary-probe.js").ProbeChild;

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "agend-probe-"));
  dirs.push(d);
  return d;
}
function file(dir: string, name: string, mode: number): string {
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, mode);
  return p;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A probe child the test drives: answer it, fail it, or never; it exits only when told to. */
function fakeChild() {
  let answer!: (p: string | null) => void, fail!: (e: unknown) => void, exit!: () => void;
  const child: ProbeChild = {
    answer: new Promise((res, rej) => { answer = res; fail = rej; }),
    exited: new Promise((res) => { exit = res; }),
    kill: vi.fn(),
  };
  child.answer.catch(() => {});
  return { child, answer, fail, exit };
}
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
const tick = () => vi.advanceTimersByTimeAsync(0);

describe("spawnWhich (the real which, as a child)", () => {
  it("answers which's path for a binary every host has, and null for one that is absent", async () => {
    const { execFileSync } = await import("node:child_process");
    const viaSync = execFileSync("which", ["sh"], { encoding: "utf-8" }).trim();
    const sh = spawnWhich("sh");
    expect(await sh.answer).toBe(viaSync);
    await sh.exited;
    expect(await spawnWhich("agend-no-such-binary-1490").answer).toBeNull();
  });

  it("rejects when the probe command cannot start, and still reports it as exited", async () => {
    const child = spawnProbeCommand("/nonexistent/agend-probe-1490", []);
    await expect(child.answer).rejects.toThrow();
    await child.exited;
  });
});

describe("BinaryProbe: cache, sharing, freshness", () => {
  let children: ReturnType<typeof fakeChild>[] = [];
  const make = () => new BinaryProbe(() => { const c = fakeChild(); children.push(c); return c.child; });
  beforeEach(() => { children = []; fakeTimers(); });
  afterEach(() => { for (const c of children) c.exit(); vi.useRealTimers(); });

  it("reuses a known answer until the TTL passes, then probes again", async () => {
    const probe = make();
    const first = probe.probe("codex");
    await tick();
    children[0].answer("/bin/codex"); children[0].exit();
    expect(await first).toEqual({ known: true, path: "/bin/codex" });

    await vi.advanceTimersByTimeAsync(BINARY_PROBE_TTL_MS - 1);
    expect(await probe.probe("codex")).toEqual({ known: true, path: "/bin/codex" });
    expect(children.length, "inside the TTL: no probe").toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    void probe.probe("codex");
    await tick();
    expect(children.length, "TTL over: one probe").toBe(2);
  });

  it("shares one probe between concurrent callers of one binary, not across binaries", async () => {
    const probe = make();
    const got: unknown[] = [];
    const all = [probe.probe("codex"), probe.probe("codex"), probe.probe("grok")];
    all.forEach((p, i) => void p.then((r) => { got[i] = r; }));
    await tick();
    expect(children.length).toBe(2);
    children[0].answer("/bin/codex"); children[1].answer(null);   // neither process has exited yet
    await tick();
    expect(got, "both codex callers answered by the one probe").toEqual([
      { known: true, path: "/bin/codex" }, { known: true, path: "/bin/codex" }, { known: true, path: null }]);
  });

  it("a fresh probe skips the cached answer, waits out the previous child, and its answer is the one kept", async () => {
    const probe = make();
    const cached = probe.probe("codex");
    await tick();
    children[0].answer(null); children[0].exit();
    expect(await cached).toEqual({ known: true, path: null });

    const older = probe.probe("codex", { fresh: true });
    await tick();
    expect(children.length, "fresh skips the cached null").toBe(2);
    const fresh = probe.probe("codex", { fresh: true });
    await tick();
    expect(children.length, "one child per binary: the second fresh waits for the first to exit").toBe(2);

    children[1].answer(null);                    // the older lookup, started before the install finished
    expect(await older).toEqual({ known: true, path: null });
    children[1].exit();
    await tick();
    expect(children.length, "then the fresh one starts its own").toBe(3);
    children[2].answer("/bin/codex"); children[2].exit();
    expect(await fresh).toEqual({ known: true, path: "/bin/codex" });
    expect(await probe.probe("codex"), "the newest answer is cached").toEqual({ known: true, path: "/bin/codex" });
    expect(children.length).toBe(3);
  });

  it("an older probe answering after a newer one does not overwrite the newer answer", async () => {
    const probe = make();
    const older = probe.probe("codex");
    await tick();
    children[0].answer(null);                    // answered, but its process has not exited yet
    expect(await older).toEqual({ known: true, path: null });
    const newer = probe.probe("codex", { fresh: true });
    children[0].exit();
    await tick();
    children[1].answer("/bin/codex"); children[1].exit();
    expect(await newer).toEqual({ known: true, path: "/bin/codex" });
    expect(await probe.probe("codex")).toEqual({ known: true, path: "/bin/codex" });
  });

  it("an answer arriving after invalidate() is not stored", async () => {
    const probe = make();
    const before = probe.probe("codex");
    await tick();
    probe.invalidate();
    children[0].answer(null); children[0].exit();
    expect(await before).toEqual({ known: true, path: null });
    void probe.probe("codex");
    await tick();
    expect(children.length, "nothing cached from the invalidated probe").toBe(2);
  });

  it("a probe that cannot start answers unknown, and unknown is not cached", async () => {
    const probe = make();
    const first = probe.probe("codex");
    await tick();
    children[0].fail(new Error("ENOENT")); children[0].exit();
    expect(await first).toEqual({ known: false });
    void probe.probe("codex");
    await tick();
    expect(children.length).toBe(2);
  });
});

describe("BinaryProbe: a lookup that hangs (#1498 review)", () => {
  let children: ReturnType<typeof fakeChild>[] = [];
  const make = (max?: number) => new BinaryProbe(() => { const c = fakeChild(); children.push(c); return c.child; },
    undefined, undefined, undefined, max);
  beforeEach(() => { children = []; fakeTimers(); });
  afterEach(() => { for (const c of children) c.exit(); vi.useRealTimers(); });

  it("answers unknown at the deadline and kills the child, which still counts until it exits", async () => {
    const probe = make();
    let settled: unknown;
    void probe.probe("codex").then((r) => { settled = r; });
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS - 1);
    expect(settled, "not before the deadline").toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual({ known: false });
    expect(children[0].child.kill).toHaveBeenCalled();
    expect(probe.runningCount, "killed is not exited").toBe(1);
    children[0].exit();
    await tick();
    expect(probe.runningCount).toBe(0);
  });

  it("twenty fresh probes while it is stuck start no second child, and all answer by the deadline", async () => {
    const probe = make();
    void probe.probe("codex", { fresh: true });
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS);
    const answers = Array.from({ length: 20 }, () => probe.probe("codex", { fresh: true }));
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS);
    expect(await Promise.all(answers)).toEqual(Array(20).fill({ known: false }));
    expect(children.length, "one stuck child, not twenty-one").toBe(1);

    const waiting = [probe.probe("codex", { fresh: true }), probe.probe("codex", { fresh: true })];
    await tick();
    children[0].exit();                          // it finally goes away, inside their deadline
    await tick();
    expect(children.length, "two fresh probes waiting on it start one child between them").toBe(2);
    children[1].answer("/bin/codex"); children[1].exit();
    expect(await Promise.all(waiting), "and both get its answer").toEqual([
      { known: true, path: "/bin/codex" }, { known: true, path: "/bin/codex" }]);
    const next = probe.probe("codex", { fresh: true });
    await tick();
    expect(children.length).toBe(3);
    children[2].answer("/bin/codex");
    expect(await next).toEqual({ known: true, path: "/bin/codex" });
  });

  it("caps stuck children across binaries: past the limit a probe answers unknown at once", async () => {
    const probe = make(3);
    for (const b of ["a", "b", "c"]) void probe.probe(b);
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS);
    expect(probe.runningCount).toBe(3);
    let settled: unknown;
    void probe.probe("d").then((r) => { settled = r; });
    await tick();
    expect(settled).toEqual({ known: false });
    expect(children.length, "no fourth process").toBe(3);
  });
});

describe("a real stuck probe process (#1498 review)", () => {
  it("answers by the deadline, leaves unrelated async fs work running, and is reclaimed when killed", async () => {
    const probe = new BinaryProbe(() => spawnProbeCommand("sleep", ["30"]), undefined, undefined, 200);
    const dir = tempDir();
    writeFileSync(join(dir, "data"), "still served");
    const started = performance.now();
    const answers = await Promise.all(["a", "b", "c", "d", "e", "f", "g"].map((b) => probe.probe(b)));
    expect(answers.every((a) => !a.known)).toBe(true);
    expect(performance.now() - started, "answered by the deadline, not after 30 s").toBeLessThan(5_000);
    expect(await readFile(join(dir, "data"), "utf8"), "the fs pool is not held by stuck lookups").toBe("still served");
    for (let i = 0; i < 100 && probe.runningCount > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(probe.runningCount, "SIGKILL reclaimed every child").toBe(0);
  });
});

/** A child that never answers and never exits until released: a dead PATH mount, as `spawn` would return it. */
const stuck: EventEmitter[] = [];
function hangingSpawn() {
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242, stdout: Object.assign(new EventEmitter(), { setEncoding() {} }), kill: vi.fn(() => true),
  });
  stuck.push(proc);
  return proc;
}
function releaseStuck() { for (const proc of stuck.splice(0)) proc.emit("close", null); }

describe("GET /ui/backends (#1490)", () => {
  const token = "b".repeat(48);
  let savedPath: string | undefined;
  beforeEach(() => { savedPath = process.env.PATH; hooks.sync = []; hooks.spawned = 0; hooks.spawn = null; binaryProbe.invalidate(); });
  afterEach(async () => {
    process.env.PATH = savedPath; hooks.spawn = null;
    releaseStuck();
    vi.useRealTimers();
    // The shared probe outlives a test: start the next one with no child still running.
    for (let i = 0; i < 200 && binaryProbe.runningCount > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(binaryProbe.runningCount).toBe(0);
    binaryProbe.invalidate();
  });

  function get() {
    const req = Object.assign(new EventEmitter(), {
      method: "GET", url: "/ui/backends", headers: { host: "127.0.0.1:19280", "x-agend-token": token },
      destroy: vi.fn(), socket: { destroy: vi.fn() },
    });
    let status = 0, text = "", ended = false;
    const done = new Promise<void>((resolve) => {
      const res = Object.assign(new EventEmitter(), {
        headersSent: false, setHeader() {}, writeHead: (c: number) => { status = c; },
        end: (t = "") => { text = t; ended = true; resolve(); }, write() { return true; },
      });
      const ctx = { webToken: token, logger: { info() {}, debug() {}, warn() {}, error() {} } } as any;
      expect(handleWebRequest(req as any, res as any, new URL("http://127.0.0.1:19280/ui/backends"), ctx)).toBe(true);
    });
    return { endedSynchronously: ended, done: done.then(() => ({ status, body: JSON.parse(text) })), isEnded: () => ended };
  }
  const entry = (body: any, name: string) => body.backends.find((b: { name: string }) => b.name === name);

  it("answers from asynchronous which children, with no synchronous child process and no blocked handler", async () => {
    const bin = tempDir();
    const codex = file(bin, "codex", 0o755);
    file(bin, "grok", 0o644);
    process.env.PATH = `${bin}:/usr/bin:/bin`;

    const call = get();
    expect(call.endedSynchronously, "the handler returned before the answer").toBe(false);
    const { status, body } = await call.done;
    expect(status).toBe(200);
    expect(entry(body, "codex")).toMatchObject({ binary: "codex", installed: true, path: codex });
    expect(entry(body, "grok")).toMatchObject({ installed: false, path: "" });
    expect(entry(body, "claude-code")).toMatchObject({ binary: "claude" });
    expect(body.backends.map((b: { name: string }) => b.name).sort())
      .toEqual(["antigravity", "claude-code", "codex", "grok", "kiro-cli", "muse", "opencode"]);
    expect(body.backends.some((b: { unknown?: boolean }) => b.unknown), "every lookup answered").toBe(false);
    expect(hooks.sync, "no synchronous which").toEqual([]);
  });

  it("reuses the answer on the next poll, so an install shows after the TTL or a fresh probe", async () => {
    const bin = tempDir();
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect(entry((await get().done).body, "codex").installed).toBe(false);
    await new Promise((r) => setTimeout(r, 50));       // let the children exit
    const spawnedBefore = hooks.spawned;

    file(bin, "codex", 0o755);
    expect(entry((await get().done).body, "codex").installed, "cached").toBe(false);
    expect(hooks.spawned, "a poll inside the TTL starts nothing").toBe(spawnedBefore);
    await binaryProbe.probe("codex", { fresh: true });   // what /login's probe does after an install
    expect(entry((await get().done).body, "codex").installed).toBe(true);
  });

  it("still answers, by the deadline, when every lookup hangs; a poll meanwhile starts no new process", async () => {
    fakeTimers();
    hooks.spawn = hangingSpawn;
    const call = get();
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS - 1);
    expect(call.isEnded(), "not before the deadline").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const { status, body } = await call.done;
    expect(status).toBe(200);
    expect(body.backends.every((b: { installed: boolean; unknown?: boolean }) => !b.installed && b.unknown)).toBe(true);
    expect(hooks.spawned).toBe(7);

    const again = get();
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS);
    const second = await again.done;
    expect(second.body.backends.every((b: { unknown?: boolean }) => b.unknown), "stuck children are not re-run").toBe(true);
    expect(hooks.spawned, "seven stuck children, not fourteen").toBe(7);
  });
});

describe("/login's installed-backend probe (#1490)", () => {
  let savedPath: string | undefined;
  beforeEach(() => { savedPath = process.env.PATH; hooks.sync = []; hooks.spawn = null; binaryProbe.invalidate(); });
  afterEach(async () => {
    process.env.PATH = savedPath; hooks.spawn = null;
    releaseStuck();
    vi.useRealTimers();
    // The shared probe outlives a test: start the next one with no child still running.
    for (let i = 0; i < 200 && binaryProbe.runningCount > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(binaryProbe.runningCount).toBe(0);
    binaryProbe.invalidate();
  });
  const fleet = async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    return new FleetManager(tempDir()) as unknown as { probeInstalledBackends(): Promise<Set<string>> };
  };

  it("sees a binary installed a moment ago although the shared cache still says absent", async () => {
    const fm = await fleet();
    const bin = tempDir();
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect(await binaryProbe.probe("codex"), "cached: absent").toEqual({ known: true, path: null });
    await new Promise((r) => setTimeout(r, 50));       // let that child exit

    file(bin, "codex", 0o755);                  // what /login's install just did
    expect([...await fm.probeInstalledBackends()]).toContain("codex");
    expect(await binaryProbe.probe("codex"), "and the route's cache now agrees").toEqual({ known: true, path: join(bin, "codex") });
    expect(hooks.sync).toEqual([]);
  });

  it("completes by the deadline when every lookup hangs, offering nothing as installed", async () => {
    const fm = await fleet();
    fakeTimers();
    hooks.spawn = hangingSpawn;
    let installed: Set<string> | undefined;
    void fm.probeInstalledBackends().then((s) => { installed = s; });
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS);
    expect(installed).toEqual(new Set());
  });
});
