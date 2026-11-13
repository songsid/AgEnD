import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { nativeHumanOrigin } from "../src/human-delivery-receipts.js";
import { outboundHandlers } from "../src/outbound-handlers.js";

const fixtures: Array<{ root: string; outbox: DeliveryOutbox }> = [];
afterEach(() => {
  for (const { root, outbox } of fixtures.splice(0)) {
    outbox.close();
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** Real store and admission/query methods, with every pump/IPC/platform effect inert. */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "agend-forwards-1756-"));
  const outbox = new DeliveryOutbox(join(root, "outbox.db"), "manager");
  fixtures.push({ root, outbox });
  const names = ["classic", "leader", "worker", "auditor", "outsider"];
  const daemons = new Map(names.map(name => [name, { bootId: `${name}-boot` }]));
  const ctx: any = {
    fleetConfig: { defaults: {}, instances: Object.fromEntries(names.map(name => [name, {}])) },
    daemons, deliveryOutbox: outbox,
    instanceIpcClients: new Map(names.map(name => [name, { connected: true, send: vi.fn(() => true) }])),
    sessionRegistry: new Map(), lifecycle: { daemons, isPaused: () => false },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    adapter: null, classicChannels: null,
    ensureDeliveryOutbox: vi.fn(), scheduleDeliveryOutboxPump: vi.fn(),
    sendCancelButton: vi.fn(), emitSseEvent: vi.fn(),
  };
  ctx.publishTraffic = () => {};   // #1918: the org canvas's traffic; not what these tests are about
  ctx.generalLocationDeliveryHold = FleetManager.prototype.generalLocationDeliveryHold.bind(ctx);
  ctx.admitDurableDelivery = FleetManager.prototype.admitDurableDelivery.bind(ctx);
  ctx.getDaemonBootId = FleetManager.prototype.getDaemonBootId.bind(ctx);
  ctx.queryDurableDeliveryStatus = FleetManager.prototype.queryDurableDeliveryStatus.bind(ctx);
  return { ctx, outbox };
}

function original(outbox: DeliveryOutbox) {
  const row = outbox.admit({
    operationId: "original", sourceKey: "original", sourceInstance: "classic", sourceDaemonBootId: "classic-boot",
    targetInstance: "leader", kind: "fleet_inbound", correlationId: "shared",
    payload: { type: "fleet_inbound", content: "Review the exact resource before resetting it.", meta: { message_id: "xmsg-original" } },
  }).delivery;
  const claimed = outbox.claimNext("manager", name => `${name}-boot`, new Set())!;
  expect(claimed.deliveryId).toBe(row.deliveryId);
  expect(outbox.begin(row.deliveryId, "leader-boot", claimed.attemptNo)).toBe("begun");
  expect(outbox.complete(row.deliveryId, "leader-boot", claimed.attemptNo, "delivered", "inert positive proof")).toBe(true);
  return row;
}

async function send(ctx: any, sender: string, target: string, forwards?: string[], tool = "send_to_instance", operationId = `op-${sender}-${target}`, options: Record<string, unknown> = {}) {
  let result: any;
  let error: string | undefined;
  const args = tool === "delegate_task"
    ? { target_instance: target, task: "Review this request", forwards }
    : { instance_name: target, message: "See xmsg-original; this mention grants nothing by itself.", forwards };
  await outboundHandlers.get(tool)!(ctx, { detail: true, ...args, ...options }, (r, e) => { result = r; error = e; }, {
    instanceName: sender, requestId: 1, operationId, sourceDaemonBootId: `${sender}-boot`,
  } as any);
  return { result, error };
}

