/**
 * M-3709 (the user, 11-25: "verify the whole flow automatically"): the contact-approval journey end to end, as one suite —
 * a send held for approval → who may decide it → where the request shows (this computer, the fixed link, the card in
 * General) → approve (admitted for delivery exactly once), decline or expire (never admitted, the requester told).
 *
 * Real: FleetManager (constructed, never started: no CLI, tmux, adapters connecting or vendor calls), its fleet tool
 * handlers (outboundHandlers → admitDurableDelivery → the contact service), the contact store and delivery outbox
 * (SQLite in a scratch home), the ClassicBot registry (ClassicChannelManager on a scratch classicBot.yaml), the web
 * handler (handleWebRequest with admin sessions), web authority (authorizeWebSession, contactActor), the General card
 * (postNonceButtonPromptOrThrow) and its click (dispatchAdapterCallback), the Hub contact windows.
 * Fake: the two Discord bots (in-memory adapters that record what they post).
 *
 * What this suite does NOT prove (#4448 review), each by its own tests elsewhere:
 *  - Receipt by the target: the delivery pump is off, so "delivered" here means admitted to the durable outbox exactly
 *    once (outbox.listPending), not handed to the agent's session or read by it.
 *  - Live agents: every agent reads as running (getInstanceStatus) and has a fixed daemon boot id (getDaemonBootId).
 *  - How an origin is learned: each source's origin is seeded in the contact store (inheritOrigin), not recorded from
 *    real inbound room messages (classic-contact-dispatch-3339 covers that ingress).
 *  - The DM Confirm itself: a browser is verified by calling authorizeWebSession, as the Confirm's handler does.
 *  - The fixed link's listener and tunnel: its requests are the handler's own, bound with the gateway's request context
 *    (bindGatewayRequest, named link) — the gateway's routing is contact-auth-public-link-m3680's.
 * People (Discord): "boss" is a Fleet admin only on the SECOND bot (b) — the user's real case; "admin-a" on the first bot
 * (a), which hosts General and the agents; "member-one" and "member-two" are room members, admins nowhere.
 *
 * The first scenario is R21079937 (11-25): a ClassicBot room in restricted mode, its origin mixed (two members), asking
 * a fleet agent — the request was pending and in no list, on this computer or anywhere.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { handleWebRequest } from "../src/web-api.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import type { ContactOrigin, ContactPerson } from "../src/contact-auth-types.js";

const TOKEN = "d".repeat(48), LOCAL = "http://127.0.0.1:19280", FIXED = "https://dashboard.example.com", EXPOSURE = "f".repeat(32);
const person = (adapterId: string, userId: string): ContactPerson => ({ platform: "discord", adapterId, userId, label: userId });
const BOSS_B = person("b", "boss"), BOSS_A = person("a", "boss"), ADMIN_A = person("a", "admin-a");
const MEMBER_ONE = person("b", "member-one"), MEMBER_TWO = person("persona-bot", "member-two");
const ROOM = "classic-agend-limit";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); vi.useRealTimers(); vi.restoreAllMocks(); });

function world() {
  const dir = mkdtempSync(join(tmpdir(), "m3709-"));
  const fm = new FleetManager(dir), any = fm as any;
  const channels = [
    { id: "a", type: "discord", mode: "topic", group_id: "-1001", access: { mode: "open", allowed_users: ["admin-a"] } },
    { id: "b", type: "discord", mode: "topic", group_id: "-1002", access: { mode: "open", allowed_users: ["boss"] } },
  ];
  fm.fleetConfig = { defaults: { backend: "codex" }, channels, web: { verified_authority: { enabled: true } },
    instances: {
      general: { working_directory: dir, general_topic: true, channel_id: "a", topic_id: 1, display_name: "General" },
      lead: { working_directory: dir, channel_id: "a", topic_id: 2, display_name: "Example lead" },
      m365: { working_directory: dir, channel_id: "a", topic_id: 3, display_name: "Example helper" },
    } } as any;
  const posted: Array<{ bot: string; chatId: string; message: string; threadId?: string; choices: string[]; messageId: string }> = [];
  const retired: Array<{ bot: string; messageId: string; text: string }> = [];
  const adapters = channels.map((ch) => Object.assign(new EventEmitter(), { id: ch.id, type: "discord", getBotUserId: () => `bot-${ch.id}`,
    notifyAlert: vi.fn(async (chatId: string, alert: any, opts: any) => {
      const messageId = `${ch.id}-card-${posted.length + 1}`;
      posted.push({ bot: ch.id, chatId, message: alert.message, threadId: opts?.threadId, choices: (alert.choices ?? []).map((c: any) => c.label), messageId });
      return { chatId, messageId, threadId: opts?.threadId };
    }),
    editMessageRemoveButtons: vi.fn(async (_chat: string, messageId: string, text: string) => { retired.push({ bot: ch.id, messageId, text }); }),
    editMessage: vi.fn(async () => {}), sendText: vi.fn(async (chatId: string) => ({ chatId, messageId: "text" })) }));
  channels.forEach((ch, i) => {
    const adapter = adapters[i]!;
    fm.adapters.set(ch.id, adapter as any);
    fm.worlds.set(ch.id, { id: ch.id, adapter, groupId: ch.group_id, channelConfig: ch, accessManager: new AccessManager(ch.access as any, join(dir, `${ch.id}.json`)) } as any);
    any.adapterState.set(ch.id, { status: "connected", retryCount: 0 });
  });
  // The ClassicBot room: the real registry (classicBot.yaml in the scratch home), the room on the second bot, restricted.
  any.classicChannels = new ClassicChannelManager(dir, any.logger);
  any.classicChannels.configureAdapters(channels);
  any.classicChannels.register("room-1", "b", ROOM, "agend-limit", "fake-creator", "claude-code", true);
  writeFileSync(join(dir, "web.token"), TOKEN, { mode: 0o600 }); any.initializeWebSessions();
  any.getDaemonBootId = (n: string) => `${n}-boot`;
  any.getInstanceStatus = () => "running";       // never started: every agent reads as running (a stated limit, above)
  any.scheduleDeliveryOutboxPump = () => {};
  any.publishTraffic = () => {};
  any.ensureDeliveryOutbox();
  cleanups.push(() => {
    for (const e of any.pendingNonceButtons?.values?.() ?? []) clearTimeout(e.timer);
    clearInterval(any.replyObligationTimer);
    any.deliveryOutbox?.close(); rmSync(dir, { recursive: true, force: true });
  });
  const outbox = any.deliveryOutbox, store = outbox.contactAuthorizations;
  const settle = async () => { for (let n = 0; n < 20; n++) await new Promise((r) => setImmediate(r)); };

  /** A fleet tool call from `source`, as its MCP server makes it. */
  async function call(source: string, tool: string, args: Record<string, unknown>, operationId = `op-${Math.random().toString(36).slice(2)}`) {
    const respond = vi.fn();
    await outboundHandlers.get(tool)!(fm, args, respond, { instanceName: source, requestId: 1, fleetRequestId: undefined, senderSessionName: undefined,
      operationId, sourceDaemonBootId: `${source}-boot` });
    await settle();
    const [result, error] = respond.mock.calls[0] ?? [];
    return result ?? (error ? { error: String((error as Error)?.message ?? error) } : null);
  }
  /** A verified administrator's browser session — on this computer, or over the fixed (named) link. */
  function browser(owner: ContactPerson, opts: { link?: boolean; verified?: boolean } = {}) {
    const s = any.webSessions.create({ tier: "admin", surface: opts.link ? "gateway" : "local", label: "browser", tokenEpoch: tokenEpoch(TOKEN),
      owner: { adapterId: owner.adapterId, userId: owner.userId }, ...(opts.link ? { exposureId: EXPOSURE } : {}) });
    if (opts.verified !== false) expect(any.authorizeWebSession(s.record, opts.link ? "named_link" : "loopback", !!opts.link)).toMatchObject({ ok: true });
    const request = (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const origin = opts.link ? FIXED : LOCAL;
      const req = Object.assign(new EventEmitter(), { method, url: path, destroy: vi.fn(), socket: { remoteAddress: "127.0.0.1", destroy: vi.fn() },
        headers: { host: new URL(origin).host, origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
          cookie: `${opts.link ? "__Host-" : ""}agend_session=${s.sessionId}`, "x-agend-csrf": csrfTokenFor(s.sessionId) } });
      if (opts.link) bindGatewayRequest(req as never, { surface: "gateway", named: true, exposureId: EXPOSURE, expectedOrigin: FIXED, isCurrent: () => true });
      return new Promise((resolve) => {
        let status = 0;
        const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writableEnded: false, setHeader() {}, write: () => true, destroy: vi.fn(),
          writeHead: (c: number) => { status = c; }, end: (t = "") => resolve({ status, body: t ? JSON.parse(String(t)) : null }) });
        handleWebRequest(req as never, res as never, new URL(path, origin), fm as never);
        if (body !== undefined) { req.emit("data", Buffer.from(JSON.stringify(body))); }
        req.emit("end");
      });
    };
    return { request, record: s.record };
  }
  /** A click on a card's button, as the Discord bot delivers it. */
  async function click(card: { bot: string; messageId: string; chatId: string; threadId?: string }, action: "approve" | "decline", who: ContactPerson) {
    const entry = [...any.pendingNonceButtons.values()].find((e: any) => e.messageId === card.messageId);
    const ack = vi.fn();
    const data = { callbackData: entry ? `contact-ticket:${entry.nonce}:${action}` : `contact-ticket:${"0".repeat(32)}:${action}`, chatId: card.chatId,
      messageId: card.messageId, threadId: card.threadId, userId: who.userId, username: who.label, ack };
    const handled = await any.dispatchAdapterCallback(data, card.bot, fm.adapters.get(card.bot));
    await settle();
    return { handled, ack };
  }
  const deliveriesTo = (target: string) => outbox.listPending().filter((d: any) => d.targetInstance === target);
  const noticesTo = (source: string) => (outbox.db.prepare("SELECT payload_json FROM deliveries WHERE target_instance=? AND source_key LIKE 'contact-outcome:%'").all(source) as any[])
    .map((r) => JSON.parse(r.payload_json).content as string);
  const cards = () => posted.filter((p) => p.choices.length === 2);
  const setOrigin = (instance: string, origin: ContactOrigin) => store.inheritOrigin(instance, origin);
  /** Who may decide the request: true / false per person (a view the person may not even open reads as false). */
  const mayDecide = (id: string, who: ContactPerson) => { try { return fm.contactAuthorization(id, who).canDecide === true; } catch { return false; } };
  return { fm, any, outbox, store, call, browser, click, deliveriesTo, noticesTo, cards, posted, retired, setOrigin, mayDecide, settle };
}

