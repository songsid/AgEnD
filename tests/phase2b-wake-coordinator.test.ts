/**
 * Phase 2b (docs/design/phase2-submit-contract.md §1.2–§1.6, §3.1): the wake
 * coordinator, against fake dependencies so each rule is exercised exactly.
 * Integration with the real FleetManager, outbox and pump is in
 * tests/phase2b-wake-integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PASSIVE_KINDS,
  CLAIM_BLOCK_NOTICE_MS, PARK_BASE_MS, PRECLAIM_WINDOW_MS, WAKE_BACKOFF_MAX_MS, WakeCoordinator,
  type WakeCoordinatorDeps,
} from "../src/wake-coordinator.js";
import { setLocale } from "../src/locale.js";
import type { OutboxDelivery } from "../src/delivery-outbox.js";

let seq = 0;
const row = (target: string, kind = "fleet_inbound", extra: Partial<OutboxDelivery> = {}): OutboxDelivery => ({
  deliveryId: `d${++seq}`, operationId: `op${seq}`, sourceKey: `k${seq}`, sourceInstance: "sender",
  sourceDaemonBootId: "b", targetInstance: target, targetSession: null, targetDaemonBootId: null, kind,
  correlationId: null, payload: {}, state: "queued", attemptNo: 0, createdSeq: seq, managerBootId: null,
  responseDeliveredAt: null, nextAttemptAt: null, lastError: null, reconciliationPending: false,
  createdAt: new Date(clock).toISOString(), ...extra,
} as OutboxDelivery);

let clock = 1_000_000;
interface World {
  rows: OutboxDelivery[];
  paused: Set<string>;
  reasons: Map<string, any>;
  resident: Set<string>;
  wakes: string[];
  /** Per-target controllable wake results. */
  wakeImpl: (target: string) => Promise<void>;
  notices: Array<{ to: string; text: string }>;
  mode: string;
  cap: number;
  overflow: number;
  wokeAt: Map<string, number>;
  holdReason: Map<string, string>;
  pumpKicks: number;
  available: boolean;
}

