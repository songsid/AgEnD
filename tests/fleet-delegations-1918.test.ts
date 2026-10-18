/**
 * #1918 review (the user's issue 1): the org canvas shows the work, not just the message. Delegations (src/fleet-traffic.ts):
 * a task opens one, delegator → worker; its report — the same correlation id, the other way — closes it; a task whose
 * delivery failed or was cancelled takes it back; past DELEGATION_TTL_MS it expires ("no report yet"); capped, the oldest
 * first. Opaque ids, never the correlation id. FleetManager sends each change as SSE "delegation" and lists the open
 * ones in GET /ui/traffic's snapshot (a reload, the public link), hidden instances left out.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryOutbox } from "../src/delivery-outbox.js";
import { Delegations, DELEGATION_TTL_MS, DELEGATIONS_MAX, type TrafficItem } from "../src/fleet-traffic.js";
import type { OutboxDelivery } from "../src/delivery-outbox.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const AT = "2026-10-18T10:00:00.000Z";
/** A message's traffic item: `n` names its delivery (each state of one message shares it). */
const item = (from: string, to: string, kind: TrafficItem["kind"], state: TrafficItem["state"] = "queued", n = 1): TrafficItem => ({ id: n.toString(16).padStart(16, "0"), from, to, kind, state, at: AT });
const row = (correlationId: string | null) => ({ correlationId });

