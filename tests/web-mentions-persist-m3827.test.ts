/**
 * M-3827: the web chat's mention names survive a fleet restart. The people seen on inbound messages (#1682 SeenUsers)
 * are kept in <home>/web-seen-users.json — bounded, written atomically and debounced, a corrupt file ignored — and
 * loaded at start, so a mention of someone who has not spoken since the restart still shows their name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as fleetManagerModule from "../src/fleet-manager.js";
import { SEEN_USERS_FILE, SEEN_USERS_WRITE_DELAY_MS, SeenUsers, parseSeenUsersFile } from "../src/web-mentions.js";

const A = "111111111111111111", B = "222222222222222222", C = "333333333333333333", D = "444444444444444444";
const dirs: string[] = [];
const home = () => { const d = mkdtempSync(join(tmpdir(), "seen-m3827-")); dirs.push(d); return d; };
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("SeenUsers on disk", () => {
  it("a restart round-trip: the names seen before are there after, newest kept newest", () => {
    const path = join(home(), SEEN_USERS_FILE);
    const before = new SeenUsers();
    before.persistTo({ path });
    before.record(A, "Avery"); before.record(B, "Blair"); before.record(A, "Avery");
    before.flush();
    const after = new SeenUsers();
    expect(after.get(A)).toBeUndefined();
    after.persistTo({ path });
    expect([after.get(A), after.get(B), after.size]).toEqual(["Avery", "Blair", 2]);
    // Order survives: A spoke last, so B is the one a full list drops first.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, users: [[B, "Blair"], [A, "Avery"]] });
  });

  it("people seen before the file is loaded stay newest; an older name on disk does not overwrite a newer one", () => {
    const path = join(home(), SEEN_USERS_FILE);
    writeFileSync(path, JSON.stringify({ version: 1, users: [[A, "Old name"], [B, "Blair"]] }));
    const seen = new SeenUsers(2);
    seen.record(A, "New name");
    seen.persistTo({ path });
    expect([seen.get(A), seen.get(B)]).toEqual(["New name", "Blair"]);
    seen.record(C, "Casey");                                   // the oldest (B) goes, not A
    expect([seen.get(A), seen.get(B), seen.get(C)]).toEqual(["New name", undefined, "Casey"]);
  });

  it("bounded: the file holds at most the limit, and a longer file loads only its newest", () => {
    const path = join(home(), SEEN_USERS_FILE);
    const seen = new SeenUsers(3);
    seen.persistTo({ path });
    for (const [id, name] of [[A, "a"], [B, "b"], [C, "c"], [D, "d"]]) seen.record(id!, name!);
    seen.flush();
    expect(JSON.parse(readFileSync(path, "utf8")).users).toEqual([[B, "b"], [C, "c"], [D, "d"]]);
    writeFileSync(path, JSON.stringify({ version: 1, users: [[A, "a"], [B, "b"], [C, "c"], [D, "d"]] }));
    const small = new SeenUsers(2);
    small.persistTo({ path });
    expect([small.size, small.get(C), small.get(D)]).toEqual([2, "c", "d"]);
    expect(parseSeenUsersFile(readFileSync(path, "utf8"), 2)).toEqual([[C, "c"], [D, "d"]]);
  });

  it("bounded when the file and the people seen before loading together pass the limit: the oldest on disk go", () => {
    const path = join(home(), SEEN_USERS_FILE);
    writeFileSync(path, JSON.stringify({ version: 1, users: [[A, "a"], [B, "b"]] }));
    const seen = new SeenUsers(2);
    seen.record(C, "c");
    seen.persistTo({ path });
    expect([seen.size, seen.get(A), seen.get(B), seen.get(C)]).toEqual([2, undefined, "b", "c"]);
  });

  it("atomic and owner-only: no temp file is left, the mode is 0600, and an unchanged record writes nothing", () => {
    const dir = home(), path = join(dir, SEEN_USERS_FILE);
    const seen = new SeenUsers();
    seen.persistTo({ path });
    seen.record(A, "Avery");
    seen.flush();
    expect(readdirSync(dir)).toEqual([SEEN_USERS_FILE]);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const write = vi.fn();
    const again = new SeenUsers();
    again.persistTo({ path, write });
    again.record(A, "Avery");                                  // already the newest, same name
    again.flush();
    expect(write).not.toHaveBeenCalled();
  });

  it("debounced: a busy stretch is one write, after the delay; the stop writes what is still owed", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const seen = new SeenUsers();
    seen.persistTo({ path: "/nowhere/" + SEEN_USERS_FILE, read: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); }, write });
    seen.record(A, "a"); seen.record(B, "b"); seen.record(C, "c");
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SEEN_USERS_WRITE_DELAY_MS - 1);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]![1]).users).toEqual([[A, "a"], [B, "b"], [C, "c"]]);
    seen.record(D, "d");
    seen.flush();                                              // the fleet's stop: not waiting for the timer
    expect(write).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(SEEN_USERS_WRITE_DELAY_MS);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("a write that fails is still owed (tried again), and is said once", () => {
    const warn = vi.fn();
    let fail = true;
    const write = vi.fn(() => { if (fail) throw new Error("disk full"); });
    const seen = new SeenUsers();
    seen.persistTo({ path: join(home(), SEEN_USERS_FILE), write, onWarn: warn });
    seen.record(A, "a"); seen.flush();
    seen.record(B, "b"); seen.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    fail = false;
    seen.flush();
    expect(write).toHaveBeenCalledTimes(3);
    expect(JSON.parse((write.mock.calls[2] as unknown as [string, string])[1]).users).toEqual([[A, "a"], [B, "b"]]);
  });

  it("a corrupt file is ignored (empty, no error) and replaced by the next write", () => {
    const path = join(home(), SEEN_USERS_FILE);
    for (const bad of ["{not json", "null", "[]", JSON.stringify({ version: 2, users: [[A, "a"]] }), JSON.stringify({ version: 1, users: "x" })]) {
      writeFileSync(path, bad);
      const seen = new SeenUsers();
      expect(() => seen.persistTo({ path })).not.toThrow();
      expect(seen.size).toBe(0);
    }
    const seen = new SeenUsers();
    seen.persistTo({ path });
    seen.record(A, "Avery"); seen.flush();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, users: [[A, "Avery"]] });
  });

  it("only well-formed entries load: Discord ids, non-empty names, trimmed and capped like a record", () => {
    const long = "x".repeat(150);
    expect(parseSeenUsersFile(JSON.stringify({ version: 1, users: [[A, " Avery "], ["12", "short id"], [B, ""], [C, 7], [D, long], "junk", [A]] })))
      .toEqual([[A, "Avery"], [D, "x".repeat(100)]]);
  });

  it("a read refused (not just missing) warns and starts empty; a missing file is quiet", () => {
    const warn = vi.fn();
    const refused = new SeenUsers();
    refused.persistTo({ path: "p", read: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, onWarn: warn });
    expect([refused.size, warn.mock.calls.length]).toEqual([0, 1]);
    const missing = new SeenUsers();
    missing.persistTo({ path: join(home(), SEEN_USERS_FILE), onWarn: warn });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("the fleet keeps them across a restart", () => {
  function fleet(dataDir: string) {
    const { FleetManager } = fleetManagerModule;
    const fm = Object.create(FleetManager.prototype) as InstanceType<typeof FleetManager> & Record<string, any>;
    Object.assign(fm, { dataDir, fleetConfig: { instances: {} }, adapters: new Map(), seenUsers: new SeenUsers(), ownBots: () => new Map() });
    return fm;
  }
  it("a mention of a person seen before the restart is named after it, from <home>/web-seen-users.json", () => {
    const dataDir = home();
    const first = fleet(dataDir);
    first.seenUsers.persistTo({ path: join(dataDir, SEEN_USERS_FILE) });
    first.seenUsers.record(A, "Han");
    first.seenUsers.flush();                                   // what stop() does
    const second = fleet(dataDir);
    expect(second.webMentionNames({ u: [A], r: [], c: [] }).u).toEqual({});
    second.seenUsers.persistTo({ path: join(dataDir, SEEN_USERS_FILE) });
    expect(second.webMentionNames({ u: [A], r: [], c: [] }).u).toEqual({ [A]: "Han" });
  });

  it("startAll() loads the file before the adapters connect, and stop() writes what is owed", () => {
    const src = readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8");
    const load = src.indexOf("this.seenUsers?.persistTo({ path: join(this.dataDir, SEEN_USERS_FILE)");
    expect(load).toBeGreaterThan(0);
    const startAt = src.indexOf("private async startAllWithinDeadline(");
    expect(startAt).toBeGreaterThan(0);
    expect(startAt).toBeLessThan(load);
    const webAuth = src.indexOf("this.initializeWebAuthTokens();", startAt);
    expect(webAuth).toBeGreaterThan(startAt);
    expect(webAuth).toBeLessThan(load);
    // Before the first adapter connects (an inbound message recorded earlier would still merge, as tested above).
    expect(load).toBeLessThan(src.indexOf("await adapter.start()", startAt));
    expect(src).toMatch(/this\.webSessions\?\.flush\(\);\n\s+this\.seenUsers\?\.flush\(\);/);
  });
});
