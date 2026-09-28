import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `/model` served a model list up to 24h old, and the only thing that refreshed
 * the cache was the startup probe. Because the cache is a file under AGEND_HOME
 * it outlives the process, and a bare `agend restart` restarts the instances
 * inside the *same* manager process — so a newly released model appeared only
 * after `agend stop` + `agend start`.
 *
 * Now `/model` re-probes once the cache passes a staleness threshold, under a
 * deadline, and falls back to the cached list when the probe cannot answer.
 */
const probeCLIEnv = vi.fn();
vi.mock("../src/backend/factory.js", () => ({
  createBackend: () => ({ probeCLIEnv }),
}));

let home: string;
let dataDir: string;
const realHome = process.env.AGEND_HOME;
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agend-modelstale-"));
  process.env.AGEND_HOME = home;
  dataDir = mkdtempSync(join(tmpdir(), "agend-modelstale-data-"));
  probeCLIEnv.mockReset();
});
afterEach(() => {
  if (realHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  vi.useRealTimers();
});

function seed(models: Array<{ id: string }>, ageMs: number) {
  mkdirSync(join(home, "cli-env"), { recursive: true });
  writeFileSync(join(home, "cli-env", "claude-code.json"), JSON.stringify({
    backend: "claude-code", models, currentModel: "old", probedAt: Date.now() - ageMs,
  }));
}

async function makeFleet() {
  const { FleetManager } = await import("../src/fleet-manager.js");
  const fm = new FleetManager(dataDir);
  (fm as any).fleetConfig = { defaults: { backend: "claude-code" }, channel: {}, instances: { w: {} } };
  return fm as any;
}

const ids = (list: Array<{ id: string }>) => list.map(m => m.id);

describe("/model refreshes a stale model list", () => {
  it("serves the cache without probing while it is fresh", async () => {
    seed([{ id: "gpt-5" }], 5 * 60 * 1000);          // 5 minutes old
    const fm = await makeFleet();

    const models = await fm.getModelOptions("w");

    expect(ids(models)).toEqual(["gpt-5"]);
    expect(probeCLIEnv, "a fresh cache must not hit the vendor").not.toHaveBeenCalled();
  });

  it("re-probes once the cache is stale, so a newly released model appears", async () => {
    seed([{ id: "gpt-5" }], 2 * HOUR);               // past the threshold
    probeCLIEnv.mockResolvedValue({ models: [{ id: "gpt-5" }, { id: "gpt-6" }], currentModel: "gpt-6" });
    const fm = await makeFleet();

    const models = await fm.getModelOptions("w");

    expect(probeCLIEnv, "a stale cache must be refreshed").toHaveBeenCalled();
    expect(ids(models)).toContain("gpt-6");
  });

  it("falls back to the cached list when a stale refresh finds nothing", async () => {
    seed([{ id: "gpt-5" }], 2 * HOUR);
    probeCLIEnv.mockRejectedValue(new Error("CLI missing"));
    const fm = await makeFleet();

    const models = await fm.getModelOptions("w");

    expect(ids(models), "a failed refresh must not empty the menu").toEqual(["gpt-5"]);
  });

  it("falls back to the cached list when a stale refresh never answers", async () => {
    vi.useFakeTimers();
    seed([{ id: "gpt-5" }], 2 * HOUR);
    probeCLIEnv.mockImplementation(() => new Promise(() => { /* never settles */ }));
    const fm = await makeFleet();

    const pending = fm.getModelOptions("w");
    await vi.advanceTimersByTimeAsync(17_000);       // past the probe deadline
    const models = await pending;

    expect(ids(models), "a hanging probe must degrade to the cached list").toEqual(["gpt-5"]);
  });

  it("the probe deadline stays above the longest chain of bounded probe steps", async () => {
    // #720's lesson: a constant that is only compared against another constant I
    // declared myself pins nothing. CLI_PROBE_LONGEST_LEAF_MS is the value the
    // claude-code probe's own AbortController uses, so raising that leaf without
    // raising the deadline turns this red — which is the point.
    const { CLI_PROBE_LONGEST_CHAIN_MS } = await import("../src/backend/types.js");
    const { CLI_ENV_PROBE_DEADLINE_MS } = await import("../src/fleet-manager.js");
    // The probe's bounded steps run back to back, so clearing only the longest
    // single leaf (8s) would be false confidence — a 10s deadline passes that
    // check and still truncates the 13s chain. Assert against the derived chain
    // constant: raising either step raises it, so this cannot drift.
    expect(CLI_ENV_PROBE_DEADLINE_MS).toBeGreaterThan(CLI_PROBE_LONGEST_CHAIN_MS);
  });

  it("announces the wait before going to the vendor, so it does not read as a hang", async () => {
    seed([{ id: "gpt-5" }], 2 * HOUR);
    probeCLIEnv.mockResolvedValue({ models: [{ id: "gpt-6" }] });
    const fm = await makeFleet();
    const notices: string[] = [];

    await fm.getModelOptions("w", false, () => notices.push("announced"));

    expect(notices, "a stale refresh must tell the caller it is fetching").toEqual(["announced"]);
  });

  it("stays silent when the cache is fresh (no vendor call, nothing to announce)", async () => {
    seed([{ id: "gpt-5" }], 5 * 60 * 1000);
    const fm = await makeFleet();
    const notices: string[] = [];

    await fm.getModelOptions("w", false, () => notices.push("announced"));

    expect(notices, "a fresh cache must not announce a fetch it is not doing").toEqual([]);
  });

  it("probes when there is no cache at all", async () => {
    probeCLIEnv.mockResolvedValue({ models: [{ id: "gpt-6" }] });
    const fm = await makeFleet();

    const models = await fm.getModelOptions("w");

    expect(probeCLIEnv).toHaveBeenCalled();
    expect(ids(models)).toEqual(["gpt-6"]);
  });

  it("a graceful restart re-probes, so restart is no longer weaker than a cold start", async () => {
    seed([{ id: "gpt-5" }], 2 * HOUR);
    probeCLIEnv.mockResolvedValue({ models: [{ id: "gpt-6" }] });
    const fm = await makeFleet();
    (fm as any).configPath = join(dataDir, "fleet.yaml");

    await fm.restartInstances();                     // no instances: returns early after the probe

    expect(probeCLIEnv, "restart must refresh the CLI env like a cold start does").toHaveBeenCalled();
  });
});

describe("usage hang bounds — #720 LONGEST_SINGLE_FETCH_MS, #724 probe deadline, #725 single-flight", () => {
  // ── #720 ─────────────────────────────────────────────────────────────────
  it("#720: LONGEST_SINGLE_FETCH_MS is the exported constant, not a magic number", async () => {
    const { LONGEST_SINGLE_FETCH_MS, DEFAULT_PROVIDER_DEADLINE_MS } = await import("../src/usage/providers.js");
    expect(typeof LONGEST_SINGLE_FETCH_MS).toBe("number");
    expect(LONGEST_SINGLE_FETCH_MS).toBe(15_000);
    expect(DEFAULT_PROVIDER_DEADLINE_MS).toBeGreaterThan(LONGEST_SINGLE_FETCH_MS);
  });

  it("#720: the probe deadline also exceeds LONGEST_SINGLE_FETCH_MS (keeps chain bound tight)", async () => {
    const { LONGEST_SINGLE_FETCH_MS } = await import("../src/usage/providers.js");
    const { CLI_ENV_PROBE_DEADLINE_MS } = await import("../src/fleet-manager.js");
    expect(CLI_ENV_PROBE_DEADLINE_MS).toBeGreaterThan(LONGEST_SINGLE_FETCH_MS);
  });

  it("#720: every AbortSignal.timeout() in providers.ts uses LONGEST_SINGLE_FETCH_MS or less — no literal > deadline", () => {
    // T1 mutation guard: if a 20_000 literal slips in (larger than the 16s
    // deadline), this test catches it. The test reads the ACTUAL source file
    // so no copied literal can hide from it.
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src = readFileSync(join(process.cwd(), "src/usage/providers.ts"), "utf8");
    // Extract numeric arguments to every AbortSignal.timeout() call.
    const matches = [...src.matchAll(/AbortSignal\.timeout\((\d[\d_]*)\)/g)];
    // There must be at least one — if this fires it means the test is stale.
    expect(matches.length, "expected at least one AbortSignal.timeout() in providers.ts").toBeGreaterThan(0);
    for (const [full, rawArg] of matches) {
      const ms = Number(rawArg.replaceAll("_", ""));
      // No single fetch timeout may exceed LONGEST_SINGLE_FETCH_MS (15s).
      // If it does, a legitimate slow fetch would be cut by the outer deadline
      // (16s) before the fetch's own abort fires — exactly the hang this fixes.
      expect(ms, `${full} exceeds LONGEST_SINGLE_FETCH_MS`).toBeLessThanOrEqual(15_000);
    }
  });

  // ── #724 ─────────────────────────────────────────────────────────────────
  it("#724: claudeApiModelOptions() uses probeBackendBounded, not probeBackend (T7)", async () => {
    // T7 mutation guard: if claudeApiModelOptions() reverts to probeBackend()
    // (no deadline), this spy assertion fails — and a hanging Claude API probe
    // would stall the "More models…" menu indefinitely.
    probeCLIEnv.mockResolvedValue({ models: [], apiModels: [{ id: "claude-opus-5" }] });
    const fm = await makeFleet();

    const bounded = vi.spyOn(fm as any, "probeBackendBounded");

    await (fm as any).claudeApiModelOptions();

    expect(bounded, "claudeApiModelOptions must use the deadline-bounded probe").toHaveBeenCalled();
    expect(bounded).toHaveBeenCalledWith("claude-code");
  });

  it("#724: probeCliEnvs() calls probeBackendBounded (deadline-bounded), not probeBackend", async () => {
    probeCLIEnv.mockResolvedValue({ models: [] });
    const fm = await makeFleet();

    const bounded = vi.spyOn(fm as any, "probeBackendBounded");
    (fm as any).probeCliEnvs();
    await new Promise(r => setTimeout(r, 10));

    expect(bounded, "startup probe must go through the deadline-bounded path").toHaveBeenCalled();
    expect(bounded.mock.calls.length).toBeGreaterThan(0);
  });

  // ── #725 ─────────────────────────────────────────────────────────────────
  it("#725: concurrent probes for the same backend share one in-flight probe", async () => {
    seed([{ id: "cached" }], 2 * HOUR);
    let resolveBoth!: () => void;
    probeCLIEnv.mockImplementation(() => new Promise<{ models: Array<{ id: string }> }>(resolve => {
      resolveBoth = () => resolve({ models: [{ id: "live" }] });
    }));
    const fm = await makeFleet();

    const p1 = fm.getModelOptions("w", false);
    const p2 = fm.getModelOptions("w", false);

    resolveBoth();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(probeCLIEnv, "single-flight: one probe, not two").toHaveBeenCalledTimes(1);
    expect(r1.map((m: { id: string }) => m.id)).toContain("live");
    expect(r2.map((m: { id: string }) => m.id)).toContain("live");
  });

  it("#725: completed probe clears its entry — next concurrent pair starts a fresh probe (T5)", async () => {
    // T5 mutation guard: if the `.finally(() => delete from map)` cleanup is
    // removed, the in-flight entry persists forever. A second pair of concurrent
    // calls would share the stale completed-entry promise rather than starting
    // a new probe — probeCLIEnv would be called once total instead of twice.
    seed([{ id: "stale" }], 2 * HOUR);
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    probeCLIEnv
      .mockImplementationOnce(() => new Promise<{ models: Array<{ id: string }> }>(resolve => {
        resolveFirst = () => resolve({ models: [{ id: "first" }] });
      }))
      .mockImplementationOnce(() => new Promise<{ models: Array<{ id: string }> }>(resolve => {
        resolveSecond = () => resolve({ models: [{ id: "second" }] });
      }));
    const fm = await makeFleet();

    // First pair: concurrent calls share one probe.
    const pa = fm.getModelOptions("w", false);
    const pb = fm.getModelOptions("w", false);
    expect(probeCLIEnv, "first pair: single probe").toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([pa, pb]);

    // Entry must be cleared. Re-seed stale so the second pair also probes.
    seed([{ id: "stale2" }], 2 * HOUR);

    // Second pair: starts a NEW probe (entry was cleared after first completed).
    const pc = fm.getModelOptions("w", false);
    const pd = fm.getModelOptions("w", false);
    expect(probeCLIEnv, "second pair: a new probe started after first completed").toHaveBeenCalledTimes(2);

    resolveSecond();
    await Promise.all([pc, pd]);
  });

  it("#725: deadline-resolved probe (null) also clears entry — next call starts fresh (T5b)", async () => {
    // Most dangerous case: first probe hits deadline → null result → stale list.
    // If the entry is NOT cleared, every subsequent call returns null forever.
    vi.useFakeTimers();
    seed([{ id: "stale" }], 2 * HOUR);
    probeCLIEnv
      .mockImplementationOnce(() => new Promise(() => {})) // never resolves → deadline fires
      .mockResolvedValueOnce({ models: [{ id: "recovered" }] });
    const fm = await makeFleet();
    const { CLI_ENV_PROBE_DEADLINE_MS } = await import("../src/fleet-manager.js");

    // First call: probe hangs → deadline fires → null → falls back to cache.
    const p1 = fm.getModelOptions("w", false);
    await vi.advanceTimersByTimeAsync(CLI_ENV_PROBE_DEADLINE_MS + 10);
    const r1 = await p1;
    expect(r1.map((m: { id: string }) => m.id)).toEqual(["stale"]); // cache fallback

    // Entry must be cleared. Re-seed stale so next call also probes.
    seed([{ id: "stale2" }], 2 * HOUR);

    // Second call must start a new probe.
    vi.useRealTimers();
    const r2 = await fm.getModelOptions("w", false);
    expect(r2.map((m: { id: string }) => m.id)).toContain("recovered");
    expect(probeCLIEnv).toHaveBeenCalledTimes(2);
  });

  it("#725: refresh probe (refreshVendorCatalog=true) bypasses single-flight and runs independently (T4)", async () => {
    // T4 mutation guard: if refresh is incorrectly coalesced with an in-flight
    // normal probe, probeCLIEnv would be called once instead of twice before
    // pNormal resolves — the refresh caller silently gets the already-running
    // result rather than its own triggered probe.
    seed([{ id: "cached" }], 2 * HOUR);
    let resolveNormal!: () => void;
    probeCLIEnv
      .mockImplementationOnce(() => new Promise<{ models: Array<{ id: string }> }>(resolve => {
        resolveNormal = () => resolve({ models: [{ id: "normal" }] });
      }))
      .mockResolvedValueOnce({ models: [{ id: "refreshed" }] });
    const fm = await makeFleet();

    // Start a normal probe (in-flight, not yet resolved).
    const pNormal = fm.getModelOptions("w", false);

    // The refresh must start its own independent probe immediately.
    // (refresh=true is the second arg to getModelOptions — but it also triggers
    //  refreshVendorCatalog which we can verify via probeCLIEnv call count.)
    // Spy on probeBackendBounded to pass refreshVendorCatalog=true directly.
    const refreshEnv = (fm as any).probeBackendBounded("claude-code", { refreshVendorCatalog: true });

    // By this point, both the normal and the refresh probe must have started.
    expect(probeCLIEnv, "refresh must start its own probe, not share the in-flight normal one")
      .toHaveBeenCalledTimes(2);

    resolveNormal();
    await Promise.all([pNormal, refreshEnv]);
  });
});

