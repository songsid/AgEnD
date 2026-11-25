import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { IncomingMessage, ServerResponse } from "node:http";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { ContactAuthStore } from "../src/contact-auth-store.js";
import { handleContactAuthorizationApi } from "../src/contact-auth-api.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import type { ContactOrigin, ContactPerson } from "../src/contact-auth-types.js";
const admin: ContactPerson = { platform: "discord", adapterId: "fake-bot", userId: "fake-admin", label: "Fleet admin" };
const member: ContactPerson = { ...admin, userId: "fake-member", label: "Room member" };
const host: ContactPerson = { platform: "host", adapterId: "host", userId: "operator", label: "Operator" };
const origin: ContactOrigin = { kind: "unknown", people: [member], receiptIds: ["fake-receipt"], chain: ["room", "worker"] };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); });
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "origin-clear-"));
  const outbox = new DeliveryOutbox(join(dir, "outbox.db"));
  cleanup.push(() => { outbox.close(); rmSync(dir, { recursive: true, force: true }); });
  let generation = "fake-generation", hub = false;
  const fm: any = Object.assign(Object.create(FleetManager.prototype), {
    deliveryOutbox: outbox, fleetConfig: { defaults: {}, instances: { worker: { backend: "codex" }, other: { backend: "codex" } } },
    adapters: new Map([["fake-bot", { id: "fake-bot", type: "discord" }]]), worlds: new Map(),
    lifecycle: { daemons: new Map() }, getInstanceAdapterId: () => "fake-bot", adminListOf: () => [admin.userId],
    isFleetAdmin: (id: string) => id === admin.userId, webChatOwner: () => ({ kind: "fleet" }),
    hubAgentToken: () => generation, hubContactRestricted: () => hub, emitSseEvent: vi.fn(),
    contactActor: vi.fn(() => admin), logger: { error: vi.fn() }, scheduleDeliveryOutboxPump: vi.fn(),
  });
  const store = outbox.contactAuthorizations;
  store.inheritOrigin("worker", origin);
  const snapshot = () => { const p = fm.contactPermissions("worker", admin); return { revision: p.revision,
    originRevision: p.originState.revision, generation: p.originState.generation }; };
  return { fm, outbox, store, snapshot, generation: (value: string) => { generation = value; }, hub: () => { hub = true; } };
}
it.each([admin, host])("verified managing $platform admin clears unknown with an atomic audit and no invented receipt", actor => {
  const r = rig();
  const next = r.fm.clearContactOrigin("worker", r.snapshot(), actor);
  expect(next.originState).toMatchObject({ kind: "human", people: [actor], receiptCount: 0, revision: 2,
    lastCleared: { actor } });
  expect(r.store.histories("worker", "fake-generation")).toEqual([expect.objectContaining({ action: "origin-clear", actor,
    generation: "fake-generation", originChange: { before: { kind: "unknown", people: [member], receiptCount: 1, chain: ["room", "worker"] }, after: { kind: "human", people: [actor], receiptCount: 0, chain: ["worker"] } } })]);
  expect(JSON.stringify(next.history)).not.toContain("fake-receipt");
  expect(r.fm.contactService().needsApplication("worker")).toBe(false);
  const last = next.originState.lastCleared;
  r.store.inheritOrigin("worker", { ...origin, kind: "human", receiptIds: ["fake-next-input"] });
  expect(r.fm.contactService().needsApplication("worker")).toBe(true);
  expect(r.fm.contactPermissions("worker", admin).originState.lastCleared).toEqual(last);
});
it("every agent shows origin state, people and hops without exposing receipt IDs", () => {
  const r = rig();
  expect(r.fm.contactPermissions("worker", admin).originState).toMatchObject({ kind: "unknown", people: [member], chain: ["room", "worker"], receiptCount: 1 });
  expect(r.fm.contactPermissions("worker", admin).originState).not.toHaveProperty("receiptIds");
  expect(r.fm.contactPermissions("other", admin).originState).toMatchObject({ kind: "none", canClear: false });
  expect(() => r.fm.contactPermissions("worker", member)).toThrow("forbidden");
});
it.each([member, { ...admin, adapterId: "fake-other", userId: "fake-other-admin" }, { ...admin, platform: "telegram" as const }])("non-managing $userId cannot clear", actor => {
  const r = rig(); const before = r.store.origin("worker");
  expect(() => r.fm.clearContactOrigin("worker", r.snapshot(), actor)).toThrow("forbidden");
  expect(r.store.origin("worker")).toEqual(before); expect(r.store.histories("worker")).toEqual([]);
});
it.each(["origin", "identical-origin", "policy", "generation", "replay"])("refuses a stale %s snapshot without a new audit", change => {
  const r = rig(); const input = r.snapshot();
  if (change === "origin") r.store.inheritOrigin("worker", { ...origin, receiptIds: ["fake-new"] });
  if (change === "identical-origin") r.store.inheritOrigin("worker", origin);
  if (change === "policy") r.store.writePolicy("worker", { revision: 0, approvers: [admin] }, admin, () => "fake-generation");
  if (change === "generation") r.generation("fake-new-generation");
  if (change === "replay") r.fm.clearContactOrigin("worker", input, admin);
  const before = r.store.origin("worker"), auditCount = r.store.histories("worker").length;
  expect(() => r.fm.clearContactOrigin("worker", input, admin)).toThrow("conflict");
  expect(r.store.origin("worker")).toEqual(before); expect(r.store.histories("worker")).toHaveLength(auditCount);
});
it("audit failure rolls back both origin and monotonic revision, and a reopened store retains the revision", () => {
  const r = rig(), input = r.snapshot(), db = (r.outbox as any).db;
  db.exec("CREATE TRIGGER fake_audit_failure BEFORE INSERT ON contact_auth_history BEGIN SELECT RAISE(ABORT, 'fake-audit-failure'); END");
  expect(() => r.fm.clearContactOrigin("worker", input, admin)).toThrow("fake-audit-failure");
  expect(r.store.origin("worker")).toEqual(origin); expect(r.store.originRevision("worker")).toBe(input.originRevision);
  expect(r.fm.emitSseEvent).not.toHaveBeenCalled();
  db.exec("DROP TRIGGER fake_audit_failure"); r.fm.clearContactOrigin("worker", input, admin);
  const restored = new ContactAuthStore(db);
  expect(restored.originRevision("worker")).toBe(input.originRevision + 1);
  expect(restored.lastOriginClear("worker", "fake-generation")?.actor).toEqual(admin);
  expect(restored.lastOriginClear("worker", "fake-other-generation")).toBeUndefined();
});
it("clearing leaves pending tickets, grants and another worker unchanged; Hub contact still refuses", async () => {
  const r = rig(); r.store.inheritOrigin("other", origin);
  const ticket = r.store.hold({ operationId: "fake-op", source: "worker", target: "other", sourceGeneration: "fake-generation", targetGeneration: "fake-generation",
    verb: "send_to_instance", origin, message: "Synthetic question", correlationId: "fake-correlation", resultRecipient: "worker", payload: { content: "Synthetic question" } });
  r.store.writePolicy("worker", { revision: 0, grants: [{ id: "", person: member, source: "other", target: "worker", verbs: ["send_to_instance"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(), remainingUses: 1 }] }, admin, () => "fake-generation");
  const grants = r.store.policy("worker").grants;
  r.fm.clearContactOrigin("worker", r.snapshot(), admin);
  expect(r.store.get(ticket.id)).toEqual(ticket); expect(r.store.policy("worker").grants).toEqual(grants);
  expect(r.store.origin("other")).toEqual(origin);
  r.hub(); const respond = vi.fn();
  await outboundHandlers.get("send_to_instance")!(r.fm, { instance_name: "other", message: "Synthetic question" }, respond,
    { instanceName: "worker", requestId: 1, operationId: "fake-hub-op", fleetRequestId: undefined, senderSessionName: undefined });
  expect(respond.mock.calls[0]?.[1]).toContain("Hub");
  expect(r.store.list().items).toHaveLength(1); expect(r.outbox.listPending()).toEqual([]);
});
class Response extends ServerResponse {
  code = 0; body = ""; resolve!: () => void; done = new Promise<void>(resolve => { this.resolve = resolve; });
  override writeHead(code: number): this { this.code = code; return this; }
  override end(value?: unknown): this { this.body = String(value ?? ""); this.resolve(); return this; }
}
async function api(r: ReturnType<typeof rig>, body: unknown, method = "POST") {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  req.method = method; const url = new URL("http://localhost/ui/api/instances/worker/contact-permissions/origin-clear"), res = new Response(req);
  expect(handleContactAuthorizationApi(req, res, url, r.fm)).toBe(true); await res.done;
  return { status: res.code, body: JSON.parse(res.body) };
}
it("the authenticated web action uses the server actor; refuses absent/revoked identity, extra authority and GET", async () => {
  const r = rig(); const input = r.snapshot();
  r.fm.contactActor.mockReturnValue(null); expect((await api(r, input)).status).toBe(403);
  r.fm.contactActor.mockReturnValueOnce(admin).mockReturnValue(null); expect((await api(r, input)).status).toBe(403);
  r.fm.contactActor.mockReturnValue(admin);
  expect((await api(r, { ...input, actor: host })).status).toBe(400);
  expect((await api(r, input, "GET")).status).toBe(405);
  expect((await api(r, input)).status).toBe(200);
  expect(r.store.origin("worker")?.people).toEqual([admin]);
  expect((await api(r, input)).status).toBe(409);
});
it("a restricted room recovers through the admin override, without changing its mode or tool guard", () => {
  const r = rig();
  r.fm.classicChannels = { getAll: () => [{ instanceName: "worker", adapterId: "fake-bot", restrictedMode: true }], getBackendByInstance: () => "claude-code" };
  const setClassicRestriction = vi.fn(); r.fm.lifecycle.daemons.set("worker", { setClassicRestriction });
  expect(r.fm.contactService().needsApplication("worker")).toBe(true);
  const result = r.fm.clearContactOrigin("worker", r.snapshot(), admin);
  expect(result.mode).toBe("restricted"); expect(r.fm.contactService().needsApplication("worker")).toBe(false);
  expect(setClassicRestriction).not.toHaveBeenCalled();
});
it("management rights are rechecked in the reset transaction", () => {
  const r = rig(), input = r.snapshot();
  r.fm.adminListOf = vi.fn().mockReturnValueOnce([admin.userId]).mockReturnValue([]);
  expect(() => r.fm.clearContactOrigin("worker", input, admin)).toThrow("forbidden");
  expect(r.store.origin("worker")).toEqual(origin); expect(r.store.histories("worker")).toEqual([]);
});
it("last cleared comes from its audit even after it leaves the newest history page", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-19T09:00:00Z"); vi.setSystemTime(new Date(start));
  const r = rig(); r.fm.clearContactOrigin("worker", r.snapshot(), admin);
  for (let revision = 0; revision < 60; revision++) {
    vi.setSystemTime(new Date(start + revision + 1));
    r.store.writePolicy("worker", { revision, approvers: [admin] }, admin, () => "fake-generation");
  }
  expect(r.store.histories("worker", "fake-generation")).toHaveLength(50);
  expect(r.store.histories("worker", "fake-generation").some(row => row.action === "origin-clear")).toBe(false);
  expect(r.fm.contactPermissions("worker", admin).originState.lastCleared?.actor).toEqual(admin);
});
