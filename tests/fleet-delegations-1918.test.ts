/**
 * #1918 review (the user's issue 1): the org canvas shows the work, not just the message. Delegations (src/fleet-traffic.ts):
 * a task opens one, delegator → worker; its report — the same correlation id, the other way — closes it; a task whose
 * delivery failed or was cancelled takes it back; past DELEGATION_TTL_MS it expires ("no report yet"); capped, the oldest
 * first. Opaque ids, never the correlation id. FleetManager sends each change as SSE "delegation" and lists the open
 * ones in GET /ui/traffic's snapshot (a reload, the public link), hidden instances left out.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryOutbox } from "../src/delivery-outbox.js";
import { Delegations, DELEGATION_TTL_MS, DELEGATIONS_MAX, type TrafficItem } from "../src/fleet-traffic.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const AT = "2026-10-18T10:00:00.000Z";
const item = (from: string, to: string, kind: TrafficItem["kind"], state: TrafficItem["state"] = "queued"): TrafficItem => ({ id: "0".repeat(16), from, to, kind, state, at: AT });
const row = (correlationId: string | null) => ({ correlationId });

describe("Delegations", () => {
  it("a task opens one; its report (same correlation id, the other way) closes it: open, then done, with how long it took", () => {
    let now = 0;
    const d = new Delegations(() => now);
    const [open] = d.note(row("cid-1"), item("atlas", "ember", "task"));
    expect(open).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), from: "atlas", to: "ember", state: "open", age_ms: 0 });
    expect(d.note(row("cid-1"), item("atlas", "ember", "task", "delivering")), "its later states: no news").toEqual([]);
    now = 90_000;
    expect(d.snapshot()).toEqual([{ ...open, age_ms: 90_000 }]);
    expect(d.note(row("cid-1"), item("ember", "atlas", "report"))).toEqual([{ ...open, state: "done", age_ms: 90_000 }]);
    expect(d.snapshot()).toEqual([]);
    expect(JSON.stringify(open)).not.toContain("cid-1");
  });
  it("only its own report closes it: not another correlation id, not the same direction, not a send; no correlation id: nothing", () => {
    const d = new Delegations(() => 0);
    d.note(row("cid-1"), item("atlas", "ember", "task"));
    expect(d.note(row("cid-2"), item("ember", "atlas", "report"))).toEqual([]);
    expect(d.note(row("cid-1"), item("atlas", "ember", "report"))).toEqual([]);
    expect(d.note(row("cid-1"), item("ember", "atlas", "send"))).toEqual([]);
    expect(d.note(row("cid-1"), item("ember", "atlas", "report", "failed")), "a report that failed to arrive").toEqual([]);
    expect(d.note(row(null), item("quill", "sage", "task"))).toEqual([]);
    expect(d.snapshot().map((x) => x.to)).toEqual(["ember"]);
  });
  it("the task's delivery failed or was cancelled: taken back (cancelled)", () => {
    const d = new Delegations(() => 0);
    d.note(row("cid-1"), item("atlas", "ember", "task"));
    d.note(row("cid-2"), item("atlas", "quill", "task"));
    expect(d.note(row("cid-1"), item("atlas", "ember", "task", "failed")).map((x) => x.state)).toEqual(["cancelled"]);
    expect(d.note(row("cid-2"), item("atlas", "quill", "task", "cancelled")).map((x) => x.state)).toEqual(["cancelled"]);
    expect(d.snapshot()).toEqual([]);
  });
  it("one that waits past DELEGATION_TTL_MS expires (no report yet): said with the next news, gone from the snapshot", () => {
    let now = 0;
    const d = new Delegations(() => now);
    d.note(row("cid-1"), item("atlas", "ember", "task"));
    now = DELEGATION_TTL_MS - 1;
    expect(d.snapshot()).toHaveLength(1);
    now = DELEGATION_TTL_MS;
    expect(d.note(row("cid-9"), item("quill", "sage", "task")).map((x) => [x.to, x.state])).toEqual([["ember", "expired"], ["sage", "open"]]);
    expect(d.snapshot().map((x) => x.to)).toEqual(["sage"]);
  });
  it("capped at DELEGATIONS_MAX: the oldest expires first", () => {
    const d = new Delegations(() => 0);
    for (let i = 0; i < DELEGATIONS_MAX; i++) d.note(row(`cid-${i}`), item("atlas", `w${i}`, "task"));
    expect(d.note(row("cid-new"), item("atlas", "wnew", "task")).map((x) => [x.to, x.state])).toEqual([["wnew", "open"], ["w0", "expired"]]);
    expect(d.snapshot()).toHaveLength(DELEGATIONS_MAX);
  });
});

describe("FleetManager: SSE delegation and the snapshot", () => {
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
    } finally { close(); }
  });
});
