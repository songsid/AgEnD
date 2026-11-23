/**
 * #4336 (M-3516): reactions waiting for an agent — an Office pat or feed with "Tell" on (message "office"), or a platform
 * reaction — ride its next real message as "[Recent reactions: …]" and are then consumed. A Discord/Telegram message did;
 * a web-chat message (POST /ui/send) did not, and left the rows unconsumed. Now a web send carries the same meta, for a
 * fleet topic and a ClassicBot room alike, and consumes the rows only once the message was accepted: exactly once (the
 * room's or topic's echo is a bot copy the agent is never handed), and a failed delivery keeps them for the next message.
 *
 * The real FleetManager web server on a scratch home (nothing started); its delivery to the instance observed.
 */
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "agend-4336-home-"));
process.env.AGEND_HOME = home;
const { FleetManager } = await import("../src/fleet-manager.js");
const { EventLog } = await import("../src/event-log.js");
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
const payloads: Array<{ instance: string; meta: Record<string, unknown> }> = [];
let refuse = false;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-4336-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n    topic_id: 77\n  room:\n    working_directory: ${dir}\n    backend: claude-code\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  fm.eventLog = new EventLog(join(dir, "events.db"));
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
  for (const n of ["a", "room"]) fm.instanceIpcClients.set(n, { connected: true, send: () => true });
}, 30_000);
afterAll(async () => { await new Promise<void>((r) => fm.healthServer?.close(() => r())); fm.eventLog?.close?.(); rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
afterEach(() => { payloads.length = 0; refuse = false; vi.restoreAllMocks(); });
const session = () => fm.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!) }).sessionId as string;
const write = (sid: string) => ({ cookie: `${WEB_SESSION_COOKIE}=${sid}`, origin: `http://127.0.0.1:${port}`, [WEB_CSRF_HEADER]: csrfTokenFor(sid), "content-type": "application/json" });
/** A web-chat send to `instance`; the delivery to the instance is recorded (and refused when `refuse`). */
async function send(instance: string, message: string) {
  vi.spyOn(fm, "deliverHumanToInstance").mockImplementation(async (...args: unknown[]) => { const [name, payload] = args as [string, any]; payloads.push({ instance: name, meta: { ...payload.meta } }); return !refuse; });
  return raw(port, "POST", "/ui/send", write(session()), JSON.stringify({ instance, message }));
}
const pending = (instance: string) => fm.eventLog.pendingReactions(instance);

describe("a web-chat message carries the agent's pending reactions and consumes them once (#4336)", () => {
  it("a fleet topic: the Office pats and feed ride the first web message, are consumed, and the next carries none", async () => {
    fm.eventLog.addOfficeReaction("a", "Ann", "pat"); fm.eventLog.addOfficeReaction("a", "Ann", "pat"); fm.eventLog.addOfficeReaction("a", "Ann", "feed");
    const summary = pending("a")!.summary;
    expect(summary).toContain("[Office]");
    expect((await send("a", "hello")).status).toBe(200);
    expect((await send("a", "again")).status).toBe(200);
    expect([payloads.map((p) => [p.instance, p.meta.pending_reactions ?? null]), pending("a")]).toEqual([[["a", summary], ["a", null]], null]);
  });
  it("a ClassicBot room the same way: exactly once", async () => {
    vi.spyOn(fm, "isClassicInstance").mockImplementation((...args: unknown[]) => args[0] === "room");
    fm.eventLog.addOfficeReaction("room", "Ann", "feed");
    const summary = pending("room")!.summary;
    expect((await send("room", "hi room")).status).toBe(200);
    expect((await send("room", "hi again")).status).toBe(200);
    expect([payloads.map((p) => p.meta.pending_reactions ?? null), pending("room")]).toEqual([[summary, null], null]);
  });
  it("a delivery that did not go through keeps them for the next message", async () => {
    fm.eventLog.addOfficeReaction("a", "Ann", "pat");
    const summary = pending("a")!.summary;
    refuse = true;
    expect((await send("a", "lost")).status).toBe(503);
    expect(pending("a")?.summary, "still waiting").toBe(summary);
    refuse = false;
    expect((await send("a", "this one")).status).toBe(200);
    expect([payloads.map((p) => p.meta.pending_reactions ?? null), pending("a")]).toEqual([[summary, summary], null]);
  });
  it("a resend of a failed web message (POST /ui/resend) carries them and consumes them once accepted", async () => {
    expect((await send("a", "first try")).status).toBe(200);
    const row = fm.webChatHistory.list("a").find((m: any) => m.messageId && m.text === "first try");
    fm.finishDeliveryStatus("a", "web", row.messageId, "failed");
    fm.eventLog.addOfficeReaction("a", "Ann", "feed");
    const summary = pending("a")!.summary;
    payloads.length = 0;
    const r = await raw(port, "POST", "/ui/resend", write(session()), JSON.stringify({ instance: "a", boot: row.boot, id: row.id, attempt: row.retry.attempt }));
    expect(r.status, r.body).toBe(200);
    expect([payloads.map((p) => p.meta.pending_reactions ?? null), pending("a")]).toEqual([[summary], null]);
  });
});
