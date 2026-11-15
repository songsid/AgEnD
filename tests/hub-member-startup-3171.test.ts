/** Real paired TLS/WSS + production runtime/member factory and private SQLite. No agent input or directory network. */
import { afterEach, expect, it, vi } from "vitest";
import type { Server } from "node:https";
import { request, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { FleetManager } from "../src/fleet-manager.js";
import { tokenEpoch } from "../src/web-session.js";
import { HubRuntime, type HubMemberHost } from "../src/hub/runtime.js";
import { HubMemberClient } from "../src/hub/client.js";
import type { HubMemberFrame } from "../src/hub/types.js";
import { hubRig } from "./helpers/hub-rig.js";
import { hubListenerPorts } from "./helpers/hub-listener-ports.js";

const leases: ReturnType<typeof hubListenerPorts>[] = [];
afterEach(async () => {
  try { for (const ports of leases.splice(0)) await ports.close(); }
  finally { vi.restoreAllMocks(); }
});
type Upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

async function expectPortOwned(port: number) {
  const competitor = createNetServer();
  try {
    const outcome = await new Promise<string>(resolve => {
      competitor.once("error", error => resolve((error as NodeJS.ErrnoException).code ?? "unknown"));
      competitor.listen(port, "127.0.0.1", () => resolve("stolen"));
    });
    expect(outcome).toBe("EADDRINUSE");
  } finally { if (competitor.listening) await new Promise<void>(resolve => competitor.close(() => resolve())); }
}

async function outage(beforeBind?: (port: number) => Promise<void>) {
  const ports = hubListenerPorts(), port = await ports.next();
  leases.push(ports);
  await beforeBind?.(port);
  const rig = await hubRig({ memberPort: port });
  const profile = await rig.pair();
  // Fixture-only access: retain the real TLS listener while changing its availability/response before upgrade.
  const listener = (rig.server as unknown as { server: Server }).server;
  const handlers = listener.listeners("upgrade") as Upgrade[];
  const upgrade = (handler?: Upgrade) => {
    listener.removeAllListeners("upgrade");
    for (const value of handler ? [handler] : handlers) listener.on("upgrade", value);
  };
  upgrade((_request, socket) => socket.destroy());
  const received: HubMemberFrame[] = rig.received;
  let exposures: Parameters<HubMemberHost["attachExposures"]>[0] = null;
  let reports: unknown = null;
  let updates: Parameters<NonNullable<HubMemberHost["attachUpdates"]>>[0] = null;
  const states: string[] = [];
  const runtime = new HubRuntime({ home: rig.memberHome, version: "2.4.0-beta.3", log: () => {}, member: {
    boundHub: () => rig.identity.hubId,
    agents: () => [{ name: "general", display: "General" }],
    representative: { deliver: async () => false, agentToken: () => "t".repeat(64), attachReports: value => { reports = value; } },
    attachExposures: value => { exposures = value; }, attachAttention: () => {}, pokeAttention: () => {},
    linkState: state => states.push(state),
    updates: { canInstall: async () => false, launch: async () => false, idle: () => false, busy: () => true, notify: () => true },
    attachUpdates: value => { updates = value; },
  } });
  return { rig, profile, runtime, states, received, upgrade, exposures: () => exposures, reports: () => reports, updates: () => updates,
    async refuse(status: number) {
      upgrade((_request, socket) => { socket.end(`HTTP/1.1 ${status} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
    },
    async restore(failFirstReconcile = false) {
      rig.setReceive(async (frame, link) => {
        if (frame.type === "reconcile" && failFirstReconcile) { failFirstReconcile = false; rig.server.refreshAuthorization(); return; }
        if (frame.type === "reconcile") return { v: 1, type: "reconcile", requestId: frame.requestId, linkEpoch: link.linkEpoch,
          payload: { receipts: [], nextReceiptSequence: 0, more: false } };
      });
      upgrade();
    },
    async close() { await runtime.close(); await rig.close(); await ports.close(); },
  };
}

it("keeps a paired member mounted through a boot-time outage, then reconciles without a Fleet restart", async () => {
  const f = await outage(expectPortOwned);
  let fm: any, http: HttpServer | undefined;
  try {
    // Deterministically try to steal the outage address before the Hub is restored.
    await expectPortOwned(Number(new URL(f.rig.memberOrigin).port));
    await f.runtime.apply({ hub_member: { enabled: true } });
    expect(f.states.at(-1)).toBe("offline");
    expect(f.runtime.currentHolds()).toEqual([]);
    const api = f.exposures();
    expect(api, "the owner's local sharing API must remain mounted while offline").not.toBeNull();
    expect(api!.list()).toHaveLength(1);
    expect(f.reports()).toBeTypeOf("function");
    // Real local owner route, using the controller attached by the actual offline member factory.
    fm = new FleetManager(f.rig.memberHome) as any;
    const quiet = () => {}; fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, child: () => fm.logger };
    fm.fleetConfig = { instances: {}, defaults: {} }; fm.startupComplete = true;
    fm.hubUpdates = f.updates();
    fm.initializeWebAuthTokens(); fm.startHealthServer(0);
    await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
    http = fm.healthServer;
    const port = (http!.address() as { port: number }).port;
    const { sessionId } = fm.webSessions.create({ tier: "admin", surface: "local", label: "test", tokenEpoch: tokenEpoch(fm.webToken), owner: { adapterId: "host", userId: "operator" } });
    const consent = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/settings/hub/update-consent", headers: { cookie: `agend_session=${sessionId}` } }, res => {
        const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); req.on("error", reject); req.end();
    });
    expect(consent.status).toBe(200);
    expect(consent.body).toHaveProperty("on", false);
    await f.restore();
    await vi.waitFor(() => expect(f.states.at(-1)).toBe("online"), { timeout: 5_000 });
    expect(f.exposures()).toBe(api);
    expect(f.updates()).toBe(fm.hubUpdates);
    expect(f.received.filter(frame => frame.type === "reconcile")).toHaveLength(1);
    expect(f.received.filter(frame => frame.type === "exposure.snapshot")).toHaveLength(1);
  } finally {
    if (fm) { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    await f.close();
  }
});

it("retains the mounted owner API after a retryable first reconciliation failure", async () => {
  const f = await outage();
  try {
    await f.restore(true);
    await f.runtime.apply({ hub_member: { enabled: true } });
    const api = f.exposures();
    expect(api).not.toBeNull();
    expect(f.runtime.currentHolds()).toEqual([]);
    await vi.waitFor(() => expect(f.states.at(-1)).toBe("online"), { timeout: 5_000 });
    expect(f.exposures()).toBe(api);
    expect(f.received.filter(frame => frame.type === "reconcile")).toHaveLength(2);
  } finally { await f.close(); }
});

it("treats an initial HTTP 503 as an outage and retries it", async () => {
  const f = await outage();
  try {
    await f.refuse(503);
    await f.runtime.apply({ hub_member: { enabled: true } });
    expect(f.runtime.currentHolds()).toEqual([]);
    expect(f.exposures()).not.toBeNull();
    await f.restore();
    await vi.waitFor(() => expect(f.states.at(-1)).toBe("online"), { timeout: 5_000 });
  } finally { await f.close(); }
});

it.each([401, 403])("keeps an initial HTTP %s refusal terminal and detaches the failed mount", async status => {
  const f = await outage();
  try {
    await f.refuse(status);
    await f.runtime.apply({ hub_member: { enabled: true } });
    expect(f.states.at(-1)).toBe("rejected");
    expect(f.exposures()).toBeNull();
    expect(f.reports()).toBeNull();
    expect(f.runtime.currentHolds()).toMatchObject([{ side: "member", code: "service-unavailable" }]);
    await f.restore();
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(f.received).toEqual([]);
    expect(f.states.at(-1)).toBe("rejected");
  } finally { await f.close(); }
});

it.each(["switch off", "shutdown"])("cancels an offline startup retry on %s", async change => {
  const f = await outage();
  try {
    await f.runtime.apply({ hub_member: { enabled: true } });
    expect(f.exposures()).not.toBeNull();
    if (change === "switch off") await f.runtime.apply({ hub_member: { enabled: false } });
    else await f.runtime.close();
    expect(f.exposures()).toBeNull();
    expect(f.reports()).toBeNull();
    await f.restore();
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(f.received).toEqual([]);
    expect(f.states).not.toContain("online");
  } finally { await f.close(); }
});

it.each(["invalid", "revoked", "replaced", "stop"] as const)("rejects offline startup when the first link is %s before welcome", async reason => {
  const f = await outage();
  const wss = new WebSocketServer({ noServer: true });
  let reconciles = 0;
  const holds: string[] = [];
  const client = new HubMemberClient({ home: f.rig.memberHome, hubId: f.rig.identity.hubId, memberOrigin: f.rig.memberOrigin,
    allowOfflineStart: true, capabilities: ["welcome-caps-v1"], current: () => true, hold: code => holds.push(code),
    receive: async () => {}, reconcile: async () => { reconciles++; } });
  f.upgrade((request, socket, head) => wss.handleUpgrade(request, socket, head, ws => {
    ws.once("message", () => {
      if (reason === "stop") client.fence();
      else if (reason === "invalid") ws.send("{}"); // Rejected by the real frame parser; close classification matters independently of stopped.
      else ws.close(1008, reason);
    });
  }));
  try {
    await expect(client.start()).rejects.toMatchObject({ code: "unavailable", reasonCode: reason === "stop" ? "unavailable" : reason });
    expect(reconciles).toBe(0);
    if (reason !== "stop") expect(holds).toEqual([reason]);
  } finally {
    await client.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await f.close();
  }
});
