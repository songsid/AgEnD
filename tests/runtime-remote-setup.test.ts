import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_FILE, AUDIT_FOLD_MS, AUDIT_KEEP, AuditLog, MAX_SWITCH_MS, REMOTE_SETUP_FILE, RemoteSetupRefusal, appendAudit, describeRemoteSwitches, formatAuditLine, parseSwitchDuration, readRemoteSwitches, remoteSwitchOn, requireRemoteSwitch, setRemoteSwitch } from "../src/runtime-remote-setup.js";

const directories: string[] = [];
const home = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-remote-setup-")); directories.push(path); return path; };
afterEach(() => { for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });

describe("the two switches", () => {
  it("are both off by default, and an off switch refuses with the command to run on that computer", () => {
    const dir = home();
    expect(readRemoteSwitches(dir)).toEqual({ accounts: { on: false }, install: { on: false } });
    expect(() => requireRemoteSwitch(dir, "accounts")).toThrow(/turned off.*agend-runtime remote-setup accounts on/);
    expect(() => requireRemoteSwitch(dir, "install")).toThrow(/agend-runtime remote-setup install on/);
    try { requireRemoteSwitch(dir, "install"); } catch (error) { expect(error).toBeInstanceOf(RemoteSetupRefusal); expect((error as RemoteSetupRefusal).reason).toBe("switch_off"); }
  });
  it("are independent: turning one on leaves the other off", () => {
    const dir = home();
    setRemoteSwitch(dir, "accounts", true);
    expect(remoteSwitchOn(dir, "accounts")).toBe(true); expect(remoteSwitchOn(dir, "install")).toBe(false);
    setRemoteSwitch(dir, "install", true); setRemoteSwitch(dir, "accounts", false);
    expect(remoteSwitchOn(dir, "accounts")).toBe(false); expect(remoteSwitchOn(dir, "install")).toBe(true);
  });
  it("can turn themselves off: a timed switch is on until its time, and an expired one is off", () => {
    const dir = home(), now = 1_000_000;
    const state = setRemoteSwitch(dir, "accounts", true, parseSwitchDuration("2h"), now);
    expect(state).toEqual({ on: true, until: now + 2 * 3_600_000 });
    expect(remoteSwitchOn(dir, "accounts", now + 3_600_000)).toBe(true);
    expect(remoteSwitchOn(dir, "accounts", now + 2 * 3_600_000)).toBe(false);
    expect(() => requireRemoteSwitch(dir, "accounts", now + 3 * 3_600_000)).toThrow(/turned off/);
    expect(describeRemoteSwitches(readRemoteSwitches(dir, now + 60_000), now + 60_000)).toMatch(/accounts: on \(turns off in 119 min\)\ninstall: off/);
  });
  it("accepts only a bounded time", () => {
    expect(parseSwitchDuration("2h")).toBe(7_200_000); expect(parseSwitchDuration("90m")).toBe(5_400_000); expect(parseSwitchDuration("0.5")).toBe(1_800_000); expect(parseSwitchDuration("168h")).toBe(168 * 3_600_000);
    for (const bad of ["", "0", "0m", "169h", "-1h", "1d", "2 hours", "abc", "1e3h", "99999h"]) expect(() => parseSwitchDuration(bad), bad).toThrow(/--for/);
    const dir = home();
    expect(() => setRemoteSwitch(dir, "accounts", false, 3_600_000)).toThrow(/only when turning a switch on/);
    expect(() => setRemoteSwitch(dir, "accounts", true, 5)).toThrow(/between 1 minute and 168 hours/);
    expect(() => setRemoteSwitch(dir, "nope" as never, true)).toThrow(/Unknown/);
  });
  it("fail closed on a damaged, oversized, wrong-version or linked file; the server has no way to write it", () => {
    const dir = home(), file = join(dir, REMOTE_SETUP_FILE);
    for (const text of ["{", "[]", "null", JSON.stringify({ version: 2, accounts: { on: true } }), JSON.stringify({ version: 1, accounts: { on: "yes" } }), JSON.stringify({ version: 1, accounts: { on: true, until: "soon" } }), JSON.stringify({ version: 1, accounts: { on: true, until: 5 } }), "x".repeat(5000)]) {
      writeFileSync(file, text); expect(readRemoteSwitches(dir, 1_000), text.slice(0, 40)).toEqual({ accounts: { on: false }, install: { on: false } });
    }
    rmSync(file);
    const real = join(home(), "real.json"); writeFileSync(real, JSON.stringify({ version: 1, accounts: { on: true } }));
    try { symlinkSync(real, file); expect(remoteSwitchOn(dir, "accounts")).toBe(false); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
  });
  it("lives in the pairing's own folder, private to the user", () => {
    const dir = home(); setRemoteSwitch(dir, "accounts", true);
    expect(existsSync(join(dir, REMOTE_SETUP_FILE))).toBe(true);
    if (process.platform !== "win32") expect(statSync(join(dir, REMOTE_SETUP_FILE)).mode & 0o077).toBe(0);
  });
});

describe("the audit log", () => {
  const lines = (dir: string): Array<Record<string, unknown>> => readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line));
  it("records who, when, what, which profile and the outcome, one line each", () => {
    const dir = home();
    appendAudit(dir, { actor: "admin:alice", action: "profile.remove", outcome: "ok", cli: "claude-code", profile: "work" }, Date.UTC(2026, 10, 6, 12, 0, 0));
    appendAudit(dir, { actor: "local", action: "switch", outcome: "ok", detail: "on" });
    appendAudit(dir, { actor: "admin:alice", action: "cli.install", outcome: "ok", cli: "claude-code", detail: "2.1.318" });
    appendAudit(dir, { actor: "admin:bob", action: "profile.signout", outcome: "refused", cli: "claude-code", profile: "work", reason: "in_use" });
    const rows = lines(dir);
    expect(rows[0]).toEqual({ at: "2026-11-06T12:00:00.000Z", actor: "admin:alice", action: "profile.remove", outcome: "ok", cli: "claude-code", profile: "work" });
    expect(rows[1]).toMatchObject({ actor: "local", action: "switch", detail: "on" }); expect(rows[2]).toMatchObject({ detail: "2.1.318" }); expect(rows[3]).toMatchObject({ outcome: "refused", reason: "in_use" });
    if (process.platform !== "win32") expect(statSync(join(dir, AUDIT_FILE)).mode & 0o077).toBe(0);
  });
  it("has a closed shape: a URL, a code, output, a path or an e-mail cannot be written, in any field", () => {
    const base = { actor: "admin", action: "signin" as const, outcome: "ok" as const };
    const bad: Array<Record<string, unknown>> = [
      { ...base, actor: "alice@example.com" }, { ...base, actor: "https://claude.com/x" }, { ...base, actor: "a b" }, { ...base, actor: "" }, { ...base, actor: "x".repeat(65) },
      { ...base, profile: "C:\\Users\\me\\.claude" }, { ...base, profile: "ab***@example.com" }, { ...base, profile: "../x" }, { ...base, cli: "Claude Code" },
      { ...base, detail: "Logged in as ab@example.com" }, { ...base, detail: "https://claude.com/cai/oauth/authorize?code=true" }, { ...base, detail: "ABCD-EFGH" }, { ...base, reason: "the code was rejected" },
      { ...base, action: "login" }, { ...base, outcome: "done" },
    ];
    for (const entry of bad) expect(() => formatAuditLine(entry as never), JSON.stringify(entry)).toThrow(/closed form/);
    // Extra fields are not copied even if a caller passes them.
    const line = formatAuditLine({ ...base, url: "https://claude.com/x", code: "ABCD", output: "Logged in as ab@example.com", email: "ab@example.com" } as never);
    expect(line).not.toMatch(/claude\.com|ABCD|Logged in|example\.com/);
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(["action", "actor", "at", "outcome"]);
  });
  it("refuses a log that is a link, and rotates one copy past a megabyte", () => {
    const dir = home(), path = join(dir, AUDIT_FILE), outside = join(home(), "elsewhere.log");
    writeFileSync(outside, "");
    try { symlinkSync(outside, path); expect(() => appendAudit(dir, { actor: "local", action: "switch", outcome: "ok", detail: "on" })).toThrow(/regular file/); expect(readFileSync(outside, "utf8")).toBe(""); rmSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
    writeFileSync(path, `${"x".repeat(1024 * 1024 + 10)}\n`);
    appendAudit(dir, { actor: "local", action: "switch", outcome: "ok", detail: "off" });
    expect(existsSync(`${path}.1`)).toBe(true); expect(lines(dir)).toHaveLength(1);
  });
  it("throws when it cannot be written, so a remote operation without a record does not run", () => {
    const dir = home(), blocked = join(dir, "not-a-directory"); writeFileSync(blocked, "");
    expect(() => appendAudit(blocked, { actor: "local", action: "switch", outcome: "ok", detail: "on" })).toThrow();
    mkdirSync(join(dir, AUDIT_FILE));
    expect(() => appendAudit(dir, { actor: "local", action: "switch", outcome: "ok", detail: "on" })).toThrow();
  });
});

