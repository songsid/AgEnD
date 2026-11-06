import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mode: "real" | "short" | "zero" | "shortThenZero" = "real"; let calls = 0; let truncateFails = false;
// A writer that runs in the middle of another one, at a place the test names. `wait`: after the 25 ms look at an incomplete tail; `failedWrite`: after a write
// failed (in both, `fstats` says after which fstat of the first writer the hook runs: 1 is the size check of its snapshot, 2 is the last look of the snapshot, right
// before the cut); `truncate`: at the call that cuts; `lockRead`: after the `nth` read of the lock file by the first writer. The hook runs once, and synchronously,
// while the first writer is paused, and the first writer goes on with the answer it had (stale by then): what it looks at next is what has to notice.
let hook: { on: "wait" | "failedWrite" | "truncate" | "lockRead" | "unlink"; run: () => void; fstats?: number; nth?: number; seen?: number; file?: "lock" | "reclaim" } | null = null; let armed = false; let inHook = false; let fstatsLeft = 0;
// `lockRead` counts the first writer's reads of `audit.lock` (or of `audit.lock.reclaim`, with `file: "reclaim"`); `unlink` runs right after `audit.lock` is unlinked.
// `renameFails`: a rename onto `audit.lock` fails (as it can where a rename cannot replace a file that is in use). `unlinked` lists every path that was unlinked.
let renameFails = false; const unlinked: string[] = [];
const fireHook = (): void => { const current = hook; if (!current || inHook) return; hook = null; inHook = true; try { current.run(); } finally { inHook = false; } };
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  // What Windows does (libuv): a handle opened for append has no right to truncate. The same rule is applied here so that a design that truncates through its append handle fails on any system.
  const flagsOf = new Map<number, number>();
  return { ...original, openSync: ((path: any, flags?: any, mode?: any) => { const fd = (original.openSync as any)(path, flags, mode); if (typeof flags === "number") flagsOf.set(fd, flags); return fd; }) as typeof original.openSync, closeSync: ((fd: number) => { flagsOf.delete(fd); return original.closeSync(fd); }) as typeof original.closeSync, writeSync: ((fd: number, buffer: any, offset?: number, length?: number) => {
    if (typeof buffer === "string" || mode === "real" || fd < 0) return (original.writeSync as any)(fd, buffer, offset, length);
    calls++;
    if (mode === "zero" || (mode === "shortThenZero" && calls > 2)) { if (hook?.on === "failedWrite" && !inHook) { armed = true; fstatsLeft = hook.fstats ?? 1; } return 0; }
    const part = Math.min(3, length ?? buffer.byteLength);                              // a short write: only three bytes go out
    return (original.writeSync as any)(fd, buffer, offset, part);
  }) as typeof original.writeSync, fstatSync: ((fd: number, options?: any) => { const result = (original.fstatSync as any)(fd, options); if (armed && !inHook && --fstatsLeft <= 0) { armed = false; fireHook(); } return result; }) as typeof original.fstatSync, readFileSync: ((path: any, options?: any) => { const result = (original.readFileSync as any)(path, options); if (hook?.on === "lockRead" && !inHook && String(path).endsWith(hook.file === "reclaim" ? "audit.lock.reclaim" : "audit.lock") && (hook.seen = (hook.seen ?? 0) + 1) === (hook.nth ?? 1)) fireHook(); return result; }) as typeof original.readFileSync,
    renameSync: ((from: any, to: any) => { if (renameFails && String(to).endsWith("audit.lock")) throw Object.assign(new Error("EPERM simulated"), { code: "EPERM" }); return (original.renameSync as any)(from, to); }) as typeof original.renameSync,
    unlinkSync: ((path: any) => { const result = (original.unlinkSync as any)(path); unlinked.push(String(path)); if (hook?.on === "unlink" && !inHook && String(path).endsWith("audit.lock")) fireHook(); return result; }) as typeof original.unlinkSync, ftruncateSync: ((fd: number, length?: number) => { if (hook?.on === "truncate" && !inHook) fireHook(); if ((flagsOf.get(fd) ?? 0) & original.constants.O_APPEND) throw Object.assign(new Error("EPERM: an append-only handle cannot truncate (Windows)"), { code: "EPERM" }); if (truncateFails) throw Object.assign(new Error("EPERM simulated"), { code: "EPERM" }); return original.ftruncateSync(fd, length); }) as typeof original.ftruncateSync };
});
const { appendAudit, AUDIT_FILE, AUDIT_LOCK_FILE, auditLockTiming } = await import("../src/runtime-remote-setup.js");
const realWait = Atomics.wait.bind(Atomics);
beforeEach(() => { vi.spyOn(Atomics, "wait").mockImplementation(((...args: Parameters<typeof Atomics.wait>) => { if (hook?.on === "wait" && !inHook) { armed = true; fstatsLeft = hook.fstats ?? 1; } return realWait(...args); }) as typeof Atomics.wait); });
const directories: string[] = [];
afterEach(() => { mode = "real"; calls = 0; truncateFails = false; hook = null; armed = false; inHook = false; fstatsLeft = 0; renameFails = false; unlinked.length = 0; vi.restoreAllMocks(); auditLockTiming.waitMs = 3_000; for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });
const dir = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-audit-write-")); directories.push(path); return path; };
const entry = { actor: "admin:u1", action: "profile.remove" as const, outcome: "ok" as const, cli: "claude-code", profile: "work" };

