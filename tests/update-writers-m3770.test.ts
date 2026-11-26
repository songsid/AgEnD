// M-3770 slice 2.3 (design update-transaction §4.4): the writers-gone proof — what counts as a writer, the exact exempt
// set (updater, runner, recorded helpers whose ancestry reaches them), and that an incomplete scan is never proof. The
// last block runs the real /proc scanner against child processes.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capsExceed, procWritersDeps, proveWritersGone, type Exempt, type WritersDeps } from "../src/update-writers.js";

const dirs: string[] = [];
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) { try { k.stdin?.end(); k.kill(); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const home = () => { const d = mkdtempSync(join(tmpdir(), "writers-")); dirs.push(d); return d; };
const START = { processStart: "s" };

/** A fake process; `seq` gives, read by read, what env, cwd and files return (then the last entry repeats). */
interface FakeProc { uid?: number | "gone" | null; env?: string | undefined | "gone" | null; cwd?: string | "gone" | null; files?: string[] | "gone" | null; ppid?: number; start?: string; sealed?: boolean; privileged?: boolean;
  seq?: Array<{ env?: string | undefined | "gone" | null; cwd?: string | "gone" | null; files?: string[] | "gone" | null; uid?: number | "gone"; start?: string }> }
function fake(h: string, procs: Record<number, FakeProc>, over: Partial<WritersDeps> = {}): WritersDeps {
  const looks = new Map<number, number>();
  /** The process as the current look sees it: its `seq` entry (advanced by each env read), or its fixed fields. */
  const p = (pid: number): FakeProc => { const f = procs[pid] ?? {}; if (!f.seq) return f; const i = Math.min(looks.get(pid) ?? 0, f.seq.length - 1); return { ...f, ...f.seq[i] }; };
  return {
    listPids: () => Object.keys(procs).map(Number),
    uidOf: pid => (p(pid).uid === undefined ? 1000 : p(pid).uid!),
    agendHomeOf: pid => ("env" in p(pid) ? p(pid).env : undefined),
    cwdOf: pid => (p(pid).cwd === undefined ? "/tmp" : p(pid).cwd!),
    // The last read of a look: it advances a `seq` process to its next state.
    filesOf: pid => { const v = p(pid).files === undefined ? [] : p(pid).files!; if (procs[pid]?.seq) looks.set(pid, (looks.get(pid) ?? 0) + 1); return v; },
    ppidOf: pid => p(pid).ppid ?? 1,
    sealed: pid => (p(pid).sealed === true ? "non-dumpable" : p(pid).privileged === true ? "privileged" : false),
    nameOf: pid => `proc-${pid}`,
    startOf: pid => ({ processStart: p(pid).start ?? "s" }),
    sleep: () => {},
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
    expect(proveWritersGone(h, exempt(), fake(h, { 50: { uid: null } }))).toMatchObject({ ok: false, incomplete: true, reason: expect.stringMatching(/pid 50\b.*owner/) });
    for (const k of ["env", "cwd", "files"] as const) {
      expect(proveWritersGone(h, exempt(), fake(h, { 51: { [k]: null } })), k).toMatchObject({ ok: false, incomplete: true, reason: expect.stringMatching(/pid 51/) });
    }
    expect(proveWritersGone(h, exempt(), fake(h, { 52: { uid: "gone" }, 53: { files: "gone", env: h } }))).toEqual({ ok: true });
    expect(proveWritersGone(h, exempt(), fake(h, {}, { platform: "darwin" }))).toMatchObject({ ok: false, incomplete: true, reason: expect.stringMatching(/darwin/) });
  });

  it("the capability subset rule: a target holding a permitted capability the reader lacks is privileged; a subset isn't", () => {
    const st = (prm: string) => `Name:\tx\nCapInh:\t0000000000000000\nCapPrm:\t${prm}\nCapEff:\t${prm}\n`;
    expect(capsExceed(st("0000000000000400"), st("0000000000000000"))).toBe(true);                    // CAP_NET_BIND_SERVICE
    expect(capsExceed(st("0000000000000000"), st("0000000000000000"))).toBe(false);
    expect(capsExceed(st("0000000000000400"), st("0000000000000c00"))).toBe(false);                   // a subset of the reader's
    expect(capsExceed(st("0000000000001400"), st("0000000000000c00"))).toBe(true);                    // one bit beyond
    expect(capsExceed("Name:\tx\n", st("0000000000000000"))).toBe(false);                            // no line: none
  });

  it("a process unreadable for a moment (mid-exec, mid-exit) is re-read: gone, or readable and clean, is no gap; staying unreadable is (Fable #4524 F1)", () => {
    const h = home();
    let slept = 0;
    const counting = { sleep: () => { slept++; } };
    // Unreadable once, then gone.
    expect(proveWritersGone(h, exempt(), fake(h, { 70: { seq: [{ env: null }, { env: "gone" }] } }, counting))).toEqual({ ok: true });
    // Unreadable once, then readable and clean.
    expect(proveWritersGone(h, exempt(), fake(h, { 71: { seq: [{ cwd: null }, { cwd: "/tmp" }] } }, counting))).toEqual({ ok: true });
    // Unreadable once, then readable — and a writer: found.
    expect(proveWritersGone(h, exempt(), fake(h, { 72: { seq: [{ files: null }, { env: h }] } }, counting))).toMatchObject({ ok: false, incomplete: false, writers: [{ pid: 72 }] });
    // The same process unreadable through every try: incomplete, after exactly the bounded re-reads.
    slept = 0;
    expect(proveWritersGone(h, exempt(), fake(h, { 73: { seq: [{ env: null }] } }, counting))).toMatchObject({ ok: false, incomplete: true, reason: expect.stringMatching(/pid 73 \(proc-73\), this user's, stays unreadable .* through 5 re-reads/) });
    expect(slept).toBe(5);
    // A pid that became a different process (a new start) gets its own tries, a bounded number of times.
    slept = 0;
    const res = proveWritersGone(h, exempt(), fake(h, { 74: { seq: [{ env: null, start: "a" }, { env: null, start: "b" }, { env: null, start: "c" }, { env: null, start: "d" }, { env: null, start: "e" }] } }, counting));
    expect(res).toMatchObject({ ok: false, incomplete: true });
    expect(slept).toBeLessThanOrEqual(5 * 4 + 1);
  });

  it("a pid whose start changes on every look still ends: its renewals are capped", () => {
    const h = home();
    let n = 0, slept = 0;
    const res = proveWritersGone(h, exempt(), fake(h, { 75: { env: null } }, { startOf: () => ({ processStart: `start-${n++}` }), sleep: () => { slept++; } }));
    expect(res).toMatchObject({ ok: false, incomplete: true });
    expect(slept).toBeLessThanOrEqual(5 * 4 + 4);
  }, 5_000);

  it("a sealed (non-dumpable) process of this user is reported as uninspectable, not a gap; an unsealed unreadable one still is (design rev 10)", () => {
    const h = home();
    expect(proveWritersGone(h, exempt(), fake(h, { 60: { sealed: true, env: null, cwd: null, files: null } }))).toEqual({ ok: true, uninspectable: [{ pid: 60, name: "proc-60", why: "non-dumpable" }] });
    // Privileged (capabilities this process lacks; dumpable, its files still ours): uninspectable too (rev 11).
    expect(proveWritersGone(h, exempt(), fake(h, { 62: { privileged: true, env: null } }))).toEqual({ ok: true, uninspectable: [{ pid: 62, name: "proc-62", why: "privileged" }] });
    expect(proveWritersGone(h, exempt(), fake(h, { 60: { sealed: false, env: null } }))).toMatchObject({ ok: false, incomplete: true, reason: expect.stringMatching(/pid 60 \(proc-60\), this user's, stays unreadable/) });
    // A sealed process never hides a writer beside it.
    expect(proveWritersGone(h, exempt(), fake(h, { 60: { sealed: true }, 61: { env: h } }))).toMatchObject({ ok: false, incomplete: false, writers: [{ pid: 61 }] });
  });
});

describe.runIf(process.platform === "linux")("M-3770 §4.4: the real /proc scanner", () => {
  const admission = require(join(process.cwd(), "launcher", "install-admission.cjs")) as { processStart(pid: number): string | null };
  /**
   * The real /proc readers, over this test's own processes only: the whole host's process list varies by machine (a CI
   * runner's own processes can't all be read), and what is under test is how real processes are read and classified.
   */
  const real = () => procWritersDeps((pid, start) => admission.processStart(pid) === start.processStart, pid => admission.processStart(pid));
  const deps = (pids: number[]) => ({ ...real(), listPids: () => [process.pid, ...pids] });
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
    const mine = [byEnv, byCwd, byFile, byLog].map(k => k.pid!);
    const res = proveWritersGone(h, self(), deps(mine));
    expect(res, JSON.stringify(res)).toMatchObject({ ok: false, incomplete: false });
    const pids = res.ok ? [] : "writers" in res ? res.writers.map(w => w.pid) : [];
    expect(pids).toEqual(expect.arrayContaining([byEnv.pid, byCwd.pid, byFile.pid]));
    expect(pids).not.toContain(byLog.pid);
    expect(pids).not.toContain(process.pid);                                                          // the updater: exempt
    for (const k of [byEnv, byCwd, byFile, byLog]) await stop(k);
    expect(proveWritersGone(h, self(), deps(mine))).toEqual({ ok: true });                           // exited: gone
  }, 30_000);

  it("the real sealed check: this process isn't sealed; a capability-holding or non-dumpable one would be (by its status)", () => {
    const d = real();
    expect(d.sealed(process.pid)).toBe(false);
    expect(d.nameOf?.(process.pid)).toMatch(/node|vitest/);
  });

  it("the whole host, under process churn (shells exec-ing short sleeps): never spuriously incomplete (Fable #4524 F1)", async () => {
    const h = home();
    const loops = Array.from({ length: 4 }, () => {
      const k = spawn("/bin/sh", ["-c", "while :; do /bin/sh -c 'exec /bin/sleep 0.01'; done"], { stdio: "ignore" });
      kids.push(k);
      return k;
    });
    await new Promise(r => setTimeout(r, 200));
    try {
      for (let i = 0; i < 40; i++) {
        const res = proveWritersGone(h, self(), real());
        expect(res, `proof ${i}: ${JSON.stringify(res)}`).toMatchObject({ ok: true });
      }
    } finally { for (const k of loops) k.kill("SIGKILL"); }
  }, 60_000);
});
