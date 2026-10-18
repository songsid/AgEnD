/**
 * #1939 S2b (design §0, §0.1): "Authorize this browser" — the Confirm card in the account's DM.
 * - The card says what it authorizes; one pending card per session; 3 asks an hour per account; no DM: General gets one
 *   line with no details. A card expires after 5 minutes (marked in place).
 * - Only the account it was sent to may tap it. Confirm is judged at the tap (the session read again, §3 again);
 *   after Confirm the card stays as the notice with Not me. Not me signs the session out, before or after Confirm.
 * - The FleetManager wiring (a real one, no fleet): the card goes by sendDirect, a tap comes back by the adapter callback,
 *   and the session's messages are web-verified after Confirm; GET/POST /ui/authorization.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No tmux"); } }) }));
vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } }) }));
import { AUTHORIZATION_CARD_TTL_MS, SessionAuthorizationRequests, type SessionAuthorizationDeps } from "../src/web-session-authorization.js";
import { FleetManager } from "../src/fleet-manager.js";
import { handleWebRequest } from "../src/web-api.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { setLocale } from "../src/locale.js";

const OWNER = { adapterId: "owner", userId: "admin" };
const H = "a1b2c3d4e5f60718";

function rig(over: Partial<SessionAuthorizationDeps> = {}) {
  let mono = 1_000_000, wall = Date.UTC(2026, 9, 18, 9, 0, 0);
  const sent: Array<{ text: string; choices: string[] }> = [], edits: Array<{ text: string; choices: string[] }> = [], hints: string[] = [], events: Array<[string, any]> = [];
  const signedOut: string[] = [], authorized: string[] = [];
  const deps: SessionAuthorizationDeps = {
    now: () => mono, wallNow: () => wall, maxSessionMs: () => 48 * 3_600_000,
    sendDirect: async (_o, text, choices) => { sent.push({ text, choices: choices.map(c => c.id) }); return { chatId: "dm", messageId: `m${sent.length}` }; },
    sendGeneralHint: async (_o, text) => { hints.push(text); },
    editCard: async (_o, _w, text, choices) => { edits.push({ text, choices: choices.map(c => c.id) }); },
    authorize: (handle) => { authorized.push(handle); return { ok: true, until: wall + 48 * 3_600_000 }; },
    signOut: (handle) => { signedOut.push(handle); },
    event: (type, payload) => { events.push([type, payload]); },
    text: { ask: (c) => `ASK ${c.label} ${c.peer} ${c.askedAt} ${c.until}`, confirmed: (c) => `OK ${c.label} ${c.until}`, denied: (c) => `DENIED ${c.label}`,
      expired: (c) => `EXPIRED ${c.label}`, refused: (c) => `REFUSED ${c.label} ${c.refusal}`, revoked: (c) => `REVOKED ${c.label}`, generalHint: () => "HINT",
      confirmLabel: () => "Confirm", notMeLabel: () => "Not me", notYours: () => "NOT YOURS" },
    log: { warn: vi.fn() }, ...over,
  };
  const r = new SessionAuthorizationRequests(deps);
  const tap = async (choiceIndex: number, userId = "admin", adapterId = "owner", card = sent.length - 1) => {
    const ack = vi.fn();
    const handled = await r.handleCallback({ callbackData: sent[card]!.choices[choiceIndex]!, userId, ack }, adapterId);
    return { handled, ack };
  };
  return { r, deps, sent, edits, hints, events, signedOut, authorized, tap, advance: (ms: number) => { mono += ms; wall += ms; } };
}
const ask = (h: ReturnType<typeof rig>, handle = H) => h.r.ask({ handle, owner: OWNER, label: "Firefox on Mac", peer: "loopback" });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the card: what it says, and the limits against confirm fatigue", () => {
  it("says what it authorizes (the device, where, when asked, until when) with Confirm and Not me", async () => {
    const h = rig();
    expect(await ask(h)).toEqual({ ok: true, expiresInMs: AUTHORIZATION_CARD_TTL_MS });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toBe(`ASK Firefox on Mac loopback ${Date.UTC(2026, 9, 18, 9, 0, 0)} ${Date.UTC(2026, 9, 20, 9, 0, 0)}`);
    expect(h.sent[0]!.choices).toEqual([expect.stringMatching(/^wauth:[0-9a-f]{32}:confirm$/), expect.stringMatching(/^wauth:[0-9a-f]{32}:notme$/)]);
    expect(h.events[0]).toEqual(["session_authorization_issued", expect.objectContaining({ session: H, actor: "owner:admin", peer: "loopback" })]);
    expect(h.r.pending(H)).toEqual({ expiresInMs: AUTHORIZATION_CARD_TTL_MS });
  });
  it("one pending card per session; a second ask says so (until when)", async () => {
    const h = rig();
    await ask(h);
    h.advance(60_000);
    expect(await ask(h)).toEqual({ ok: false, refusal: "pending", retryAfterMs: AUTHORIZATION_CARD_TTL_MS - 60_000 });
    expect(h.sent).toHaveLength(1);
  });
  it("at most 3 asks an hour per account (across its sessions), then refused with when to try again", async () => {
    vi.useFakeTimers();
    const h = rig();
    for (let i = 0; i < 3; i++) { expect((await ask(h, `${i}`.repeat(16).slice(0, 16).replace(/./g, String(i)))).ok).toBe(true); h.advance(10 * 60_000); }
    const r = await ask(h, "f".repeat(16));
    expect(r).toEqual({ ok: false, refusal: "rate_limited", retryAfterMs: 30 * 60_000 });
    h.advance(30 * 60_000);
    expect((await ask(h, "e".repeat(16))).ok, "an hour after the first: one more").toBe(true);
  });
  it("no DM can be sent: refused, and General gets one line with no details", async () => {
    const h = rig({ sendDirect: async () => null });
    expect(await ask(h)).toEqual({ ok: false, refusal: "dm_unavailable" });
    expect(h.hints).toEqual(["HINT"]);
    expect(h.r.pending(H)).toBeNull();
    expect(h.events.at(-1)).toEqual(["session_authorization_failed", expect.objectContaining({ reason: "dm_unavailable" })]);
  });
  it("a card expires after 5 minutes, marked in place; a later tap does nothing", async () => {
    vi.useFakeTimers();
    const h = rig();
    await ask(h);
    h.advance(AUTHORIZATION_CARD_TTL_MS);
    await vi.advanceTimersByTimeAsync(AUTHORIZATION_CARD_TTL_MS);
    expect(h.edits.at(-1)).toEqual({ text: "EXPIRED Firefox on Mac", choices: [] });
    expect(h.events.map(e => e[0])).toContain("session_authorization_expired");
    expect(h.r.pending(H)).toBeNull();
    await h.tap(0);
    expect(h.authorized).toEqual([]);
  });
  it("a Confirm after the deadline, before the card's timer has run, is judged expired at the tap: nothing authorized", async () => {
    vi.useFakeTimers();
    const h = rig();
    await ask(h);
    h.advance(AUTHORIZATION_CARD_TTL_MS);                                                // the clock moved; the timer has not run
    const { ack } = await h.tap(0);
    expect(ack).toHaveBeenCalledWith();
    expect(h.authorized).toEqual([]);
    expect(h.edits.at(-1)).toEqual({ text: "EXPIRED Firefox on Mac", choices: [] });
  });
  it("a card past its deadline is expired when next asked about, even before its timer runs (timers run late)", async () => {
    vi.useFakeTimers();
    const h = rig();
    await ask(h);
    h.advance(AUTHORIZATION_CARD_TTL_MS);                                                // the clock moved; the timer has not run
    expect(h.r.pending(H), "never 'waiting 0:00'").toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.edits.at(-1)).toEqual({ text: "EXPIRED Firefox on Mac", choices: [] });
    expect(h.events.filter(e => e[0] === "session_authorization_expired")).toHaveLength(1);
    expect((await ask(h)).ok, "a new ask is not refused as pending").toBe(true);
    await vi.advanceTimersByTimeAsync(AUTHORIZATION_CARD_TTL_MS - 1);                   // the first card's timer: nothing more
    expect(h.events.filter(e => e[0] === "session_authorization_expired")).toHaveLength(1);
  });
});

describe("a tap on the card", () => {
  it("only the account it was sent to: anyone else is told it isn't theirs, and nothing happens", async () => {
    const h = rig();
    await ask(h);
    const other = await h.tap(0, "admin2");
    expect(other.ack).toHaveBeenCalledWith("NOT YOURS");
    const otherAdapter = await h.tap(0, "admin", "two");
    expect(otherAdapter.ack).toHaveBeenCalledWith("NOT YOURS");
    expect(h.authorized).toEqual([]);
    expect(h.signedOut).toEqual([]);
  });
  it("Confirm: judged at the tap; the card stays as the notice with Not me only", async () => {
    const h = rig();
    await ask(h);
    const t = await h.tap(0);
    expect(t.handled).toBe(true);
    expect(h.authorized).toEqual([H]);
    expect(h.edits.at(-1)).toEqual({ text: `OK Firefox on Mac ${Date.UTC(2026, 9, 20, 9, 0, 0)}`, choices: [expect.stringMatching(/:notme$/)] });
    expect(h.events.map(e => e[0])).toEqual(["session_authorization_issued", "session_authorization_verified"]);
    expect(h.r.pending(H)).toBeNull();
    // A second Confirm on the same card does nothing more.
    await h.tap(0);
    expect(h.authorized).toEqual([H]);
  });
  it("Confirm refused at the tap (§3 failed now): said on the card, no authorization", async () => {
    const h = rig({ authorize: () => ({ ok: false, refusal: "session_gone" }) });
    await ask(h);
    await h.tap(0);
    expect(h.edits.at(-1)).toEqual({ text: "REFUSED Firefox on Mac session_gone", choices: [] });
    expect(h.events.at(-1)).toEqual(["session_authorization_failed", expect.objectContaining({ reason: "session_gone" })]);
  });
  it("Not me before Confirm: denied, the session signed out", async () => {
    const h = rig();
    await ask(h);
    await h.tap(1);
    expect(h.signedOut).toEqual([H]);
    expect(h.edits.at(-1)).toEqual({ text: "DENIED Firefox on Mac", choices: [] });
    expect(h.r.pending(H)).toBeNull();
    await h.tap(0);
    expect(h.authorized, "the card is spent").toEqual([]);
  });
  it("Not me after Confirm: the session signed out, its authorization ended", async () => {
    const h = rig();
    await ask(h);
    await h.tap(0);
    await h.r.handleCallback({ callbackData: h.edits.at(-1)!.choices[0]!, userId: "admin", ack: vi.fn() }, "owner");
    expect(h.signedOut).toEqual([H]);
    expect(h.edits.at(-1)).toEqual({ text: "REVOKED Firefox on Mac", choices: [] });
    expect(h.events.at(-1)).toEqual(["session_authorization_failed", expect.objectContaining({ reason: "not_me_after_confirm" })]);
  });
  it("another prefix, a malformed id or an unknown card: not ours, or acknowledged quietly", async () => {
    const h = rig();
    expect(await h.r.handleCallback({ callbackData: "rb:x:1" }, "owner")).toBe(false);
    const ack = vi.fn();
    expect(await h.r.handleCallback({ callbackData: `wauth:${"0".repeat(32)}:confirm`, userId: "admin", ack }, "owner")).toBe(true);
    expect(ack).toHaveBeenCalledWith();
  });
});

describe("the FleetManager wiring (a real one, no fleet)", () => {
  const TOKEN = "c".repeat(48);
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function fleet() {
    setLocale("en");
    const dir = mkdtempSync(join(tmpdir(), "agend-1939b-")); dirs.push(dir);
    const fm = new FleetManager(dir), s = fm as any;
    const dms: Array<{ user: string; text: string; choices: Array<{ id: string; label: string }> }> = [];
    const adapter = { id: "owner", type: "telegram", sendText: vi.fn(async () => ({ chatId: "G", messageId: "g" })),
      sendDirect: vi.fn(async (user: string, text: string, opts: any) => { dms.push({ user, text, choices: opts.choices }); return { chatId: `dm-${user}`, messageId: `m${dms.length}` }; }),
      editMessage: vi.fn(async () => {}), replaceMessageButtons: vi.fn(async () => {}), editMessageRemoveButtons: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const owner = { id: "owner", type: "telegram", group_id: "G", bot_token_env: "NONE", access: { mode: "open", allowed_users: ["admin"] } };
    fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner], instances: { general: { working_directory: dir, general_topic: true, topic_id: "T0", channel_id: "owner" } } } as never;
    s.adapters.set("owner", adapter);
    writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); s.initializeWebSessions();
    const session = (userId = "admin") => s.webSessions.create({ tier: "admin", surface: "local", label: "Firefox on Mac", tokenEpoch: tokenEpoch(TOKEN), owner: { adapterId: "owner", userId } });
    return { fm, s, adapter, dms, session, close: () => { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); } };
  }
  async function route(h: ReturnType<typeof fleet>, method: string, who: { sessionId: string }) {
    const headers: Record<string, string> = { host: "127.0.0.1:19280", origin: "http://127.0.0.1:19280", cookie: `agend_session=${who.sessionId}`, "x-agend-csrf": csrfTokenFor(who.sessionId), "content-type": "application/json" };
    const req = Object.assign(new EventEmitter(), { method, url: "/ui/authorization", headers, destroy: vi.fn(), socket: { remoteAddress: "127.0.0.1" } });
    let status = 0, text = "";
    const res = { setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { text = t; }, headersSent: false, destroyed: false };
    expect(handleWebRequest(req as never, res as never, new URL("http://127.0.0.1:19280/ui/authorization"), h.fm as never)).toBe(true);
    if (method === "POST") { req.emit("data", Buffer.from("{}")); req.emit("end"); }
    for (let n = 0; n < 40; n++) await Promise.resolve();
    await new Promise(r => setTimeout(r, 5));
    return { status, body: text ? JSON.parse(text) : null };
  }
  it("from defaults: not verified → Authorize → the card in the account's DM → Confirm → verified, and its messages web-verified", async () => {
    const h = fleet(); const { sessionId, record } = h.session();
    expect((await route(h, "GET", { sessionId })).body).toEqual({ state: "none", reason: "not_authorized" });
    const asked = await route(h, "POST", { sessionId });
    expect(asked).toEqual({ status: 200, body: { ok: true, expiresInMs: AUTHORIZATION_CARD_TTL_MS } });
    expect(h.dms).toHaveLength(1);
    expect(h.dms[0]!.user).toBe("admin");
    expect(h.dms[0]!.text).toContain("Firefox on Mac");
    expect(h.dms[0]!.text).toContain("on this computer");
    expect(h.dms[0]!.choices.map(c => c.label)).toEqual(["Confirm", "Not me"]);
    expect((await route(h, "GET", { sessionId })).body).toMatchObject({ state: "pending" });
    await h.s.dispatchAdapterCallback({ callbackData: h.dms[0]!.choices[0]!.id, chatId: "dm-admin", messageId: "m1", userId: "admin", ack: vi.fn() }, "owner", h.adapter);
    const st = (await route(h, "GET", { sessionId })).body;
    expect(st.state).toBe("verified");
    expect(st.until).toBeGreaterThan(Date.now());
    expect(h.s.webAuthority({ session: record, gateway: false, peer: "loopback", instance: "general" }).authority.kind).toBe("web-verified");
    expect(h.adapter.replaceMessageButtons).toHaveBeenCalledWith("dm-admin", "m1", [expect.objectContaining({ label: "Not me" })]);
    h.close();
  });
  it("the confirmed card says when it really ends: the session's own end when that comes before the authorization's", async () => {
    const h = fleet();
    (h.fm.fleetConfig as any).web = { session: { local: { absolute_hours: 2, idle_hours: 2 } } };
    const { sessionId, record } = h.session();
    expect(record.absoluteExpiry - Date.now()).toBeLessThan(2 * 3_600_000 + 1000);
    await route(h, "POST", { sessionId });
    await h.s.dispatchAdapterCallback({ callbackData: h.dms[0]!.choices[0]!.id, chatId: "dm-admin", messageId: "m1", userId: "admin", ack: vi.fn() }, "owner", h.adapter);
    const st = (await route(h, "GET", { sessionId })).body;
    expect(st.until).toBe(record.absoluteExpiry);
    expect(h.adapter.editMessage).toHaveBeenCalledWith("dm-admin", "m1", expect.stringContaining(`until ${new Date(record.absoluteExpiry).toLocaleString()}.`));
    h.close();
  });
  it("Not me signs that browser out: its next request is not signed in", async () => {
    const h = fleet(); const { sessionId } = h.session();
    await route(h, "POST", { sessionId });
    await h.s.dispatchAdapterCallback({ callbackData: h.dms[0]!.choices[1]!.id, chatId: "dm-admin", messageId: "m1", userId: "admin", ack: vi.fn() }, "owner", h.adapter);
    expect(h.s.webSessions.authenticate(sessionId, tokenEpoch(TOKEN), { touch: false })).toBeNull();
    expect(h.adapter.editMessageRemoveButtons).toHaveBeenCalledWith("dm-admin", "m1", expect.stringContaining("signed out"));
    h.close();
  });
  it("a tap after the session ended: refused on the card (§3 again at the tap)", async () => {
    const h = fleet(); const { sessionId, record } = h.session();
    await route(h, "POST", { sessionId });
    h.s.webSessions.revokeByHandle(record.handle);
    await h.s.dispatchAdapterCallback({ callbackData: h.dms[0]!.choices[0]!.id, chatId: "dm-admin", messageId: "m1", userId: "admin", ack: vi.fn() }, "owner", h.adapter);
    expect(h.adapter.editMessageRemoveButtons).toHaveBeenCalledWith("dm-admin", "m1", expect.stringContaining("no longer signed in"));
    expect(h.s.sessionAuthorizationStore().list()).toEqual([]);
    h.close();
  });
  it("the app's poll while a card waits is not the person's activity (#1374): GET is passive, the ask (POST) is not", () => {
    expect([isPassiveWebRead("GET", "/ui/authorization"), isPassiveWebRead("POST", "/ui/authorization")]).toEqual([true, false]);
  });
  it("blocked states, said why: the switch off, an account that isn't an admin", async () => {
    const h = fleet();
    const stranger = h.session("stranger");
    expect((await route(h, "GET", stranger)).body).toEqual({ state: "none", reason: "not_admin" });
    expect((await route(h, "POST", stranger))).toEqual({ status: 200, body: { ok: false, refusal: "not_admin" } });
    h.s.fleetConfig.web = { verified_authority: { enabled: false } };
    const mine = h.session();
    expect((await route(h, "GET", mine)).body).toEqual({ state: "none", reason: "disabled" });
    expect(h.dms).toEqual([]);
    h.close();
  });
});
