import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAgentRequest } from "../src/agent-endpoint.js";
import { FleetManager } from "../src/fleet-manager.js";
import { AgentCredentials, agentCredentialPolicy } from "../src/agent-credentials.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agend-agent-generation-")); roots.push(root);
  const fm = new FleetManager(root) as any;
  const path = join(root, "fleet.yaml");
  writeFileSync(path, `defaults:\n  dashboard:\n    task_board: false\ninstances:\n  dev:\n    working_directory: ${JSON.stringify(root)}\n    tool_set: worker\n`);
  fm.loadConfig(path);
  const dir = join(root, "instances", "dev"); mkdirSync(dir, { recursive: true });
  const tokenPath = join(dir, "agent.token");
  const issue = (token: string) => {
    writeFileSync(tokenPath, token, { mode: 0o600 });
    // On the baseline this hook is absent; the held-body assertion still exercises the real endpoint.
    fm.agentCredentials?.issue("dev", token);
  };
  issue("initial-test-token");
  const create = vi.spyOn(fm.lifecycle, "handleCreate").mockImplementation(async (_args: any, respond: any) => respond({ success: true }));
  return { root, fm, issue, create, tokenPath };
}

function request(fm: any, token = "initial-test-token", op = "spawn") {
  const req = Object.assign(new EventEmitter(), { method: "POST", headers: { "x-agend-instance-token": `dev:${token}` }, resume() {} });
  let end!: () => void;
  const done = new Promise<void>(resolve => { end = resolve; });
  const res = { status: 0, body: "", writeHead(status: number) { this.status = status; }, end(body: string) { this.body = body; end(); } };
  handleAgentRequest(req as any, res as any, fm);
  return { res, finish: async () => {
    req.emit("data", Buffer.from(JSON.stringify({ instance: "dev", op, args: { topic_name: "test" } })));
    req.emit("end"); await done;
    return res;
  } };
}

