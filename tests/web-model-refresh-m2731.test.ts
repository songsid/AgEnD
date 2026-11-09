import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:worker_threads", async () => ({ Worker: (await import("./helpers/probe-worker.js")).FakeProbeWorker }));
vi.mock("../src/logger.js", async () => ({ createLogger: (await import("./helpers/probe-worker.js")).fakeProbeLogger, rotateLogIfNeeded: vi.fn() }));
vi.mock("../src/backend/factory.js", () => ({ createBackend: () => { throw new Error("no backend on fleet loop"); } }));
import { FakeProbeWorker } from "./helpers/probe-worker.js";
import { FleetManager } from "../src/fleet-manager.js";
let home: string, previous: string | undefined, fm: any;
beforeEach(() => {
  previous = process.env.AGEND_HOME; home = mkdtempSync(join(tmpdir(), "web-model-refresh-")); process.env.AGEND_HOME = home;
  fm = new FleetManager(home); fm.fleetConfig = { defaults: { backend: "claude-code" }, instances: { w: { backend: "claude-code", backend_options: { "claude-code": { credential_profile: "work" } } } } };
  mkdirSync(join(home, "cli-env")); writeFileSync(join(home, "cli-env", "claude-code@work.json"), JSON.stringify({ backend: "claude-code", probedAt: Date.now(), models: [{ id: "sonnet", label: "Sonnet" }] }));
  FakeProbeWorker.reset();
});
afterEach(() => { fm.stopCliEnvProbes(); process.env.AGEND_HOME = previous; if (previous === undefined) delete process.env.AGEND_HOME; rmSync(home, { recursive: true, force: true }); });
describe("explicit web model rediscovery", () => {
  it("opening reads cache; refresh bypasses it and asks vendor with the exact profile", async () => {
    expect(fm.modelCatalogFor("claude-code", "w")[0].id).toBe("sonnet"); expect(FakeProbeWorker.workers).toHaveLength(0);
    FakeProbeWorker.answer = () => ({ models: [{ id: "opus", label: "Opus" }], apiModels: [{ id: "claude-new", label: "New" }] });
    const result = await fm.refreshModelCatalogFor("claude-code", "w");
    expect(result.refreshed).toBe(true); expect(result.models.map((x: any) => x.id)).toEqual(["opus", "claude-new"]);
    expect(FakeProbeWorker.workers[0].input).toMatchObject({ mode: "env", refreshVendorCatalog: true, config: { credentialStoreHome: expect.stringContaining("work") } });
    expect(fm.modelCatalogFor("claude-code", "w")).toEqual(result.models);
    expect(fm.modelCatalogFor("claude-code", null)).toEqual([]);
  });
  it("coalesces the same binding, retires a changed profile and never publishes its old answer", async () => {
    const a = fm.refreshModelCatalogFor("claude-code", "w"), b = fm.refreshModelCatalogFor("claude-code", "w");
    expect(FakeProbeWorker.workers).toHaveLength(1);
    fm.fleetConfig.instances.w.backend_options["claude-code"].credential_profile = "other";
    FakeProbeWorker.workers[0].reply({ models: [{ id: "private-old", label: "Old" }] });
    expect((await a).refreshed).toBe(false); expect((await b).refreshed).toBe(false);
    expect(fm.modelCatalogFor("claude-code", "w")).toEqual([]);
  });
  it("custom providers never fall back to the global login; errors retain only the exact prior list", async () => {
    fm.fleetConfig.instances.w = { backend: "codex", backend_options: { codex: { provider: "own" } } };
    writeFileSync(join(home, "cli-env", "codex.json"), JSON.stringify({ backend: "codex", probedAt: Date.now(), models: [{ id: "foreign", label: "Foreign" }] }));
    expect(fm.modelCatalogFor("codex", "w")).toEqual([]);
    FakeProbeWorker.answer = () => ({ models: [{ id: "own-model", label: "Own" }] });
    expect((await fm.refreshModelCatalogFor("codex", "w")).models[0].id).toBe("own-model");
    expect(FakeProbeWorker.workers[0].input.config.backendOptions).toMatchObject({ provider: "own" });
    FakeProbeWorker.answer = () => { throw new Error("offline"); };
    expect(await fm.refreshModelCatalogFor("codex", "w")).toMatchObject({ refreshed: false, models: [{ id: "own-model" }] });
    expect(FakeProbeWorker.workers).toHaveLength(2);
  });
  it("unknown/deleted/prototype targets never start a probe; replacing an instance retires the result", async () => {
    for (const n of ["missing", "__proto__", "constructor"]) expect((await fm.refreshModelCatalogFor("claude-code", n)).refreshed).toBe(false);
    expect(FakeProbeWorker.workers).toHaveLength(0);
    const pending = fm.refreshModelCatalogFor("claude-code", "w");
    fm.fleetConfig.instances.w = structuredClone(fm.fleetConfig.instances.w);
    FakeProbeWorker.workers[0].reply({ models: [{ id: "old-instance", label: "Old" }] });
    expect((await pending).refreshed).toBe(false); expect(fm.modelCatalogFor("claude-code", "w").map((x: any) => x.id)).not.toContain("old-instance");
  });
  it("failed Claude account fetch never erases the full list even when aliases succeeded", async () => {
    FakeProbeWorker.answer = () => ({ models: [{ id: "opus", label: "Opus" }], apiModels: [{ id: "claude-private", label: "Private" }] });
    await fm.refreshModelCatalogFor("claude-code", "w");
    FakeProbeWorker.answer = () => ({ models: [{ id: "opus", label: "Opus" }], apiModels: [], catalogRefreshFailed: true });
    const result = await fm.refreshModelCatalogFor("claude-code", "w");
    expect(result.refreshed).toBe(false); expect(result.models.map((m: any) => m.id)).toContain("claude-private");
    expect(fm.claudeModelKnown("w", "claude-private", null).known).toBe(true);
  });
  it("replacement after publication cannot inherit the predecessor's private catalog", async () => {
    fm.fleetConfig.instances.w.backend_options["claude-code"].provider = "private";
    FakeProbeWorker.answer = () => ({ models: [{ id: "old-private", label: "Old" }] });
    await fm.refreshModelCatalogFor("claude-code", "w");
    fm.fleetConfig.instances.w = structuredClone(fm.fleetConfig.instances.w);
    expect(fm.modelCatalogFor("claude-code", "w")).toEqual([]);
  });
  it("two different targets using one account serialize their physical workers", async () => {
    fm.fleetConfig.instances.v = structuredClone(fm.fleetConfig.instances.w);
    const a = fm.refreshModelCatalogFor("claude-code", "w"), b = fm.refreshModelCatalogFor("claude-code", "v");
    expect(FakeProbeWorker.workers).toHaveLength(1);
    FakeProbeWorker.workers[0].reply({ models: [{ id: "a", label: "A" }] }); await a;
    for (let n = 0; n < 10 && FakeProbeWorker.workers.length < 2; n++) await Promise.resolve();
    expect(FakeProbeWorker.workers).toHaveLength(2);
    FakeProbeWorker.workers[1].reply({ models: [{ id: "b", label: "B" }] }); expect((await b).refreshed).toBe(true);
  });
  it("published snapshots obey the hard TTL", async () => {
    fm.fleetConfig.instances.w.backend_options["claude-code"].provider = "private";
    FakeProbeWorker.answer = () => ({ models: [{ id: "old-private", label: "Old" }] });
    await fm.refreshModelCatalogFor("claude-code", "w");
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 25 * 3600_000);
    try { expect(fm.modelCatalogFor("claude-code", "w")).toEqual([]); } finally { clock.mockRestore(); }
  });

});
