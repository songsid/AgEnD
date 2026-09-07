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
