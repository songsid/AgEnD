/**
 * #1273: an upload no message took before a restart is removed at startup once older than the upload window.
 * On disk the name says which files those are: web-pending-… until a message takes the file (then web-…).
 * Files a message took follow the inbox's 7-day rotation, like a file from Telegram; nothing else is touched.
 * Scratch directories only (a scratch AGEND_HOME for the fleet path); no fleet started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING_PREFIX, sniffUpload, sweepOrphanedUploads, UPLOAD_TTL_MS, WebFileLedger } from "../src/web-upload.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-1273-")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); try { chmodSync(join(dir, "inbox"), 0o700); } catch { /* none */ } rmSync(dir, { recursive: true, force: true }); });

describe("the name on disk says whether a message took the file", () => {
  const png = () => sniffUpload(PNG, "a.png")!;
  it("stored web-pending-…; a message takes it → web-… (the name the agent is given); a failed delivery puts it back", () => {
    const ledger = new WebFileLedger({ now: () => 0 });
    const inbox = join(dir, "inbox");
    const a = ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: "a.png", type: png() });
    const b = ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: "b.png", type: png() });
    expect(readdirSync(inbox).every(f => f.startsWith(PENDING_PREFIX))).toBe(true);
    const t = ledger.takeForMessage("w", [a.id]);
    if (!t.ok) throw new Error(t.error);
    expect(t.entries[0]!.path).toMatch(/\/web-\d+-[0-9a-f]{8}\.png$/);
    expect(existsSync(t.entries[0]!.path)).toBe(true);
    expect(ledger.read(a.id)?.bytes, "still served under its id after the rename").toEqual(PNG);
    ledger.release(t.entries);                                          // delivery failed: back to "not taken"
    expect(a.path).toMatch(/\/web-pending-\d+-[0-9a-f]{8}\.png$/);
    expect(ledger.read(a.id)?.bytes).toEqual(PNG);
    const t2 = ledger.takeForMessage("w", [a.id, b.id]);
    if (!t2.ok) throw new Error(t2.error);
    ledger.commit(t2.entries);                                          // delivered: keeps its sent name
    expect(readdirSync(inbox).sort().every(f => /^web-\d+-[0-9a-f]{8}\.png$/.test(f))).toBe(true);
  });

  it("all or nothing: when a file cannot get its sent name, none is taken and every name is as before", () => {
    const ledger = new WebFileLedger({ now: () => 0 });
    const inbox = join(dir, "inbox");
    const a = ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: "a.png", type: png() });
    const b = ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: "b.png", type: png() });
    const names = readdirSync(inbox).sort();
    chmodSync(inbox, 0o500);                                            // no renames in this directory
    const t = ledger.takeForMessage("w", [a.id, b.id]);
    chmodSync(inbox, 0o700);
    expect(t.ok).toBe(false);
    expect(readdirSync(inbox).sort()).toEqual(names);
    expect(ledger.takeForMessage("w", [a.id, b.id]).ok, "still takeable").toBe(true);
  });
});

describe("a partial failure is rolled back", () => {
  it("the first file got its sent name, the second could not: the first goes back to pending, nothing is taken", () => {
    const ledger = new WebFileLedger({ now: () => 0 });
    const inbox = join(dir, "inbox");
    const png = sniffUpload(PNG, "a.png")!;
    const a = ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: "a.png", type: png });
    const b = ledger.storeUpload({ instance: "w", inboxDir: inbox, bytes: PNG, name: "b.png", type: png });
    // A directory where b's sent name would go: renaming b fails after a has already been renamed.
    mkdirSync(b.path.replace(PENDING_PREFIX, "web-"));
    const t = ledger.takeForMessage("w", [a.id, b.id]);
    expect(t.ok).toBe(false);
    expect(a.path, "a is back under its pending name").toMatch(/\/web-pending-\d+-[0-9a-f]{8}\.png$/);
    expect(existsSync(a.path)).toBe(true);
    expect(ledger.read(a.id)?.bytes).toEqual(PNG);
    expect(ledger.takeForMessage("w", [a.id]).ok, "a is still takeable on its own").toBe(true);
  });
});

