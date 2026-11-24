import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { mergeContactOrigins, type ContactRequest } from "../src/contact-auth-store.js";
import { nativeHumanOrigin } from "../src/human-delivery-receipts.js";
import type { ContactOrigin, ContactPerson } from "../src/contact-auth-types.js";
const admin: ContactPerson = { platform: "discord", adapterId: "fake-dc", userId: "fake-admin", label: "Admin" };
const member: ContactPerson = { ...admin, userId: "fake-member", label: "Member" };
const otherAdmin: ContactPerson = { ...admin, adapterId: "fake-other", userId: "fake-other-admin" };
const origin = (person = member, receipt = "fake-receipt"): ContactOrigin => ({ kind: "human", people: [person], receiptIds: [receipt], chain: ["room"] });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function rig() {
  const directory = mkdtempSync(join(tmpdir(), "origin-feedback-"));
  const outbox = new DeliveryOutbox(join(directory, "outbox.db"));
  cleanups.push(() => { outbox.close(); rmSync(directory, { recursive: true, force: true }); });
  const room = { instanceName: "room", channelId: "fake-room", adapterId: "fake-dc", restrictedMode: true };
  const adapters = new Map(["fake-dc", "fake-other"].map(id => [id, { id, type: "discord" }]));
  const fm: any = Object.assign(Object.create(FleetManager.prototype), {
    dataDir: directory, deliveryOutbox: outbox, managerBootId: "fake-manager",
    fleetConfig: { defaults: {}, instances: { worker: { working_directory: directory }, peer: { working_directory: directory, channel_id: "fake-other" } } },
    classicChannels: { getAll: () => [room], isAdmin: (id: string) => id === admin.userId, setRestrictedMode: (_name: string, value: boolean) => { room.restrictedMode = value; } },
    adapters, worlds: new Map(), getPrimaryAdapterId: () => "fake-dc",
    adminListOf: (id: string) => id === "fake-dc" ? [admin.userId] : id === "fake-other" ? [otherAdmin.userId] : [],
    getDaemonBootId: (name: string) => `${name}-boot`, hubAgentToken: (name: string) => `${name}-gen`,
    hubContactRestricted: () => false, generalLocationDeliveryHold: () => null,
    scheduleDeliveryOutboxPump: vi.fn(), publishTraffic: vi.fn(), emitSseEvent: vi.fn(), needsYouItems: () => [],
    lifecycle: { daemons: new Map() }, logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    contactPermissions: () => ({ revision: outbox.contactAuthorizations.policy("room", "room-gen").revision,
      mode: room.restrictedMode ? "restricted" : "legacy", canManage: true, canSetMode: true, eligibleApprovers: [admin] }),
  });
  const store = outbox.contactAuthorizations;
  const service = () => fm.contactService();
  const human = (target: string, person: ContactPerson, id: string) => fm.humanReceiptPayload(target,
    { type: "fleet_inbound", content: "Synthetic request", meta: {} },
    nativeHumanOrigin("discord", person.adapterId, person.userId, person.label, false, id), "Synthetic request");
  const request = (value: ContactOrigin, target = "worker"): ContactRequest => ({ operationId: "fake-operation", source: "room", target,
    sourceGeneration: "room-gen", targetGeneration: `${target}-gen`, verb: "send_to_instance", origin: value,
    message: "Synthetic question", correlationId: "fake-correlation", resultRecipient: "room", payload: { type: "fleet_inbound", content: "Synthetic question" } });
  const grant = () => store.writePolicy("worker", { revision: 0, grants: [{ id: "", person: admin, source: "room", target: "worker", verbs: ["send_to_instance"], expiresAt: new Date(Date.now() + 60_000).toISOString(), remainingUses: null }] }, admin, name => `${name}-gen`);
  const admit = (target: string) => fm.admitDurableDelivery({ operationId: "fake-operation", sourceInstance: "room", sourceDaemonBootId: "room-boot", targetInstance: target,
    kind: "fleet_inbound", correlationId: "fake-correlation", payload: { type: "fleet_inbound", content: "Synthetic question" } });
  return { fm, room, outbox, store, service, human, request, grant, admit };
}
it("first legacy switch seeds sticky unknown; even a valid admin grant cannot match it", () => {
  const r = rig(); r.room.restrictedMode = false;
  r.fm.writeContactPermissions("room", { revision: 0, mode: "restricted" }, admin);
  r.human("room", admin, "fake-admin-input"); r.grant();
  expect(r.store.origin("room")?.kind).toBe("unknown");
  expect(r.service().needsApplication("room")).toBe(true);
  expect(r.store.matchingGrants(r.request(origin(admin)))).toHaveLength(1);
  expect(r.store.matchingGrants(r.request(r.store.origin("room")!))).toEqual([]);
});
it("delegated-only workers inherit the primary adapter; a genuinely adapterless target admits only host authority", () => {
  const r = rig();
  expect(r.fm.getInstanceAdapterId("worker")).toBe("fake-dc");
  expect(r.service().host.defaultApprovers("worker")).toEqual([expect.objectContaining({ userId: admin.userId })]);
  r.fm.getPrimaryAdapterId = () => undefined;
  expect(r.service().host.defaultApprovers("worker")).toEqual([]);
  expect(r.service().canDecide("worker", admin)).toBe(false);
  expect(r.service().canDecide("worker", { platform: "host", adapterId: "host", userId: "operator", label: "Operator" })).toBe(true);
});
it("a new daemon/service retains origin under the same instance key", () => {
  const r = rig(); r.store.inheritOrigin("worker", origin());
  r.fm.getDaemonBootId = () => "new-boot";
  expect(r.service().origin("worker")).toEqual(origin());
  expect(r.service().needsApplication("worker")).toBe(true);
});
it("ordinary admission copies origin to a non-Classic worker with a different owning adapter", () => {
  const r = rig(); r.store.inheritOrigin("room", origin(admin)); r.admit("peer");
  expect(r.store.origin("peer")?.people).toEqual([admin]);
  expect(r.service().needsApplication("peer")).toBe(true);
  r.human("peer", otherAdmin, "fake-direct-owner-input");
  expect(r.store.origin("peer")?.kind).toBe("mixed");
  expect(r.service().needsApplication("peer")).toBe(true);
});
it("approved member work preserves a clean worker; its administrator remains unrestricted", () => {
  const r = rig(); r.store.inheritOrigin("room", origin());
  expect(() => r.admit("worker")).toThrow();
  const ticket = r.store.list().items[0]!;
  r.fm.decideContactAuthorization(ticket.id, { revision: ticket.revision, decision: "approve-once" }, admin);
  expect(r.store.origin("worker")).toBeUndefined();
  expect(r.store.origin("room")?.people).toEqual([member]);
  r.human("worker", admin, "fake-direct-admin-input");
  expect(r.store.origin("worker")).toBeUndefined();
  expect(r.service().needsApplication("worker")).toBe(false);
});
it("keeps admin authority and a matching grant at 64, 65 and 66 real receipt inputs", () => {
  const r = rig(); r.grant();
  let checked = 0;
  for (let i = 1; i <= 66; i++) {
    r.human("room", admin, `fake-input-${i}`);
    if (![64, 65, 66].includes(i)) continue;
    checked++;
    expect(r.store.origin("room")?.kind).toBe("human");
    expect(r.store.origin("room")?.receiptIds).toHaveLength(64);
    expect(r.store.origin("room")?.people).toEqual([admin]);
    expect(r.service().needsApplication("room")).toBe(false);
    expect(r.store.matchingGrants(r.request(r.store.origin("room")!))).toHaveLength(1);
  }
  expect(checked).toBe(3);
});
it("keeps explicit or previously stored unknown after receipt history is trimmed", () => {
  const r = rig(); r.grant();
  r.store.inheritOrigin("room", { ...origin(admin), kind: "unknown" });
  for (let i = 1; i <= 66; i++) r.human("room", admin, `fake-known-${i}`);
  expect(r.store.origin("room")?.kind).toBe("unknown");
  expect(r.store.origin("room")?.receiptIds).toHaveLength(64);
  expect(r.store.matchingGrants(r.request(r.store.origin("room")!))).toEqual([]);
});
it.each([16, 17])("retains the people fail-closed boundary at %i identities", count => {
  const people = Array.from({ length: count }, (_, i) => ({ ...member, userId: `fake-person-${i}` }));
  const value = mergeContactOrigins(undefined, { ...origin(), kind: "mixed", people });
  expect(value.people).toHaveLength(16);
  expect(value.kind).toBe(count === 16 ? "mixed" : "unknown");
});
it("bounded diagnostic hops do not change a known person's authority", () => {
  const value = mergeContactOrigins(undefined, { ...origin(admin), chain: Array.from({ length: 33 }, (_, i) => `fake-hop-${i}`) });
  expect(value.kind).toBe("human");
  expect(value.chain).toHaveLength(32);
  expect(value.chain[0]).toBe("fake-hop-1");
});
it("saving restricted on an already restricted known room should not seed unknown", () => {
  const r = rig(); r.store.inheritOrigin("room", origin(admin));
  const before = r.store.origin("room");
  r.fm.writeContactPermissions("room", { revision: 0, mode: "restricted" }, admin);
  expect(r.store.origin("room")).toEqual(before);
  r.fm.writeContactPermissions("room", { revision: 1, mode: "legacy" }, admin);
  expect(r.store.origin("room")).toEqual(before);
  r.fm.writeContactPermissions("room", { revision: 2, mode: "restricted" }, admin);
  expect(r.store.origin("room")?.kind).toBe("unknown");
});

it("M-3679 receipt retains the observing bot, while one person's contact origin is independent of it",()=>{
 const r=rig(),alias={...admin,adapterId:"fake-other"};
 r.store.inheritOrigin("worker",origin(admin));
 r.human("worker",admin,"native-main");
 const payload=r.human("worker",alias,"native-persona") as {meta:{human_receipt_id:string}};
 const proof=r.outbox.getHumanReceipt(payload.meta.human_receipt_id)!;
 expect(JSON.parse(proof.origin_json)).toMatchObject({platform:"discord",adapter_id:"fake-other",user_id:admin.userId});
 expect(r.store.origin("worker")).toMatchObject({kind:"human",people:[expect.objectContaining({userId:admin.userId})]});
 expect(r.service().needsApplication("worker")).toBe(false);
});
