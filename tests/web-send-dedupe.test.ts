/**
 * #2438 follow-up: the web chat's Retry never delivers a message twice. A send the page repeats with the same clientId
 * (its first reached the agent, but the answer and the live copy were both lost) is answered with the first one's
 * messageId and delivered once. A first that failed is forgotten (its Retry is a new send); one still going is waited
 * for. Keyed by person, chat and clientId; held 10 minutes on a monotonic clock.
 *
 * WebSendDedupe on a fake clock, and the real FleetManager's web server on a scratch home (nothing started: delivery
 * is a spy).
 */
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "agend-send-dedupe-home-"));
process.env.AGEND_HOME = home;

const { WebSendDedupe, WEB_SEND_DEDUPE_MS } = await import("../src/web-send-dedupe.js");
const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");

describe("WebSendDedupe", () => {
  const make = (max?: number) => { let t = 1000; const d = new WebSendDedupe(() => t, WEB_SEND_DEDUPE_MS, max); return { d, step: (ms: number) => { t += ms; } }; };
  it("accepted: the same key is that send for 10 minutes, then a new one", () => {
    const { d, step } = make();
    const first = d.claim("k");
    if (first.kind !== "new") throw new Error(first.kind);
    first.settle("m1");
    step(WEB_SEND_DEDUPE_MS - 1);
    const again = d.claim("k");
    step(1);
    expect([again, d.claim("k").kind]).toEqual([{ kind: "accepted", messageId: "m1" }, "new"]);
  });
  it("failed: forgotten at once, so its Retry is a new send; a second settle changes nothing", () => {
    const { d } = make();
    const first = d.claim("k");
    if (first.kind !== "new") throw new Error(first.kind);
    first.settle(null);
    first.settle("late");
    expect(d.claim("k").kind).toBe("new");
  });
  it("going: a repeat waits for the first, whatever its age, and then reads how it ended", async () => {
    const { d, step } = make();
    const first = d.claim("k");
    if (first.kind !== "new") throw new Error(first.kind);
    step(WEB_SEND_DEDUPE_MS * 3);                                            // a slow wake: still going, never swept
    const repeat = d.claim("k");
    if (repeat.kind !== "going") throw new Error(repeat.kind);
    let woke = false;
    void repeat.settled.then(() => { woke = true; });
    await Promise.resolve();
    expect(woke).toBe(false);
    first.settle("m1");
    await repeat.settled;
    expect([woke, d.claim("k")]).toEqual([true, { kind: "accepted", messageId: "m1" }]);
  });
  it("one key per person, chat and clientId: another person's or another chat's same id is its own send", () => {
    const { d } = make();
    const a = d.claim(WebSendDedupe.key("p1", "w", "c123456789"));
    if (a.kind !== "new") throw new Error(a.kind);
    a.settle("m1");
    expect([d.claim(WebSendDedupe.key("p2", "w", "c123456789")).kind, d.claim(WebSendDedupe.key("p1", "x", "c123456789")).kind,
      d.claim(WebSendDedupe.key("p1", "w", "c123456789")).kind]).toEqual(["new", "new", "accepted"]);
  });
  it("bounded: past the cap the oldest accepted go first; a send still going is never dropped", () => {
    const { d } = make(2);
    const going = d.claim("going");
    for (const k of ["a", "b", "c"]) { const c = d.claim(k); if (c.kind === "new") c.settle(`m-${k}`); }
    expect([going.kind, d.claim("going").kind, d.claim("a").kind, d.claim("c")]).toEqual(["new", "going", "new", { kind: "accepted", messageId: "m-c" }]);
  });
});

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject); r.end(body);
  });
}
let fm: any, port = 0, dir: string;
const write = (sid: string) => ({ cookie: `${WEB_SESSION_COOKIE}=${sid}`, origin: `http://127.0.0.1:${port}`, [WEB_CSRF_HEADER]: csrfTokenFor(sid), "content-type": "application/json" });
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-send-dedupe-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n  b:\n    working_directory: ${dir}\n    backend: claude-code\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
  for (const name of ["a", "b"]) fm.instanceIpcClients.set(name, { connected: true, send: () => true });
}, 30_000);
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
afterEach(() => { vi.restoreAllMocks(); });
const session = () => fm.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!) }).sessionId as string;
let seq = 0;
const newClientId = () => `c${String(++seq).padStart(24, "0")}`;
const send = (sid: string, clientId: string, instance = "a", message = "deploy it") => raw(port, "POST", "/ui/send", write(sid), JSON.stringify({ instance, message, clientId }))
  .then((r) => ({ status: r.status, body: JSON.parse(r.body) }));
const rows = (instance: string, text: string) => fm.webChatHistory.list(instance).filter((m: any) => m.text === text).length;

describe("/ui/send: a repeated clientId is the same send", () => {
  it("accepted, then repeated (the answer was lost): the first one's messageId, delivered and recorded once", async () => {
    const deliver = vi.spyOn(fm, "deliverHumanToInstance").mockImplementation(async () => true);
    const sid = session(), id = newClientId();
    const first = await send(sid, id, "a", "only once");
    const again = await send(sid, id, "a", "only once");
    expect([first.status, again.status, again.body.messageId === first.body.messageId, again.body.repeated, deliver.mock.calls.length, rows("a", "only once")])
      .toEqual([200, 200, true, true, 1, 1]);
  });
  it("failed (not delivered, or delivery threw): forgotten, so its Retry delivers it", async () => {
    const sid = session();
    for (const fail of [async () => false, async () => { throw new Error("socket closed"); }]) {
      const id = newClientId();
      const deliver = vi.spyOn(fm, "deliverHumanToInstance").mockImplementationOnce(fail as never).mockImplementation(async () => true);
      const first = await send(sid, id);
      const retry = await send(sid, id);
      expect([first.status, retry.status, typeof retry.body.messageId, retry.body.repeated, deliver.mock.calls.length]).toEqual([503, 200, "string", undefined, 2]);
      deliver.mockRestore();
    }
  });
  it("a repeat while the first is still going waits for it, and gets its messageId: one delivery", async () => {
    let open!: (v: boolean) => void;
    const deliver = vi.spyOn(fm, "deliverHumanToInstance").mockImplementation(() => new Promise<boolean>((r) => { open = r; }));
    const sid = session(), id = newClientId();
    const first = send(sid, id, "a", "slow wake");
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const repeat = send(sid, id, "a", "slow wake");
    await new Promise((r) => setTimeout(r, 50));
    expect(deliver).toHaveBeenCalledTimes(1);
    open(true);
    const [a, b] = await Promise.all([first, repeat]);
    expect([a.status, b.status, b.body.messageId === a.body.messageId, deliver.mock.calls.length, rows("a", "slow wake")]).toEqual([200, 200, true, 1, 1]);
  });
  it("the same clientId to another chat, or a send without one, is its own message", async () => {
    const deliver = vi.spyOn(fm, "deliverHumanToInstance").mockImplementation(async () => true);
    const sid = session(), id = newClientId();
    const toA = await send(sid, id, "a", "twin");
    const toB = await send(sid, id, "b", "twin");
    const plain = () => raw(port, "POST", "/ui/send", write(sid), JSON.stringify({ instance: "a", message: "no id" })).then((r) => JSON.parse(r.body));
    const [p1, p2] = [await plain(), await plain()];
    expect([toA.body.messageId !== toB.body.messageId, p1.messageId !== p2.messageId, deliver.mock.calls.length]).toEqual([true, true, 4]);
  });
});