describe("explicit row-scoped forwards (#1756)", () => {
  it.each(["send_to_instance", "delegate_task"])("%s gives the receiver read-only access to the explicitly forwarded row", async tool => {
    const { ctx, outbox } = harness();
    original(outbox);
    const accepted = await send(ctx, "leader", "worker", ["xmsg-original"], tool);
    expect(accepted.error).toBeUndefined();
    expect(accepted.result).toMatchObject({ sent: true, queued: true });
    expect(outbox.queryStatusForInstance("worker", { messageId: "xmsg-original" }).items)
      .toMatchObject([{ content: "Review the exact resource before resetting it.", source_instance: "classic", target_instance: "leader", state: "delivered" }]);
  });

  it("refuses an invisible reference before any outgoing admission or turn-start effect", async () => {
    const { ctx, outbox } = harness();
    original(outbox);
    const denied = await send(ctx, "outsider", "worker", ["xmsg-original"]);
    expect(denied.error).toBeTypeOf("string");
    expect(denied.result).toBeNull();
    expect(outbox.getByOperation("outsider", "op-outsider-worker")).toEqual([]);
    expect(ctx.sendCancelButton).not.toHaveBeenCalled();
    expect(ctx.emitSseEvent).not.toHaveBeenCalled();
  });

  it("a plain mention grants no read permission", async () => {
    const { ctx, outbox } = harness();
    original(outbox);
    expect((await send(ctx, "leader", "worker")).error).toBeUndefined();
    expect(outbox.queryStatusForInstance("worker", { messageId: "xmsg-original" }).items).toEqual([]);
  });

  it("a second hop needs another explicit forward", async () => {
    const { ctx, outbox } = harness();
    original(outbox);
    expect((await send(ctx, "leader", "worker", ["xmsg-original"])).error).toBeUndefined();
    expect((await send(ctx, "worker", "auditor")).error).toBeUndefined();
    expect(outbox.queryStatusForInstance("auditor", { messageId: "xmsg-original" }).items).toEqual([]);
    expect((await send(ctx, "worker", "auditor", ["xmsg-original"], "delegate_task", "second-hop")).error).toBeUndefined();
    expect(outbox.queryStatusForInstance("auditor", { messageId: "xmsg-original" }).items)
      .toMatchObject([{ forwarded_by: [{ source_instance: "worker" }], content: "Review the exact resource before resetting it." }]);
  });

  it.each(["queued", "delivering", "submission_started", "retry_wait", "uncertain", "failed", "cancelled"])("%s is not proof of a delivered reference", async state => {
    const { ctx, outbox } = harness();
    const row = original(outbox);
    (outbox as any).db.prepare("UPDATE deliveries SET state=? WHERE delivery_id=?").run(state, row.deliveryId);
    expect((await send(ctx, "leader", "worker", ["xmsg-original"])).error).toBeTypeOf("string");
    expect(outbox.getByOperation("leader", "op-leader-worker")).toEqual([]);
    expect(outbox.queryStatusForInstance("worker", { messageId: "xmsg-original" }).items).toEqual([]);
    expect(ctx.sendCancelButton).not.toHaveBeenCalled();
  });

  it("one bad member rolls back the complete forward set", async () => {
    const { ctx, outbox } = harness();
    original(outbox);
    expect((await send(ctx, "leader", "worker", ["xmsg-original", "xmsg-invisible"])).error).toBeTypeOf("string");
    expect(outbox.getByOperation("leader", "op-leader-worker")).toEqual([]);
    expect(outbox.queryStatusForInstance("worker", { messageId: "xmsg-original" }).items).toEqual([]);
    expect(ctx.sendCancelButton).not.toHaveBeenCalled();
  });

  it("a forwarded row does not grant correlation siblings or cursor anchors", async () => {
    const { ctx, outbox } = harness();
    const first = original(outbox);
    const sibling = outbox.admit({
      operationId: "sibling", sourceKey: "sibling", sourceInstance: "classic", sourceDaemonBootId: "classic-boot",
      targetInstance: "leader", kind: "fleet_inbound", correlationId: "shared",
      payload: { content: "Not shared", meta: { message_id: "xmsg-sibling" } },
    }).delivery;
    expect((await send(ctx, "leader", "worker", ["xmsg-original"])).error).toBeUndefined();
    expect(outbox.queryStatusForInstance("worker", { correlationId: "shared" }).items)
      .toMatchObject([{ delivery_id: first.deliveryId }]);
    expect(outbox.queryStatusForInstance("worker", { messageId: "xmsg-sibling" }).items).toEqual([]);
    expect(outbox.queryStatusForInstance("worker", { correlationId: "shared", cursor: sibling.deliveryId }).items).toEqual([]);
  });

  it("a duplicate retry preserves its original grant without adding another edge", async () => {
    const { ctx, outbox } = harness();
    original(outbox);
    const first = await send(ctx, "leader", "worker", ["xmsg-original"]);
    const again = await send(ctx, "leader", "worker", ["xmsg-original"]);
    expect(again.error).toBeUndefined();
    expect(again.result).toMatchObject({ duplicate: true, delivery_id: first.result.delivery_id });
    expect(outbox.getByOperation("leader", "op-leader-worker")).toHaveLength(1);
    expect((outbox as any).db.prepare("SELECT COUNT(*) AS n FROM delivery_forward_edges").get().n).toBe(1);
    expect((await send(ctx, "leader", "worker", [])).error).toBeTypeOf("string");
    expect(outbox.getByOperation("leader", "op-leader-worker")).toHaveLength(1);
  });

  it("a forwarded operation cannot retry for a different recipient", async () => {
    const { ctx, outbox } = harness(); original(outbox);
    expect((await send(ctx, "leader", "worker", ["xmsg-original"], "send_to_instance", "same-operation")).error).toBeUndefined();
    ctx.sendCancelButton.mockClear(); ctx.emitSseEvent.mockClear();
    expect((await send(ctx, "leader", "auditor", ["xmsg-original"], "send_to_instance", "same-operation")).error).toBeTypeOf("string");
    expect(outbox.getByOperation("leader", "same-operation")).toHaveLength(1);
    expect(outbox.queryStatusForInstance("auditor", { messageId: "xmsg-original" }).items).toEqual([]);
    expect(ctx.sendCancelButton).not.toHaveBeenCalled(); expect(ctx.emitSseEvent).not.toHaveBeenCalled();
  });

  it("an unchanged forwarded steer retry reuses its admitted idle mode after the predecessor clears", async () => {
    const { ctx, outbox } = harness(); original(outbox);
    ctx.fleetConfig.defaults.backend = "codex";
    let pending = true; ctx.hasPendingIdleGatedDelivery = () => pending;
    const first = await send(ctx, "leader", "worker", ["xmsg-original"], "send_to_instance", "steer-operation", { steer: true });
    expect(first.error).toBeUndefined(); expect(first.result.delivery_mode).toBe("idle_queue");
    pending = false;
    const again = await send(ctx, "leader", "worker", ["xmsg-original"], "send_to_instance", "steer-operation", { steer: true });
    expect(again.error).toBeUndefined();
    expect(again.result).toMatchObject({ duplicate: true, delivery_id: first.result.delivery_id, delivery_mode: "idle_queue" });
    expect(outbox.getByOperation("leader", "steer-operation")).toMatchObject([{ kind: "fleet_inbound" }]);
    expect((outbox as any).db.prepare("SELECT COUNT(*) AS n FROM delivery_forward_edges").get().n).toBe(1);
    expect((await send(ctx, "leader", "worker", ["xmsg-original"], "send_to_instance", "steer-operation", { steer: false })).error).toBeTypeOf("string");
  });

  it("a forwarded operation cannot retry for a different session", () => {
    const { outbox } = harness(); original(outbox);
    const input = { operationId: "session-operation", sourceInstance: "leader", sourceDaemonBootId: "leader-boot",
      targetInstance: "worker", targetSession: "session-a", kind: "fleet_inbound", forwards: ["xmsg-original"],
      payload: { content: "same body", meta: { message_id: "xmsg-session" } } };
    outbox.admit({ ...input, sourceKey: "session-a" });
    expect(() => outbox.admit({ ...input, sourceKey: "session-b", targetSession: "session-b" })).toThrow();
    expect(outbox.getByOperation("leader", input.operationId)).toHaveLength(1);
  });

  it("an originally admitted steer mode stays steer even when a later predecessor appears", async () => {
    const { ctx, outbox } = harness(); original(outbox); ctx.fleetConfig.defaults.backend = "codex";
    let pending = false; ctx.hasPendingIdleGatedDelivery = () => pending;
    const first = await send(ctx, "leader", "worker", ["xmsg-original"], "send_to_instance", "first-steer", { steer: true });
    expect(first.result.delivery_mode).toBe("steer"); pending = true;
    const again = await send(ctx, "leader", "worker", ["xmsg-original"], "send_to_instance", "first-steer", { steer: true });
    expect(again.result).toMatchObject({ duplicate: true, delivery_id: first.result.delivery_id, delivery_mode: "steer" });
    expect(again.result.warning).toBeUndefined(); expect(outbox.getByOperation("leader", "first-steer")).toHaveLength(1);
  });

  it("reopening preserves operation pinning even after its notification is pruned", async () => {
    const { ctx, outbox } = harness(); original(outbox);
    const sent = await send(ctx, "leader", "worker", ["xmsg-original"], "send_to_instance", "retained-operation");
    const claimed = outbox.claimNext("manager", name => `${name}-boot`, new Set())!;
    expect(claimed.deliveryId).toBe(sent.result.delivery_id);
    expect(outbox.begin(claimed.deliveryId, "worker-boot", claimed.attemptNo)).toBe("begun");
    expect(outbox.complete(claimed.deliveryId, "worker-boot", claimed.attemptNo, "delivered", "inert proof")).toBe(true);
    (outbox as any).db.prepare("UPDATE deliveries SET finished_at=? WHERE delivery_id=?")
      .run(new Date(Date.now() - 48 * 60 * 60_000).toISOString(), claimed.deliveryId);
    expect((await outbox.prune(1)).pruned).toBe(1);
    const fixture = fixtures.at(-1)!; outbox.close();
    const reopened = new DeliveryOutbox(join(fixture.root, "outbox.db"), "reopen"); fixture.outbox = reopened; ctx.deliveryOutbox = reopened;
    expect((await send(ctx, "leader", "worker", ["xmsg-original"], "send_to_instance", "retained-operation")).error).toBeTypeOf("string");
    expect((await send(ctx, "leader", "auditor", ["xmsg-original"], "send_to_instance", "retained-operation")).error).toBeTypeOf("string");
    expect(reopened.getByOperation("leader", "retained-operation")).toEqual([]);
    expect(reopened.queryStatusForInstance("auditor", { messageId: "xmsg-original" }).items).toEqual([]);
    expect(reopened.queryStatusForInstance("worker", { messageId: "xmsg-original" }).items).toHaveLength(1);
  });

  it("ordinary no-forward broadcasts still admit each recipient under one operation", async () => {
    const { ctx, outbox } = harness(); original(outbox);
    expect((await send(ctx, "leader", "worker", undefined, "send_to_instance", "broadcast")).error).toBeUndefined();
    expect((await send(ctx, "leader", "auditor", undefined, "send_to_instance", "broadcast")).error).toBeUndefined();
    expect(outbox.getByOperation("leader", "broadcast")).toHaveLength(2);
    expect(outbox.queryStatusForInstance("auditor", { messageId: "xmsg-original" }).items).toEqual([]);
  });

  it("database reopen retains the explicit ACL", async () => {
    const { ctx, outbox } = harness();
    original(outbox);
    expect((await send(ctx, "leader", "worker", ["xmsg-original"])).error).toBeUndefined();
    const fixture = fixtures.at(-1)!;
    outbox.close();
    const reopened = new DeliveryOutbox(join(fixture.root, "outbox.db"), "manager-reopen");
    fixture.outbox = reopened;
    expect(reopened.queryStatusForInstance("worker", { messageId: "xmsg-original" }).items)
      .toMatchObject([{ state: "delivered", forwarded_by: [{ source_instance: "leader" }] }]);
    expect(reopened.queryStatusForInstance("outsider", { messageId: "xmsg-original" }).items).toEqual([]);
  });

  it("typed admission persists its own reference set without a metadata mirror", () => {
    const { outbox } = harness(); original(outbox);
    const input = { operationId: "typed", sourceKey: "typed", sourceInstance: "leader", sourceDaemonBootId: "leader-boot",
      targetInstance: "worker", kind: "fleet_inbound", forwards: ["xmsg-original"],
      payload: { type: "fleet_inbound", content: "typed API", meta: { message_id: "xmsg-typed" } } };
    const first = outbox.admit(input);
    expect(first.delivery.payload.meta).toMatchObject({ forwards: JSON.stringify(input.forwards) });
    const second = outbox.admit(input);
    expect(second.inserted).toBe(false); expect(second.delivery.deliveryId).toBe(first.delivery.deliveryId);
    expect(outbox.queryStatusForInstance("worker", { messageId: "xmsg-original" }).items).toHaveLength(1);
    expect((outbox as any).db.prepare("SELECT COUNT(*) AS n FROM delivery_forward_edges").get().n).toBe(1);
  });

  it("pruning the forwarding notification preserves the reference grant; pruning the reference removes it", async () => {
    const { ctx, outbox } = harness();
    const reference = original(outbox);
    const sent = await send(ctx, "leader", "worker", ["xmsg-original"]);
    const claimed = outbox.claimNext("manager", name => `${name}-boot`, new Set())!;
    expect(claimed.deliveryId).toBe(sent.result.delivery_id);
    expect(outbox.begin(claimed.deliveryId, "worker-boot", claimed.attemptNo)).toBe("begun");
    expect(outbox.complete(claimed.deliveryId, "worker-boot", claimed.attemptNo, "delivered", "inert proof")).toBe(true);
    const age = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
    (outbox as any).db.prepare("UPDATE deliveries SET finished_at=? WHERE delivery_id=?").run(age, claimed.deliveryId);
    expect((await outbox.prune(1)).pruned).toBe(1);
    expect(outbox.get(claimed.deliveryId)).toBeUndefined();
    expect(outbox.queryStatusForInstance("worker", { messageId: "xmsg-original" }).items).toHaveLength(1);
    (outbox as any).db.prepare("UPDATE deliveries SET finished_at=? WHERE delivery_id=?").run(age, reference.deliveryId);
    expect((await outbox.prune(1)).pruned).toBe(1);
    expect(outbox.queryStatusForInstance("worker", { messageId: "xmsg-original" }).items).toEqual([]);
    expect((outbox as any).db.prepare("SELECT COUNT(*) AS n FROM delivery_forward_edges").get().n).toBe(0);
  });

  it.each([
    ["xmsg-original", "xmsg-original"], [""], ["xmsg-\nheader"], ["x".repeat(257)],
    Array.from({ length: 17 }, (_, i) => `xmsg-${i}`),
  ])("malformed/beyond-bound IDs refuse before effects (%j)", async (...ids) => {
    const { ctx, outbox } = harness();
    original(outbox);
    expect((await send(ctx, "leader", "worker", ids)).error).toBeTypeOf("string");
    expect(outbox.getByOperation("leader", "op-leader-worker")).toEqual([]);
    expect(ctx.sendCancelButton).not.toHaveBeenCalled();
  });
});


