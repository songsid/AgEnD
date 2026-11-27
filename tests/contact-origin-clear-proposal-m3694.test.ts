// M-3694 (S-262): General proposes clearing an agent's retained origin; an admin confirms on the card, and the clear
// runs the Permissions tab's own path (FleetManager.clearContactOrigin → ContactAuthStore.clearOrigin): the admin's
// identity replaces the origin, recorded in the history. Proposing writes nothing; only a managing admin's Confirm on
// the live card applies it; an agent with no restricting origin is refused with a sentence. Nothing real is started.
import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { FleetManager } from "../src/fleet-manager.js";
import { ContactAuthStore } from "../src/contact-auth-store.js";
import { ContactAuthService } from "../src/contact-auth-service.js";
import { contactProposalRefusal, prepareContactChange, ProposeContactChangeArgs } from "../src/contact-change-proposals.js";
import { contactStateView } from "../src/contact-state-view.js";
import type { ContactPerson } from "../src/contact-auth-types.js";

const admin: ContactPerson = { platform: "discord", adapterId: "demo", userId: "fake-admin", label: "Demo admin" };
const other: ContactPerson = { ...admin, userId: "fake-other" }, person: ContactPerson = { ...admin, userId: "fake-person", label: "Demo person" };
const rigs: Array<{ db: Database.Database; fm: any }> = [];
afterEach(() => { for (const r of rigs.splice(0)) { for (const e of r.fm.pendingNonceButtons.values()) clearTimeout(e.timer); r.db.close(); } vi.restoreAllMocks(); });

function rig() {
  const db = new Database(":memory:"), store = new ContactAuthStore(db);
  const gen = new Map([["general", "g1"], ["worker", "w1"]]);
  const service = new ContactAuthService({ store, restricted: () => true, adminOf: () => false, defaultApprovers: () => [admin], generation: n => gen.get(n)!,
    hubRestricted: () => false, delivered: () => false, admit: vi.fn(() => "delivery-1"), changed: vi.fn() });
  const adapter: any = { id: "demo", type: "discord", getBotUserId: () => "fake-bot", notifyAlert: vi.fn(async () => ({ chatId: "channel", messageId: "prompt", threadId: "thread" })),
    editMessageRemoveButtons: vi.fn(async () => {}) };
  const fm: any = Object.assign(Object.create(FleetManager.prototype), {
    fleetConfig: { defaults: { scheduler: { default_timezone: "Asia/Taipei" } }, instances: { general: { general_topic: true }, worker: { display_name: "Demo worker" } } },
    pendingNonceButtons: new Map(), adapters: new Map([["demo", adapter]]), webPromptClicks: new WeakSet(), webPromptClaims: new WeakSet(),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }, renderPlaces: (_id: string, text: string) => ({ text, opts: {} }),
    webPromptGone: vi.fn(), collapseNoncePrompt: vi.fn(async () => {}), retireNonceButtons: vi.fn(async () => {}), hubContactRestricted: () => false, lifecyclePin: () => () => true,
    contactService: () => service, contactRoom: () => undefined, contactGeneration: (n: string) => gen.get(n)!, contactAdminOf: () => false,
    contactAdapter: () => adapter, webChatOwner: (n: string) => (n === "worker" ? "owner" : null), emitSseEvent: vi.fn(), contactPermissions: vi.fn(() => ({})),
    settingsGeneralRoute: (n: string) => (n === "general" ? { adapterId: "demo", adapter, chatId: "channel", topic: "thread", current: () => true } : null) });
  const clear = vi.spyOn(fm, "clearContactOrigin");
  const held = () => store.inheritOrigin("worker", { kind: "mixed", people: [person], receiptIds: [], chain: ["room", "worker"] });
  const post = async (raw: unknown = { kind: "origin-clear", target: "worker" }) => { await fm.requestContactChange("general", raw, () => true); return [...fm.pendingNonceButtons.values()].at(-1); };
  const click = (entry: any, userId = admin.userId) => fm.handleContactChangeCallback({ callbackData: `contact-change:${entry.nonce}:confirm`, chatId: entry.chatId,
    messageId: entry.messageId, threadId: entry.threadId, userId, username: admin.label, ack: vi.fn() }, "demo", adapter);
  const r = { db, store, service, fm, adapter, gen, clear, held, post, click };
  rigs.push(r);
  return r;
}

