import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelStatus } from "../src/daemon.js";
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

describe("the dashboard (the real page script)", () => {
  const PAGE = readFileSync(join(process.cwd(), "src", "ui", "dashboard.html"), "utf8").match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  function el(tag = "div") {
    const node: any = {
      tag, className: "", textContent: "", title: "", type: "", id: "", disabled: false, dataset: {}, children: [] as any[], attrs: {} as Record<string, string>, style: {},
      append(...kids: any[]) { node.children.push(...kids); }, setAttribute(k: string, v: string) { node.attrs[k] = v; }, remove() {},
    };
    // textContent = "" empties it, as in a browser.
    let text = "";
    Object.defineProperty(node, "textContent", { get: () => text, set: (v: string) => { text = v; if (v === "") node.children = []; } });
    return node;
  }
  // The message list as the page builds it (#1307): one node per message, inserted, replaced and removed — enough of
  // the DOM for that, and its innerHTML is the messages' HTML in order.
  function msgNode(html: string, parent: any) {
    const n: any = {
      html, querySelectorAll: () => [],
      remove() { const i = parent.kids.indexOf(n); if (i >= 0) parent.kids.splice(i, 1); },
      replaceWith(m: any) { const i = parent.kids.indexOf(n); if (i >= 0) parent.kids.splice(i, 1, m); },
      get nextSibling() { return parent.kids[parent.kids.indexOf(n) + 1] ?? null; },
    };
    return n;
  }
  function msgList() {
    const list: any = {
      kids: [] as any[], scrollHeight: 0,
      get firstChild() { return list.kids[0] ?? null; },
      insertBefore(n: any, ref: any) { const i = list.kids.indexOf(n); if (i >= 0) list.kids.splice(i, 1); const j = ref ? list.kids.indexOf(ref) : -1; if (j < 0) list.kids.push(n); else list.kids.splice(j, 0, n); },
      set textContent(_v: string) { list.kids = []; },
      set innerHTML(v: string) { list.kids = [msgNode(v, list)]; },
      get innerHTML() { return list.kids.map((k: any) => k.html).join(""); },
    };
    return list;
  }
  function page() {
    const messages = msgList();
    // The composer buttons start as the page writes them: Stop hidden.
    const nodes: Record<string, any> = { workBar: el(), messages, uptime: { textContent: "" }, stopBtn: Object.assign(el("button"), { hidden: true }), sendBtn: el("button"), msgIn: { value: "" } };
    const create = (t: string) => t === "template"
      ? { set innerHTML(v: string) { (this as any).content = { firstElementChild: msgNode(v, messages) }; } }
      : el(t);
    const sse: Record<string, (e: { data: string; lastEventId?: string }) => void> = {};
    const toasts: Array<[string, boolean]> = [];
    const c = vm.createContext({
      localStorage: { getItem: () => null }, navigator: { language: "en" },
      document: { addEventListener() {}, getElementById: (n: string) => nodes[n] ?? null, createElement: create, body: { appendChild() {} } },
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      EventSource: class { addEventListener(k: string, f: (e: { data: string }) => void) { sse[k] = f; } },
    });
    vm.runInContext(RENDER, c);
    vm.runInContext(PAGE, c);
    (c as any).captureToast = (m: string, ok: boolean) => toasts.push([m, ok]);
    vm.runInContext('toast=(m,ok=true)=>captureToast(m,ok);renderList=()=>{};renderActions=()=>{};mode="instance";cur="w";curTab="chat";', c);
    return { c, nodes, sse, toasts, read: (s: string) => vm.runInContext(s, c) };
  }
  const bar = (p: ReturnType<typeof page>) => p.nodes.workBar;
  // Stop is the composer's (#1307): shown while the agent works, beside Send only when there is something to send.
  const button = (p: ReturnType<typeof page>) => p.nodes.stopBtn;

  it("shows '<name> is working…' and a Stop while the open chat's agent works, and hides them when it is idle", () => {
    const p = page();
    p.sse.activity!({ data: JSON.stringify({ instance: "w", state: "working" }) });
    expect(bar(p).className).toBe("work-bar on");
    expect(bar(p).children.map((k: any) => k.textContent)).toEqual(["", "w is working…", "0:00"]);
    expect([button(p).hidden, p.nodes.sendBtn.hidden], "an empty composer: Send becomes Stop").toEqual([false, true]);
    p.nodes.msgIn.value = "next, please";
    p.read("renderComposerButtons()");
    expect([button(p).hidden, p.nodes.sendBtn.hidden], "something typed: it can be sent to wait its turn, and Stop stays").toEqual([false, false]);
    p.nodes.msgIn.value = "";
    p.sse.activity!({ data: JSON.stringify({ instance: "w", state: "stuck" }) });
    expect(bar(p).className).toBe("work-bar on stuck");
    expect(bar(p).children[1].textContent).toBe("w looks stuck");
    expect(button(p).hidden).toBe(false);
    p.sse.activity!({ data: JSON.stringify({ instance: "w", state: "idle" }) });
    expect(bar(p).className).toBe("work-bar");
    expect(bar(p).children).toEqual([]);
    expect([button(p).hidden, p.nodes.sendBtn.hidden]).toEqual([true, false]);
  });

  it("another instance working does not show here; the status frames carry the state too", () => {
    const p = page();
    p.sse.activity!({ data: JSON.stringify({ instance: "other", state: "working" }) });
    expect(bar(p).children).toEqual([]);
    expect(button(p).hidden).toBe(true);
    p.sse.status!({ data: JSON.stringify({ uptime: 1, instances: [{ name: "w", state: "working" }, { name: "other", state: null }] }) });
    expect(bar(p).className).toBe("work-bar on");
    expect(p.read("activity.other")).toBeNull();
  });

  it("a status that presents awaiting_input (#1212) keeps the agent's turn — the line stays, Stop stays — and says it waits on you (#1307)", () => {
    const p = page();
    p.sse.activity!({ data: JSON.stringify({ instance: "w", state: "working" }) });
    p.sse.status!({ data: JSON.stringify({ uptime: 1, instances: [{ name: "w", state: "awaiting_input", execution_state: "working", interaction_summary: "Permission prompt for 12s" }] }) });
    expect(bar(p).className).toBe("work-bar on awaiting");
    expect(bar(p).children.map((k: any) => k.textContent)).toEqual(["", "w is waiting for your input", "Permission prompt for 12s"]);
    expect(button(p).hidden, "Stop stays").toBe(false);
    expect(p.read("activity.w")).toBe("working");
    // Answered: back to working.
    p.sse.status!({ data: JSON.stringify({ uptime: 1, instances: [{ name: "w", state: "working", execution_state: "working" }] }) });
    expect(bar(p).className).toBe("work-bar on");
    // An older status without execution_state still works from `state`.
    p.sse.status!({ data: JSON.stringify({ uptime: 1, instances: [{ name: "w", state: "idle" }] }) });
    expect(bar(p).className).toBe("work-bar");
  });

  it("the name is text, never markup", () => {
    const p = page();
    p.read('cur = "<img src=x onerror=alert(1)>"');
    p.sse.activity!({ data: JSON.stringify({ instance: "<img src=x onerror=alert(1)>", state: "working" }) });
    expect(bar(p).children[1].textContent).toBe("<img src=x onerror=alert(1)> is working…");
    expect(bar(p).innerHTML).toBeUndefined();
  });

  it("a status frame with no change keeps the same Stop button (a keyboard user's focus stays on it)", () => {
    const p = page();
    p.sse.activity!({ data: JSON.stringify({ instance: "w", state: "working" }) });
    const first = button(p);
    p.sse.status!({ data: JSON.stringify({ uptime: 1, instances: [{ name: "w", state: "working" }] }) });
    expect(button(p)).toBe(first);
    expect(first.hidden).toBe(false);
  });

  it("Stop posts /ui/cancel/<the chat it was pressed in> and says how it went", async () => {
    const p = page();
    const calls: unknown[] = [];
    (p.c as any).recordCall = (x: unknown) => calls.push(x);
    p.read('api = async (m, path) => { recordCall([m, path]); return path.endsWith("/a%2Fb") ? { error: "a/b is not running" } : { cancelled: "w" }; }');
    p.sse.activity!({ data: JSON.stringify({ instance: "w", state: "working" }) });
    (p.c as any).stopNode = button(p);
    await p.read("ACTIONS.stopReply(stopNode)");
    expect(calls).toEqual([["POST", "/ui/cancel/w"]]);
    expect(p.toasts).toEqual([["w: Stopped", true]]);
    await p.read('cancelReply("a/b")');
    expect(calls.at(-1)).toEqual(["POST", "/ui/cancel/a%2Fb"]);
    expect(p.toasts.at(-1)).toEqual(["a/b is not running", false]);
  });

  it("after Stop: 'Stopping…' until the agent goes idle; a Stop that failed changes nothing (#1307)", async () => {
    const p = page();
    p.read('api = async (m, path) => path.endsWith("/w") ? { cancelled: "w" } : { error: "x is not running" }');
    p.sse.activity!({ data: JSON.stringify({ instance: "w", state: "working" }) });
    (p.c as any).stopNode = button(p);
    await p.read("ACTIONS.stopReply(stopNode)");
    expect(bar(p).className).toBe("work-bar on stopping");
    expect(bar(p).children[1].textContent).toBe("Stopping w…");
    p.sse.status!({ data: JSON.stringify({ uptime: 1, instances: [{ name: "w", state: "working" }] }) });
    expect(bar(p).className, "still stopping while it works").toBe("work-bar on stopping");
    p.sse.activity!({ data: JSON.stringify({ instance: "w", state: "idle" }) });
    expect(bar(p).className).toBe("work-bar");
    p.sse.activity!({ data: JSON.stringify({ instance: "w", state: "working" }) });
    expect(bar(p).className, "the next turn starts fresh").toBe("work-bar on");
    p.read('cur = "x"; activity.x = "working"');
    await p.read('cancelReply("x")');
    expect(p.read("stopping.x")).toBeUndefined();
  });

  it("a `delivery` event puts the ticks on that message", () => {
    const p = page();
    p.sse.message!({ data: JSON.stringify({ boot: "b", id: 1, instance: "w", sender: "web-user", text: "hi", ts: "2026-01-01T00:00:00Z", messageId: "web-a" }) });
    expect(p.nodes.messages.innerHTML).not.toContain("tick");
    p.sse.delivery!({ data: JSON.stringify({ instance: "w", messageId: "web-a", delivery: "processing" }) });
    expect(p.nodes.messages.innerHTML).toContain('<span class="tick tick-processing" role="img" aria-label="Handed to the agent" title="Handed to the agent">✓</span>');
    p.sse.delivery!({ data: JSON.stringify({ instance: "w", messageId: "web-a", delivery: "cancelled" }) });
    expect(p.nodes.messages.innerHTML).toContain("tick-cancelled");
    expect(p.read("msgs.w[0].delivery")).toBe("cancelled");
  });

  // #1307: one node per message, so an update touches only its own message, and the view is the reader's.
  const say = (p: ReturnType<typeof page>, id: number, sender: string, text: string) =>
    p.sse.message!({ data: JSON.stringify({ boot: "b", id, instance: "w", sender, text, ts: "2026-01-01T00:00:00Z", ...(sender === "web-user" ? { messageId: `web-${id}` } : {}) }) });

  it("a tick re-renders only its own message: the others are the same nodes, in the same order", () => {
    const p = page();
    say(p, 1, "web-user", "hi"); say(p, 2, "w", "hello"); say(p, 3, "web-user", "and?");
    const [a, b, c] = p.nodes.messages.kids;
    p.sse.delivery!({ data: JSON.stringify({ instance: "w", messageId: "web-1", delivery: "delivered" }) });
    const after = p.nodes.messages.kids;
    expect(after).toHaveLength(3);
    expect(after[0]).not.toBe(a);
    expect(after[0].html).toContain("tick-delivered");
    expect([after[1], after[2]]).toEqual([b, c]);
    expect(after[1]).toBe(b);
    expect(after[2]).toBe(c);
  });

  it("at the bottom, a new message pulls the view down; scrolled up, it stays put and '↓ N new' counts", () => {
    const p = page();
    const sc = { scrollTop: 0, clientHeight: 500, scrollHeight: 2000 };
    p.nodes.scroller = sc;
    p.nodes.jumpLatest = { hidden: true, textContent: "" };
    say(p, 1, "w", "one");
    expect(sc.scrollTop, "it was not at the bottom: stays").toBe(0);
    expect([p.nodes.jumpLatest.hidden, p.nodes.jumpLatest.textContent]).toEqual([false, "↓ 1 new"]);
    say(p, 2, "w", "two");
    expect(p.nodes.jumpLatest.textContent).toBe("↓ 2 new");
    p.read("jumpLatest()");
    expect(sc.scrollTop).toBe(2000);
    expect(p.nodes.jumpLatest.hidden).toBe(true);
    sc.scrollTop = 1460;                                           // 40px above the bottom: counts as at it…
    say(p, 3, "w", "three");                                       // …so a new one follows
    expect(sc.scrollTop).toBe(2000);
    expect(p.nodes.jumpLatest.hidden).toBe(true);
  });

  it("while polling, the ticks come with the poll — the chat's history is never re-read in the background (#1253 review)", async () => {
    const p = page();
    p.read(`msgs.w = [{ boot: "b", id: 1, instance: "w", sender: "web-user", text: "hi", ts: "1", messageId: "web-1", delivery: "processing" }]`);
    const fetched: string[] = [];
    (p.c as any).recordFetch = (u: string) => fetched.push(u);
    p.read('fetch = async (u) => { recordFetch(u); return { ok: true, json: async () => ({ status: { uptime: 1, instances: [] }, messages: [], cursor: "b-1", deliveries: [{ instance: "w", messageId: "web-1", delivery: "delivered" }] }) }; }');
    p.read('api = async (m, path) => { recordFetch(path); return { messages: [] }; }');
    await p.read("pollOnce()");
    expect(fetched, "one passive poll, no history read").toEqual(["/ui/poll?after="]);
    expect(p.read("msgs.w[0].delivery")).toBe("delivered");
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

  it.each(["delivered", "failed", "cancelled"] as const)("a tick that became %s while the stream was down is caught up on reconnect — no new message, no poll (#1253 review)", (final) => {
    const p = page();
    const h = new WebChatHistory({ boot: "b1" });
    const m = h.record({ instance: "w", sender: "web-user", text: "hi", ts: "1", messageId: "web-1" });
    h.setDelivery("w", "web-1", final === "cancelled" ? "queued" : "processing");
    p.sse.message!({ data: JSON.stringify(m), lastEventId: h.cursorOf(m) });          // the page saw it…
    const seen = p.read("msgs.w[0].delivery");
    // …the stream drops; the report arrives while it is down…
    if (final === "cancelled") h.cancelPending("w"); else h.setDelivery("w", "web-1", final);
    // …and the browser reconnects with the cursor it had, before any fallback poll.
    const { c } = ctx({ webChatHistory: h, getUiStatus: () => ({ uptime: 1, instances: [] }) });
    const frames = connect(c, h.cursorOf(m));
    expect(frames.map(f => f.event), "nothing new to replay — only the status and the ticks").toEqual(["status", "deliveries"]);
    for (const f of frames) p.sse[f.event]!({ data: f.data, lastEventId: f.id });
    expect([seen, p.read("msgs.w[0].delivery")]).toEqual([final === "cancelled" ? "queued" : "processing", final]);
    expect(p.read("pollTimer"), "no poll was needed").toBeNull();
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
