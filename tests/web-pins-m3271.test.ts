/**
 * M-3271 (the user: 「右鍵可以釘選訊息，這樣比較好找」): pinned web chat messages, the host's side.
 * - the store (web-pins.json): a pin is a copy of the message taken from the host's chat history (text, author, time,
 *   attachment names), newest first, at most 50 per agent (pins_full), kept across a restart; an unreadable file refuses
 *   writes and is never overwritten; what is read back is checked pin by pin; an agent's pins go with it;
 * - the 500-message window: a pinned message that leaves the history keeps its pin (the copy);
 * - the routes: GET /ui/pins?instance and POST /ui/pins/<instance> { pin | unpin } — an admin's only (a read-only
 *   session, a guest: refused), never over the public link; the copy comes from the host, never the page's words; a change
 *   is an SSE `pins` frame.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { handleWebRequest } from "../src/web-api.js";
import { WebChatHistory, type WebChatMessage } from "../src/web-chat-history.js";
import { PINS_MAX, PIN_TEXT_MAX, WebPinStore, parsePinKey } from "../src/web-pin-store.js";
import { guestFrameData } from "../src/web-guest-access.js";

const token = "c".repeat(48), local = "http://127.0.0.1:19280", pub = "https://sample.trycloudflare.com", exposureId = "a".repeat(32);
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "pins-3271-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const at = (n: number) => new Date(Date.UTC(2026, 10, 17, 9, 0, n)).toISOString();
const msg = (id: number, over: Partial<WebChatMessage> = {}): WebChatMessage =>
  ({ boot: "ab12", id, instance: "alpha", role: "agent", sender: "atlas", text: `message ${id}`, ts: at(id % 60), ...over } as WebChatMessage);

describe("the store", () => {
  it("a pin is the message's copy (text, author, time, file names), newest first; pinning twice changes nothing", () => {
    const s = new WebPinStore(tmp(), () => new Date(at(30)));
    const a = s.pin("alpha", msg(1, { attachments: [{ id: "f1", kind: "photo", name: "plan.png", size: 9, mime: "image/png" }, { gone: true, kind: "document", name: "old.pdf", size: 3, mime: "application/pdf" }] }));
    expect(a).toMatchObject({ ok: true, changed: true, rev: 1 });
    const b = s.pin("alpha", msg(2, { role: "user", sender: "Ops", text: "keep this" }));
    expect(s.list("alpha")).toEqual([
      { key: "ab12-2", role: "user", sender: "Ops", text: "keep this", ts: at(2), pinnedAt: at(30) },
      { key: "ab12-1", role: "agent", sender: "atlas", text: "message 1", ts: at(1), files: [{ name: "plan.png", kind: "photo" }, { name: "old.pdf", kind: "document" }], pinnedAt: at(30) },
    ]);
    expect([b.ok && b.rev, s.pin("alpha", msg(2))]).toEqual([2, { ok: true, rev: 2, pins: s.list("alpha"), changed: false }]);
    expect(s.list("beta"), "another agent's: its own (none)").toEqual([]);
  });

  it("a status line is not a message; long words keep their start; a button's click keeps its label", () => {
    const s = new WebPinStore(tmp());
    expect(s.pin("alpha", msg(1, { role: "status" }))).toEqual({ ok: false, status: 400, error: "pin_not_a_message" });
    s.pin("alpha", msg(2, { text: "x".repeat(PIN_TEXT_MAX + 50) }));
    s.pin("alpha", msg(3, { role: "user", text: "", click: { label: "Approve" } }));
    const [click, long] = s.list("alpha");
    expect([long!.text.length, long!.text.endsWith("…"), click!.text]).toEqual([PIN_TEXT_MAX, true, "Approve"]);
  });

  it(`at most ${PINS_MAX} per agent: one more is pins_full (another agent's are its own); unpin makes room`, () => {
    const s = new WebPinStore(tmp());
    for (let i = 1; i <= PINS_MAX; i++) expect(s.pin("alpha", msg(i)).ok).toBe(true);
    expect(s.pin("alpha", msg(999))).toEqual({ ok: false, status: 409, error: "pins_full" });
    expect(s.pin("beta", msg(999, { instance: "beta" })).ok).toBe(true);
    expect(s.unpin("alpha", "ab12-7")).toMatchObject({ ok: true, changed: true });
    expect(s.unpin("alpha", "ab12-7")).toMatchObject({ ok: true, changed: false });
    expect(s.pin("alpha", msg(999)).ok).toBe(true);
    expect(s.list("alpha").length).toBe(PINS_MAX);
  });

  it("kept across a restart (0600); read back pin by pin (one that no longer checks is dropped); unreadable: no pins, writes refused, never overwritten", () => {
    const dir = tmp(), s = new WebPinStore(dir);
    s.pin("alpha", msg(1)); s.pin("alpha", msg(2));
    expect(statSync(join(dir, "web-pins.json")).mode & 0o777).toBe(0o600);
    expect(new WebPinStore(dir).list("alpha").map(p => p.key)).toEqual(["ab12-2", "ab12-1"]);
    const doc = JSON.parse(readFileSync(join(dir, "web-pins.json"), "utf8"));
    doc.instances.alpha.push({ key: "nope", role: "agent", sender: "x", text: "y", ts: at(1), pinnedAt: at(1) }, { ...doc.instances.alpha[0], role: "status", key: "ab12-9" });
    writeFileSync(join(dir, "web-pins.json"), JSON.stringify(doc));
    expect(new WebPinStore(dir).list("alpha").map(p => p.key)).toEqual(["ab12-2", "ab12-1"]);
    writeFileSync(join(dir, "web-pins.json"), "{ not json");
    const bad = new WebPinStore(dir);
    expect([bad.readable(), bad.list("alpha"), bad.pin("alpha", msg(3)), bad.unpin("alpha", "ab12-1")])
      .toEqual([false, [], { ok: false, status: 503, error: "pins_unreadable" }, { ok: false, status: 503, error: "pins_unreadable" }]);
    expect(readFileSync(join(dir, "web-pins.json"), "utf8")).toBe("{ not json");
  });

  it("an agent removed: its pins go (a later agent of the same name starts with none)", () => {
    const dir = tmp(), s = new WebPinStore(dir);
    s.pin("alpha", msg(1)); s.pin("beta", msg(1, { instance: "beta" }));
    expect([s.forget("alpha"), s.forget("alpha"), s.list("alpha"), s.list("beta").length]).toEqual([true, false, [], 1]);
    expect(new WebPinStore(dir).list("alpha")).toEqual([]);
  });

  it("message keys as the page sends them", () => {
    expect([parsePinKey("ab12-3"), parsePinKey("AB12-3"), parsePinKey("ab12-"), parsePinKey(3), parsePinKey("ab12-3-4")])
      .toEqual([{ boot: "ab12", id: 3 }, null, null, null, null]);
  });
});

describe("the 500-message window", () => {
  it("a pinned message that leaves the chat's history keeps its pin: the copy", () => {
    const history = new WebChatHistory(), s = new WebPinStore(tmp());
    const first = history.record({ instance: "alpha", role: "agent", sender: "atlas", text: "the plan: ship on Friday" } as never) as unknown as WebChatMessage;
    const row = history.find("alpha", first.boot, first.id)!;
    expect(s.pin("alpha", row).ok).toBe(true);
    for (let i = 0; i < 500; i++) history.record({ instance: "alpha", role: "agent", sender: "atlas", text: `later ${i}` } as never);
    expect(history.find("alpha", first.boot, first.id), "out of the window").toBeUndefined();
    expect(s.list("alpha").map(p => [p.key, p.text, p.sender])).toEqual([[`${first.boot}-${first.id}`, "the plan: ship on Friday", "atlas"]]);
    expect(new WebPinStore(s.path.replace(/\/web-pins\.json$/, "")).list("alpha").length, "and after a restart").toBe(1);
  });
});

function request(path: string, method = "GET", headers: Record<string, string> = {}, host = "127.0.0.1:19280") {
  const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host, ...headers } as Record<string, string>, destroy: vi.fn(), socket: { destroy: vi.fn() } });
  let status = 0, body = "";
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, headersSent: false, writableEnded: false,
    setHeader() {}, writeHead: (code: number) => { status = code; }, end: (text = "") => { body = String(text); }, write: () => true, destroy: vi.fn(),
  });
  return { req, res, status: () => status, json: () => JSON.parse(body || "null"),
    feed: (value: unknown) => { req.emit("data", Buffer.from(JSON.stringify(value))); req.emit("end"); } };
}
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

function setup(opts: { tier?: "admin" | "read" | "guest"; publicLink?: boolean } = {}) {
  const sessions = new WebSessionStore();
  const owner = { adapterId: "discord", userId: "42" };
  const s = sessions.create({ tier: opts.tier ?? "admin", surface: opts.publicLink ? "gateway" : "local", label: "t", tokenEpoch: tokenEpoch(token),
    ...(opts.publicLink ? { exposureId } : {}), ...(opts.tier === "guest" ? { owner } : {}) } as never);
  const history = new WebChatHistory(), pinStore = new WebPinStore(tmp());
  const row = history.record({ instance: "alpha", role: "agent", sender: "atlas", text: "the host's words" } as never) as unknown as WebChatMessage;
  const emitSseEvent = vi.fn();
  const ctx = { webToken: token, webSessions: sessions, webChatHistory: history, pinStore, isKnownInstance: (n: string) => n === "alpha",
    logger: { info() {}, debug() {}, error() {}, warn() {} }, sseClients: new Set(), getUiStatus: () => ({ instances: [] }), emitSseEvent } as any;
  const cookie = `${opts.publicLink ? "__Host-" : ""}agend_session=${s.sessionId}`;
  const origin = opts.publicLink ? pub : local, host = opts.publicLink ? "sample.trycloudflare.com" : "127.0.0.1:19280";
  const bind = (h: ReturnType<typeof request>) => { if (opts.publicLink) bindGatewayRequest(h.req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true }); };
  const post = async (instance: string, body: unknown) => {
    const h = request(`/ui/pins/${encodeURIComponent(instance)}`, "POST", { cookie, origin, "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" }, host);
    bind(h);
    handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, local), ctx);
    h.feed(body); await flush();
    return { status: h.status(), json: h.json() };
  };
  const get = (instance = "alpha") => {
    const h = request(`/ui/pins?instance=${encodeURIComponent(instance)}`, "GET", { cookie }, host);
    bind(h);
    handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, local), ctx);
    return { status: h.status(), json: h.json() };
  };
  return { ctx, row, key: `${row.boot}-${row.id}`, post, get, emitSseEvent, pinStore, history };
}

describe("the routes", () => {
  it("an admin pins (the host's copy, not the page's words), reads, unpins; each change is a `pins` frame", async () => {
    const t = setup();
    expect(t.get()).toEqual({ status: 200, json: { rev: 0, pins: [], readable: true } });
    const p = await t.post("alpha", { pin: t.key, text: "words the page made up" });
    expect([p.status, p.json.pins.map((x: any) => [x.key, x.text, x.sender])]).toEqual([200, [[t.key, "the host's words", "atlas"]]]);
    expect(t.emitSseEvent.mock.calls).toEqual([["pins", { instance: "alpha", rev: 1 }]]);
    expect(t.get().json.pins.length).toBe(1);
    expect((await t.post("alpha", { pin: t.key })).status, "again: no change, no frame").toBe(200);
    expect(t.emitSseEvent.mock.calls.length).toBe(1);
    const u = await t.post("alpha", { unpin: t.key });
    expect([u.status, u.json.pins, t.emitSseEvent.mock.calls.at(-1)]).toEqual([200, [], ["pins", { instance: "alpha", rev: 2 }]]);
  });

  it("refused: a message not in the history, an unknown agent, both or neither key; pins_full at the cap", async () => {
    const t = setup();
    expect(await t.post("alpha", { pin: "ab12-999999" })).toEqual({ status: 404, json: { error: "pin_message_gone" } });
    expect((await t.post("nobody", { pin: t.key })).status).toBe(404);
    expect((await t.post("alpha", { pin: t.key, unpin: t.key })).status).toBe(400);
    expect((await t.post("alpha", {})).status).toBe(400);
    expect(t.get("nobody").status).toBe(404);
    for (let i = 0; i < PINS_MAX; i++) {
      const r = t.history.record({ instance: "alpha", role: "agent", sender: "atlas", text: `n${i}` } as never) as unknown as WebChatMessage;
      t.pinStore.pin("alpha", r);
    }
    expect(await t.post("alpha", { pin: t.key })).toEqual({ status: 409, json: { error: "pins_full" } });
  });

  it("admins only: a read-only session and a guest get none and change nothing", async () => {
    for (const tier of ["read", "guest"] as const) {
      const t = setup({ tier });
      expect([tier, t.get().status, (await t.post("alpha", { pin: t.key })).status, t.pinStore.list("alpha")]).toEqual([tier, 403, 403, []]);
    }
  });

  it("never over the public link: not on its route list, and refused by the handler for an admin's session there", async () => {
    expect([isPublicWebRoute("GET", "/ui/pins"), isPublicWebRoute("POST", "/ui/pins/alpha")]).toEqual([false, false]);
    const t = setup({ publicLink: true });
    expect(t.get()).toEqual({ status: 403, json: { error: "pins_not_over_public_link" } });
    expect(await t.post("alpha", { pin: t.key })).toEqual({ status: 403, json: { error: "pins_not_over_public_link" } });
    expect(t.pinStore.list("alpha")).toEqual([]);
  });

  it("a guest's stream never carries a `pins` frame", () => {
    expect(guestFrameData("pins", { instance: "alpha", rev: 1 }, new Set(["alpha"]), { owner: { adapterId: "discord", userId: "42" } } as never)).toBeUndefined();
  });
});
