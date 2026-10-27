/**
 * #2785 (b): queued messages for an old PR head were all delivered later, in order — on 2026-10-26 GrokCore got eleven
 * #2683 messages in a 4-minute burst, four of them review rounds for heads since replaced, sent by Prism under ONE
 * correlation_id. The outbox now drops a message still waiting when a newer one from the same sender to the same target
 * on the same thread waits behind it; it is `cancelled`, its reason naming the newer delivery, and only agents'
 * messages (fleet_inbound, steer) that never began are touched.
 *
 * Isolation: a temp outbox database; nothing starts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeliveryOutbox } from "../src/delivery-outbox.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function outbox() {
  const root = mkdtempSync(join(tmpdir(), "agend-2785b-")); roots.push(root);
  const o = new DeliveryOutbox(join(root, "outbox.db"), "manager");
  let n = 0;
  const admit = (source: string, target: string, content: string, cid?: string, kind = "fleet_inbound", requiresReply = false) => o.admit({
    operationId: `op-${++n}`, sourceKey: `k-${n}`, sourceInstance: source, sourceDaemonBootId: "sb", targetInstance: target, kind,
    ...(cid ? { correlationId: cid } : {}),
    payload: { type: kind, content, meta: { ...(cid ? { correlation_id: cid } : {}), ...(requiresReply ? { requires_reply: "true" } : {}) } },
  }).delivery;
  const states: string[] = [];
  o.on("state", (e: { deliveryId: string; state: string }) => states.push(`${e.deliveryId}:${e.state}`));
  /** Claim, begin and deliver the next row for `target`; what was delivered. */
  const deliverNext = (target = "grok") => {
    const c = o.claimNext("manager", (t) => (t === target ? "boot" : null), new Set());
    if (!c) return null;
    expect(o.begin(c.deliveryId, "boot", c.attemptNo)).toBe("begun");
    o.complete(c.deliveryId, "boot", c.attemptNo, "delivered");
    return c;
  };
  return { o, admit, deliverNext, states };
}

