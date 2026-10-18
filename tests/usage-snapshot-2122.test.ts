/**
 * #2122 (Prism R1 P2-4): usageData is one coherent snapshot per instance. While it waits on the next instance (here:
 * B's ledger read, held), a background pass may fold A's old hour into a new rollup and prune it from A's ledger. The
 * report still counts that hour exactly once — from the copies taken together, before the pass moved it.
 * Rig: node:fs/promises' readFile, held for one path until released (every other read is the real one).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hold = vi.hoisted(() => ({ path: "", gate: null as Promise<void> | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = ((path: unknown, ...rest: unknown[]) => (hold.gate && String(path) === hold.path
    ? hold.gate.then(() => (real.readFile as (...a: unknown[]) => unknown)(path, ...rest))
    : (real.readFile as (...a: unknown[]) => unknown)(path, ...rest))) as typeof real.readFile;
  return { ...real, default: { ...real, readFile }, readFile };
});

const { addTurn, emptyLedger } = await import("../src/cache-ledger.js");
const { CacheService } = await import("../src/cache-service.js");
const { buildUsageReport } = await import("../src/usage-report.js");
const { readDays } = await import("../src/usage-rollup.js");

const HOUR = 3_600_000, DAY = 86_400_000;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); hold.gate = null; });

describe("usageData: one coherent snapshot per instance", () => {
  it("A's hour folded and pruned by a pass while B is being read: the report counts it exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-2122s-")); dirs.push(root);
    const t0 = Date.UTC(2026, 9, 18, 12), hourA = t0 - 30 * DAY - (t0 % HOUR);   // inside the 31 days at t0
    const ledgerA = emptyLedger();
    addTurn(ledgerA, { kind: "claude", ino: 1, offset: 0 }, { t: hourA + 60_000, model: "claude-opus-4-5", prompt: 1000, uncached: 100, read: 800, write5m: 50, write1h: 50, write: null, output: 20 }, 0, "default");
    const inst = (name: string) => {
      const dir = join(root, "instances", name); mkdirSync(dir, { recursive: true });
      return { name, backend: "claude-code", workingDirectory: join(root, `wd-${name}`), ledgerPath: join(dir, "cache-ledger.json"), claudeConfigDir: join(root, "claude"), profile: "default" };
    };
    const A = inst("a"), B = inst("b");
    writeFileSync(A.ledgerPath, JSON.stringify(ledgerA));
    writeFileSync(B.ledgerPath, JSON.stringify(emptyLedger()));
    let now = t0, roster = [A];
    const svc = new CacheService({
      instances: () => roster, claudeProjectsDir: () => join(root, "claude", "projects"), claudeKey: (wd) => wd.split("-").pop()!,
      codexSessionsDir: () => join(root, "codex"), listRollouts: () => [], metaPath: join(root, "meta.json"), now: () => now, zone: () => "UTC",
    });
    await svc.kick();                                                    // A loaded; its hour is not old enough to fold yet
    expect(existsSync(join(root, "instances", "a", "usage-days.json"))).toBe(true);

    // Two days on, the hour is past the cutoff. B joins, and its first ledger read is held.
    now = t0 + 2 * DAY; roster = [A, B];
    let release!: () => void;
    hold.path = B.ledgerPath; hold.gate = new Promise<void>(r => { release = r; });
    const data = svc.usageData();                                        // snapshots A, then waits on B; it also starts a pass
    // That pass folds A's hour into a new rollup and prunes it from A's ledger, then waits on B too.
    await vi.waitFor(async () => expect((await readDays(join(root, "instances", "a", "usage-days.json"))).checkpoint).toBe(hourA), { timeout: 5000 });
    release();
    const d = await data;
    const a = d.instances.find(i => i.inst.name === "a")!;
    const report = buildUsageReport({ now, zone: "UTC", range: { kind: "all" }, group: "instance", messages: [], scanning: d.scanning,
      instances: d.instances.map(i => ({ name: i.inst.name, backend: i.inst.backend, team: null, status: i.status, ledger: i.ledger, days: i.days })) });
    expect(report.rows.find(r => r.key === "a")!.requests).toBe(1);
    // And the next answer, after the pass: the hour from the rollup now — still once.
    const next = await svc.usageData();
    const again = buildUsageReport({ now, zone: "UTC", range: { kind: "all" }, group: "instance", messages: [], scanning: next.scanning,
      instances: next.instances.map(i => ({ name: i.inst.name, backend: i.inst.backend, team: null, status: i.status, ledger: i.ledger, days: i.days })) });
    expect([a.days.checkpoint, again.rows.find(r => r.key === "a")!.requests]).toEqual([-1, 1]);
    await svc.stop();
  });
});
