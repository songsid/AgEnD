/**
 * M-2260 (the user, hmsg-16c13410): a dashboard tab left open for half a day showed the chat "loading" for ever when
 * looked at again (「正在載入目前的狀態…」, then "Could not load…"), while F5 showed the newest at once.
 * Root cause (reproduced in a real browser, scripts/manual/smoke/smoke-long-idle.mts): the catch-up after the stream
 * came back read every message it missed in ONE /ui/poll answer — up to 500 across every agent plus every tick,
 * megabytes — and a slow link (WSL's relay, a tunnel) could not bring it within the page's 10 s poll limit: the answer
 * was dropped, the same read asked for again from the same cursor, then given up. A tab the browser froze also woke to
 * every heartbeat it missed, thousands of whole status snapshots, each redrawn.
 *  - the server: a catch-up carries only the newest messages within CATCH_UP_MAX (at least one) and says `truncated`
 *    when it left older ones out — for an admin's and a guest's poll, and for an empty ("fresh") cursor too;
 *  - the page: `truncated` → "gap" → each chat reads its newest history again (the one on screen at once, the others on
 *    their next visit) and keeps only that and what arrived meanwhile — what a reload shows, never a hole;
 *  - a burst of status frames is one (the newest), in order with every other event; a single heartbeat is as before;
 *  - a catch-up that still fails offers a reload beside Try again.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { CATCH_UP_MAX, WebChatHistory, catchUpWindow } from "../src/web-chat-history.js";
import { guestPollBody } from "../src/web-guest-access.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const TOKEN = "c".repeat(48);
function call(url: string, ctx: WebApiContext) {
  const res = Object.assign(new EventEmitter(), { status: 0, body: "", headers: {} as Record<string, unknown>,
    writeHead(status: number) { res.status = status; return res; }, setHeader() {}, write() { return true; }, end(chunk?: unknown) { if (chunk) res.body += String(chunk); return res; } });
  const req = Object.assign(new EventEmitter(), { method: "GET", url, headers: { "x-agend-token": TOKEN } });
  expect(handleWebRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, new URL(url, "http://localhost"), ctx)).toBe(true);
  return JSON.parse(res.body);
}
const ctxWith = (history: WebChatHistory) => ({
  webToken: TOKEN, dataDir: "/tmp", sseClients: new Set(), fleetConfig: { instances: {} },
  getUiStatus: () => ({ instances: [], uptime: 1 }), emitSseEvent: () => {}, logger: { info() {}, debug() {}, error() {} },
  webChatHistory: history,
}) as unknown as WebApiContext;
const REPLY = "x".repeat(6000);                          // an agent's reply of a few KB, as real ones are
/** Half a day: `n` replies across three agents. */
function busyDay(n: number) {
  const h = new WebChatHistory({ boot: "bb" });
  for (let i = 1; i <= n; i++) h.record({ instance: ["w", "x", "y"][i % 3]!, sender: "a", role: "agent", text: `reply ${i} ${REPLY}`, ts: new Date(1_800_000_000_000 + i * 60_000).toISOString() });
  return h;
}

