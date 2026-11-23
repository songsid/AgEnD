import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { FleetManager } from "../src/fleet-manager.js";
import { ContactAuthStore, contactPersonKey, type ContactRequest } from "../src/contact-auth-store.js";
import type { ContactPerson } from "../src/contact-auth-types.js";
const admin: ContactPerson = { platform: "host", adapterId: "host", userId: "operator", label: "Owner" };
const alice: ContactPerson = { platform: "discord", adapterId: "demo", userId: "fake-alice", label: "Alice" };
const bob = { ...alice, userId: "fake-bob", label: "Bob" };
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function rig() {
  const db = new Database(":memory:"); dbs.push(db); let now = 1_000, seq = 0;
  const store = new ContactAuthStore(db, () => now);
  const request = (over: Partial<ContactRequest> = {}): ContactRequest => ({ operationId: `op-${++seq}`, source: "room", target: "worker", sourceGeneration: "room-one", targetGeneration: "worker-one",
    verb: "send_to_instance", origin: { kind: "mixed", people: [alice, bob], receiptIds: ["proof"], chain: ["room"] }, message: "Public question", correlationId: "test", resultRecipient: "room", payload: {}, ...over });
  const authority = { canDecide: () => true, current: () => true, admit: vi.fn(() => "delivery") };
  const grant = (people = [alice, bob], uses: number | null = null) => ({ expiresAt: new Date(10_000).toISOString(), remainingUses: uses, personKeys: people.map(contactPersonKey) });
  return { db, store, request, authority, grant, now: (n: number) => { now = n; } };
}
it("explicitly creates one exact row per selected known person, without spreading the endorsed origin", () => {
  const h = rig(), r = h.request(), ticket = h.store.hold(r);
  h.store.decide(ticket.id, { revision: 1, decision: "approve-once", grant: h.grant() }, admin, h.authority);
  const rows = h.store.policy("worker", "worker-one").grants;
  expect(rows.map(x => x.person.userId)).toEqual([alice.userId, bob.userId]);
  expect(rows.every(x => x.sourceGeneration === "room-one" && x.targetGeneration === "worker-one" && x.verbs.join() === "send_to_instance")).toBe(true);
  expect(h.store.origin("worker")).toBeUndefined();
  expect(h.store.get(ticket.id)?.origin).toEqual(r.origin);
  expect(h.store.matchingGrants(h.request())).toHaveLength(2);
});
it("a partial selection cannot launder another retained person, a forged identity or an unknown origin", () => {
  const h = rig(), t = h.store.hold(h.request());
  h.store.decide(t.id, { revision: 1, decision: "approve-once", grant: h.grant([alice]) }, admin, h.authority);
  expect(h.store.matchingGrants(h.request())).toEqual([]);
  for (const [origin, keys] of [[{ kind: "unknown", people: [alice], receiptIds: [], chain: [] }, [alice]],
    [{ kind: "mixed", people: [alice, bob], receiptIds: [], chain: [] }, [admin]]] as const) {
    const tk = h.store.hold(h.request({ origin: origin as any }));
    expect(() => h.store.decide(tk.id, { revision: 1, decision: "approve-once", grant: h.grant([...keys]) }, admin, h.authority)).toThrow("invalid-grant-origin");
    expect(h.store.get(tk.id)?.state).toBe("pending");
  }
});
it("cannot reuse permission across room, target, verb, incarnation or person platform", () => {
  for (const over of [{ source: "other-room" }, { target: "other-worker" }, { verb: "delegate_task" }, { sourceGeneration: "room-two" }, { targetGeneration: "worker-two" },
    { origin: { kind: "human", people: [{ ...alice, platform: "telegram" }], receiptIds: [], chain: [] } }] as Partial<ContactRequest>[]) {
    const h = rig(), tk = h.store.hold(h.request());
    h.store.decide(tk.id, { revision: 1, decision: "approve-once", grant: h.grant() }, admin, h.authority);
    expect(h.store.matchingGrants(h.request(over))).toEqual([]);
  }
});
it("expiry, revocation, quota and removed manager authority stop later admissions; stale editors cannot restore them", () => {
  const h = rig(), tk = h.store.hold(h.request());
  h.store.decide(tk.id, { revision: 1, decision: "approve-once", grant: h.grant(undefined, 1) }, admin, h.authority);
  const next = h.store.hold(h.request());
  expect(h.store.applyStandingGrant(next.id, { ...h.authority, canDecide: () => false })).toBeUndefined();
  expect(h.store.applyStandingGrant(next.id, h.authority)?.state).toBe("approved");
  expect(h.store.applyStandingGrant(next.id, h.authority)?.deliveryId).toBe("delivery");
  expect(h.store.policy("worker", "worker-one").grants.map(x => x.remainingUses)).toEqual([0, 0]);
  expect(h.store.matchingGrants(h.request())).toEqual([]);
  const p = h.store.policy("worker", "worker-one");
  h.store.writePolicy("worker", { revision: p.revision, grants: [] }, admin, n => n === "worker" ? "worker-one" : "room-one");
  expect(() => h.store.writePolicy("worker", { revision: p.revision, grants: p.grants }, admin, () => "worker-one")).toThrow("conflict");
  expect(h.store.matchingGrants(h.request())).toEqual([]);
  h.now(10_000); expect(h.store.matchingGrants(h.request())).toEqual([]);
});

