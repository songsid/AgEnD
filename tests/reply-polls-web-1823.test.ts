/**
 * #1823 part 2: polls in the web chat. The real FleetManager reply path, the real POST /ui/reply-button route (local
 * session, header token, and the public link through the real gateway), the real web history, and the page's own
 * modules (chat-render, chat-store, chat-thread) on the mini DOM. Nothing starts a fleet, tmux or a process.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDom } from "./helpers/mini-dom.js";
import { FleetManager } from "../src/fleet-manager.js";
import { handleWebRequest } from "../src/web-api.js";
import { createPublicWebGateway } from "../src/public-web-gateway.js";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { WebChatHistory } from "../src/web-chat-history.js";
import type { ReplyButtonStore } from "../src/reply-buttons.js";

type Served = any;
let createThread: any, createChatStore: any, t: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  ({ createThread } = await (import("/ui/js/chat-thread.js") as Promise<Served>));
  ({ createChatStore } = await (import("/ui/js/chat-store.js") as Promise<Served>));
  await (import("/ui/js/chat-strings.js") as Promise<Served>);
  ({ t } = await (import("/assets/app-i18n.js") as Promise<Served>));
});

const dirs: string[] = [];
const fleets: FleetManager[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const fm of fleets.splice(0)) {
    const any = fm as any;
    any.replyButtonsCtl?.stop(); any.replyButtonsStore?.close();
    try { any.deliveryOutbox?.close(); } catch { /* closed */ }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1823w-")); dirs.push(d); return d; };
const BUTTONS = [{ label: "Paris" }, { label: "London" }, { label: "Rome" }];
const R = () => (globalThis as any).AgendChatRender;

/** A web-only fleet (no chat platform): the web chat is where the poll is. */
function webFleet() {
  const dir = scratch();
  const fm = new FleetManager(dir);
  fleets.push(fm);
  const any = fm as any;
  any.fleetConfig = { defaults: {}, instances: { w: { working_directory: "/tmp" } } };
  const answers: any[] = [];
  any.instanceIpcClients.set("w", { send: (m: unknown) => { answers.push(m); return true; } });
  any.getInstanceIdle = () => true; any.clearCancelButton = () => {}; any.reactDone = () => {};
  any.deliverToInstance = vi.fn(async () => true);
  const sse: Array<{ event: string; data: any }> = [];
  const realEmit = any.emitSseEvent.bind(fm);
  any.emitSseEvent = (event: string, data: any) => { sse.push({ event, data }); realEmit(event, data); };
  const ctl = () => { const c = any.replyButtons(); c.deps.monotonic = () => Date.now(); return c; };
  const reply = async (args: Record<string, unknown>) => {
    const before = answers.length;
    await any.handleOutboundFromInstance("w", { tool: "reply", args, fleetRequestId: `r${before}` });
    await vi.waitFor(() => expect(answers.length).toBeGreaterThan(before));
    return answers[answers.length - 1];
  };
  const pollMsg = () => fm.webChatHistory.list("w").filter(m => m.role === "agent").at(-1)!;
  return { fm, any, sse, ctl, reply, pollMsg, dir };
}

/** POST /ui/reply-button through the real route, as a local page with a session (or the CLI's header token). */
async function post(ctx: unknown, body: Record<string, unknown>, who: { sessionId?: string; token?: string }) {
  const host = "127.0.0.1:19280", origin = `http://${host}`;
  const headers: Record<string, string> = { host, origin, "content-type": "application/json" };
  if (who.sessionId) { headers.cookie = `agend_session=${who.sessionId}`; headers["x-agend-csrf"] = csrfTokenFor(who.sessionId); }
  if (who.token) headers["x-agend-token"] = who.token;
  const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/reply-button", headers, destroy() {}, socket: { destroy() {}, remoteAddress: "127.0.0.1" } });
  let status = 0, text = "";
  const done = new Promise<void>(resolve => {
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { text = t; resolve(); }, write() { return true; }, destroy() {} });
    handleWebRequest(req as never, res as never, new URL("/ui/reply-button", origin), ctx as never);
    setImmediate(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
  });
  await done;
  return { status, body: JSON.parse(text) };
}