describe("sweepOrphanedUploads (startup)", () => {
  const NOW = Date.parse("2026-10-07T12:00:00Z");
  function file(ws: string, name: string, ageMs: number) {
    const inbox = join(dir, ws, "inbox"); mkdirSync(inbox, { recursive: true });
    const p = join(inbox, name); writeFileSync(p, "x");
    const t = new Date(NOW - ageMs); utimesSync(p, t, t);
    return p;
  }
  it("removes only web-pending-… files older than the upload window; sent uploads and every other file stay", () => {
    const old = file("w", `${PENDING_PREFIX}1-aaaaaaaa.png`, UPLOAD_TTL_MS + 1_000);
    const exact = file("x", `${PENDING_PREFIX}2-bbbbbbbb.txt`, UPLOAD_TTL_MS);
    const young = file("w", `${PENDING_PREFIX}3-cccccccc.png`, 10 * 60_000);
    const sentOld = file("w", "web-4-dddddddd.png", 6 * 24 * 3_600_000);    // a message took it: 7-day rotation, not this
    const telegram = file("w", "photo_123.jpg", 6 * 24 * 3_600_000);         // not ours
    const lookalike = file("w", "web-pendingX-1.png", 6 * 24 * 3_600_000);   // not the prefix
    const r = sweepOrphanedUploads(dir, NOW);
    expect(r.deleted).toBe(2);
    expect([old, exact].map(existsSync)).toEqual([false, false]);
    expect([young, sentOld, telegram, lookalike].map(existsSync)).toEqual([true, true, true, true]);
    expect(r.nextDueInMs, "the young one comes due in 20 minutes").toBe(20 * 60_000);
  });

  it("a future mtime (the clock was set back) is young — kept, due in a full window — never a negative age", () => {
    const future = file("w", `${PENDING_PREFIX}5-eeeeeeee.png`, -3_600_000);   // an hour ahead
    const r = sweepOrphanedUploads(dir, NOW);
    expect(existsSync(future)).toBe(true);
    expect(r).toEqual({ deleted: 0, nextDueInMs: UPLOAD_TTL_MS });
  });

  it("never follows or removes a symlink or a directory, even with the prefix and old", () => {
    const target = join(dir, "precious.txt"); writeFileSync(target, "keep");
    const inbox = join(dir, "w", "inbox"); mkdirSync(inbox, { recursive: true });
    symlinkSync(target, join(inbox, `${PENDING_PREFIX}6-ffffffff.png`));
    mkdirSync(join(inbox, `${PENDING_PREFIX}dir`));
    const r = sweepOrphanedUploads(dir, NOW + 365 * 24 * 3_600_000);
    expect(r.deleted).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(readdirSync(inbox).sort()).toEqual([`${PENDING_PREFIX}6-ffffffff.png`, `${PENDING_PREFIX}dir`]);
  });

  it("no workspaces, or unreadable ones: nothing to do, nothing thrown", () => {
    expect(sweepOrphanedUploads(join(dir, "nope"), NOW)).toEqual({ deleted: 0, nextDueInMs: null });
    mkdirSync(join(dir, "w")); writeFileSync(join(dir, "w", "inbox"), "a file, not a dir");
    expect(sweepOrphanedUploads(dir, NOW)).toEqual({ deleted: 0, nextDueInMs: null });
  });
});

describe("the fleet runs it at startup and again when the youngest comes due (scratch AGEND_HOME)", () => {
  it("removes the old one now and the young one when its window has passed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const now = Date.now();
    vi.stubEnv("AGEND_HOME", dir);
    const inbox = join(dir, "workspaces", "w", "inbox"); mkdirSync(inbox, { recursive: true });
    const mk = (name: string, ageMs: number) => { const p = join(inbox, name); writeFileSync(p, "x"); const t = new Date(now - ageMs); utimesSync(p, t, t); return p; };
    const old = mk(`${PENDING_PREFIX}1-aaaaaaaa.png`, UPLOAD_TTL_MS + 60_000);
    const young = mk(`${PENDING_PREFIX}2-bbbbbbbb.png`, 25 * 60_000);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(join(dir, "data"));
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
    (fm as unknown as { sweepOrphanedWebUploads(): void }).sweepOrphanedWebUploads();
    expect([existsSync(old), existsSync(young)]).toEqual([false, true]);
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    expect(existsSync(young), "swept by the follow-up when it came due").toBe(false);
  });
});
