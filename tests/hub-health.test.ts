/** Real health route/composer and runtime lifecycle; private homes, inert HTTP boundaries and explicit factory/start gates. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const http = vi.hoisted(() => ({ handler: null as null | ((req: IncomingMessage, res: ServerResponse) => void) }));
vi.mock("node:http", async original => ({ ...await original<typeof import("node:http")>(), createServer: vi.fn((handler) => {
  http.handler ??= handler; return { on: vi.fn(), once: vi.fn(), listen: vi.fn(), close: vi.fn() };
}) }));
// These tests target post-verification mount readiness. No identity, directory, listener or store is opened by a factory.
vi.mock("../src/hub/initialization.js", () => ({ verifyHubInitialization: () => ({}) }));
import { FleetManager } from "../src/fleet-manager.js";
import { HubRuntime } from "../src/hub/runtime.js";
import type { HubMountedService } from "../src/hub/mount.js";

const roots: string[] = [], runtimes: HubRuntime[] = [];
afterEach(async () => { for (const r of runtimes.splice(0)) await r.close(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); http.handler = null; });
const home = () => { const p = mkdtempSync(join(tmpdir(), "agend-hub-health-")); roots.push(p); return p; };
const configuration = { enabled: true, hubId: "00000000-0000-4000-8000-000000000001", name: "Example Hub",
  memberOrigin: "https://hub.example.test:9443", webOrigin: "https://hub.example.test:8443" };
const service = (): HubMountedService => ({ start: async () => {}, fence: () => {}, close: async () => {} });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function runtime(createServer: NonNullable<ConstructorParameters<typeof HubRuntime>[0]['createServer']> = async () => service()) {
  const r = new HubRuntime({ home: home(), log: () => {}, createServer }); runtimes.push(r); return r;
}
function fleet(opts: { enabled?: unknown; level?: "normal" | "elevated" | "critical"; instances?: Record<string, string>; adapters?: Record<string, string>; startup?: boolean; runtime?: HubRuntime } = {}) {
  const root = home(); vi.stubEnv("AGEND_HOME", root); const f = new FleetManager(root) as any;
  f.rawFleetConfig = { hub: { ...configuration, enabled: opts.enabled ?? true } };
  f.fleetConfig = { defaults: {}, instances: Object.fromEntries(Object.keys(opts.instances ?? {}).map(x => [x, {}])) };
  f.getInstanceStatus = (name: string) => opts.instances?.[name] ?? "running";
  f.adapterState = new Map(Object.entries(opts.adapters ?? {}).map(([id, status]) => [id, { status, retryCount: 0 }]));
  f.adapters = new Map(); f.startupComplete = opts.startup ?? true; f.hubRuntime = opts.runtime ?? null;
  const initial = f.memoryPressure.snapshot(); vi.spyOn(f.memoryPressure, "snapshot").mockReturnValue({ ...initial, level: opts.level ?? "critical" });
  vi.spyOn(f.memoryPressure, "advisoryOnly").mockReturnValue(false);
  return f as FleetManager;
}
function request(f: FleetManager) {
  f["startHealthServer"](0); const req = { method: "GET", url: "/health", headers: { host: "localhost" } } as IncomingMessage;
  const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() }; http.handler!(req, res as unknown as ServerResponse);
  return { status: res.writeHead.mock.calls[0]?.[0], body: JSON.parse(res.end.mock.calls[0]![0]) };
}
it.each(["normal", "elevated", "critical"] as const)("serves a ready dedicated Hub at 200 with %s pressure visible as a warning", async level => {
  const r = runtime(); await r.apply({ hub: configuration }); const result = request(fleet({ runtime: r, level }));
  expect(result.status).toBe(200); expect(result.body.status).toBe("ok"); expect(result.body.hub).toEqual({ server: "ready" });
  expect(result.body.hostMemory.level).toBe(level); expect(result.body.warnings).toEqual(level === "normal" ? [] : [`host memory pressure is ${level}`]); expect(result.body.problems).toEqual([]);
});
it.each([undefined, false, "true"])("preserves ordinary-fleet pressure scoring when the Hub switch is %s", enabled => {
  const f = fleet({ enabled: enabled ?? false }); const result = request(f);
  expect(result.status).toBe(503); expect(result.body.status).toBe("degraded"); expect(result.body.hub).toBeUndefined();
  expect(result.body.problems).toContain("host memory pressure is critical");
});
it.each([{ instances: { worker: "running" } }, { adapters: { telegram: "connected" } }])("preserves mixed-fleet pressure scoring (%j)", async extra => {
  const r = runtime(); await r.apply({ hub: configuration }); const result = request(fleet({ runtime: r, ...extra }));
  expect(result.status).toBe(503); expect(result.body.hub.server).toBe("ready"); expect(result.body.problems).toContain("host memory pressure is critical");
});
it("keeps incomplete startup, unavailable Hub, shutdown, crashed agents and disconnected adapters unhealthy", async () => {
  const r = runtime(); await r.apply({ hub: configuration });
  const cases = [fleet({ runtime: r, startup: false }), fleet({}), fleet({ runtime: r, instances: { worker: "crashed" }, level: "normal" }),
    fleet({ runtime: r, adapters: { telegram: "retrying" }, level: "normal" })];
  for (const f of cases) expect(f.getFleetHealth().status).not.toBe("ok");
  const f = fleet({ runtime: r }); (f as any).shuttingDown = true;
  expect(f.getFleetHealth()).toMatchObject({ status: "down", hub: { server: "stopped" } });
  r.fence(); expect(r.serverHealth(configuration)).toBe("stopped");
});
it("never reports ready while a factory or start is held, or for a different configuration", async () => {
  const factoryEntered = deferred(), allowFactory = deferred(), startEntered = deferred(), allowStart = deferred();
  const r = runtime(async () => { factoryEntered.resolve(); await allowFactory.promise; return { ...service(), start: async () => { startEntered.resolve(); await allowStart.promise; } }; });
  expect(r.serverHealth(configuration)).toBe("starting"); const apply = r.apply({ hub: configuration });
  try {
    await factoryEntered.promise;
    expect(r.serverHealth(configuration)).toBe("starting"); expect(request(fleet({ runtime: r })).status).toBe(503);
    allowFactory.resolve(); await startEntered.promise; expect(r.serverHealth(configuration)).toBe("starting");
    allowStart.resolve(); await apply; expect(r.serverHealth(configuration)).toBe("ready");
    expect(r.serverHealth({ ...configuration, name: "Different Hub" })).toBe("starting"); expect(r.serverHealth({ enabled: false })).toBe("off");
  } finally { allowFactory.resolve(); allowStart.resolve(); await apply; }
});
it.each(["factory", "start"])("reports an unavailable Hub when %s fails, without exposing its error", async where => {
  const r = runtime(async () => { if (where === "factory") throw Error("private setup detail"); return { ...service(), start: async () => { throw Error("private setup detail"); } }; });
  await r.apply({ hub: configuration }); const result = request(fleet({ runtime: r, level: "normal" }));
  expect(result.status).toBe(503); expect(result.body).toMatchObject({ status: "down", hub: { server: "unavailable" } });
  expect(JSON.stringify(result.body)).not.toContain("private setup detail");
});
it("keeps unconfirmed cleanup unhealthy and permits a later close retry", async () => {
  let refuse = true; const r = runtime(async () => ({ ...service(), close: async () => { if (refuse) throw Error("held cleanup"); } }));
  try {
    await r.apply({ hub: configuration }); await r.apply({ hub: { ...configuration, name: "Changed" } });
    expect(r.serverHealth({ ...configuration, name: "Changed" })).toBe("unavailable");
  } finally { refuse = false; }
});

it("compares an immutable applied digest even when the caller changes its config object in place", async () => {
  const r = runtime(), current = { ...configuration }; await r.apply({ hub: current });
  expect(r.serverHealth(current)).toBe("ready"); current.name = "Changed in place";
  expect(r.serverHealth(current)).toBe("starting");
});

it("does not hide a failed Hub inside an otherwise healthy mixed fleet", () => {
  const result = request(fleet({ instances: { worker: "running" }, adapters: { telegram: "connected" }, level: "normal" }));
  expect(result.status).toBe(503); expect(result.body.status).toBe("degraded");
  expect(result.body.problems).toContain("Hub server is unavailable");
});
it("retains the ordinary-fleet advisory-only memory policy", () => {
  const f = fleet({ enabled: false }); vi.mocked(f.memoryPressure.advisoryOnly).mockReturnValue(true);
  const result = request(f); expect(result.status).toBe(200); expect(result.body.problems).toEqual([]);
});
it("keeps member-only fleets on the ordinary pressure policy", () => {
  const f = fleet(); (f as any).rawFleetConfig = { hub_member: { enabled: true } };
  const result = request(f); expect(result.status).toBe(503); expect(result.body.hub).toBeUndefined();
  expect(result.body.problems).toContain("host memory pressure is critical");
});
