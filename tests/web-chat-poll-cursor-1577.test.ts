/**
 * #1577 (baseline: the issue body; follow-up to #1565/#1566): after a restart that restored the web chat history, the
 * poll's cursor names the newest message its answer accounts for — the last restored one until this process records
 * its own — so a polling page (the public link, the stream's fallback) is not sent the restored history again every
 * 5 s. A fresh page still gets it once; the SSE cursors and reconnect replay of #1566 are unchanged.
 * The real /ui/poll and /ui/events handlers over a real WebChatHistory restored from another boot.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { WebChatHistory } from "../src/web-chat-history.js";

const TOKEN = "c".repeat(48);
function fakeRes() {
  const res = Object.assign(new EventEmitter(), {
    status: 0, body: "", writes: [] as string[], headers: {} as Record<string, unknown>,
    writeHead(status: number, headers?: Record<string, unknown>) { res.status = status; Object.assign(res.headers, headers ?? {}); return res; },
    setHeader(k: string, v: unknown) { res.headers[k] = v; },
    write(chunk: string) { res.writes.push(String(chunk)); return true; },
    end(chunk?: unknown) { if (chunk) res.body += String(chunk); return res; },
  });
  return res;
}
function call(url: string, ctx: WebApiContext, headers: Record<string, string> = {}) {
  const req = Object.assign(new EventEmitter(), { method: "GET", url, headers: { "x-agend-token": TOKEN, ...headers } });
  const res = fakeRes();
  expect(handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(url, "http://localhost"), ctx)).toBe(true);
  return { req, res };
}
const ctxWith = (history: WebChatHistory) => ({
  webToken: TOKEN, dataDir: "/tmp", sseClients: new Set(), fleetConfig: { instances: {} },
  getUiStatus: () => ({ instances: [], uptime: 1 }), emitSseEvent: () => {}, logger: { info() {}, debug() {}, error() {} },
  webChatHistory: history,
}) as unknown as WebApiContext;

type Polled = { messages: Array<{ boot: string; id: number; text: string }>; cursor: string };
const poll = (ctx: WebApiContext, after: string): Polled => JSON.parse(call(`/ui/poll?after=${encodeURIComponent(after)}`, ctx).res.body);
const shape = (p: Polled) => p.messages.map(m => `${m.boot}-${m.id}:${m.text}`);
const row = (boot: string, id: number, instance: string, ts: string) => ({ boot, id, instance, role: "user", sender: "u", text: `${instance}-${boot}${id}`, ts });

/** This process ("bb") after a restart: "w" kept three messages of boot aa, "x" two of boot cc (a later process). */
function restarted() {
  const h = new WebChatHistory({ boot: "bb" });
  h.restore("w", [row("aa", 1, "w", "2026-10-10T01:00:01Z"), row("aa", 2, "w", "2026-10-10T01:00:02Z"), row("aa", 3, "w", "2026-10-10T01:00:03Z")]);
  h.restore("x", [row("cc", 1, "x", "2026-10-10T02:00:01Z"), row("cc", 2, "x", "2026-10-10T02:00:02Z")]);
  return { h, ctx: ctxWith(h) };
}
const ALL = ["w-aa1", "w-aa2", "w-aa3", "x-cc1", "x-cc2"].map((t, i) => `${i < 3 ? "aa" : "cc"}-${i < 3 ? i + 1 : i - 2}:${t}`);

describe("a page that already holds the restored history is not sent it again", () => {
  it("the poll after the first one is empty until something new is said — then only that", () => {
    const { h, ctx } = restarted();
    const first = poll(ctx, "");
    expect(shape(first)).toEqual(ALL);
    expect(first.cursor, "the newest message the answer accounts for: the last restored one, in boot order").toBe("cc-2");
    const again = poll(ctx, first.cursor);
    expect([shape(again), again.cursor]).toEqual([[], "cc-2"]);
    h.record({ instance: "w", sender: "u", text: "new", ts: "2026-10-11T00:00:00Z" });
    const next = poll(ctx, again.cursor);
    expect([shape(next), next.cursor]).toEqual([["bb-1:new"], "bb-1"]);
    expect(shape(poll(ctx, next.cursor))).toEqual([]);
  });
  it("what a page polls stays small: the second answer carries none of the restored text", () => {
    const { ctx } = restarted();
    const first = call("/ui/poll?after=", ctx).res.body;
    const second = call(`/ui/poll?after=${JSON.parse(first).cursor}`, ctx).res.body;
    expect([first.includes("w-aa1"), second.includes("w-aa1"), second.includes("x-cc2")]).toEqual([true, false, false]);
  });
  it("nothing retained at all: the cursor is this boot's 0, as before — also once the restored chats were deleted", () => {
    const h = new WebChatHistory({ boot: "bb" });
    expect(poll(ctxWith(h), "")).toMatchObject({ messages: [], cursor: "bb-0" });
    const r = restarted();
    r.h.forget("w"); r.h.forget("x");
    expect(poll(r.ctx, "")).toMatchObject({ messages: [], cursor: "bb-0" });
  });
  it("once this process has said something, its newest id is the cursor — even if that chat was deleted since", () => {
    const { h, ctx } = restarted();
    h.record({ instance: "gone", sender: "u", text: "said", ts: "2026-10-11T00:00:00Z" });
    h.forget("gone");
    const p = poll(ctx, "");
    expect([shape(p), p.cursor]).toEqual([ALL, "bb-1"]);
    expect(shape(poll(ctx, p.cursor))).toEqual([]);
  });
});

describe("a fresh page still gets the full restored history, once", () => {
  it("no cursor yet: everything retained, restored and new, in boot order", () => {
    const { h, ctx } = restarted();
    h.record({ instance: "x", sender: "u", text: "new", ts: "2026-10-11T00:00:00Z" });
    const p = poll(ctx, "");
    expect([shape(p), p.cursor]).toEqual([[...ALL, "bb-1:new"], "bb-1"]);
  });
  it("a cursor of a boot this process does not hold (a page from before an older restart): everything retained", () => {
    const { ctx } = restarted();
    const p = poll(ctx, "ffff-9");
    expect([shape(p), p.cursor]).toEqual([ALL, "cc-2"]);
  });
});

describe("#1566's SSE contract is unchanged", () => {
  it("a stream reconnecting with a restored-boot cursor is sent what came after it, never what it has", () => {
    const { h, ctx } = restarted();
    h.record({ instance: "w", sender: "u", text: "new", ts: "2026-10-11T00:00:00Z" });
    const { req, res } = call("/ui/events", ctx, { "last-event-id": "aa-2" });
    req.emit("close");
    const ids = res.writes.filter(w => /^event: message$/m.test(w)).map(w => /^id: (\S+)$/m.exec(w)?.[1]);
    expect(ids).toEqual(["aa-3", "cc-1", "cc-2", "bb-1"]);
    expect(h.replayFor({ boot: "cc", id: 2 }).map(m => `${m.boot}-${m.id}`)).toEqual(["bb-1"]);
    expect(h.replayFor({ boot: "bb", id: 1 })).toEqual([]);
  });
  it("each message's SSE cursor is its own boot and id", () => {
    const { h } = restarted();
    expect(h.list("x").map(m => h.cursorOf(m))).toEqual(["cc-1", "cc-2"]);
  });
});
