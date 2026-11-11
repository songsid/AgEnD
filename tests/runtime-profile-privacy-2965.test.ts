import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, readdirSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const f = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFileSync: f.exec }));
import { RuntimeClientStore } from "../src/runtime-client-store.js";
const homes: string[] = []; const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
function scratch() { const p = mkdtempSync(join(tmpdir(), "agend-profile-privacy-2965-")); homes.push(p); return p; }
beforeEach(() => { f.exec.mockReset(); Object.defineProperty(process, "platform", { value: "win32", configurable: true }); });
afterEach(() => { Object.defineProperty(process, "platform", platform); for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true }); });
it("refuses a shared custom profile before reading its credential or even malformed job JSON", () => {
  const p = scratch(); writeFileSync(join(p, "jobs.json"), "invalid JSON"); writeFileSync(join(p, "unrelated.txt"), "leave me alone"); const mode = statSync(p).mode;
  f.exec.mockImplementation(() => { throw Error("modeled broad ACL"); });
  expect(() => new RuntimeClientStore(p)).toThrow(/profile.*privacy|private.*profile/i);
  expect(f.exec).toHaveBeenCalledOnce(); expect(readFileSync(join(p, "unrelated.txt"), "utf8")).toBe("leave me alone"); expect(statSync(p).mode).toBe(mode);
});
it("a proven private custom profile remains usable with one bounded fixed-script check before state access", () => {
  const p = scratch(), store = new RuntimeClientStore(p);
  store.saveCredentials({ server: "http://127.0.0.1", machineId: "12345678-1234-4234-8234-123456789012", credential: "a".repeat(64), name: "fixture" });
  expect(store.credentials()?.name).toBe("fixture"); expect(f.exec).toHaveBeenCalledOnce();
  const [exe, args, opts] = f.exec.mock.calls[0]!;
  expect(exe).toContain("WindowsPowerShell"); expect(args).toEqual(expect.arrayContaining(["-File", expect.stringContaining("runtime-pane-private.ps1"), "-Directory", p, "-RuntimeProfile"]));
  expect(opts).toMatchObject({ timeout: 30000, windowsHide: true }); expect(opts.shell).not.toBe(true);
});
it("a directory swapped during the privacy check is not used", () => {
  const p = scratch(), old = p + "-old"; homes.push(old); const before = statSync(p);
  f.exec.mockImplementation(() => { renameSync(p, old); mkdirSync(p); });
  expect(() => new RuntimeClientStore(p)).toThrow(/changed|privacy/i); expect(statSync(p).ino).not.toBe(before.ino);
});
it("new directories are created by the Windows ACL gate, before any state file", () => {
  const p = join(scratch(), "new"); f.exec.mockImplementation(() => { expect(existsSync(p)).toBe(false); mkdirSync(p, { mode: 0o700 }); });
  new RuntimeClientStore(p); expect(f.exec).toHaveBeenCalledOnce(); expect(readdirSync(p)).toEqual([]);
});

it("an existing file or symlink is refused before invoking the ACL gate", () => {
  const p = join(scratch(), "file"); writeFileSync(p, "untouched");
  expect(() => new RuntimeClientStore(p)).toThrow(/real directory/i);
  expect(f.exec).not.toHaveBeenCalled(); expect(readFileSync(p, "utf8")).toBe("untouched");
  const link = join(scratch(), "linked"); symlinkSync(scratch(), link, "dir");
  expect(() => new RuntimeClientStore(link)).toThrow(/real directory/i); expect(f.exec).not.toHaveBeenCalled();
});
it("the check cannot expose PowerShell diagnostics or continue when its result is missing", () => {
  const p = scratch(); f.exec.mockImplementation(() => { throw Error("private child diagnostic"); });
  let message = ""; try { new RuntimeClientStore(p); } catch (error) { message = (error as Error).message; }
  expect(message).toMatch(/bounded check|dedicated directory/); expect(message).not.toContain("private child diagnostic");
  f.exec.mockReset(); const absent = join(p, "missing");
  expect(() => new RuntimeClientStore(absent)).toThrow(); expect(existsSync(absent)).toBe(false);
});
