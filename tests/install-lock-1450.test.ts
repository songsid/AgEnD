/**
 * #1450 C1: one owner per npm prefix, and only its own npm child admitted. The acceptance list of
 * docs/design/1450-private-node-runtime.md: different HOMEs on one prefix → one refusal; different prefixes → both
 * proceed; the owner's own install proceeds; a foreign install during the transition refuses; a stale or late token
 * refuses; a dead owner's lock is reclaimed. Plus: an unreadable lock blocks; release removes only our own lock.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { INSTALL_LOCK_FILE, acquireInstallLock, parseInstallLock, type InstallLockDeps } from "../src/install-lock.js";

const require = createRequire(import.meta.url);
const admission = require("../launcher/install-admission.cjs") as {
  admit(pkgDir: string, deps?: { env?: Record<string, string>; processStart?: (pid: number) => string | null; exists?: (pid: number) => boolean }): { ok: boolean; reason?: string; why?: string };
  globalPrefix(pkgDir: string): string | null;
  processStart(pid: number): string | null;
};

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
/** A global prefix with the package installed where npm puts it. */
function prefix(): { prefix: string; pkg: string } {
  const root = mkdtempSync(join(tmpdir(), "agend-lock-"));
  roots.push(root);
  const pkg = join(root, "lib", "node_modules", "@songsid", "agend");
  mkdirSync(pkg, { recursive: true });
  return { prefix: root, pkg };
}

/** Processes by pid → start time; anything else does not exist. */
function world(live: Record<number, string>) {
  let n = 0;
  const logs: string[] = [];
  const deps = (pid: number): InstallLockDeps => ({
    pid, processStart: p => live[p] ?? null, exists: p => p in live, newToken: () => `${String(++n).padStart(4, "0")}${"ab".repeat(16)}`,
    now: () => new Date("2026-10-09T00:00:00Z"), log: m => logs.push(m),
  });
  return { deps, logs, start: (p: number) => live[p] ?? null, exists: (p: number) => p in live };
}
const target = (home: string) => ({ spec: "@songsid/agend@2.2.0", agendHome: home });