it("the schema takes origin-clear {target} only; no actor or confirmation can ride along", () => {
  expect(ProposeContactChangeArgs.safeParse({ change: { kind: "origin-clear", target: "worker" } }).success).toBe(true);
  expect(ProposeContactChangeArgs.safeParse({ change: { kind: "origin-clear" } }).success).toBe(false);
  expect(ProposeContactChangeArgs.safeParse({ change: { kind: "origin-clear", target: "worker", actor: admin } }).success).toBe(false);
});

it("proposing writes nothing; the card says what is retained and what the clear does; only the managing admin's Confirm clears it, through the Permissions tab's own path", async () => {
  const r = rig();
  r.held();
  const before = r.store.originRevision("worker");
  const e = await r.post();
  expect(r.clear).not.toHaveBeenCalled();
  expect(r.store.origin("worker")?.kind).toBe("mixed");
  const card = r.adapter.notifyAlert.mock.calls[0]![1] as { message?: string; text?: string };
  const text = JSON.stringify(card);
  expect(text).toContain("Its retained origin: mixed (Demo person (Discord)).");
  expect(text).toContain("as when you clear it on its Permissions tab");
  await r.click(e, other.userId);                                                                    // not a managing admin
  expect(r.clear).not.toHaveBeenCalled();
  await r.click(e);
  expect(r.clear).toHaveBeenCalledOnce();
  expect(r.clear.mock.calls[0]![0]).toBe("worker");
  expect(r.clear.mock.calls[0]![2]).toMatchObject(admin);
  expect(r.store.origin("worker")).toMatchObject({ kind: "human", people: [admin] });
  expect(r.store.originRevision("worker")).toBe(before + 1);
  expect(r.store.lastOriginClear("worker", "w1")?.actor).toMatchObject(admin);
});

it("a stale card never clears: the origin changed after the proposal (a new restricting relay), or the agent was replaced", async () => {
  for (const cause of ["origin", "generation"] as const) {
    const r = rig();
    r.held();
    const e = await r.post();
    if (cause === "origin") r.store.inheritOrigin("worker", { kind: "unknown", people: [], receiptIds: [], chain: ["other"] });
    else r.gen.set("worker", "w2");
    await r.click(e);
    expect(r.clear, cause).not.toHaveBeenCalled();
  }
});

it("nothing to clear: no origin, or a human one (it holds nothing) — refused with a sentence, no card", async () => {
  const r = rig();
  await expect(r.fm.requestContactChange("general", { kind: "origin-clear", target: "worker" }, () => true)).rejects.toThrow("contact-proposal-no-origin");
  r.store.inheritOrigin("worker", { kind: "human", people: [admin], receiptIds: [], chain: ["worker"] });
  expect(() => prepareContactChange({ kind: "origin-clear", target: "worker" }, { service: r.service, generation: n => r.gen.get(n)!, mode: () => undefined, modeAdmin: () => false,
    write: vi.fn(), decide: vi.fn(), clearOrigin: vi.fn() })).toThrow("contact-proposal-no-origin");
  expect(r.adapter.notifyAlert).not.toHaveBeenCalled();
  expect(contactProposalRefusal(new Error("contact-proposal-no-origin"))).toBe("Not proposed: that agent has no retained origin holding it (contact_state lists the agents that have one).");
});

it("contact_state names each held agent's target and says how to propose the clear", () => {
  const r = rig();
  r.held();
  const view = contactStateView({ store: r.store, names: () => ["general", "worker"], now: () => Date.now(), generation: n => r.gen.get(n)!, label: n => (n === "worker" ? "Demo worker" : n), roomMode: () => undefined });
  expect(view.retained_origins).toEqual([{ agent: "Demo worker (worker)", target: "worker", kind: "mixed", people: [expect.any(String)], chain: ["room", "Demo worker (worker)"] }]);
  expect(view.how_to.some(l => l.includes("kind: 'origin-clear', target"))).toBe(true);
});
