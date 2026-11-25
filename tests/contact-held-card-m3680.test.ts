/**
 * M-3680 part 2 (the user, 11-25, hmsg-7eb6016e): a fleet agent's send held for approval had no chat path — General on
 * Discord/Telegram could not post a card for the leader's held tickets. Now the hold posts one card in General (the target
 * agent's world) with Approve once / Decline:
 *  - only one who may decide the request (ContactAuthService.view(...).canDecide, read at the click) can act; anyone else
 *    is refused and the card stays;
 *  - the decision is the clicker's (decideContactAuthorization as that Discord/Telegram person, with the ticket's revision);
 *  - a request decided anywhere else retires its card; one card per request; web-only targets get none.
 *  - R21079937 (11-25): a ClassicBot room's request to a fleet agent gets the card too (in the General of the target's
 *    connection), the room named by its display name; a room's request to anything but a fleet agent gets none.
 * The real FleetManager button posting, callbacks and timers; a synthetic adapter, people and contact store.
 */
import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { FleetManager } from "../src/fleet-manager.js";
import { ContactAuthStore } from "../src/contact-auth-store.js";
import { ContactAuthService } from "../src/contact-auth-service.js";
import type { ContactPerson } from "../src/contact-auth-types.js";

const admin: ContactPerson = { platform: "discord", adapterId: "demo", userId: "fake-admin", label: "Demo admin" };
const other: ContactPerson = { ...admin, userId: "fake-other", label: "Someone else" };
const rigs: any[] = [];
afterEach(() => { for (const r of rigs.splice(0)) { for (const e of r.fm.pendingNonceButtons.values()) clearTimeout(e.timer); r.db.close(); } vi.restoreAllMocks(); });

function rig(opts: { adapterType?: string } = {}) {
  const db = new Database(":memory:"), store = new ContactAuthStore(db);
  const gen = new Map([["general", "g1"], ["lead", "l1"], ["worker", "w1"], ["room", "r1"], ["plain-room", "p1"], ["other-room", "o1"]]);
  const service = new ContactAuthService({ store, restricted: () => true, adminOf: () => false, defaultApprovers: () => [admin], generation: (n) => gen.get(n)!,
    hubRestricted: () => false, delivered: () => false, admit: vi.fn(() => "delivery-1"), changed: vi.fn() });
  const decide = vi.fn((id: string, input: any, actor: ContactPerson) => service.decide(id, input, actor));
  const adapter: any = { id: "demo", type: opts.adapterType ?? "discord", getBotUserId: () => "fake-bot",
    notifyAlert: vi.fn(async () => ({ chatId: "channel", messageId: "card-1", threadId: "general-thread" })), editMessageRemoveButtons: vi.fn(async () => {}) };
  const fm: any = Object.assign(Object.create(FleetManager.prototype), {
    fleetConfig: { defaults: {}, instances: { general: { general_topic: true }, lead: { display_name: "Example lead" }, worker: { display_name: "Example worker" } } },
    pendingNonceButtons: new Map(), adapters: new Map([["demo", adapter]]), webPromptClicks: new WeakSet(), webPromptClaims: new WeakSet(),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }, renderPlaces: (_id: string, text: string) => ({ text, opts: {} }),
    webPromptGone: vi.fn(), collapseNoncePrompt: vi.fn(async () => {}), retireNonceButtons: vi.fn(async () => {}), lifecyclePin: () => () => true,
    contactService: () => service, contactRoom: (n: string) => (n === "room" ? { restrictedMode: true, displayName: "classic: agend-limit", name: "agend-limit" } : n === "plain-room" ? { restrictedMode: true, name: "plain" } : undefined), contactGeneration: (n: string) => gen.get(n)!,
    decideContactAuthorization: decide, contactAdapter: () => adapter,
    settingsGeneralRoute: (n: string) => (n === "general" ? { adapterId: "demo", adapter, chatId: "channel", topic: "general-thread", current: () => true } : null) });
  const hold = (source = "lead", target = "worker") => store.hold({ operationId: `op-${Math.random()}`, source, target, sourceGeneration: gen.get(source)!, targetGeneration: gen.get(target)!,
    verb: "send_to_instance", origin: { kind: "unknown", people: [], chain: [source], receiptIds: [] }, message: "Please run the release checklist.",
    correlationId: "synthetic", resultRecipient: source, payload: {} });
  const r = { db, store, service, decide, adapter, fm, hold };
  rigs.push(r);
  return r;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const cards = (r: ReturnType<typeof rig>) => [...r.fm.pendingNonceButtons.values()].filter((e: any) => e.prefix === "contact-ticket:");
