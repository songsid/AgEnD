import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { FleetManager } from "../src/fleet-manager.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
// @ts-expect-error — served browser ESM
import { createLiveAgentReplies } from "../src/ui/chat-live-replies.js";
// @ts-expect-error — served browser ESM
import { createStream } from "../src/ui/shared/app-stream.js";
const BOOT = "abc123", INSTANCE = "worker";
const message = (id = 1, patch: Record<string, unknown> = {}) => ({ boot: BOOT, id, instance: INSTANCE, role: "agent", sender: INSTANCE, text: "private reply", ts: "t", ...patch });
const receipt = (id = 1, patch: Record<string, unknown> = {}) => ({ v: 1, boot: BOOT, id, instance: INSTANCE, ...patch });
const source = (receivedAt = 0) => ({ source: "sse", receivedAt });
function collector() { let time = 0; const fn = vi.fn(), c = createLiveAgentReplies(() => time); c.subscribe(fn); return { c, fn, set time(t: number) { time = t; } }; }
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fakeRes() {
  const res = Object.assign(new EventEmitter(), { writes: [] as string[], body: "", status: 0,
    writeHead(status: number) { res.status = status; return res; }, setHeader() {},
    write(chunk: unknown) { res.writes.push(String(chunk)); return true; }, end(chunk?: unknown) { if (chunk) res.body += String(chunk); return res; } }); return res;
}
function call(path: string, ctx: WebApiContext, headers = {}) {
  const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { "x-agend-token": "token", ...headers } }), res = fakeRes();
  expect(handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(path, "http://localhost"), ctx)).toBe(true); return res;
}
describe("#1629 live-only server reply receipts", () => {
  it("records and sends the message first, then a content-free receipt without cursor; no receipt in history/poll/replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "fresh-reply-")); dirs.push(dir); const fm = new FleetManager(dir), res = fakeRes();
    (fm as any).sseClients.add(res); fm.emitSseEvent("message", message());
    expect(res.writes).toHaveLength(2); expect(res.writes[0]).toContain("event: message\n"); expect(res.writes[0]).toMatch(/^id: /);
    const recorded = fm.webChatHistory.list(INSTANCE)[0]!;
    expect(res.writes[1]).toBe(`event: agent_reply_live\ndata: ${JSON.stringify({ v: 1, boot: recorded.boot, id: recorded.id, instance: INSTANCE })}\n\n`);
    expect(Object.keys(recorded)).not.toContain("agent_reply_live"); expect(fm.webChatHistory.lastId).toBe(1);
    const ctx = { webToken: "token", dataDir: dir, sseClients: new Set(), fleetConfig: { instances: {} }, getUiStatus: () => ({ ok: true }), emitSseEvent() {}, logger: { info() {}, debug() {}, error() {} }, webChatHistory: fm.webChatHistory } as unknown as WebApiContext;
    expect(call(`/ui/history?instance=${INSTANCE}`, ctx).body).not.toContain("agent_reply_live"); expect(call("/ui/poll?after=", ctx).body).not.toContain("agent_reply_live");
    const replay = call("/ui/events", ctx, { "last-event-id": `${recorded.boot}-0` }); expect(replay.writes.some(x => x.includes("event: message\n"))).toBe(true); expect(replay.writes.join("")).not.toContain("agent_reply_live"); replay.emit("close");
  });
  it.each([undefined, "user", "status", "wrong"])("sender agent with role %s grants no receipt", role => {
    const dir = mkdtempSync(join(tmpdir(), "fresh-role-")); dirs.push(dir); const fm = new FleetManager(dir), res = fakeRes(); (fm as any).sseClients.add(res);
    fm.emitSseEvent("message", message(1, { sender: "agent", role })); expect(res.writes).toHaveLength(1); expect(res.writes[0]).toContain("event: message\n");
  });
});
describe("#1629 fresh reply collector", () => {
  it("emits once, with exact frozen identity and no content, and does not replay to late listeners", () => {
    const h = collector(); h.c.message(message(), source()); expect(h.fn).not.toHaveBeenCalled(); expect(h.c.receipt(receipt(), source())).toBe(true);
    const got = h.fn.mock.calls[0]![0]; expect(got).toEqual(receipt()); expect(Object.isFrozen(got)).toBe(true); expect(Object.keys(got)).toEqual(["v", "boot", "id", "instance"]);
    expect(h.c.receipt(receipt(), source())).toBe(false); h.c.message(message(), source()); expect(h.c.receipt(receipt(), source())).toBe(false); expect(h.fn).toHaveBeenCalledOnce();
    const late = vi.fn(); h.c.subscribe(late); expect(late).not.toHaveBeenCalled();
  });
  it.each([undefined, { source: "poll" }, { source: "history" }, { source: "poll", receivedAt: 0 }, { source: "history", receivedAt: 0 }])("non-SSE message ingress %j cannot pair with a live receipt", extra => {
    const h = collector(); h.c.message(message(), extra); expect(h.c.receipt(receipt(), source())).toBe(false); h.c.message(message(), source()); expect(h.c.receipt(receipt(), source())).toBe(false);
  });
  it.each(["user", "status", undefined])("non-agent role %s cannot pulse", role => { const h = collector(); h.c.message(message(1, { role }), source()); expect(h.c.receipt(receipt(), source())).toBe(false); });
  it("receipt-before-message, mismatches and an unknown id never pulse", () => {
    const h = collector(); expect(h.c.receipt(receipt(), source())).toBe(false); h.c.message(message(), source()); expect(h.c.receipt(receipt(2), source())).toBe(false); expect(h.c.receipt(receipt(1, { instance: "other" }), source())).toBe(false); expect(h.fn).not.toHaveBeenCalled();
  });
  it("watermarks survive 501 messages and admit a genuinely new reply at the cap", () => {
    const h = collector(); for (let id = 1; id <= 501; id++) { h.c.message(message(id), source()); h.c.receipt(receipt(id), source()); } expect(h.fn).toHaveBeenCalledTimes(501);
    h.c.message(message(1), source()); expect(h.c.receipt(receipt(1), source())).toBe(false); h.c.message(message(502), source()); expect(h.c.receipt(receipt(502), source())).toBe(true); expect(h.fn).toHaveBeenCalledTimes(502);
  });
  it("a new boot can reuse an id; an older id after a history watermark cannot", () => {
    const h = collector(); h.c.message(message(10)); h.c.message(message(2), source()); expect(h.c.receipt(receipt(2), source())).toBe(false);
    h.c.message(message(2, { boot: "def456" }), source()); expect(h.c.receipt(receipt(2, { boot: "def456" }), source())).toBe(true);
  });
  it.each([5001, 10000])("held SSE older than five seconds (%sms) cannot refresh itself", age => {
    const h = collector(); h.time = age; h.c.message(message(), source(0)); expect(h.c.receipt(receipt(), source(age))).toBe(false); expect(h.fn).not.toHaveBeenCalled();
  });
  it("exact freshness boundary succeeds; stale candidate/future receipt/backward ingress refuse", () => {
    const h = collector(); h.c.message(message(), source()); h.time = 5000; expect(h.c.receipt(receipt(), source(5000))).toBe(true);
    h.c.message(message(2), source(5000)); h.time = 10001; expect(h.c.receipt(receipt(2), source(10001))).toBe(false);
    h.c.message(message(3), source(20000)); expect(h.c.receipt(receipt(3), source(10001))).toBe(false);
    h.c.message(message(4), source(10001)); expect(h.c.receipt(receipt(4), source(10000))).toBe(false);
  });
  it.each([NaN, Infinity, -1])("invalid clock %s permanently revokes notifications", time => { const h = collector(); h.c.message(message(), source()); h.time = time; expect(h.c.receipt(receipt(), source())).toBe(false); h.time = 1; h.c.message(message(2), source(1)); expect(h.c.receipt(receipt(2), source(1))).toBe(false); });
  it("clock rollback and thrown clock permanently revoke", () => {
    const h = collector(); h.time = 5; h.c.message(message(), source(5)); h.time = 4; expect(h.c.receipt(receipt(), source(4))).toBe(false); h.time = 6; h.c.message(message(2), source(6)); expect(h.c.receipt(receipt(2), source(6))).toBe(false);
    let bad = true; const c = createLiveAgentReplies(() => { if (bad) throw Error("clock"); return 1; }); c.message(message(), source()); bad = false; c.message(message(2), source(1)); expect(c.receipt(receipt(2), source(1))).toBe(false);
  });
  it.each([{ text: "secret" }, { targets: ["person"] }, { v: 2 }, { id: 0 }, { id: 1.5 }, { id: Infinity }, { boot: "not hex" }, { instance: "" }, { instance: "x".repeat(129) }])("refuses malformed/extra receipt %j", patch => { const h = collector(); h.c.message(message(), source()); expect(h.c.receipt(receipt(1, patch), source())).toBe(false); expect(h.fn).not.toHaveBeenCalled(); });
  it("does not read message text, people, attachments or target getters", () => {
    const h = collector(), m = message(), getter = vi.fn(() => { throw Error("private content"); });
    for (const key of ["text", "sender", "attachments", "targets", "author"]) Object.defineProperty(m, key, { get: getter });
    h.c.message(m, source()); expect(h.c.receipt(receipt(), source())).toBe(true); expect(getter).not.toHaveBeenCalled(); expect(h.fn.mock.calls[0]![0]).toEqual(receipt());
  });
  it("never invokes receipt/metadata getters", () => {
    const h = collector(), getter = vi.fn(() => "private"); h.c.message(message(), source()); const r = receipt(); Object.defineProperty(r, "text", { get: getter }); expect(h.c.receipt(r, source())).toBe(false);
    const extra = { source: "sse" }; Object.defineProperty(extra, "receivedAt", { get: getter }); expect(h.c.receipt(receipt(), extra)).toBe(false); expect(getter).not.toHaveBeenCalled();
  });
  it("boot exhaustion fails closed; replay candidates stay bounded without disabling later live replies", () => {
    const h = collector(); for (let id = 1; id <= 65; id++) h.c.message(message(1, { boot: id.toString(16) })); h.c.message(message(2), source()); expect(h.c.receipt(receipt(2), source())).toBe(false);
    const p = collector(); for (let id = 1; id <= 65; id++) p.c.message(message(id), source()); expect(p.c.receipt(receipt(1), source())).toBe(false); expect(p.c.receipt(receipt(65), source())).toBe(true); p.c.message(message(66), source()); expect(p.c.receipt(receipt(66), source())).toBe(true);
  });
  it("subscriber exceptions/reentry are isolated, unsubscribe works, and receipt is consumed before callbacks", () => {
    const h = collector(), removed = vi.fn(), off = h.c.subscribe(removed), other = vi.fn(); off(); h.c.subscribe(() => { h.c.receipt(receipt(), source()); throw Error("display"); }); h.c.subscribe(other);
    h.c.message(message(), source()); expect(h.c.receipt(receipt(), source())).toBe(true); expect(h.fn).toHaveBeenCalledOnce(); expect(other).toHaveBeenCalledOnce(); expect(removed).not.toHaveBeenCalled(); expect(h.c.subscribe(null)).toBeTypeOf("function");
  });
});