describe("a clock that moved, and values nobody can set (review item 9)", () => {
  it("a timed switch is off when its end is further away than the longest allowed time, so a clock moved back cannot revive it", () => {
    const dir = home(), now = 1_700_000_000_000;
    setRemoteSwitch(dir, "accounts", true, parseSwitchDuration("1h"), now);
    expect(remoteSwitchOn(dir, "accounts", now + 1000)).toBe(true);
    expect(remoteSwitchOn(dir, "accounts", now - 6 * 24 * 3_600_000)).toBe(true);        // within the allowed span of the end: still a plausible 1h..7d switch
    expect(remoteSwitchOn(dir, "accounts", now - 8 * 24 * 3_600_000)).toBe(false);       // the clock was moved back more than a week: off
    expect(remoteSwitchOn(dir, "accounts", now + 3_600_000)).toBe(false);
    for (const until of [1e15, Number.MAX_SAFE_INTEGER, now + MAX_SWITCH_MS + 1000, 1e308]) {
      writeFileSync(join(dir, REMOTE_SETUP_FILE), JSON.stringify({ version: 1, accounts: { on: true, until } })); expect(remoteSwitchOn(dir, "accounts", now), String(until)).toBe(false);
    }
    writeFileSync(join(dir, REMOTE_SETUP_FILE), JSON.stringify({ version: 1, accounts: { on: true, until: now + MAX_SWITCH_MS } })); expect(remoteSwitchOn(dir, "accounts", now)).toBe(true);
  });
});