describe("an audit record is whole or it is an error", () => {
  it("writes the whole line, however the system splits the write (three bytes at a time)", () => {
    const d = dir(); mode = "short"; appendAudit(d, entry); mode = "real";
    const text = readFileSync(join(d, AUDIT_FILE), "utf8"); expect(text.endsWith("\n")).toBe(true); expect(JSON.parse(text)).toMatchObject({ actor: "admin:u1", action: "profile.remove", outcome: "ok", profile: "work" }); expect(calls).toBeGreaterThan(10);
  });
  it("a write that returns zero bytes is an error, never accepted as written", () => {
    const d = dir(); mode = "zero"; expect(() => appendAudit(d, entry)).toThrow(/incomplete/);
  });
  it("a write that stops part-way (a few bytes, then nothing) is an error too", () => {
    const d = dir(); mode = "shortThenZero"; expect(() => appendAudit(d, entry)).toThrow(/incomplete/);
  });
});

const lines = (d: string): string[] => readFileSync(join(d, AUDIT_FILE), "utf8").split("\n").filter(Boolean);
const allParse = (d: string): void => { for (const line of lines(d)) expect(() => JSON.parse(line), line.slice(0, 60)).not.toThrow(); };
const second = { ...entry, profile: "home" }, third = { ...entry, profile: "third" };

