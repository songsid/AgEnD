/**
 * S-229 (slice K of M-3736): General, Discord and Telegram show slice I's same card. The real FleetManager nonce
 * posting, callbacks and retirement; slice I's real RequestContactCards and E's gate on a real DeliveryOutbox; a
 * synthetic adapter and people. The card is posted from prepareForNativePost (authority none); only the platform
 * callback's person, on the bot that posted it, decides — through cards.decide with the posted CAS snapshot.
 *
 * S229_EVIDENCE=1 also writes the posted payloads to docs/evidence/request-contact-native-s229/{en,zh-TW}.json.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { ContactHeldError } from "../src/contact-auth-service.js";
import type { ContactPerson } from "../src/contact-auth-types.js";
import { DeliveryOutbox, type NewOutboxDelivery } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { getLocale, setLocale } from "../src/locale.js";
import type { RequestContactCardsHost } from "../src/request-contact-card.js";
import { nativeContactPrincipal } from "../src/request-contact-native.js";
import type { RequestContactPrincipal } from "../src/request-contact-types.js";
import type { RequestContextV1, RequestOperationBindingV1 } from "../src/request-context-protocol.js";
import { requestContextDigest } from "../src/request-context-store.js";

const admin: ContactPerson = { platform: "discord", adapterId: "demo", userId: "demo-admin", label: "Demo admin" };
const clean: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); setLocale("en"); for (const fn of clean.splice(0).reverse()) fn(); });

function rig(opts: { eligible?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "s229-native-")); clean.push(() => rmSync(home, { recursive: true, force: true }));
  const box = new DeliveryOutbox(join(home, "outbox.db"), "fixture", { requestContextDispatchVersion: 1 }); clean.push(() => box.close());
  box.activateRequestContextBarrier();
  const generations = new Map([["source", "source-v1"], ["target", "target-v1"], ["general", "general-v1"]]);
  let eligible = opts.eligible ?? true;
  const manages = (target: string, p: ContactPerson) => p.platform === "discord" && p.userId === admin.userId && target === "target";
  const host: RequestContactCardsHost = { current: () => true, canManage: manages, canDecide: (target, p) => eligible && manages(target, p), adminOf: () => false,
    person: actor => actor.kind === "person" && actor.platform !== "hub" ? { platform: actor.platform, userId: actor.userId, adapterId: "demo", label: actor.displayName ?? "Demo person" } : null,
    generation: name => generations.get(name) ?? null, roleRevision: () => "roles-a", managedTargets: () => ["target"], label: name => name === "source" ? "Example lead" : name === "target" ? "Example worker" : name,
    deliveryState: ticket => ticket.deliveryId ? box.get(ticket.deliveryId)?.state : undefined, legacyCurrent: () => true,
    admitLegacy: (request, id) => box.admit({ operationId: request.operationId, sourceKey: `contact:${id}`, sourceInstance: request.source, sourceDaemonBootId: "boot", targetInstance: request.target, kind: "fleet_inbound", payload: request.payload }).delivery.deliveryId,
    changed: vi.fn() };
  const cards = box.requestContactCards(host), gate = box.requestContactGate(host);
  let sent = 0;
  const adapter: any = { id: "demo", type: "discord", getBotUserId: () => "demo-bot",
    notifyAlert: vi.fn(async () => ({ chatId: "channel", messageId: `card-${++sent}`, threadId: "general-thread" })), editMessageRemoveButtons: vi.fn(async () => {}) };
  const other: any = { ...adapter, id: "other-bot", getBotUserId: () => "other-bot" };
  const fm: any = Object.assign(Object.create(FleetManager.prototype), {
    fleetConfig: { defaults: {}, instances: { general: { general_topic: true }, source: { display_name: "Example lead" }, target: { display_name: "Example worker" } } },
    pendingNonceButtons: new Map(), adapters: new Map([["demo", adapter], ["other-bot", other]]), webPromptClicks: new WeakSet(), webPromptClaims: new WeakSet(),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }, renderPlaces: (_id: string, text: string) => ({ text, opts: {} }), shuttingDown: false,
    webPromptGone: vi.fn(), collapseNoncePrompt: vi.fn(async () => {}), retireNonceButtons: vi.fn(async () => {}), lifecyclePin: () => () => true,
    contactService: () => ({ host: { store: box.contactAuthorizations } }), contactRoom: () => undefined, contactGeneration: (n: string) => generations.get(n)!,
    contactAdapter: () => adapter, contactAdminOf: (n: string, p: ContactPerson) => manages(n, p), hubContactRestricted: () => false,
    decideContactAuthorization: vi.fn(() => { throw Error("the legacy writer must not be used"); }),
    settingsGeneralRoute: (n: string) => (n === "general" ? { adapterId: "demo", adapter, chatId: "channel", topic: "general-thread", current: () => true } : null) });
  fm.installRequestContactCards(cards);
  const context = (actor: RequestContextV1["initiatingActor"] = { kind: "person", platform: "discord", userId: "demo-person", displayName: "Demo person" }, ingress: RequestContextV1["ingress"] = "restricted-room"): RequestContextV1 => {
    const id = randomUUID();
    return { ref: { version: 1, contextId: id, rootContextId: id }, rootEvidenceRef: "fixture", ingress, initiatingActor: actor,
      source: { instance: "source", incarnation: "source-v1" }, sourceAudience: { kind: "room", ref: randomUUID() } };
  };
  const hold = (c = context()) => {
    const operationId = randomUUID(), delivery: NewOutboxDelivery = { operationId, sourceKey: operationId, sourceInstance: "source", sourceDaemonBootId: "boot", targetInstance: "target", kind: "fleet_inbound", payload: { content: "Please run the release checklist." }, forwards: [] };
    const binding: RequestOperationBindingV1 = { version: 1, operationId, contextId: c.ref.contextId, rootContextId: c.ref.rootContextId, source: c.source, target: { instance: "target", incarnation: "target-v1" }, verb: "send_to_instance", payloadSha256: requestContextDigest(delivery.payload) };
    try { gate.admit(delivery, c, binding); throw Error("expected hold"); } catch (e) { if (!(e instanceof ContactHeldError)) throw e; return box.contactAuthorizations.get(e.result.authorization_id)!; }
  };
  const legacy = () => box.contactAuthorizations.hold({ operationId: randomUUID(), source: "source", target: "target", sourceGeneration: "source-v1", targetGeneration: "target-v1", verb: "send_to_instance",
    origin: { kind: "human", people: [{ ...admin, userId: "demo-person", label: "Demo person" }], receiptIds: [], chain: [] }, message: "Please run the release checklist.",
    correlationId: randomUUID(), resultRecipient: "source", payload: { content: "Please run the release checklist." }, forwards: [] });
  const webActor = (): RequestContactPrincipal => ({ person: admin, binding: "web-session", verified: true, current: () => true });
  return { box, cards, gate, host, fm, adapter, other, generations, hold, legacy, context, webActor, eligible: (v: boolean) => { eligible = v; } };
}
type Rig = ReturnType<typeof rig>;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const entries = (r: Rig) => [...r.fm.pendingNonceButtons.values()].filter((e: any) => e.prefix === "contact-ticket:");
const posted = (r: Rig, n = -1) => r.adapter.notifyAlert.mock.calls.at(n)![1];
const retired = (r: Rig) => r.fm.retireNonceButtons.mock.calls.map((c: any[]) => c[2]);
const click = (r: Rig, entry: any, action: "approve" | "decline" | "cancel", who: Partial<ContactPerson> = admin, via: any = r.adapter) =>
  r.fm.handleContactTicketCallback({ callbackData: `contact-ticket:${entry.nonce}:${action}`, chatId: entry.chatId, messageId: entry.messageId, threadId: entry.threadId,
    userId: who.userId, username: who.label, ack: vi.fn() }, via.id, via);
const pendingDeliveries = (r: Rig) => r.box.listPending().length;

const evidence: Record<string, Record<string, unknown>> = { en: {}, "zh-TW": {} };
const record = (name: string, r: Rig, extra: Record<string, unknown> = {}) => {
  const alert = posted(r);
  evidence[getLocale()]![name] = { card: { type: alert.type, text: alert.message.replace(/#R[a-f0-9]{8}/g, "#R1a2b3c4d"),
    buttons: alert.choices.map((c: any) => ({ label: c.label, callback: c.id.replace(/[0-9a-f]{32}/, "<ephemeral-test-nonce>") })) }, ...extra };
};
afterAll(() => {
  if (!process.env.S229_EVIDENCE) return;
  const dir = join(import.meta.dirname, "..", "docs", "evidence", "request-contact-native-s229"); mkdirSync(dir, { recursive: true });
  for (const [locale, cases] of Object.entries(evidence)) writeFileSync(join(dir, `${locale}.json`), JSON.stringify({
    provenance: "Actual FleetManager nonce posting/callback/retirement on slice I's RequestContactCards and E's gate over a real DeliveryOutbox; synthetic adapter and people, no platform connection. Ticket short ids and nonces are normalized.",
    cases }, null, 2) + "\n");
});

it.each(["en", "zh-TW"] as const)("%s: a request-scoped hold posts the same card: question, quote, who asked · #id · expiry, the root-request scope; Continue / Decline", async (locale) => {
  setLocale(locale);
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); r.fm.syncHeldTicketCard(ticket); await settle();
  expect(r.adapter.notifyAlert).toHaveBeenCalledTimes(1);
  const alert = posted(r), short = ticket.id.slice(0, 9);
  expect(alert.message.split("\n")).toEqual(locale === "en" ? [
    "Let Example lead contact Example worker?",
    "> Please run the release checklist.",
    expect.stringMatching(new RegExp(`^Asked by Demo person · #${short} · expires in (29|30) min$`)),
    "Continue = this request and its follow-up contacts only.",
  ] : [
    "讓 Example lead 聯絡 Example worker？",
    "> Please run the release checklist.",
    expect.stringMatching(new RegExp(`^Demo person 提出 · #${short} · (29|30) 分鐘後到期$`)),
    "繼續＝只放行這筆請求和它後續的聯絡。",
  ]);
  expect(alert.choices.map((c: any) => c.label)).toEqual(locale === "en" ? ["Continue", "Decline"] : ["繼續", "拒絕"]);
  expect(alert.choices.every((c: any) => Buffer.byteLength(c.id) <= 64)).toBe(true);
  // The entry keeps I's snapshot of exactly what was shown; posting decided nothing and admitted nothing.
  expect(entries(r)[0]).toMatchObject({ contactTicketId: ticket.id, contactSnapshot: r.cards.read(ticket.id, r.webActor()).snapshot });
  expect([pendingDeliveries(r), r.box.contactAuthorizations.get(ticket.id)!.state]).toEqual([0, "pending"]);
  record("held-request", r);
});

it.each(["en", "zh-TW"] as const)("%s: a legacy ticket on the same card says Approve once and its one-message scope", async (locale) => {
  setLocale(locale);
  const r = rig(), ticket = r.legacy();
  r.fm.syncHeldTicketCard(ticket); await settle();
  const lines = posted(r).message.split("\n");
  expect([lines[0], lines.at(-1)]).toEqual(locale === "en" ? ["Let Example lead contact Example worker?", "Approve once = this one request only."]
    : ["讓 Example lead 聯絡 Example worker？", "核准這一次＝只轉交這一筆請求。"]);
  expect(posted(r).choices.map((c: any) => c.label)).toEqual(locale === "en" ? ["Approve once", "Decline"] : ["核准這一次", "拒絕"]);
  record("held-legacy", r);
  await click(r, entries(r)[0], "approve");
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, pendingDeliveries(r), retired(r)]).toEqual(["approved", 1, [locale === "en" ? "Approved once by Demo admin. The message was sent." : "Demo admin 已核准這一次，訊息已送出。"]]);
  expect(r.fm.decideContactAuthorization).not.toHaveBeenCalled();
});

it.each(["en", "zh-TW"] as const)("%s: Continue by an administrator who may decide: cards.decide as that platform person, admitted once; the card says who", async (locale) => {
  setLocale(locale);
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); await settle();
  const decide = vi.spyOn(r.cards, "decide"), shown = entries(r)[0].contactSnapshot;
  expect(await click(r, entries(r)[0], "approve")).toBe(true);
  expect(decide).toHaveBeenCalledTimes(1);
  const [id, input, principal] = decide.mock.calls[0]!;
  expect([id, input]).toEqual([ticket.id, { snapshot: shown, decision: "approve-once" }]);
  expect(principal).toMatchObject({ person: { platform: "discord", adapterId: "demo", userId: "demo-admin", label: "Demo admin" }, verified: true });
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, pendingDeliveries(r), entries(r).length]).toEqual(["approved", 1, 0]);
  expect(retired(r)).toEqual([locale === "en" ? "Continued by Demo admin." : "Demo admin 已讓這筆請求繼續。"]);
  evidence[locale]!["held-request"] = { ...(evidence[locale]!["held-request"] as object), afterContinue: retired(r)[0] };
});

it("Decline declines it as the clicker; nothing is admitted", async () => {
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); await settle();
  await click(r, entries(r)[0], "decline");
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, r.box.contactAuthorizations.get(ticket.id)!.decidedBy?.userId, pendingDeliveries(r), retired(r)])
    .toEqual(["declined", "demo-admin", 0, ["Declined by Demo admin. The agent is told."]]);
});

it("someone who may not decide — another member, a manager who is not an approver, the bot itself — is refused and the card stays", async () => {
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); await settle();
  await click(r, entries(r)[0], "approve", { userId: "demo-member", label: "Demo member" });
  await click(r, entries(r)[0], "approve", { userId: "demo-bot", label: "Bot" });
  // A forged Not now on a held card (it offers Continue / Decline only) closes nothing.
  await click(r, entries(r)[0], "cancel");
  r.eligible(false);
  await click(r, entries(r)[0], "approve");
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, pendingDeliveries(r), entries(r).length, retired(r)]).toEqual(["pending", 0, 1, []]);
});

it("a click arriving through another bot finds no card: the nonce is bound to the bot, chat and message that posted it", async () => {
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); await settle();
  await click(r, entries(r)[0], "approve", admin, r.other);
  // A forwarded copy: the right bot, but another message.
  await click(r, { ...entries(r)[0], messageId: "forwarded-copy" }, "approve");
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, pendingDeliveries(r), entries(r).length]).toEqual(["pending", 0, 1]);
});

it("the web decides first: the native click re-reads and shows that outcome, admitting nothing twice", async () => {
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); await settle();
  const card = entries(r)[0];
  r.cards.decide(ticket.id, { snapshot: r.cards.read(ticket.id, r.webActor()).snapshot, decision: "approve-once" }, r.webActor());   // its sync has not run yet
  await click(r, card, "decline");
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, pendingDeliveries(r), retired(r)]).toEqual(["approved", 1, ["Continued elsewhere (the dashboard or another card)."]]);
});

it("a decision on one card closes the request's other cards (General's proposal and the held card) with the outcome", async () => {
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); await settle();
  await expect(r.fm.requestContactChange("general", { kind: "ticket-decision", ticket_id: ticket.id.slice(0, 9), decision: "approve-once" }, () => true))
    .resolves.toEqual({ status: "awaiting_platform_admin_confirmation" });
  const [held, proposal] = entries(r);
  expect([held.generalName, proposal.generalName]).toEqual([undefined, "general"]);
  await click(r, proposal, "approve");
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, pendingDeliveries(r), entries(r).length]).toEqual(["approved", 1, 0]);
  expect(retired(r)).toEqual(["Continued by Demo admin.", "Continued elsewhere (the dashboard or another card)."]);
  await click(r, held, "approve");   // a late tap on the closed card
  expect(pendingDeliveries(r)).toBe(1);
});

it("a request that changed after posting (policy revision): the card closes, says so, and one fresh card with the new snapshot follows", async () => {
  const r = rig(), ticket = r.hold();
  r.fm.syncHeldTicketCard(ticket); await settle();
  const first = entries(r)[0], before = first.contactSnapshot;
  const policy = r.box.contactAuthorizations.policy("target", "target-v1");
  r.box.contactAuthorizations.writePolicy("target", { revision: policy.revision, approvers: [admin] }, admin, n => r.generations.get(n)!);
  await click(r, first, "approve"); await settle();
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, pendingDeliveries(r), retired(r)]).toEqual(["pending", 0, ["This request changed. A fresh card follows."]]);
  expect(r.adapter.notifyAlert).toHaveBeenCalledTimes(2);
  const fresh = entries(r)[0];
  expect(fresh.contactSnapshot.policyRevision).toBe(before.policyRevision + 1);
  await click(r, fresh, "approve");
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, pendingDeliveries(r)]).toEqual(["approved", 1]);
});

it.each(["en", "zh-TW"] as const)("%s: General's proposal posts the same card with its one suggestion and Not now; General never decides", async (locale) => {
  setLocale(locale);
  const r = rig(), ticket = r.hold();
  await r.fm.requestContactChange("general", { kind: "ticket-decision", ticket_id: ticket.id, decision: "decline" }, () => true);
  const lines = posted(r).message.split("\n");
  expect(lines.slice(0, 2)).toEqual(locale === "en" ? ["General suggests: Decline", "Let Example lead contact Example worker?"] : ["General 建議：拒絕", "讓 Example lead 聯絡 Example worker？"]);
  expect(posted(r).choices.map((c: any) => c.label)).toEqual(locale === "en" ? ["Decline", "Not now"] : ["拒絕", "先不要"]);
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, pendingDeliveries(r)]).toEqual(["pending", 0]);
  record("general-proposal", r);
  await click(r, entries(r)[0], "cancel");
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, retired(r)]).toEqual(["pending", [locale === "en" ? "Not now. The request still waits." : "先不處理，申請仍在等待。"]]);
  (evidence[locale]!["general-proposal"] as any).afterNotNow = retired(r)[0];
  // Its only decision button is the suggested one: an approve forged onto the proposal's nonce is refused.
  await r.fm.requestContactChange("general", { kind: "ticket-decision", ticket_id: ticket.id, decision: "decline" }, () => true);
  const proposal = entries(r).find((e: any) => e.generalName)!;
  await click(r, proposal, "approve");
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, pendingDeliveries(r)]).toEqual(["pending", 0]);
  await click(r, proposal, "decline");
  // The proposal says who declined; the request's held card (posted while it still waited) closes with the outcome.
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, retired(r).slice(1)]).toEqual(["declined", locale === "en"
    ? ["Declined by Demo admin. The agent is told.", "Declined elsewhere (the dashboard or another card)."] : ["Demo admin 已拒絕，已通知該 Agent。", "已在別處拒絕（網頁或另一張卡片）。"]]);
});

it("General's proposal: an Always allow proposal goes to the web; a non-General, a stale revision and a closed request are refused", async () => {
  const r = rig(), ticket = r.hold();
  const propose = (who: string, change: object) => r.fm.requestContactChange(who, { kind: "ticket-decision", ticket_id: ticket.id, ...change }, () => true);
  await expect(propose("general", { decision: "approve-once", grant: { expiresAt: new Date(Date.now() + 86_400_000).toISOString(), remainingUses: null } })).rejects.toThrow("contact-proposal-use-web");
  await expect(propose("source", { decision: "approve-once" })).rejects.toThrow("general-only");
  await expect(propose("general", { decision: "approve-once", revision: ticket.revision + 1 })).rejects.toThrow("conflict");
  expect(r.adapter.notifyAlert).not.toHaveBeenCalled();
  r.cards.decide(ticket.id, { snapshot: r.cards.read(ticket.id, r.webActor()).snapshot, decision: "decline" }, r.webActor());
  await expect(propose("general", { decision: "approve-once" })).rejects.toThrow("contact-proposal-ticket-unavailable");
});

it("a proposal past its five minutes, or whose General changed, decides nothing", async () => {
  const r = rig(), ticket = r.hold();
  let general = true;
  await r.fm.requestContactChange("general", { kind: "ticket-decision", ticket_id: ticket.id, decision: "approve-once" }, () => general);
  general = false;
  await click(r, entries(r)[0], "approve");
  expect([r.box.contactAuthorizations.get(ticket.id)!.state, pendingDeliveries(r), retired(r)]).toEqual(["pending", 0, ["This proposal expired or changed. Ask General to propose again; nothing was applied."]]);
});

it("a Hub requester is named as a Hub person, never as a native account; an unknown one is not named", async () => {
  const r = rig();
  r.fm.syncHeldTicketCard(r.hold(r.context({ kind: "person", platform: "hub", hubId: "demo-hub", id: "demo-hub-person", displayName: "Demo Hub person" }, "hub"))); await settle();
  expect(posted(r).message.split("\n")[2]).toMatch(/^Asked by Demo Hub person \(Hub\) · #R[a-f0-9]{8} · /);
  r.fm.syncHeldTicketCard(r.hold(r.context({ kind: "unknown", reason: "unidentified" }))); await settle();
  expect(posted(r).message.split("\n")[2]).toMatch(/^#R[a-f0-9]{8} · expires in /);
});

it("the native principal is only a real person on the bot that posted: never the bot, another adapter or a gone adapter", () => {
  const adapter = { id: "demo", type: "discord", getBotUserId: () => "demo-bot" };
  const make = (over: Partial<Parameters<typeof nativeContactPrincipal>[0]>) => nativeContactPrincipal({ adapter, adapterId: "demo", userId: "demo-admin", nonce: "n", live: () => true, ...over });
  expect(make({})).toMatchObject({ person: { platform: "discord", adapterId: "demo", userId: "demo-admin" }, verified: true });
  expect([make({ userId: "demo-bot" }), make({ adapterId: "other" }), make({ userId: undefined }), make({ live: () => false }), make({ adapter: { ...adapter, type: "slack" } })]).toEqual([null, null, null, null, null]);
  let live = true; const p = make({ live: () => live })!; live = false;
  expect(p.current()).toBe(false);
});

it("without the port (before L), the held card and proposals are exactly today's M-3680 / M-3544 paths", async () => {
  const r = rig(), ticket = r.legacy();
  r.fm.installRequestContactCards(null);
  r.fm.syncHeldTicketCard(ticket); await settle();
  expect(posted(r).message.split("\n")[0]).toBe("Example lead wants to contact Example worker. The message is held until an administrator decides.");
  expect(entries(r)[0].contactSnapshot).toBeUndefined();
});