describe("the server: a catch-up within a budget, saying when it left older messages out", () => {
  it("the window keeps the newest, by count and by size, at least one; within the budget nothing is left out", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ i, text: "y".repeat(100) }));
    expect(catchUpWindow(rows)).toEqual({ messages: rows, truncated: false });
    expect(catchUpWindow(rows, { messages: 3, bytes: 1e9 })).toEqual({ messages: rows.slice(-3), truncated: true });
    const size = JSON.stringify(rows[0]).length;
    expect(catchUpWindow(rows, { messages: 100, bytes: size * 4 + 1 })).toEqual({ messages: rows.slice(-4), truncated: true });
    expect(catchUpWindow([{ text: "z".repeat(5000) }, { text: "z".repeat(5000) }], { messages: 100, bytes: 10 }).messages).toHaveLength(1);
    expect(catchUpWindow([])).toEqual({ messages: [], truncated: false });
  });
  it("half a day behind: the answer is the newest within the budget, the cursor the newest, and `truncated` — not megabytes", () => {
    const h = busyDay(600), ctx = ctxWith(h);
    const early = call("/ui/poll?after=bb-1", ctx);
    const size = JSON.stringify(early.messages).length;
    expect(early.truncated).toBe(true);
    expect(size).toBeLessThanOrEqual(CATCH_UP_MAX.bytes);
    expect(early.messages.at(-1).text).toMatch(/^reply 600 /);
    expect(early.cursor).toBe("bb-600");
    // Before the fix the same read carried the newest 500: about 3 MB.
    expect(JSON.stringify(h.replayFor({ boot: "bb", id: 1 })).length).toBeGreaterThan(2_500_000);
    // From that cursor on, nothing is left out, and the flag is absent.
    h.record({ instance: "w", sender: "a", role: "agent", text: "after", ts: new Date().toISOString() });
    const next = call(`/ui/poll?after=${early.cursor}`, ctx);
    expect([next.messages.map((m: any) => m.text), next.truncated]).toEqual([["after"], undefined]);
  });
  it("a quiet page's empty cursor (#1577's fresh read: everything retained) is bounded the same way", () => {
    const fresh = call("/ui/poll?after=", ctxWith(busyDay(600)));
    expect([fresh.truncated, JSON.stringify(fresh.messages).length <= CATCH_UP_MAX.bytes]).toEqual([true, true]);
  });
  it("a small gap is answered whole, as before", () => {
    const h = busyDay(5);
    expect(call("/ui/poll?after=bb-1", ctxWith(h))).toMatchObject({ messages: [{}, {}, {}, {}], cursor: "bb-5" });
    expect(call("/ui/poll?after=bb-1", ctxWith(h)).truncated).toBeUndefined();
  });
  it("a guest's poll: the same budget, measured on what it may see", () => {
    const h = busyDay(600);
    // A guest whose own room every agent is (it may see every message), on a Telegram account.
    const guest = { owner: { adapterId: "telegram", userId: "42" }, current: () => true, ownRoom: () => true, history: () => h, scope: () => new Set(["w", "x", "y"]) } as any;
    const body = guestPollBody({ instances: [] }, new Set(["w", "x", "y"]), 1, guest, "bb-1", (after) => h.replayFor({ boot: "bb", id: Number(String(after).split("-")[1]) })) as any;
    expect(body.truncated).toBe(true);
    expect(JSON.stringify(body.messages).length).toBeLessThanOrEqual(CATCH_UP_MAX.bytes);
  });
});

let p: AppPage;
beforeAll(() => { p = page({ url: "http://localhost/ui/chat/w", storage: { agend_lang: "en" } }); });
afterAll(() => p.restore());

function streamEnv() {
  const sources: any[] = [], reads: Array<{ url: string; open: (body: unknown) => void }> = [];
  class ES { url: string; listeners: Record<string, Function> = {}; onerror: Function | null = null;
    constructor(url: string) { this.url = url; sources.push(this); } addEventListener(n: string, f: Function) { this.listeners[n] = f; } close() {} }
  const env = { EventSource: ES, setTimeout, clearTimeout, setInterval, clearInterval, console,
    fetch: (u: string) => new Promise((resolve) => reads.push({ url: u, open: (body) => resolve({ ok: true, status: 200, json: async () => body }) })) };
  return { env, sources, reads };
}
const snap = (over: Record<string, unknown> = {}) => ({ status: { instances: [] }, messages: [], cursor: "bb-5", deliveries: [], prompts: [], needs: [], ...over });
const macrotask = () => new Promise((r) => setTimeout(r, 5));