function setup(over: Partial<World> = {}) {
  const w: World = {
    rows: [], paused: new Set(), reasons: new Map(), resident: new Set(), wakes: [], notices: [],
    wakeImpl: async () => {}, mode: "wake_only", cap: 0, overflow: 2, wokeAt: new Map(), holdReason: new Map(), pumpKicks: 0, available: true,
    ...over,
  };
  const deps: WakeCoordinatorDeps = {
    mode: () => w.mode as any,
    available: () => w.available,
    listPending: () => w.rows.filter(r => ["queued", "retry_wait", "delivering", "submission_started"].includes(r.state)),
    isPaused: t => w.paused.has(t),
    pauseReason: t => w.reasons.get(t) ?? null,
    isRestarting: () => false,
    wake: async t => {
      w.wakes.push(t);
      await w.wakeImpl(t);
      w.paused.delete(t);
      w.resident.add(t);
      w.wokeAt.set(t, clock);
    },
    residentNames: () => [...w.resident],
    warmCap: () => w.cap,
    warmOverflow: () => w.overflow,
    wokeAt: t => w.wokeAt.get(t),
    notAcceptingReason: t => w.holdReason.get(t) ?? null,
    notifyTarget: (to, text) => { w.notices.push({ to, text }); },
    notifySender: (to, text) => { w.notices.push({ to, text }); },
    kickPump: () => { w.pumpKicks++; },
    now: () => clock,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
  return { w, c: new WakeCoordinator(deps) };
}

const settle = () => new Promise(r => setTimeout(r, 0));
const deferred = () => { let release!: () => void; let fail!: (e: Error) => void; const promise = new Promise<void>((r, j) => { release = r; fail = j; }); return { promise, release, fail }; };

beforeEach(() => { clock = 1_000_000; seq = 0; });
afterEach(() => { vi.useRealTimers(); setLocale("en"); });

describe("what is woken", () => {
  it("a paused target with queued work is woken once, even when scanned again mid-wake", async () => {
    const gate = deferred();
    const { w, c } = setup({ wakeImpl: () => gate.promise });
    w.paused.add("t");
    w.rows.push(row("t"), row("t"));
    c.scan(); c.scan(); c.scan();
    expect(w.wakes).toEqual(["t"]);
    expect(c.blocksClaim("t")).toBe(true);
    gate.release(); await settle();
    expect(c.blocksClaim("t")).toBe(false);
  });

  it("the whole queue decides: a notice at the head and a task behind it wake once, order untouched (2b ④)", () => {
    const { w, c } = setup();
    w.paused.add("t");
    w.rows.push(row("t", "delivery_outcome_notice"), row("t", "fleet_inbound"));
    c.scan();
    expect(w.wakes).toEqual(["t"]);
    expect(w.rows.map(r => r.kind)).toEqual(["delivery_outcome_notice", "fleet_inbound"]);
  });

  it("every current kind is wake-eligible, reply-obligation notices included (2b ⑤)", () => {
    for (const kind of ["fleet_inbound", "steer", "raw_paste", "delivery_outcome_notice", "post_restart_outcome_notice", "reply_obligation_notice"]) {
      const { w, c } = setup();
      w.paused.add("t");
      w.rows.push(row("t", kind));
      c.scan();
      expect(w.wakes, kind).toEqual(["t"]);
    }
  });

  it("an awake target, an in-flight-only target, or delivery_worker=off is never woken", () => {
    const awake = setup(); awake.w.rows.push(row("t")); awake.c.scan();
    expect(awake.w.wakes).toEqual([]);
    const inflight = setup(); inflight.w.paused.add("t"); inflight.w.rows.push(row("t", "fleet_inbound", { state: "delivering" })); inflight.c.scan();
    expect(inflight.w.wakes).toEqual([]);
    const off = setup({ mode: "off" }); off.w.paused.add("t"); off.w.rows.push(row("t")); off.c.scan();
    expect(off.w.wakes).toEqual([]);
    expect(off.c.blocksClaim("t")).toBe(false); // off: the pump's old behaviour is untouched
  });
});

describe("wake failure (2b ③)", () => {
  it("backs off 1s→…→60s, tells both topics once at the third failure, and never touches the rows", async () => {
    const { w, c } = setup({ wakeImpl: async () => { throw new Error("spawn failed"); } });
    w.paused.add("t");
    const r = row("t");
    w.rows.push(r);
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      c.scan(); await settle();
      const due = (c as any).states.get("t").backoffUntil - clock;
      delays.push(due);
      c.scan(); // inside the backoff: no new wake
      clock += due;
    }
    expect(w.wakes).toHaveLength(8);
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, WAKE_BACKOFF_MAX_MS, WAKE_BACKOFF_MAX_MS]);
    const failureNotices = w.notices.filter(n => n.text.includes("could not be woken"));
    expect(failureNotices.map(n => n.to).sort()).toEqual(["sender", "t"]);
    expect(failureNotices[0]!.text).toContain("3 attempts");
    // The coordinator never claims, so the row's attempt is untouched.
    expect(r.state).toBe("queued");
    expect(r.attemptNo).toBe(0);
    expect(c.wakeFailure("t")).toBe("spawn failed");
  });

  it("a success ends the episode: the next failure run notifies again", async () => {
    let fail = true;
    const { w, c } = setup({ wakeImpl: async () => { if (fail) throw new Error("x"); } });
    w.paused.add("t"); w.rows.push(row("t"));
    for (let i = 0; i < 3; i++) { c.scan(); await settle(); clock += WAKE_BACKOFF_MAX_MS; }
    fail = false; c.scan(); await settle();
    expect(c.wakeFailure("t")).toBeNull();
    fail = true; w.paused.add("t");
    for (let i = 0; i < 3; i++) { c.scan(); await settle(); clock += WAKE_BACKOFF_MAX_MS; }
    expect(w.notices.filter(n => n.to === "t" && n.text.includes("could not be woken"))).toHaveLength(2);
  });
});

describe("auth pauses are not woken automatically (2b ⑥)", () => {
  it("one notice, no wake; an explicit wake clears it", () => {
    const { w, c } = setup();
    w.paused.add("t"); w.reasons.set("t", "auth"); w.rows.push(row("t"), row("t"));
    c.scan(); c.scan();
    expect(w.wakes).toEqual([]);
    expect(w.notices.filter(n => n.text.includes("login failed"))).toHaveLength(1);
  });

  it("idle / warm_cap / operator / error pauses are woken", () => {
    for (const reason of ["idle", "warm_cap", "operator", "error", null]) {
      const { w, c } = setup();
      w.paused.add("t"); w.reasons.set("t", reason); w.rows.push(row("t"));
      c.scan();
      expect(w.wakes, String(reason)).toEqual(["t"]);
    }
  });
});