describe("the updater's prefix lock", () => {
  it("two fleets (different AGEND_HOMEs) on one prefix: the second refuses while the first holds it", () => {
    const p = prefix(), w = world({ 100: "Thu Oct  9 10:00:00 2026", 200: "Thu Oct  9 10:00:05 2026" });
    const first = acquireInstallLock(p.prefix, target("/home/a/.agend"), w.deps(100));
    expect(first.ok).toBe(true);
    const second = acquireInstallLock(p.prefix, target("/home/b/.agend"), w.deps(200));
    expect(second).toMatchObject({ ok: false, reason: expect.stringContaining("another AgEnD install is running") });
    expect(second.ok === false && second.reason).toContain("/home/a/.agend");
  });

  it("different prefixes: both proceed", () => {
    const a = prefix(), b = prefix(), w = world({ 100: "s1", 200: "s2" });
    expect(acquireInstallLock(a.prefix, target("/h"), w.deps(100)).ok).toBe(true);
    expect(acquireInstallLock(b.prefix, target("/h"), w.deps(200)).ok).toBe(true);
  });

  it("the prefix is canonicalised: a symlink to it is the same lock", () => {
    const p = prefix(), w = world({ 100: "s1", 200: "s2" });
    const link = `${p.prefix}-link`;
    symlinkSync(p.prefix, link);
    roots.push(link);
    expect(acquireInstallLock(p.prefix, target("/h"), w.deps(100)).ok).toBe(true);
    expect(acquireInstallLock(link, target("/h"), w.deps(200)).ok).toBe(false);
  });

  it("a dead owner's lock is reclaimed (and logged); so is one whose pid is now another process", () => {
    const p = prefix(), w = world({ 100: "s1", 300: "s3" });
    expect(acquireInstallLock(p.prefix, target("/h"), w.deps(100)).ok).toBe(true);
    const dead = world({ 300: "s3" });                                   // pid 100 is gone
    const next = acquireInstallLock(p.prefix, target("/h"), dead.deps(300));
    expect(next.ok).toBe(true);
    expect(dead.logs.join("\n")).toContain("Replaced a stale install lock (pid 100 is gone");
    const reused = world({ 300: "a different start", 400: "s4" });       // pid 300 recycled
    expect(acquireInstallLock(p.prefix, target("/h"), reused.deps(400)).ok).toBe(true);
  });

  it("a lock that cannot be parsed blocks, naming the file — it is never taken", () => {
    const p = prefix(), w = world({ 100: "s1" });
    writeFileSync(join(p.prefix, INSTALL_LOCK_FILE), "{ not json");
    const r = acquireInstallLock(p.prefix, target("/h"), w.deps(100));
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("cannot be read as a lock") });
    expect(readFileSync(join(p.prefix, INSTALL_LOCK_FILE), "utf8")).toBe("{ not json");
  });

  it("no own start time → refuses (its lock could not be told from a stale one)", () => {
    const p = prefix();
    expect(acquireInstallLock(p.prefix, target("/h"), world({}).deps(100))).toMatchObject({ ok: false });
    expect(existsSync(join(p.prefix, INSTALL_LOCK_FILE))).toBe(false);
  });

  it("release removes only our own lock: a lock another owner holds by then is left alone", () => {
    const p = prefix(), w = world({ 100: "s1", 200: "s2" });
    const mine = acquireInstallLock(p.prefix, target("/h"), w.deps(100));
    if (!mine.ok) throw new Error("expected the lock");
    mine.release();
    expect(existsSync(mine.path)).toBe(false);
    const again = acquireInstallLock(p.prefix, target("/h"), w.deps(100));
    if (!again.ok) throw new Error("expected the lock");
    const theirs = JSON.stringify({ ...parseInstallLock(readFileSync(again.path, "utf8"))!, pid: 200, processStart: "s2" }) + "\n";
    writeFileSync(again.path, theirs);                                   // someone else's lock now
    again.release();
    expect(readFileSync(again.path, "utf8")).toBe(theirs);
  });
});

