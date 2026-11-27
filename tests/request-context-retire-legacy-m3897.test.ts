// M-3897 (Sentinel's settlement split for S-273): before the first On, an earlier contact ticket with no readable
// delivery record (missing-receipt), an unconfirmed one, or an unreadable (malformed) one can be retired by an owner.
// The retirement is append-only and bound to the ticket's exact stored image: it never relabels the ticket, never
// grants a receipt, and fences that ticket's replay. A changed row is not covered.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { contactRetirementImage } from "../src/contact-auth-store.js";
import type { RequestMigrationHost } from "../src/request-context-migration.js";
import type { ContactPerson } from "../src/contact-auth-types.js";
import type { ContactRequest } from "../src/contact-auth-store.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const admin: ContactPerson = { platform: "discord", adapterId: "fixture", userId: "demo-admin", label: "Demo admin" };
function rig() {
  const home = mkdtempSync(join(tmpdir(), "m3897-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const box = new DeliveryOutbox(join(home, "outbox.db")); cleanup.push(() => box.close());
  const db = (box as any).db as Database.Database, store = box.contactAuthorizations;
  const host: RequestMigrationHost = { owner: () => "manager-a", policyEpoch: () => "policy-a", generation: () => "v1", canManage: () => true };
  const shadow = () => box.requestContextMigrationShadow(host).inspect();
  const request = (operationId = randomUUID()): ContactRequest => ({ operationId, source: "source", target: "target", sourceGeneration: "v1", targetGeneration: "v1",
    verb: "send_to_instance", origin: { kind: "unknown", people: [], receiptIds: [], chain: [] }, message: "hello", correlationId: "c1", resultRecipient: "source",
    payload: { type: "message" } } as unknown as ContactRequest);
  /** An earlier ticket approved for a delivery whose row is gone (the 11-27 upgraded-home shape). */
  const approvedMissing = (input = request()) => {
    const ticket = store.hold(input);
    const row = db.prepare("SELECT ticket_json FROM contact_auth_tickets WHERE id=?").get(ticket.id) as { ticket_json: string };
    db.prepare("UPDATE contact_auth_tickets SET ticket_json=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.ticket_json), state: "approved", deliveryId: "gone-delivery" }), ticket.id);
    return { id: ticket.id, input };
  };
  const entry = (id: string) => shadow().tickets.find(row => row.id === id)!;
  return { box, db, store, shadow, request, approvedMissing, entry };
}

describe("M-3897: retiring an earlier ticket nothing can settle", () => {
  it("missing-receipt: retired by its exact image → no longer a blocker; the ticket row itself is unchanged", () => {
    const r = rig(), { id } = r.approvedMissing();
    const before = r.entry(id);
    expect(before.disposition).toBe("missing-receipt");
    expect(r.shadow().blockers.map(b => b.id)).toContain(id);
    const raw = JSON.stringify(r.db.prepare("SELECT * FROM contact_auth_tickets WHERE id=?").get(id));
    r.store.retireLegacy(id, before.sha256!, before.disposition, admin, () => true);
    expect(r.entry(id).disposition).toBe("retired-unknown");
    expect(r.shadow().blockers.map(b => b.id)).not.toContain(id);
    expect(r.shadow().complete).toBe(true);
    expect(JSON.stringify(r.db.prepare("SELECT * FROM contact_auth_tickets WHERE id=?").get(id))).toBe(raw);   // never relabelled
    expect(r.db.prepare("SELECT ticket_id,disposition,actor_json FROM contact_auth_retirements").all()).toEqual([{ ticket_id: id, disposition: "missing-receipt", actor_json: JSON.stringify(admin) }]);
  });

  it("a retired request is never replayed: the same operation is refused, and it allows no reply", () => {
    const r = rig(), { id, input } = r.approvedMissing();
    expect(r.store.hold(input).id).toBe(id);                                        // before: the old approval is returned
    expect(r.store.approvedReturn("target", "source", "c1").map(t => t.id)).toEqual([id]);
    const e = r.entry(id);
    r.store.retireLegacy(id, e.sha256!, e.disposition, admin, () => true);
    expect(() => r.store.hold(input)).toThrow("operation-retired");
    expect(r.store.retired(id)).toBe(true);
    expect(r.store.approvedReturn("target", "source", "c1")).toEqual([]);
  });

  it("bound to the image: a stale image is refused, and a row that changes after retirement is a blocker again", () => {
    const r = rig(), { id } = r.approvedMissing(), e = r.entry(id);
    expect(() => r.store.retireLegacy(id, "0".repeat(64), e.disposition, admin, () => true)).toThrow("stale");
    expect(() => r.store.retireLegacy(id, e.sha256!, e.disposition, admin, () => false)).toThrow("stale");
    r.store.retireLegacy(id, e.sha256!, e.disposition, admin, () => true);
    const row = r.db.prepare("SELECT ticket_json FROM contact_auth_tickets WHERE id=?").get(id) as { ticket_json: string };
    r.db.prepare("UPDATE contact_auth_tickets SET ticket_json=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.ticket_json), deliveryId: "other" }), id);
    expect(r.entry(id).disposition).toBe("missing-receipt");
    expect(r.store.retired(id)).toBe(false);
  });

  it("Sentinel's Go back contract: the retirement image changes with each retirement (a snapshot from before can't match)", () => {
    const r = rig();
    expect(contactRetirementImage(r.db)).toBe("none");
    const { id } = r.approvedMissing(), e = r.entry(id);
    r.store.retireLegacy(id, e.sha256!, e.disposition, admin, () => true);
    const once = contactRetirementImage(r.db);
    expect(once).toMatch(/^[0-9a-f]{64}$/);
    const second = r.approvedMissing(), e2 = r.entry(second.id);
    r.store.retireLegacy(second.id, e2.sha256!, e2.disposition, admin, () => true);
    expect(contactRetirementImage(r.db)).not.toBe(once);
  });

  it("only what nothing else settles: a pending ticket can't be retired (it is decided on Authorizations)", () => {
    const r = rig(), ticket = r.store.hold(r.request()), e = r.entry(ticket.id);
    expect(e.disposition).toBe("preserve-legacy-pending");
    expect(() => r.store.retireLegacy(ticket.id, e.sha256!, e.disposition, admin, () => true)).toThrow("invalid-request");
    // Even a retirement row planted for it (no supported path writes one) never hides a pending decision.
    r.db.prepare("INSERT INTO contact_auth_retirements VALUES (?,?,?,?,?)").run(ticket.id, e.sha256!, "missing-receipt", 1, "{}");
    expect(r.entry(ticket.id).disposition).toBe("preserve-legacy-pending");
  });

  it("malformed: retired by its raw image, it no longer makes the whole scan incomplete", () => {
    const r = rig(), { id } = r.approvedMissing();
    r.db.prepare("UPDATE contact_auth_tickets SET ticket_json=? WHERE id=?").run("{not json", id);
    expect(r.entry(id).disposition).toBe("malformed");
    expect(r.shadow().complete).toBe(false);
    r.store.retireLegacy(id, r.entry(id).sha256!, "malformed", admin, () => true);
    expect(r.entry(id).disposition).toBe("retired-unknown");
    expect(r.shadow().complete).toBe(true);
  });
});

describe("M-3897: the owner's Retire / Withdraw before the first On (resolveLegacyBlocker)", () => {
  async function host(r: ReturnType<typeof rig>) {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const self = { deliveryOutbox: r.box, requestContextShadow: () => r.shadow() };
    const mutated: string[] = [];
    const actor = { person: admin, execution: { mutate: (fn: () => void) => { mutated.push("mutate"); fn(); } } };
    const resolve = (blocker: any, current = () => true) => (FleetManager.prototype as any).resolveLegacyBlocker.call(self, blocker, actor, current);
    return { resolve, mutated };
  }
  it("Retire: the shadow's exact image is retired through the decision's execution; then nothing blocks", async () => {
    const r = rig(), { id } = r.approvedMissing(), h = await host(r);
    h.resolve({ id: `legacy-retire:${id}`, kind: "legacy", labels: [id], action: "retire" });
    expect(h.mutated).toEqual(["mutate"]);
    expect(r.entry(id).disposition).toBe("retired-unknown");
    expect(() => h.resolve({ id: "legacy-retire:R-not-there", kind: "legacy", labels: [], action: "retire" })).toThrow("stale");
  });
  it("Retire refuses a ticket that isn't retirable, and anything when the decision is no longer current", async () => {
    const r = rig(), pending = r.store.hold(r.request()), h = await host(r);
    expect(() => h.resolve({ id: `legacy-retire:${pending.id}`, kind: "legacy", labels: [], action: "retire" })).toThrow("stale");
    const { id } = r.approvedMissing();
    expect(() => h.resolve({ id: `legacy-retire:${id}`, kind: "legacy", labels: [], action: "retire" }, () => false)).toThrow("stale");
    expect(r.entry(id).disposition).toBe("missing-receipt");
  });
  it("never after activation: once request-based approvals were turned on, these are the drain's, not this path's", async () => {
    const r = rig(), { id } = r.approvedMissing();
    const { FleetManager } = await import("../src/fleet-manager.js");
    const active = Object.assign(Object.create(r.box), { requestContextInstallation: () => ({ read: () => ({ mode: "active" }) }) });
    const self = { deliveryOutbox: active, requestContextShadow: () => r.shadow() };
    const actor = { person: admin, execution: { mutate: (fn: () => void) => fn() } };
    expect(() => (FleetManager.prototype as any).resolveLegacyBlocker.call(self, { id: `legacy-retire:${id}`, kind: "legacy", labels: [], action: "retire" }, actor, () => true)).toThrow("stale");
    expect(r.entry(id).disposition).toBe("missing-receipt");
  });
  it("Withdraw: an earlier queued delivery is cancelled by its exact image; one being sent is not", async () => {
    const r = rig(), h = await host(r);
    const { delivery } = r.box.admit({ operationId: "op-q", sourceKey: "legacy:q", sourceInstance: "lead", sourceDaemonBootId: "sb", targetInstance: "worker",
      kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "hi", meta: {} } } as any);
    h.resolve({ id: `legacy-withdraw:${delivery.deliveryId}`, kind: "legacy", labels: [], action: "withdraw" });
    expect((r.db.prepare("SELECT state FROM deliveries WHERE delivery_id=?").get(delivery.deliveryId) as { state: string }).state).toBe("cancelled");
    const sent = r.box.admit({ operationId: "op-s", sourceKey: "legacy:s", sourceInstance: "lead", sourceDaemonBootId: "sb", targetInstance: "worker",
      kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "hi", meta: {} } } as any).delivery;
    r.db.prepare("UPDATE deliveries SET state='delivering' WHERE delivery_id=?").run(sent.deliveryId);
    expect(() => h.resolve({ id: `legacy-withdraw:${sent.deliveryId}`, kind: "legacy", labels: [], action: "withdraw" })).toThrow("stale");
  });
});