const click = (r: ReturnType<typeof rig>, entry: any, action: "approve" | "decline", who: ContactPerson = admin) => {
  const ack = vi.fn();
  return r.fm.handleContactTicketCallback({ callbackData: `contact-ticket:${entry.nonce}:${action}`, chatId: entry.chatId, messageId: entry.messageId, threadId: entry.threadId,
    userId: who.userId, username: who.label, ack }, "demo", r.adapter).then((handled: boolean) => ({ handled, ack }));
};

it("a fleet agent's held send posts one card in General: who, what, the short id, Approve once / Decline", async () => {
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); r.fm.syncHeldTicketCard(ticket); await settle();
  expect(r.adapter.notifyAlert).toHaveBeenCalledTimes(1);
  const [chat, alert] = r.adapter.notifyAlert.mock.calls[0]!;
  expect(chat).toBe("channel");
  expect(alert.message.split("\n")).toEqual([
    "Example lead wants to contact Example worker. The message is held until an administrator decides.",
    "> Please run the release checklist.",
    expect.stringMatching(new RegExp(`^#${ticket.id.slice(0, 9)} · send_to_instance · expires in (29|30) min$`)),   // a request waits 30 minutes
    "Approve once lets this one message through. Fleet › Authorizations on the dashboard has the same request, with more choices.",
  ]);
  expect(alert.choices.map((c: any) => c.label)).toEqual(["Approve once", "Decline"]);
  expect(alert.choices.every((c: any) => Buffer.byteLength(c.id) <= 64)).toBe(true);
  expect(cards(r)).toHaveLength(1);
});

it("an administrator who may decide it approves it once from the card, as themself, with the request's revision", async () => {
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); await settle();
  const { handled } = await click(r, cards(r)[0], "approve");
  expect(handled).toBe(true);
  expect(r.decide).toHaveBeenCalledWith(ticket.id, { revision: ticket.revision, decision: "approve-once" }, expect.objectContaining({ platform: "discord", adapterId: "demo", userId: "fake-admin" }));
  expect(r.store.get(ticket.id)!.state).toBe("approved");
  expect(r.fm.retireNonceButtons).toHaveBeenCalledWith(expect.anything(), "card-1", "Approved once by Demo admin. The message was sent.");
  expect(cards(r)).toHaveLength(0);
});

it("Decline declines it, as the clicker", async () => {
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); await settle();
  await click(r, cards(r)[0], "decline");
  expect([r.store.get(ticket.id)!.state, r.fm.retireNonceButtons.mock.calls[0]![2]]).toEqual(["declined", "Declined by Demo admin. The agent is told."]);
});

it("someone who may not decide it is refused: nothing is decided and the card stays", async () => {
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); await settle();
  await click(r, cards(r)[0], "approve", other);
  expect([r.decide.mock.calls.length, r.store.get(ticket.id)!.state, cards(r).length]).toEqual([0, "pending", 1]);
  // A click from the bot itself or another adapter's world is no person at all.
  await click(r, cards(r)[0], "approve", { ...admin, userId: "fake-bot" });
  expect([r.decide.mock.calls.length, cards(r).length]).toEqual([0, 1]);
});

it("decided elsewhere (the dashboard): the card is retired and says so; a click after that changes nothing", async () => {
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); await settle();
  const card = cards(r)[0];
  r.service.decide(ticket.id, { revision: ticket.revision, decision: "approve-once" }, admin);
  r.fm.syncHeldTicketCard(r.store.get(ticket.id));
  expect([cards(r).length, r.fm.retireNonceButtons.mock.calls[0]![2]]).toEqual([0, "Approved elsewhere (the dashboard or another card)."]);
  await click(r, card, "decline");
  expect([r.decide.mock.calls.length, r.store.get(ticket.id)!.state]).toEqual([0, "approved"]);
});

it("R21079937: a ClassicBot room's request to a fleet agent posts the card, the room named as Fleet names it; an admin approves it there", async () => {
  const r = rig(), ticket = r.hold("room");
  r.fm.syncHeldTicketCard(ticket); await settle();
  expect(r.adapter.notifyAlert).toHaveBeenCalledTimes(1);
  expect(r.adapter.notifyAlert.mock.calls[0]![1].message.split("\n")[0]).toBe("classic: agend-limit wants to contact Example worker. The message is held until an administrator decides.");
  await click(r, cards(r)[0], "approve");
  expect(r.store.get(ticket.id)!.state).toBe("approved");
  const plain = rig();
  plain.fm.syncHeldTicketCard(plain.hold("plain-room")); await settle();
  expect(plain.adapter.notifyAlert.mock.calls[0]![1].message.split("\n")[0]).toMatch(/^plain wants to contact Example worker\./);   // no display name: its channel's name
});