describe("Delegations", () => {
  it("a task opens one; its report (same correlation id, the other way) closes it: open, then done, with how long it took", () => {
    let now = 0;
    const d = new Delegations(() => now);
    const [open] = d.note(row("cid-1"), item("atlas", "ember", "task", "queued", 1));
    expect(open).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), from: "atlas", to: "ember", state: "open", age_ms: 0 });
    expect(d.note(row("cid-1"), item("atlas", "ember", "task", "delivering", 1)), "its later states: no news").toEqual([]);
    now = 90_000;
    expect(d.snapshot()).toEqual([{ ...open, age_ms: 90_000 }]);
    expect(d.note(row("cid-1"), item("ember", "atlas", "report", "queued", 2))).toEqual([{ ...open, state: "done", age_ms: 90_000 }]);
    expect(d.snapshot()).toEqual([]);
    expect(JSON.stringify(open)).not.toContain("cid-1");
  });
  it("#2135 review: a later state of the task's own delivery never opens it again — after its report, its expiry or being pushed out", () => {
    let now = 0;
    const d = new Delegations(() => now);
    d.note(row("cid-1"), item("atlas", "ember", "task", "delivered", 1));
    d.note(row("cid-1"), item("ember", "atlas", "report", "queued", 2));                // a fast report, before the task's consumed mark
    expect(d.note(row("cid-1"), item("atlas", "ember", "task", "consumed", 1)), "the consumed mark, 5 s later").toEqual([]);
    expect(d.snapshot()).toEqual([]);
    d.note(row("cid-2"), item("atlas", "quill", "task", "queued", 3));
    now = DELEGATION_TTL_MS;
    expect(d.note(row("cid-2"), item("atlas", "quill", "task", "delivered", 3)).map((x) => x.state), "expired, and not opened again").toEqual(["expired"]);
    expect(d.snapshot()).toEqual([]);
  });
  it("a new task delivery with the same correlation id is a new delegation (its own id); one already open for the pair is kept", () => {
    const d = new Delegations(() => 0);
    const [a] = d.note(row("cid-1"), item("atlas", "ember", "task", "queued", 1));
    d.note(row("cid-1"), item("ember", "atlas", "report", "queued", 2));
    const [b] = d.note(row("cid-1"), item("atlas", "ember", "task", "queued", 3));
    expect([b.state, b.id === a.id]).toEqual(["open", false]);
    expect(d.note(row("cid-1"), item("atlas", "ember", "task", "queued", 4)), "open already for this pair: its report closes it").toEqual([]);
    expect(d.note(row("cid-1"), item("atlas", "ember", "task", "failed", 4)), "that other delivery failing takes nothing back").toEqual([]);
    expect(d.snapshot().map((x) => x.id)).toEqual([b.id]);
  });
  it("#2135 review: a report counts once — its later states never close the next task of the same correlation id and pair; a new report does", () => {
    const d = new Delegations(() => 0);
    d.note(row("cid-1"), item("atlas", "ember", "task", "queued", 1));
    expect(d.note(row("cid-1"), item("ember", "atlas", "report", "queued", 2)).map((x) => x.state)).toEqual(["done"]);
    const [t2] = d.note(row("cid-1"), item("atlas", "ember", "task", "queued", 3));
    for (const st of ["delivering", "delivered", "consumed"] as const) expect(d.note(row("cid-1"), item("ember", "atlas", "report", st, 2)), `the first report, ${st}`).toEqual([]);
    expect(d.snapshot().map((x) => x.id)).toEqual([t2.id]);
    expect(d.note(row("cid-1"), item("ember", "atlas", "report", "queued", 4)).map((x) => [x.id, x.state])).toEqual([[t2.id, "done"]]);
    // A report with nothing to close counts once too: its later states do not close a task opened after it.
    d.note(row("cid-9"), item("ember", "atlas", "report", "queued", 5));
    const [t3] = d.note(row("cid-9"), item("atlas", "ember", "task", "queued", 6));
    expect(d.note(row("cid-9"), item("ember", "atlas", "report", "delivered", 5))).toEqual([]);
    expect(d.snapshot().map((x) => x.id)).toEqual([t3.id]);
  });
  it("only its own report closes it: not another correlation id, not the same direction, not a send; no correlation id: nothing", () => {
    const d = new Delegations(() => 0);
    d.note(row("cid-1"), item("atlas", "ember", "task", "queued", 1));
    expect(d.note(row("cid-2"), item("ember", "atlas", "report", "queued", 2))).toEqual([]);
    expect(d.note(row("cid-1"), item("atlas", "ember", "report", "queued", 3))).toEqual([]);
    expect(d.note(row("cid-1"), item("ember", "atlas", "send", "queued", 4))).toEqual([]);
    expect(d.note(row("cid-1"), item("ember", "atlas", "report", "failed", 5)), "a report that failed to arrive").toEqual([]);
    expect(d.note(row(null), item("quill", "sage", "task", "queued", 6))).toEqual([]);
    expect(d.snapshot().map((x) => x.to)).toEqual(["ember"]);
  });
  it("the task's delivery failed or was cancelled: taken back (cancelled), and its later states never open it", () => {
    const d = new Delegations(() => 0);
    d.note(row("cid-1"), item("atlas", "ember", "task", "queued", 1));
    d.note(row("cid-2"), item("atlas", "quill", "task", "queued", 2));
    expect(d.note(row("cid-1"), item("atlas", "ember", "task", "failed", 1)).map((x) => x.state)).toEqual(["cancelled"]);
    expect(d.note(row("cid-2"), item("atlas", "quill", "task", "cancelled", 2)).map((x) => x.state)).toEqual(["cancelled"]);
    expect(d.note(row("cid-1"), item("atlas", "ember", "task", "delivering", 1))).toEqual([]);
    expect(d.snapshot()).toEqual([]);
  });
  it("one that waits past DELEGATION_TTL_MS expires (no report yet): said with the next news, gone from the snapshot", () => {
    let now = 0;
    const d = new Delegations(() => now);
    d.note(row("cid-1"), item("atlas", "ember", "task", "queued", 1));
    now = DELEGATION_TTL_MS - 1;
    expect(d.snapshot()).toHaveLength(1);
    now = DELEGATION_TTL_MS;
    expect(d.note(row("cid-9"), item("quill", "sage", "task", "queued", 2)).map((x) => [x.to, x.state])).toEqual([["ember", "expired"], ["sage", "open"]]);
    expect(d.snapshot().map((x) => x.to)).toEqual(["sage"]);
  });
  it("capped at DELEGATIONS_MAX: the oldest expires first, and its later states never open it again", () => {
    const d = new Delegations(() => 0);
    for (let i = 0; i < DELEGATIONS_MAX; i++) d.note(row(`cid-${i}`), item("atlas", `w${i}`, "task", "queued", 100 + i));
    expect(d.note(row("cid-new"), item("atlas", "wnew", "task", "queued", 9999)).map((x) => [x.to, x.state])).toEqual([["wnew", "open"], ["w0", "expired"]]);
    expect(d.snapshot()).toHaveLength(DELEGATIONS_MAX);
    expect(d.note(row("cid-0"), item("atlas", "w0", "task", "consumed", 100))).toEqual([]);
  });
});

