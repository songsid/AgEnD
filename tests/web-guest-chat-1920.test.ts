/**
 * #1920 phase 2 (step 2b): a guest chats as on the platform — to an in-scope instance, while guests may chat
 * (web.guests.chat, default true), with authority none, and never a command.
 * - /ui/send: out of scope 404; read-only 403; text that starts with "/" 403; the agent sees "[user:… via web (guest)…]".
 * - /ui/upload: the same scope and switch. /ui/cancel/<n>: the platform button's, in scope and while guests may chat.
 * - /ui/reply-button: only on a reply the guest may see (§5.2), while guests may chat; the agent sees the choice as a
 *   guest's, as a typed message.
 * - /ui/prefs: read only — the host's look and the guest's own, never a preference that names an instance (the app
 *   shell's embedded copy too); POST stays closed. /ui/profile: its own web name.
 * - #2799: the effect posters' route is gone — a guest is refused it as any other unlisted route; an admin finds nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// #2095 CI: pino's worker opens daemon.log in the scratch home late — an afterAll rmSync walking it met ENOTEMPTY (as
// #1778/#1779). This file has no use for the log: the logger is silent, so nothing writes there once the work is done.
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-1920c-home-"));
process.env.AGEND_HOME = home;                         // before the fleet's modules load (pino's daemon.log)

const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { formatHumanInboundMessage } = await import("../src/human-delivery-receipts.js");
const { guestChatRefusal, guestCommandText, guestPrefs } = await import("../src/web-guest-access.js");

const ALICE = { adapterId: "discord", userId: "111111111111111111" };
interface Raw { status: number; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ""; res.on("data", (c: Buffer) => { b += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject); r.end(body);
  });
}
let fm: any, port = 0, dir: string;
const cookieOf = (sid: string) => `${WEB_SESSION_COOKIE}=${sid}`;
const write = (sid: string) => ({ cookie: cookieOf(sid), origin: `http://127.0.0.1:${port}`, [WEB_CSRF_HEADER]: csrfTokenFor(sid), "content-type": "application/json" });
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-1920c-fleet-"));
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
});
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
afterEach(() => { vi.restoreAllMocks(); delete fm.fleetConfig.web; });
const session = (tier: "admin" | "guest", owner?: typeof ALICE) =>
  fm.webSessions.create({ tier, surface: "local", label: tier, tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), owner }).sessionId as string;
const scopedToA = () => vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["a"]));
/** #2855: a test's own guest-save limit (the account's count is per fleet, so one test's saves would count in the next). */
const freshLimits = () => { fm.guestPrefWrites = new (fm.guestPrefWrites.constructor)(undefined, { perWindow: 30, windowMs: 60_000 }); };
const guestsChat = (chat?: boolean) => { fm.fleetConfig.web = { guests: { enabled: true, ...(chat === undefined ? {} : { chat }) } }; };

describe("the rules", () => {
  it("a guest's write: in scope, while guests may chat; not a guest: no rule here", () => {
    const g = (chat: boolean) => ({ owner: ALICE, scope: () => new Set(["a"]), current: () => true, chat: () => chat });
    expect([guestChatRefusal(undefined, "b"), guestChatRefusal(g(true) as never, "a")]).toEqual([null, null]);
    expect(guestChatRefusal(g(true) as never, "b")).toEqual({ status: 404, error: "not found" });
    expect(guestChatRefusal(g(true) as never, 7)).toEqual({ status: 404, error: "not found" });
    expect(guestChatRefusal(g(false) as never, "a")).toEqual({ status: 403, error: "guest_read_only" });
    expect(guestChatRefusal({ ...g(true), chat: undefined } as never, "a"), "no switch read: read-only").toEqual({ status: 403, error: "guest_read_only" });
    expect(["/raw ls", "  /clear", "/model x", "hello", "a /path", "\n/raw x"].map(guestCommandText)).toEqual([true, true, true, false, false, true]);
  });
  it("the agent sees a guest's message as a guest's: recognition only", () => {
    expect(formatHumanInboundMessage("hi", { user: "Alice", source: "web", user_id: ALICE.userId, web_guest: "1" }, "mcp")).toContain(`[user:Alice via web (guest), id:${ALICE.userId}] hi`);
    expect(formatHumanInboundMessage("hi", { user: "Ops", source: "web", user_id: "web-user" }, "mcp")).toContain("[user:Ops via web, id:web-user] hi");
    expect(formatHumanInboundMessage("hi", { user: "Bob", source: "discord", user_id: "2", web_guest: "1" }, "mcp"), "only a web message is marked").toContain("[user:Bob via discord, id:2] hi");
  });
  it("guestPrefs keeps the look and the guest's own, nothing that names an instance", () => {
    const view = guestPrefs({ rev: 3, values: { theme: "dark", lang: "zh-TW", "nav.favorites": ["b"], "nav.order": ["b", "a"], "card.sizeByInstance": { b: "l" }, "widget.sidebar": { spec: {} }, "names.primary": "display", "fx.sidebar": { id: "x" } } });
    expect(view).toEqual({ rev: 3, values: { theme: "dark", lang: "zh-TW", "fx.sidebar": { id: "x" } } });
  });
});