function webCtx(fm: FleetManager) {
  const token = "c".repeat(48);
  const sessions = new WebSessionStore();
  const ctx = Object.create(fm, { webToken: { value: token }, webSessions: { value: sessions } });
  const session = (label: string, surface: "local" | "gateway" = "local", exposureId?: string) =>
    sessions.create({ tier: "admin", surface, label, tokenEpoch: tokenEpoch(token), ...(exposureId ? { exposureId } : {}) });
  return { ctx, token, sessions, session };
}

describe("a web-only fleet: the poll is in the web chat", () => {
  it("shown with its deadline and how many answered — no counts while open (Kahoot)", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const h = webFleet();
    h.ctl();
    const answer = await h.reply({ text: "Capital?", buttons: BUTTONS, poll: { seconds: 30 } });
    expect(answer.error).toBeUndefined();
    const b = h.pollMsg().buttons!;
    expect(b).toMatchObject({ labels: ["Paris", "London", "Rome"], state: "open", poll: { deadline: 1_030_000, answered: 0, multi: false, reveal: "close" } });
    expect(b.poll!.counts).toBeUndefined();
    expect(answer.result.poll_id).toBe(b.id);
  });
  it("each signed-in device is one voter, told its own ballot; the CLI's token is one more; a stranger without a session cannot", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const h = webFleet();
    h.ctl();
    await h.reply({ text: "Capital?", buttons: BUTTONS, poll: { seconds: 30, multi: true } });
    const id = h.pollMsg().buttons!.id;
    const w = webCtx(h.fm);
    const laptop = w.session("Chrome on macOS"), phone = w.session("Safari on iOS");
    expect(await post(w.ctx, { instance: "w", id, index: 0 }, { sessionId: laptop.sessionId })).toEqual({ status: 200, body: { answered: true, options: [0] } });
    expect(await post(w.ctx, { instance: "w", id, index: 2 }, { sessionId: laptop.sessionId })).toEqual({ status: 200, body: { answered: true, options: [0, 2] } });
    expect(await post(w.ctx, { instance: "w", id, index: 1 }, { sessionId: phone.sessionId })).toEqual({ status: 200, body: { answered: true, options: [1] } });
    expect(await post(w.ctx, { instance: "w", id, index: 1 }, { token: w.token })).toEqual({ status: 200, body: { answered: true, options: [1] } });
    const ballots = (h.any.replyButtonsStore as ReplyButtonStore).ballots(id);
    expect(ballots.map(b => [b.voter, b.name, b.options])).toEqual(expect.arrayContaining([
      [`web:${laptop.record.handle}`, `web · Chrome on macOS (${laptop.record.handle.slice(0, 4)})`, [0, 2]],
      [`web:${phone.record.handle}`, `web · Safari on iOS (${phone.record.handle.slice(0, 4)})`, [1]],
      ["web:cli", "web", [1]],
    ]));
    expect(ballots).toHaveLength(3);
    expect(JSON.stringify(ballots)).not.toContain(laptop.sessionId);            // the handle, never the session id
    expect(await h.fm.clickWebReplyButton("w", id, 0)).toEqual({ status: 403, error: "A vote needs a signed-in session" });
  });
  it("the pages are told the count as votes come (at most once a second), then the closed tally; the results go to the agent once", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const h = webFleet();
    h.ctl();
    await h.reply({ text: "Capital?", buttons: BUTTONS, poll: { seconds: 30, show_voters: true } });
    const id = h.pollMsg().buttons!.id;
    const w = webCtx(h.fm);
    const a = w.session("A"), b = w.session("B");
    const views = () => h.sse.filter(e => e.event === "reply_buttons" && e.data.buttons.id === id).map(e => e.data.buttons);
    await post(w.ctx, { instance: "w", id, index: 0 }, { sessionId: a.sessionId });
    await vi.advanceTimersByTimeAsync(100);                                   // A's view goes at once; B votes later
    await post(w.ctx, { instance: "w", id, index: 0 }, { sessionId: b.sessionId });
    await vi.advanceTimersByTimeAsync(899);
    expect(views().map(v => [v.state, v.poll.answered, v.poll.counts])).toEqual([["open", 1, undefined]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(views().map(v => [v.state, v.poll.answered, v.poll.counts])).toEqual([["open", 1, undefined], ["open", 2, undefined]]);
    await vi.advanceTimersByTimeAsync(30_000);
    const closed = views().at(-1);
    expect(closed).toMatchObject({ state: "closed", poll: { answered: 2, counts: [2, 0, 0], voters: [[`web · A (${a.record.handle.slice(0, 4)})`, `web · B (${b.record.handle.slice(0, 4)})`], [], []] } });
    expect(h.pollMsg().buttons).toMatchObject({ state: "closed", poll: { counts: [2, 0, 0] } });
    expect(h.fm.webChatHistory.buttonStates()).toEqual([{ instance: "w", buttons: expect.objectContaining({ id, state: "closed" }) }]);
    expect((await post(w.ctx, { instance: "w", id, index: 1 }, { sessionId: a.sessionId }))).toEqual({ status: 409, body: { error: "This poll is closed.", gone: true } });
    expect((h.any.replyButtonsStore as ReplyButtonStore).get(id)!.resultsAt).not.toBeNull();
  });
});

