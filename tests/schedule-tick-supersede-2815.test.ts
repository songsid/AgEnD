/**
 * #2815: while agend-coordinator-kiro was stuck at a sign-in screen (2026-10-28, 12:12–12:24), its silent 5-minute
 * patrol schedule kept admitting raw_paste ticks; once it was free, four were pasted back to back (12:26:31–12:27:25),
 * each costing a turn. A newer tick of the same schedule now replaces that schedule's older ticks that never began —
 * #2785 (b)'s rule, keyed by source + target + schedule id. The ticks are admitted by the real FleetManager schedule
 * path, so the key follows the correlation id it actually writes.
 *
 * Isolation: a temp data dir and outbox; the dispatcher is held (shuttingDown) and the claims are made by the test.
 */
import { installTmuxProcessFixture } from "./helpers/tmux-process-stub.js";
installTmuxProcessFixture();
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function fleet() {
  const root = mkdtempSync(join(tmpdir(), "agend-2815-")); roots.push(root);
  const fm = new FleetManager(root) as any;
  fm.shuttingDown = true;                                   // the dispatcher stays idle; the test claims
  const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), fm.managerBootId);
  fm.deliveryOutbox = outbox;
  fm.scheduler = { recordRun: vi.fn() };
  const notices = vi.fn();
  fm.notifyFleetError = notices; fm.notifyInstanceTopic = notices;
  const states: string[] = [];
  outbox.on("state", (e: { deliveryId: string; state: string }) => states.push(`${e.deliveryId}:${e.state}`));
  const schedule = (id: string, target = "coordinator", source = "leader") => ({
    id, cron: "*/5 * * * *", at: null, message: `[巡邏] ${id}`, source, target, reply_chat_id: "chat", reply_thread_id: null,
    label: id, enabled: true, timezone: "UTC", silent: true, created_at: "2026-10-28T00:00:00.000Z",
    last_triggered_at: null, last_status: null,
  });
  /** One tick, admitted exactly as the cron would (handleScheduleTrigger with the fire instant as run id). */
  const tick = async (s: ReturnType<typeof schedule>, at: string) => {
    await fm.handleScheduleTrigger(s, at);
    return outbox.listPending().find((r) => r.operationId === `schedule:${s.id}:${at}` && r.targetInstance === s.target)!;
  };
  /** Claim, begin and deliver the next row for `target`; what was pasted. */
  const deliverNext = (target = "coordinator") => {
    const c = outbox.claimNext(fm.managerBootId, (t) => (t === target ? "boot" : null), new Set());
    if (!c) return null;
    expect(outbox.begin(c.deliveryId, "boot", c.attemptNo)).toBe("begun");
    outbox.complete(c.deliveryId, "boot", c.attemptNo, "delivered");
    return c;
  };
  const drain = (target?: string) => { const out = []; for (let c = deliverNext(target); c; c = deliverNext(target)) out.push(c); return out; };
  return { fm, outbox, schedule, tick, deliverNext, drain, states, notices };
}

describe("#2815: a newer tick of a silent schedule replaces its older ticks still waiting", () => {
  it("the 2026-10-28 patrol: four ticks waiting behind a stuck agent → one paste, the newest; the rest cancelled, naming it", async () => {
    const { outbox, schedule, tick, drain, states, notices } = fleet();
    const patrol = schedule("98b718d7-b1d4-43f4-a20a-58a2d1d00000");
    const waiting = [];
    for (const at of ["2026-10-28T04:10:00.000Z", "2026-10-28T04:15:00.000Z", "2026-10-28T04:20:00.000Z", "2026-10-28T04:25:00.000Z"]) {
      waiting.push(await tick(patrol, at));
    }
    expect(waiting.map((r) => r.kind)).toEqual(["raw_paste", "raw_paste", "raw_paste", "raw_paste"]);
    const pasted = drain();
    expect(pasted.map((c) => c.deliveryId)).toEqual([waiting[3]!.deliveryId]);
    expect(pasted[0]!.payload).toMatchObject({ type: "raw_paste", content: `[巡邏] ${patrol.id}` });
    for (const old of waiting.slice(0, 3)) {
      expect(outbox.get(old.deliveryId)).toMatchObject({ state: "cancelled", lastError: `superseded by ${waiting[3]!.deliveryId}` });
      expect(states).toContain(`${old.deliveryId}:cancelled`);
    }
    expect(notices).not.toHaveBeenCalled();
    // The next tick after recovery goes as usual.
    const next = await tick(patrol, "2026-10-28T04:30:00.000Z");
    expect(drain().map((c) => c.deliveryId)).toEqual([next.deliveryId]);
  });

  it("other schedules and other targets keep their own newest tick", async () => {
    const { schedule, tick, drain } = fleet();
    const patrol = schedule("patrol");
    const digest = schedule("digest");                                  // another schedule, same target
    const elsewhere = schedule("patrol", "sol");                        // the same id, another target
    const p1 = await tick(patrol, "2026-10-28T04:10:00.000Z");
    const d1 = await tick(digest, "2026-10-28T04:10:00.000Z");
    const e1 = await tick(elsewhere, "2026-10-28T04:10:00.000Z");
    const p2 = await tick(patrol, "2026-10-28T04:15:00.000Z");
    const d2 = await tick(digest, "2026-10-28T04:15:00.000Z");
    expect(drain().map((c) => c.deliveryId)).toEqual([p2, d2].map((r) => r.deliveryId));
    expect(drain("sol").map((c) => c.deliveryId)).toEqual([e1.deliveryId]);
    void p1; void d1;
  });

  it("a tick whose paste already began keeps its place; the newer one still goes after it (the worst case: 2)", async () => {
    const { outbox, fm, schedule, tick, drain } = fleet();
    const patrol = schedule("patrol");
    const first = await tick(patrol, "2026-10-28T04:10:00.000Z");
    const c = outbox.claimNext(fm.managerBootId, () => "boot", new Set())!;
    expect(c.deliveryId).toBe(first.deliveryId);
    expect(outbox.begin(c.deliveryId, "boot", c.attemptNo)).toBe("begun");     // on the pane
    // Force it back to look pending, to prove the begun attempt alone protects it.
    (outbox as any).db.prepare("UPDATE deliveries SET state='retry_wait', next_attempt_at=NULL WHERE delivery_id=?").run(first.deliveryId);
    await tick(patrol, "2026-10-28T04:15:00.000Z");
    const last = await tick(patrol, "2026-10-28T04:20:00.000Z");
    const pasted = drain().map((c) => c.deliveryId);
    expect(outbox.get(first.deliveryId)?.state).not.toBe("cancelled");
    expect(pasted).toContain(last.deliveryId);
    expect(pasted.length).toBeLessThanOrEqual(2);
  });

  it("a raw paste without a schedule id is untouched (a /raw command, or another correlation id)", async () => {
    const { outbox, drain } = fleet();
    const admit = (n: number, cid?: string) => outbox.admit({
      operationId: `raw-${n}`, sourceKey: `raw-${n}`, sourceInstance: "leader", sourceDaemonBootId: "sb", targetInstance: "coordinator",
      kind: "raw_paste", ...(cid ? { correlationId: cid } : {}), payload: { type: "raw_paste", content: `/cmd ${n}` },
    }).delivery;
    const rows = [admit(1), admit(2), admit(3, "cid-x"), admit(4, "cid-x"), admit(5, "schedule-like:x:1"), admit(6, "schedule-like:x:2")];
    expect(drain().map((c) => c.deliveryId)).toEqual(rows.map((r) => r.deliveryId));
  });
});
