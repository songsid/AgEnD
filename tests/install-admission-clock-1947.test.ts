/**
 * #1947: a chat /update failed twice with only "npm error code 1 … path …/@songsid/agend" (the postinstall refusing),
 * then succeeded. The postinstall's install admission compared the lock holder's `ps -o lstart` text, a wall time
 * derived from the boot time: a clock step (NTP, a VM / WSL resync) between the updater writing the lock and the
 * postinstall reading it made the updater's own npm child look foreign ("the AgEnD update that held … is gone").
 * Now: Linux locks also record /proc/<pid>/stat start ticks (exact, immune to clock steps); a lock without them (every
 * 2.2 beta's, macOS) is judged by lstart within ±2 s. And the refusal line, not npm's code/path, is the chat's cause.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acquireInstallLock, holderState, parseInstallLock, type InstallLockDeps } from "../src/install-lock.js";
import { extractUpdateCause } from "../src/update-launch.js";

const require = createRequire(import.meta.url);
type Deps = { env?: Record<string, string>; processStart?: (pid: number) => string | null; startTicks?: (pid: number) => string | null; bootId?: () => string | null; exists?: (pid: number) => boolean };
const admission = require("../launcher/install-admission.cjs") as {
  admit(pkgDir: string, deps?: Deps): { ok: boolean; reason?: string; why?: string };
  processStart(pid: number): string | null;
  startTicks(pid: number): string | null;
  bootId(): string | null;
};
const BOOT = "11111111-2222-3333-4444-555555555555", OTHER_BOOT = "99999999-2222-3333-4444-555555555555";
const thisBoot = () => BOOT;

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function prefix(): { prefix: string; pkg: string } {
  const root = mkdtempSync(join(tmpdir(), "agend-adm1947-"));
  roots.push(root);
  const pkg = join(root, "lib", "node_modules", "@songsid", "agend");
  mkdirSync(pkg, { recursive: true });
  return { prefix: realpathSync(root), pkg };
}
const TOKEN = "c".repeat(32);   // a placeholder: a realistic-looking token is a secret scanner's false positive
const BEFORE = "Fri Oct 16 09:00:58 2026";
/** A lock as an updater writes it; `ticks` present = a #1947 updater on Linux. */
function lock(p: string, extra: Record<string, unknown> = {}) {
  writeFileSync(join(p, ".agend-install.lock"), JSON.stringify({
    pid: 4242, processStart: BEFORE, prefix: p, targetSpec: "@songsid/agend@2.2.0", agendHome: "/h", token: TOKEN, createdAt: "2026-10-16T09:01:00Z", ...extra,
  }) + "\n");
}
const own = { AGEND_INSTALL_TOKEN: TOKEN };
const alive = () => true;

