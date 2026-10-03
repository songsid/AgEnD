import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendProbeInput } from "../src/backend/cli-env-probe.js";
const { createBackend, listModels, probeCLIEnv, refreshModelCatalog } = vi.hoisted(() => ({
  createBackend: vi.fn(), listModels: vi.fn(), probeCLIEnv: vi.fn(), refreshModelCatalog: vi.fn(),
}));
vi.mock("../src/backend/factory.js", () => ({ createBackend }));
import { runBackendProbe } from "../src/backend/cli-env-probe.js";
const input: BackendProbeInput = { mode: "env", backend: "codex", instanceDir: "/scratch/probe", refreshVendorCatalog: false,
  config: { workingDirectory: "/scratch/project", instanceDir: "/scratch/probe", instanceName: "alpha", model: "custom", backendOptions: { provider: "private" }, mcpServers: {} } };
beforeEach(() => {
  vi.resetAllMocks();
  createBackend.mockReturnValue({ listModels, probeCLIEnv, refreshModelCatalog });
  probeCLIEnv.mockResolvedValue({ models: [], version: "1.2.3" });
  listModels.mockResolvedValue([{ id: "custom", label: "Custom" }]);
});
describe("isolated backend probe entry", () => {
  it("ordinary env probe preserves config without refreshing the vendor catalog", async () => {
    expect(await runBackendProbe(input)).toEqual({ models: [], version: "1.2.3" });
    expect(createBackend).toHaveBeenCalledWith("codex", "/scratch/probe");
    expect(probeCLIEnv).toHaveBeenCalledWith(input.config);
    expect(refreshModelCatalog).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
  });
  it("refreshes vendor data before probing the environment", async () => {
    await runBackendProbe({ ...input, mode: "env", refreshVendorCatalog: true });
    expect(refreshModelCatalog).toHaveBeenCalledOnce();
    expect(refreshModelCatalog.mock.invocationCallOrder[0]).toBeLessThan(probeCLIEnv.mock.invocationCallOrder[0]!);
  });
  it("instance catalog uses listModels and its exact config, never an account env probe", async () => {
    expect(await runBackendProbe({ ...input, mode: "models" })).toEqual([{ id: "custom", label: "Custom" }]);
    expect(listModels).toHaveBeenCalledWith(input.config);
    expect(probeCLIEnv).not.toHaveBeenCalled(); expect(refreshModelCatalog).not.toHaveBeenCalled();
  });
  it("supports backends without optional catalog/probe capabilities", async () => {
    createBackend.mockReturnValue({});
    expect(await runBackendProbe(input)).toBeNull();
    expect(await runBackendProbe({ ...input, mode: "models" })).toEqual([]);
  });
  it("does not probe stale catalog data after a failed vendor refresh", async () => {
    refreshModelCatalog.mockRejectedValue(new Error("offline"));
    await expect(runBackendProbe({ ...input, mode: "env", refreshVendorCatalog: true })).rejects.toThrow("offline");
    expect(probeCLIEnv).not.toHaveBeenCalled();
  });
});
