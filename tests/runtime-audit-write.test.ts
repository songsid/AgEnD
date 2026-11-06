import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mode: "real" | "short" | "zero" | "shortThenZero" = "real"; let calls = 0; let truncateFails = false;
// A writer that runs in the middle of another one, at a place the test names. `wait`: just after the 25 ms look at an incomplete tail; `failedWrite`: just after
// a write failed; `truncate`: at the call that cuts. The hook runs once, and synchronously, while the first writer is paused: its next look at the file (the size
// check that comes right after, or the cut) is the one that has to notice what the second writer did. Whatever the hook sees of the first writer's look is stale.
let hook: { on: "wait" | "failedWrite" | "truncate"; run: () => void } | null = null; let armed = false; let inHook = false;
const fireHook = (): void => { const current = hook; if (!current || inHook) return; hook = null; inHook = true; try { current.run(); } finally { inHook = false; } };
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  // What Windows does (libuv): a handle opened for append has no right to truncate. The same rule is applied here so that a design that truncates through its append handle fails on any system.
  const flagsOf = new Map<number, number>();
  return { ...original, openSync: ((path: any, flags?: any, mode?: any) => { const fd = (original.openSync as any)(path, flags, mode); if (typeof flags === "number") flagsOf.set(fd, flags); return fd; }) as typeof original.openSync, closeSync: ((fd: number) => { flagsOf.delete(fd); return original.closeSync(fd); }) as typeof original.closeSync, writeSync: ((fd: number, buffer: any, offset?: number, length?: number) => {
    if (typeof buffer === "string" || mode === "real" || fd < 0) return (original.writeSync as any)(fd, buffer, offset, length);
    calls++;
    if (mode === "zero" || (mode === "shortThenZero" && calls > 2)) { if (hook?.on === "failedWrite" && !inHook) armed = true; return 0; }
    const part = Math.min(3, length ?? buffer.byteLength);                              // a short write: only three bytes go out
    return (original.writeSync as any)(fd, buffer, offset, part);
  }) as typeof original.writeSync, fstatSync: ((fd: number, options?: any) => { const result = (original.fstatSync as any)(fd, options); if (armed && !inHook) { armed = false; fireHook(); } return result; }) as typeof original.fstatSync, ftruncateSync: ((fd: number, length?: number) => { if (hook?.on === "truncate" && !inHook) fireHook(); if ((flagsOf.get(fd) ?? 0) & original.constants.O_APPEND) throw Object.assign(new Error("EPERM: an append-only handle cannot truncate (Windows)"), { code: "EPERM" }); if (truncateFails) throw Object.assign(new Error("EPERM simulated"), { code: "EPERM" }); return original.ftruncateSync(fd, length); }) as typeof original.ftruncateSync };
});
const { appendAudit, AUDIT_FILE, AUDIT_LOCK_FILE, auditLockTiming } = await import("../src/runtime-remote-setup.js");
const realWait = Atomics.wait.bind(Atomics);
beforeEach(() => { vi.spyOn(Atomics, "wait").mockImplementation(((...args: Parameters<typeof Atomics.wait>) => { if (hook?.on === "wait" && !inHook) armed = true; return realWait(...args); }) as typeof Atomics.wait); });
const directories: string[] = [];
afterEach(() => { mode = "real"; calls = 0; truncateFails = false; hook = null; armed = false; inHook = false; vi.restoreAllMocks(); auditLockTiming.waitMs = 3_000; auditLockTiming.unreadableMs = 10_000; for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });
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
const profiles = (d: string): string[] => lines(d).map(line => JSON.parse(line).profile);
const incompleteTail = '{"at":"2026-11-06T12:00:00.000Z","actor":"admin:u1","act';
const sleeping = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });

describe("another writer's accepted record is never cut (P2: truncation is serialized and re-checked)", () => {
  it("repair: B repairs the tail and commits a record while A, which had already seen the tail unchanged, is about to cut: both records stay and every line parses", () => {
    const d = dir(); appendAudit(d, entry); appendFileSync(join(d, AUDIT_FILE), incompleteTail);
    let accepted = false;
    hook = { on: "wait", run: () => { rmSync(lockOf(d), { force: true }); appendAudit(d, second); accepted = true; } };      // as if A's lock had been cleared as stale
    appendAudit(d, third);
    expect(accepted).toBe(true); expect(hook).toBeNull(); allParse(d);
    expect(profiles(d)).toEqual(["work", "home", "third"]);
  });
  it("rollback: A's write fails, but B has repaired A's partial tail and committed a record: B's record stays, A still fails with its own error, every line parses", () => {
    const d = dir(); appendAudit(d, entry); mode = "shortThenZero";
    let accepted = false;
    hook = { on: "failedWrite", run: () => { mode = "real"; rmSync(lockOf(d), { force: true }); appendAudit(d, second); accepted = true; } };
    expect(() => appendAudit(d, third)).toThrow(/incomplete/);
    mode = "real"; expect(accepted).toBe(true); expect(hook).toBeNull(); allParse(d);
    expect(profiles(d)).toEqual(["work", "home"]);
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
  it("a lock file with nothing readable in it is waited for while it is new (its writer may be filling it), and cleared when it has been there too long", () => {
    auditLockTiming.waitMs = 40; const d = dir(); writeFileSync(lockOf(d), "");
    expect(() => appendAudit(d, entry)).toThrow(/busy/); expect(existsSync(join(d, AUDIT_FILE))).toBe(false);
    const old = new Date(Date.now() - 60_000); utimesSync(lockOf(d), old, old);
    appendAudit(d, entry); expect(lines(d)).toHaveLength(1); expect(existsSync(lockOf(d))).toBe(false);
  });
  it("is released only if the file is still ours: a lock another process holds by then is not removed", async () => {
    const d = dir(); const other = sleeping(); const foreign = JSON.stringify({ pid: other.pid, token: "aaaaaaaaaaaaaaaa" });
    try {
      appendAudit(d, entry); appendFileSync(join(d, AUDIT_FILE), incompleteTail);
      hook = { on: "truncate", run: () => { expect(existsSync(lockOf(d))).toBe(true); rmSync(lockOf(d)); writeFileSync(lockOf(d), foreign); } };    // ours was cleared as stale and taken over
      appendAudit(d, second); expect(hook).toBeNull(); expect(readFileSync(lockOf(d), "utf8")).toBe(foreign); allParse(d);
    } finally { other.kill(); }
  });
  it("a lock that is not a regular file is refused, never followed", () => {
    const d = dir(); mkdirSync(lockOf(d)); expect(() => appendAudit(d, entry)).toThrow(/regular file/);
  });
});