describe("names stay private unless the poll asked otherwise", () => {
  it("closed without show_voters: the counts, never who — on the stream and in the history; a polling page sees the open poll's count", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const h = webFleet();
    h.ctl();
    await h.reply({ text: "Capital?", buttons: BUTTONS, poll: { seconds: 10 } });
    const id = h.pollMsg().buttons!.id;
    const w = webCtx(h.fm);
    await post(w.ctx, { instance: "w", id, index: 1 }, { sessionId: w.session("A").sessionId });
    await vi.advanceTimersByTimeAsync(0);
    // The public link's poll (/ui/poll) reads buttonStates: an open poll is there too, with its count.
    expect(h.fm.webChatHistory.buttonStates()).toEqual([{ instance: "w", buttons: expect.objectContaining({ id, state: "open", poll: expect.objectContaining({ answered: 1 }) }) }]);
    await vi.advanceTimersByTimeAsync(10_000);
    const views = h.sse.filter(e => e.event === "reply_buttons" && e.data.buttons.id === id).map(e => e.data.buttons);
    expect(views.at(-1)).toMatchObject({ state: "closed", poll: { counts: [0, 1, 0] } });
    expect(views.every(v => v.poll.voters === undefined)).toBe(true);
    expect(h.pollMsg().buttons!.poll!.voters).toBeUndefined();
    expect(JSON.stringify(h.fm.webChatHistory.list("w"))).not.toContain("web · A");
  });
});

describe("the public link votes as its own session, through the real gateway", () => {
  it("a gateway session's click is that session's vote", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const h = webFleet();
    h.ctl();
    await h.reply({ text: "Capital?", buttons: BUTTONS, poll: { seconds: 30 } });
    const id = h.pollMsg().buttons!.id;
    const w = webCtx(h.fm);
    const exposureId = "a".repeat(32), host = "sample.trycloudflare.com", pub = `https://${host}`;
    const s = w.session("phone", "gateway", exposureId);
    let callback!: (req: any, res: any) => void;
    const server: any = Object.assign(new EventEmitter(), { setTimeout() {}, listen: (_p: number, _h: string, cb: () => void) => cb(), address: () => ({ port: 1 }), close() {}, closeAllConnections() {} });
    const g = createPublicWebGateway({ exposureId, isCurrent: () => true, isOpen: () => true, create: ((cb: any) => { callback = cb; return server; }) as never,
      dispatch: (req, res) => { handleWebRequest(req as never, res as never, new URL(req.url ?? "/", pub), w.ctx); } });
    await g.listen(); g.setHost(host);
    const req = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/reply-button", destroy() {}, socket: { destroy() {} },
      headers: { host, cookie: `__Host-agend_session=${s.sessionId}`, origin: pub, "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" } });
    let status = 0, body = "";
    await new Promise<void>(resolve => {
      const res = Object.assign(new EventEmitter(), { headersSent: false, setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { body = t; resolve(); }, write() { return true; }, destroy() {} });
      callback(req, res);
      setImmediate(() => { req.emit("data", Buffer.from(JSON.stringify({ instance: "w", id, index: 2 }))); req.emit("end"); });
    });
    expect([status, JSON.parse(body)]).toEqual([200, { answered: true, options: [2] }]);
    expect((h.any.replyButtonsStore as ReplyButtonStore).ballots(id).map(b => b.voter)).toEqual([`web:${s.record.handle}`]);
    g.close();
  });
});