describe("an incomplete audit tail never turns the next record into accepted corrupt JSONL", () => {
  it("a write that fails part-way takes back what it wrote: the log is as it was, and the next record is a clean line", () => {
    const d = dir(); appendAudit(d, entry); const before = readFileSync(join(d, AUDIT_FILE), "utf8");
    mode = "shortThenZero"; expect(() => appendAudit(d, second)).toThrow(/incomplete/); mode = "real";
    expect(readFileSync(join(d, AUDIT_FILE), "utf8")).toBe(before);
    appendAudit(d, third); expect(lines(d)).toHaveLength(2); allParse(d); expect(JSON.parse(lines(d)[1]!)).toMatchObject({ profile: "third" });
  });
  it("when even the cut cannot be made (the partial front stays), the next append repairs the tail first: every line of the log parses, and holds only whole records", () => {
    const d = dir(); appendAudit(d, entry);
    mode = "shortThenZero"; truncateFails = true; expect(() => appendAudit(d, second)).toThrow(/incomplete/); mode = "real"; truncateFails = false;
    expect(readFileSync(join(d, AUDIT_FILE), "utf8").endsWith("\n")).toBe(false);                    // the partial front really is there
    appendAudit(d, third); expect(lines(d)).toHaveLength(2); allParse(d); expect(lines(d).map(line => JSON.parse(line).profile)).toEqual(["work", "third"]);
  });
  it("an incomplete tail left by a crash (the front of one of our own records, no newline) is repaired the same way", () => {
    const d = dir(); appendAudit(d, entry); appendFileSync(join(d, AUDIT_FILE), '{"at":"2026-11-06T12:00:00.000Z","actor":"admin:u1","act');
    appendAudit(d, second); expect(lines(d)).toHaveLength(2); allParse(d); expect(JSON.parse(lines(d)[1]!)).toMatchObject({ profile: "home" });
    const e = dir(); writeFileSync(join(e, AUDIT_FILE), '{"at":"20'); appendAudit(e, entry); expect(lines(e)).toHaveLength(1); allParse(e);   // a front of any length, also the whole file
  });
  it("damage it cannot explain is refused, never repaired by guessing and never appended to: a foreign tail, and a last whole line that is not JSON", () => {
    const a = dir(); appendAudit(a, entry); appendFileSync(join(a, AUDIT_FILE), "garbage without a newline"); const keptA = readFileSync(join(a, AUDIT_FILE), "utf8");
    expect(() => appendAudit(a, second)).toThrow(/unreadable tail/); expect(readFileSync(join(a, AUDIT_FILE), "utf8")).toBe(keptA);
    const b = dir(); appendAudit(b, entry); appendFileSync(join(b, AUDIT_FILE), "not json at all\n"); const keptB = readFileSync(join(b, AUDIT_FILE), "utf8");
    expect(() => appendAudit(b, second)).toThrow(/unreadable last record/); expect(readFileSync(join(b, AUDIT_FILE), "utf8")).toBe(keptB);
    const c = dir(); appendAudit(c, entry); appendFileSync(join(c, AUDIT_FILE), "[1,2]\n"); expect(() => appendAudit(c, second)).toThrow(/unreadable last record/);
  });
  it("a log that ends with whole records, or is new or empty, is appended to as before (and a padded JSON line is still JSON)", () => {
    const d = dir(); appendAudit(d, entry); appendAudit(d, second); appendAudit(d, third); expect(lines(d)).toHaveLength(3); allParse(d);
    const e = dir(); writeFileSync(join(e, AUDIT_FILE), ""); appendAudit(e, entry); expect(lines(e)).toHaveLength(1);
    const f = dir(); writeFileSync(join(f, AUDIT_FILE), `{"padding":1}${" ".repeat(2000)}\n`); appendAudit(f, entry); expect(lines(f)).toHaveLength(2); allParse(f);
  });
});

const lockOf = (d: string): string => join(d, AUDIT_LOCK_FILE);
const textOf = (path: string): string => existsSync(path) ? readFileSync(path, "utf8") : "<missing>";
const profiles = (d: string): string[] => lines(d).map(line => JSON.parse(line).profile);
const incompleteTail = '{"at":"2026-11-06T12:00:00.000Z","actor":"admin:u1","act';
const sleeping = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });

