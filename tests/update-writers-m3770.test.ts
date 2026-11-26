// M-3770 slice 2.3 (design update-transaction §4.4): the writers-gone proof — what counts as a writer, the exact exempt
// set (updater, runner, recorded helpers whose ancestry reaches them), and that an incomplete scan is never proof. The
// last block runs the real /proc scanner against child processes.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { procWritersDeps, proveWritersGone, type Exempt, type WritersDeps } from "../src/update-writers.js";

const dirs: string[] = [];
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) { try { k.stdin?.end(); k.kill(); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const home = () => { const d = mkdtempSync(join(tmpdir(), "writers-")); dirs.push(d); return d; };
const START = { processStart: "s" };

interface FakeProc { uid?: number | "gone" | null; env?: string | undefined | "gone" | null; cwd?: string | "gone" | null; files?: string[] | "gone" | null; ppid?: number; start?: string; sealed?: boolean }
function fake(h: string, procs: Record<number, FakeProc>, over: Partial<WritersDeps> = {}): WritersDeps {
  const p = (pid: number) => procs[pid] ?? {};
  return {
    listPids: () => Object.keys(procs).map(Number),
    uidOf: pid => (p(pid).uid === undefined ? 1000 : p(pid).uid!),
    agendHomeOf: pid => ("env" in p(pid) ? p(pid).env : undefined),
    cwdOf: pid => (p(pid).cwd === undefined ? "/tmp" : p(pid).cwd!),
    filesOf: pid => (p(pid).files === undefined ? [] : p(pid).files!),
    ppidOf: pid => p(pid).ppid ?? 1,
    sealed: pid => p(pid).sealed === true,
    sameProcess: (pid, start) => (p(pid).start ?? "s") === start.processStart,
    uid: 1000, platform: "linux", ...over,
  };
}
const exempt = (over: Partial<Exempt> = {}): Exempt => ({ updater: { pid: 10, start: START }, runner: null, helpers: [], ...over });

describe("M-3770 §4.4: what counts as a writer", () => {
  it("AGEND_HOME equal to this home, a cwd under it, or a scope file open or mapped; an excluded file alone doesn't count", () => {
    const h = home();
    mkdirSync(join(h, "instances")); writeFileSync(join(h, "fleet.yaml"), ""); writeFileSync(join(h, "fleet.log"), "");
    const res = proveWritersGone(h, exempt(), fake(h, {
      10: { env: h, cwd: h },                                                                        // the updater: exempt
      20: { env: h },
      21: { cwd: join(h, "instances") },
      22: { files: [join(h, "fleet.yaml")] },
      23: { files: [join(h, "fleet.log"), "/usr/lib/libc.so"] },                                     // excluded + outside: not a writer
      24: { env: "/other/home", cwd: "/tmp" },
      25: { uid: 1001, env: h },                                                                     // another user's: not this proof's
    }));
    expect(res).toMatchObject({ ok: false, incomplete: false });
    expect(res.ok ? [] : "writers" in res ? res.writers.map(w => w.pid) : []).toEqual([20, 21, 22]);
  });

  it("nobody left: proven", () => {
    const h = home();
    expect(proveWritersGone(h, exempt(), fake(h, { 10: { env: h }, 30: { cwd: "/tmp" } }))).toEqual({ ok: true });
  });
});

describe("M-3770 §4.4: the exempt set is exactly the updater, the runner, and their recorded helpers", () => {
  it("a helper is exempt only when recorded with its start and its ancestry (each step recorded) reaches the updater or the runner", () => {
    const h = home();
    const helpers = [{ pid: 40, start: START }, { pid: 41, start: START }, { pid: 42, start: { processStart: "other" } }, { pid: 44, start: START }];
    const procs: Record<number, FakeProc> = {
      10: { env: h }, 11: { env: h },
      40: { env: h, ppid: 10 },                         // child of the updater: exempt
      41: { env: h, ppid: 40 },                         // grandchild through a recorded helper: exempt
      42: { env: h, ppid: 10 },                         // recorded, but its start differs (pid reused): a writer
      43: { env: h, ppid: 10 },                         // the updater's child, not recorded: a writer
      44: { env: h, ppid: 43 },                         // recorded, but through an unrecorded parent: a writer
      45: { env: h, ppid: 11 },                         // the runner's child, not recorded: a writer
      46: { env: h, start: "different" },               // claims the updater's pid? no — another pid with env: a writer
    };
    const res = proveWritersGone(h, exempt({ runner: { pid: 11, start: START }, helpers }), fake(h, procs));
    expect(res.ok ? [] : "writers" in res ? res.writers.map(w => w.pid) : []).toEqual([42, 43, 44, 45, 46]);
  });

  it("the updater's pid with another start (a reused pid) is not exempt", () => {
    const h = home();
    expect(proveWritersGone(h, exempt(), fake(h, { 10: { env: h, start: "reused" } }))).toMatchObject({ ok: false, incomplete: false, writers: [{ pid: 10 }] });
  });
});

describe("M-3770 §4.4: an incomplete scan is never proof", () => {
  it("a failed listing, an unreadable owner, or an unreadable process of this user: incomplete; a process that exited mid-scan is gone", () => {
    const h = home();
    expect(proveWritersGone(h, exempt(), fake(h, {}, { listPids: () => null }))).toMatchObject({ ok: false, incomplete: true });
    expect(proveWritersGone(h, exempt(), fake(h, { 50: { uid: null } }))).toMatchObject({ ok: false, incomplete: true, reason: expect.stringMatching(/pid 50's owner/) });
    for (const k of ["env", "cwd", "files"] as const) {
      expect(proveWritersGone(h, exempt(), fake(h, { 51: { [k]: null } })), k).toMatchObject({ ok: false, incomplete: true, reason: expect.stringMatching(/pid 51/) });
    }
    expect(proveWritersGone(h, exempt(), fake(h, { 52: { uid: "gone" }, 53: { files: "gone", env: h } }))).toEqual({ ok: true });
    expect(proveWritersGone(h, exempt(), fake(h, {}, { platform: "darwin" }))).toMatchObject({ ok: false, incomplete: true, reason: expect.stringMatching(/darwin/) });
  });

  it("a sealed (non-dumpable) process of this user is reported as uninspectable, not a gap; an unsealed unreadable one still is (design rev 10)", () => {
    const h = home();
    expect(proveWritersGone(h, exempt(), fake(h, { 60: { sealed: true, env: null, cwd: null, files: null } }))).toEqual({ ok: true, uninspectable: [60] });
    expect(proveWritersGone(h, exempt(), fake(h, { 60: { sealed: false, env: null } }))).toMatchObject({ ok: false, incomplete: true });
    // A sealed process never hides a writer beside it.
    expect(proveWritersGone(h, exempt(), fake(h, { 60: { sealed: true }, 61: { env: h } }))).toMatchObject({ ok: false, incomplete: false, writers: [{ pid: 61 }] });
  });
});

describe.runIf(process.platform === "linux")("M-3770 §4.4: the real /proc scanner", () => {
  const admission = require(join(process.cwd(), "launcher", "install-admission.cjs")) as { processStart(pid: number): string | null };
  const deps = () => procWritersDeps((pid, start) => admission.processStart(pid) === start.processStart);
  const self = (): Exempt => ({ updater: { pid: process.pid, start: { processStart: admission.processStart(process.pid)! } }, runner: null, helpers: [] });
  /** A child that holds until its stdin closes; `ready` resolves once it has set itself up. */
  const child = (code: string, opts: { cwd?: string; env?: Record<string, string> } = {}) => {
    const k = spawn(process.execPath, ["-e", `${code}; process.stdout.write("ready\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`],
      { cwd: opts.cwd, env: { PATH: process.env.PATH ?? "", ...opts.env }, stdio: ["pipe", "pipe", "inherit"] });
    kids.push(k);
    return new Promise<ChildProcess>(r => k.stdout!.once("data", () => r(k)));
  };
  const stop = (k: ChildProcess) => new Promise<void>(r => { k.once("exit", () => r()); k.stdin!.end(); });

  it("finds a child by AGEND_HOME, by cwd, and by an open scope file; not by an open excluded file; proves it gone once it exits", async () => {
    const h = home();
    writeFileSync(join(h, "fleet.yaml"), "x"); writeFileSync(join(h, "fleet.log"), "x");
    const byEnv = await child("", { env: { AGEND_HOME: h } });
    const byCwd = await child("", { cwd: h });
    const byFile = await child(`require("fs").openSync(${JSON.stringify(join(h, "fleet.yaml"))}, "r")`);
    const byLog = await child(`require("fs").openSync(${JSON.stringify(join(h, "fleet.log"))}, "r")`);
    const res = proveWritersGone(h, self(), deps());
    const pids = res.ok ? [] : "writers" in res ? res.writers.map(w => w.pid) : [];
    expect(pids).toEqual(expect.arrayContaining([byEnv.pid, byCwd.pid, byFile.pid]));
    expect(pids).not.toContain(byLog.pid);
    expect(pids).not.toContain(process.pid);                                                          // the updater: exempt
    for (const k of [byEnv, byCwd, byFile, byLog]) await stop(k);
    expect(proveWritersGone(h, self(), deps())).toMatchObject({ ok: true });
  }, 30_000);
});
