import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { WebChatHistory } from "../src/web-chat-history.js";
import Database from "better-sqlite3";
import { ContactAuthService } from "../src/contact-auth-service.js";
import { ContactAuthStore } from "../src/contact-auth-store.js";
import type { ContactRequest } from "../src/contact-auth-store.js";
import type { ContactPerson, ContactOrigin } from "../src/contact-auth-types.js";

const admin: ContactPerson = { platform: "discord", adapterId: "fake-bot", userId: "fake-admin", label: "Admin" };
const member: ContactPerson = { ...admin, userId: "fake-member", label: "Member" };
const origin: ContactOrigin = { kind: "human", people: [member], receiptIds: ["fake-receipt"], chain: ["room"] };
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function rig() {
  const db = new Database(":memory:"); databases.push(db);
  let now = 1_000;
  const store = new ContactAuthStore(db, () => now);
  const input = { operationId: "fake-operation", source: "room", target: "worker", sourceGeneration: "source-one",
    targetGeneration: "target-one", verb: "delegate_task" as const, origin, message: "Read public information",
    correlationId: "fake-correlation", resultRecipient: "room", payload: { content: "Read public information" } };
  const authority = { canDecide: () => true, current: () => true, admit: vi.fn((_request: ContactRequest, _ticketId: string) => "fake-delivery") };
  return { db, store, input, authority, setNow: (value: number) => { now = value; } };
}
describe("Classic contact authorization", () => {
  it("holds the exact original request without admission and admits it once on an authorized decision", () => {
    const { store, input, authority } = rig();
    const held = store.hold(input);
    expect(held.state).toBe("pending"); expect(authority.admit).not.toHaveBeenCalled();
    const decided = store.decide(held.id, { revision: held.revision, decision: "approve-once" }, admin, authority);
    expect(decided.state).toBe("approved"); expect(decided.deliveryId).toBe("fake-delivery");
    expect(authority.admit).toHaveBeenCalledOnce();
    expect(authority.admit.mock.calls[0]?.[0]).toMatchObject({ payload: input.payload, origin, message: input.message });
    expect(() => store.decide(held.id, { revision: decided.revision, decision: "approve-once" }, admin, authority)).toThrow("already-decided");
    expect(authority.admit).toHaveBeenCalledOnce();
    expect(store.hold(input).id).toBe(held.id);
    expect(() => store.hold({ ...input, message: "Changed request" })).toThrow("operation-conflict");
  });
  it("decline, expiry, a changed target and a non-approver never admit", () => {
    const { store, input, authority, setNow } = rig();
    const held = store.hold(input);
    expect(() => store.decide(held.id, { revision: 1, decision: "approve-once" }, member,
      { ...authority, canDecide: () => false })).toThrow("forbidden");
    expect(() => store.decide(held.id, { revision: 1, decision: "approve-once" }, admin,
      { ...authority, current: () => false })).toThrow("stale-generation");
    store.decide(held.id, { revision: 1, decision: "decline" }, admin, authority);
    const expiring = store.hold({ ...input, operationId: "second" });
    setNow(Date.parse(expiring.expiresAt));
    expect(() => store.decide(expiring.id, { revision: 1, decision: "approve-once" }, admin, authority)).toThrow("expired");
    expect(store.get(expiring.id)?.state).toBe("expired");
    expect(authority.admit).not.toHaveBeenCalled();
  });
  it("rolls the decision and outbox insertion back together when admission fails", () => {
    const { db, store, input, authority } = rig();
    db.exec("CREATE TABLE fake_outbox(id TEXT PRIMARY KEY)");
    const held = store.hold(input);
    expect(() => store.decide(held.id, { revision: 1, decision: "approve-once" }, admin, {
      ...authority, admit: () => { db.prepare("INSERT INTO fake_outbox VALUES (?)").run("one"); throw Error("storage-failed"); },
    })).toThrow("storage-failed");
    expect(db.prepare("SELECT * FROM fake_outbox").all()).toEqual([]);
    expect(store.get(held.id)?.state).toBe("pending");
  });
  it("restoring the store never replays a committed approval", () => {
    const { db, store, input, authority } = rig();
    const held = store.hold(input);
    store.decide(held.id, { revision: 1, decision: "approve-once" }, admin, authority);
    const restored = new ContactAuthStore(db, () => 2_000);
    expect(restored.get(held.id)?.deliveryId).toBe("fake-delivery");
    expect(restored.hold(input).state).toBe("approved");
    expect(authority.admit).toHaveBeenCalledOnce();
  });
  it("preserves derived origins across later turns and a restart; an admin message cannot wash them", () => {
    const { db, store } = rig();
    store.inheritOrigin("worker", origin);
    store.inheritOrigin("worker", { kind: "human", people: [admin], receiptIds: ["admin-receipt"], chain: [] });
    const restored = new ContactAuthStore(db);
    const combined = restored.origin("worker")!;
    expect(combined.kind).toBe("mixed");
    expect(combined.people.map(p => p.userId)).toEqual(expect.arrayContaining([member.userId, admin.userId]));
    expect(combined.receiptIds).toContain("fake-receipt");
    restored.inheritOrigin("worker", { kind: "unknown", people: [], receiptIds: [], chain: [] });
    expect(restored.origin("worker")?.kind).toBe("unknown");
  });
});

