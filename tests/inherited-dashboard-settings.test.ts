import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { csrfTokenFor, tokenEpoch, WebSessionStore } from "../src/web-session.js";
import { dashboardAccessOf, dashboardFeaturesOff } from "../src/dashboard-permissions.js";
import { readDashboardOff } from "../src/dashboard-live.js";
import { dispatchAgentOperation, ToolNotPermittedError } from "../src/agent-endpoint.js";
import { classifyInstanceChange } from "../src/instance-config-impact.js";

const dirs: string[] = [], servers: Server[] = [], gates: any[] = [];
afterEach(async () => { for (const gate of gates.splice(0)) gate.store.close(); for (const server of servers.splice(0)) await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const TOKEN = "scratch-inheritance-token";
async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-inherited-dashboard-")); dirs.push(dir);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, yaml.dump({ defaults: { backend: "claude-code", model: "before", office_access: true, dashboard: { appearance: true, task_board: true, web_settings: true } }, instances: {
    inherited: { working_directory: dir },
    explicit: { working_directory: dir, office_access: true, dashboard: { appearance: true, task_board: true, web_settings: true } },
  } }));
  const fm = new FleetManager(dir) as any; fm.loadConfig(path);
  Object.defineProperty(fm, "webToken", { value: TOKEN, configurable: true });
  const sessions = fm.webSessions = new WebSessionStore();
  fm.promptSettingsChange = vi.fn(async () => {}); fm.settingsSelfConfirmation = () => null;
  fm.startInstanceUnattended = fm.startClassicInstanceUnattended = fm.stopInstance = () => { throw Error("forbidden fleet lifecycle"); };
  fm.handleWebThemeHttp = vi.fn(async () => ({ offices: [] })); fm.admitTaskBoardNotice = vi.fn(() => true);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: "info" };
  const daemons = new Map<string, Daemon>();
  const makeDaemon = (name: string, config: any) => new Daemon(name, config, join(dir, name), false, { binaryName: "claude" } as never, undefined, { child: () => logger } as never);
  for (const name of ["inherited", "explicit"]) {
    const daemon = makeDaemon(name, fm.fleetConfig.instances[name]);
    daemons.set(name, daemon); fm.daemons.set(name, daemon);
  }
  const gate = fm.settingsGate(); gates.push(gate);
  const next = (req: any, res: any, url: URL) => handleSettingsRequest(req, res, url, fm);
  const server = createServer((req, res) => { const url = new URL(req.url!, "http://localhost"); if (gate.handle(req, res, url, next) || next(req, res, url)) return; res.writeHead(404); res.end("{}"); });
  servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const made = sessions.create({ tier: "admin", surface: "local", label: "scratch admin", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "discord", userId: "operator" } });
  let seq = 0;
  const send = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { cookie: `agend_session=${made.sessionId}`, origin: `http://127.0.0.1:${port}`, "x-agend-csrf": csrfTokenFor(made.sessionId), "idempotency-key": `scratch-${++seq}`, "content-type": "application/json" } }, res => { let text = ""; res.setEncoding("utf8"); res.on("data", x => text += x); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) })); });
    req.setTimeout(5000, () => req.destroy(Error("private HTTP timeout"))); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { dir, path, fm, daemons, gate, send, makeDaemon };
}

