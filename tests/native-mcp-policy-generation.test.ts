/** Isolated capability publication/HTTP continuations; no CLI, runner, account or real task writes. */
import { PassThrough } from "node:stream";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { handleAgentRequest } from "../src/agent-endpoint.js";
const roots: string[] = [], managers: any[] = [];
const agentId = "12345678-1234-4321-abcd-123456789012", name = `windows-${agentId}`;
beforeEach(() => vi.stubEnv("AGEND_WINDOWS_CLI", "1"));
afterEach(() => { for (const f of managers.splice(0)) f.nativeMcpSessions().closeAll(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-native-policy-")); roots.push(root);
  const fm: any = new FleetManager(root); managers.push(fm);
  const path = join(root, "fleet.yaml");
  writeFileSync(path, `defaults:\n  dashboard:\n    task_board: true\ninstances:\n  ${name}:\n    runtime: windows\n    native_agent_id: ${agentId}\n    native_sandbox: workspace-write\n    working_directory: 'C:\\Scratch'\n    backend: codex\n    tool_set: minimal\n`);
  fm.loadConfig(path);
  const sessions = fm.nativeMcpSessions(), crud = vi.spyOn(fm, "handleTaskCrudHttp").mockResolvedValue({ items: [] });
  const grant = () => sessions.grant({ instance: name, requestId: randomUUID(), sandbox: "workspace-write", endpoint: "http://127.0.0.1:19280/agent", stillCurrent: () => true });
  return { fm, sessions, crud, grant, lease: grant(), path };
}
const create = () => ({ op: "native-mcp", method: "tools/call", callId: randomUUID(), params: { name: "task", arguments: { action: "create", title: "inert fixture" } } });
function request(f: ReturnType<typeof fixture>, token = f.lease.connection.token, body: unknown = create()) {
  const req = Object.assign(new PassThrough(), { method: "POST", url: "/agent", headers: { "x-agend-native-token": token }, socket: { remoteAddress: "127.0.0.1" } });
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const res: any = { status: 0, body: "", writableEnded: false, writeHead(status: number) { this.status = status; }, end(text: string) { this.body = text; this.writableEnded = true; finish(); } };
  handleAgentRequest(req as any, res, f.fm);
  return { req, res, finish: async () => { req.end(JSON.stringify(body)); await done; return res; } };
}
describe("native capability issuing policy", () => {
  it("keeps an admitted request bound to publication and permits a freshly issued capability", async () => {
    const f = fixture(); expect((await request(f).finish()).status).toBe(403); expect(f.crud).not.toHaveBeenCalled();
    const held = request(f); f.fm.fleetConfig.instances[name].tool_set = "worker"; f.fm.saveFleetConfig();
    expect((await held.finish()).status).toBe(401); expect(f.crud).not.toHaveBeenCalled();
    const fresh = f.grant(); expect((await request(f, fresh.connection.token).finish()).status).toBe(200); expect(f.crud).toHaveBeenCalledOnce();
  });
  it("observes a changed in-memory policy before dispatch even without publication", async () => {
    const f = fixture(), held = request(f); f.fm.fleetConfig.instances[name].tool_set = "worker";
    expect((await held.finish()).status).toBe(401); expect(f.crud).not.toHaveBeenCalled();
  });
  it("does not revive a retired capability after policy rollback or delete/recreate", async () => {
    const f = fixture(), held = request(f);
    f.fm.fleetConfig.instances[name].tool_set = "worker"; f.fm.saveFleetConfig();
    f.fm.fleetConfig.instances[name].tool_set = "minimal"; f.fm.saveFleetConfig();
    expect((await held.finish()).status).toBe(401); expect(f.sessions.hasActive(name)).toBe(false);
    const fresh = f.grant(), config = { ...f.fm.fleetConfig.instances[name] };
    delete f.fm.fleetConfig.instances[name]; f.fm.saveFleetConfig(); f.fm.fleetConfig.instances[name] = config; f.fm.saveFleetConfig();
    expect((await request(f, fresh.connection.token).finish()).status).toBe(401); expect(f.crud).not.toHaveBeenCalled();
  });
  it("does not retire a capability for a display-only change, but lifecycle invalidation retires it synchronously", async () => {
    const f = fixture(); f.fm.fleetConfig.instances[name].display_name = "Updated"; f.fm.saveFleetConfig();
    const listing = { op: "native-mcp", method: "tools/list", params: {} };
    expect((await request(f, f.lease.connection.token, listing).finish()).status).toBe(200);
    const held = request(f); f.fm.lifecycle.invalidate(name);
    expect((await held.finish()).status).toBe(401); expect(f.crud).not.toHaveBeenCalled();
  });
  it("observes inherited dashboard publication and an accepted reload before reconciliation", async () => {
    const f = fixture(); f.lease.close(); f.fm.fleetConfig.instances[name].tool_set = "worker"; f.fm.saveFleetConfig();
    const fresh = f.grant(), held = request(f, fresh.connection.token);
    f.fm.fleetConfig.defaults.dashboard.task_board = false; f.fm.saveFleetConfig([{ path: ["defaults", "dashboard", "task_board"], value: false }]);
    f.fm.fleetConfig.defaults.dashboard.task_board = true; f.fm.saveFleetConfig([{ path: ["defaults", "dashboard", "task_board"], value: true }]);
    expect((await held.finish()).status).toBe(401); expect(f.crud).not.toHaveBeenCalled();
    const next = f.grant(), duringReload = request(f, next.connection.token);
    const raw = nativeInstanceYaml();
    writeFileSync(f.path, `defaults:\n  dashboard:\n    task_board: true\ninstances:\n  ${name}:\n${raw}\n    tool_set: minimal\n`);
    vi.spyOn(f.fm, "migrateOfficeStorage").mockImplementation(() => { throw Error("after publication"); });
    await expect(f.fm.reconcileInstances()).rejects.toThrow("after publication");
    expect((await duringReload.finish()).status).toBe(401);
  });
  it.each([
    ["native_sandbox", "read-only"], ["machine_id", "12345678-1234-4321-abcd-123456789099"],
    ["native_adapter", "pane"], ["working_directory", "C:\\Other"],
  ])("retires an issuing capability when %s changes", async (key, value) => {
    const f = fixture(), held = request(f, f.lease.connection.token, { op: "native-mcp", method: "tools/list", params: {} });
    f.fm.fleetConfig.instances[name][key] = value;
    expect((await held.finish()).status).toBe(401); expect(f.crud).not.toHaveBeenCalled();
  });
  it("retains a capability after a rejected reload", async () => {
    const f = fixture(); writeFileSync(f.path, "instances: {}\n");
    vi.spyOn(f.fm, "notifyFleetError").mockImplementation(() => {});
    expect(await f.fm.reconcileInstances()).toHaveProperty("rejected");
    expect((await request(f, f.lease.connection.token, { op: "native-mcp", method: "tools/list", params: {} }).finish()).status).toBe(200);
    expect(f.sessions.hasActive(name)).toBe(true);
  });
  it("rechecks a real local HTTP request after its headers and before its delayed body", async () => {
    const f = fixture(); let admitted!: () => void; const admission = new Promise<void>(resolve => { admitted = resolve; });
    const server = createServer((req, res) => { handleAgentRequest(req, res, f.fm); admitted(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port, body = JSON.stringify(create()); let client!: ReturnType<typeof httpRequest>;
    try {
      const response = new Promise<number | undefined>((resolve, reject) => {
        client = httpRequest({ hostname: "127.0.0.1", port, path: "/agent", method: "POST", headers: { "x-agend-native-token": f.lease.connection.token, "content-length": Buffer.byteLength(body) } }, res => { res.resume(); res.once("end", () => resolve(res.statusCode)); }); client.on("error", reject); client.flushHeaders();
      });
      await admission; f.fm.fleetConfig.instances[name].tool_set = "worker"; f.fm.saveFleetConfig(); client.end(body);
      expect(await response).toBe(401); expect(f.crud).not.toHaveBeenCalled();
      expect((await request(f, f.grant().connection.token).finish()).status).toBe(200); expect(f.crud).toHaveBeenCalledOnce();
    } finally { client?.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
function nativeInstanceYaml() { return `    runtime: windows\n    native_agent_id: ${agentId}\n    native_sandbox: workspace-write\n    working_directory: 'C:\\Scratch'\n    backend: codex`; }