it("binds standing grants and policy revisions to the current source and target incarnations", () => {
  const { store, input } = rig();
  const generations: Record<string, string> = { room: input.sourceGeneration, worker: input.targetGeneration };
  const resolve = (name: string) => generations[name]!;
  const policy = store.writePolicy("worker", { revision: 0, grants: [{ id: "", person: member,
    source: "room", target: "worker", verbs: ["delegate_task"], expiresAt: new Date(100_000).toISOString(), remainingUses: null }] }, admin, resolve);
  expect(store.matchingGrants(input)).toHaveLength(1);
  generations.room = "new-source";
  expect(store.matchingGrants({ ...input, sourceGeneration: generations.room })).toEqual([]);
  generations.worker = "new-target";
  const fresh = store.policy("worker", generations.worker);
  expect(fresh.grants).toEqual([]);
  expect(fresh.revision).toBe(policy.revision + 1);
  expect(() => store.writePolicy("worker", { revision: policy.revision, approvers: [member] }, admin, resolve)).toThrow("conflict");
  expect(store.policy("worker", input.targetGeneration).grants).toEqual([]);
});

it("does not expose an earlier incarnation's ticket to the replacement's administrator", () => {
  const { store, input } = rig();
  const ticket = store.hold(input);
  const generations: Record<string, string> = { room: input.sourceGeneration, worker: input.targetGeneration };
  const service = new ContactAuthService({ store, generation: name => generations[name]!, restricted: () => true,
    defaultApprovers: () => [admin], adminOf: () => false, hubRestricted: () => false,
    delivered: () => false, admit: () => "unused", changed: () => {} });
  expect(service.view(ticket, admin).canDecide).toBe(true);
  generations.worker = "replacement";
  expect(() => service.view(ticket, admin)).toThrow("forbidden");
  generations.worker = input.targetGeneration;
  generations.room = "replacement-source";
  expect(service.view(ticket, admin).canDecide).toBe(false);
});

it("keeps historical rooms legacy while new rooms persist restricted mode", () => {
  const home = mkdtempSync(join(tmpdir(), "classic-mode-"));
  try {
    writeFileSync(join(home, "classicBot.yaml"), "channels:\n  fake-old:\n    channelId: fake-old\n    instanceName: old-room\n");
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const rooms = new ClassicChannelManager(home, log as any);
    expect(rooms.getAll().find(row => row.instanceName === "old-room")?.restrictedMode).toBeUndefined();
    rooms.register("fake-new", undefined, "new-room", "New room", "fake-admin");
    rooms.reloadFromDisk();
    expect(rooms.getAll().find(row => row.instanceName === "new-room")?.restrictedMode).toBe(true);
    expect(rooms.getAll().find(row => row.instanceName === "old-room")?.restrictedMode).toBeUndefined();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
it("persists ticket badges and their decided state through chat history restoration", () => {
  let saved: any[] = [];
  const history = new WebChatHistory({ boot: "aa" });
  history.setStore({ schedule: (_name: string, rows: () => any[]) => { saved = rows(); } } as any);
  history.record({ instance: "room", sender: "AgEnD", text: "Contact held", ts: new Date(1_000).toISOString(),
    role: "status", contactTicket: { id: "R00000000-0000-4000-8000-000000000001", state: "pending" } });
  history.updateContactTicket("room", "R00000000-0000-4000-8000-000000000001", "approved");
  expect(saved[0]?.contactTicket?.state).toBe("approved");
  const restored = new WebChatHistory({ boot: "bb" });
  restored.setStore({ schedule: (_name: string, rows: () => any[]) => { saved = rows(); } } as any);
  restored.restore("room", saved);
  restored.updateContactTicket("room", "R00000000-0000-4000-8000-000000000001", "delivered");
  expect(saved[0]?.contactTicket?.state).toBe("delivered");
});

it("does not carry received attachment identifiers into a replacement room", () => {
  const { store } = rig();
  store.recordRoomContext("room", { threadId: "fake-thread", fileIds: ["fake-attachment"] }, "one");
  expect(store.roomContext("room", "one").fileIds).toEqual(["fake-attachment"]);
  expect(store.roomContext("room", "two")).toEqual({ fileIds: [] });
  store.recordRoomContext("room", { fileIds: ["new-attachment"] }, "two");
  expect(store.roomContext("room", "two").fileIds).toEqual(["new-attachment"]);
});