describe("the audit log cannot be flooded (review item 6)", () => {
  const rows = (dir: string): Array<Record<string, unknown>> => readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const refused = (actor: string, extra: Record<string, unknown> = {}) => ({ actor, action: "signin" as const, outcome: "refused" as const, reason: "switch_off" as const, ...extra });
  it("writes the first refusal of a kind, counts the rest of that minute, and states the count on the next line; the actor, profile and CLI are not part of the key", () => {
    const dir = home(); let now = 1_700_000_000_000; const log = new AuditLog(dir, () => now);
    for (let i = 0; i < 500; i++) log.append(refused(`attacker-${i}`, { profile: `p${i}`, cli: "claude-code" }));      // every request names someone else and something else
    expect(rows(dir)).toHaveLength(1); expect(rows(dir)[0]).toMatchObject({ actor: "attacker-0", reason: "switch_off" }); expect(rows(dir)[0]).not.toHaveProperty("repeated");
    now += AUDIT_FOLD_MS - 1; log.append(refused("late")); expect(rows(dir)).toHaveLength(1);
    now += 2; log.append(refused("next-minute")); const all = rows(dir);
    expect(all).toHaveLength(2); expect(all[1]).toMatchObject({ actor: "next-minute", repeated: 501 });
  });
  it("keeps a separate line per kind (action and reason), so one kind cannot hide another", () => {
    const dir = home(); const log = new AuditLog(dir, () => 1_700_000_000_000);
    log.append(refused("a")); log.append({ ...refused("a"), reason: "busy" }); log.append({ ...refused("a"), action: "profile.remove" }); log.append(refused("b"));
    expect(rows(dir).map(row => `${row.action}:${row.reason}`)).toEqual(["signin:switch_off", "signin:busy", "profile.remove:switch_off"]);
  });
  it("never folds a switch change, a started, ok or failed entry: a refusal flood cannot push them out or hide them; the folded count goes out before the next real operation starts", () => {
    const dir = home(); const log = new AuditLog(dir, () => 1_700_000_000_000);
    for (let i = 0; i < 100; i++) log.append(refused("x"));
    log.append({ actor: "local", action: "switch", outcome: "ok", detail: "off" });
    expect(rows(dir).map(row => `${row.action}:${row.outcome}`)).toEqual(["signin:refused", "switch:ok"]);        // an ok or a refusal does not make the log write the count
    log.append({ actor: "admin:u1", action: "profile.remove", outcome: "started", cli: "claude-code", profile: "work" }); log.append({ actor: "admin:u1", action: "profile.remove", outcome: "ok", cli: "claude-code", profile: "work" });
    log.append({ actor: "admin:u1", action: "profile.remove", outcome: "failed", reason: "failed" }); log.append({ actor: "admin:u1", action: "profile.remove", outcome: "failed", reason: "failed" });
    const all = rows(dir);
    expect(all.map(row => `${row.action}:${row.outcome}`)).toEqual(["signin:refused", "switch:ok", "signin:refused", "profile.remove:started", "profile.remove:ok", "profile.remove:failed", "profile.remove:failed"]);
    expect(all[2]).toMatchObject({ repeated: 99 });
  });
  it("an ok, a failed or a switch change in between does not unfold: 1000 refusals each followed by an ok still write about one refusal line", () => {
    const dir = home(); const log = new AuditLog(dir, () => 1_700_000_000_000);
    for (let i = 0; i < 1000; i++) { log.append(refused(`a${i}`)); log.append({ actor: "x", action: "profile.signout", outcome: "ok" }); }
    expect(rows(dir).filter(row => row.outcome === "refused")).toHaveLength(1);
  });
  it("flush writes the folded count when a process ends", () => {
    const dir = home(); const log = new AuditLog(dir, () => 1_700_000_000_000); for (let i = 0; i < 10; i++) log.append(refused("x"));
    log.flush(); expect(rows(dir)).toHaveLength(2); expect(rows(dir)[1]).toMatchObject({ repeated: 9 }); log.flush(); expect(rows(dir)).toHaveLength(2);
  });
  it("keeps five rotated copies, newest first, and drops the oldest", () => {
    const dir = home(), path = join(dir, AUDIT_FILE); expect(AUDIT_KEEP).toBe(5);
    for (let round = 1; round <= 7; round++) { writeFileSync(path, `${JSON.stringify({ marker: round })}\n${"x".repeat(1024 * 1024 + 10)}\n`); appendAudit(dir, { actor: "local", action: "switch", outcome: "ok", detail: "on" }); }
    expect(existsSync(`${path}.5`)).toBe(true); expect(existsSync(`${path}.6`)).toBe(false);
    for (let copy = 1; copy <= 5; copy++) expect(JSON.parse(readFileSync(`${path}.${copy}`, "utf8").split("\n")[0]!).marker, `.${copy}`).toBe(8 - copy);     // .1 is round 7 ... .5 is round 3
  });
  it("accepts signin.write and a repeat count in the closed form, and refuses a count that is not one", () => {
    expect(() => formatAuditLine({ actor: "a", action: "signin.write", outcome: "ok", cli: "claude-code", profile: "work" })).not.toThrow();
    expect(formatAuditLine({ actor: "a", action: "signin", outcome: "refused", reason: "busy", repeated: 5 })).toMatch(/"repeated":5/);
    for (const repeated of [0, 1, -3, 1.5, 1e12, NaN]) expect(() => formatAuditLine({ actor: "a", action: "signin", outcome: "refused", repeated })).toThrow(/closed form/);
  });
});

