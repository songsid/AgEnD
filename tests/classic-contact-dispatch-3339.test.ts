import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { dispatchAgentOperation } from "../src/agent-endpoint.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import type { ContactPerson } from "../src/contact-auth-types.js";

const admin: ContactPerson = { platform: "discord", adapterId: "fake-adapter", userId: "fake-admin", label: "Admin" };
const member: ContactPerson = { ...admin, userId: "fake-member", label: "Member" };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function rig() {
  const directory = mkdtempSync(join(tmpdir(), "classic-contact-"));
  const outbox = new DeliveryOutbox(join(directory, "outbox.db"));
  cleanups.push(() => { outbox.close(); rmSync(directory, { recursive: true, force: true }); });
  let hub = false;
  const room = { instanceName: "room", channelId: "fake-room", adapterId: "fake-adapter", restrictedMode: true };
  const manager = Object.assign(Object.create(FleetManager.prototype), {
    dataDir: directory, deliveryOutbox: outbox,
    fleetConfig: { defaults: {}, instances: { worker: { working_directory: directory }, peer: { working_directory: directory } } },
    classicChannels: { getAll: () => [room], isAdmin: (id: string) => id === admin.userId },
    getAdapterForInstance: () => ({ type: "discord", id: "fake-adapter" }),
    getInstanceAdapterId: () => "fake-adapter", worlds: new Map(),
    adapters: new Map([["fake-adapter", { type: "discord", id: "fake-adapter" }]]),
    adminListOf: () => [admin.userId], isFleetAdmin: (id: string) => id === admin.userId,
    getDaemonBootId: (name: string) => `${name}-boot`, generalLocationDeliveryHold: () => null,
    hubAgentToken: (name: string) => `${name}-incarnation`,
    hubContactRestricted: () => hub, emitSseEvent: vi.fn(), scheduleDeliveryOutboxPump: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    publishTraffic: vi.fn(),
    instanceIpcClients: new Map([["room", { connected: true, send: vi.fn() }], ["worker", { connected: true, send: vi.fn() }], ["peer", { connected: true, send: vi.fn() }]]),
    lifecycle: { daemons: new Map(), isPaused: () => false }, sessionRegistry: new Map(), eventLog: null,
    getInstanceStatus: () => "running", lastActivityMs: () => 0, deliverToInstance: vi.fn(),
    isInstanceRestarting: () => false,
    sendCancelButton: vi.fn(async () => {}), notifyInstanceTopic: vi.fn(), queueMirrorMessage: vi.fn(), indexCrossInstance: vi.fn(),
    clearCancelButtonByCorrelation: vi.fn(), clearCancelButton: vi.fn(),
  }) as FleetManager & Record<string, any>;
  outbox.contactAuthorizations.inheritOrigin("room", { kind: "human", people: [member], receiptIds: ["fake-receipt"], chain: ["room"] });
  return { manager, outbox, setHub: (value: boolean) => { hub = value; } };
}
async function call(manager: any, tool: string, args: Record<string, unknown>, source = "room", operationId = `${tool}-operation`) {
  const respond = vi.fn();
  await outboundHandlers.get(tool)!(manager, args, respond, { instanceName: source, requestId: 1, fleetRequestId: undefined,
    senderSessionName: undefined, operationId, sourceDaemonBootId: `${source}-boot` });
  return respond;
}
it.each([
  ["send_to_instance", { instance_name: "worker", message: "Read public status" }],
  ["delegate_task", { target_instance: "worker", task: "Read public status" }],
  ["request_information", { target_instance: "worker", question: "Read public status" }],
  ["report_result", { target_instance: "worker", summary: "Read public status" }],
])("holds %s before any worker delivery and approval admits the exact original once", async (tool, args) => {
  const { manager, outbox } = rig();
  const response = await call(manager, tool as string, args as Record<string, unknown>);
  const result = response.mock.calls[0]?.[0];
  expect(result).toMatchObject({ sent: false, held: true, authorization_state: "pending" });
  expect(outbox.listPending()).toEqual([]); expect(manager.deliverToInstance).not.toHaveBeenCalled();
  const ticket = manager.contactAuthorization(result.authorization_id, admin);
  const approved = manager.decideContactAuthorization(ticket.id, { revision: ticket.revision, decision: "approve-once" }, admin);
  expect(approved.deliveryId).toBeTruthy();
  const pending = outbox.listPending(); expect(pending).toHaveLength(1);
  expect(pending[0]?.payload.content).toBe("Read public status");
  expect(() => manager.decideContactAuthorization(ticket.id, { revision: approved.revision, decision: "approve-once" }, admin)).toThrow("already-decided");
  expect(outbox.listPending()).toHaveLength(1);
});
it("reports each broadcast hold explicitly, including compact output", async () => {
  const { manager, outbox } = rig();
  const response = await call(manager, "broadcast", { targets: ["worker", "peer"], message: "Read public status" });
  expect(response.mock.calls[0]?.[0]).toMatchObject({ sent: 0, queued: false, held: [{ target: "worker" }, { target: "peer" }] });
  expect(outbox.listPending()).toEqual([]);
});
it("a Hub window refuses before a ticket and also stops a previously pending approval", async () => {
  const { manager, outbox, setHub } = rig();
  setHub(true);
  const response = await call(manager, "send_to_instance", { instance_name: "worker", message: "Read public status" });
  expect(response.mock.calls[0]?.[1]).toContain("this turn is answering a Hub question");
  expect(outbox.contactAuthorizations.list().items).toEqual([]);
  setHub(false);
  const held = await call(manager, "send_to_instance", { instance_name: "worker", message: "Read public status" });
  const ticket = manager.contactAuthorization(held.mock.calls[0]?.[0].authorization_id, admin);
  setHub(true);
  expect(() => manager.decideContactAuthorization(ticket.id, { revision: ticket.revision, decision: "approve-once" }, admin)).toThrow("stale-generation");
  expect(outbox.listPending()).toEqual([]);
});
it("an approved but undelivered request does not authorize a correlation-only return; a confirmed return does", async () => {
  const { manager, outbox } = rig();
  // Pre-existing worker restrictions still need the proven return; approval no longer creates them.
  outbox.contactAuthorizations.inheritOrigin("worker", outbox.contactAuthorizations.origin("room")!);
  const held = await call(manager, "delegate_task", { target_instance: "worker", task: "Read public status", correlation_id: "fake-work" });
  const ticket = manager.contactAuthorization(held.mock.calls[0]?.[0].authorization_id, admin);
  manager.decideContactAuthorization(ticket.id, { revision: ticket.revision, decision: "approve-once" }, admin);
  const premature = await call(manager, "report_result", { target_instance: "room", summary: "result", correlation_id: "fake-work" }, "worker", "premature");
  expect(premature.mock.calls[0]?.[0]).toMatchObject({ sent: false, held: true });
  const claimed = outbox.claimNext(outbox.managerBootId, () => "worker-boot", new Set())!;
  expect(claimed.deliveryId).toBeTruthy();
  expect(outbox.begin(claimed.deliveryId, claimed.targetDaemonBootId, claimed.attemptNo)).toBe("begun");
  expect(outbox.markEnterStarted(claimed.deliveryId, claimed.targetDaemonBootId, claimed.attemptNo)).toBe(true);
  expect(outbox.complete(claimed.deliveryId, claimed.targetDaemonBootId, claimed.attemptNo, "delivered")).toBe(true);
  const confirmed = await call(manager, "report_result", { target_instance: "room", summary: "result", correlation_id: "fake-work" }, "worker", "confirmed");
  expect(confirmed.mock.calls[0]?.[1]).toBeUndefined();
  expect(confirmed.mock.calls[0]?.[0]).toMatchObject({ sent: true });
  const forged = await call(manager, "report_result", { target_instance: "peer", summary: "result", correlation_id: "fake-work" }, "worker", "forged");
  expect(forged.mock.calls[0]?.[0]).toMatchObject({ sent: false, held: true });
});
it("rechecks Hub restriction at final handoff and keeps the original source across a restart", async () => {
  const { manager, outbox, setHub } = rig();
  const held = await call(manager, "send_to_instance", { instance_name: "worker", message: "Read public status" });
  const ticket = manager.contactAuthorization(held.mock.calls[0]?.[0].authorization_id, admin);
  manager.decideContactAuthorization(ticket.id, { revision: ticket.revision, decision: "approve-once" }, admin);
  const row = outbox.listPending()[0]!;
  expect((manager as any).contactDeliveryCurrent(row)).toBe(true);
  setHub(true); expect((manager as any).contactDeliveryCurrent(row)).toBe(false);
  setHub(false); manager.getDaemonBootId = (name: string) => `${name}-replacement-boot`;
  expect((manager as any).contactDeliveryCurrent(row)).toBe(true);
  expect(outbox.contactAuthorizations.origin("worker")).toBeUndefined();
  expect(outbox.listPending()).toHaveLength(1);
});
it("matches only an exact standing contact row and consumes its one use without replay", async () => {
  const { manager, outbox } = rig();
  outbox.contactAuthorizations.writePolicy("worker", { revision: 0, grants: [{ id: "", person: member, source: "room", target: "worker",
    verbs: ["send_to_instance"], expiresAt: new Date(Date.now() + 60_000).toISOString(), remainingUses: 1 }] }, admin, name => `${name}-incarnation`);
  const args = { instance_name: "worker", message: "Read public status" };
  expect((await call(manager, "send_to_instance", args)).mock.calls[0]?.[0]).toMatchObject({ sent: true });
  expect((await call(manager, "send_to_instance", args)).mock.calls[0]?.[0]).toMatchObject({ sent: true });
  expect(outbox.listPending()).toHaveLength(1);
  expect(outbox.contactAuthorizations.policy("worker").grants[0]?.remainingUses).toBe(0);
  const next = await call(manager, "send_to_instance", args, "room", "next-operation");
  expect(next.mock.calls[0]?.[0]).toMatchObject({ sent: false, held: true });
});