describe("another writer's accepted record is never cut (the cut needs the lock, still owned at the last moment)", () => {
  for (const [place, fstats] of [["at the size check of its snapshot", 1], ["at the last look of its snapshot, right before the cut", 2]] as const) {
    it(`repair: B repairs the tail and commits a record while A's lock is gone (${place}): B's record stays, A refuses (no cut, no write), every line parses`, () => {
      const d = dir(); appendAudit(d, entry); appendFileSync(join(d, AUDIT_FILE), incompleteTail);
      let accepted = false;
      hook = { on: "wait", fstats, run: () => { rmSync(lockOf(d), { force: true }); appendAudit(d, second); accepted = true; } };
      expect(() => appendAudit(d, third)).toThrow(/lock was lost/);
      expect(accepted).toBe(true); expect(hook).toBeNull(); allParse(d);
      expect(profiles(d)).toEqual(["work", "home"]);
    });
    it(`rollback: A's write fails and B has repaired A's partial tail and committed a record while A's lock is gone (${place}): B's record stays, A still fails with its own error, every line parses`, () => {
      const d = dir(); appendAudit(d, entry); mode = "shortThenZero";
      let accepted = false;
      hook = { on: "failedWrite", fstats, run: () => { mode = "real"; rmSync(lockOf(d), { force: true }); appendAudit(d, second); accepted = true; } };
      expect(() => appendAudit(d, third)).toThrow(/incomplete/);
      mode = "real"; expect(accepted).toBe(true); expect(hook).toBeNull(); allParse(d);
      expect(profiles(d)).toEqual(["work", "home"]);
    });
  }
  it("a lock replaced by another live owner right before the cut: nothing is cut and nothing is written (the incomplete tail stays as it was), and the other owner's lock is left alone", () => {
    const d = dir(); appendAudit(d, entry); appendFileSync(join(d, AUDIT_FILE), incompleteTail); const before = readFileSync(join(d, AUDIT_FILE), "utf8");
    const other = sleeping(); const foreign = JSON.stringify({ pid: other.pid, token: "bbbbbbbbbbbbbbbb" });
    try {
      hook = { on: "wait", fstats: 2, run: () => { rmSync(lockOf(d)); writeFileSync(lockOf(d), foreign); } };
      expect(() => appendAudit(d, second)).toThrow(/lock was lost/); expect(hook).toBeNull();
      expect(readFileSync(join(d, AUDIT_FILE), "utf8")).toBe(before); expect(readFileSync(lockOf(d), "utf8")).toBe(foreign);
    } finally { other.kill(); }
  });
  it("the lock keeps a second writer out of the whole of the first one's look, cut and write: it is refused (nothing of it is written), never accepted and then cut", () => {
    auditLockTiming.waitMs = 30;
    const d = dir(); appendAudit(d, entry); appendFileSync(join(d, AUDIT_FILE), incompleteTail);
    let outcome = "not run";
    hook = { on: "truncate", run: () => { try { appendAudit(d, second); outcome = "accepted"; } catch (error) { outcome = (error as Error).message; } } };
    appendAudit(d, third);
    expect(hook).toBeNull(); allParse(d);
    if (outcome === "accepted") expect(profiles(d), "an accepted record is still in the log").toContain("home");
    expect(outcome).toMatch(/busy/); expect(profiles(d)).toEqual(["work", "third"]);
  });
  it("the same during the rollback of a failed write: the second writer is refused, the log is as it was before the failed write", () => {
    auditLockTiming.waitMs = 30;
    const d = dir(); appendAudit(d, entry); const before = readFileSync(join(d, AUDIT_FILE), "utf8"); mode = "shortThenZero";
    let outcome = "not run";
    hook = { on: "truncate", run: () => { const was = mode; mode = "real"; try { appendAudit(d, second); outcome = "accepted"; } catch (error) { outcome = (error as Error).message; } finally { mode = was; } } };
    expect(() => appendAudit(d, third)).toThrow(/incomplete/); mode = "real";
    expect(hook).toBeNull(); if (outcome === "accepted") expect(profiles(d), "an accepted record is still in the log").toContain("home");
    expect(outcome).toMatch(/busy/); expect(readFileSync(join(d, AUDIT_FILE), "utf8")).toBe(before);
  });
});