describe("#2848: a chat whose messages are all hidden from the guest says so", () => {
  it("cross-instance lines: unmarked → hidden and allHidden; marked as the topic's → shown; an admin is never told", async () => {
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["c2848"])); guestsChat();
    const guest = session("guest", ALICE), admin = session("admin");
    const history = async (sid: string) => JSON.parse((await raw(port, "GET", "/ui/history?instance=c2848", { cookie: cookieOf(sid) })).body);
    expect(await history(guest), "no messages at all: an ordinary empty chat").toEqual(expect.not.objectContaining({ allHidden: expect.anything() }));
    const line = (text: string, channel?: true) => fm.emitSseEvent("message", { instance: "c2848", sender: "alice", role: "status", text, ts: new Date().toISOString(), ...(channel ? { channel } : {}) });
    line("alice → c2848:\nnot posted to the topic");
    const hidden = await history(guest);
    expect([hidden.messages, hidden.allHidden]).toEqual([[], true]);
    const forAdmin = await history(admin);
    expect([forAdmin.messages.length, "allHidden" in forAdmin]).toEqual([1, false]);
    line("alice → c2848:\nposted to the topic", true);
    const shown = await history(guest);
    expect([shown.messages.map((m: { text: string }) => m.text), "allHidden" in shown]).toEqual([["alice → c2848:\nposted to the topic"], false]);
    expect(shown.messages[0]).not.toHaveProperty("channel");
  });
});