describe("the server says what time it is (#1830 review)", () => {
  async function get(ctx: unknown, path: string, token: string, keepOpen = false) {
    const host = "127.0.0.1:19280", origin = `http://${host}`;
    const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host, origin, "x-agend-token": token }, destroy() {}, socket: { destroy() {}, remoteAddress: "127.0.0.1" } });
    const writes: string[] = [];
    let status = 0;
    const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; return res; }, write: (x: string) => { writes.push(x); return true; }, end: (x = "") => { writes.push(x); return res; }, destroy() {} });
    handleWebRequest(req as never, res as never, new URL(path, origin), ctx as never);
    if (!keepOpen) await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0));
    return { status, writes, res };
  }
  it("/ui/poll answers with `now`", async () => {
    vi.useFakeTimers({ now: 1_234_567, toFake: ["Date"] });
    const h = webFleet();
    const w = webCtx(h.fm);
    const r = await get(w.ctx, "/ui/poll?after=", w.token);
    expect(JSON.parse(r.writes.join("")).now).toBe(1_234_567);
  });
  it("the stream sends a `clock` right after its status, and again with every heartbeat", async () => {
    vi.useFakeTimers({ now: 5_000_000, toFake: ["Date", "setInterval", "clearInterval"] });
    const h = webFleet();
    const w = webCtx(h.fm);
    Object.defineProperty(w.ctx, "sseHeartbeatMs", { value: 10_000 });
    const r = await get(w.ctx, "/ui/events", w.token, true);
    const frames = () => r.writes.join("").split("\n\n").filter(Boolean).map(f => ({ event: f.match(/^event: (.*)$/m)![1]!, data: JSON.parse(f.match(/^data: (.*)$/m)![1]!) }));
    expect(frames().slice(0, 2).map(f => f.event)).toEqual(["status", "clock"]);
    expect(frames()[1]!.data).toEqual({ now: 5_000_000 });
    vi.advanceTimersByTime(10_000);
    expect(frames().filter(f => f.event === "clock").map(f => f.data.now)).toEqual([5_000_000, 5_010_000]);
    r.res.emit("close");
  });
});

describe("the history keeps the newest view of a poll", () => {
  it("an older view (by rev) never replaces a newer one, and closed is final", () => {
    const hist = new WebChatHistory({ perInstance: 50 });
    hist.record({ instance: "w", sender: "w", role: "agent", text: "Q", ts: new Date().toISOString(),
      buttons: { id: "d".repeat(32), labels: ["A", "B"], state: "open", poll: { deadline: 9, answered: 0, multi: false, reveal: "close", rev: 1 } } } as any);
    const view = (state: string, answered: number, rev: number, extra = {}) => ({ id: "d".repeat(32), labels: ["A", "B"], state, poll: { deadline: 9, answered, multi: false, reveal: "close", rev, ...extra } });
    hist.updateButtons("w", view("open", 3, 30));
    hist.updateButtons("w", view("open", 2, 20));
    expect(hist.list("w")[0]!.buttons!.poll!.answered).toBe(3);
    hist.updateButtons("w", view("closed", 4, 40, { counts: [3, 1] }));
    hist.updateButtons("w", view("open", 5, 50));
    expect(hist.list("w")[0]!.buttons).toMatchObject({ state: "closed", poll: { answered: 4, counts: [3, 1] } });
  });
  it("counts or voters that do not fit the options are dropped, never shown wrong", () => {
    const hist = new WebChatHistory({ perInstance: 50 });
    hist.record({ instance: "w", sender: "w", role: "agent", text: "Q", ts: new Date().toISOString(),
      buttons: { id: "e".repeat(32), labels: ["A", "B"], state: "closed", poll: { deadline: 9, answered: 1, multi: false, reveal: "close", rev: 1, counts: [1], voters: [["x"]] } } } as any);
    expect(hist.list("w")[0]!.buttons!.poll).toEqual({ deadline: 9, answered: 1, multi: false, reveal: "close", rev: 1 });
  });
});