async function browser({ prime = true } = {}) {
  let time = 0, answer: any = { messages: [], cursor: "", status: { instances: [] } }, release: ((value: any) => void) | null = null, held = false;
  const sources: any[] = [];
  const fetch = vi.fn(async (url: string) => {
    const body = url.startsWith("/ui/history") ? { messages: answer.messages } : held ? await new Promise(r => { release = r; }) : answer;
    return { ok: true, status: 200, json: async () => body };
  });
  class ES {
    listeners: Record<string, Function> = {}; onerror: Function | null = null; closed = false;
    constructor() { sources.push(this); } addEventListener(name: string, fn: Function) { this.listeners[name] = fn; } close() { this.closed = true; }
    frame(name: string, value: unknown, cursor?: string) { this.listeners[name]?.({ data: JSON.stringify(value), lastEventId: cursor }); }
  }
  const env = { fetch, EventSource: ES, performance: { now: () => time }, setTimeout, clearTimeout, setInterval, clearInterval, random: () => 1 };
  const stream = createStream({ mode: "full", env });
  const { createChatStore } = await import("/ui/js/chat-store.js") as any;
  const store = createChatStore({ fetch, toast() {}, announce() {}, t: (key: string) => key, now: () => time }); store.attach(stream); store.setCurrent(INSTANCE); stream.start();
  const fn = vi.fn(); store.onAgentReply(fn); if (prime) sources[0].frame("status", { instances: [] });
  return { stream, store, fn, sources, set time(value: number) { time = value; }, set answer(value: any) { answer = value; }, set held(value: boolean) { held = value; }, release(value: any) { release!(value); } };
}
describe("#1629 actual stream → chat-store live receipt wiring", () => {
  afterEach(() => vi.useRealTimers());
  it.each([0, 5000, 5001, 6000])("captures first message before a slow connection observer (%sms)", async age => {
    vi.useFakeTimers(); const h = await browser({ prime: false }), delivered: any[] = [];
    h.stream.on("connection", (state: string) => { if (state === "live") h.time = age; });
    h.stream.on("message", (_m: any, extra: any) => delivered.push(extra));
    h.sources[0].frame("message", message(), `${BOOT}-1`); h.sources[0].frame("agent_reply_live", receipt());
    expect(h.fn).toHaveBeenCalledTimes(age <= 5000 ? 1 : 0); expect(delivered).toEqual([{ source: "sse", receivedAt: 0 }]); expect(h.stream.cursor()).toBe(`${BOOT}-1`); h.stream.close();
  });
  it.each([5000, 5001, 6000])("captures reconnect message before a slow hydration observer (%sms)", async age => {
    vi.useFakeTimers(); const h = await browser(), delivered: any[] = [];
    h.sources[0].onerror(); h.time = 1000; await vi.advanceTimersByTimeAsync(1000); expect(h.sources).toHaveLength(2);
    h.stream.on("hydration", (state: string) => { if (state === "catching") h.time = 1000 + age; });
    h.stream.on("message", (_m: any, extra: any) => delivered.push(extra));
    h.sources[1].frame("message", message(), `${BOOT}-1`); h.sources[1].frame("agent_reply_live", receipt()); await vi.advanceTimersByTimeAsync(0);
    expect(h.fn).toHaveBeenCalledTimes(age <= 5000 ? 1 : 0); expect(delivered).toEqual([{ source: "sse", receivedAt: 1000 }]); expect(h.stream.cursor()).toBe(`${BOOT}-1`); h.stream.close();
  });
  it("a fresh accepted SSE pair pulses once; replayed/duplicate pairs and evicted identities do not", async () => {
    vi.useFakeTimers(); const h = await browser();
    for (let id = 1; id <= 501; id++) { h.sources[0].frame("message", message(id), `${BOOT}-${id}`); h.sources[0].frame("agent_reply_live", receipt(id)); }
    expect(h.store.state.msgs[INSTANCE]).toHaveLength(500); expect(h.fn).toHaveBeenCalledTimes(501);
    h.sources[0].frame("message", message(1), `${BOOT}-1`); h.sources[0].frame("agent_reply_live", receipt(1)); expect(h.fn).toHaveBeenCalledTimes(501);
    h.sources[0].frame("message", message(502), `${BOOT}-502`); h.sources[0].frame("agent_reply_live", receipt(502)); expect(h.fn).toHaveBeenCalledTimes(502); expect(h.store.state.msgs[INSTANCE]).toHaveLength(500); h.stream.close();
  });
  it("actual history and poll acceptance prevent a subsequent duplicated SSE pair from pulsing", async () => {
    vi.useFakeTimers(); const h = await browser(); h.answer = { messages: [message(5)], cursor: `${BOOT}-5`, agent_reply_live: receipt(5) };
    await h.store.openHistory(INSTANCE); h.sources[0].frame("message", message(5), `${BOOT}-5`); h.sources[0].frame("agent_reply_live", receipt(5)); expect(h.fn).not.toHaveBeenCalled();
    h.answer = { messages: [message(6)], cursor: `${BOOT}-6`, agent_reply_live: receipt(6) }; expect(await h.stream.catchUp()).toBe(true);
    h.sources[0].frame("message", message(6), `${BOOT}-6`); h.sources[0].frame("agent_reply_live", receipt(6)); expect(h.fn).not.toHaveBeenCalled(); h.stream.close();
  });
  it.each([0, 5001])("held catchup preserves order and original arrival time (held %sms)", async age => {
    vi.useFakeTimers(); const h = await browser(), delivered: any[] = [];
    h.stream.on("message", (m: any, extra: any) => delivered.push([m.id, extra])); h.stream.on("agent_reply_live", (_r: any, extra: any) => delivered.push(["receipt", extra]));
    h.held = true; const read = h.stream.catchUp(); h.sources[0].frame("message", message(2), `${BOOT}-2`); h.sources[0].frame("agent_reply_live", receipt(2), "wrong-cursor-999"); expect(h.fn).not.toHaveBeenCalled();
    h.time = age; h.release({ messages: [message(1)], cursor: `${BOOT}-1`, agent_reply_live: receipt(1) }); expect(await read).toBe(true);
    expect(delivered).toEqual([[1, { source: "poll" }], [2, { source: "sse", receivedAt: 0 }], ["receipt", { source: "sse", receivedAt: 0 }]]);
    expect(h.fn).toHaveBeenCalledTimes(age === 0 ? 1 : 0); expect(h.stream.cursor()).toBe(`${BOOT}-2`); h.stream.close();
  });
  it("unknown receipt before a message, role status, delivery/button changes and old EventSource cannot pulse", async () => {
    vi.useFakeTimers(); const h = await browser(); h.sources[0].frame("agent_reply_live", receipt()); h.sources[0].frame("message", message(1, { role: "status" }), `${BOOT}-1`); h.sources[0].frame("agent_reply_live", receipt());
    h.sources[0].frame("delivery", { instance: INSTANCE, messageId: "x", delivery: { state: "delivered" } }); h.sources[0].frame("reply_buttons", { instance: INSTANCE }); expect(h.fn).not.toHaveBeenCalled();
    h.stream.suspend(); h.sources[0].frame("message", message(2), `${BOOT}-2`); h.sources[0].frame("agent_reply_live", receipt(2)); expect(h.fn).not.toHaveBeenCalled(); h.stream.close();
  });
});
