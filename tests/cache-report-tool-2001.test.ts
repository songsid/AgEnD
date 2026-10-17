/**
 * #2001: get_cache_report — the cache report for an agent.
 * - Who sees what: General, coordinators and full-profile instances read every row and the fleet summary; any other
 *   instance only its own row (naming another is refused).
 * - The answer is bounded: the costliest expiries first, `top` (default 10, at most 50) analysed rows, the rest counted.
 * - Each row carries the TTL as written, the 5m/1h write mix, the effective TTL and gap-miss signal (#2010), the
 *   keep-warm simulation and recommendation, and whether figures are estimates or priced.
 * - From the last scan: the handler runs no process (tool-handlers-never-fork) and the service reuses its report for a
 *   minute or until the next pass.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const deny = (name: string) => (...a: unknown[]) => { hooks.calls.push(`${name} ${String(a[0])}`); throw new Error(`${name} on the fleet loop`); };
  return { ...real, execFileSync: deny("execFileSync"), execSync: deny("execSync"), spawnSync: deny("spawnSync"), spawn: deny("spawn"), execFile: deny("execFile"), exec: deny("exec"), fork: deny("fork") };
});

const { cacheReportForTool, CACHE_REPORT_TOP_DEFAULT } = await import("../src/cache-report-tool.js");
const { outboundHandlers } = await import("../src/outbound-handlers.js");
const { cacheReportScope, resolveToolSet } = await import("../src/tool-permissions.js");
const { CacheService } = await import("../src/cache-service.js");

const sim = (o: Record<string, number> = {}) => ({ pastTtl: 0, expired: 0, rewriteTokens: 0, expiryCost: 0, pings: 0, pingCost: 0, tailPings: 0, tailCost: 0, net: 0, estimated: false, ...o });
const analysis = (cost: number, o: Record<string, unknown> = {}) => ({
  requests: 100, ttlSec: 300, estimate: false, priced: true, models: ["claude-opus-5-5"], gapBuckets: [1, 0, 0, 0, 0, 0, 0],
  sim: sim({ expiryCost: cost, pings: 3, tailPings: 1, pingCost: 0.5, tailCost: 0.25, net: -0.75 }), totalCost: 10, share: cost / 10,
  recommendation: { on: false, reason: "never_expired" }, effectiveTtl: { ttlSec: 3600, fiveMinute: 3600, basis: "measured", sample: 12, misses: 1, rate: 1 / 12 },
  writeMix: { "5m": 3000, "1h": 1000 }, ...o,
});
const ok = (name: string, cost: number, o: Record<string, unknown> = {}) => ({ name, backend: "claude-code", status: "ok", analysis: analysis(cost, o) });
const REPORT = (instances: unknown[]) => ({
  window: "7d", from: Date.UTC(2026, 9, 10), to: Date.UTC(2026, 9, 17), pricesChecked: "2026-10-09", priceSources: [],
  scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 },
  fleet: { expiryCost: 9, saving: 0, recommended: 0, analysed: 3, priced: true, switchTo1h: 1 }, instances,
}) as any;
const FLEET = REPORT([ok("cheap", 1), ok("dear", 5), ok("mid", 3, { recommendation: { on: false, reason: "switch_to_1h" } }),
  { name: "kiro-1", backend: "kiro-cli", status: "credit_billed" }, { name: "twin", backend: "codex", status: "shared", with: ["twin2"] }]);

describe("the answer's shape and bounds", () => {
  it("fleet scope: the summary, rows by expiry cost, every field", () => {
    const out = cacheReportForTool(FLEET, { scope: "fleet", caller: "general" }) as any;
    expect([out.scope, out.window, out.from, out.prices_checked, out.fleet.switchTo1h]).toEqual(["fleet", "7d", "2026-10-10T00:00:00.000Z", "2026-10-09", 1]);
    expect(out.instances.map((r: any) => r.name)).toEqual(["dear", "mid", "cheap"]);
    expect(out.instances[0]).toEqual({
      name: "dear", backend: "claude-code", status: "ok", models: ["claude-opus-5-5"], requests: 100, ttl_written: "5m",
      write_mix: { "5m_tokens": 3000, "1h_tokens": 1000, "1h_share": 0.25 },
      effective_ttl: { ttl: "1h", basis: "measured", five_minute_measured_as: "1h", gap_miss: { gaps: 12, rewritten: 1, rate: 0.0833 } },
      past_ttl: 0, expired: 0, rewrite_tokens: 0, unit: "usd", expiry_cost: 5, share_of_cost: 0.5,
      keep_warm: { pings: 4, pings_after_last_request: 1, ping_cost: 0.75, net: -0.75 },
      recommendation: { on: false, reason: "never_expired" }, estimate: false,
    });
    expect(out.instances[1].recommendation.reason).toBe("switch_to_1h");
    expect(out.other).toEqual([{ name: "kiro-1", backend: "kiro-cli", status: "credit_billed" }, { name: "twin", backend: "codex", status: "shared", with: ["twin2"] }]);
    expect(out.scanning).toEqual({ active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 });
  });
  it("top: default 10, at most 50, the rest counted", () => {
    const many = REPORT(Array.from({ length: 60 }, (_, i) => ok(`i${i}`, i)));
    const d = cacheReportForTool(many, { scope: "fleet", caller: "general" }) as any;
    expect([CACHE_REPORT_TOP_DEFAULT, d.instances.length, d.omitted, d.instances[0].name]).toEqual([10, 10, 50, "i59"]);
    expect((cacheReportForTool(many, { scope: "fleet", caller: "general", top: 2 }) as any).instances.map((r: any) => r.name)).toEqual(["i59", "i58"]);
    expect((cacheReportForTool(many, { scope: "fleet", caller: "general", top: 500 }) as any).instances.length).toBe(50);
  });
  it("an instance filter: that row only, no summary; an unknown name is an error", () => {
    const one = cacheReportForTool(FLEET, { scope: "fleet", caller: "general", instance: "mid" }) as any;
    expect([one.instances.map((r: any) => r.name), one.fleet, one.other]).toEqual([["mid"], undefined, []]);
    expect(cacheReportForTool(FLEET, { scope: "fleet", caller: "general", instance: "nope" })).toEqual({ error: "get_cache_report: no instance named nope" });
    expect((cacheReportForTool(FLEET, { scope: "fleet", caller: "general", instance: "kiro-1" }) as any).other).toEqual([{ name: "kiro-1", backend: "kiro-cli", status: "credit_billed" }]);
  });
  it("own scope: only the caller's row, no summary; naming another is refused", () => {
    const own = cacheReportForTool(FLEET, { scope: "own", caller: "cheap" }) as any;
    expect([own.scope, own.instances.map((r: any) => r.name), own.fleet]).toEqual(["own", ["cheap"], undefined]);
    expect(cacheReportForTool(FLEET, { scope: "own", caller: "cheap", instance: "cheap" })).toMatchObject({ instances: [{ name: "cheap" }] });
    expect((cacheReportForTool(FLEET, { scope: "own", caller: "cheap", instance: "dear" }) as any).error).toMatch(/only your own row \(cheap\)/);
  });
  it("not priced: input-price units", () => {
    const out = cacheReportForTool(REPORT([ok("u", 2, { priced: false })]), { scope: "fleet", caller: "general" }) as any;
    expect(out.instances[0].unit).toBe("input_price_units");
  });
});

describe("who reads the fleet", () => {
  it("full, coordinator and general; worker, standard and minimal read their own row", () => {
    expect(["full", "coordinator", "general", "worker", "standard", "minimal"].map((p) => cacheReportScope(p as never))).toEqual(["fleet", "fleet", "fleet", "own", "own", "own"]);
  });
  it("the handler: General and a coordinator get the fleet; a worker its own row; no process is started", async () => {
    hooks.calls.length = 0;
    const published = vi.fn(async (_w: string) => FLEET);
    const ctx = { fleetConfig: { instances: { lead: { tool_set: "coordinator" }, cheap: {}, gt: { general_topic: true } } }, cacheReportPublished: published } as any;
    const ask = (caller: string, args: Record<string, unknown>) => new Promise<{ result: any; error: string | null }>((resolve) => {
      void outboundHandlers.get("get_cache_report")!(ctx, args, (result: unknown, error?: string) => resolve({ result, error: error ?? null }), { instanceName: caller } as any);
    });
    for (const caller of ["general", "gt", "lead"]) {
      const r = await ask(caller, {});
      expect([r.error, r.result.scope, r.result.instances.length, !!r.result.fleet], caller).toEqual([null, "fleet", 3, true]);
    }
    const w = await ask("cheap", { window: "24h" });
    expect([w.result.scope, w.result.instances.map((x: any) => x.name), w.result.fleet]).toEqual(["own", ["cheap"], undefined]);
    expect(published).toHaveBeenLastCalledWith("24h");
    expect((await ask("cheap", { instance: "dear" })).error).toMatch(/only your own row/);
    expect((await ask("cheap", { window: "1y" })).error).toBeTruthy();
    expect((await ask("cheap", { top: 0 })).error).toBeTruthy();
    expect((await ask("cheap", { extra: 1 })).error).toBeTruthy();
    expect(hooks.calls, "never a process on the fleet loop").toEqual([]);
    expect(resolveToolSet(undefined, "general")).toBe("general");
  });
});

describe("the published report", () => {
  it("reused for a minute and until a catch-up reads something new (the real report, its own catch-up included — Fable #2030 P2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-2001-pub-"));
    try {
      const wd = join(dir, "wd"), proj = join(dir, "projects", "wd-key");
      mkdirSync(proj, { recursive: true });
      let mono = 0;
      const svc = new CacheService({ instances: () => [{ name: "w", backend: "claude-code", workingDirectory: wd, ledgerPath: join(dir, "w.json") }],
        claudeProjectsDir: () => join(dir, "projects"), claudeKey: () => "wd-key", codexSessionsDir: () => join(dir, "sessions"), listRollouts: () => [],
        metaPath: join(dir, "meta.json"), monotonic: () => mono, intervalMs: 3_600_000 });
      const report = vi.spyOn(svc, "report");
      const first = await svc.published("7d");
      await svc.kick();                                                    // the catch-up the report started, finished: nothing new
      mono = 1_000;
      expect(await svc.published("7d"), "an idle fleet: reused after its own catch-up").toBe(first);
      expect(report).toHaveBeenCalledTimes(1);
      expect(await svc.published("24h"), "per window").not.toBe(first);
      copyFileSync(join(process.cwd(), "tests", "fixtures", "cache-1468", "claude-transcript.jsonl"), join(proj, "s1.jsonl"));
      await svc.kick();                                                    // a catch-up that reads a new transcript
      const fresh = await svc.published("7d");
      expect(fresh, "new lines read: a fresh report").not.toBe(first);
      expect(report).toHaveBeenCalledTimes(3);
      await svc.kick(); mono = 59_999;
      expect(await svc.published("7d"), "nothing new since").toBe(fresh);
      mono = 61_000;
      expect(await svc.published("7d"), "a minute old").not.toBe(fresh);
      report.mockImplementationOnce(async () => { throw new Error("boom"); });
      mono = 999_999;
      await expect(svc.published("7d")).rejects.toThrow("boom");
      await expect(svc.published("7d"), "a failure is not kept").resolves.toMatchObject({ window: "7d" });
      await svc.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