describe("hard cap with atomic reservation (2b ⑧ ⑪)", () => {
  it("one slot left, two targets want it, both spawns held: only one starts", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const { w, c } = setup({ cap: 1, overflow: 1, wakeImpl: t => { const g = deferred(); gates.set(t, g); return g.promise; } });
    w.resident.add("busy"); // one of the two hard slots is taken
    w.paused.add("a"); w.paused.add("b");
    w.rows.push(row("a"), row("b"));
    c.scan();
    expect(w.wakes).toEqual(["a"]);
    expect(c.reservedCount).toBe(1);
    // a failure returns exactly that slot; b then gets it
    gates.get("a")!.fail(new Error("boom")); await settle();
    expect(c.reservedCount).toBe(0);
    c.scan();
    expect(w.wakes).toEqual(["a", "b"]);
  });

  it("a successful wake is counted once (reserved → resident), and a later pause frees the slot", async () => {
    const gate = deferred();
    const { w, c } = setup({ cap: 1, overflow: 0, wakeImpl: () => gate.promise });
    w.paused.add("a"); w.paused.add("b");
    w.rows.push(row("a"), row("b"));
    c.scan();
    expect(w.wakes).toEqual(["a"]);
    // While waking, a may already show as resident (the daemon went active
    // before the flight settled): still one slot, never two.
    w.resident.add("a");
    expect((c as any).freeSlots()).toBe(0);
    gate.release(); await settle();
    expect(c.reservedCount).toBe(0);
    expect((c as any).freeSlots()).toBe(0);
    c.scan();
    expect(w.wakes).toEqual(["a"]); // b waits: no slot
    w.resident.delete("a"); w.paused.add("a"); // a paused again
    w.rows.splice(0, 1); // a's work is done
    c.scan();
    expect(w.wakes).toEqual(["a", "b"]);
  });

  it("many targets, some held forever: residents + reservations stay ≤ cap + overflow; rows are kept", async () => {
    const { w, c } = setup({ cap: 2, overflow: 2, wakeImpl: () => new Promise<void>(() => {}) });
    for (const t of ["a", "b", "c", "d", "e", "f"]) { w.paused.add(t); w.rows.push(row(t)); }
    c.scan(); c.scan();
    expect(w.wakes).toHaveLength(4);
    expect(c.reservedCount + w.resident.size).toBeLessThanOrEqual(4);
    expect(w.rows).toHaveLength(6);
  });

  it("warm_cap 0 means no cap at all (current semantics)", () => {
    const { w, c } = setup({ cap: 0 });
    for (const t of ["a", "b", "c"]) { w.paused.add(t); w.rows.push(row(t)); w.resident.add(`r-${t}`); }
    c.scan();
    expect(w.wakes).toHaveLength(3);
  });
});

describe("park: a woken target that will not take its work (2b ⑩ ⑫)", () => {
  it("parks after the pre-claim window, is not re-woken by new admissions, and re-wakes after the park", () => {
    const { w, c } = setup();
    w.rows.push(row("t"));
    w.wokeAt.set("t", clock);
    w.holdReason.set("t", "a dialog is holding its input");
    clock += PRECLAIM_WINDOW_MS;
    c.scan();
    expect(c.isParked("t")).toBe(true);
    // evicted while parked, and a new message arrives: still no automatic wake
    w.paused.add("t");
    w.rows.push(row("t"));
    c.scan();
    expect(w.wakes).toEqual([]);
    clock += PARK_BASE_MS;
    c.scan();
    expect(w.wakes).toEqual(["t"]);
  });

  it("park length doubles while the hold persists, up to 30 min, and resets on a delivery", () => {
    const { w, c } = setup();
    w.rows.push(row("t"));
    const spans: number[] = [];
    for (let i = 0; i < 7; i++) {
      w.wokeAt.set("t", clock);
      clock += PRECLAIM_WINDOW_MS;
      c.scan();
      const until = (c as any).states.get("t").parkedUntil;
      spans.push(until - clock);
      clock = until;
    }
    expect(spans).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);
    c.noteDelivered("t");
    expect(c.isParked("t")).toBe(false);
    expect((c as any).states.get("t").parkLevel).toBe(0);
  });

  it("fresh work for a long-awake target is not mistaken for a hold", () => {
    const { w, c } = setup();
    w.wokeAt.set("t", clock - 24 * 60 * 60_000);
    w.rows.push(row("t")); // admitted just now
    c.scan();
    expect(c.isParked("t")).toBe(false);
  });

  it("an explicit wake lifts the park at once; a normal admission does not", () => {
    const { w, c } = setup();
    w.rows.push(row("t"));
    w.wokeAt.set("t", clock);
    clock += PRECLAIM_WINDOW_MS;
    c.scan();
    w.paused.add("t"); w.reasons.set("t", "idle");
    w.rows.push(row("t"));
    c.scan();
    expect(w.wakes).toEqual([]);
    c.noteExternalWake("t");
    c.scan();
    expect(w.wakes).toEqual(["t"]);
  });

  it("an auth park, then paused: after the login is fixed an explicit wake clears the auth hold", () => {
    const { w, c } = setup();
    w.paused.add("t"); w.reasons.set("t", "auth"); w.rows.push(row("t"));
    c.scan();
    expect(w.wakes).toEqual([]);
    c.noteExternalWake("t");
    w.reasons.set("t", null); // the operator's wake path (lifecycle) clears the marker reason
    c.scan();
    expect(w.wakes).toEqual(["t"]);
  });
});