describe("install admission across a clock step (#1947)", () => {
  it("a lock without start ticks (every 2.2 beta's): the updater's own child is admitted when the clock stepped by up to 2 s", () => {
    const p = prefix();
    lock(p.prefix);
    for (const seen of [BEFORE, "Fri Oct 16 09:00:59 2026", "Fri Oct 16 09:00:56 2026"]) {
      expect(admission.admit(p.pkg, { env: own, exists: alive, processStart: () => seen }), seen).toMatchObject({ ok: true, why: "the updater's own install" });
    }
  });

  it("…but a start more than 2 s off is another process (a reused pid): refused, and a foreign token too", () => {
    const p = prefix();
    lock(p.prefix);
    expect(admission.admit(p.pkg, { env: own, exists: alive, processStart: () => "Fri Oct 16 09:01:05 2026" })).toMatchObject({ ok: false, reason: expect.stringContaining("is gone") });
    expect(admission.admit(p.pkg, { env: { AGEND_INSTALL_TOKEN: "f".repeat(32) }, exists: alive, processStart: () => BEFORE })).toMatchObject({ ok: false, reason: expect.stringContaining("is installing into") });
    expect(admission.admit(p.pkg, { env: {}, exists: alive, processStart: () => BEFORE })).toMatchObject({ ok: false, reason: expect.stringContaining("is installing into") });
  });

  it("a lock with start ticks (Linux): judged by ticks and boot, never the wall clock", () => {
    const p = prefix();
    lock(p.prefix, { startTicks: "123456", bootId: BOOT });
    // The wall clock moved a whole minute: lstart says another time; the same boot and ticks say the same process.
    expect(admission.admit(p.pkg, { env: own, exists: alive, bootId: thisBoot, startTicks: () => "123456", processStart: () => "Fri Oct 16 09:02:00 2026" })).toMatchObject({ ok: true });
    // Other ticks this boot: a reused pid → gone; a foreign token stays refused.
    expect(admission.admit(p.pkg, { env: own, exists: alive, bootId: thisBoot, startTicks: () => "999999", processStart: () => BEFORE })).toMatchObject({ ok: false, reason: expect.stringContaining("is gone") });
    expect(admission.admit(p.pkg, { env: { AGEND_INSTALL_TOKEN: "f".repeat(32) }, exists: alive, bootId: thisBoot, startTicks: () => "123456" })).toMatchObject({ ok: false, reason: expect.stringContaining("is installing into") });
  });

  it("#1949 review P2-1: a ticks lock whose ticks or boot cannot be read is UNKNOWN — never judged by wall time", () => {
    const p = prefix();
    lock(p.prefix, { startTicks: "123456", bootId: BOOT });
    const moved = () => "Fri Oct 16 09:02:00 2026";   // 60 s off: the wall-time rule would call it stale
    for (const d of [{ bootId: thisBoot, startTicks: () => null }, { bootId: () => null, startTicks: () => "123456" }]) {
      expect(admission.admit(p.pkg, { env: {}, exists: alive, processStart: moved, ...d })).toMatchObject({ ok: false, reason: expect.stringContaining("cannot be told") });
      expect(admission.admit(p.pkg, { env: own, exists: alive, processStart: moved, ...d })).toMatchObject({ ok: false, reason: expect.stringContaining("cannot be told") });
    }
  });

  it("#1949 review P2-2: a ticks lock from another boot is stale, even if a process now has the same pid and ticks", () => {
    const p = prefix();
    lock(p.prefix, { startTicks: "123456", bootId: OTHER_BOOT });
    const same = { exists: alive, bootId: thisBoot, startTicks: () => "123456", processStart: () => BEFORE };
    expect(admission.admit(p.pkg, { env: {}, ...same })).toMatchObject({ ok: true, why: "a stale lock and no token: an external install" });
    expect(admission.admit(p.pkg, { env: own, ...same })).toMatchObject({ ok: false, reason: expect.stringContaining("is gone") });
  });

  it("the beta-era lock fixture (no ticks) is still a lock, and admits its updater's own child", () => {
    const p = prefix();
    const text = readFileSync(join(import.meta.dirname, "fixtures", "install-lock-1947", "beta-lock.json"), "utf8").replace("__PREFIX__", p.prefix);
    writeFileSync(join(p.prefix, ".agend-install.lock"), text);
    expect(parseInstallLock(text)).not.toBeNull();
    expect(admission.admit(p.pkg, { env: own, exists: alive, processStart: () => "Fri Oct 16 09:00:59 2026" })).toMatchObject({ ok: true });
  });

  it.each([
    ["a malformed startTicks", { startTicks: "12x", bootId: BOOT }],
    ["startTicks without its boot", { startTicks: "123" }],
    ["a boot without startTicks", { bootId: BOOT }],
  ])("%s makes the lock unreadable (blocks), never silently ignored", (_n, extra) => {
    const p = prefix();
    lock(p.prefix, extra);
    expect(admission.admit(p.pkg, { env: own, exists: alive, bootId: thisBoot, processStart: () => BEFORE })).toMatchObject({ ok: false, reason: expect.stringContaining("cannot be read as a lock") });
  });
});