describe("the audit lock", () => {
  it("is held by this process for the whole write (its pid and a token of its own) and is gone afterwards, also after a failed write", () => {
    const d = dir(); let during: { pid?: number; token?: string } | undefined;
    hook = { on: "truncate", run: () => { expect(existsSync(lockOf(d))).toBe(true); during = JSON.parse(readFileSync(lockOf(d), "utf8")); } };
    appendAudit(d, entry); appendFileSync(join(d, AUDIT_FILE), incompleteTail);
    appendAudit(d, second); expect(during?.pid).toBe(process.pid); expect(during?.token).toMatch(/^[0-9a-f]{16}$/); expect(existsSync(lockOf(d))).toBe(false);
    mode = "zero"; expect(() => appendAudit(d, third)).toThrow(/incomplete/); mode = "real"; expect(existsSync(lockOf(d))).toBe(false);
    expect(() => appendAudit(d, { ...entry, actor: "bad actor" })).toThrow(/closed form/); expect(existsSync(lockOf(d))).toBe(false);
  });
  it("held by a live process: the writer waits, then refuses, and neither repairs, cuts nor appends (fail closed); the other one's lock is left alone", async () => {
    auditLockTiming.waitMs = 60;
    const d = dir(); appendAudit(d, entry); appendFileSync(join(d, AUDIT_FILE), incompleteTail); const before = readFileSync(join(d, AUDIT_FILE), "utf8");
    const other = sleeping(); const foreign = JSON.stringify({ pid: other.pid, token: "aaaaaaaaaaaaaaaa" });
    try {
      writeFileSync(lockOf(d), foreign); const started = Date.now();
      expect(() => appendAudit(d, second)).toThrow(/busy/); expect(Date.now() - started).toBeGreaterThanOrEqual(50);
      expect(readFileSync(join(d, AUDIT_FILE), "utf8")).toBe(before); expect(readFileSync(lockOf(d), "utf8")).toBe(foreign);
    } finally { other.kill(); }
  });
  it("held by a process that is gone: the lock is cleared and taken over", () => {
    const d = dir(); const gone = spawnSync(process.execPath, ["-e", "0"]); expect(gone.pid).toBeGreaterThan(0);
    writeFileSync(lockOf(d), JSON.stringify({ pid: gone.pid, token: "aaaaaaaaaaaaaaaa" }));
    appendAudit(d, entry); expect(lines(d)).toHaveLength(1); expect(existsSync(lockOf(d))).toBe(false);
    writeFileSync(lockOf(d), JSON.stringify({ pid: process.pid, token: "bbbbbbbbbbbbbbbb" }));      // this process's pid, a token it does not hold: left over (a reused pid)
    appendAudit(d, second); expect(lines(d)).toHaveLength(2); expect(existsSync(lockOf(d))).toBe(false);
  });
  it("a lock file with nothing readable in it is never cleared, however old: the writer waits, then refuses, and the file is left as it is for someone to look at; nothing is written", () => {
    auditLockTiming.waitMs = 40; const d = dir(); writeFileSync(lockOf(d), "");
    expect(() => appendAudit(d, entry)).toThrow(/busy/); expect(existsSync(join(d, AUDIT_FILE))).toBe(false);
    const old = new Date(Date.now() - 60_000); utimesSync(lockOf(d), old, old);
    expect(() => appendAudit(d, entry)).toThrow(/busy/);
    expect(textOf(lockOf(d))).toBe(""); expect(existsSync(join(d, AUDIT_FILE))).toBe(false); expect(readdirSync(d)).toEqual([AUDIT_LOCK_FILE]);
  });
  it("is released only if the file is still ours: a lock another process holds by then is not removed", async () => {
    const d = dir(); const other = sleeping(); const foreign = JSON.stringify({ pid: other.pid, token: "aaaaaaaaaaaaaaaa" });
    try {
      appendAudit(d, entry); appendFileSync(join(d, AUDIT_FILE), incompleteTail);
      hook = { on: "truncate", run: () => { expect(existsSync(lockOf(d))).toBe(true); rmSync(lockOf(d)); writeFileSync(lockOf(d), foreign); } };    // ours was cleared as stale and taken over
      expect(() => appendAudit(d, second)).toThrow(/lock was lost/);              // the cut was made while the lock was ours; the write is not, once it is not
      expect(hook).toBeNull(); expect(readFileSync(lockOf(d), "utf8")).toBe(foreign); allParse(d); expect(profiles(d)).toEqual(["work"]);
    } finally { other.kill(); }
  });
  it("a lock that is not a regular file is refused, never followed", () => {
    const d = dir(); mkdirSync(lockOf(d)); expect(() => appendAudit(d, entry)).toThrow(/regular file/);
  });
});

