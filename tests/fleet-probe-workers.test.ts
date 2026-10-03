import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProbeWorker } from "./helpers/probe-worker.js";
vi.mock("node:worker_threads", async () => ({ Worker: (await import("./helpers/probe-worker.js")).FakeProbeWorker }));
vi.mock("../src/logger.js", async () => ({ createLogger: (await import("./helpers/probe-worker.js")).fakeProbeLogger, rotateLogIfNeeded: vi.fn() }));
const { createBackend } = vi.hoisted(() => ({ createBackend: vi.fn(() => { throw new Error("parent backend construction forbidden"); }) }));
vi.mock("../src/backend/factory.js", () => ({ createBackend }));
vi.mock("../src/sd-notify.js", () => ({ sdNotify: vi.fn(), sdNotifyBlocking: vi.fn() }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const forbidden = () => { throw new Error("real child process forbidden in probe regression"); };
  return { ...actual, spawn: forbidden, spawnSync: forbidden, exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden, fork: forbidden };
});
import { CLI_ENV_PROBE_DEADLINE_MS, FleetManager } from "../src/fleet-manager.js";
let home: string;
const previousHome = process.env.AGEND_HOME;
const managers: any[] = [];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const models = (id: string) => [{ id, label: id }];
function fleet(instances: Record<string, any> = {}, defaults: Record<string, any> = {}) {
  const fm = new FleetManager(join(home, "data")) as any;
  fm.fleetConfig = { defaults: { backend: "codex", ...defaults }, instances };
  managers.push(fm); return fm;
}
function cachePath(backend: string) { return join(home, "cli-env", `${backend}.json`); }
function seed(backend: string, id: string) {
  mkdirSync(join(home, "cli-env"), { recursive: true });
  writeFileSync(cachePath(backend), JSON.stringify({ backend, models: models(id), probedAt: Date.now() - 2 * 3600_000 }));
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agend-probe-worker-")); process.env.AGEND_HOME = home;
  FakeProbeWorker.reset(); createBackend.mockClear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  for (const fm of managers.splice(0)) { fm.shuttingDown = true; fm.stopCliEnvProbes(); }
  vi.clearAllTimers(); vi.useRealTimers();
  if (previousHome === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("fleet probe worker coverage and consistency", () => {
  it("startup, global menus, vendor refresh, sysinfo and instance catalogs share one bounded pool", async () => {
    const fm = fleet({ a: { backend: "codex", model: "private" }, b: { backend: "kiro-cli" }, c: { backend: "grok" } }, { backend: "claude-code" });
    fm.probeCliEnvs();
    const account = fm.listModelCatalog({ backend: "muse" });
    const vendor = fm.probeBackendBounded("codex", { refreshVendorCatalog: true });
    const instance = fm.instanceScopedModels("a", "codex");
    fm.refreshBackendCliVersions();
    expect(FakeProbeWorker.workers).toHaveLength(2);
    let maximum = 0;
    for (let index = 0; index < 8; index++) {
      const worker = FakeProbeWorker.workers[index]!;
      expect(worker, `queued worker ${index} must eventually start`).toBeDefined();
      maximum = Math.max(maximum, FakeProbeWorker.workers.filter(w => w.terminate.mock.calls.length === 0).length);
      worker.reply(worker.input.mode === "models" ? models("private") : { models: models(worker.input.backend) });
      await flush();
    }
    expect(maximum).toBe(2);
    expect(FakeProbeWorker.workers).toHaveLength(8); // six ordinary + vendor + instance
    expect((await account).models).toEqual(models("muse"));
    expect((await vendor).models).toEqual(models("codex"));
    expect(await instance).toEqual(models("private"));
    expect(createBackend).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(cachePath("codex"), "utf8")).models).toEqual(models("codex"));
  });

  it("ordinary callers join a vendor flight, explicit refresh keeps its own serialized work", async () => {
    const fm = fleet();
    const normal = fm.probeBackendBounded("codex");
    const vendor = fm.probeBackendBounded("codex", { refreshVendorCatalog: true });
    const vendorAgain = fm.probeBackendBounded("codex", { refreshVendorCatalog: true });
    const sysinfo = fm.probeBackendBounded("codex");
    expect(FakeProbeWorker.workers).toHaveLength(1);
    FakeProbeWorker.workers[0]!.reply({ models: models("old") }); await flush();
    expect(FakeProbeWorker.workers).toHaveLength(2);
    expect(FakeProbeWorker.workers[1]!.input).toMatchObject({ mode: "env", refreshVendorCatalog: true });
    FakeProbeWorker.workers[1]!.reply({ models: models("new") }); await flush();
    expect(FakeProbeWorker.workers).toHaveLength(2);
    expect((await normal).models).toEqual(models("old"));
    for (const p of [vendor, vendorAgain, sysinfo]) expect((await p).models).toEqual(models("new"));
    expect(fm.pendingCliEnvProbes.size).toBe(0); expect(fm.pendingVendorCliEnvProbes.size).toBe(0);
    expect(JSON.parse(readFileSync(cachePath("codex"), "utf8")).models).toEqual(models("new"));
  });

  it("ordinary global requests share one flight even after the worker completes", async () => {
    const fm = fleet();
    const a = fm.probeBackendBounded("codex"), b = fm.probeBackendBounded("codex");
    expect(FakeProbeWorker.workers).toHaveLength(1);
    FakeProbeWorker.workers[0]!.reply({ models: models("shared") }); await flush();
    expect(FakeProbeWorker.workers).toHaveLength(1);
    expect((await a).models).toEqual(models("shared")); expect((await b).models).toEqual(models("shared"));
  });

  it("instance probes retain per-instance/default config, coalesce identical requests and isolate caches", async () => {
    const fm = fleet({
      a: { backend: "codex", working_directory: "/project-a", model: "a-model", backend_options: { codex: { provider: "a", profile: "work" } } },
      b: { backend: "codex", working_directory: "/project-b", model: "b-model" },
    }, { backend_options: { codex: { provider: "b", profile: "home" } } });
    const a = fm.listModelCatalog({ instanceName: "a" });
    const aAgain = fm.listModelCatalog({ instanceName: "a" });
    const b = fm.listModelCatalog({ instanceName: "b" });
    expect(FakeProbeWorker.workers).toHaveLength(2);
    const [wa, wb] = FakeProbeWorker.workers;
    expect(wa!.input).toMatchObject({ mode: "models", instanceDir: fm.getInstanceDir("a"), config: {
      workingDirectory: "/project-a", instanceName: "a", model: "a-model", backendOptions: { provider: "a", profile: "work" }, mcpServers: {},
    } });
    expect(wb!.input.config).toMatchObject({ workingDirectory: "/project-b", model: "b-model", backendOptions: { provider: "b", profile: "home" } });
    expect(wb!.input.instanceDir).not.toBe(wa!.input.instanceDir);
    wa!.reply(models("a-model")); wb!.reply(models("b-model")); await flush();
    expect(FakeProbeWorker.workers).toHaveLength(2);
    expect((await a).models).toEqual(models("a-model")); expect((await aAgain).models).toEqual(models("a-model"));
    expect((await b).models).toEqual(models("b-model"));
    expect(fm.pendingInstanceModelProbes.size).toBe(0);
    expect(existsSync(cachePath("codex"))).toBe(false);
    expect(createBackend).not.toHaveBeenCalled();
  });

  it("a changed provider gets a new snapshot and waits for its predecessor to stop", async () => {
    const options = { provider: "old" };
    const fm = fleet({ a: { backend: "codex", backend_options: { codex: options } } });
    const old = fm.instanceScopedModels("a", "codex");
    options.provider = "new";
    const next = fm.instanceScopedModels("a", "codex");
    expect(FakeProbeWorker.workers).toHaveLength(1);
    expect(FakeProbeWorker.workers[0]!.input.config.backendOptions).toEqual({ provider: "old" });
    FakeProbeWorker.workers[0]!.reply(models("old")); await flush();
    expect(FakeProbeWorker.workers).toHaveLength(2);
    expect(FakeProbeWorker.workers[1]!.input.config.backendOptions).toEqual({ provider: "new" });
    FakeProbeWorker.workers[1]!.reply(models("new"));
    expect(await old).toEqual(models("old")); expect(await next).toEqual(models("new"));
    const again = fm.instanceScopedModels("a", "codex");
    expect(FakeProbeWorker.workers).toHaveLength(3);
    FakeProbeWorker.workers[2]!.reply(models("latest")); expect(await again).toEqual(models("latest"));
  });

  it("instance timeout falls back to the account cache with honest scope/provider warning", async () => {
    seed("codex", "account-model");
    const fm = fleet({ a: { backend: "codex", backend_options: { codex: { provider: "private" } } } });
    const result = fm.listModelCatalog({ instanceName: "a" });
    await vi.advanceTimersByTimeAsync(CLI_ENV_PROBE_DEADLINE_MS);
    // Account cache is stale too: the facade keeps its own bounded refresh.
    expect(FakeProbeWorker.workers).toHaveLength(2);
    FakeProbeWorker.workers[1]!.reply(null);
    const catalog = await result;
    expect(catalog.scope).toBe("global"); expect(catalog.source).toBe("cache");
    expect(catalog.note).toContain("private"); expect(catalog.models).toEqual(models("account-model"));
    expect(fm.pendingInstanceModelProbes.size).toBe(0);
  });

  it("queued requests expire without launching more workers; timeout never writes a late cache result", async () => {
    const fm = fleet();
    const a = fm.probeBackendBounded("codex"), b = fm.probeBackendBounded("grok"), c = fm.probeBackendBounded("muse");
    await vi.advanceTimersByTimeAsync(CLI_ENV_PROBE_DEADLINE_MS);
    expect(await Promise.all([a, b, c])).toEqual([null, null, null]);
    expect(FakeProbeWorker.workers).toHaveLength(2);
    const oldWorker = FakeProbeWorker.workers[0]!;
    const next = fm.probeBackendBounded("codex");
    expect(FakeProbeWorker.workers).toHaveLength(3);
    oldWorker.reply({ models: models("late") });
    expect(existsSync(cachePath("codex"))).toBe(false);
    expect(fm.pendingCliEnvProbes.size).toBe(1);
    FakeProbeWorker.workers[2]!.reply({ models: models("fresh") });
    expect((await next).models).toEqual(models("fresh"));
    expect(JSON.parse(readFileSync(cachePath("codex"), "utf8")).models).toEqual(models("fresh"));
  });

  it.each(["error", "exit", "failure", "null", "construction"])("cleans up %s failures and permits a fresh probe", async kind => {
    const fm = fleet();
    if (kind === "construction") FakeProbeWorker.constructionError = new Error("bad worker path");
    const pending = fm.probeBackendBounded("codex");
    const worker = FakeProbeWorker.workers[0];
    if (kind === "error") worker!.emit("error", new Error("crashed"));
    if (kind === "exit") worker!.emit("exit", 1);
    if (kind === "failure") worker!.emit("message", { ok: false, error: "offline" });
    if (kind === "null") worker!.reply(null);
    expect(await pending).toBeNull(); await flush();
    expect(fm.pendingCliEnvProbes.size).toBe(0); expect(existsSync(cachePath("codex"))).toBe(false);
    FakeProbeWorker.constructionError = undefined;
    const fresh = fm.probeBackendBounded("codex");
    FakeProbeWorker.workers.at(-1)!.reply({ models: models("ok") });
    expect((await fresh).models).toEqual(models("ok"));
  });

  it("a cache write failure cleans the flight rather than rejecting a model command", async () => {
    const fm = fleet();
    const writer = vi.spyOn(fm, "persistCliEnvProbeResult").mockImplementationOnce(() => { throw new Error("read-only disk"); });
    const failed = fm.probeBackendBounded("codex"); FakeProbeWorker.workers[0]!.reply({ models: models("first") });
    expect(await failed).toBeNull(); await flush();
    expect(fm.pendingCliEnvProbes.size).toBe(0);
    writer.mockRestore();
    const next = fm.probeBackendBounded("codex"); FakeProbeWorker.workers[1]!.reply({ models: models("next") });
    expect((await next).models).toEqual(models("next"));
  });

  it.each(["reject", "throw"])("termination %s retains capacity until an actual exit", async kind => {
    const fm = fleet();
    const first = fm.probeBackendBounded("codex");
    const worker = FakeProbeWorker.workers[0]!;
    if (kind === "reject") worker.terminate.mockRejectedValue(new Error("not stopped"));
    else worker.terminate.mockImplementation(() => { throw new Error("not stopped"); });
    worker.reply({ models: models("one") }); expect((await first).models).toEqual(models("one"));
    const next = fm.probeBackendBounded("codex"); await flush();
    expect(FakeProbeWorker.workers).toHaveLength(1);
    worker.emit("exit", 0); await flush();
    expect(FakeProbeWorker.workers).toHaveLength(2);
    FakeProbeWorker.workers[1]!.reply({ models: models("two") }); expect((await next).models).toEqual(models("two"));
  });

  it("stop cancels queues and invalidates results already received but not yet committed", async () => {
    const fm = fleet({ a: { backend: "codex" } });
    const first = fm.probeBackendBounded("codex");
    const instance = fm.instanceScopedModels("a", "codex");
    const queued = fm.probeBackendBounded("muse");
    FakeProbeWorker.workers[0]!.reply({ models: models("previous epoch") });
    FakeProbeWorker.workers[1]!.reply(models("previous instance epoch"));
    // Let the pool receive both results, but stop before the caller's next
    // microtask can commit them. Cancellation alone can no longer hide a
    // missing epoch fence. Keep shuttingDown=false to isolate that fence.
    await Promise.resolve();
    fm.stopCliEnvProbes();
    expect(await first).toBeNull(); expect(await instance).toEqual([]); expect(await queued).toBeNull();
    expect(existsSync(cachePath("codex"))).toBe(false);
    expect(fm.pendingCliEnvProbes.size).toBe(0); expect(fm.pendingInstanceModelProbes.size).toBe(0);
    expect(FakeProbeWorker.workers).toHaveLength(2);
    await flush();
    const fresh = fm.probeBackendBounded("codex"); FakeProbeWorker.workers[2]!.reply({ models: models("new epoch") });
    expect((await fresh).models).toEqual(models("new epoch"));
  });

  it("old flight cleanup cannot remove replacement flights after a generation change", async () => {
    const fm = fleet({ a: { backend: "codex" } });
    const old = fm.probeBackendBounded("codex");
    const oldInstance = fm.instanceScopedModels("a", "codex");
    fm.stopCliEnvProbes();
    const fresh = fm.probeBackendBounded("codex");
    const freshInstance = fm.instanceScopedModels("a", "codex");
    expect(await old).toBeNull(); expect(await oldInstance).toEqual([]); await flush();
    expect(fm.pendingCliEnvProbes.size).toBe(1);
    expect(fm.pendingInstanceModelProbes.size).toBe(1);
    const join = fm.probeBackendBounded("codex");
    const joinInstance = fm.instanceScopedModels("a", "codex");
    expect(FakeProbeWorker.workers).toHaveLength(4);
    FakeProbeWorker.workers[2]!.reply({ models: models("new") });
    FakeProbeWorker.workers[3]!.reply(models("private-new"));
    expect((await fresh).models).toEqual(models("new")); expect((await join).models).toEqual(models("new"));
    expect(await freshInstance).toEqual(models("private-new")); expect(await joinInstance).toEqual(models("private-new"));
  });

  it("fleet shutdown invokes probe cleanup before its first asynchronous lifecycle boundary", async () => {
    const fm = fleet();
    const pending = fm.probeBackendBounded("codex");
    // All lifecycle/process effects are stubbed; stop at the first await.
    fm.stormWindow.shutdown = vi.fn(); fm.spawnGate.shutdown = vi.fn();
    if (fm.memoryPressure) fm.memoryPressure.stop = vi.fn();
    fm.shutdownLoginWindows = vi.fn().mockRejectedValue(new Error("test boundary"));
    await expect(fm.stopAll()).rejects.toThrow("test boundary");
    expect(FakeProbeWorker.workers[0]!.terminate).toHaveBeenCalledOnce(); expect(await pending).toBeNull();
    expect(fm.pendingCliEnvProbes.size).toBe(0);
    expect(await fm.probeBackendBounded("muse")).toBeNull();
    expect(FakeProbeWorker.workers).toHaveLength(1);
  });
});