describe("the updater side follows the same rule (src/install-lock.ts)", () => {
  const base = (over: Partial<InstallLockDeps> = {}): InstallLockDeps => ({
    pid: 100, processStart: () => BEFORE, newToken: () => TOKEN, now: () => new Date("2026-10-16T09:01:00Z"), log: () => {}, ...over,
  });

  it("acquire records start ticks with their boot when both can be read, and neither otherwise", () => {
    const a = prefix(), b = prefix(), c = prefix();
    expect(acquireInstallLock(a.prefix, { spec: "x", agendHome: "/h" }, base({ startTicks: () => "777", bootId: thisBoot })).ok).toBe(true);
    expect(acquireInstallLock(b.prefix, { spec: "x", agendHome: "/h" }, base({ startTicks: () => null, bootId: thisBoot })).ok).toBe(true);
    expect(acquireInstallLock(c.prefix, { spec: "x", agendHome: "/h" }, base({ startTicks: () => "777", bootId: () => null })).ok).toBe(true);
    expect(parseInstallLock(readFileSync(join(a.prefix, ".agend-install.lock"), "utf8"))).toMatchObject({ startTicks: "777", bootId: BOOT });
    for (const q of [b, c]) {
      const rec = parseInstallLock(readFileSync(join(q.prefix, ".agend-install.lock"), "utf8"));
      expect(rec).not.toHaveProperty("startTicks");
      expect(rec).not.toHaveProperty("bootId");
    }
  });

  it("#1949 review: the updater never reclaims a live ticks holder it cannot read; the lock is left byte-for-byte", () => {
    const p = prefix();
    const held = JSON.stringify({ pid: 4242, processStart: BEFORE, startTicks: "123456", bootId: BOOT, prefix: p.prefix, targetSpec: "x", agendHome: "/a", token: TOKEN, createdAt: "2026-10-16T09:01:00Z" }) + "\n";
    writeFileSync(join(p.prefix, ".agend-install.lock"), held);
    const moved = () => "Fri Oct 16 09:02:00 2026";
    const r = acquireInstallLock(p.prefix, { spec: "y", agendHome: "/b" }, base({ pid: 100, exists: alive, processStart: moved, startTicks: () => null, bootId: thisBoot }));
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("cannot be told") });
    expect(readFileSync(join(p.prefix, ".agend-install.lock"), "utf8")).toBe(held);
    // …and a lock left from another boot is reclaimed.
    writeFileSync(join(p.prefix, ".agend-install.lock"), held.replace(BOOT, OTHER_BOOT));
    const again = acquireInstallLock(p.prefix, { spec: "y", agendHome: "/b" }, base({ pid: 100, exists: alive, processStart: () => BEFORE, startTicks: () => "123456", bootId: thisBoot }));
    expect(again.ok).toBe(true);
  });

  it("holderState: ticks and boot decide; else lstart within 2 s; a clock step never makes a live holder stale", () => {
    const rec = { pid: 7, processStart: BEFORE, startTicks: "55", bootId: BOOT };
    expect(holderState(rec, { exists: alive, bootId: thisBoot, startTicks: () => "55", processStart: () => "Fri Oct 16 09:03:00 2026" })).toBe("live");
    expect(holderState(rec, { exists: alive, bootId: thisBoot, startTicks: () => "56", processStart: () => BEFORE })).toBe("stale");
    expect(holderState(rec, { exists: alive, bootId: () => OTHER_BOOT, startTicks: () => "55", processStart: () => BEFORE })).toBe("stale");
    expect(holderState(rec, { exists: alive, bootId: thisBoot, startTicks: () => null, processStart: () => BEFORE })).toBe("unknown");
    expect(holderState(rec, { exists: alive, bootId: () => null, startTicks: () => "55", processStart: () => BEFORE })).toBe("unknown");
    expect(holderState({ pid: 7, processStart: BEFORE }, { exists: alive, processStart: () => "Fri Oct 16 09:01:00 2026" })).toBe("live");
    expect(holderState({ pid: 7, processStart: BEFORE }, { exists: alive, processStart: () => "Fri Oct 16 09:01:01 2026" })).toBe("stale");
    expect(holderState({ pid: 7, processStart: BEFORE }, { exists: alive, processStart: () => null })).toBe("unknown");
  });

  it("with REAL processes on this OS: a lock acquired with the real readers admits its own child, and not after the holder exits", async () => {
    const p = prefix();
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
    try {
      await new Promise(r => setTimeout(r, 300));
      const got = acquireInstallLock(p.prefix, { spec: "x", agendHome: "/h" }, {
        pid: holder.pid!, processStart: admission.processStart, startTicks: admission.startTicks, bootId: admission.bootId, newToken: () => TOKEN, now: () => new Date(), log: () => {},
      });
      expect(got.ok).toBe(true);
      if (process.platform === "linux") expect(parseInstallLock(readFileSync(join(p.prefix, ".agend-install.lock"), "utf8"))).toMatchObject({ startTicks: expect.stringMatching(/^\d+$/), bootId: admission.bootId() });
      expect(admission.admit(p.pkg, { env: own })).toMatchObject({ ok: true });
    } finally { holder.kill(); }
    await new Promise(r => setTimeout(r, 300));
    expect(admission.admit(p.pkg, { env: own })).toMatchObject({ ok: false, reason: expect.stringContaining("is gone") });
  });
});

describe("the chat shows AgEnD's own refusal, not npm's code/path lines (#1947)", () => {
  // npm 10's output for a postinstall that exits 1 (captured with a probe package), with our real script command.
  const npm = [
    "npm error code 1",
    "npm error path /home/u/.nvm/versions/node/v22.22.3/lib/node_modules/@songsid/agend",
    "npm error command failed",
    "npm error command sh -c node launcher/postinstall.cjs",
    "npm error AgEnD cannot be installed here: the AgEnD update that held /home/u/.nvm/versions/node/v22.22.3/.agend-install.lock is gone, so its token cannot authorise this install.",
    "npm error   npm is rolling this install back; the previous install stays.",
    "npm error A complete log of this run can be found in: /home/u/.npm/_logs/x-debug-0.log",
  ].join("\n");

  it("the postinstall's refusal is the cause", () => {
    expect(extractUpdateCause(npm)).toBe("AgEnD cannot be installed here: the AgEnD update that held /home/u/.nvm/versions/node/v22.22.3/.agend-install.lock is gone, so its token cannot authorise this install.");
  });
  it("so is the preinstall's, printed bare (before npm's lines)", () => {
    expect(extractUpdateCause("\n  AgEnD 2.2 needs Node >=22.14; npm is aborting this install.\n\nnpm error code 1\nnpm error path /p/@songsid/agend")).toBe("AgEnD 2.2 needs Node >=22.14; npm is aborting this install.");
  });
  it("any other npm failure keeps the code line, as before", () => {
    expect(extractUpdateCause("npm error code ENOTEMPTY\nnpm error syscall rename")).toBe("npm error code ENOTEMPTY — npm error syscall rename");
  });
});