it("no card for a room's request to anything but a fleet agent, nor when the target's world is not Discord or Telegram", async () => {
  const r = rig();
  r.fm.syncHeldTicketCard(r.hold("room", "other-room")); await settle();
  expect(r.adapter.notifyAlert).not.toHaveBeenCalled();
  const web = rig({ adapterType: "web" });
  web.fm.syncHeldTicketCard(web.hold()); await settle();
  expect(web.adapter.notifyAlert).not.toHaveBeenCalled();
});

it("繁體中文", async () => {
  const { setLocale } = await import("../src/locale.js");
  setLocale("zh-TW");
  try {
    const r = rig(), ticket = r.hold();
    r.fm.syncHeldTicketCard(ticket); await settle();
    const alert = r.adapter.notifyAlert.mock.calls[0]![1];
    expect(alert.message.split("\n")[0]).toBe("Example lead 想聯絡 Example worker。訊息已暫留，等管理員決定。");
    expect(alert.choices.map((c: any) => c.label)).toEqual(["核准這一次", "拒絕"]);
    await click(r, cards(r)[0], "approve");
    expect(r.fm.retireNonceButtons.mock.calls[0]![2]).toBe("Demo admin 已核准這一次，訊息已送出。");
  } finally { setLocale("en"); }
});

it("end to end through FleetManager's own contact service: a held origin's send is held, and the hold itself posts the card", async () => {
  const r = rig();
  // The real contactService() (its `changed` hook), over this rig's store; the leader's case: an agent whose origin was held.
  Object.assign(r.fm, { contactService: FleetManager.prototype["contactService" as keyof FleetManager], ensureDeliveryOutbox: () => {},
    deliveryOutbox: { contactAuthorizations: r.store, isOpen: false, get: () => undefined }, emitSseEvent: vi.fn(), needsYouItems: () => [],
    contactAdminOf: () => false, adminListOf: () => [admin.userId], hubContactRestricted: () => false, getDaemonBootId: () => "boot" });
  r.store.inheritOrigin("lead", { kind: "unknown", people: [], receiptIds: [], chain: ["lead"] });
  const { ContactHeldError } = await import("../src/contact-auth-service.js");
  let held: any;
  try {
    r.fm.contactService().requireApplication({ operationId: "op-e2e", source: "lead", target: "worker", verb: "send_to_instance", message: "Please run the release checklist.",
      correlationId: "synthetic", resultRecipient: "lead", payload: {} });
  } catch (error) { held = error; }
  expect(held).toBeInstanceOf(ContactHeldError);
  await settle();
  expect([r.adapter.notifyAlert.mock.calls.length, cards(r).length, cards(r)[0]?.contactTicketId]).toEqual([1, 1, held.result.authorization_id]);
});

it("a card that cannot be posted never stands in the way of the hold", async () => {
  const r = rig();
  Object.assign(r.fm, { contactService: FleetManager.prototype["contactService" as keyof FleetManager], ensureDeliveryOutbox: () => {},
    deliveryOutbox: { contactAuthorizations: r.store, isOpen: false, get: () => undefined }, emitSseEvent: vi.fn(), needsYouItems: () => [],
    contactAdminOf: () => false, adminListOf: () => [admin.userId], hubContactRestricted: () => false, getDaemonBootId: () => "boot",
    settingsGeneralRoute: () => { throw Error("route lookup failed"); }, syncHeldTicketCard: () => { throw Error("card failed"); } });
  r.store.inheritOrigin("lead", { kind: "unknown", people: [], receiptIds: [], chain: ["lead"] });
  const { ContactHeldError } = await import("../src/contact-auth-service.js");
  let held: unknown;
  try { r.fm.contactService().requireApplication({ operationId: "op-fail", source: "lead", target: "worker", verb: "send_to_instance", message: "x", correlationId: "c", resultRecipient: "lead", payload: {} }); }
  catch (error) { held = error; }
  expect(held).toBeInstanceOf(ContactHeldError);
  expect(r.store.pending()).toHaveLength(1);
});

