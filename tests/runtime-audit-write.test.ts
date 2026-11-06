import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let mode: "real" | "short" | "zero" | "shortThenZero" = "real"; let calls = 0;
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, writeSync: ((fd: number, buffer: any, offset?: number, length?: number) => {
    if (typeof buffer === "string" || mode === "real" || fd < 0) return (original.writeSync as any)(fd, buffer, offset, length);
    calls++;
    if (mode === "zero" || (mode === "shortThenZero" && calls > 2)) return 0;
    const part = Math.min(3, length ?? buffer.byteLength);                              // a short write: only three bytes go out
    return (original.writeSync as any)(fd, buffer, offset, part);
  }) as typeof original.writeSync };
});
const { appendAudit, AUDIT_FILE } = await import("../src/runtime-remote-setup.js");
const directories: string[] = [];
afterEach(() => { mode = "real"; calls = 0; for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });
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
