// M-3770 slice 1.3 (design #4480 §4.2): the home lock `<home>/.update.lock`, on a real directory with fake process
// identities: `agend update` takes it for the install prefix it updates; a fleet start takes it briefly, is refused
// while another install's live update holds it, and goes through for its own update's restart.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireHomeUpdateLock, admitFleetStart, homeUpdateLockHolder, homeUpdateLockPath, installPrefixOf } from "../src/home-update-lock.js";
import type { InstallLockDeps } from "../src/install-lock.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "home-lock-"))); dirs.push(d); return d; };

const START = "Wed Nov 25 10:00:00 2026";
/** Fake processes: `live` pids exist and started at START; anything else is gone. */
function deps(pid: number, live: number[]): InstallLockDeps {
  let n = 0;
  return {
    pid, processStart: p => (live.includes(p) || p === pid ? START : null), exists: p => live.includes(p) || p === pid,
    newToken: () => (++n).toString(16).padStart(32, "0"), now: () => new Date("2026-11-25T10:00:00Z"), log: () => {},
  };
}

describe("M-3770: the home update lock", () => {
  it("agend update takes it for the prefix it updates; another install's update on the same home is refused while it lives", () => {
    const home = scratch();
    const first = acquireHomeUpdateLock(home, { spec: "@songsid/agend@2.4.1", installPrefix: "/opt/a" }, deps(100, [100]));
    expect(first.ok).toBe(true);
    const record = JSON.parse(readFileSync(homeUpdateLockPath(home), "utf8"));
    expect(record).toMatchObject({ pid: 100, installPrefix: "/opt/a", targetSpec: "@songsid/agend@2.4.1", agendHome: home });
    const second = acquireHomeUpdateLock(home, { spec: "@songsid/agend@2.3.9", installPrefix: "/opt/b" }, deps(200, [100, 200]));
    expect(second).toMatchObject({ ok: false });
    expect((second as { reason: string }).reason).toContain("pid 100");
    if (first.ok) first.release();
    expect(existsSync(homeUpdateLockPath(home))).toBe(false);
  });

  it("a fleet start takes it briefly when free (released by the caller)", () => {
    const home = scratch();
    const admitted = admitFleetStart(home, "/opt/a", deps(300, [300]));
    expect(admitted).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(homeUpdateLockPath(home), "utf8"))).toMatchObject({ pid: 300, targetSpec: "fleet start" });
    if (admitted.ok) admitted.release();
    expect(existsSync(homeUpdateLockPath(home))).toBe(false);
  });

  it("another install's live update refuses a fleet start; its own update's restart (same prefix) goes through", () => {
    const home = scratch();
    const update = acquireHomeUpdateLock(home, { spec: "@songsid/agend@2.4.1", installPrefix: "/opt/a" }, deps(100, [100]));
    expect(update.ok).toBe(true);
    const other = admitFleetStart(home, "/opt/b", deps(400, [100, 400]));
    expect(other).toMatchObject({ ok: false });
    expect((other as { reason: string }).reason).toMatch(/update from another install \(\/opt\/a, pid 100, installing @songsid\/agend@2\.4\.1\) is running for this home/);
    const checkout = admitFleetStart(home, null, deps(401, [100, 401]));
    expect(checkout.ok).toBe(false);                                                          // a checkout is another install
    const own = admitFleetStart(home, "/opt/a", deps(402, [100, 402]));
    expect(own).toMatchObject({ ok: true, note: "the update of this install is restarting it" });
    expect(homeUpdateLockHolder(home, deps(402, [100, 402]))).toMatchObject({ state: "live", record: { pid: 100 } });   // still the update's
  });

  it("a stale holder is replaced; the lock's own trouble never keeps a fleet down", () => {
    const home = scratch();
    expect(acquireHomeUpdateLock(home, { spec: "x", installPrefix: "/opt/a" }, deps(100, [100])).ok).toBe(true);
    // pid 100 is gone now: the start reclaims the lock.
    const after = admitFleetStart(home, "/opt/b", deps(500, [500]));
    expect(after).toMatchObject({ ok: true });
    expect(after.ok && after.note).toBeFalsy();
    if (after.ok) after.release();
    // An unreadable record, or another start's brief hold (no installPrefix): the start goes on and says why.
    writeFileSync(homeUpdateLockPath(home), "not json");
    expect(admitFleetStart(home, "/opt/b", deps(600, [600]))).toMatchObject({ ok: true, note: expect.stringContaining("starting without it") });
    rmSync(homeUpdateLockPath(home));
    const brief = admitFleetStart(home, "/opt/a", deps(700, [700]));
    expect(admitFleetStart(home, "/opt/b", deps(701, [700, 701]))).toMatchObject({ ok: true, note: expect.stringContaining("starting without it") });
    if (brief.ok) brief.release();
  });

  it("installPrefixOf: a global install's prefix (POSIX lib/node_modules), null for a checkout", () => {
    const base = scratch();
    const pkg = join(base, "prefix", "lib", "node_modules", "@songsid", "agend");
    mkdirSync(pkg, { recursive: true });
    expect(installPrefixOf(pkg)).toBe(join(base, "prefix"));
    mkdirSync(join(base, "src", "agend"), { recursive: true });
    expect(installPrefixOf(join(base, "src", "agend"))).toBeNull();
    expect(installPrefixOf(null)).toBeNull();
  });
});
