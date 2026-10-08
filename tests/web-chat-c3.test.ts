import { installTmuxProcessFixture } from "./helpers/tmux-process-stub.js";
installTmuxProcessFixture();
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelStatus } from "../src/daemon.js";
import { fire, settle } from "./helpers/mini-dom.js";
import type { AppPage } from "./helpers/app-harness.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { isWebMessageId, newWebMessageId, nextDeliveryState, WebChatHistory, type WebDeliveryState } from "../src/web-chat-history.js";
import { csrfTokenFor } from "../src/web-session.js";

/**
 * Web track C3 — what Telegram shows while an agent works, in the web chat: delivery ticks under the web
 * user's messages (the reactions a Telegram message gets), a "working" line for the open chat, and a Stop
 * that does what the cancel button and /cancel do. Expectations are written out by hand.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "c3-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const STATES: WebDeliveryState[] = ["queued", "processing", "cancelled", "delivered", "failed"];

describe("the order a message moves through", () => {
  it("never moves back; delivered and failed are final; cancelled gives way to what the agent got", () => {
    // [prev, next] → result, every pair written out.
    const table: Record<string, WebDeliveryState> = {
      "queued>queued": "queued", "queued>processing": "processing", "queued>cancelled": "cancelled", "queued>delivered": "delivered", "queued>failed": "failed",
      "processing>queued": "processing", "processing>processing": "processing", "processing>cancelled": "cancelled", "processing>delivered": "delivered", "processing>failed": "failed",
      "cancelled>queued": "cancelled", "cancelled>processing": "cancelled", "cancelled>cancelled": "cancelled", "cancelled>delivered": "delivered", "cancelled>failed": "failed",
      "delivered>queued": "delivered", "delivered>processing": "delivered", "delivered>cancelled": "delivered", "delivered>delivered": "delivered", "delivered>failed": "delivered",
      "failed>queued": "failed", "failed>processing": "failed", "failed>cancelled": "failed", "failed>delivered": "failed", "failed>failed": "failed",
    };
    for (const prev of STATES) for (const next of STATES) expect(nextDeliveryState(prev, next), `${prev}>${next}`).toBe(table[`${prev}>${next}`]);
    for (const next of STATES) expect(nextDeliveryState(undefined, next)).toBe(next);
    expect(nextDeliveryState("queued", "received" as WebDeliveryState), "not a web state").toBe("queued");
    expect(nextDeliveryState(undefined, "__proto__" as WebDeliveryState)).toBeUndefined();
  });

  it("the page keeps exactly the same order (chat-render.js)", () => {
    const R = renderApi();
    for (const prev of [undefined, ...STATES]) for (const next of STATES) {
      expect(R.nextDeliveryState(prev, next), `${prev}>${next}`).toBe(nextDeliveryState(prev, next));
    }
    expect(R.nextDeliveryState("queued", "constructor")).toBe("queued");
    expect(R.nextDeliveryState(undefined, "toString")).toBeUndefined();
  });
});

describe("web message ids", () => {
  it("are unique, never a platform id, and recognised as the web chat's", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newWebMessageId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^web-[0-9a-z]+-[0-9a-f]{8}$/);
      expect(isWebMessageId(id)).toBe(true);
    }
    for (const platform of ["12345", "1172345678901234567", "", "webhook-1"]) expect(isWebMessageId(platform), platform).toBe(false);
  });
});

describe("WebChatHistory: delivery state", () => {
  const h = () => new WebChatHistory({ boot: "b" });
  const say = (x: WebChatHistory, messageId?: string, instance = "w") => x.record({ instance, sender: messageId ? "web-user" : "agent", text: "t", ts: "1", messageId });

  it("keeps the message id it was sent under (bounded) and moves its state forward only", () => {
    const x = h();
    say(x, "web-a");
    expect(x.list("w")[0]!.messageId).toBe("web-a");
    expect(say(x, "w".repeat(100)).messageId).toHaveLength(64);
    expect(x.setDelivery("w", "web-a", "processing")!.delivery).toBe("processing");
    expect(x.setDelivery("w", "web-a", "queued"), "late queued: no change, nothing to tell").toBeNull();
    expect(x.setDelivery("w", "web-a", "delivered")!.delivery).toBe("delivered");
    expect(x.setDelivery("w", "web-a", "delivered"), "twice").toBeNull();
    expect(x.setDelivery("w", "web-nope", "delivered"), "unknown id").toBeNull();
    expect(x.setDelivery("other", "web-a", "failed"), "another instance's").toBeNull();
    expect(x.list("w")[0]!.delivery).toBe("delivered");
    // It is part of what history and replay serve.
    expect(x.after(0)[0]).toMatchObject({ messageId: "web-a", delivery: "delivered" });
  });

  it("a Stop marks only the web user's messages still waiting — back from the newest, up to one that got further", () => {
    const x = h();
    say(x, "web-old");                 // nothing reported, but older than a delivered one: not waiting any more
    say(x, "web-1"); x.setDelivery("w", "web-1", "delivered");
    say(x);                            // the agent's reply: not ours to mark
    say(x, "web-2"); x.setDelivery("w", "web-2", "queued");
    say(x, "web-3");
    say(x, "web-z", "other");
    expect(x.cancelPending("w").map(m => m.messageId)).toEqual(["web-2", "web-3"]);
    expect(x.list("w").map(m => m.delivery)).toEqual([undefined, "delivered", undefined, "cancelled", "cancelled"]);
    expect(x.list("other")[0]!.delivery, "another chat").toBeUndefined();
    expect(x.cancelPending("w"), "nothing left waiting").toEqual([]);
    // A delivery already under way when Stop came: what the agent got wins.
    expect(x.setDelivery("w", "web-3", "delivered")!.delivery).toBe("delivered");
  });

  it("a processing message is past the queue: Stop leaves it and everything before it", () => {
    const x = h();
    say(x, "web-1");
    say(x, "web-2"); x.setDelivery("w", "web-2", "processing");
    say(x, "web-3");
    expect(x.cancelPending("w").map(m => m.messageId)).toEqual(["web-3"]);
  });
});

describe("the daemon reports a web message's delivery even with no platform chat", () => {
  it("channelStatus", () => {
    expect(channelStatus({ chat_id: "", message_id: "web-a", source: "web" })).toEqual({ chatId: "", messageId: "web-a" });
    expect(channelStatus({ chat_id: "-100", message_id: "web-a", source: "web", thread_id: "7" })).toEqual({ chatId: "-100", messageId: "web-a", threadId: "7" });
    // Unchanged for everything else.
    expect(channelStatus({ chat_id: "", message_id: "55" })).toBeUndefined();
    expect(channelStatus({ chat_id: "", message_id: "55", source: "telegram" })).toBeUndefined();
    expect(channelStatus({ chat_id: "-100", message_id: "", source: "web" })).toBeUndefined();
    expect(channelStatus({ chat_id: "-100", message_id: "55" })).toEqual({ chatId: "-100", messageId: "55" });
  });
});

// ── the fleet ───────────────────────────────────────────────────────────────────────────────────────────────

async function bareFleet() {
  const { FleetManager } = await import("../src/fleet-manager.js");
  const fm = new FleetManager(dir);
  const any = fm as unknown as Record<string, any>;
  const events: Array<{ event: string; data: any }> = [];
  const broadcast = fm.emitSseEvent.bind(fm);
  vi.spyOn(fm, "emitSseEvent").mockImplementation((event: string, data: unknown) => { events.push({ event, data }); broadcast(event, data); });
  return { fm, any, events };
}

describe("FleetManager: delivery reports for web messages", () => {
  it("become the message's ticks and a `delivery` event — never a platform reaction", async () => {
    const { fm, any, events } = await bareFleet();
    const reacted: unknown[] = [];
    any.adapter = { id: "tg", sendText: async () => ({}), react: async (...a: unknown[]) => { reacted.push(a); } };
    any.queueDeliveryStatusReaction = (...a: unknown[]) => reacted.push(a);
    fm.emitSseEvent("message", { instance: "w", sender: "web-user", text: "hi", ts: "1", messageId: "web-a" });
    expect(fm.webChatHistory.list("w")[0]!.messageId).toBe("web-a");

    fm.reactMessageStatus("w", "-100", "web-a", "queued");
    fm.reactMessageStatus("w", "-100", "web-a", "processing");
    fm.reactMessageStatus("w", "-100", "web-a", "queued");          // late: no event
    fm.finishDeliveryStatus("w", "-100", "web-a", "delivered");
    fm.reactMessageStatus("w", "-100", "web-a", "received");        // not a web state
    expect(events.filter(e => e.event === "delivery").map(e => e.data)).toEqual([
      { instance: "w", messageId: "web-a", delivery: "queued" },
      { instance: "w", messageId: "web-a", delivery: "processing" },
      { instance: "w", messageId: "web-a", delivery: "delivered" },
    ]);
    expect(fm.webChatHistory.list("w")[0]!.delivery).toBe("delivered");
    expect(reacted).toEqual([]);

    // A platform message still gets its reaction, and no web event.
    any.resolveStatusEmojisFor = () => ({ platform: "telegram", queued: "👀", processing: "👀", delivered: "👀", failed: "👎" });
    fm.reactMessageStatus("w", "-100", "42", "queued");
    expect(reacted).toHaveLength(1);
    expect(events.filter(e => e.event === "delivery")).toHaveLength(3);
  });

  it("a cancel marks the waiting web messages cancelled, on every page", async () => {
    const { fm, any, events } = await bareFleet();
    const escapes: string[] = [];
    const order: string[] = [];
    // The daemon's clearPendingDeliveries is where #1199 lives: the human turn is cancelled (no reply nag, no
    // resume) BEFORE the interrupt key — the same order as Telegram's cancel button and /cancel.
    any.daemons.set("w", { sendEscape: async () => { escapes.push("w"); order.push("escape"); }, clearPendingDeliveries() { order.push("clear"); } });
    any.clearCancelButton = () => {};
    fm.emitSseEvent("message", { instance: "w", sender: "web-user", text: "1", ts: "1", messageId: "web-1" });
    fm.reactMessageStatus("w", "", "web-1", "processing");
    fm.emitSseEvent("message", { instance: "w", sender: "web-user", text: "2", ts: "2", messageId: "web-2" });
    fm.reactMessageStatus("w", "", "web-2", "queued");
    expect(fm.cancelInstance("w")).toBe(true);
    expect(escapes).toEqual(["w"]);
    expect(order, "the turn is cancelled before the Esc").toEqual(["clear", "escape"]);
    expect(events.filter(e => e.event === "delivery").at(-1)!.data).toEqual({ instance: "w", messageId: "web-2", delivery: "cancelled" });
    expect(fm.webChatHistory.list("w").map(m => m.delivery)).toEqual(["processing", "cancelled"]);
    expect(fm.cancelInstance("nobody"), "not running").toBe(false);
  });

  it("`activity` on every edge of the execution state, not on its heartbeat; the status carries it too", async () => {
    const { fm, any, events } = await bareFleet();
    any.enforceWarmCap = () => {};
    any.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
    const report = (state: string) => any.cacheInstanceExecutionState("w", { state });
    report("working"); report("working"); report("stuck"); report("idle"); report("idle"); report("bogus");
    expect(events.filter(e => e.event === "activity").map(e => e.data.state)).toEqual(["working", "stuck", "idle"]);
    report("working");
    any.cacheInstanceProcessStatus("w", "crashed");
    any.cacheInstanceProcessStatus("w", "crashed");             // nothing cached any more: no second event
    expect(events.filter(e => e.event === "activity").map(e => e.data)).toEqual([
      { instance: "w", state: "working" }, { instance: "w", state: "stuck" }, { instance: "w", state: "idle" },
      { instance: "w", state: "working" }, { instance: "w", state: null },
    ]);
    any.fleetConfig = { instances: { w: { working_directory: dir } } };
    any.instanceProcessStatus.delete("w");
    report("working");
    const status = fm.getUiStatus() as { instances: Array<{ name: string; state: unknown; execution_state: unknown }> };
    // `state` is #1212's presentation state; `execution_state` is the raw one the activity events carry.
    expect(status.instances.find(i => i.name === "w")).toMatchObject({ state: "working", execution_state: "working" });
  });
});

// ── the routes ─────────────────────────────────────────────────────────────────────────────────────────────

const TOKEN = "u".repeat(48);
function call(method: string, url: string, c: WebApiContext, body?: string) {
  const req = Object.assign(new EventEmitter(), { method, url, headers: { "x-agend-token": TOKEN }, destroy() {}, resume() {} });
  const res = Object.assign(new EventEmitter(), {
    status: 0, body: "",
    setHeader() {}, writeHead(s: number) { res.status = s; return res; }, write() { return true; },
    end(chunk?: unknown) { if (chunk) res.body = String(chunk); return res; },
  });
  handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(url, "http://localhost"), c);
  setImmediate(() => { if (body !== undefined) req.emit("data", Buffer.from(body)); req.emit("end"); });
  return vi.waitFor(() => { expect(res.status).not.toBe(0); return { status: res.status, body: res.body ? JSON.parse(res.body) : {} }; });
}
function ctx(over: Record<string, unknown> = {}) {
  const delivered: Array<{ meta: Record<string, string> }> = [];
  const events: Array<{ event: string; data: any }> = [];
  const cancelled: string[] = [];
  const c = {
    webToken: TOKEN, dataDir: dir, sseClients: new Set(), fleetConfig: { instances: { w: { working_directory: dir }, off: { working_directory: dir } } },
    instanceIpcClients: new Map([["w", { send() {} }]]), daemons: new Map([["w", {}]]),
    adapter: null, logger: { info() {}, debug() {}, error() {} }, eventLog: null, lastInboundUser: new Map(),
    deliverToInstance: async (_n: string, p: { meta: Record<string, string> }) => { delivered.push(p); },
    emitSseEvent: (event: string, data: unknown) => { events.push({ event, data }); },
    getUiStatus: () => ({}),
    cancelInstance: (name: string) => { cancelled.push(name); return name === "w"; },
    ...over,
  } as unknown as WebApiContext;
  return { c, delivered, events, cancelled };
}

describe("POST /ui/send names the message", () => {
  it("the agent, the chat echo and the answer all carry the same fresh id", async () => {
    const { c, delivered, events } = ctx();
    const a = await call("POST", "/ui/send", c, JSON.stringify({ instance: "w", message: "one" }));
    const b = await call("POST", "/ui/send", c, JSON.stringify({ instance: "w", message: "two" }));
    expect(a.status).toBe(200);
    expect(a.body.messageId).toMatch(/^web-[0-9a-z]+-[0-9a-f]{8}$/);
    expect(b.body.messageId).not.toBe(a.body.messageId);
    expect(delivered.map(d => d.meta.message_id)).toEqual([a.body.messageId, b.body.messageId]);
    expect(events.filter(e => e.event === "message").map(e => e.data.messageId)).toEqual([a.body.messageId, b.body.messageId]);
    expect(delivered[0]!.meta.source).toBe("web");
  });
});

describe("POST /ui/cancel/<instance>", () => {
  it("stops the current reply of a running instance", async () => {
    const { c, cancelled } = ctx();
    expect(await call("POST", "/ui/cancel/w", c)).toEqual({ status: 200, body: { cancelled: "w" } });
    expect(cancelled).toEqual(["w"]);
  });

  it("a configured instance that is not running is 409; an unknown or malformed one is 404 and nothing is cancelled", async () => {
    const { c, cancelled } = ctx();
    expect((await call("POST", "/ui/cancel/off", c)).status).toBe(409);
    expect(cancelled).toEqual(["off"]);
    for (const bad of ["nobody", "w/x", "constructor", "__proto__", "toString"]) {
      expect((await call("POST", `/ui/cancel/${bad}`, c)).status, bad).toBe(404);
    }
    expect((await call("POST", "/ui/cancel/%E0%A4%A", c)).status, "not percent-encoding").toBe(400);
    expect(cancelled).toEqual(["off"]);
    const without = ctx({ cancelInstance: undefined });
    expect((await call("POST", "/ui/cancel/w", without.c)).status).toBe(404);
  });

  it("is a write: GET does nothing", async () => {
    const { c, cancelled } = ctx();
    await call("GET", "/ui/cancel/w", c).catch(() => null);
    expect(cancelled).toEqual([]);
  });
});

interface Res { status: number; body: string; setCookie: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = "";
      res.on("data", (ch: Buffer) => { text += ch.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, setCookie: String(res.headers["set-cookie"] ?? "") }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

describe("POST /ui/cancel through the real gate", () => {
  it("needs a session, and the session's CSRF token — a cookie alone cannot stop an agent", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir);
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
    vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
    const cancel = vi.spyOn(fm, "cancelInstance").mockImplementation(() => true);
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: { w: { working_directory: dir } } };
    (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
    (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
    await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
    const server = (fm as unknown as { healthServer: Server }).healthServer;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing TCP address");
    const port = address.port, origin = `http://127.0.0.1:${port}`;
    try {
      const login = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin }, JSON.stringify({ code: fm.issueDashboardLogin()!.display }));
      expect(login.status).toBe(200);
      const cookie = login.setCookie.split(";")[0]!, csrf = csrfTokenFor(cookie.split("=")[1]!);

      expect((await raw(port, "POST", "/ui/cancel/w", { origin })).status, "no session").toBe(401);
      expect((await raw(port, "POST", "/ui/cancel/w", { origin, cookie })).status, "no CSRF token").toBe(403);
      expect((await raw(port, "POST", "/ui/cancel/w", { origin: "http://evil.example", cookie, "x-agend-csrf": csrf })).status, "cross-origin").toBe(403);
      expect(cancel).not.toHaveBeenCalled();
      const ok = await raw(port, "POST", "/ui/cancel/w", { origin, cookie, "x-agend-csrf": csrf });
      expect(ok.status).toBe(200);
      expect(cancel).toHaveBeenCalledWith("w");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      (fm as unknown as { healthServer: Server | null }).healthServer = null;
    }
  }, 30_000);
});

// ── the page ────────────────────────────────────────────────────────────────────────────────────────────────

const RENDER = readFileSync(join(process.cwd(), "src", "ui", "chat-render.js"), "utf8");
function renderApi() {
  const c = vm.createContext({}); vm.runInContext(RENDER, c);
  return (c as any).AgendChatRender;
}

describe("chat-render.js: ticks", () => {
  const R = renderApi();
  const m = (id: number, messageId?: string, delivery?: string) => ({ boot: "b", id, instance: "w", sender: "web-user", text: "t", ts: "1", messageId, delivery });

  it("applyDelivery moves the named message forward, in a copy; the same list when nothing moved", () => {
    const list = [m(1, "web-a"), m(2, "web-b", "queued")];
    const moved = R.applyDelivery(list, "web-b", "delivered");
    expect(moved).not.toBe(list);
    expect(moved[1].delivery).toBe("delivered");
    expect(list[1]!.delivery, "the old list is untouched").toBe("queued");
    expect(moved[0]).toBe(list[0]);
    expect(R.applyDelivery(moved, "web-b", "queued")).toBe(moved);
    expect(R.applyDelivery(moved, "web-zzz", "delivered")).toBe(moved);
    expect(R.applyDelivery(undefined, "web-a", "queued")).toEqual([]);
  });

  it("mergeMessages: the same message again keeps its place and takes the ticks that got further", () => {
    const live = [m(1, "web-a", "queued"), m(2, "web-b", "delivered")];
    const fromHistory = [m(1, "web-a", "delivered"), m(2, "web-b", "queued"), m(3, "web-c")];
    const merged = R.mergeMessages(live, fromHistory, 500);
    expect(merged.map((x: { id: number; delivery?: string }) => [x.id, x.delivery])).toEqual([[1, "delivered"], [2, "delivered"], [3, undefined]]);
    expect(merged[1]).toBe(live[1]);
  });

  it("deliveryHtml: a labelled tick per state, the label escaped; nothing for anything else", () => {
    expect(R.deliveryHtml("delivered", { delivered: "The agent has it" }))
      .toBe('<span class="tick tick-delivered" role="img" aria-label="The agent has it" title="The agent has it">✓✓</span>');
    expect(R.deliveryHtml("failed", { failed: '"><img src=x onerror=alert(1)>' })).toContain('aria-label="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    expect(R.deliveryHtml("queued")).toContain('aria-label="queued"');
    for (const bad of [undefined, "", "received", "__proto__", '"><b>']) expect(R.deliveryHtml(bad, {}), String(bad)).toBe("");
  });

  it("isBusy: working and stuck show the Stop; idle and unknown do not", () => {
    expect([R.isBusy("working"), R.isBusy("stuck"), R.isBusy("idle"), R.isBusy(null), R.isBusy(undefined)]).toEqual([true, true, false, false, false]);
  });
});

// ── the chat panel: the real page modules, mounted the way the app mounts them (#1408 step 1) ──────────────────

/** The app's stream as the chat hears it: `emit` is one frame, already parsed (app-stream.js parses before it emits). */
function fakeStream() {
  const subs = new Map<string, Array<(d: any, extra?: unknown) => void>>();
  return {
    on(name: string, fn: (d: any, extra?: unknown) => void) { subs.set(name, [...(subs.get(name) ?? []), fn]); return () => {}; },
    emit(name: string, d: any, extra?: unknown) { for (const fn of subs.get(name) ?? []) fn(d, extra); },
  };
}
/** The page's fetch: every call recorded; `respond` answers it (assign a new one to change the answer). */
function fetchMock() {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const mock = {
    calls,
    respond: (_path: string, _body?: any): unknown => ({}),
    fn: async (path: string, o: { method?: string; body?: string } = {}) => {
      const body = o.body ? JSON.parse(o.body) : undefined;
      calls.push({ path, method: o.method ?? "GET", body });
      const value = await mock.respond(path, body);
      return { ok: true, status: 200, json: async () => value };
    },
  };
  return mock;
}
const load = (path: string): Promise<any> => import(path);
const inst = (name: string, over: Record<string, unknown> = {}) => ({ name, status: "running", state: "idle", backend: "claude-code", ...over });
const frame = (...instances: Array<Record<string, unknown>>) => ({ uptime: 1, instances });
const msg = (id: number, sender: string, text: string, over: Record<string, unknown> = {}) => ({ boot: "b", id, instance: "w", sender, text, ts: "2026-01-01T00:00:00Z", ...over });
const key = (k: string, over: Record<string, unknown> = {}) => { const e: any = { key: k, isComposing: false, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, ...over }; return e; };

