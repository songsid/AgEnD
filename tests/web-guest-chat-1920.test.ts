/**
 * #1920 phase 2 (step 2b): a guest chats as on the platform — to an in-scope instance, while guests may chat
 * (web.guests.chat, default true), with authority none, and never a command.
 * - /ui/send: out of scope 404; read-only 403; text that starts with "/" 403; the agent sees "[user:… via web (guest)…]".
 * - /ui/upload: the same scope and switch. /ui/cancel/<n>: the platform button's, in scope and while guests may chat.
 * - /ui/reply-button: only on a reply the guest may see (§5.2), while guests may chat; the agent sees the choice as a
 *   guest's, as a typed message.
 * - /ui/prefs: read only — the host's look and the guest's own, never a preference that names an instance (the app
 *   shell's embedded copy too); POST stays closed. /ui/profile: its own web name.
 * - A placed effect's poster: by its instance, in scope.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  it("/ui/prefs and the app shell's copy: the host's look and the guest's own only; POST closed", async () => {
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
    expect((await raw(port, "POST", "/ui/prefs", write(guest), JSON.stringify({ set: { "nav.favorites": ["a"] } }))).status).toBe(403);
  });
  it("/ui/profile: the guest's own web name", async () => {
    scopedToA(); guestsChat();
    const guest = session("guest", ALICE);
    expect((await raw(port, "POST", "/ui/profile", write(guest), JSON.stringify({ name: "Alice W" }))).status).toBe(200);
    expect(JSON.parse((await raw(port, "GET", "/ui/profile", { cookie: cookieOf(guest) })).body)).toMatchObject({ name: "Alice W", bound: true, id: ALICE.userId });
  });
  it("a placed effect's poster: by its instance, in scope", async () => {
    scopedToA(); guestsChat();
    const guest = session("guest", ALICE);
    expect((await raw(port, "GET", `/ui/effect-posters/${"e".repeat(32)}.png?instance=b`, { cookie: cookieOf(guest) })).status).toBe(404);
    expect((await raw(port, "GET", `/ui/effect-posters/${"e".repeat(32)}.png`, { cookie: cookieOf(guest) })).status).toBe(404);
    expect((await raw(port, "GET", `/ui/effect-posters/${"e".repeat(32)}.png?instance=a`, { cookie: cookieOf(guest) })).status, "in scope: the handler answers").not.toBe(403);
  });
});
