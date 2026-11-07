import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const real: { append?: (...args: any[]) => void; set?: (...args: any[]) => any } = {};
vi.mock("../src/runtime-remote-setup.js", async importOriginal => { const original = await importOriginal<typeof import("../src/runtime-remote-setup.js")>(); real.append = original.appendAudit; real.set = original.setRemoteSwitch; return { ...original, appendAudit: vi.fn((...args: Parameters<typeof original.appendAudit>) => original.appendAudit(...args)), setRemoteSwitch: vi.fn((...args: Parameters<typeof original.setRemoteSwitch>) => original.setRemoteSwitch(...args)) }; });
const { runtimeMain } = await import("../src/runtime-cli.js");
const setup = await import("../src/runtime-remote-setup.js");

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(setup.appendAudit).mockImplementation((...args) => real.append!(...args)); vi.mocked(setup.setRemoteSwitch).mockImplementation((...args) => real.set!(...args)); for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });
function fixture() {
  const make = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-cli-switch-audit-")); directories.push(path); return path; };
  const home = make(), program = make(), runtimeHome = join(home, ".agend-runtime"), out: string[] = [], err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; }); vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
  return { runtimeHome, out, err, run: (argv: string[]) => runtimeMain(argv, { home, programDirectory: program, env: {} } as never),
    rows: (): Array<Record<string, unknown>> => { try { return readFileSync(join(runtimeHome, "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } } };
}
const summary = (rows: Array<Record<string, unknown>>) => rows.map(row => `${row.switch}:${row.detail}:${row.outcome}${row.until ? ":until" : ""}${row.reason ? `:${row.reason}` : ""}`);

describe("remote-setup records which switch, until when, and what really happened", () => {
  it("accounts on --for 2h: started, then ok, each naming the switch and the end time", async () => {
    const f = fixture(); const before = Date.now(); await f.run(["remote-setup", "accounts", "on", "--for", "2h"]);
    expect(summary(f.rows())).toEqual(["accounts:on:started:until", "accounts:on:ok:until"]);
    const until = Date.parse(String(f.rows()[0]!.until)); expect(until - before).toBeGreaterThanOrEqual(2 * 3_600_000 - 1000); expect(until - before).toBeLessThanOrEqual(2 * 3_600_000 + 5000); expect(f.rows()[1]!.until).toBe(f.rows()[0]!.until);
    expect(f.rows().every(row => row.actor === "local" && row.action === "switch")).toBe(true);
  });
  it("install on and off: the install switch is named, with no end time when none was asked for", async () => {
    const f = fixture(); await f.run(["remote-setup", "install", "on"]); await f.run(["remote-setup", "install", "off"]);
    expect(summary(f.rows())).toEqual(["install:on:started", "install:on:ok", "install:off:ok"]);
    await f.run(["remote-setup", "accounts", "on"]); await f.run(["remote-setup", "accounts", "off"]); expect(summary(f.rows()).slice(3)).toEqual(["accounts:on:started", "accounts:on:ok", "accounts:off:ok"]);
  });
  it("a switch that cannot be set (its file is in the way): on records started and failed, never ok, and the switch is not on", async () => {
    const f = fixture(); mkdirSync(f.runtimeHome, { recursive: true }); mkdirSync(join(f.runtimeHome, "remote-setup.json"));
    await expect(f.run(["remote-setup", "accounts", "on", "--for", "1h"])).rejects.toThrow();
    expect(summary(f.rows())).toEqual(["accounts:on:started:until", "accounts:on:failed:until:failed"]); expect(f.rows().some(row => row.outcome === "ok")).toBe(false);
    expect(setup.readRemoteSwitches(f.runtimeHome).accounts.on).toBe(false); expect(f.out.join("")).not.toMatch(/accounts: on/);
  });
  it("off that cannot be set also records failed (never ok), and throws", async () => {
    const f = fixture(); mkdirSync(f.runtimeHome, { recursive: true }); mkdirSync(join(f.runtimeHome, "remote-setup.json"));
    await expect(f.run(["remote-setup", "accounts", "off"])).rejects.toThrow(); expect(summary(f.rows())).toEqual(["accounts:off:failed:failed"]);
  });
  it("the record of the result cannot be written after the switch was set: the switch is put back off and the command fails, so nothing is on without its record", async () => {
    const f = fixture(); let calls = 0;
    vi.mocked(setup.appendAudit).mockImplementation((...args) => { calls++; if (calls === 2) throw new Error("disk full"); return real.append!(...args); });
    await expect(f.run(["remote-setup", "accounts", "on"])).rejects.toThrow(/turned off again/);
    expect(setup.readRemoteSwitches(f.runtimeHome).accounts.on).toBe(false); expect(summary(f.rows())).toEqual(["accounts:on:started", "accounts:on:failed:failed"]);
  });
  it("the successful rollback is proven by reading the saved switch back, and only then reported as turned off again", async () => {
    const f = fixture(); let calls = 0;
    vi.mocked(setup.appendAudit).mockImplementation((...args) => { calls++; if (calls === 2) throw new Error("disk full"); return real.append!(...args); });
    await expect(f.run(["remote-setup", "accounts", "on"])).rejects.toThrow(/turned off again/);
    expect(setup.readRemoteSwitches(f.runtimeHome).accounts.on).toBe(false); expect(summary(f.rows())).toEqual(["accounts:on:started", "accounts:on:failed:failed"]);
  });
  it("DOUBLE FAILURE: the result record cannot be written and turning the switch back off fails too: the outcome is unconfirmed, never `turned off again`, and the switch really is still on", async () => {
    const f = fixture(); let appends = 0, sets = 0;
    vi.mocked(setup.appendAudit).mockImplementation((...args) => { appends++; if (appends === 2) throw new Error("disk full"); return real.append!(...args); });
    vi.mocked(setup.setRemoteSwitch).mockImplementation((...args) => { sets++; if (sets === 2) throw new Error("EPERM"); return real.set!(...args); });
    const error = await f.run(["remote-setup", "accounts", "on"]).catch((e: Error) => e) as Error;
    expect(error).toBeInstanceOf(Error); expect(error.message).toMatch(/unconfirmed/); expect(error.message).toMatch(/could not be confirmed/); expect(error.message).not.toMatch(/turned off again/);
    expect(error.message).toMatch(/agend-runtime remote-setup accounts off/); expect(setup.readRemoteSwitches(f.runtimeHome).accounts.on).toBe(true);        // what the message warns about is the truth
    expect(summary(f.rows())).toEqual(["accounts:on:started", "accounts:on:failed:unconfirmed"]);
  });
  it("DOUBLE FAILURE, the other way: the rollback writes without error but the file still reads on: also unconfirmed", async () => {
    const f = fixture(); let appends = 0, sets = 0;
    vi.mocked(setup.appendAudit).mockImplementation((...args) => { appends++; if (appends === 2) throw new Error("disk full"); return real.append!(...args); });
    vi.mocked(setup.setRemoteSwitch).mockImplementation((...args) => { sets++; if (sets === 2) return { on: false }; return real.set!(...args); });
    const error = await f.run(["remote-setup", "accounts", "on", "--for", "1h"]).catch((e: Error) => e) as Error;
    expect(error.message).toMatch(/unconfirmed/); expect(error.message).not.toMatch(/turned off again/); expect(setup.readRemoteSwitches(f.runtimeHome).accounts.on).toBe(true);
    expect(summary(f.rows())).toEqual(["accounts:on:started:until", "accounts:on:failed:until:unconfirmed"]);
  });
  it("the record of the attempt cannot be written: on is refused before anything is set", async () => {
    const f = fixture(); vi.mocked(setup.appendAudit).mockImplementation(() => { throw new Error("disk full"); });
    await expect(f.run(["remote-setup", "accounts", "on"])).rejects.toThrow(/was not turned on/); expect(setup.readRemoteSwitches(f.runtimeHome).accounts.on).toBe(false);
  });
  it("off with an unwritable record: the switch goes off first, and a note says it was not recorded", async () => {
    const f = fixture(); await f.run(["remote-setup", "accounts", "on"]);
    vi.mocked(setup.appendAudit).mockImplementation(() => { throw new Error("disk full"); });
    await f.run(["remote-setup", "accounts", "off"]); expect(setup.readRemoteSwitches(f.runtimeHome).accounts.on).toBe(false); expect(f.err.join("")).toMatch(/Note: the audit log.*not recorded/);
  });
});