describe("Settings immediately resolves inherited dashboard access", () => {
  it("default Office off denies the inherited tool and refreshes Settings and spawn-menu state", async () => {
    const f = await rig();
    const owner = f.fm.fleetConfig.instances.inherited;
    expect((await f.send("PUT", "/api/settings/fleet/defaults", { office_access: false })).status).toBe(200);
    expect(f.fm.fleetConfig.instances.inherited).toBe(owner);
    expect((yaml.load(readFileSync(f.path, "utf8")) as any).defaults.office_access).toBe(false);
    await expect(dispatchAgentOperation(f.fm, "inherited", "office-set", { say: "hi" })).rejects.toBeInstanceOf(ToolNotPermittedError);
    expect(f.fm.handleWebThemeHttp).not.toHaveBeenCalled();
    const view = await f.send("GET", "/api/settings/fleet");
    expect(view.body.instances.inherited.office_access).toBe(false);
    expect(view.body.instances.explicit.office_access).toBe(true);
    expect(dashboardFeaturesOff(dashboardAccessOf(f.daemons.get("inherited")!.getConfigSnapshot()))).toContain("office");
    expect(readDashboardOff(f.dir, "inherited", [])).toContain("office");
    expect(readDashboardOff(f.dir, "explicit", [])).not.toContain("office");
  });
  it("enable after default-off asks for confirmation, then applies only that override", async () => {
    const f = await rig();
    expect((await f.send("PUT", "/api/settings/fleet/defaults", { office_access: false })).status).toBe(200);
    const pending = await f.send("PATCH", "/api/settings/fleet/instances/inherited", { office_access: true });
    expect([pending.status, pending.body.result]).toEqual([202, "pending_confirmation"]);
    expect(f.fm.fleetConfig.instances.inherited.office_access).toBe(false);
    expect((await f.gate.store.decide(pending.body.pending_change.id, "confirm", { label: "confirmed", current: () => true })).state).toBe("applied");
    expect(f.fm.fleetConfig.instances.inherited.office_access).toBe(true);
    expect(f.fm.fleetConfig.defaults.office_access).toBe(false);
  });
  it.each(["appearance", "task_board", "web_settings"])("refreshes inherited %s too, preserving explicit on", async feature => {
    const f = await rig();
    expect((await f.send("PUT", "/api/settings/fleet/defaults", { dashboard: { [feature]: false } })).status).toBe(200);
    expect(dashboardFeaturesOff(dashboardAccessOf(f.fm.fleetConfig.instances.inherited))).toContain(feature);
    expect(dashboardFeaturesOff(dashboardAccessOf(f.daemons.get("inherited")!.getConfigSnapshot()))).toContain(feature);
    expect(dashboardFeaturesOff(dashboardAccessOf(f.fm.fleetConfig.instances.explicit))).not.toContain(feature);
  });
  it("does not persist resolved inheritors on later saves or activate a cold default early", async () => {
    const f = await rig();
    await f.send("PUT", "/api/settings/fleet/defaults", { office_access: false, model: "after" });
    expect(f.fm.fleetConfig.instances.inherited.model).toBe("after");
    expect(f.daemons.get("inherited")!.getConfigSnapshot().model).toBe("before");
    expect(classifyInstanceChange(f.daemons.get("inherited")!.getConfigSnapshot(), f.fm.fleetConfig.instances.inherited)).toBe("restart");
    f.fm.saveFleetConfig();
    const raw = yaml.load(readFileSync(f.path, "utf8")) as any;
    expect(raw.instances.inherited.office_access).toBeUndefined(); expect(raw.instances.inherited.model).toBeUndefined();
    const pending = await f.send("PUT", "/api/settings/fleet/defaults", { office_access: true });
    expect(pending.status).toBe(202);
    await f.gate.store.decide(pending.body.pending_change.id, "confirm", { label: "confirmed", current: () => true });
    expect(f.fm.fleetConfig.instances.inherited.office_access).toBe(true);
  });
  it("keeps the task-board-on notice when the immediate refresh precedes reconcile", async () => {
    const f = await rig();
    await f.send("PUT", "/api/settings/fleet/defaults", { dashboard: { task_board: false } });
    const pending = await f.send("PUT", "/api/settings/fleet/defaults", { dashboard: { task_board: true } });
    expect(pending.status).toBe(202);
    expect((await f.gate.store.decide(pending.body.pending_change.id, "confirm", { label: "confirmed", current: () => true })).state).toBe("applied");
    expect(f.fm.admitTaskBoardNotice).toHaveBeenCalledTimes(1);
    expect(f.fm.admitTaskBoardNotice.mock.calls[0][0]).toBe("inherited");
    f.fm.saveFleetConfig(); expect(f.fm.admitTaskBoardNotice).toHaveBeenCalledTimes(1);
  });

  it("refreshes a ClassicBot identity that inherits the fleet permission", async () => {
    const f = await rig();
    const inherited = f.makeDaemon("classic", f.fm.fleetConfig.instances.inherited);
    f.fm.daemons.set("classic", inherited);
    f.fm.classicChannels = { getAll: () => [{ instanceName: "classic" }] };
    expect((await f.send("PUT", "/api/settings/fleet/defaults", { office_access: false })).status).toBe(200);
    expect(dashboardFeaturesOff(dashboardAccessOf(inherited.getConfigSnapshot()))).toContain("office");
    expect(readDashboardOff(f.dir, "classic", [])).toContain("office");
  });

});
