import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let mode: "real" | "short" | "zero" | "shortThenZero" = "real"; let calls = 0; let truncateFails = false;
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  // What Windows does (libuv): a handle opened for append has no right to truncate. The same rule is applied here so that a design that truncates through its append handle fails on any system.
  const flagsOf = new Map<number, number>();
  return { ...original, openSync: ((path: any, flags?: any, mode?: any) => { const fd = (original.openSync as any)(path, flags, mode); if (typeof flags === "number") flagsOf.set(fd, flags); return fd; }) as typeof original.openSync, closeSync: ((fd: number) => { flagsOf.delete(fd); return original.closeSync(fd); }) as typeof original.closeSync, writeSync: ((fd: number, buffer: any, offset?: number, length?: number) => {
    if (typeof buffer === "string" || mode === "real" || fd < 0) return (original.writeSync as any)(fd, buffer, offset, length);
    calls++;
    if (mode === "zero" || (mode === "shortThenZero" && calls > 2)) return 0;
    const part = Math.min(3, length ?? buffer.byteLength);                              // a short write: only three bytes go out
    return (original.writeSync as any)(fd, buffer, offset, part);
  }) as typeof original.writeSync, ftruncateSync: ((fd: number, length?: number) => { if ((flagsOf.get(fd) ?? 0) & original.constants.O_APPEND) throw Object.assign(new Error("EPERM: an append-only handle cannot truncate (Windows)"), { code: "EPERM" }); if (truncateFails) throw Object.assign(new Error("EPERM simulated"), { code: "EPERM" }); return original.ftruncateSync(fd, length); }) as typeof original.ftruncateSync };
});
const { appendAudit, AUDIT_FILE } = await import("../src/runtime-remote-setup.js");
const directories: string[] = [];
afterEach(() => { mode = "real"; calls = 0; truncateFails = false; for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });
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
