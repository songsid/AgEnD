// M-3770 slice 2.5 (S-252, 2.2 fleet-side hand-back; design rev 15, Fable #4536 design): the restarted old fleet's
// hand-back ports — the pump owns a handed-back row again, a held copy goes in as its own kind with every receipt field
// stripped (the old fleet's receipt can't be re-bound: it is marked uncertain), a gone target is refused — and the copy's
// replay reaches the daemon as a person's plain, unverifiable turn: no from_instance, no hid, no web:v.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { formatHumanInboundMessage } from "../src/human-delivery-receipts.js";
import { ackGeneration, advance, listHandback, newAttemptId, openAttempt, planGeneration, readCurrent, substep, writeInboxItem, type AttemptRecord } from "../src/update-journal.js";
import { UPDATE_HANDBACK_COPY_KIND, UPDATE_HANDBACK_SOURCE, stripHumanReceipt, type HandbackPorts } from "../src/update-quiescence.js";

const dirs: string[] = [], outboxes: DeliveryOutbox[] = [];
afterEach(() => { for (const o of outboxes.splice(0)) o.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A held web turn as the old fleet journaled it: bound to that fleet's receipt (its hid, web:v, preparation token). */
const heldMeta = (receiptId: string) => ({
  source: "web", user: "Ada", user_id: "u-1", chat_id: "web-chat", message_id: "m-7", thread_id: "t-3",
  human_receipt_id: receiptId, verification_id: "hmsg-old", web_verified: "1", human_prepare_token: "tok-old",
  human_owner_key: "owner-old", human_some_future_field: "stale",
});

function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "handback-fleet-")); dirs.push(dir);
  const outbox = new DeliveryOutbox(join(dir, "delivery-outbox.db"), "mgr-old"); outboxes.push(outbox);
  const fm = Object.create(FleetManager.prototype) as any;
  const pump = vi.fn(), runDeferredOccurrence = vi.fn(), recordInterruptedOccurrence = vi.fn();
  Object.assign(fm, {
    dataDir: dir, deliveryOutbox: outbox, managerBootId: "mgr-new", fleetConfig: { instances: { worker: {} } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, scheduleDeliveryOutboxPump: pump,
    scheduler: { runDeferredOccurrence, recordInterruptedOccurrence },
  });
  return { dir, outbox, fm, ports: fm.updateHandbackPorts() as HandbackPorts, pump, runDeferredOccurrence, recordInterruptedOccurrence };
}

