/**
 * The web chat's sending state (the user's request), the server's side: /ui/send takes the page's `clientId` for its
 * pending bubble (8–64 of [A-Za-z0-9_-], else 400) and echoes it on the LIVE copy of the message only — never recorded,
 * so neither /ui/history nor a stream's replay ever carries it. A send without one is unchanged.
 * The real FleetManager's web server on a scratch home (nothing started: delivery is a spy).
 */
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "agend-sending-home-"));
process.env.AGEND_HOME = home;

const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject); r.end(body);
  });
}
let fm: any, port = 0, dir: string;
const cookieOf = (sid: string) => `${WEB_SESSION_COOKIE}=${sid}`;
const write = (sid: string) => ({ cookie: cookieOf(sid), origin: `http://127.0.0.1:${port}`, [WEB_CSRF_HEADER]: csrfTokenFor(sid), "content-type": "application/json" });
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-sending-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
});
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
afterEach(() => { vi.restoreAllMocks(); });
const session = () => fm.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!) }).sessionId as string;
/** A live stream client: what it is written, as frames. */
function liveClient() {
  const writes: string[] = [];
  const res = { write: (s: string) => { writes.push(s); return true; }, writableEnded: false, destroyed: false, on() {}, once() {}, end() {} };
  fm.sseClients.add(res);
  return { frames: () => writes.filter((w) => w.includes("event: message")).map((w) => JSON.parse(w.split("data: ")[1]!.split("\n")[0]!)), stop: () => fm.sseClients.delete(res) };
}
function delivering() {
  fm.instanceIpcClients.set("a", { connected: true, send: () => true });
  vi.spyOn(fm, "deliverHumanToInstance").mockImplementation(async () => true);
}

describe("/ui/send and the page's clientId", () => {
  it("echoed on the live copy only: the stream's frame carries it, the recorded row and /ui/history do not", async () => {
    delivering();
    const live = liveClient();
    try {
      const sid = session(), clientId = "c" + "0123456789abcdef01234567";
      const r = await raw(port, "POST", "/ui/send", write(sid), JSON.stringify({ instance: "a", message: "hello", clientId }));
      expect(r.status, r.body).toBe(200);
      const { messageId } = JSON.parse(r.body);
      const frame = live.frames().at(-1);
      const row = fm.webChatHistory.list("a").at(-1);
      const history = JSON.parse((await raw(port, "GET", "/ui/history?instance=a&limit=5", { cookie: cookieOf(sid) })).body).messages.at(-1);
      expect([frame.clientId, frame.messageId, frame.text, Object.hasOwn(row, "clientId"), row.messageId, Object.hasOwn(history, "clientId")])
        .toEqual([clientId, messageId, "hello", false, messageId, false]);
    } finally { live.stop(); }
  });
  it("a send without one is as before: no clientId anywhere", async () => {
    delivering();
    const live = liveClient();
    try {
      const r = await raw(port, "POST", "/ui/send", write(session()), JSON.stringify({ instance: "a", message: "plain" }));
      expect([r.status, Object.hasOwn(live.frames().at(-1), "clientId")]).toEqual([200, false]);
    } finally { live.stop(); }
  });
  it("only 8–64 of [A-Za-z0-9_-]: anything else is refused (400) and nothing is delivered", async () => {
    delivering();
    const sid = session();
    for (const clientId of ["short", "x".repeat(65), "has space 123", "<script>12", 12345678]) {
      const r = await raw(port, "POST", "/ui/send", write(sid), JSON.stringify({ instance: "a", message: "x", clientId }));
      expect(r.status, JSON.stringify(clientId)).toBe(400);
    }
    expect(fm.deliverHumanToInstance).not.toHaveBeenCalled();
  });
});
