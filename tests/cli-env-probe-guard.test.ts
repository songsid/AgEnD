import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A probe that comes back empty must not blank a catalog we already have.
 *
 * Some probes hit the network — `agy models` fetches with a 5s cap — so a slow
 * moment legitimately returns []. Writing that emptied a good 11-model
 * antigravity cache for the entire 24h TTL, long after the CLI recovered
 * (observed live). `list_models` makes this path reachable on demand rather
 * than once at startup, which is what turns a rare blip into a real hazard.
 *
 * The backend factory is mocked so this is deterministic: no CLI binary needs
 * to exist, and the probe's return value is the thing under test.
 */
const probeCLIEnv = vi.fn();
vi.mock("../src/backend/factory.js", () => ({
  createBackend: () => ({ probeCLIEnv }),
}));

let home: string;
let dataDir: string;
const realHome = process.env.AGEND_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agend-probeguard-"));
  process.env.AGEND_HOME = home;
  dataDir = mkdtempSync(join(tmpdir(), "agend-probeguard-data-"));
  probeCLIEnv.mockReset();
});
afterEach(() => {
  if (realHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

function seed(models: Array<{ id: string }>) {
  mkdirSync(join(home, "cli-env"), { recursive: true });
  writeFileSync(join(home, "cli-env", "antigravity.json"),
    JSON.stringify({ backend: "antigravity", models, currentModel: "old", probedAt: Date.now() }));
}
function cached() {
  return JSON.parse(readFileSync(join(home, "cli-env", "antigravity.json"), "utf-8"));
}
async function makeFleet() {
  const { FleetManager } = await import("../src/fleet-manager.js");
  const fm = new FleetManager(dataDir);
  (fm as any).fleetConfig = { defaults: {}, channel: {}, instances: {} };
  return fm as any;
}

describe("cli-env probe cache", () => {
  it("keeps the known catalog when a probe returns no models", async () => {
    seed([{ id: "gemini-3.6-flash-medium" }, { id: "claude-opus-4-6-thinking" }]);
    probeCLIEnv.mockResolvedValue({ models: [], currentModel: "fresh", version: "1.2.3" });
    const fm = await makeFleet();

    const env = await fm.probeBackend("antigravity");

    // The models survive...
    expect(env.models.map((m: { id: string }) => m.id))
      .toEqual(["gemini-3.6-flash-medium", "claude-opus-4-6-thinking"]);
    expect(cached().models).toHaveLength(2);
    // ...while genuinely fresher fields still land.
    expect(env.currentModel).toBe("fresh");
    expect(cached().currentModel).toBe("fresh");
  });

  it("still replaces the catalog when the probe actually finds models", async () => {
    seed([{ id: "stale-model" }]);
    probeCLIEnv.mockResolvedValue({ models: [{ id: "gemini-4.0-flash-high" }], currentModel: "fresh" });
    const fm = await makeFleet();

    const env = await fm.probeBackend("antigravity");

    // The guard must not freeze the catalog — a real result always wins.
    expect(env.models.map((m: { id: string }) => m.id)).toEqual(["gemini-4.0-flash-high"]);
    expect(cached().models).toHaveLength(1);
  });

  it("writes an empty catalog when there was nothing cached to protect", async () => {
    probeCLIEnv.mockResolvedValue({ models: [] });
    const fm = await makeFleet();

    const env = await fm.probeBackend("antigravity");

    expect(env.models).toEqual([]);
    expect(cached().models).toEqual([]);
  });
});