describe("the chat panel (the real page modules)", () => {
  const pages: AppPage[] = [];
  afterEach(async () => { for (const pg of pages.splice(0)) { await pg.unmount(); pg.restore(); } });

  /** A page with the app's modules: the store booted on a stream (fake, or the real one over poll or SSE), <ChatPanel>
   *  mounted into <main id="main"> as the shell does. vi.resetModules() first: boot runs once per module instance. */
  async function chatPage(kind: "fake" | "poll" | "events" = "fake") {
    vi.resetModules();
    const harness = await import("./helpers/app-harness.js");
    const p = harness.page();
    pages.push(p);
    const app = await load("/assets/app-store.js");
    const shell = await load("/assets/app-shell.js");
    const panel = await load("/ui/js/panel-chat.js");
    const fx = fetchMock();
    const toasts: Array<[string, boolean]> = [];
    const timers: Array<() => void> = [];        // the store's 60-second clocks: recorded, run only when a test says so
    const sources: any[] = [];                   // the EventSource(s) the real stream opened
    const clock = (f: () => void) => { timers.push(f); return timers.length; };
    const env = {
      fetch: fx.fn, setTimeout: clock, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
      EventSource: class { listeners = new Map<string, (e: { data: string; lastEventId?: string }) => void>(); constructor() { sources.push(this); } addEventListener(n: string, f: any) { this.listeners.set(n, f); } close() {} },
    };
    const stream: any = kind === "fake" ? fakeStream() : (await load("/assets/app-stream.js")).createStream({ mode: "full", transport: kind === "poll" ? "poll" : undefined, env });
    stream.on("status", app.applyStatus);        // app.js wires these two before the chat boots
    stream.on("activity", app.applyActivity);
    panel.boot({ stream, boot: null, deps: { fetch: fx.fn, toast: (m: string, ok = true) => { toasts.push([m, ok]); }, setTimeout: clock } });
    const mount = (name: string, ...beside: unknown[]) => p.mount(harness.h("main", { id: "main" }, ...beside, harness.h(panel.ChatPanel, { route: { panel: "chat", instance: name }, navKey: `chat|${name}` })));
    const posts = () => fx.calls.filter(c => c.method === "POST");
    return { p, fx, toasts, timers, stream, sources, app, shell, panel, mount, posts, store: () => panel.store as any, h: harness.h };
  }

  it("shows '<name> is working…' and a Stop while the open chat's agent works, and hides them when it is idle", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    const bar = () => c.p.root.querySelector(".work-bar");
    const stop = () => c.p.root.querySelector("#stopBtn");
    const send = () => c.p.root.querySelector("#sendBtn");
    const typeIn = async (text: string) => { c.p.root.querySelector("#msgIn").value = text; fire(c.p.root.querySelector("#msgIn"), "input"); await settle(); };
    c.stream.emit("activity", { instance: "w", state: "working" });
    await settle();
    expect(bar().className).toBe("work-bar working");
    expect(bar().querySelector(".lbl").textContent).toBe("w is working…");
    expect(bar().querySelector(".elapsed").getAttribute("aria-hidden"), "the ticking time is not read out every second").toBe("true");
    expect([stop().hidden, send().hidden], "an empty composer: Send becomes Stop").toEqual([false, true]);
    await typeIn("next, please");
    expect([stop().hidden, send().hidden], "something typed: it can be sent to wait its turn, and Stop stays").toEqual([false, false]);
    await typeIn("");
    c.stream.emit("activity", { instance: "w", state: "stuck" });
    await settle();
    expect(bar().className).toBe("work-bar stuck");
    expect(bar().querySelector(".lbl").textContent).toBe("w looks stuck");
    expect(stop().hidden).toBe(false);
    c.stream.emit("activity", { instance: "w", state: "idle" });
    await settle();
    expect(bar()).toBeNull();
    expect([stop().hidden, send().hidden]).toEqual([true, false]);
  });

  it("another instance working does not show here; the status frames carry the state too", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w"), inst("other")));
    await c.mount("w");
    c.stream.emit("activity", { instance: "other", state: "working" });
    await settle();
    expect(c.p.root.querySelector(".work-bar")).toBeNull();
    expect(c.p.root.querySelector("#stopBtn").hidden).toBe(true);
    c.stream.emit("status", frame(inst("w", { state: "working" }), inst("other", { state: null })));
    await settle();
    expect(c.p.root.querySelector(".work-bar").className).toBe("work-bar working");
    expect(c.store().state.exec.other).toBeNull();
  });

  it("a status that presents awaiting_input (#1212) keeps the agent's turn — the line stays, Stop stays — and says it waits on you (#1307)", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    c.stream.emit("activity", { instance: "w", state: "working" });
    c.stream.emit("status", frame(inst("w", { state: "awaiting_input", execution_state: "working", interaction_summary: "Permission prompt for 12s" })));
    await settle();
    const bar = c.p.root.querySelector(".work-bar");
    expect(bar.className).toBe("work-bar awaiting");
    expect([bar.querySelector(".lbl").textContent, bar.querySelector(".note").textContent]).toEqual(["w is waiting for your input", "Permission prompt for 12s"]);
    expect(c.p.root.querySelector("#stopBtn").hidden, "Stop stays").toBe(false);
    expect(c.store().state.exec.w).toBe("working");
    // Answered: back to working.
    c.stream.emit("status", frame(inst("w", { state: "working", execution_state: "working" })));
    await settle();
    expect(c.p.root.querySelector(".work-bar").className).toBe("work-bar working");
    // An older status without execution_state still works from `state`.
    c.stream.emit("status", frame(inst("w", { state: "idle" })));
    await settle();
    expect(c.p.root.querySelector(".work-bar")).toBeNull();
  });

  it("the name is text, never markup", async () => {
    const name = "<img src=x onerror=alert(1)>";
    const c = await chatPage();
    c.stream.emit("status", frame(inst(name)));
    await c.mount(name);
    c.stream.emit("activity", { instance: name, state: "working" });
    await settle();
    expect(c.p.root.querySelector(".work-bar .lbl").textContent).toBe(`${name} is working…`);
    expect(c.p.root.querySelector("img"), "no element was made from the name").toBeNull();
  });

  it("a status frame with no change keeps the same Stop button (a keyboard user's focus stays on it)", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    c.stream.emit("activity", { instance: "w", state: "working" });
    await settle();
    const first = c.p.root.querySelector("#stopBtn");
    c.stream.emit("status", frame(inst("w", { state: "working" })));
    await settle();
    expect(c.p.root.querySelector("#stopBtn")).toBe(first);
    expect(first.hidden).toBe(false);
  });

  it("Stop posts /ui/cancel/<the chat it was pressed in> and says how it went", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string) => (path.endsWith("/a%2Fb") ? { error: "a/b is not running" } : { cancelled: "w" });
    c.stream.emit("status", frame(inst("w", { state: "working" })));
    await c.mount("w");
    c.stream.emit("activity", { instance: "w", state: "working" });
    await settle();
    fire(c.p.root.querySelector("#stopBtn"), "click");
    await settle();
    expect(c.posts().map(x => [x.method, x.path])).toEqual([["POST", "/ui/cancel/w"]]);
    expect(c.toasts).toEqual([["w: Stopped", true]]);
    await c.store().cancelReply("a/b");
    expect(c.posts().at(-1)!.path).toBe("/ui/cancel/a%2Fb");
    expect(c.toasts.at(-1)).toEqual(["a/b is not running", false]);
  });

  it("after Stop: 'Stopping…' until the agent goes idle; a Stop that failed changes nothing (#1307)", async () => {
    const c = await chatPage();
    c.fx.respond = (path: string) => (path.endsWith("/w") ? { cancelled: "w" } : { error: "x is not running" });
    c.stream.emit("status", frame(inst("w", { state: "working" })));
    await c.mount("w");
    c.stream.emit("activity", { instance: "w", state: "working" });
    await settle();
    fire(c.p.root.querySelector("#stopBtn"), "click");
    await settle();
    const bar = () => c.p.root.querySelector(".work-bar");
    expect(bar().className).toBe("work-bar stopping");
    expect(bar().querySelector(".lbl").textContent).toBe("Stopping w…");
    c.stream.emit("status", frame(inst("w", { state: "working" })));
    await settle();
    expect(bar().className, "still stopping while it works").toBe("work-bar stopping");
    c.stream.emit("activity", { instance: "w", state: "idle" });
    await settle();
    expect(bar()).toBeNull();
    c.stream.emit("activity", { instance: "w", state: "working" });
    await settle();
    expect(bar().className, "the next turn starts fresh").toBe("work-bar working");
    c.stream.emit("activity", { instance: "x", state: "working" });
    await c.store().cancelReply("x");
    expect(c.store().state.stopping.x).toBeUndefined();
  });

  it("a Stop on its way gives way after a minute, even if the agent never goes idle", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w", { state: "working" })));
    await c.mount("w");
    c.stream.emit("activity", { instance: "w", state: "working" });
    await settle();
    fire(c.p.root.querySelector("#stopBtn"), "click");
    await settle();
    expect(c.p.root.querySelector(".work-bar").className).toBe("work-bar stopping");
    c.timers.forEach(run => run());                 // a minute passes
    await settle();
    expect(c.p.root.querySelector(".work-bar").className).toBe("work-bar working");
  });

  // Esc stops the reply from the chat, while it works, when nothing else is open for Esc to close.
  it("Esc stops the agent's reply — only while it works, not twice, not over an open form", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    const esc = (over: Record<string, unknown> = {}) => { const e = key("Escape", over); c.shell.handleKey(e); return e.defaultPrevented; };
    expect(esc(), "idle: Esc is left alone").toBe(false);
    c.stream.emit("activity", { instance: "w", state: "working" });
    await settle();
    for (const make of ["dialog", "pop"]) {
      const open = c.p.document.createElement(make === "dialog" ? "dialog" : "div");
      if (make === "dialog") open.setAttribute("open", ""); else open.className = "pop";
      c.p.document.body.appendChild(open);
      expect(esc(), `a ${make} is open: Esc is its own`).toBe(false);
      open.remove();
    }
    expect(esc({ isComposing: true }), "Esc that belongs to the input method stops nothing").toBe(false);
    await settle();
    expect(c.posts()).toEqual([]);
    expect(esc()).toBe(true);
    await settle();
    expect(c.posts().map(x => x.path)).toEqual(["/ui/cancel/w"]);
    expect(esc(), "already stopping").toBe(false);
    expect(c.posts()).toHaveLength(1);
  });

  it("Esc is the chat's only while focus is in the chat or on nothing — a control elsewhere on the page keeps its own Esc", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w", c.h("button", { id: "side", type: "button" }));
    c.stream.emit("activity", { instance: "w", state: "working" });
    await settle();
    const esc = () => { const e = key("Escape"); c.shell.handleKey(e); return e.defaultPrevented; };
    c.p.root.querySelector("#side").focus();
    expect(esc(), "focus on a control outside the chat").toBe(false);
    c.p.document.body.focus();
    expect(esc(), "nothing focused").toBe(true);
    await settle();
    expect(c.posts()).toHaveLength(1);
  });

  // #1317 review: a Stop on its way blocks a second one at once — before its answer arrives, not after.
  it("two Esc (a held key repeating) while the first Stop's answer is pending: one request", async () => {
    const c = await chatPage();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    c.fx.respond = async () => { await gate; return { cancelled: "w" }; };
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    c.stream.emit("activity", { instance: "w", state: "working" });
    await settle();
    const esc = () => { const e = key("Escape", { repeat: true }); c.shell.handleKey(e); return e.defaultPrevented; };
    expect(esc()).toBe(true);
    expect(esc(), "pending: nothing more").toBe(false);
    fire(c.p.root.querySelector("#stopBtn"), "click");                  // nor a click on Stop
    await settle();
    expect(c.p.root.querySelector("#stopBtn").disabled).toBe(true);
    expect(c.posts().map(x => x.path)).toEqual(["/ui/cancel/w"]);
    release();
    await settle();
    expect(c.store().state.stopping.w, "answered: the stopping gate takes over").toBe(true);
    expect(esc()).toBe(false);
    expect(c.posts()).toHaveLength(1);
  });

  it("a Stop that failed can be tried again", async () => {
    const c = await chatPage();
    c.fx.respond = () => ({ error: "socket closed" });
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    c.stream.emit("activity", { instance: "w", state: "working" });
    await settle();
    const esc = () => { const e = key("Escape"); c.shell.handleKey(e); return e.defaultPrevented; };
    esc();
    await settle();
    expect(c.store().state.stopping.w).toBeUndefined();
    expect(c.toasts.at(-1)).toEqual(["socket closed", false]);
    expect(esc(), "after a refusal Esc works again").toBe(true);
    await settle();
    expect(c.posts().map(x => x.path)).toEqual(["/ui/cancel/w", "/ui/cancel/w"]);
  });

  it("switching chats while a Stop is pending: the other chat can be stopped, and the answer lands on the first", async () => {
    const c = await chatPage();
    const answers: Array<() => void> = [];
    c.fx.respond = (path: string) => (path.startsWith("/ui/cancel/") ? new Promise(r => answers.push(() => r({ cancelled: path.slice("/ui/cancel/".length) }))) : { messages: [] });
    c.stream.emit("status", frame(inst("w", { state: "working" }), inst("x", { state: "working" })));
    await c.mount("w");
    c.stream.emit("activity", { instance: "w", state: "working" });
    await settle();
    const esc = () => { const e = key("Escape"); c.shell.handleKey(e); return e.defaultPrevented; };
    expect(esc()).toBe(true);
    await c.mount("x");
    c.stream.emit("activity", { instance: "x", state: "working" });
    await settle();
    expect(esc(), "x has no Stop pending").toBe(true);
    expect(c.posts().map(x => x.path)).toEqual(["/ui/cancel/w", "/ui/cancel/x"]);
    answers[0]!();
    await settle();
    expect([c.store().state.stopping.w, c.store().state.cancelling.w]).toEqual([true, undefined]);
    expect(c.store().state.cancelling.x, "x still pending").toBe(true);
  });

  it("a polite status line says the coarse things only: started, finished, replied, waits on you", async () => {
    const c = await chatPage();
    const beat = () => new Promise(r => setTimeout(r, 80));          // the line is set 60 ms after a change
    const said = () => c.p.document.getElementById("announcer")?.textContent ?? "";
    // The page's first status says w is already working, and "other" is idle: that is how things are, not news.
    c.stream.emit("status", frame(inst("w", { state: "working" }), inst("other", { state: "idle" })));
    await c.mount("w");
    await beat();
    expect(said(), "the first status is not news").toBe("");
    c.stream.emit("activity", { instance: "w", state: "idle" });
    await beat();
    expect(said()).toBe("w finished");
    c.stream.emit("activity", { instance: "w", state: "working" });
    await beat();
    expect(said()).toBe("w started working");
    c.stream.emit("status", frame(inst("w", { state: "awaiting_input", execution_state: "working" })));
    await beat();
    expect(said()).toBe("w is waiting for your input");
    c.stream.emit("message", msg(1, "w", "**done**", { ts: "2026-01-01T00:00:00Z" }));
    await beat();
    expect(said(), "not the reply's text").toBe("w replied");
    c.stream.emit("message", msg(2, "web-user", "thanks", { messageId: "web-2" }));
    await beat();
    expect(said(), "your own message is not announced").toBe("w replied");
    c.stream.emit("activity", { instance: "w", state: "idle" });
    await beat();
    expect(said()).toBe("w finished");
    c.stream.emit("activity", { instance: "other", state: "working" });
    await beat();
    expect(said(), "another instance's edges are not this chat's").toBe("w finished");
  });

  it("a `delivery` event puts the ticks on that message", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    c.stream.emit("message", msg(1, "web-user", "hi", { messageId: "web-a" }));
    await settle();
    expect(c.p.root.querySelector(".tick")).toBeNull();
    c.stream.emit("delivery", { instance: "w", messageId: "web-a", delivery: "processing" });
    await settle();
    const tick = c.p.root.querySelector(".tick-processing");
    expect([tick.textContent, tick.getAttribute("role"), tick.getAttribute("aria-label"), tick.getAttribute("title")])
      .toEqual(["✓", "img", "Handed to the agent", "Handed to the agent"]);
    c.stream.emit("delivery", { instance: "w", messageId: "web-a", delivery: "cancelled" });
    await settle();
    expect(c.p.root.querySelector(".tick-cancelled")).not.toBeNull();
    expect(c.store().state.msgs.w[0].delivery).toBe("cancelled");
  });

  // #1307: one node per message, so an update touches only its own message, and the view is the reader's.
  it("a tick re-renders only its own message: the others are the same nodes, in the same order", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    c.stream.emit("message", msg(1, "web-user", "hi", { messageId: "web-1" }));
    c.stream.emit("message", msg(2, "w", "hello"));
    c.stream.emit("message", msg(3, "web-user", "and?", { messageId: "web-3" }));
    await settle();
    const rows = () => c.p.root.querySelectorAll(".thread > .msg");
    const [a, b, d] = rows();
    c.stream.emit("delivery", { instance: "w", messageId: "web-1", delivery: "delivered" });
    await settle();
    const after = rows();
    expect(after).toHaveLength(3);
    expect(after[0]).not.toBe(a);
    expect(after[0].querySelector(".tick-delivered")).not.toBeNull();
    expect(after[1]).toBe(b);
    expect(after[2]).toBe(d);
  });

  it("at the bottom, a new message pulls the view down; scrolled up, it stays put and '↓ N new' counts", async () => {
    const c = await chatPage();
    c.stream.emit("status", frame(inst("w")));
    await c.mount("w");
    const sc = c.p.root.querySelector(".scroller");
    Object.assign(sc, { scrollTop: 0, clientHeight: 500, scrollHeight: 2000 });
    const jump = () => c.p.root.querySelector(".jump-latest");
    c.stream.emit("message", msg(1, "w", "one"));
    await settle();
    expect(sc.scrollTop, "it was not at the bottom: stays").toBe(0);
    expect(jump().textContent, "the arrow is an icon; the count is text").toBe("1 new");
    c.stream.emit("message", msg(2, "w", "two"));
    await settle();
    expect(jump().textContent).toBe("2 new");
    fire(jump(), "click");
    await settle();
    expect(sc.scrollTop).toBe(2000);
    expect(jump()).toBeNull();
    sc.scrollTop = 1460;                                           // 40px above the bottom: counts as at it…
    c.stream.emit("message", msg(3, "w", "three"));                // …so a new one follows
    await settle();
    expect(sc.scrollTop).toBe(2000);
    expect(jump()).toBeNull();
  });

  it("while polling, the ticks come with the poll — the chat's history is never re-read in the background (#1253 review)", async () => {
    const c = await chatPage("poll");
    c.store().ingest(msg(1, "web-user", "hi", { instance: "w", messageId: "web-1", delivery: "processing" }));
    c.fx.respond = (path: string) => (path.startsWith("/ui/poll") ? { status: { uptime: 1, instances: [] }, messages: [], cursor: "b-1", deliveries: [{ instance: "w", messageId: "web-1", delivery: "delivered" }] } : { messages: [] });
    c.stream.start();
    await settle();
    expect(c.fx.calls.map(x => x.path), "one passive poll, no history read").toEqual(["/ui/poll?after="]);
    expect(c.store().state.msgs.w[0].delivery).toBe("delivered");
  });

  // The real /ui/events handler, as an EventSource that reconnects sees it: the frames it writes, in order.
  function connect(c: WebApiContext, lastEventId?: string) {
    const writes: string[] = [];
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/events", headers: { "x-agend-token": TOKEN, ...(lastEventId ? { "last-event-id": lastEventId } : {}) }, socket: null });
    const res = Object.assign(new EventEmitter(), { status: 0, setHeader() {}, writeHead(st: number) { res.status = st; return res; }, write(x: string) { writes.push(x); return true; }, end() { return res; } });
    handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL("http://localhost/ui/events"), c);
    res.emit("close");                                              // this test only needs what was sent on connect
    return writes.join("").split("\n\n").filter(Boolean).map(f => {
      const field = (k: string) => f.split("\n").find(l => l.startsWith(`${k}: `))?.slice(k.length + 2);
      return { event: field("event")!, id: field("id"), data: field("data")! };
    });
  }

  it.each(["delivered", "failed", "cancelled"] as const)("a tick that became %s while the stream was down is caught up on reconnect — no new message, no poll (#1253 review)", async (final) => {
    const c = await chatPage("events");
    const h = new WebChatHistory({ boot: "b1" });
    const m = h.record({ instance: "w", sender: "web-user", text: "hi", ts: "1", messageId: "web-1" });
    h.setDelivery("w", "web-1", final === "cancelled" ? "queued" : "processing");
    c.stream.start();
    const source = c.sources[0];
    source.listeners.get("message")({ data: JSON.stringify(m), lastEventId: h.cursorOf(m) });   // the page saw it…
    const seen = c.store().state.msgs.w[0].delivery;
    // …the stream drops; the report arrives while it is down…
    if (final === "cancelled") h.cancelPending("w"); else h.setDelivery("w", "web-1", final);
    // …and the browser reconnects with the cursor it had, before any fallback poll.
    const { c: server } = ctx({ webChatHistory: h, getUiStatus: () => ({ uptime: 1, instances: [] }) });
    const frames = connect(server, h.cursorOf(m));
    expect(frames.map(f => f.event), "nothing new to replay — only the status and the ticks").toEqual(["status", "deliveries"]);
    for (const f of frames) source.listeners.get(f.event)!({ data: f.data, lastEventId: f.id });
    expect([seen, c.store().state.msgs.w[0].delivery]).toEqual([final === "cancelled" ? "queued" : "processing", final]);
    expect(c.fx.calls, "no poll was needed").toEqual([]);
  });

  it("GET /ui/poll carries the ticks of every retained web message (and only those)", async () => {
    const h = new WebChatHistory({ boot: "b1" });
    h.record({ instance: "w", sender: "web-user", text: "a", ts: "1", messageId: "web-1" });
    h.setDelivery("w", "web-1", "failed");
    h.record({ instance: "w", sender: "web-user", text: "b", ts: "2", messageId: "web-2" });
    const { c } = ctx({ webChatHistory: h, getUiStatus: () => ({ uptime: 1, instances: [] }) });
    const r = await call("GET", "/ui/poll?after=b1-2", c);
    expect(r.status).toBe(200);
    expect(r.body.deliveries).toEqual([{ instance: "w", messageId: "web-1", delivery: "failed" }]);
  });

  it("the first connect, with no cursor at all, carries the ticks too", () => {
    const h = new WebChatHistory({ boot: "b1" });
    h.record({ instance: "w", sender: "web-user", text: "hi", ts: "1", messageId: "web-1" });
    h.setDelivery("w", "web-1", "delivered");
    h.record({ instance: "w", sender: "agent", text: "agent says", ts: "2" });                // no ticks: not listed
    h.record({ instance: "w", sender: "web-user", text: "just sent", ts: "3", messageId: "web-2" });   // no report yet: not listed
    const { c } = ctx({ webChatHistory: h, getUiStatus: () => ({ uptime: 1, instances: [] }) });
    const frames = connect(c);
    expect(frames.find(f => f.event === "deliveries")!.data).toBe(JSON.stringify([{ instance: "w", messageId: "web-1", delivery: "delivered" }]));
    expect(frames.find(f => f.event === "deliveries")!.id, "not a message: no cursor").toBeUndefined();
  });
});