describe("`since` on a folded line (round 3)", () => {
  const rows = (dir: string): Array<Record<string, unknown>> => readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const refused = (actor: string) => ({ actor, action: "signin" as const, outcome: "refused" as const, reason: "busy" as const });
  it("records where the folded run began (a closed ISO time); `at` is when the line was written", () => {
    const dir = home(); let now = Date.UTC(2026, 10, 6, 12, 0, 0); const log = new AuditLog(dir, () => now);
    log.append(refused("a")); now += 10_000; log.append(refused("b")); now += 10_000; log.append(refused("c"));
    now += AUDIT_FOLD_MS; log.append(refused("d"));
    const all = rows(dir); expect(all).toHaveLength(2);
    expect(all[0]).not.toHaveProperty("since"); expect(all[1]).toMatchObject({ repeated: 3, since: "2026-11-06T12:00:00.000Z", at: "2026-11-06T12:01:20.000Z" });
  });
  it("a flush carries it too, and a single refusal never has one", () => {
    const dir = home(); let now = Date.UTC(2026, 10, 6, 12, 0, 0); const log = new AuditLog(dir, () => now);
    for (let i = 0; i < 5; i++) { log.append(refused("x")); now += 1000; }
    log.flush(); expect(rows(dir)[1]).toMatchObject({ repeated: 4, since: "2026-11-06T12:00:00.000Z" }); expect(rows(dir)[0]).not.toHaveProperty("since");
  });
  it("is part of the closed form: only with a repeat count, only as a UTC ISO time", () => {
    expect(() => formatAuditLine({ actor: "a", action: "signin", outcome: "refused", repeated: 3, since: "2026-11-06T12:00:00.000Z" })).not.toThrow();
    for (const since of ["yesterday", "2026-11-06", "2026-11-06T12:00:00Z", "2026-11-06T12:00:00.000+08:00", "https://x", ""]) expect(() => formatAuditLine({ actor: "a", action: "signin", outcome: "refused", repeated: 3, since }), since).toThrow(/closed form/);
    expect(() => formatAuditLine({ actor: "a", action: "signin", outcome: "refused", since: "2026-11-06T12:00:00.000Z" })).toThrow(/closed form/);
  });
});