const mixed: ContactOrigin = { kind: "mixed", people: [MEMBER_TWO, MEMBER_ONE], receiptIds: ["r1", "r2"], chain: [ROOM] };

describe("1. scenarios: a send is held (or not), and who may decide it", () => {
  it("R21079937: a restricted ClassicBot room with a mixed origin asks a fleet agent — held; the admin via the second bot may decide, members may not", async () => {
    const w = world();
    w.setOrigin(ROOM, mixed);
    const result = await w.call(ROOM, "request_information", { target_instance: "m365", question: "What is on the release checklist?" });
    expect(result).toMatchObject({ sent: false, held: true, authorization_state: "pending" });
    expect(w.deliveriesTo("m365")).toEqual([]);
    const id = result.authorization_id;
    expect([BOSS_B, BOSS_A, ADMIN_A, MEMBER_ONE, MEMBER_TWO].map((p) => [p.adapterId, p.userId, w.mayDecide(id, p)])).toEqual([
      ["b", "boss", true], ["a", "boss", true], ["a", "admin-a", true], ["b", "member-one", false], ["persona-bot", "member-two", false]]);
  });
  it("a restricted room whose origin is one member (not an admin) — held; that member may not decide it", async () => {
    const w = world();
    w.setOrigin(ROOM, { kind: "human", people: [MEMBER_ONE], receiptIds: ["r1"], chain: [ROOM] });
    const result = await w.call(ROOM, "send_to_instance", { instance_name: "m365", message: "Please summarise the incident." });
    expect(result).toMatchObject({ held: true });
    expect([w.mayDecide(result.authorization_id, MEMBER_ONE), w.mayDecide(result.authorization_id, BOSS_B)]).toEqual([false, true]);
  });
  it("#4435: the same admin seen through both bots is ONE person — a human origin of an admin, not held: admitted for delivery at once", async () => {
    const w = world();
    w.setOrigin(ROOM, { kind: "mixed", people: [BOSS_A, BOSS_B], receiptIds: ["r1", "r2"], chain: [ROOM] });
    const result = await w.call(ROOM, "send_to_instance", { instance_name: "m365", message: "Go ahead." });
    expect(result?.held).toBeUndefined();
    expect(w.deliveriesTo("m365")).toHaveLength(1);
  });
  it("a fleet agent with a retained unknown origin asks another — held; admins of the target's bots decide", async () => {
    const w = world();
    w.setOrigin("lead", { kind: "unknown", people: [], receiptIds: [], chain: ["lead"] });
    const result = await w.call("lead", "delegate_task", { target_instance: "m365", task: "Draft the weekly report." });
    expect(result).toMatchObject({ held: true });
    expect([BOSS_B, ADMIN_A, MEMBER_ONE].map((p) => w.mayDecide(result.authorization_id, p))).toEqual([true, true, false]);
  });
  it("during a Hub answer turn the agent's contacts are refused before any request is made (nothing to decide)", async () => {
    const w = world();
    w.setOrigin("lead", { kind: "unknown", people: [], receiptIds: [], chain: ["lead"] });
    w.any.contactWindows().begin("lead", "hub-turn-1");
    const result = await w.call("lead", "send_to_instance", { instance_name: "m365", message: "From the Hub question." });
    expect(JSON.stringify(result)).toMatch(/hub-contact-restricted|Hub/);
    expect(w.store.pending()).toEqual([]);
    expect(w.deliveriesTo("m365")).toEqual([]);
  });
});