describe("#2785 (b): a newer message on the same thread replaces an older one still waiting", () => {
  it("three review rounds under one correlation_id: only the newest is delivered; the others are cancelled, naming it", () => {
    const { o, admit, deliverNext, states } = outbox();
    const r1 = admit("prism", "grok", "REQUEST_CHANGES — PR #2683 @332105b", "cid-pr");
    const r2 = admit("prism", "grok", "REQUEST_CHANGES — PR #2683 @7b6c46a", "cid-pr");
    const r3 = admit("prism", "grok", "APPROVE — PR #2683 @824571f", "cid-pr");
    const got = deliverNext()!;
    expect(got.deliveryId).toBe(r3.deliveryId);
    for (const r of [r1, r2]) {
      expect(o.get(r.deliveryId)).toMatchObject({ state: "cancelled", lastError: `superseded by ${r3.deliveryId}` });
      expect(states).toContain(`${r.deliveryId}:cancelled`);
    }
    expect(deliverNext()).toBeNull();
  });

  it("other threads, senders, targets and kinds keep their place, in order", () => {
    const { o, admit, deliverNext } = outbox();
    const a = admit("prism", "grok", "review A", "cid-a");
    const b = admit("prism", "grok", "review B", "cid-b");                     // another thread
    const c = admit("coordinator", "grok", "CI on A", "cid-a");               // another sender
    const d = admit("prism", "sol", "review A for sol", "cid-a");             // another target
    const e = admit("prism", "grok", "no thread at all");                     // no correlation id
    const e2 = admit("prism", "grok", "no thread either");                    // …nor this one: both go
    const f = admit("leader", "grok", "Follow-up check", "cid-sched", "raw_paste");
    const g = admit("leader", "grok", "Follow-up check again", "cid-sched", "raw_paste");   // schedules are not threads here
    const order = [deliverNext(), deliverNext(), deliverNext(), deliverNext(), deliverNext(), deliverNext(), deliverNext()].map((x) => x?.deliveryId);
    expect(order).toEqual([a, b, c, e, e2, f, g].map((x) => x.deliveryId));
    expect(deliverNext("sol")?.deliveryId).toBe(d.deliveryId);
    for (const x of [a, b, c, d, e, e2, f, g]) expect(o.get(x.deliveryId)?.state).toBe("delivered");
  });

  it("a steer on the thread counts like a message", () => {
    const { o, admit, deliverNext } = outbox();
    const old = admit("leader", "grok", "#2683 CI is red", "cid-l");
    const newer = admit("leader", "grok", "#2683: never mind, it's green", "cid-l", "steer");
    expect(deliverNext()?.deliveryId).toBe(newer.deliveryId);
    expect(o.get(old.deliveryId)?.state).toBe("cancelled");
  });

  it("a row that already began keeps its place; one whose only attempt was aborted (nothing written) can be replaced", () => {
    const { o, admit, deliverNext } = outbox();
    const first = admit("prism", "grok", "round 1", "cid-pr");
    const c = o.claimNext("manager", () => "boot", new Set())!;
    expect(c.deliveryId).toBe(first.deliveryId);
    expect(o.begin(c.deliveryId, "boot", c.attemptNo)).toBe("begun");
    expect(o.abort(c.deliveryId, "boot", c.attemptNo, "no pane write")).toBe(true);      // back to retry_wait, nothing written
    (o as any).db.prepare("UPDATE deliveries SET next_attempt_at=NULL WHERE delivery_id=?").run(first.deliveryId);
    const second = admit("prism", "grok", "round 2", "cid-pr");
    expect(deliverNext()?.deliveryId).toBe(second.deliveryId);
    expect(o.get(first.deliveryId)?.state).toBe("cancelled");

    const { o: o2, admit: admit2 } = outbox();
    const begun = admit2("prism", "grok", "round 1", "cid-pr");
    const c2 = o2.claimNext("manager", () => "boot", new Set())!;
    expect(o2.begin(c2.deliveryId, "boot", c2.attemptNo)).toBe("begun");          // submission started: on the pane
    // A begun row is no longer pending; force it back to look pending, to prove the attempt alone protects it.
    (o2 as any).db.prepare("UPDATE deliveries SET state='retry_wait', next_attempt_at=NULL WHERE delivery_id=?").run(begun.deliveryId);
    admit2("prism", "grok", "round 2", "cid-pr");
    o2.claimNext("manager", () => "boot", new Set());
    expect(o2.get(begun.deliveryId)?.state).not.toBe("cancelled");
  });

  it("the reply obligation goes with the newest message", () => {
    const { o, admit, deliverNext } = outbox();
    admit("leader", "grok", "what's left on #2683?", "cid-q", "fleet_inbound", true);
    const newer = admit("leader", "grok", "what's left on #2683? (head 824571f)", "cid-q", "fleet_inbound", true);
    expect(deliverNext()?.deliveryId).toBe(newer.deliveryId);
    const rows = (o as any).db.prepare("SELECT request_delivery_id, state FROM reply_obligations").all();
    expect(rows).toEqual([{ request_delivery_id: newer.deliveryId, state: "open" }]);
  });

  it("a request that needs a reply is not replaced by an update that doesn't (#2797 review): both go, the duty stays", () => {
    const { o, admit, deliverNext } = outbox();
    const request = admit("leader", "grok", "what's left on #2683? reply please", "cid-q", "fleet_inbound", true);
    const update = admit("leader", "grok", "fyi: CI is green now", "cid-q");                     // no requires_reply
    expect(deliverNext()?.deliveryId).toBe(request.deliveryId);
    expect(deliverNext()?.deliveryId).toBe(update.deliveryId);
    const rows = (o as any).db.prepare("SELECT request_delivery_id, state FROM reply_obligations").all();
    expect(rows).toEqual([{ request_delivery_id: request.deliveryId, state: "open" }]);
  });

  it("an update that doesn't need a reply is replaced by a request that does", () => {
    const { o, admit, deliverNext } = outbox();
    const update = admit("leader", "grok", "fyi: CI is red", "cid-q");
    const request = admit("leader", "grok", "CI is red: what's the fix? reply please", "cid-q", "fleet_inbound", true);
    expect(deliverNext()?.deliveryId).toBe(request.deliveryId);
    expect(o.get(update.deliveryId)?.state).toBe("cancelled");
  });

  it("the 2026-10-26 #2683 burst to GrokCore: Prism's four rounds collapse into its approval", () => {
    const { o, admit, deliverNext } = outbox();
    // the eleven rows as they waited (sender, correlation id), in order
    const burst: Array<[string, string]> = [
      ["prism", "cid-1792998007441-33a5lx"], ["coordinator", "cid-1792999285026-396ym5"], ["prism", "cid-1792999257536-ysoktl"],
      ["coordinator", "cid-1792999800510-e33zdx"], ["leader", "cid-1792997127376-dyjaxa"], ["prism", "cid-1792999257536-ysoktl"],
      ["coordinator", "cid-1793001650041-eln0qy"], ["prism", "cid-1792999257536-ysoktl"], ["coordinator", "cid-1793007347374-7s60b1"],
      ["leader", "cid-1792997127376-dyjaxa"], ["prism", "cid-1793008815372-22c4cp"],
    ];
    const rows = burst.map(([source, cid], i) => admit(source, "grok", `message ${i + 1}`, cid));
    const delivered: number[] = [];
    for (let next = deliverNext(); next; next = deliverNext()) delivered.push(rows.findIndex((r) => r.deliveryId === next!.deliveryId) + 1);
    // Prism's rounds 3 and 6 are replaced by 8 (same thread); the leader's 5 by 10. The rest have their own threads.
    expect(delivered).toEqual([1, 2, 4, 7, 8, 9, 10, 11]);
    expect([3, 5, 6].map((i) => o.get(rows[i - 1]!.deliveryId)?.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });
});