describe("M-3770 2.5: the fleet's hand-back ports", () => {
  it("stripHumanReceipt drops every human_* key (a future one too), the hid and web:v; keeps where to answer", () => {
    const { meta, receiptId } = stripHumanReceipt(heldMeta("r-1"));
    expect(receiptId).toBe("r-1");
    expect(Object.keys(meta).filter(k => k.startsWith("human_"))).toEqual([]);
    expect(meta).toEqual({ source: "web", user: "Ada", user_id: "u-1", chat_id: "web-chat", message_id: "m-7", thread_id: "t-3" });
    expect(meta).not.toHaveProperty("from_instance");
  });

  it("the replayed turn the daemon formats is a plain [user:…]: no hid, no verified tag — what the go-ahead rules treat as non-authoritative", () => {
    const bound = heldMeta("r-1") as unknown as Record<string, string>;
    const replay = stripHumanReceipt(heldMeta("r-1")).meta as Record<string, string>;
    for (const dialect of ["legacy", "compact"] as const) {
      const before = formatHumanInboundMessage("please ship it", bound, "mcp", { dialect });
      const after = formatHumanInboundMessage("please ship it", replay, "mcp", { dialect });
      expect(before, dialect).toMatch(/verified|:v/);                                               // what the held wire claimed
      expect(after, dialect).toMatch(/\[user:Ada/);
      expect(after, dialect).not.toMatch(/hid|hmsg|verified|:v\b|web:v/);
    }
  });

  it("admitCopy: its own kind and source, receipt fields stripped, the old receipt marked uncertain, idempotent; a gone target is refused", () => {
    const { outbox, ports } = fleet();
    const receipt = outbox.createHumanReceipt({ targetInstance: "worker", originalBody: "please ship it", inputKind: "fleet_inbound", managerBootId: "mgr-old",
      origin: { platform: "web", adapter_id: null, user_id: null, username: null, platform_message_id: null, ingress: "web" } });
    const body = { type: "user_message", content: "please ship it", meta: heldMeta(receipt.receipt_id) };
    const key = "update-handback:20261126T150000Z-feedf00d:000000000001";
    const first = ports.admitCopy(key, body, "worker")!;
    const row = outbox.get(first.deliveryId)!;
    expect(row).toMatchObject({ kind: UPDATE_HANDBACK_COPY_KIND, sourceInstance: UPDATE_HANDBACK_SOURCE, targetInstance: "worker", state: "queued" });
    expect(Object.keys(row.payload.meta as object).filter(k => k.startsWith("human_") || k === "verification_id" || k === "web_verified" || k === "from_instance")).toEqual([]);
    expect(row.payload.meta).toMatchObject({ chat_id: "web-chat", message_id: "m-7", thread_id: "t-3", source: "web" });
    expect(outbox.getHumanReceipt(receipt.receipt_id)?.state).toBe("uncertain");
    expect(ports.admitCopy(key, body, "worker")).toEqual(first);                                    // a replay: the same row
    expect(ports.admitCopy("update-handback:x:000000000002", body, "removed")).toBeNull();
  });

  it("claim: a queued or backed-off row is the pump's again (kicked, nothing claimed); a settled one is settled; a missing one missing", () => {
    const { outbox, ports, pump } = fleet();
    const admitted = outbox.admit({ operationId: "op-1", sourceKey: "k-1", sourceInstance: "peer", sourceDaemonBootId: "b", targetInstance: "worker",
      kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "held", meta: {} } }).delivery;
    expect(ports.lookup(admitted.deliveryId)).toEqual({ state: "queued", target: "worker" });
    expect(ports.claim(admitted.deliveryId)).toBe("claimed");
    expect(outbox.get(admitted.deliveryId)?.state).toBe("queued");                                  // still the pump's to claim
    expect(pump).toHaveBeenCalledTimes(1);
    expect(ports.claim("no-such-row")).toBe("missing");
    expect(ports.lookup("no-such-row")).toBeNull();
    outbox.claimExact(admitted.deliveryId, "mgr-new", "boot-1");
    expect(ports.claim(admitted.deliveryId)).toBe("settled");
  });

  it("a replayed copy that fails (here: its TTL) queues no outcome notice — its source isn't an agent; a peer's row still does", () => {
    const { outbox } = fleet();
    outbox.admit({ operationId: "k", sourceKey: "k", sourceInstance: UPDATE_HANDBACK_SOURCE, sourceDaemonBootId: "mgr-new", targetInstance: "worker",
      kind: UPDATE_HANDBACK_COPY_KIND, payload: { type: "user_message", content: "held", meta: { source: "web" } } });
    outbox.admit({ operationId: "p", sourceKey: "p", sourceInstance: "peer", sourceDaemonBootId: "b", targetInstance: "worker",
      kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "from a peer", meta: {} } });
    expect(outbox.expireStale(Date.now() + 365 * 24 * 60 * 60 * 1000)).toBe(2);
    expect(outbox.listPending().filter(d => d.kind === "delivery_outcome_notice").map(d => d.targetInstance)).toEqual(["peer"]);
  });

  it("deferred jobs go to the scheduler with the fleet's own instance check", () => {
    const { ports, runDeferredOccurrence, recordInterruptedOccurrence } = fleet();
    ports.runDeferred({ scheduleId: "s-1", runId: "r-1" });
    ports.recordInterrupted({ scheduleId: "s-2", runId: "r-2" });
    expect(runDeferredOccurrence).toHaveBeenCalledWith("s-1", "r-1", expect.any(Function));
    const exists = runDeferredOccurrence.mock.calls[0]![2] as (n: string) => boolean;
    expect([exists("worker"), exists("removed")]).toEqual([true, false]);
    expect(recordInterruptedOccurrence).toHaveBeenCalledWith("s-2", "r-2");
  });

  it("the copy's dispatch hands the journaled turn over as it was: the fence's delivery id and attempt added, never a from_instance", async () => {
    const { outbox, fm } = fleet();
    const admitted = outbox.admit({ operationId: "k", sourceKey: "k", sourceInstance: UPDATE_HANDBACK_SOURCE, sourceDaemonBootId: "mgr-new", targetInstance: "worker",
      kind: UPDATE_HANDBACK_COPY_KIND, payload: { type: "user_message", content: "please ship it", meta: stripHumanReceipt(heldMeta("r")).meta } }).delivery;
    const claimed = outbox.claimExact(admitted.deliveryId, "mgr-new", "boot-1") === "claimed" ? { ...outbox.get(admitted.deliveryId)!, targetDaemonBootId: "boot-1" } : null;
    const delivered: Record<string, unknown>[] = [];
    Object.assign(fm, {
      waitForDurableLaneRelease: () => Promise.resolve(), deliveryWorkerMode: () => "off",
      deliverToInstance: vi.fn(async (_t: string, p: Record<string, unknown>) => { delivered.push(p); return true; }),
    });
    await fm.dispatchDurableDelivery(claimed);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ type: "user_message", content: "please ship it",
      meta: { source: "web", chat_id: "web-chat", message_id: "m-7", delivery_id: admitted.deliveryId, delivery_attempt: "1" } });
    expect(delivered[0]!.meta).not.toHaveProperty("from_instance");
  });

  it("the start walk: waits (bounded) for restart-old, then admits the held copy before returning — the 10 s re-walk only after", async () => {
    const { dir, outbox, fm } = fleet();
    const NONCE = "d".repeat(32), ID = newAttemptId(new Date("2026-11-26T16:00:00Z"), "0badcafe");
    const opened = openAttempt(dir, { id: ID, kind: "update", updater: { pid: 244, start: { processStart: "x" } },
      from: { name: "@songsid/agend", version: "2.4.0", integrity: null }, to: { name: "@songsid/agend", version: "2.4.1", integrity: null } });
    if (!opened.ok) throw new Error(opened.reason);
    writeInboxItem(dir, ID, 1, "web", { kind: "copy", target: "worker", body: { type: "user_message", content: "during the update", meta: heldMeta("r-9") } });
    let a: AttemptRecord = advance(dir, opened.attempt, "abandoning", { note: "test" });
    a = planGeneration(dir, a, "old", NONCE);
    a = ackGeneration(dir, a, NONCE, process.pid);                                                   // this process took over as old
    let sleeps = 0;
    // The abandon driver journals restart-old while the start waits.
    const sleep = async () => { sleeps += 1; if (sleeps === 2) a = substep(dir, a, "restart-old"); };
    await fm.startUpdateHandback(NONCE, 60_000, sleep);
    try {
      expect(sleeps).toBe(2);
      expect(listHandback(dir, ID).map(e => e.acked)).toEqual([true]);
      const copies = outbox.listPending().filter(d => d.kind === UPDATE_HANDBACK_COPY_KIND);
      expect(copies.map(d => [d.targetInstance, d.payload.content])).toEqual([["worker", "during the update"]]);
      expect(fm.updateHandbackTimer).toBeTruthy();                                                      // stragglers: the re-walk
    } finally { clearTimeout(fm.updateHandbackTimer); }
  });

  it("the start walk does nothing for a start without a handoff nonce, or one that isn't this attempt's old generation", async () => {
    const { dir, fm } = fleet();
    const ID = newAttemptId(new Date("2026-11-26T16:00:00Z"), "0badcafe");
    const opened = openAttempt(dir, { id: ID, kind: "update", updater: { pid: 244, start: { processStart: "x" } },
      from: { name: "@songsid/agend", version: "2.4.0", integrity: null }, to: { name: "@songsid/agend", version: "2.4.1", integrity: null } });
    if (!opened.ok) throw new Error(opened.reason);
    let a = advance(dir, opened.attempt, "abandoning", { note: "test" });
    a = ackGeneration(dir, planGeneration(dir, a, "old", "d".repeat(32)), "d".repeat(32), process.pid);
    substep(dir, a, "restart-old");
    const sleep = vi.fn(async () => {});
    await fm.startUpdateHandback("", 60_000, sleep);
    await fm.startUpdateHandback("e".repeat(32), 60_000, sleep);
    expect(sleep).not.toHaveBeenCalled();
    expect(fm.updateHandbackTimer ?? null).toBeNull();
    expect(readCurrent(dir).state).toBe("open");
  });

  it("the fleet start runs the first walk before any ingress opens: the web chat, the agents and the shared adapter all come after (Fable #4541 F1)", () => {
    // Source-order pin of design 3b: moving the call below any of these would let a held copy land behind newer messages.
    const src = (FleetManager.prototype as unknown as Record<string, { toString(): string }>)["startAllWithinDeadline"]!.toString();
    const at = (needle: string) => { const i = src.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    const walk = at("await this.startUpdateHandback()");
    expect(src.split("this.startUpdateHandback(").length - 1).toBe(1);                              // one call, this one
    for (const ingress of ["this.startHealthServer(", "this.startInstance(", "this.startSharedAdapter("]) expect(walk, ingress).toBeLessThan(at(ingress));
  });
});