describe("claim-block visibility (design §1.4)", () => {
  it("queued work on an awake but blocked target is reported once per episode after 5 minutes", () => {
    const { w, c } = setup();
    w.rows.push(row("t"));
    w.holdReason.set("t", "a dialog is holding its input");
    clock += CLAIM_BLOCK_NOTICE_MS - 1;
    c.scan();
    expect(w.notices).toEqual([]);
    clock += 1;
    c.scan(); c.scan();
    expect(w.notices.filter(n => n.text.includes("waiting"))).toHaveLength(1);
  });
});


describe("the pump is told when a target becomes claimable", () => {
  it("after a successful wake, and on a scan that finds an awake target with waiting work", async () => {
    const { w, c } = setup();
    w.paused.add("t"); w.rows.push(row("t"));
    c.scan(); await settle();
    expect(w.pumpKicks).toBe(1);
    c.scan(); // now awake with the row still queued
    expect(w.pumpKicks).toBe(2);
  });

  it("a failed wake does not kick it", async () => {
    const { w, c } = setup({ wakeImpl: async () => { throw new Error("x"); } });
    w.paused.add("t"); w.rows.push(row("t"));
    c.scan(); await settle();
    expect(w.pumpKicks).toBe(0);
  });
});


describe("passive kinds (none today) — the whole-queue rule", () => {
  afterEach(() => { (PASSIVE_KINDS as Set<string>).delete("x_passive"); });
  it("a passive head does not hide a wake-eligible row behind it; passive-only work does not wake", () => {
    (PASSIVE_KINDS as Set<string>).add("x_passive");
    const mixed = setup();
    mixed.w.paused.add("t"); mixed.w.rows.push(row("t", "x_passive"), row("t", "fleet_inbound"));
    mixed.c.scan();
    expect(mixed.w.wakes).toEqual(["t"]);
    const passive = setup();
    passive.w.paused.add("t"); passive.w.rows.push(row("t", "x_passive"));
    passive.c.scan();
    expect(passive.w.wakes).toEqual([]);
  });
});


describe("the scan never throws from its timer (#1078 CI)", () => {
  it("a failing pending-queue read (e.g. the outbox database already closed) is logged, not thrown", () => {
    const { c } = setup();
    const deps = (c as any).deps;
    deps.listPending = () => { throw new TypeError("The database connection is not open"); };
    expect(() => c.scan()).not.toThrow();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: "The database connection is not open" }), expect.any(String));
  });
});