describe("agent credential generations", () => {
  it("refuses an earlier request after a new credential and profile are published", async () => {
    const h = fixture(), held = request(h.fm);
    h.fm.fleetConfig.instances.dev.tool_set = "coordinator";
    h.issue("replacement-test-token");
    expect((await held.finish()).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
    expect((await request(h.fm, "replacement-test-token").finish()).status).toBe(200);
    expect(h.create).toHaveBeenCalledOnce();
  });

  it("invalidates at Settings publication, before any respawn", async () => {
    const h = fixture(), held = request(h.fm);
    h.fm.fleetConfig.instances.dev.tool_set = "coordinator";
    h.fm.saveFleetConfig();
    expect(readFileSync(h.tokenPath, "utf8")).not.toBe("initial-test-token");
    expect((await held.finish()).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
    expect(readFileSync(h.tokenPath, "utf8")).not.toBe("initial-test-token");
    expect((await request(h.fm, readFileSync(h.tokenPath, "utf8")).finish()).status).toBe(200);
  });

  it("does not revive an issuing generation when a published policy is rolled back", async () => {
    const h = fixture(), held = request(h.fm);
    h.fm.fleetConfig.instances.dev.tool_set = "coordinator"; h.fm.saveFleetConfig();
    h.fm.fleetConfig.instances.dev.tool_set = "worker"; h.fm.saveFleetConfig();
    expect((await held.finish()).status).toBe(401);
    expect((await request(h.fm).finish()).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuses a retired generation even if the on-disk token could not be renewed", async () => {
    const h = fixture();
    h.fm.agentCredentialsCache = new AgentCredentials(
      name => agentCredentialPolicy(h.fm.fleetConfig, name), () => null,
    );
    h.fm.agentCredentials.issue("dev", "initial-test-token");
    const held = request(h.fm);
    h.fm.fleetConfig.instances.dev.tool_set = "coordinator"; h.fm.saveFleetConfig();
    expect(readFileSync(h.tokenPath, "utf8")).toBe("initial-test-token");
    expect((await held.finish()).status).toBe(401);
    expect((await request(h.fm).finish()).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("retains current restrictions for a newly issued credential", async () => {
    const h = fixture();
    h.fm.fleetConfig.instances.dev.tool_set = "coordinator"; h.issue("coordinator-test-token");
    const held = request(h.fm, "coordinator-test-token");
    h.fm.fleetConfig.instances.dev.tool_set = "worker"; h.fm.saveFleetConfig();
    expect((await held.finish()).status).toBe(401);
    expect((await request(h.fm, readFileSync(h.tokenPath, "utf8")).finish()).status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("observes inherited dashboard changes, including a return to the former value", async () => {
    const h = fixture(), held = request(h.fm, "initial-test-token", "task");
    h.fm.fleetConfig.defaults.dashboard = { task_board: true };
    h.fm.saveFleetConfig([{ path: ["defaults", "dashboard", "task_board"], value: true }]);
    h.fm.fleetConfig.defaults.dashboard = { task_board: false };
    h.fm.saveFleetConfig([{ path: ["defaults", "dashboard", "task_board"], value: false }]);
    expect((await held.finish()).status).toBe(401);
    expect((await request(h.fm, readFileSync(h.tokenPath, "utf8"), "task").finish()).status).toBe(403);
  });

  it("does not renew a credential for an unrelated Settings save", async () => {
    const h = fixture(); h.fm.fleetConfig.instances.dev.tool_set = "coordinator"; h.issue("initial-test-token");
    const held = request(h.fm);
    h.fm.fleetConfig.instances.dev.display_name = "Updated name"; h.fm.saveFleetConfig();
    expect(readFileSync(h.tokenPath, "utf8")).toBe("initial-test-token");
    expect((await held.finish()).status).toBe(200);
    expect(h.create).toHaveBeenCalledOnce();
  });

  it("retires a credential when stop is queued, before transition cleanup", async () => {
    const h = fixture(), held = request(h.fm);
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const prior = h.fm.lifecycle.runTransition("dev", async () => { started(); await waiting; });
    await entered;
    vi.spyOn(h.fm.lifecycle as any, "stopInTransition").mockResolvedValue(undefined);
    const stopping = h.fm.lifecycle.stop("dev");
    expect((await held.finish()).status).toBe(401);
    expect((await request(h.fm).finish()).status).toBe(401);
    release(); await prior; await stopping;
    expect(h.create).not.toHaveBeenCalled();
  });

  it("requires new issuance after delete and recreation with the same policy", async () => {
    const h = fixture(), held = request(h.fm), config = { ...h.fm.fleetConfig.instances.dev };
    delete h.fm.fleetConfig.instances.dev; h.fm.saveFleetConfig();
    h.fm.fleetConfig.instances.dev = config; h.fm.saveFleetConfig();
    expect((await held.finish()).status).toBe(401);
    expect((await request(h.fm).finish()).status).toBe(401);
    h.issue("recreated-test-token");
    expect((await request(h.fm, "recreated-test-token").finish()).status).toBe(403);
  });

  it("requires an issued generation even when the token file matches", async () => {
    const h = fixture(); h.fm.agentCredentials.invalidate("dev");
    expect((await request(h.fm).finish()).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("retires a Classic room's credential across removal and re-registration", async () => {
    const h = fixture();
    delete h.fm.fleetConfig.instances.dev;
    const rooms: any[] = [{ instanceName: "dev", channelId: "test-room" }];
    h.fm.classicChannels = { getAll: () => rooms };
    h.issue("initial-test-token");
    const held = request(h.fm);
    const room = rooms.pop(); h.fm.reregisterClassicChannels();
    rooms.push(room); h.fm.reregisterClassicChannels();
    expect((await held.finish()).status).toBe(401);
    expect((await request(h.fm).finish()).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("observes a directly changed policy without assigning it to the old credential", async () => {
    const h = fixture(), held = request(h.fm);
    h.fm.fleetConfig.instances.dev.tool_set = "coordinator";
    expect((await held.finish()).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("observes an accepted YAML reload before reconciliation work begins", async () => {
    const h = fixture(), held = request(h.fm);
    writeFileSync(join(h.root, "fleet.yaml"), `instances:\n  dev:\n    working_directory: ${JSON.stringify(h.root)}\n    tool_set: coordinator\n`);
    // Stop after the real loader/validator/publication boundary, before any lifecycle or host work.
    vi.spyOn(h.fm, "migrateOfficeStorage").mockImplementation(() => { throw Error("after publication"); });
    await expect(h.fm.reconcileInstances()).rejects.toThrow("after publication");
    expect(readFileSync(h.tokenPath, "utf8")).not.toBe("initial-test-token");
    expect((await held.finish()).status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuses an admitted real HTTP request when Settings publishes before its body", async () => {
    const h = fixture();
    let admitted!: () => void;
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    const server = createServer((req, res) => { handleAgentRequest(req, res, h.fm); admitted(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const body = JSON.stringify({ instance: "dev", op: "spawn", args: { topic_name: "test" } });
    const port = (server.address() as { port: number }).port;
    let client!: ReturnType<typeof httpRequest>;
    try {
      const response = new Promise<number | undefined>((resolve, reject) => {
        client = httpRequest({ hostname: "127.0.0.1", port, method: "POST", path: "/agent", headers: {
          "x-agend-instance-token": "dev:initial-test-token", "content-length": Buffer.byteLength(body),
        } }, res => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
        client.on("error", reject); client.flushHeaders();
      });
      await admission;
      h.fm.fleetConfig.instances.dev.tool_set = "coordinator"; h.fm.saveFleetConfig();
      client.end(body);
      expect(await response).toBe(401);
      expect(h.create).not.toHaveBeenCalled();
      expect((await request(h.fm, readFileSync(h.tokenPath, "utf8")).finish()).status).toBe(200);
    } finally {
      client?.destroy(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe("credential policy observations", () => {
  it("fails closed when renewal fails, even after policy rollback", () => {
    let policy = "first";
    const credentials = new AgentCredentials(() => policy, () => null);
    credentials.issue("dev", "test-token");
    const issued = credentials.capture("dev", "test-token")!;
    policy = "second"; credentials.observePolicies();
    policy = "first"; credentials.observePolicies();
    expect(credentials.current("dev", "test-token", issued)).toBe(false);
    expect(credentials.capture("dev", "test-token")).toBeNull();
  });

  it("keeps Classic credentials on the actual worker/default-dashboard policy", () => {
    const fleet = { defaults: { tool_set: "full", dashboard: { task_board: true } }, instances: {} } as any;
    const policy = agentCredentialPolicy(fleet, "classic-room", true);
    expect(JSON.parse(policy!)[0]).toBe("worker");
    fleet.defaults.dashboard.task_board = false;
    expect(agentCredentialPolicy(fleet, "classic-room", true)).not.toBe(policy);
    expect(agentCredentialPolicy(fleet, "classic-room", false)).toBeNull();
  });
});