describe("pending forwarded receipts (#3578)", () => {
  const pending = "Could not accept the message for delivery: Forwarded message verification is pending delivery confirmation; check delivery_status and retry this forward after it is delivered. Do not resend the original message.";
  const unavailable = "Could not accept the message for delivery: Forwarded message verification is unavailable";
  function human(outbox: DeliveryOutbox) {
    const row = outbox.createHumanReceipt({ targetInstance: "leader", originalBody: "Approve only this resource", inputKind: "fleet_inbound",
      managerBootId: "manager", origin: nativeHumanOrigin("discord", "mock-bot", "mock-human", "Test person", false, "mock-platform-message")! });
    const bound = outbox.bindHumanReceipt(row.receipt_id, "leader", "owner", "wire", "manager");
    const delivered = () => expect(outbox.settleHumanReceipt(row.receipt_id, "leader", "owner", {
      receipt_id: row.receipt_id, verification_id: row.message_id, wire_sha256: bound.wire_sha256, owner_key: "owner", mode: "idle_submit", tag: "unique-id-pane",
    }, "owner")).toBe(true);
    return { id: row.message_id, delivered };
  }
  it.each(["send_to_instance", "delegate_task"])("%s refuses an owned queued human reference with pending guidance, then admits the same forward only after positive delivery", async tool => {
    const {ctx,outbox}=harness(), receipt=human(outbox);
    const first=await send(ctx,"leader","worker",[receipt.id],tool,"pending-human");
    expect(first).toEqual({result:null,error:pending});
    expect(outbox.getByOperation("leader","pending-human")).toEqual([]);
    expect(outbox.queryStatusForInstance("worker",{messageId:receipt.id}).items).toEqual([]);
    expect(ctx.scheduleDeliveryOutboxPump).not.toHaveBeenCalled(); expect(ctx.sendCancelButton).not.toHaveBeenCalled(); expect(ctx.emitSseEvent).not.toHaveBeenCalled();
    receipt.delivered();
    const next=await send(ctx,"leader","worker",[receipt.id],tool,"pending-human");
    expect(next.error).toBeUndefined();expect(next.result.sent).toBe(true);
    expect(outbox.getByOperation("leader","pending-human")).toHaveLength(1);
    expect(outbox.queryStatusForInstance("worker",{messageId:receipt.id}).items).toMatchObject([{state:"delivered"}]);
    expect((await send(ctx,"leader","worker",[receipt.id],tool,"pending-human")).result.duplicate).toBe(true);
    expect(outbox.getByOperation("leader","pending-human")).toHaveLength(1);
  });
  it.each(["queued", "delivering", "submission_started", "retry_wait", "reconciliation_pending"])("an owned %s delivery is pending, never forwardable", async state => {
    const {ctx,outbox}=harness(),row=original(outbox);
    (outbox as any).db.prepare("UPDATE deliveries SET state=? WHERE delivery_id=?").run(state === "reconciliation_pending" ? "submission_started" : state,row.deliveryId);
    if(state === "reconciliation_pending") (outbox as any).db.prepare("UPDATE deliveries SET reconciliation_pending=1 WHERE delivery_id=?").run(row.deliveryId);
    expect((await send(ctx,"leader","worker",["xmsg-original"])).error).toBe(pending);
    expect(outbox.getByOperation("leader","op-leader-worker")).toEqual([]);
    expect(outbox.queryStatusForInstance("worker",{messageId:"xmsg-original"}).items).toEqual([]);
  });
  it.each(["queued","delivered","uncertain"])("hidden %s human receipts reveal no pending/existence distinction", async state=>{
    const {ctx,outbox}=harness(),receipt=human(outbox);
    if(state==="delivered")receipt.delivered();else if(state==="uncertain")outbox.markHumanReceiptUncertain(receipt.id.slice(5),"leader");
    expect((await send(ctx,"outsider","worker",[receipt.id])).error).toBe(unavailable);
    expect((await send(ctx,"outsider","worker",["hmsg-missing"])).error).toBe(unavailable);
    if(state==="uncertain")expect((await send(ctx,"leader","worker",[receipt.id])).error).toBe(unavailable);
  });
  it.each(["queued","delivered","uncertain","failed","cancelled"])("hidden %s normal references reveal no pending/existence distinction", async state=>{
    const {ctx,outbox}=harness(),row=original(outbox);
    (outbox as any).db.prepare("UPDATE deliveries SET state=? WHERE delivery_id=?").run(state === "reconciliation_pending" ? "submission_started" : state,row.deliveryId);
    if(state === "reconciliation_pending") (outbox as any).db.prepare("UPDATE deliveries SET reconciliation_pending=1 WHERE delivery_id=?").run(row.deliveryId);
    expect((await send(ctx,"outsider","worker",["xmsg-original"])).error).toBe(unavailable);
    expect((await send(ctx,"outsider","worker",["xmsg-missing"])).error).toBe(unavailable);
    if(["uncertain","failed","cancelled"].includes(state))expect((await send(ctx,"leader","worker",["xmsg-original"])).error).toBe(unavailable);
  });
  it("a mixed delivered/pending list admits no delivery or partial grant",async()=>{
    const {ctx,outbox}=harness();original(outbox);const receipt=human(outbox);
    expect((await send(ctx,"leader","worker",["xmsg-original",receipt.id])).error).toBe(pending);
    expect(outbox.getByOperation("leader","op-leader-worker")).toEqual([]);
    expect(outbox.queryStatusForInstance("worker",{messageId:"xmsg-original"}).items).toEqual([]);
    expect(outbox.queryStatusForInstance("worker",{messageId:receipt.id}).items).toEqual([]);
  });
  it("ambiguous visible references remain unavailable rather than exposing one queued duplicate",async()=>{
    const {ctx,outbox}=harness();original(outbox);
    outbox.admit({operationId:"duplicate-id",sourceKey:"duplicate-id",sourceInstance:"classic",sourceDaemonBootId:"classic-boot",targetInstance:"leader",kind:"fleet_inbound",payload:{content:"another message",meta:{message_id:"xmsg-original"}}});
    expect((await send(ctx,"leader","worker",["xmsg-original"])).error).toBe(unavailable);
    expect(outbox.getByOperation("leader","op-leader-worker")).toEqual([]);
    expect(outbox.queryStatusForInstance("worker",{messageId:"xmsg-original"}).items).toEqual([]);
  });

});