describe("live: a guest scoped to `a`", () => {
  it("/ui/send: delivered to `a` as a guest's; out of scope 404; read-only 403; a command 403", async () => {
    scopedToA(); guestsChat();
    const delivered: any[] = [];
    fm.instanceIpcClients.set("a", { connected: true, send: () => true });
    fm.instanceIpcClients.set("b", { connected: true, send: () => true });
    vi.spyOn(fm, "deliverHumanToInstance").mockImplementation(async (name: unknown, payload: unknown) => { delivered.push([name, payload]); return true; });
    const guest = session("guest", ALICE);
    const ok = await raw(port, "POST", "/ui/send", write(guest), JSON.stringify({ instance: "a", message: "hello from the web" }));
    expect(ok.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0][1].meta).toMatchObject({ source: "web", web_guest: "1", user_id: ALICE.userId });
    expect(await raw(port, "POST", "/ui/send", write(guest), JSON.stringify({ instance: "b", message: "hi" }))).toEqual({ status: 404, body: JSON.stringify({ error: "not found" }) });
    for (const text of ["/raw rm -rf x", "/clear", "  /model opus"]) {
      expect(await raw(port, "POST", "/ui/send", write(guest), JSON.stringify({ instance: "a", message: text })), text).toEqual({ status: 403, body: JSON.stringify({ error: "guest_no_commands" }) });
    }
    guestsChat(false);
    expect(await raw(port, "POST", "/ui/send", write(guest), JSON.stringify({ instance: "a", message: "hi" }))).toEqual({ status: 403, body: JSON.stringify({ error: "guest_read_only" }) });
    expect(delivered, "nothing else reached the agent").toHaveLength(1);
    // An admin is unchanged: not marked a guest, and may still send a command.
    guestsChat();
    expect((await raw(port, "POST", "/ui/send", write(session("admin")), JSON.stringify({ instance: "b", message: "/clear" }))).status).toBe(200);
    expect(delivered.at(-1)[1].meta.web_guest).toBeUndefined();
  });
  it("/ui/upload and /ui/cancel: in scope, while guests may chat", async () => {
    scopedToA(); guestsChat(false);
    const guest = session("guest", ALICE);
    expect(await raw(port, "POST", "/ui/upload?instance=a&name=x.txt", { ...write(guest), "content-type": "application/octet-stream" }, "data")).toEqual({ status: 403, body: JSON.stringify({ error: "guest_read_only" }) });
    expect((await raw(port, "POST", "/ui/upload?instance=b&name=x.txt", { ...write(guest), "content-type": "application/octet-stream" }, "data")).status).toBe(404);
    const cancel = vi.spyOn(fm, "cancelInstance").mockReturnValue(true);
    expect(await raw(port, "POST", "/ui/cancel/a", write(guest))).toEqual({ status: 403, body: JSON.stringify({ error: "guest_read_only" }) });
    guestsChat();
    expect((await raw(port, "POST", "/ui/cancel/a", write(guest))).status).toBe(200);
    expect((await raw(port, "POST", "/ui/cancel/b", write(guest))).status).toBe(404);
    expect(cancel.mock.calls.map((c) => c[0])).toEqual(["a"]);
  });
  it("/ui/reply-button: only a reply the guest may see", async () => {
    scopedToA(); guestsChat();
    const click = vi.spyOn(fm, "clickWebReplyButton").mockResolvedValue({ status: 200 });
    const seen = "c".repeat(32), hidden = "d".repeat(32);
    fm.emitSseEvent("message", { instance: "a", sender: "a", role: "agent", text: "pick", ts: new Date().toISOString(), channel: true, buttons: { id: seen, state: "open", labels: ["Yes", "No"] } });
    fm.emitSseEvent("message", { instance: "a", sender: "a", role: "agent", text: "web only", ts: new Date().toISOString(), buttons: { id: hidden, state: "open", labels: ["Yes"] } });
    const guest = session("guest", ALICE);
    expect((await raw(port, "POST", "/ui/reply-button", write(guest), JSON.stringify({ instance: "a", id: seen, index: 0 }))).status).toBe(200);
    expect(await raw(port, "POST", "/ui/reply-button", write(guest), JSON.stringify({ instance: "a", id: hidden, index: 0 }))).toEqual({ status: 404, body: JSON.stringify({ error: "not found" }) });
    expect(await raw(port, "POST", "/ui/reply-button", write(guest), JSON.stringify({ instance: "b", id: seen, index: 0 }))).toEqual({ status: 404, body: JSON.stringify({ error: "not found" }) });
    expect(click.mock.calls.map((c) => [c[0], c[1]])).toEqual([["a", seen]]);
    expect(click.mock.calls[0]![3]).toMatchObject({ key: `${ALICE.adapterId}:${ALICE.userId}`, userId: ALICE.userId, guest: true });
    // #2090 review: a read-only guest's click is a message too — refused, nothing clicked.
    guestsChat(false);
    expect(await raw(port, "POST", "/ui/reply-button", write(guest), JSON.stringify({ instance: "a", id: seen, index: 0 }))).toEqual({ status: 403, body: JSON.stringify({ error: "guest_read_only" }) });
    expect(click).toHaveBeenCalledTimes(1);
    // An admin's click is not a guest's.
    expect((await raw(port, "POST", "/ui/reply-button", write(session("admin")), JSON.stringify({ instance: "a", id: seen, index: 0 }))).status).toBe(200);
    expect(click.mock.calls[1]![3]).not.toHaveProperty("guest");
  });
  it("#2090 review: a guest's button choice reaches the agent marked a guest's, as its typed messages do", async () => {
    scopedToA(); guestsChat();
    fm.instanceIpcClients.set("a", { connected: true, send: () => true });
    const delivered: any[] = [];
    vi.spyOn(fm, "deliverHumanToInstance").mockImplementation(async (_name: unknown, payload: unknown) => { delivered.push(payload); return true; });
    fm.replyButtons();
    const ids = ["e".repeat(32), "f".repeat(32)];
    for (const id of ids) {
      fm.replyButtonsStore.create({ id, instance: "a", adapterId: "web", chatId: "web", threadId: "", buttons: [{ label: "Deploy", value: "deploy" }] }, Date.now());
      fm.replyButtonsStore.bind(id, `w-${id.slice(0, 4)}`);
      fm.emitSseEvent("message", { instance: "a", sender: "a", role: "agent", text: "deploy?", ts: new Date().toISOString(), channel: true, buttons: { id, state: "open", labels: ["Deploy"] } });
    }
    expect(await raw(port, "POST", "/ui/reply-button", write(session("guest", ALICE)), JSON.stringify({ instance: "a", id: ids[0], index: 0 }))).toEqual({ status: 200, body: JSON.stringify({ answered: true }) });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].meta).toMatchObject({ source: "web", web_guest: "1", user_id: ALICE.userId });
    expect(formatHumanInboundMessage(delivered[0].content, delivered[0].meta, "mcp")).toContain(`via web (guest), id:${ALICE.userId}]`);
    expect((await raw(port, "POST", "/ui/reply-button", write(session("admin")), JSON.stringify({ instance: "a", id: ids[1], index: 0 }))).status).toBe(200);
    expect(delivered[1].meta.web_guest, "an admin's choice is not a guest's").toBeUndefined();
  });
  it("/ui/prefs and the app shell's copy: the host's look and the guest's own only", async () => {
    scopedToA(); guestsChat();
    fm.webPrefs.write("operator", new Map<string, unknown>([["theme", "dark"], ["nav.favorites", ["b"]], ["nav.order", ["b", "a"]], ["card.sizeByInstance", { b: "l" }]]));
    const guest = session("guest", ALICE), admin = session("admin");
    const g = JSON.parse((await raw(port, "GET", "/ui/prefs", { cookie: cookieOf(guest) })).body);
    expect(g.values).toEqual({ theme: "dark" });
    const a = JSON.parse((await raw(port, "GET", "/ui/prefs", { cookie: cookieOf(admin) })).body);
    expect(a.values).toMatchObject({ theme: "dark", "nav.favorites": ["b"] });
    const shell = await raw(port, "GET", "/ui", { cookie: cookieOf(guest), accept: "text/html" });
    const embedded = /data-prefs="([^"]*)"/.exec(shell.body)?.[1] ?? "";
    expect(embedded).toContain("dark");
    expect(embedded).not.toContain("nav.favorites");
  });
  it("#2855: a guest saves its own preferences — its five keys, its own bucket, favourites in scope; the same on its other devices", async () => {
    scopedToA(); guestsChat(); freshLimits();
    const person = `person:${ALICE.adapterId}:${ALICE.userId}`;
    fm.webPrefs.write("operator", new Map<string, unknown>([["theme", "light"], ["nav.favorites", ["b"]], ["nav.sort", { mode: "custom", favs: "fixed" }]]));
    const guest = session("guest", ALICE), other = session("guest", ALICE), admin = session("admin");
    const post = (sid: string, set: unknown, extra: Record<string, unknown> = {}) => raw(port, "POST", "/ui/prefs", write(sid), JSON.stringify({ set, ...extra }));
    const own = { theme: "dark", lang: "zh-TW", "nav.favorites": ["a"], "nav.sort": { mode: "recent", favs: "fixed" }, "nav.filter": { q: "ops", status: [], cli: [] } };
    const ok = await post(guest, own);
    expect(ok.status, ok.body).toBe(200);
    expect(JSON.parse(ok.body).values).toMatchObject(own);
    // Its other device (another session of the same account) reads the same; the host's own values are unchanged.
    expect(JSON.parse((await raw(port, "GET", "/ui/prefs", { cookie: cookieOf(other) })).body).values).toMatchObject(own);
    const shell = await raw(port, "GET", "/ui", { cookie: cookieOf(other), accept: "text/html" });
    expect(/data-prefs="([^"]*)"/.exec(shell.body)?.[1] ?? "").toContain("recent");
    expect(fm.webPrefs.read("operator").values).toMatchObject({ theme: "light", "nav.favorites": ["b"], "nav.sort": { mode: "custom", favs: "fixed" } });
    expect(JSON.parse((await raw(port, "GET", "/ui/prefs", { cookie: cookieOf(admin) })).body).values, "an admin's view is the host's").toMatchObject({ theme: "light" });
    expect(fm.webPrefs.read(person).values).toMatchObject(own);
    // Refused: another key, a favourite out of its scope, too big.
    for (const [set, error] of [[{ "nav.order": ["a"] }, "guest_pref_not_yours: nav.order"], [{ "card.size": "l" }, "guest_pref_not_yours: card.size"],
      [{ "nav.favorites": ["b"] }, "not_in_scope: b"]] as const) {
      const r = await post(guest, set);
      expect([r.status, JSON.parse(r.body).error], JSON.stringify(set)).toEqual([400, error]);
    }
    expect((await post(guest, { "nav.filter": { q: "x".repeat(17 * 1024), status: [], cli: [] } })).status, "over 16 KB").toBe(413);
    // A favourite whose instance leaves the guest's scope is not shown any more (it stays in its bucket).
    vi.spyOn(fm, "guestScope").mockReturnValue(new Set(["b"]));
    expect(JSON.parse((await raw(port, "GET", "/ui/prefs", { cookie: cookieOf(guest) })).body).values["nav.favorites"]).toEqual([]);
  });
  it("#2855: the guest's status frame times its agent by the last reply its channel showed, never a web-only one", async () => {
    const { guestStatus } = await import("../src/web-guest-access.js");
    fm.emitSseEvent("message", { instance: "a", sender: "a", role: "agent", text: "to the channel", ts: "2026-10-29T07:00:00.000Z", channel: true });
    fm.emitSseEvent("message", { instance: "a", sender: "a", role: "agent", text: "to someone's web chat", ts: "2026-10-29T08:00:00.000Z" });
    const full = fm.getUiStatus();
    expect(full.instances.find((i: { name: string }) => i.name === "a")).toMatchObject({ last_reply: "2026-10-29T08:00:00.000Z", last_reply_channel: "2026-10-29T07:00:00.000Z" });
    expect(guestStatus(full, new Set(["a"])).instances[0]).toMatchObject({ last_reply: "2026-10-29T07:00:00.000Z" });
  });
  it("#2855: at most 30 saves a minute per guest account, every device of it counted together", async () => {
    scopedToA(); guestsChat(); freshLimits();
    const a = session("guest", ALICE), b = session("guest", ALICE);
    const post = (sid: string) => raw(port, "POST", "/ui/prefs", write(sid), JSON.stringify({ set: { theme: "dark" } }));
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await post(i % 2 ? a : b)).status);
    const over = await post(a);
    expect([statuses.every((s) => s === 200), over.status, JSON.parse(over.body).error]).toEqual([true, 429, "guest_prefs_rate_limited"]);
  });
  it("/ui/profile: the guest's own web name", async () => {
    scopedToA(); guestsChat();
    const guest = session("guest", ALICE);
    expect((await raw(port, "POST", "/ui/profile", write(guest), JSON.stringify({ name: "Alice W" }))).status).toBe(200);
    expect(JSON.parse((await raw(port, "GET", "/ui/profile", { cookie: cookieOf(guest) })).body)).toMatchObject({ name: "Alice W", bound: true, id: ALICE.userId });
  });
  it("#2799: the effect posters' route is gone — a guest is refused it, an admin finds nothing, whatever an old fleet.yaml says", async () => {
    scopedToA(); guestsChat();
    fm.fleetConfig.web.experimental = { canvas_worker: true };
    const guest = session("guest", ALICE), admin = session("admin");
    for (const q of ["?instance=b", "", "?instance=a"]) {
      const path = `/ui/effect-posters/${"e".repeat(32)}.png${q}`;
      expect((await raw(port, "GET", path, { cookie: cookieOf(guest) })).status, `guest ${q}`).toBe(403);
      expect((await raw(port, "GET", path, { cookie: cookieOf(admin) })).status, `admin ${q}`).toBe(404);
    }
  });
});