// Evidence (M3680_CARD_EVIDENCE=<dir>): the card as posted and each outcome, from the actual FleetManager posting and
// callbacks; a synthetic adapter and people, no platform connection. Nonces are left out.
it.runIf(!!process.env.M3680_CARD_EVIDENCE)("writes the card evidence", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { setLocale, t } = await import("../src/locale.js");
  mkdirSync(process.env.M3680_CARD_EVIDENCE!, { recursive: true });
  for (const language of ["en", "zh-TW"] as const) {
    setLocale(language);
    try {
      const outcome = async (fn: (r: ReturnType<typeof rig>, ticket: any) => Promise<unknown>, source = "lead") => {
        const r = rig(), ticket = r.hold(source);
        r.fm.syncHeldTicketCard(ticket); await settle();
        const posted = r.adapter.notifyAlert.mock.calls[0]![1];
        const extra = await fn(r, ticket);
        return { posted: { message: posted.message, buttons: posted.choices.map((c: any) => c.label) }, cardAfter: r.fm.retireNonceButtons.mock.calls[0]?.[2] ?? "(still waiting)", state: r.store.get(ticket.id)!.state, ...(extra ? { extra } : {}) };
      };
      const evidence = {
        provenance: "Actual FleetManager nonce posting/callback; synthetic adapter, people and contact store; no platform connection. Nonces omitted.",
        approve: await outcome((r) => click(r, cards(r)[0], "approve")),
        // R21079937: a ClassicBot room's request to a fleet agent — the same card, the room named by its display name.
        classicRoomApprove: await outcome((r) => click(r, cards(r)[0], "approve"), "room"),
        decline: await outcome((r) => click(r, cards(r)[0], "decline")),
        notAllowed: await outcome(async (r) => { const { ack } = await click(r, cards(r)[0], "approve", other); return { clickerTold: ack.mock.calls.map((c: any) => c[0]) }; }),
        decidedOnTheDashboard: await outcome(async (r, ticket) => { r.service.decide(ticket.id, { revision: ticket.revision, decision: "decline" }, admin); r.fm.syncHeldTicketCard(r.store.get(ticket.id)); }),
        expiredText: t("contactHeld.expired"),
      };
      writeFileSync(`${process.env.M3680_CARD_EVIDENCE}/${language}.json`, JSON.stringify(evidence, (k, v) => (k === "message" && typeof v === "string" ? v.replace(/#R[0-9a-f]{8}/g, "#R12345678") : v), 2) + "\n");
    } finally { setLocale("en"); }
  }
});

// #4438 review (Prism, 6043943197): the card's lifecycle while the platform is still posting it, and what it remembers.
const deferredPost = (r: ReturnType<typeof rig>) => {
  let resolve!: (v: unknown) => void;
  r.adapter.notifyAlert.mockImplementationOnce(() => new Promise((ok) => { resolve = ok; }));
  return () => resolve({ chatId: "channel", messageId: "late-card", threadId: "general-thread" });
};
it("decided on the dashboard while the card was still being posted: the card, once posted, is retired with that outcome", async () => {
  const r = rig(), ticket = r.hold(), post = deferredPost(r);
  r.fm.syncHeldTicketCard(ticket); await settle();
  expect(cards(r)).toHaveLength(1);
  r.service.decide(ticket.id, { revision: ticket.revision, decision: "approve-once" }, admin);
  r.fm.syncHeldTicketCard(r.store.get(ticket.id));
  expect([cards(r).length, r.fm.retireNonceButtons.mock.calls.length]).toEqual([0, 0]);   // nothing to retire yet: no message
  post(); await settle(); await settle();
  expect(r.fm.retireNonceButtons.mock.calls.map((c: any[]) => [c[1], c[2]])).toEqual([["late-card", "Approved elsewhere (the dashboard or another card)."]]);
  expect(cards(r)).toHaveLength(0);
});
it("expired while still being posted: the card, once posted, says it expired; a card posted in time stays armed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const r = rig(), ticket = r.hold(), post = deferredPost(r);
    r.fm.syncHeldTicketCard(ticket); await Promise.resolve(); await Promise.resolve();
    vi.advanceTimersByTime(31 * 60_000);                               // the card's timer (the request's 30 minutes) fires first
    expect(cards(r)).toHaveLength(0);
    post(); for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(r.fm.retireNonceButtons.mock.calls.map((c: any[]) => [c[1], c[2]])).toEqual([["late-card", "This card expired. The request may still wait in Fleet › Authorizations until its own expiry."]]);
    const ok = rig(), waiting = ok.hold();
    ok.fm.syncHeldTicketCard(waiting); for (let i = 0; i < 6; i++) await Promise.resolve();
    expect([cards(ok).length, ok.fm.retireNonceButtons.mock.calls.length]).toEqual([1, 0]);
  } finally { vi.useRealTimers(); }
});
it("remembers a request only while it waits (and at most 512): a decided one is forgotten", async () => {
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); await settle();
  expect(r.fm.heldTicketCards.has(ticket.id)).toBe(true);
  r.service.decide(ticket.id, { revision: ticket.revision, decision: "decline" }, admin);
  r.fm.syncHeldTicketCard(r.store.get(ticket.id));
  expect(r.fm.heldTicketCards.has(ticket.id)).toBe(false);
  const web = rig({ adapterType: "web" });                            // nothing is posted there; ids are still remembered
  for (let i = 0; i < 600; i++) web.fm.syncHeldTicketCard({ id: `R${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`, state: "pending", source: "lead", target: "worker" });
  await settle();
  expect([web.fm.heldTicketCards.size, web.fm.heldTicketCards.has("R00000599-0000-0000-0000-000000000000"), web.fm.heldTicketCards.has("R00000000-0000-0000-0000-000000000000")]).toEqual([512, true, false]);
});