it("enforces the room tool ceiling at both direct IPC and HTTP sinks", async () => {
  const { manager } = rig();
  manager.fleetConfig!.instances.room = { working_directory: "/tmp/fake-room", tool_set: "full" } as any;
  expect((manager as any).checkToolPermission("ipc-outbound", "room", "create_instance").allowed).toBe(false);
  expect((manager as any).checkToolPermission("ipc-outbound", "room", "reply").allowed).toBe(true);
  await expect(dispatchAgentOperation(manager as any, "room", "spawn", { name: "new-worker" })).rejects.toThrow("room tool allowance");
});
it("requires both a real admin web session and the existing verified authority result", () => {
  const { manager } = rig();
  const sessions = new WebSessionStore();
  const token = "x".repeat(48);
  const issue = (tier: "admin" | "guest") => sessions.create({ tier, surface: "local", label: "Test browser",
    tokenEpoch: tokenEpoch(token), owner: { adapterId: admin.adapterId, userId: admin.userId } }).sessionId;
  Object.defineProperty(manager, "webToken", { value: token, configurable: true });
  Object.assign(manager, { webSessions: sessions,
    webAuthority: vi.fn(() => ({ authority: { kind: "web-verified", actor: { adapter_id: admin.adapterId, user_id: admin.userId } } })) });
  const request = (headers: Record<string, string>) => ({ method: "GET", url: "/ui/api/contact-authorizations", headers: { host: "localhost", ...headers }, socket: { remoteAddress: "127.0.0.1" } }) as any;
  const url = new URL("http://localhost/ui/api/contact-authorizations");
  expect(manager.contactActor(request({ authorization: `Bearer ${token}` }), url)).toBeNull();
  expect(manager.contactActor(request({ cookie: `agend_session=${issue("guest")}` }), url)).toBeNull();
  const req = request({ cookie: `agend_session=${issue("admin")}` });
  expect(manager.contactActor(req, url)).toMatchObject({ userId: admin.userId, adapterId: admin.adapterId });
  (manager as any).webAuthority.mockReturnValue({ authority: { kind: "none" } });
  expect(manager.contactActor(req, url)).toBeNull();
});