describe("taking over the lock of a process that is gone is exclusive and bound to the very file that was seen", () => {
  const gonePid = (): number => { const gone = spawnSync(process.execPath, ["-e", "0"]); expect(gone.pid).toBeGreaterThan(0); return gone.pid!; };
  const reclaimOf = (d: string): string => join(d, `${AUDIT_LOCK_FILE}.reclaim`);
  it("two reclaimers: A has seen the dead owner's lock and is working under the takeover file; B, which has seen the same lock, cannot take it over or touch it: it is refused, and A completes", () => {
    auditLockTiming.waitMs = 60; const d = dir(); const dead = JSON.stringify({ pid: gonePid(), token: "aaaaaaaaaaaaaaaa" }); writeFileSync(lockOf(d), dead);
    let outcome = "not run", lockDuring = "", takeoverDuring = false;
    hook = { on: "lockRead", nth: 2, run: () => { takeoverDuring = existsSync(reclaimOf(d)); try { appendAudit(d, second); outcome = "accepted"; } catch (error) { outcome = (error as Error).message; } lockDuring = readFileSync(lockOf(d), "utf8"); } };
    appendAudit(d, entry);
    expect(hook).toBeNull(); expect(takeoverDuring, "A holds the exclusive takeover file while it takes over").toBe(true);
    expect(outcome).toMatch(/busy/); expect(lockDuring).toBe(dead); expect(profiles(d)).toEqual(["work"]); expect(readdirSync(d)).toEqual([AUDIT_FILE]);
  });
  it("dead owner → live replacement: A is about to take over; B has taken the dead lock over and holds a live one: A never removes B's lock; A refuses, and the log is not touched", () => {
    auditLockTiming.waitMs = 60; const d = dir(); writeFileSync(lockOf(d), JSON.stringify({ pid: gonePid(), token: "aaaaaaaaaaaaaaaa" }));
    const other = sleeping(); const foreign = JSON.stringify({ pid: other.pid, token: "bbbbbbbbbbbbbbbb" });
    try {
      hook = { on: "lockRead", nth: 2, run: () => { rmSync(lockOf(d)); writeFileSync(lockOf(d), foreign); } };
      expect(() => appendAudit(d, entry)).toThrow(/busy/);
      expect(hook).toBeNull(); expect(readFileSync(lockOf(d), "utf8")).toBe(foreign); expect(existsSync(join(d, AUDIT_FILE))).toBe(false);
      expect(readdirSync(d)).toEqual([AUDIT_LOCK_FILE]);                              // no takeover file and no half-made lock left behind
    } finally { other.kill(); }
  });
  it("a delayed empty-lock creator resumes: the lock was empty and old, and its creator writes its valid owner after the writer has looked at it again and again: the writer refuses, the creator's lock is left intact, the log is not touched", () => {
    auditLockTiming.waitMs = 60; const d = dir(); writeFileSync(lockOf(d), ""); const old = new Date(Date.now() - 60_000); utimesSync(lockOf(d), old, old);
    const other = sleeping(); const owner = JSON.stringify({ pid: other.pid, token: "bbbbbbbbbbbbbbbb" });
    try {
      hook = { on: "lockRead", nth: 3, run: () => { writeFileSync(lockOf(d), owner); } };       // in place: the same file, now with its owner in it
      expect(() => appendAudit(d, entry)).toThrow(/busy/);
      expect(hook).toBeNull(); expect(textOf(lockOf(d))).toBe(owner); expect(existsSync(join(d, AUDIT_FILE))).toBe(false); expect(readdirSync(d)).toEqual([AUDIT_LOCK_FILE]);
    } finally { other.kill(); }
  });
  it("a takeover that another live process has under way is waited for: nothing is taken over, the dead owner's lock is left as it is, and the writer refuses when the wait runs out", () => {
    auditLockTiming.waitMs = 60; const d = dir(); const dead = JSON.stringify({ pid: gonePid(), token: "aaaaaaaaaaaaaaaa" }); writeFileSync(lockOf(d), dead);
    const other = sleeping(); const taking = JSON.stringify({ pid: other.pid, token: "cccccccccccccccc" });
    try {
      writeFileSync(reclaimOf(d), taking);
      expect(() => appendAudit(d, entry)).toThrow(/busy/);
      expect(readFileSync(lockOf(d), "utf8")).toBe(dead); expect(readFileSync(reclaimOf(d), "utf8")).toBe(taking); expect(existsSync(join(d, AUDIT_FILE))).toBe(false);
    } finally { other.kill(); }
  });
  it("two contenders meet an abandoned takeover file: A has read it twice when B (which has cleared it, in the old way) puts a live takeover file of its own there: A never removes it, and refuses; nothing is written", () => {
    auditLockTiming.waitMs = 60; const d = dir(); const dead = JSON.stringify({ pid: gonePid(), token: "aaaaaaaaaaaaaaaa" }); writeFileSync(lockOf(d), dead); writeFileSync(reclaimOf(d), JSON.stringify({ pid: gonePid(), token: "cccccccccccccccc" }));
    const other = sleeping(); const live = JSON.stringify({ pid: other.pid, token: "bbbbbbbbbbbbbbbb" });
    try {
      hook = { on: "lockRead", file: "reclaim", nth: 2, run: () => { rmSync(reclaimOf(d)); writeFileSync(reclaimOf(d), live); } };
      expect(() => appendAudit(d, entry)).toThrow(/busy/);
      expect(hook).toBeNull(); expect(textOf(reclaimOf(d)), "B's takeover file").toBe(live); expect(textOf(lockOf(d))).toBe(dead); expect(existsSync(join(d, AUDIT_FILE))).toBe(false);
      expect(unlinked.filter(path => path.endsWith(AUDIT_LOCK_FILE) || path.endsWith(`${AUDIT_LOCK_FILE}.reclaim`))).toEqual([]);
    } finally { other.kill(); }
  });
  it("two contenders, an abandoned takeover file and a dead owner's lock: neither takes over, clears or writes; both refuse, and both files are left as they were for someone to look at", () => {
    auditLockTiming.waitMs = 60; const d = dir(); const dead = JSON.stringify({ pid: gonePid(), token: "aaaaaaaaaaaaaaaa" }), abandoned = JSON.stringify({ pid: gonePid(), token: "cccccccccccccccc" });
    writeFileSync(lockOf(d), dead); writeFileSync(reclaimOf(d), abandoned);
    let outcome = "not run";
    hook = { on: "lockRead", file: "reclaim", nth: 1, run: () => { try { appendAudit(d, second); outcome = "accepted"; } catch (error) { outcome = (error as Error).message; } } };
    expect(() => appendAudit(d, entry)).toThrow(/busy/);
    expect(hook).toBeNull(); expect(outcome).toMatch(/busy/);
    expect(textOf(lockOf(d))).toBe(dead); expect(textOf(reclaimOf(d))).toBe(abandoned); expect(existsSync(join(d, AUDIT_FILE))).toBe(false);
    expect(unlinked.filter(path => path.endsWith(AUDIT_LOCK_FILE) || path.endsWith(`${AUDIT_LOCK_FILE}.reclaim`))).toEqual([]);
  });
  it("a rename that cannot replace the lock fails the takeover: the lock file is never unlinked, so an acquirer that was already on its way cannot own the path in a gap and be replaced after it", () => {
    auditLockTiming.waitMs = 60; const d = dir(); const dead = JSON.stringify({ pid: gonePid(), token: "aaaaaaaaaaaaaaaa" }); writeFileSync(lockOf(d), dead);
    const other = sleeping(); const owner = JSON.stringify({ pid: other.pid, token: "bbbbbbbbbbbbbbbb" });
    try {
      renameFails = true;
      hook = { on: "unlink", run: () => { writeFileSync(lockOf(d), owner, { flag: "wx" }); } };       // the acquirer that was in flight creates the lock the moment it is gone
      expect(() => appendAudit(d, entry)).toThrow(/busy/);
      expect(unlinked.filter(path => path.endsWith(AUDIT_LOCK_FILE)), "the lock file was unlinked").toEqual([]);
      expect(textOf(lockOf(d))).toBe(dead); expect(existsSync(join(d, AUDIT_FILE))).toBe(false); expect(readdirSync(d)).toEqual([AUDIT_LOCK_FILE]);
    } finally { other.kill(); }
  });
  it("uncontended: a readable lock of a process that is gone is taken over under the takeover file, the incomplete tail is repaired, the record is appended, and no lock, takeover or staging file is left", () => {
    const d = dir(); appendAudit(d, entry); appendFileSync(join(d, AUDIT_FILE), incompleteTail); writeFileSync(lockOf(d), JSON.stringify({ pid: gonePid(), token: "aaaaaaaaaaaaaaaa" }));
    let takeoverFile = false;
    hook = { on: "lockRead", nth: 2, run: () => { takeoverFile = existsSync(reclaimOf(d)); } };
    appendAudit(d, second);
    expect(hook).toBeNull(); expect(takeoverFile).toBe(true); allParse(d); expect(profiles(d)).toEqual(["work", "home"]); expect(readdirSync(d)).toEqual([AUDIT_FILE]);
  });
  it("a takeover file that is not a regular file is refused, never followed", () => {
    const d = dir(); writeFileSync(lockOf(d), JSON.stringify({ pid: gonePid(), token: "aaaaaaaaaaaaaaaa" })); mkdirSync(reclaimOf(d));
    expect(() => appendAudit(d, entry)).toThrow(/regular file/);
  });
});