describe("the page: a gap, and bursts of heartbeats", () => {
  it("a truncated catch-up says `gap` once, after its messages; a whole one says nothing", async () => {
    const { createStream } = await import("/assets/app-stream.js") as any;
    const e = streamEnv(), s = createStream({ mode: "full", env: e.env });
    const seen: string[] = [];
    s.on("message", (m: any) => seen.push(`message:${m.id}`)); s.on("gap", () => seen.push("gap"));
    s.start();
    const first = s.catchUp();
    e.reads[0]!.open(snap({ messages: [{ id: 9 }], truncated: true }));
    await expect(first).resolves.toBe(true);
    const second = s.catchUp();
    e.reads[1]!.open(snap({ messages: [{ id: 10 }] }));
    await expect(second).resolves.toBe(true);
    expect(seen).toEqual(["message:9", "gap", "message:10"]);
    s.close();
  });
  it("a burst of status frames (a frozen tab waking) is delivered as its first and its newest; a lone heartbeat at once, as before", async () => {
    const { createStream } = await import("/assets/app-stream.js") as any;
    const e = streamEnv(), s = createStream({ mode: "full", env: e.env });
    const seen: number[] = [];
    s.on("status", (d: any) => seen.push(d.n));
    s.start();
    const fire = (n: number) => e.sources[0].listeners.status({ data: JSON.stringify({ n }) });
    for (let n = 1; n <= 4320; n++) fire(n);
    expect(seen).toEqual([1]);                              // at once: the first; the rest wait for the next turn
    await macrotask();
    expect(seen).toEqual([1, 4320]);                        // …and only the newest of them is drawn
    fire(4321);
    expect(seen).toEqual([1, 4320, 4321]);                  // a heartbeat after a quiet moment: at once
    s.close();
  });
  it("order never changes: a status waiting goes before the next other event, and before a read's snapshot", async () => {
    const { createStream } = await import("/assets/app-stream.js") as any;
    const e = streamEnv(), s = createStream({ mode: "full", env: e.env });
    const seen: string[] = [];
    s.on("status", (d: any) => seen.push(`status:${d.n}`)); s.on("message", (m: any) => seen.push(`message:${m.id}`));
    s.start();
    const L = e.sources[0].listeners;
    L.status({ data: JSON.stringify({ n: 1 }) }); L.status({ data: JSON.stringify({ n: 2 }) }); L.status({ data: JSON.stringify({ n: 3 }) });
    L.message({ data: JSON.stringify({ id: 7 }), lastEventId: "bb-7" });
    expect(seen).toEqual(["status:1", "status:3", "message:7"]);
    L.status({ data: JSON.stringify({ n: 4 }) });           // still in the same turn: waits…
    const read = s.catchUp();                                // …and a read starting now delivers it first
    expect(seen.at(-1)).toBe("status:4");
    e.reads[0]!.open(snap({ status: { n: 5 } }));
    await read;
    expect(seen.slice(-2)).toEqual(["status:4", "status:5"]);
    s.close();
  });
  for (const leave of ["close", "suspend"] as const) {
    it(`a page let go of (${leave}) never delivers a status still waiting`, async () => {
      const { createStream } = await import("/assets/app-stream.js") as any;
      const e = streamEnv(), s = createStream({ mode: "full", env: e.env });
      const seen: number[] = [];
      s.on("status", (d: any) => seen.push(d.n));
      s.start();
      e.sources[0].listeners.status({ data: JSON.stringify({ n: 1 }) }); e.sources[0].listeners.status({ data: JSON.stringify({ n: 2 }) });
      s[leave]();
      await macrotask();
      expect(seen).toEqual([1]);
      s.close();
    });
  }
});