describe("FleetManager: SSE delegation and the snapshot", () => {
  // Loading FleetManager is slow under a parallel run: not part of any one test's time.
  beforeAll(async () => { await import("../src/fleet-manager.js"); }, 120_000);
  async function fleet() {
    const dir = mkdtempSync(join(tmpdir(), "agend-1918d-")); roots.push(dir);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm: any = new FleetManager(dir);
    const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
    fm.fleetConfig = { defaults: {}, instances: { atlas: {}, ember: {}, quill: {}, shy: { cross_instance_visibility: "hidden" } } };
    fm.scheduleDeliveryOutboxPump = () => {};
    fm.createWakeCoordinator = () => ({ start() {}, stop() {}, kick() {}, noteDelivered() {} });
    fm.ensureDeliveryOutbox();
    const sse: Array<[string, any]> = [];
    fm.emitSseEvent = (type: string, data: unknown) => sse.push([type, data]);
    for (const n of ["atlas", "ember", "quill", "shy"]) fm.daemons.set(n, { bootId: `${n}-boot` });   // the senders' daemons
    const close = () => { clearInterval(fm.replyObligationTimer); fm.deliveryOutbox.close(); };
    return { fm, sse, close };
  }
  const admit = (fm: any, from: string, to: string, requestKind: string, correlationId: string, op = `${from}-${to}-${correlationId}`) => fm.admitDurableDelivery({
    operationId: op, sourceInstance: from, targetInstance: to, kind: "fleet_inbound", correlationId, payload: { type: "fleet_inbound", content: "c", meta: { request_kind: requestKind } } });
  it("delegate_task → report_result over the real outbox: open, then done; the snapshot lists the open ones", async () => {
    const { fm, sse, close } = await fleet();
    try {
      admit(fm, "atlas", "ember", "task", "cid-a");
      admit(fm, "atlas", "quill", "task", "cid-b");
      const s = fm.trafficSnapshot();
      expect(s.delegations.map((d: any) => [d.from, d.to, d.state])).toEqual([["atlas", "ember", "open"], ["atlas", "quill", "open"]]);
      admit(fm, "ember", "atlas", "report", "cid-a");
      expect(sse.filter(([t]) => t === "delegation").map(([, d]) => [d.from, d.to, d.state])).toEqual([["atlas", "ember", "open"], ["atlas", "quill", "open"], ["atlas", "ember", "done"]]);
      expect(fm.trafficSnapshot().delegations.map((d: any) => d.to), "news dropped the memo").toEqual(["quill"]);
    } finally { close(); }
  });
  const deliver = (fm: any, deliveryId: string, boot: string) => {
    const outbox = fm.deliveryOutbox as DeliveryOutbox;
    const c = outbox.claimNext("manager", () => boot, new Set())!;
    expect(c.deliveryId).toBe(deliveryId);
    outbox.begin(deliveryId, boot, c.attemptNo, { backend: "claude-code", backendVersion: null, windowId: "@w", transcriptPath: "/t", transcriptOffset: 0, transcriptSessionId: "/t", submissionMode: "native_queue_handoff" });
    outbox.complete(deliveryId, boot, c.attemptNo, "delivered", "proof");
    return c.attemptNo as number;
  };
  it("#2135 review: task → a fast report → the task's own consumed mark (seconds later) never opens it again", async () => {
    const { fm, sse, close } = await fleet();
    try {
      const task = admit(fm, "atlas", "ember", "task", "cid-a");
      const attempt = deliver(fm, task.deliveryId, "boot-e");
      admit(fm, "ember", "atlas", "report", "cid-a");                                    // the report comes back first
      (fm.deliveryOutbox as DeliveryOutbox).markConsumed(task.deliveryId, "boot-e", attempt, "turn", "e");
      expect(sse.filter(([t]) => t === "traffic").some(([, d]) => d.kind === "task" && d.state === "consumed"), "the consumed mark was published").toBe(true);
      expect(sse.filter(([t]) => t === "delegation").map(([, d]) => d.state)).toEqual(["open", "done"]);
      expect(fm.trafficSnapshot().delegations).toEqual([]);
    } finally { close(); }
  });
  it("#2135 review: T1 → report R1 → a new T2 (same correlation id) → R1 delivered and consumed: T2 stays open; a new report R2 closes it", async () => {
    const { fm, sse, close } = await fleet();
    try {
      const t1 = admit(fm, "atlas", "ember", "task", "cid-a", "op-t1");
      deliver(fm, t1.deliveryId, "boot-e");
      const r1 = admit(fm, "ember", "atlas", "report", "cid-a", "op-r1");
      admit(fm, "atlas", "ember", "task", "cid-a", "op-t2");
      const attempt = deliver(fm, r1.deliveryId, "boot-a");
      (fm.deliveryOutbox as DeliveryOutbox).markConsumed(r1.deliveryId, "boot-a", attempt, "turn", "e");
      expect(sse.filter(([t]) => t === "traffic").some(([, d]) => d.kind === "report" && d.state === "consumed"), "R1's consumed was published").toBe(true);
      expect(fm.trafficSnapshot().delegations.map((d: any) => d.to)).toEqual(["ember"]);
      admit(fm, "ember", "atlas", "report", "cid-a", "op-r2");
      expect(fm.trafficSnapshot().delegations).toEqual([]);
      expect(sse.filter(([t]) => t === "delegation").map(([, d]) => d.state)).toEqual(["open", "done", "open", "done"]);
    } finally { close(); }
  });
  it("#2135 review: an instance hidden after its delegation opened is in no later delegation event — not its expiry, not its eviction", async () => {
    const { fm, sse, close } = await fleet();
    try {
      let now = 0;
      fm.delegations = new Delegations(() => now);
      admit(fm, "atlas", "quill", "task", "cid-q");
      fm.fleetConfig.instances.quill = { cross_instance_visibility: "hidden" };
      now = DELEGATION_TTL_MS;
      admit(fm, "atlas", "ember", "task", "cid-e");                                      // news: the sweep expires quill's
      const after = sse.filter(([t]) => t === "delegation").map(([, d]) => [d.to, d.state]);
      expect(after).toEqual([["quill", "open"], ["ember", "open"]]);
      // Eviction at the cap: one more open for a hidden peer, pushed out by visible ones.
      fm.fleetConfig.instances.quill = {};
      admit(fm, "atlas", "quill", "task", "cid-q2");
      fm.fleetConfig.instances.quill = { cross_instance_visibility: "hidden" };
      for (let i = 0; i < DELEGATIONS_MAX; i++) { fm.fleetConfig.instances[`w${i}`] = {}; fm.daemons.set(`w${i}`, { bootId: `w${i}-boot` }); admit(fm, "atlas", `w${i}`, "task", `cid-w${i}`); }
      const evicted = sse.filter(([t]) => t === "delegation").map(([, d]) => d).filter((d: any) => d.state === "expired");
      expect(evicted.length, "evictions happened").toBeGreaterThan(0);
      expect(evicted.some((d: any) => d.to === "quill"), "quill is never named").toBe(false);
    } finally { close(); }
  });
  it("the task's delivery failing takes it back; a hidden instance's delegations never show", async () => {
    const { fm, sse, close } = await fleet();
    try {
      const a = admit(fm, "atlas", "ember", "task", "cid-a");
      admit(fm, "shy", "quill", "task", "cid-s");
      const outbox = fm.deliveryOutbox as DeliveryOutbox;
      const c = outbox.claimNext("manager", () => "boot-e", new Set())!;
      expect(c.deliveryId).toBe(a.deliveryId);
      outbox.begin(a.deliveryId, "boot-e", c.attemptNo, { backend: "claude-code", backendVersion: null, windowId: "@w", transcriptPath: "/t", transcriptOffset: 0, transcriptSessionId: "/t", submissionMode: "native_queue_handoff" });
      outbox.complete(a.deliveryId, "boot-e", c.attemptNo, "failed", "no pane");
      const states = sse.filter(([t]) => t === "delegation").map(([, d]) => [d.to, d.state]);
      expect(states).toEqual([["ember", "open"], ["ember", "cancelled"]]);
      expect(fm.trafficSnapshot().delegations.some((d: any) => d.from === "shy" || d.to === "quill")).toBe(false);
      // Open, then its worker hidden since: gone from the snapshot (visibility as of now).
      admit(fm, "atlas", "quill", "task", "cid-q");
      expect(fm.trafficSnapshot().delegations.map((d: any) => d.to)).toEqual(["quill"]);
      fm.fleetConfig.instances.quill = { cross_instance_visibility: "hidden" };
      admit(fm, "atlas", "ember", "update", "cid-news");                                   // any news drops the memo
      expect(fm.trafficSnapshot().delegations).toEqual([]);
    } finally { close(); }
  });
});