describe("#1472 review: ownership under stale recovery and uncertain reads", () => {
  const stale = (p: { prefix: string }, pid = 300, start = "s-old") => writeFileSync(join(p.prefix, INSTALL_LOCK_FILE),
    JSON.stringify({ pid, processStart: start, prefix: realpathSync(p.prefix), targetSpec: "@songsid/agend@2.1.12", agendHome: "/old", token: "c".repeat(36), createdAt: "2026-10-01T00:00:00Z" }) + "\n");
  it("an updater that judged a lock stale cannot move the lock another updater claimed meanwhile: exactly one live owner", () => {
    const p = prefix(), w = world({ 100: "s1", 200: "s2", 400: "s4" });
    stale(p);
    let b: ReturnType<typeof acquireInstallLock> | null = null;
    let c: ReturnType<typeof acquireInstallLock> | null = null;
    // A judges pid 300's lock stale; before A takes the reclaim marker, B reclaims it and holds the lock; and should A
    // ever move a lock aside, C tries to claim in that gap (the interleaving that once left B and C both owners).
    const a = acquireInstallLock(p.prefix, target("/a"), {
      ...w.deps(100),
      afterStaleJudged: () => { b = acquireInstallLock(p.prefix, target("/b"), w.deps(200)); },
      afterStaleMoved: () => { c = acquireInstallLock(p.prefix, target("/c"), w.deps(400)); },
    });
    expect(b).toMatchObject({ ok: true });
    expect(a).toMatchObject({ ok: false, reason: expect.stringContaining("retry") });
    expect(c === null || (c as { ok: boolean }).ok === false).toBe(true);
    // B's lock is in place, intact; a third updater sees a live owner.
    expect(parseInstallLock(readFileSync(join(realpathSync(p.prefix), INSTALL_LOCK_FILE), "utf8"))).toMatchObject({ pid: 200, agendHome: "/b" });
    expect(acquireInstallLock(p.prefix, target("/c"), w.deps(400))).toMatchObject({ ok: false, reason: expect.stringContaining("another AgEnD install is running") });
    expect(readdirSync(realpathSync(p.prefix)).filter(f => f.includes(".agend-install.lock."))).toEqual([]);
  });
  it("a reclaim marker held by a live updater: refused, retry; one left by a dead one blocks, naming itself, never taken", () => {
    const p = prefix(), w = world({ 100: "s1", 200: "s2" });
    stale(p);
    const marker = join(realpathSync(p.prefix), `${INSTALL_LOCK_FILE}.reclaim`);
    writeFileSync(marker, JSON.stringify({ pid: 200, processStart: "s2", prefix: realpathSync(p.prefix), targetSpec: "x", agendHome: "/b", token: "d".repeat(36), createdAt: "t" }) + "\n");
    expect(acquireInstallLock(p.prefix, target("/a"), w.deps(100))).toMatchObject({ ok: false, reason: expect.stringContaining("is replacing the stale lock") });
    writeFileSync(marker, JSON.stringify({ pid: 999, processStart: "s9", prefix: realpathSync(p.prefix), targetSpec: "x", agendHome: "/b", token: "d".repeat(36), createdAt: "t" }) + "\n");
    expect(acquireInstallLock(p.prefix, target("/a"), w.deps(100))).toMatchObject({ ok: false, reason: expect.stringContaining(`a reclaim marker ${marker} was left behind`) });
    expect(existsSync(marker)).toBe(true);
  });
  it("the stale lock is replaced, and the marker is gone afterwards", () => {
    const p = prefix(), w = world({ 100: "s1" });
    stale(p);
    expect(acquireInstallLock(p.prefix, target("/a"), w.deps(100))).toMatchObject({ ok: true });
    expect(readdirSync(realpathSync(p.prefix)).filter(f => f.startsWith(INSTALL_LOCK_FILE))).toEqual([INSTALL_LOCK_FILE]);
  });
  it("a holder that exists but whose start time cannot be read is UNKNOWN: blocks the updater, never stale (#2264: the postinstall reads no lock)", () => {
    const p = prefix(), w = world({ 100: "s1" });
    stale(p, 300, "s-old");
    const deps = { ...w.deps(100), exists: (pid: number) => pid === 300 || pid === 100 };
    expect(acquireInstallLock(p.prefix, target("/a"), deps)).toMatchObject({ ok: false, reason: expect.stringContaining("cannot be told") });
  });
  it("a reused pid (another start time) is proven stale; a gone pid is proven stale", () => {
    const p = prefix(), w = world({ 100: "s1", 300: "s-new" });
    stale(p, 300, "s-old");
    expect(acquireInstallLock(p.prefix, target("/a"), w.deps(100))).toMatchObject({ ok: true });
  });
  it("the start time is one canonical text whatever the caller's time zone (real ps)", () => {
    const read = (tz: string) => execFileSync(process.execPath, ["-e", `process.stdout.write(String(require(${JSON.stringify(join(process.cwd(), "launcher", "install-admission.cjs"))}).processStart(${process.pid})))`], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    const utc = read("UTC");
    expect(utc).not.toBe("null");
    expect(read("Etc/GMT+12")).toBe(utc);
    expect(read("Asia/Taipei")).toBe(utc);
  });
  it.each([["a fractional pid", 100.5], ["a negative pid", -1], ["a pid as text", "100"]] as const)("the updater does not take a lock record with %s as a lock", (_n, pid) => {
    const p = prefix();
    writeFileSync(join(p.prefix, INSTALL_LOCK_FILE), JSON.stringify({ pid, processStart: "s1", prefix: realpathSync(p.prefix), targetSpec: "x", agendHome: "/h", token: "e".repeat(36), createdAt: "t" }));
    expect(parseInstallLock(readFileSync(join(p.prefix, INSTALL_LOCK_FILE), "utf8"))).toBeNull();
  });
});