it("learns room threads and file identifiers only at the bound native SDK ingress", () => {
  const { manager, outbox } = rig();
  const adapter = { id: "fake-adapter", type: "discord" };
  const native = { adapterId: adapter.id, chatId: "fake-room", threadId: "fake-topic", isBotMessage: false,
    attachments: [{ fileId: "fake-received-file", kind: "document" }] };
  (manager as any).recordClassicContactInput("room", { ...native, adapterId: "other-adapter" }, adapter);
  expect(outbox.contactAuthorizations.roomContext("room").fileIds).toEqual([]);
  (manager as any).recordClassicContactInput("room", native, adapter);
  expect(outbox.contactAuthorizations.roomContext("room", "room-incarnation")).toMatchObject({ threadId: "fake-topic", fileIds: ["fake-received-file"] });
  (manager as any).recordClassicContactInput("room", { ...native, isBotMessage: true, threadId: "peer-topic" }, adapter);
  expect(manager.restrictedClassicRouting("room")?.threadId).toBe("fake-topic");
});

it("does not require an incarnation token to launch or send from a legacy room", async () => {
  const { manager, outbox } = rig();
  (manager.classicChannels!.getAll()[0] as any).restrictedMode = false;
  const token = vi.fn(() => null), setClassicRestriction = vi.fn();
  (manager as any).hubAgentToken = token;
  manager.configureClassicRestriction("room", { setClassicRestriction } as any);
  expect(setClassicRestriction).toHaveBeenCalledWith({ mode: "legacy", roomTools: { publicRead: true, allowedMcpTools: [] } });
  expect((await call(manager, "send_to_instance", { instance_name: "worker", message: "Legacy contact" })).mock.calls[0]?.[0]).toMatchObject({ sent: true });
  expect(outbox.listPending()).toHaveLength(1);
  expect(token).not.toHaveBeenCalled();
});
it.each(["approve-once", "standing-grant"].flatMap(via => ["none", "human", "mixed", "unknown"].map(kind => ({ via, kind }))))(
  "admin-endorsed $via leaves target $kind origin unchanged and retains the source audit", async ({ via, kind }) => {
    const { manager, outbox } = rig(), store = outbox.contactAuthorizations;
    const second = { ...member, userId: "fake-second-member", label: "Second member" };
    store.inheritOrigin("room", { kind: "human", people: [second], receiptIds: ["fake-second-receipt"], chain: ["room"] });
    const source = store.origin("room")!;
    if (kind !== "none") store.inheritOrigin("worker", { kind: kind as "human" | "mixed" | "unknown",
      people: [{ ...member, userId: "fake-target-member", label: "Target member" }, ...(kind === "mixed" ? [{ ...member, userId: "fake-other-target-member", label: "Other target member" }] : [])], receiptIds: ["fake-target-receipt"], chain: ["worker"] });
    const before = store.origin("worker");
    if (via === "standing-grant") store.writePolicy("worker", { revision: 0, grants: source.people.map(person => ({ id: "", person,
      source: "room", target: "worker", verbs: ["delegate_task"], expiresAt: new Date(Date.now() + 60_000).toISOString(), remainingUses: 1 })) }, admin,
      name => `${name}-incarnation`);
    const response = await call(manager, "delegate_task", { target_instance: "worker", task: "Synthetic public-status question" });
    if (via === "approve-once") {
      expect(response.mock.calls[0]?.[0]).toMatchObject({ sent: false, held: true });
      const held = store.list().items[0]!;
      manager.decideContactAuthorization(held.id, { revision: held.revision, decision: "approve-once" }, admin);
    } else expect(response.mock.calls[0]?.[0]).toMatchObject({ sent: true });
    expect(store.origin("worker")).toEqual(before);
    expect(store.origin("room")).toEqual(source);
    expect(store.list().items).toEqual([expect.objectContaining({ state: "approved", origin: source, verb: "delegate_task" })]);
    const rows = outbox.listPending(); expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ content: "Synthetic public-status question", meta: { request_kind: "task" } });
    expect((manager as any).contactDeliveryCurrent(rows[0])).toBe(true);
    if (kind === "none") {
      const next = await call(manager, "send_to_instance", { instance_name: "peer", message: "Synthetic follow-up" }, "worker", "fake-target-follow-up");
      expect(next.mock.calls[0]?.[0]).toMatchObject({ sent: true });
    }
  });
