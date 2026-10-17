/**
 * #1918 phase 1: cross-instance traffic for the org canvas, from what the delivery outbox already records.
 * - trafficItem: messages between instances only (send_to_instance's family, broadcast), never fleet notices; the kind
 *   from request_kind; the state from the row; an opaque id; no part for an instance whose visibility is "hidden".
 * - TrafficLog: news only on a change; a finished item never goes back; finished items leave after two minutes; capped.
 * - The outbox emits "consumed" on the ordinary consumed mark (it changes no state).
 * - FleetManager: admission, each state event and the consumed mark become SSE "traffic" items; GET /ui/traffic's
 *   snapshot is the pending rows plus the recent finished ones, bounded, visibility as of now, worked out at most once
 *   every two seconds. No probe: only the outbox's own events and one indexed read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryOutbox, type OutboxDelivery } from "../src/delivery-outbox.js";
import { TrafficLog, trafficId, trafficItem, TRAFFIC_RECENT_MS, TRAFFIC_SNAPSHOT_MAX, type TrafficItem } from "../src/fleet-traffic.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { handleWebRequest } from "../src/web-api.js";
import { EventEmitter } from "node:events";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); vi.restoreAllMocks(); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-1918-")); roots.push(d); return d; };
const AT = "2026-10-17T10:00:00.000Z";
const row = (o: Partial<OutboxDelivery> = {}): OutboxDelivery => ({
  deliveryId: "d-1", operationId: "op", sourceKey: "k", sourceInstance: "atlas", sourceDaemonBootId: "b", targetInstance: "quill", targetSession: null,
  targetDaemonBootId: null, kind: "fleet_inbound", correlationId: null, payload: { type: "fleet_inbound", content: "x", meta: { request_kind: "task" } },
  state: "queued", attemptNo: 0, createdSeq: 1, managerBootId: null, responseDeliveredAt: null, nextAttemptAt: null, lastError: null, reconciliationPending: false, ...o,
});
const item = (id: string, state: TrafficItem["state"], o: Partial<TrafficItem> = {}): TrafficItem => ({ id, from: "a", to: "b", kind: "send", state, at: AT, ...o });

describe("trafficItem", () => {
  it("send_to_instance's family by request_kind; broadcast; steer is a send", () => {
    const kinds = ["task", "report", "query", "update", "other", undefined].map((k) => trafficItem(row({ payload: { meta: k === undefined ? {} : { request_kind: k } } }), null, AT)!.kind);
    expect(kinds).toEqual(["task", "report", "query", "update", "send", "send"]);
    expect(trafficItem(row({ kind: "broadcast" }), null, AT)!.kind).toBe("broadcast");
    // One broadcast is a row per recipient: they share an opaque op (never the operation id); no other kind has one.
    const b1 = trafficItem(row({ kind: "broadcast", operationId: "op-secret", deliveryId: "d-1" }), null, AT)!, b2 = trafficItem(row({ kind: "broadcast", operationId: "op-secret", deliveryId: "d-2", targetInstance: "sage" }), null, AT)!;
    expect([b1.op, b1.op === b2.op, b1.id === b2.id, JSON.stringify(b1).includes("op-secret")]).toEqual([expect.stringMatching(/^[0-9a-f]{16}$/), true, false, false]);
    expect(trafficItem(row({ kind: "broadcast", operationId: "op-other" }), null, AT)!.op).not.toBe(b1.op);
    expect("op" in trafficItem(row(), null, AT)!).toBe(false);
    expect(trafficItem(row({ kind: "steer", payload: { meta: {} } }), null, AT)!.kind).toBe("send");
  });
  it("fleet notices, self-sends and unknown states are not traffic", () => {
    for (const kind of ["system_notice", "reply_obligation_notice", "delivery_outcome_notice", "post_restart_outcome_notice"]) expect(trafficItem(row({ kind }), null, AT), kind).toBeNull();
    expect(trafficItem(row({ targetInstance: "atlas" }), null, AT)).toBeNull();
    expect(trafficItem(row(), null, AT, "nonsense" as never)).toBeNull();
  });
  it("states: the row's own, a given one, consumed; reconciliation counts as delivering", () => {
    const st = (o: Partial<OutboxDelivery>, s?: never) => trafficItem(row(o), null, AT, s)!.state;
    expect([st({ state: "queued" }), st({ state: "retry_wait" }), st({ state: "delivering" }), st({ state: "submission_started" }), st({ state: "delivered" }),
      st({ state: "failed" }), st({ state: "uncertain" }), st({ state: "cancelled" }), st({ state: "queued", reconciliationPending: true })])
      .toEqual(["queued", "queued", "delivering", "delivering", "delivered", "failed", "uncertain", "cancelled", "delivering"]);
    expect(trafficItem(row(), null, AT, "consumed")!.state).toBe("consumed");
  });
  it("an opaque id, never the delivery id; the two names and the time; no text", () => {
    const it = trafficItem(row({ deliveryId: "dlv-secret-1" }), null, AT)!;
    expect(it).toEqual({ id: trafficId("dlv-secret-1"), from: "atlas", to: "quill", kind: "task", state: "queued", at: AT });
    expect(it.id).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(it)).not.toContain("dlv-secret-1");
  });
  it("an instance whose cross_instance_visibility is hidden takes no part, from either side; summary and full show", () => {
    const fleet = (vis: Record<string, string>, def?: string) => ({ defaults: def ? { cross_instance_visibility: def } : {}, instances: Object.fromEntries(Object.entries(vis).map(([n, v]) => [n, { cross_instance_visibility: v }])) }) as never;
    expect(trafficItem(row(), fleet({ atlas: "hidden" }), AT)).toBeNull();
    expect(trafficItem(row(), fleet({ quill: "hidden" }), AT)).toBeNull();
    expect(trafficItem(row(), fleet({}, "hidden"), AT)).toBeNull();
    expect(trafficItem(row(), fleet({ atlas: "summary", quill: "full" }), AT)).not.toBeNull();
  });
});

describe("TrafficLog", () => {
  it("news only on a change; a finished item never goes back; consumed is the end", () => {
    const log = new TrafficLog(() => 0);
    expect(log.note(item("x", "queued"))).not.toBeNull();
    expect(log.note(item("x", "queued")), "the same state again").toBeNull();
    expect(log.note(item("x", "delivering"))).not.toBeNull();
    expect(log.note(item("x", "delivered"))).not.toBeNull();
    expect(log.note(item("x", "delivering")), "late, out of order").toBeNull();
    expect(log.note(item("x", "consumed"))).not.toBeNull();
    expect(log.note(item("x", "failed")), "after consumed").toBeNull();
  });
  it("snapshot: the pending rows first, then recent finished ones; finished leave after two minutes; capped", () => {
    let mono = 0;
    const log = new TrafficLog(() => mono);
    log.note(item("done-1", "delivered")); log.note(item("moving", "delivering"));
    const pending = [item("p-1", "queued"), item("moving", "delivering")];
    expect(log.snapshot(pending).map((i) => i.id)).toEqual(["p-1", "moving", "done-1"]);
    mono = TRAFFIC_RECENT_MS + 1;
    expect(log.snapshot([]).map((i) => i.id), "finished, two minutes on: gone; in flight shows only as the outbox says").toEqual([]);
    for (let i = 0; i < TRAFFIC_SNAPSHOT_MAX + 50; i++) log.note(item(`f-${i}`, "delivered"));
    const snap = log.snapshot([]);
    expect([snap.length, snap.at(-1)!.id]).toEqual([TRAFFIC_SNAPSHOT_MAX, `f-${TRAFFIC_SNAPSHOT_MAX + 49}`]);
  });
});

describe("the outbox's consumed event", () => {
  it("the ordinary consumed mark emits \"consumed\" (no state changes); an already-consumed one does not", () => {
    const outbox = new DeliveryOutbox(join(scratch(), "outbox.db"), "manager-1");
    const r = outbox.admit({ operationId: "op-1918", sourceKey: "s:op-1918", sourceInstance: "atlas", sourceDaemonBootId: "sb", targetInstance: "quill", kind: "fleet_inbound",
      correlationId: "cid", payload: { type: "fleet_inbound", content: "work", meta: { request_kind: "task" } } }).delivery;
    const c = outbox.claimNext("manager-1", () => "boot-1", new Set())!;
    outbox.begin(r.deliveryId, "boot-1", c.attemptNo, { backend: "claude-code", backendVersion: null, windowId: "@w", transcriptPath: "/t", transcriptOffset: 0, transcriptSessionId: "/t", submissionMode: "native_queue_handoff" });
    outbox.complete(r.deliveryId, "boot-1", c.attemptNo, "delivered", "proof");
    const events: unknown[] = []; outbox.on("consumed", (e) => events.push(e));
    expect(outbox.markConsumed(r.deliveryId, "boot-1", c.attemptNo, "turn", "e")).toBe("marked");
    expect(outbox.markConsumed(r.deliveryId, "boot-1", c.attemptNo, "turn", "e")).toBe("already");
    expect(events).toEqual([{ deliveryId: r.deliveryId }]);
    outbox.close();
  });
});

describe("FleetManager: SSE traffic and GET /ui/traffic", () => {
  async function fleet() {
    const dir = scratch();
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm: any = new FleetManager(dir);
    const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
    fm.fleetConfig = { defaults: {}, instances: { atlas: {}, quill: {}, sage: {}, shy: { cross_instance_visibility: "hidden" } } };
    fm.scheduleDeliveryOutboxPump = () => {};                                   // nothing else claims the rows
    fm.createWakeCoordinator = () => ({ start() {}, stop() {}, kick() {}, noteDelivered() {} });
    fm.ensureDeliveryOutbox();
    const sse: Array<[string, any]> = [];
    fm.emitSseEvent = (type: string, data: unknown) => sse.push([type, data]);
    for (const [n, b] of [["atlas", "atlas-boot"], ["sage", "sage-boot"], ["shy", "shy-boot"]]) fm.daemons.set(n, { bootId: b });
    const close = () => { clearInterval(fm.replyObligationTimer); fm.deliveryOutbox.close(); };
    return { fm, sse, close };
  }
  const admit = (fm: any, from: string, to: string, kind = "fleet_inbound", requestKind = "task", op = `${from}-${to}`) => fm.admitDurableDelivery({
    operationId: op, sourceInstance: from, targetInstance: to, kind, correlationId: `cid-${op}`, payload: { type: kind, content: "c", meta: { request_kind: requestKind } } });
  it("admission, delivery steps and the consumed mark each send one traffic item; a notice and a hidden instance send none", async () => {
    const { fm, sse, close } = await fleet();
    try {
      const a = admit(fm, "atlas", "quill");
      const outbox = fm.deliveryOutbox as DeliveryOutbox;
      const c = outbox.claimNext("manager", () => "boot-q", new Set())!;
      outbox.begin(a.deliveryId, "boot-q", c.attemptNo, { backend: "claude-code", backendVersion: null, windowId: "@w", transcriptPath: "/t", transcriptOffset: 0, transcriptSessionId: "/t", submissionMode: "native_queue_handoff" });
      outbox.complete(a.deliveryId, "boot-q", c.attemptNo, "delivered", "proof");
      outbox.markConsumed(a.deliveryId, "boot-q", c.attemptNo, "turn", "e");
      admit(fm, "shy", "quill");                                                 // hidden: never shown
      admit(fm, "atlas", "quill", "system_notice", "x", "op-notice");            // a fleet notice: not traffic
      const traffic = sse.filter(([t]) => t === "traffic").map(([, d]) => [d.from, d.to, d.kind, d.state]);
      expect(traffic).toEqual([["atlas", "quill", "task", "queued"], ["atlas", "quill", "task", "delivering"], ["atlas", "quill", "task", "delivered"], ["atlas", "quill", "task", "consumed"]]);
      expect(sse.filter(([t]) => t === "traffic").every(([, d]) => d.id === trafficId(a.deliveryId))).toBe(true);
    } finally { close(); }
  });
  it("the snapshot: pending rows and recent finished ones, visibility as of now, worked out at most once every two seconds", async () => {
    const { fm, close } = await fleet();
    try {
      admit(fm, "atlas", "quill", "fleet_inbound", "task", "op-1");
      admit(fm, "sage", "atlas", "fleet_inbound", "report", "op-2");
      const listPending = vi.spyOn(fm.deliveryOutbox, "listPending");
      const s1 = fm.trafficSnapshot();
      expect(s1.items.map((i: TrafficItem) => [i.from, i.to, i.kind, i.state])).toEqual([["atlas", "quill", "task", "queued"], ["sage", "atlas", "report", "queued"]]);
      expect(fm.trafficSnapshot(), "the same answer within two seconds").toBe(s1);
      expect(listPending).toHaveBeenCalledTimes(1);
      admit(fm, "atlas", "sage", "broadcast", "x", "op-3");                         // news: the memo is dropped
      expect(fm.trafficSnapshot().items.map((i: TrafficItem) => i.kind)).toEqual(["task", "report", "broadcast"]);
      fm.fleetConfig.instances.sage = { cross_instance_visibility: "hidden" };    // hidden since: gone at once (with any news)
      admit(fm, "atlas", "quill", "fleet_inbound", "query", "op-4");
      expect(fm.trafficSnapshot().items.map((i: TrafficItem) => [i.from, i.to])).toEqual([["atlas", "quill"], ["atlas", "quill"]]);
    } finally { close(); }
  });
  it("a finished item kept for the snapshot leaves it once one of its instances is hidden", async () => {
    const { fm, close } = await fleet();
    try {
      const a = admit(fm, "atlas", "quill");
      const outbox = fm.deliveryOutbox as DeliveryOutbox;
      const c = outbox.claimNext("manager", () => "boot-q", new Set())!;
      outbox.begin(a.deliveryId, "boot-q", c.attemptNo, { backend: "claude-code", backendVersion: null, windowId: "@w", transcriptPath: "/t", transcriptOffset: 0, transcriptSessionId: "/t", submissionMode: "native_queue_handoff" });
      outbox.complete(a.deliveryId, "boot-q", c.attemptNo, "delivered", "proof");
      expect(fm.trafficSnapshot().items.map((i: TrafficItem) => [i.to, i.state])).toEqual([["quill", "delivered"]]);
      fm.fleetConfig.instances.quill = { cross_instance_visibility: "hidden" };
      admit(fm, "atlas", "sage", "fleet_inbound", "task", "op-news");            // news: the memo is dropped
      expect(fm.trafficSnapshot().items.map((i: TrafficItem) => [i.to, i.state])).toEqual([["sage", "queued"]]);
    } finally { close(); }
  });
  it("GET /ui/traffic answers the snapshot (empty without a fleet); a public-link read, polled, so not a person's activity; no write", () => {
    const token = "c".repeat(48);
    const call = (method: string, over: Record<string, unknown> = {}) => {
      const req = Object.assign(new EventEmitter(), { method, url: "/ui/traffic", headers: { host: "127.0.0.1:19280", "x-agend-token": token } });
      let status = 0, body = "";
      const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { body = t; } });
      handleWebRequest(req as never, res as never, new URL("/ui/traffic", "http://127.0.0.1:19280"), { webToken: token, logger: { info() {}, debug() {}, error() {} }, sseClients: new Set(), ...over } as never);
      return { status, body: body ? JSON.parse(body) : null };
    };
    const snap = { now: AT, items: [item("x", "queued")] };
    expect(call("GET", { trafficSnapshot: () => snap })).toEqual({ status: 200, body: snap });
    const empty = call("GET");
    expect([empty.status, empty.body.items, typeof empty.body.now]).toEqual([200, [], "string"]);
    expect(call("POST", { trafficSnapshot: () => snap }).status).not.toBe(200);
    expect([isPublicWebRoute("GET", "/ui/traffic"), isPublicWebRoute("POST", "/ui/traffic"), isPublicWebRoute("GET", "/ui/traffic/x")]).toEqual([true, false, false]);
    expect(isPassiveWebRead("GET", "/ui/traffic")).toBe(true);
  });
});
