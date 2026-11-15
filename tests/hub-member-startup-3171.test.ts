/** Real paired TLS/WSS + production runtime/member factory and private SQLite. No agent input or directory network. */
import { expect, it, vi } from "vitest";
import { createServer, type Server } from "node:https";
import { request, type Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import { FleetManager } from "../src/fleet-manager.js";
import { tokenEpoch } from "../src/web-session.js";
import { HubRuntime, type HubMemberHost } from "../src/hub/runtime.js";
import { HubServer } from "../src/hub/server.js";
import { HubMemberClient } from "../src/hub/client.js";
import { readHubMemberTls } from "../src/hub/tls.js";
import type { HubMemberFrame } from "../src/hub/types.js";
import { hubRig } from "./helpers/hub-rig.js";

async function outage() {
  const rig = await hubRig();
  const profile = await rig.pair();
  await rig.server.close();
  const received: HubMemberFrame[] = [];
  let restored: HubServer | undefined;
  let refusal: Server | undefined;
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
  return { rig, profile, runtime, states, received, exposures: () => exposures, reports: () => reports, updates: () => updates,
    async refuse(status: number) {
      const tls = readHubMemberTls({ home: rig.root });
      refusal = createServer({ key: tls.keyPem, cert: tls.certificatePem });
      refusal.on("upgrade", (_request, socket) => { socket.end(`HTTP/1.1 ${status} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
      await new Promise<void>(resolve => refusal!.listen(Number(new URL(rig.memberOrigin).port), "127.0.0.1", resolve));
    },
    async restore(failFirstReconcile = false) {
      if (refusal) { await new Promise<void>(resolve => refusal!.close(() => resolve())); refusal = undefined; }
      restored = new HubServer({ home: rig.root, hubId: rig.identity.hubId, memberOrigin: rig.memberOrigin,
        listen: { host: "127.0.0.1", port: Number(new URL(rig.memberOrigin).port) }, pairing: rig.pairing,
        current: () => true, hold: () => {}, receive: async (frame, link) => {
          received.push(frame);
          if (frame.type === "reconcile" && failFirstReconcile) { failFirstReconcile = false; restored!.refreshAuthorization(); return; }
          if (frame.type === "reconcile") return { v: 1, type: "reconcile", requestId: frame.requestId, linkEpoch: link.linkEpoch,
            payload: { receipts: [], nextReceiptSequence: 0, more: false } };
        } });
      await restored.start();
    },
    async close() { await runtime.close(); await restored?.close(); if (refusal) await new Promise<void>(resolve => refusal!.close(() => resolve())); await rig.close(); },
  };
}

it("keeps a paired member mounted through a boot-time outage, then reconciles without a Fleet restart", async () => {
  const f = await outage();
  let fm: any, http: HttpServer | undefined;
  try {
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
  const tls = readHubMemberTls({ home: f.rig.root });
  const server = createServer({ key: tls.keyPem, cert: tls.certificatePem });
  const wss = new WebSocketServer({ noServer: true });
  let reconciles = 0;
  const holds: string[] = [];
  const client = new HubMemberClient({ home: f.rig.memberHome, hubId: f.rig.identity.hubId, memberOrigin: f.rig.memberOrigin,
    allowOfflineStart: true, capabilities: ["welcome-caps-v1"], current: () => true, hold: code => holds.push(code),
    receive: async () => {}, reconcile: async () => { reconciles++; } });
  server.on("upgrade", (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => {
    ws.once("message", () => {
      if (reason === "stop") client.fence();
      else if (reason === "invalid") ws.send("{}"); // Rejected by the real frame parser; close classification matters independently of stopped.
      else ws.close(1008, reason);
    });
  }));
  try {
    await new Promise<void>(resolve => server.listen(Number(new URL(f.rig.memberOrigin).port), "127.0.0.1", resolve));
    await expect(client.start()).rejects.toMatchObject({ code: "unavailable", reasonCode: reason === "stop" ? "unavailable" : reason });
    expect(reconciles).toBe(0);
    if (reason !== "stop") expect(holds).toEqual([reason]);
  } finally {
    await client.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});