it("expiry and explicit revoke each independently invalidate an otherwise matching unlimited rule", () => {
  for (const cause of ["expiry", "revoke"]) {
    const h = rig(), tk = h.store.hold(h.request());
    h.store.decide(tk.id, { revision: 1, decision: "approve-once", grant: h.grant() }, admin, h.authority);
    expect(h.store.matchingGrants(h.request())).toHaveLength(2);
    if (cause === "expiry") h.now(10_000);
    else { const p = h.store.policy("worker", "worker-one"); h.store.writePolicy("worker", { revision: p.revision, grants: [] }, admin, n => n === "worker" ? "worker-one" : "room-one"); }
    expect(h.store.matchingGrants(h.request())).toEqual([]);
  }
});
it("unknown/forged/duplicate selections never admit or persist, and failed admission rolls back all new rows", () => {
  const h = rig();
  for (const keys of [[], ["forged"], [contactPersonKey(alice), contactPersonKey(alice)]]) {
    const tk = h.store.hold(h.request()); h.authority.admit.mockClear();
    expect(() => h.store.decide(tk.id, { revision: 1, decision: "approve-once", grant: { ...h.grant(), personKeys: keys } }, admin, h.authority)).toThrow("invalid-grant-origin");
    expect(h.authority.admit).not.toHaveBeenCalled();
    expect(h.store.policy("worker", "worker-one").grants).toEqual([]);
  }
  const tk = h.store.hold(h.request());
  expect(() => h.store.decide(tk.id, { revision: 1, decision: "approve-once", grant: h.grant() }, admin, { ...h.authority, admit: () => { throw Error("disk-failed"); } })).toThrow("disk-failed");
  expect(h.store.get(tk.id)?.state).toBe("pending"); expect(h.store.policy("worker", "worker-one").grants).toEqual([]);
});

it("notifies the target Permissions view after grant creation; Hub restriction still precedes tickets and automatic grants", async () => {
  const { ContactAuthService } = await import("../src/contact-auth-service.js");
  const h = rig(), changed = vi.fn(); let hub = false;
  const service = new ContactAuthService({ store: h.store, restricted: () => true, adminOf: () => false, defaultApprovers: () => [admin], generation: name => name === "worker" ? "worker-one" : "room-one", hubRestricted: () => hub, delivered: () => false, admit: h.authority.admit, changed });
  const tk = h.store.hold(h.request());
  service.decide(tk.id, { revision: 1, decision: "approve-once", grant: h.grant() }, admin);
  expect(changed.mock.calls).toEqual([["room", tk.id], ["worker"]]);
  h.store.inheritOrigin("room", h.request().origin); hub = true; h.authority.admit.mockClear();
  expect(() => service.requireApplication(h.request())).toThrow("hub-contact-restricted");
  expect(h.authority.admit).not.toHaveBeenCalled();
  expect(h.store.list().items).toHaveLength(1);
});

it("the real Permissions writer can retain an unchanged expired row while extending another, but cannot alter the expired row", async () => {
  const h = rig(); const rows = [alice, bob].map((person, i) => ({ id: "", person, source: "room", target: "worker", verbs: ["send_to_instance" as const], expiresAt: new Date(i ? Date.now() + 86400000 : 1000).toISOString(), remainingUses: null }));
  h.store.writePolicy("worker", { revision: 0, grants: rows }, admin, n => n === "worker" ? "worker-one" : "room-one");
  const view = () => ({ ...h.store.policy("worker", "worker-one"), canManage: true, canSetMode: false, eligibleApprovers: [] });
  const fm = Object.assign(Object.create(FleetManager.prototype), { contactPermissions: view, contactService: () => ({ host: { store: h.store } }), webChatOwner: () => true,
    contactGeneration: (n: string) => n === "worker" ? "worker-one" : "room-one", lifecycle: { daemons: new Map() }, emitSseEvent: vi.fn(), needsYou: null, needsYouItems: () => [] });
  const p = view(), image = (r: any) => { const { id, person, source, target, verbs, expiresAt, remainingUses } = r; return { id, person, source, target, verbs, expiresAt, remainingUses }; };
  const grants = p.grants.map(image); grants[1]!.expiresAt = new Date(Date.now() + 2 * 86400000).toISOString();
  expect(() => fm.writeContactPermissions("worker", { revision: p.revision, grants }, admin)).not.toThrow();
  grants[0]!.verbs = ["broadcast"];
  expect(() => fm.writeContactPermissions("worker", { revision: view().revision, grants }, admin)).toThrow("invalid-grant");
});

it("ticket grant references name exactly the persisted selected-person rows, preserving neighbors and transactional rollback", () => {
  const h = rig();
  const prior = h.store.writePolicy("worker", { revision: 0, grants: [{ id: "", person: admin, source: "room", target: "worker", verbs: ["request_information"], expiresAt: new Date(10_000).toISOString(), remainingUses: null }] }, admin, n => n === "worker" ? "worker-one" : "room-one");
  const ticket = h.store.hold(h.request());
  const result = h.store.decide(ticket.id, { revision: 1, decision: "approve-once", grant: h.grant([bob]) }, admin, h.authority);
  const saved = h.store.policy("worker", "worker-one");
  expect(saved.grants[0]).toEqual(prior.grants[0]);
  expect(saved.grants.slice(1).map(row => contactPersonKey(row.person))).toEqual([contactPersonKey(bob)]);
  expect(result.grantIds).toEqual(saved.grants.slice(1).map(row => row.id));
  expect(h.store.get(ticket.id)?.grantIds).toEqual(result.grantIds);
  const pending = h.store.hold(h.request());
  expect(() => h.store.decide(pending.id, { revision: 1, decision: "approve-once", grant: h.grant([alice]) }, admin,
    { ...h.authority, admit: () => { throw Error("admission-failed"); } })).toThrow("admission-failed");
  expect(h.store.policy("worker", "worker-one")).toEqual(saved);
  expect(h.store.get(pending.id)).toMatchObject({ state: "pending" });
  expect(h.store.get(pending.id)?.grantIds).toBeUndefined();
});