describe("2. where the request shows, and each way to decide it", () => {
  /** Hold R21079937's shape (room → m365) or a fleet agent's (lead → m365). */
  async function held(kind: "room" | "agent") {
    const w = world();
    const source = kind === "room" ? ROOM : "lead";
    w.setOrigin(source, kind === "room" ? mixed : { kind: "unknown", people: [], receiptIds: [], chain: ["lead"] });
    const result = await w.call(source, "request_information", { target_instance: "m365", question: "What is on the release checklist?" });
    expect(result).toMatchObject({ held: true });
    return { w, id: result.authorization_id as string, source };
  }
  describe.each(["room", "agent"] as const)("source: %s", (kind) => {
    it("visible to a verified admin on this computer (Authorizations and Needs you), over the fixed link, and as a card in General", async () => {
      const { w, id } = await held(kind);
      const local = w.browser(BOSS_B), link = w.browser(BOSS_B, { link: true });
      for (const b of [local, link]) {
        const list = await b.request("GET", "/ui/api/contact-authorizations?status=pending");
        expect([list.status, list.body.items.map((t: any) => [t.id, t.canDecide])]).toEqual([200, [[id, true]]]);
        const poll = await b.request("GET", "/ui/poll");
        expect(poll.body.needs.filter((i: any) => i.type === "contact").map((i: any) => i.contactTicket?.id)).toEqual([id]);
      }
      const cards = w.cards();
      expect(cards.map((c) => [c.bot, c.chatId, c.threadId, c.choices])).toEqual([["a", "-1001", "1", ["Approve once", "Decline"]]]);
      expect(cards[0]!.message).toContain(id.slice(0, 9));
    });
    it("approved from the General card by the admin via the second bot: admitted for delivery exactly once; a second decision anywhere changes nothing", async () => {
      const { w, id } = await held(kind);
      const card = w.cards()[0]!;
      expect((await w.click(card, "approve", BOSS_A)).handled).toBe(true);
      expect(w.fm.contactAuthorization(id, BOSS_B).state).toBe("approved");
      expect(w.deliveriesTo("m365").map((d: any) => d.payload.content)).toEqual(["What is on the release checklist?"]);
      expect(w.retired.map((r) => r.text)).toEqual([expect.stringMatching(/^Approved once by boss/)]);
      const again = await w.browser(BOSS_B).request("POST", `/ui/api/contact-authorizations/${id}/decision`, { revision: 1, decision: "approve-once" });
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(w.deliveriesTo("m365")).toHaveLength(1);
    });
    it("a member's click is refused: the card stays and nothing is decided", async () => {
      const { w, id } = await held(kind);
      const card = w.cards()[0]!;
      await w.click(card, "approve", person("a", "member-one"));
      expect(w.fm.contactAuthorization(id, BOSS_B).state).toBe("pending");
      expect([w.retired, w.deliveriesTo("m365")]).toEqual([[], []]);
    });
    it.each([["this computer", false], ["the fixed link", true]] as const)("approved on the dashboard (%s): admitted for delivery once; the General card says it was approved elsewhere", async (_where, link) => {
      const { w, id } = await held(kind);
      const b = w.browser(BOSS_B, { link });
      const ticket = (await b.request("GET", `/ui/api/contact-authorizations/${id}`)).body;
      const decided = await b.request("POST", `/ui/api/contact-authorizations/${id}/decision`, { revision: ticket.revision, decision: "approve-once" });
      expect([decided.status, decided.body.state]).toEqual([200, "approved"]);
      await w.settle();
      expect(w.deliveriesTo("m365")).toHaveLength(1);
      expect(w.retired.map((r) => r.text)).toEqual(["Approved elsewhere (the dashboard or another card)."]);
    });
    it("declined from the card: never admitted for delivery; the requester is told", async () => {
      const { w, id, source } = await held(kind);
      await w.click(w.cards()[0]!, "decline", BOSS_A);
      expect(w.fm.contactAuthorization(id, BOSS_B).state).toBe("declined");
      expect(w.deliveriesTo("m365")).toEqual([]);
      expect(w.noticesTo(source)).toEqual([expect.stringContaining(id)]);
    });
    it("left to expire (30 minutes): never admitted for delivery; the requester is told; it leaves every list", async () => {
      const { w, id, source } = await held(kind);
      // 31 minutes pass (the store keeps the real clock it was built with: the row is aged instead).
      w.outbox.db.prepare("UPDATE contact_auth_tickets SET created_at=created_at-?, ticket_json=json_set(ticket_json,'$.expiresAt',?) WHERE id=?")
        .run(31 * 60_000, new Date(Date.now() - 60_000).toISOString(), id);
      w.any.sweepContactAuthorizationOutcomes();
      expect(w.fm.contactAuthorization(id, BOSS_B).state).toBe("expired");
      expect(w.deliveriesTo("m365")).toEqual([]);
      expect(w.noticesTo(source)).toEqual([expect.stringContaining(id)]);
      const poll = await w.browser(BOSS_B).request("GET", "/ui/poll");
      expect(poll.body.needs.filter((i: any) => i.type === "contact" && i.reason === "contact_request")).toEqual([]);
    });
  });
});