describe("the chats after a gap: what a reload would show", () => {
  const msg = (id: number, text = `m${id}`) => ({ boot: "bb", id, instance: "w", sender: "w", role: "agent", text, ts: new Date(1_800_000_000_000 + id).toISOString() });
  async function store(history: () => unknown[]) {
    const { createChatStore } = await import("/ui/js/chat-store.js") as any;
    const reads: string[] = [];
    let release: (() => void) | null = null;
    const fetch = vi.fn(async (path: string) => {
      reads.push(path);
      await new Promise<void>((r) => { release = r; });
      return { json: async () => ({ messages: history() }) };
    });
    const st = createChatStore({ fetch, t: (k: string) => k, toast: vi.fn(), announce: vi.fn(), now: () => 1, setTimeout, confirm: vi.fn() });
    return { st, reads, answer: async () => { await vi.waitFor(() => expect(release).not.toBeNull()); const r = release!; release = null; r(); await settle(5); } };
  }
  it("the chat on screen reads its newest history at once; the old messages across the hole go, what arrived meanwhile stays", async () => {
    const { st, reads, answer } = await store(() => [msg(500), msg(501), msg(502)]);
    st.setCurrent("w");
    for (const id of [1, 2, 3]) st.ingest(msg(id));          // what the page held before the half day
    st.ingest(msg(502));                                     // the catch-up's newest (the rest was left out)
    st.onGap();
    expect(reads).toEqual(["/ui/history?instance=w&limit=200"]);
    st.ingest(msg(503));                                     // said while the read was out
    await answer();
    expect(st.state.msgs.w.map((m: any) => m.id)).toEqual([500, 501, 502, 503]);
  });
  it("a chat not on screen reads again when it is next opened (and only then), and shows what a reload would", async () => {
    const { st, reads, answer } = await store(() => [{ ...msg(900), instance: "x" }]);
    st.setCurrent("w");
    const before = st.openHistory("x");                      // read once before the half day
    await answer(); await before;
    st.ingest({ ...msg(1), instance: "x" });
    expect(await st.openHistory("x")).toBe(false);           // opened again: nothing read (as before)
    st.onGap();
    await answer();                                          // only the chat on screen reads now
    expect(reads.filter(r => r.includes("instance=x"))).toHaveLength(1);
    const again = st.openHistory("x");                       // next opened: read again
    await answer(); await again;
    expect(reads.filter(r => r.includes("instance=x"))).toHaveLength(2);
    expect(st.state.msgs.x.map((m: any) => m.id)).toEqual([900]);
  });
  it("a read after a gap that fails keeps the chat to read again (and drops nothing meanwhile)", async () => {
    const { createChatStore } = await import("/ui/js/chat-store.js") as any;
    let fail = true;
    const fetch = vi.fn(async () => { if (fail) throw new Error("offline"); return { json: async () => ({ messages: [msg(700)] }) }; });
    const st = createChatStore({ fetch, t: (k: string) => k, toast: vi.fn(), announce: vi.fn(), now: () => 1, setTimeout, confirm: vi.fn() });
    st.setCurrent("w"); st.ingest(msg(1));
    st.onGap(); await settle(5);
    expect(st.state.msgs.w.map((m: any) => m.id)).toEqual([1]);
    fail = false;
    await st.openHistory("w");
    expect(st.state.msgs.w.map((m: any) => m.id)).toEqual([700]);
  });
  it("without a gap, a history read merges as before (nothing the page held is dropped)", async () => {
    const { st, answer } = await store(() => [msg(5), msg(6)]);
    st.ingest(msg(1));
    const r = st.openHistory("w");
    await answer(); await r;
    expect(st.state.msgs.w.map((m: any) => m.id)).toEqual([1, 5, 6]);
  });
});

describe("never a dead end", () => {
  it("a catch-up that still fails offers Reload the page beside Try again", async () => {
    const shell = await import("/assets/app-shell.js") as any;
    const { appStore } = await import("/assets/app-store.js") as any;
    const retry = vi.fn();
    appStore.set({ hydration: "failed", retryHydration: retry, connection: "live" });
    await p.mount(h(shell.ConnectionLine, {}));
    await settle(5);
    const buttons = [...p.root.querySelectorAll("button")].map((b: any) => b.textContent.trim());
    expect(buttons).toEqual(["Try again", "Reload the page"]);
    await p.unmount();
    appStore.set({ hydration: "ok", retryHydration: null });
  });
});
