import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { rotateWebToken } from "../src/web-auth.js";

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const HEARTBEAT = 80;
const GW = "gw.example";

async function startFleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-sse-live-"));
  tempDirs.push(dir);
  const fm = new FleetManager(dir);
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => {});
  (fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: {}, defaults: {}, web: { external_hosts: [GW], gateway_port: 19999 } };
  fm.sseHeartbeatMs = HEARTBEAT;
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  (fm as unknown as { startGatewayServer(port: number): void }).startGatewayServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  await vi.waitFor(() => expect(((fm as unknown as { gatewayServer: Server }).gatewayServer).address()).not.toBeNull());
  const port = (key: string) => (((fm as unknown as Record<string, Server>)[key]).address() as { port: number }).port;
  return { fm, dir, local: port("healthServer"), gateway: port("gatewayServer") };
}

async function stop(fm: FleetManager) {
  for (const key of ["healthServer", "gatewayServer"]) {
    const server = (fm as unknown as Record<string, Server | null>)[key];
    server?.closeAllConnections();
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    (fm as unknown as Record<string, Server | null>)[key] = null;
  }
}

function post(port: number, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method: "POST", headers }, res => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers })); });
    r.on("error", reject);
    r.end(body);
  });
}

async function signIn(fm: FleetManager, port: number, host: string, origin: string): Promise<string> {
  const res = await post(port, "/auth/login", { host, origin, "content-type": "application/json" }, JSON.stringify({ code: fm.issueDashboardLogin()!.display }));
  expect(res.status).toBe(200);
  return String(res.headers["set-cookie"]).split(";")[0]!;
}

/** A real SSE connection: what arrived, and when it ended. */
function openStream(port: number, headers: Record<string, string>) {
  const frames: string[] = [];
  let ended = false;
  const req = request({ host: "127.0.0.1", port, path: "/ui/events", headers }, res => {
    res.on("data", c => frames.push(String(c)));
    res.on("end", () => { ended = true; });
    res.on("close", () => { ended = true; });
  });
  req.on("error", () => { ended = true; });
  req.end();
  return { frames, get ended() { return ended; }, close: () => req.destroy() };
}

const sseCount = (fm: FleetManager) => (fm as unknown as { sseClients: Set<unknown> }).sseClients.size;
const settle = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("a real SSE stream (over real sockets)", () => {
  it("stays registered and keeps beating after the request has been read", async () => {
    const h = await startFleet();
    const token = h.fm.getDashboardAccess().token!;
    const stream = openStream(h.local, { host: "127.0.0.1", "x-agend-token": token });
    await settle(HEARTBEAT * 6);

    expect(sseCount(h.fm)).toBe(1);
    expect(stream.ended).toBe(false);
    expect(stream.frames.length).toBeGreaterThanOrEqual(4);       // the opening frame plus several heartbeats
    stream.close();
    await vi.waitFor(() => expect(sseCount(h.fm)).toBe(0), { timeout: 2000 });
    await stop(h.fm);
  }, 20_000);

  it("ends when the session that opened it is revoked, and leaves nobody registered", async () => {
    const h = await startFleet();
    const origin = `http://127.0.0.1:${h.local}`;
    const cookie = await signIn(h.fm, h.local, `127.0.0.1:${h.local}`, origin);
    const stream = openStream(h.local, { host: `127.0.0.1:${h.local}`, cookie });
    await settle(HEARTBEAT * 3);
    expect(stream.ended).toBe(false);
    expect(sseCount(h.fm)).toBe(1);

    h.fm.revokeWebSessions();

    await vi.waitFor(() => expect(stream.ended).toBe(true), { timeout: 2000 });
    expect(sseCount(h.fm)).toBe(0);
    await stop(h.fm);
  }, 20_000);

  it("ends when web.token is rotated under it", async () => {
    const h = await startFleet();
    const origin = `http://127.0.0.1:${h.local}`;
    const cookie = await signIn(h.fm, h.local, `127.0.0.1:${h.local}`, origin);
    const stream = openStream(h.local, { host: `127.0.0.1:${h.local}`, cookie });
    await settle(HEARTBEAT * 3);
    expect(stream.ended).toBe(false);

    rotateWebToken(h.dir);

    await vi.waitFor(() => expect(stream.ended).toBe(true), { timeout: 2000 });
    expect(sseCount(h.fm)).toBe(0);
    await stop(h.fm);
  }, 20_000);

  it("cannot be used to fill the gateway: revoking the session frees every one of its connections", async () => {
    const h = await startFleet();
    const cookie = await signIn(h.fm, h.gateway, GW, `https://${GW}`);
    const streams = Array.from({ length: 12 }, () => openStream(h.gateway, { host: GW, cookie }));
    await vi.waitFor(() => expect(sseCount(h.fm)).toBe(12), { timeout: 3000 });
    await settle(HEARTBEAT * 3);
    expect(streams.every(s => !s.ended)).toBe(true);

    h.fm.revokeWebSessions();

    await vi.waitFor(() => expect(streams.every(s => s.ended)).toBe(true), { timeout: 3000 });
    expect(sseCount(h.fm)).toBe(0);
    const server = (h.fm as unknown as { gatewayServer: Server }).gatewayServer;
    await vi.waitFor(async () => {
      const open = await new Promise<number>(resolve => server.getConnections((_, n) => resolve(n)));
      expect(open).toBe(0);
    }, { timeout: 4000 });
    await stop(h.fm);
  }, 30_000);
});

describe("shutdown", () => {
  it("writes the session state the debounce was holding", async () => {
    const h = await startFleet();
    const origin = `http://127.0.0.1:${h.local}`;
    const cookie = await signIn(h.fm, h.local, `127.0.0.1:${h.local}`, origin);
    const file = join(h.dir, "web-sessions.json");
    const lastSeenOnDisk = () => JSON.parse(readFileSync(file, "utf8")).sessions[0].lastSeen as number;
    const before = lastSeenOnDisk();

    await settle(30);
    // A request that only touches the session: within the debounce, so not written yet.
    const res = await new Promise<number>(resolve => {
      request({ host: "127.0.0.1", port: h.local, path: "/auth/session", headers: { host: `127.0.0.1:${h.local}`, cookie } }, r => { r.resume(); resolve(r.statusCode ?? 0); }).end();
    });
    expect(res).toBe(200);
    expect(lastSeenOnDisk()).toBe(before);

    await h.fm.stopAll();

    expect(lastSeenOnDisk()).toBeGreaterThan(before);
    await stop(h.fm);
  }, 30_000);
});