describe("lifecycle: nothing runs once the outbox is gone or the coordinator stopped (#1078 CI)", () => {
  it("stop() clears every timer it owns, and kick/scan are no-ops afterwards", () => {
    vi.useFakeTimers();
    const { w, c } = setup();
    c.start(); // watchdog interval + an immediate scan timer
    c.kick(5_000);
    expect(vi.getTimerCount()).toBe(2);
    c.stop();
    expect(vi.getTimerCount()).toBe(0); // cleared, not merely forgotten
    expect((c as any).watchdog).toBeNull();
    expect((c as any).scanTimer).toBeNull();
    w.paused.add("t"); w.rows.push(row("t"));
    c.kick(); c.scan();
    expect((c as any).scanTimer).toBeNull();
    expect(w.wakes).toEqual([]);
  });

  it("an unavailable outbox: the scan does not read it and the coordinator stops itself", () => {
    const { w, c } = setup();
    const listPending = vi.spyOn((c as any).deps, "listPending");
    w.available = false;
    w.paused.add("t"); w.rows.push(row("t"));
    c.scan();
    expect(listPending).not.toHaveBeenCalled();
    expect(w.wakes).toEqual([]);
    expect((c as any).stopped).toBe(true);
  });

  it("a kick with the outbox unavailable schedules nothing", () => {
    const { w, c } = setup();
    w.available = false;
    c.kick(); c.kick(5_000);
    expect((c as any).scanTimer).toBeNull();
    expect((c as any).stopped).toBe(true);
  });

  it("a wake that settles after stop() does not kick the pump", async () => {
    const gate = deferred();
    const { w, c } = setup({ wakeImpl: () => gate.promise });
    w.paused.add("t"); w.rows.push(row("t"));
    c.scan();
    c.stop();
    gate.release(); await settle();
    expect(w.pumpKicks).toBe(0);
  });
});


describe("stop() fences outstanding wake completions (#1078 review P2-5)", () => {
  it("a wake that resolves after stop: no pump kick, no state change, slot still returned once", async () => {
    const g = deferred();
    const { w, c } = setup({ wakeImpl: () => g.promise });
    w.paused.add("t"); w.rows.push(row("t"));
    c.scan();
    (c as any).states.get("t").failures = 2;
    c.stop();
    g.release(); await settle(); await settle();
    expect(w.pumpKicks).toBe(0);
    expect((c as any).states.get("t").failures).toBe(2);
    expect(c.reservedCount).toBe(0);
  });

  it("a wake that rejects after stop (would be the 3rd failure): no notices, slot returned", async () => {
    const g = deferred();
    const { w, c } = setup({ wakeImpl: () => g.promise });
    w.paused.add("t"); w.rows.push(row("t"));
    c.scan();
    (c as any).states.get("t").failures = 2;
    c.stop();
    g.fail(new Error("spawn failed")); await settle(); await settle();
    expect(w.notices).toEqual([]);
    expect((c as any).states.get("t").failures).toBe(2);
    expect(c.reservedCount).toBe(0);
  });
});


describe.each(["en", "zh-TW"] as const)("queue notifications in %s", locale => {
  beforeEach(() => setLocale(locale));
  it("localizes login holds and long queue waits", () => {
    const { w, c } = setup();
    w.paused.add("auth"); w.reasons.set("auth", "auth"); w.rows.push(row("auth"));
    c.scan();
    expect(w.notices[0]!.text).toContain(locale === "en" ? "login failed" : "登入失敗");
    expect(w.notices[0]!.text).toContain("/wake");
    expect(w.wakes).toEqual([]);
    w.rows.push(row("busy")); w.holdReason.set("busy", "dialog");
    clock += CLAIM_BLOCK_NOTICE_MS;
    c.scan();
    const wait = w.notices.find(n => n.to === "busy")!;
    expect(wait.text).toContain(locale === "en" ? "message(s) waiting" : "筆訊息已等了");
    expect(wait.text).toContain("dialog");
    expect(wait.text).not.toContain("queued message(s)");
  });
  it("localizes wake failure for both topics without losing retries", async () => {
    const { w, c } = setup({ wakeImpl: async () => { throw new Error("spawn failed"); } });
    w.paused.add("t"); w.rows.push(row("t"));
    for (let i = 0; i < 3; i++) {
      c.scan(); await settle();
      clock = (c as any).states.get("t").backoffUntil;
    }
    expect(w.notices.map(n => n.to).sort()).toEqual(["sender", "t"]);
    for (const n of w.notices) {
      expect(n.text).toContain(locale === "en" ? "3 attempts" : "嘗試 3 次");
      expect(n.text).toContain(locale === "en" ? "will try again" : "系統會再試");
      expect(n.text).not.toContain("spawn failed.");
    }
    expect(w.rows[0]!.state).toBe("queued");
    expect(w.rows[0]!.attemptNo).toBe(0);
  });
});