// ── the page ──

describe("the page: ordering, the countdown, and its own vote", () => {
  const view = (state: string, answered: number, rev: number, extra = {}) => ({ id: "f".repeat(32), labels: ["Paris", "London"], state, poll: { deadline: 1_030_000, answered, multi: false, reveal: "close", rev, ...extra } });
  it("applyReplyButtons/mergeMessages keep the newer poll view; the time left reads m:ss or h:mm:ss", () => {
    const list = [{ id: 1, boot: "b", role: "agent", text: "Q", buttons: view("open", 1, 10) }];
    expect(R().applyReplyButtons(list, view("open", 0, 5))).toBe(list);
    expect(R().applyReplyButtons(list, view("open", 2, 20))[0].buttons.poll.answered).toBe(2);
    expect(R().applyReplyButtons([{ ...list[0], buttons: view("closed", 2, 30) }], view("open", 3, 40))[0].buttons.state).toBe("closed");
    const merged = R().mergeMessages([{ ...list[0], buttons: view("open", 2, 20) }], [{ ...list[0], buttons: view("open", 1, 10) }], 10);
    expect(merged[0].buttons.poll.answered).toBe(2);
    expect(R().mergeMessages([{ ...list[0], buttons: view("open", 1, 10) }], [{ ...list[0], buttons: view("open", 2, 20) }], 10)[0].buttons.poll.answered).toBe(2);
    expect([0, 1, 59_001, 61_000, 3_600_000, 3_661_000].map(R().pollRemaining)).toEqual(["0:00", "0:01", "1:00", "1:01", "1:00:00", "1:01:01"]);
  });
  function thread(mine: number[] = []) {
    const dom = installDom({});
    const doc = (globalThis as any).document;
    const scroller = doc.createElement("div"); const list = doc.createElement("div");
    scroller.append(list); doc.body.append(scroller);
    const th = createThread(list, scroller, {
      t: (k: string) => t(k), tf: (k: string, ...a: unknown[]) => t(k, ...a), isUser: () => false, onJump() {}, onEmpty() {},
      setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {}, clickReplyButton() {}, pollMine: () => mine,
    });
    return { dom, list, th };
  }
  const agent = (buttons: unknown) => ({ boot: "x", id: 1, instance: "w", sender: "w", role: "agent", text: "Q", ts: "2026-01-01T00:00:00Z", buttons });
  it("open: the options to click, this device's own vote marked, 'N answered' and a time left that counts down every second", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { dom, list, th } = thread([1]);
    try {
      th.render([agent(view("open", 3, 1))]);
      const buttons = [...list.querySelectorAll(".rb-row.poll .rb-btn")] as any[];
      expect(buttons.map(b => [b.textContent, b.disabled, b.getAttribute("aria-pressed")])).toEqual([["Paris", false, "false"], ["✓ London", false, "true"]]);
      const note = list.querySelector(".rb-row.poll .rb-note");
      expect(note.textContent).toBe("🗳 3 answered · ⏳ 0:30");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(note.textContent).toBe("🗳 3 answered · ⏳ 0:29");
      th.render([agent(view("open", 4, 2))]);                                  // a new count: drawn again, still ticking
      expect(list.querySelector(".rb-note").textContent).toBe("🗳 4 answered · ⏳ 0:29");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(list.querySelector(".rb-note").textContent).toBe("🗳 4 answered · ⏳ 0:28");
      const ticking = vi.getTimerCount();
      th.dispose();
      expect(vi.getTimerCount()).toBeLessThan(ticking);                        // leaving the thread stops the ticker
    } finally { dom.restore(); }
  });
  it("closed: the tally with shares, everything off, the voters when sent, and no countdown left running", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { dom, list, th } = thread([0]);
    try {
      th.render([{ ...agent(undefined), buttons: undefined }]);                // the same thread without a poll: its own timers
      const baseline = vi.getTimerCount();
      th.render([agent(view("open", 1, 1))]);
      expect(vi.getTimerCount()).toBe(baseline + 1);                          // the countdown ticker
      th.render([agent(view("closed", 4, 9, { counts: [3, 1], voters: [["a", "b", "c"], ["d"]] }))]);
      expect([...list.querySelectorAll(".rb-btn")].map((b: any) => [b.textContent, b.disabled])).toEqual([["Paris · 3 (75%)", true], ["London · 1 (25%)", true]]);
      expect(list.querySelector(".rb-note").textContent).toBe("🗳 Closed · 4 answered");
      expect([...list.querySelectorAll(".poll-voters li")].map((li: any) => li.textContent)).toEqual(["Paris: a, b, c", "London: d"]);
      expect(list.querySelector(".poll-left")).toBeNull();
      expect(vi.getTimerCount()).toBe(baseline);
    } finally { th.dispose(); dom.restore(); }
  });
  it("live reveal: the counts on the options while open", () => {
    const { dom, list, th } = thread();
    try {
      th.render([agent(view("open", 3, 1, { reveal: "live", counts: [2, 1] }))]);
      expect([...list.querySelectorAll(".rb-btn")].map((b: any) => b.textContent)).toEqual(["Paris · 2", "London · 1"]);
    } finally { th.dispose(); dom.restore(); }
  });
  it("a click is this session's vote: the answer's ballot is remembered on this device (and survives a reload)", async () => {
    const dom = installDom({});
    try {
      const fetch = vi.fn(async () => ({ json: async () => ({ answered: true, options: [0, 1] }) }));
      const store = createChatStore({ fetch, toast: vi.fn(), announce: vi.fn(), t: (k: string) => k, now: () => 0 } as any);
      await store.clickReplyButton("w", "f".repeat(32), 1);
      expect(fetch).toHaveBeenCalledWith("/ui/reply-button", expect.objectContaining({ method: "POST", body: JSON.stringify({ instance: "w", id: "f".repeat(32), index: 1 }) }));
      expect(store.state.pollMine["f".repeat(32)]).toEqual([0, 1]);
      const again = createChatStore({ fetch, toast: vi.fn(), announce: vi.fn(), t: (k: string) => k, now: () => 0 } as any);
      expect(again.state.pollMine["f".repeat(32)]).toEqual([0, 1]);
    } finally { dom.restore(); }
  });
  it("the countdown runs on the server's clock, from its explicit `clock` — never from a view's rev (#1830 review)", () => {
    const dom = installDom({});
    try {
      vi.useFakeTimers({ now: 1_000_000 });
      const store = createChatStore({ fetch: vi.fn(), toast: vi.fn(), announce: vi.fn(), t: (k: string) => k, now: () => 0 } as any);
      const handlers: Record<string, (d: any) => void> = {};
      store.attach({ on: (e: string, fn: (d: any) => void) => { handlers[e] = fn; } });
      handlers.clock!({ now: 1_007_000 });
      expect(store.state.clockSkew).toBe(7_000);                            // this device is 7 s behind the server
      handlers.clock!({ now: 1_005_000 });
      expect(store.state.clockSkew).toBe(5_000);
      // Views say when they were made, not what time it is: an open one from 60 s ago changes nothing.
      handlers.message!({ boot: "x", id: 1, instance: "w", sender: "w", role: "agent", text: "Q", ts: "2026-01-01T00:00:00Z", buttons: view("open", 0, 940_000) });
      handlers.reply_buttons!({ instance: "w", buttons: view("open", 1, 940_000) });
      expect(store.state.clockSkew).toBe(5_000);
      handlers.clock!({ now: "soon" });
      expect(store.state.clockSkew).toBe(5_000);
    } finally { dom.restore(); }
  });
  it("the stream: a clock is handed over at once, even while live events are held behind a catch-up", async () => {
    // @ts-expect-error — a shipped ESM module with no types (the app's own file)
    const { createStream } = await import("../src/ui/shared/app-stream.js");
    const dom = installDom({});
    try {
      const sources: Array<{ listeners: Map<string, (e: { data: string }) => void> }> = [];
      class FakeSource { listeners = new Map(); constructor() { sources.push(this); } addEventListener(n: string, fn: any) { this.listeners.set(n, fn); } close() {} }
      const env = { EventSource: FakeSource, fetch: () => new Promise(() => {}), setInterval: () => 1, clearInterval() {}, setTimeout: () => 2, clearTimeout() {} };
      const stream = createStream({ mode: "full", env });
      const store = createChatStore({ fetch: vi.fn(), toast: vi.fn(), announce: vi.fn(), t: (k: string) => k, now: () => 0 } as any);
      store.attach(stream);
      stream.start();
      const fire = (name: string, data: unknown) => sources[0]!.listeners.get(name)!({ data: JSON.stringify(data) });
      fire("status", {});
      void stream.catchUp();                                               // its read never answers: live events are held
      const now = Date.now();
      fire("clock", { now: now + 9_000 });
      expect(store.state.clockSkew).toBeGreaterThan(8_900);
      expect(store.state.clockSkew).toBeLessThanOrEqual(9_000);
    } finally { dom.restore(); }
  });
  it("the poll transport: a poll answer carrying a 60 s old open view sets the skew from its `now`, not the view", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    // @ts-expect-error — a shipped ESM module with no types (the app's own file)
    const { createStream } = await import("../src/ui/shared/app-stream.js");
    const dom = installDom({});
    try {
      const answer = { now: 1_002_000, cursor: "c1", reply_buttons: [{ instance: "w", buttons: view("open", 2, 940_000) }] };
      const env = {
        fetch: async () => ({ ok: true, status: 200, json: async () => answer }),
        setInterval: () => 1, clearInterval() {}, setTimeout: () => 2, clearTimeout() {},
      };
      const stream = createStream({ mode: "full", transport: "poll", env });
      const store = createChatStore({ fetch: vi.fn(), toast: vi.fn(), announce: vi.fn(), t: (k: string) => k, now: () => 0 } as any);
      store.attach(stream);
      stream.start();
      // now − the time the page read it (vi.waitFor's own ticks may pass first): about +2 s — never the view's −60 s.
      await vi.waitFor(() => expect(store.state.clockSkew).toBeGreaterThan(1_800));
      expect(store.state.clockSkew).toBeLessThanOrEqual(2_000);
    } finally { dom.restore(); }
  });
  it("the thread counts down from the server's now when it is given one", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const dom = installDom({});
    const doc = (globalThis as any).document;
    const scroller = doc.createElement("div"); const list = doc.createElement("div");
    scroller.append(list); doc.body.append(scroller);
    const th = createThread(list, scroller, {
      t: (k: string) => t(k), tf: (k: string, ...a: unknown[]) => t(k, ...a), isUser: () => false, onJump() {}, onEmpty() {},
      setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {}, clickReplyButton() {}, pollMine: () => [],
      serverNow: () => Date.now() + 7_000,
    });
    try {
      th.render([agent(view("open", 0, 1))]);
      expect(list.querySelector(".poll-left").textContent).toBe("0:23");     // 30 s on the server's clock, 7 s gone there
    } finally { th.dispose(); dom.restore(); }
  });
  it("storage that throws (a private window) loses only the mark", async () => {
    const dom = installDom({});
    const g = globalThis as any;
    const saved = Object.getOwnPropertyDescriptor(g, "localStorage");
    Object.defineProperty(g, "localStorage", { configurable: true, get() { throw new Error("denied"); } });
    try {
      const store = createChatStore({ fetch: vi.fn(async () => ({ json: async () => ({ answered: true, options: [2] }) })), toast: vi.fn(), announce: vi.fn(), t: (k: string) => k, now: () => 0 } as any);
      await store.clickReplyButton("w", "f".repeat(32), 2);
      expect(store.state.pollMine["f".repeat(32)]).toEqual([2]);
    } finally { if (saved) Object.defineProperty(g, "localStorage", saved); dom.restore(); }
  });
});
