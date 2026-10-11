/**
 * #1641: after a fleet restart, sol's codex (0.160.0) sat at its idle composer under the native-only footer
 * `⚠ 2 warnings · f2 to view` — the #1031 shape. The first reading was `working`, the static pane became `stuck` after
 * the stuck window, and `stuck` had no way out: a quiet stuck pane was never read differently, and the pump never claims
 * for a target that is not accepting, so #1031's delivery fallback never ran. Five deliveries sat at attempt 0 for hours.
 *
 * The rollout knew: its turn ended at 18:26:41Z and nothing started until the manual restart. So:
 * - a stuck pane that shows the backend's own live, empty composer recovers when the transcript shows no open turn — or,
 *   with no transcript followed, when that composer holds still for #978's window; an open turn never recovers;
 * - an open, still-moving turn keeps every pane reading out of idle (codex hides its status row while streaming);
 * - a waiting delivery says why (`waiting_reason`), and an always-on target's blocked queue is reported once.
 * Fixtures: tests/fixtures/codex-0160-false-stuck-1641 (sol's real stream and rollout).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon, PaneStateMachine, TRANSCRIPT_OPEN_TURN_QUIET_MS, UNKNOWN_LAYOUT_STABLE_MS } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import type { TranscriptTurnEvent } from "../src/transcript-turns.js";
import { ALWAYS_ON_BLOCK_NOTICE_MS, WakeCoordinator, type WakeCoordinatorDeps } from "../src/wake-coordinator.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";
import type { OutboxDelivery } from "../src/delivery-outbox.js";

const FIX = fileURLToPath(new URL("./fixtures/codex-0160-false-stuck-1641/", import.meta.url));
const IDLE_LOOKING = readFileSync(join(FIX, "warnings-footer-idle-composer.pane.txt"), "utf8");
const WORKING = readFileSync(join(FIX, "working-0s-warnings-footer.pane.txt"), "utf8");
const READY_0156 = readFileSync(fileURLToPath(new URL("./fixtures/codex-0156-ready.pane.txt", import.meta.url)), "utf8");
/** Sol's real turn records, in rollout order — mapped as the codex rollout source maps them (#1510). */
const ROLLOUT: TranscriptTurnEvent[] = readFileSync(join(FIX, "rollout-task-events.jsonl"), "utf8").trim().split("\n").map(line => {
  const p = JSON.parse(line).payload;
  return p.type === "task_started" ? { kind: "start", turnId: p.turn_id } : { kind: "end", turnId: p.turn_id, end: "complete" };
});
const [STARTED_0237, ENDED_0226, STARTED_2225, ENDED_2241] = ROLLOUT;

const STUCK_MS = 60_000;
/** The safety sweep's interval: what separates two of these captures in life. */
const SWEEP_MS = 60_000;
const dirs: string[] = [];
let now = Date.parse("2026-10-11T09:28:15Z");
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); setLocale("en"); });
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const advance = (ms: number) => { now += ms; vi.setSystemTime(now); };

function harness(pane: string, opts: { following?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-1641-"));
  dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@7");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backend = new CodexBackend(dir);
  const daemon = new Daemon("agend-dev-sol", {
    working_directory: "/tmp", backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, backend as any, undefined, { child: () => logger } as any) as any;
  const state = { pane };
  daemon.tmux = { capturePane: async () => state.pane, isWindowAlive: async () => true, getWindowId: () => "@7" };
  daemon.controlClient = { isIdle: () => true, hasOutputSince: () => false, getLastOutputAt: () => 0, getObservationResetAt: () => 0 };
  daemon.instanceStateMachine = new PaneStateMachine(backend.getReadyPattern(), STUCK_MS, Date.now(), backend.getBusyPattern());
  daemon.instanceStateMonitorActive = true;
  daemon.transcriptMonitor = { following: () => opts.following !== false };
  const sweep = () => daemon.captureAndEvaluateInstanceState("safety_sweep");
  const rollout = (...events: TranscriptTurnEvent[]) => { daemon.transcriptTurns.observe(events, Date.now()); daemon.transcriptActivityAt = Date.now(); };
  const recovered = () => logger.info.mock.calls.some(([, msg]) => typeof msg === "string" && msg.startsWith("Stuck instance recovered"));
  return { daemon, state, sweep, rollout, recovered, logger };
}

/** Sol from 17:28: the restart's first reading of its Context-less idle pane, then the pane holding still. */
async function solAfterRestart(h: ReturnType<typeof harness>) {
  await h.sweep();
  expect(h.daemon.instanceState).toBe("working");      // the #1031 footer is not a ready proof — as designed
  advance(STUCK_MS + 1_000);
}

describe("#1641: a stuck instance that is in fact idle comes back", () => {
  it("sol's case: the rollout's turn ended, the composer is idle → the next sweep recovers it (not stuck for hours)", async () => {
    const h = harness(IDLE_LOOKING);
    h.rollout(STARTED_0237, ENDED_0226);
    await solAfterRestart(h);
    await h.sweep();
    expect([h.daemon.instanceState, h.recovered()]).toEqual(["idle", true]);
    expect(h.daemon.notAcceptingReason()).toBeNull();      // the pump may claim its queued deliveries again
  });

  it("an open turn in the rollout never recovers: that CLI is running (no paste into it)", async () => {
    const h = harness(IDLE_LOOKING);
    h.rollout(STARTED_2225);
    await solAfterRestart(h);
    h.rollout();                                          // still moving
    await h.sweep();
    expect([h.daemon.instanceState, h.recovered()]).toEqual(["stuck", false]);
  });

  it("an open turn whose rollout went quiet (a missed end) no longer pins it: the #978 stable window decides", async () => {
    const h = harness(IDLE_LOOKING);
    h.rollout(STARTED_2225);
    advance(TRANSCRIPT_OPEN_TURN_QUIET_MS);
    await solAfterRestart(h);
    await h.sweep();                                      // stuck; the composer starts its stable window
    expect(h.daemon.instanceState).toBe("stuck");
    advance(UNKNOWN_LAYOUT_STABLE_MS);
    await h.sweep();
    expect([h.daemon.instanceState, h.recovered()]).toEqual(["idle", true]);
  });

  it("no rollout followed: the same composer held still for the #978 window recovers; one that changes does not", async () => {
    const h = harness(IDLE_LOOKING, { following: false });
    await solAfterRestart(h);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("stuck");
    h.state.pane = IDLE_LOOKING.replace("I’ll check", "I will check");   // the screen moved: not stuck, and no recovery
    advance(UNKNOWN_LAYOUT_STABLE_MS);
    await h.sweep();
    expect([h.daemon.instanceState, h.recovered()]).toEqual(["working", false]);
    advance(STUCK_MS + 1_000);                                              // still again, stuck again
    await h.sweep();
    expect([h.daemon.instanceState, h.recovered()]).toEqual(["stuck", false]);
    advance(UNKNOWN_LAYOUT_STABLE_MS);
    await h.sweep();
    expect([h.daemon.instanceState, h.recovered()]).toEqual(["idle", true]);
  });

  it("with no transcript to ask, a composer seen still for less than the #978 window does not recover yet", async () => {
    const h = harness(IDLE_LOOKING, { following: false });
    await solAfterRestart(h);
    await h.sweep();
    advance(UNKNOWN_LAYOUT_STABLE_MS - 1_000);
    await h.sweep();
    expect([h.daemon.instanceState, h.recovered()]).toEqual(["stuck", false]);
    advance(1_000);
    await h.sweep();
    expect([h.daemon.instanceState, h.recovered()]).toEqual(["idle", true]);
  });

  it("a busy row (`• Working (0s …)`) never recovers, whatever the rollout says", async () => {
    const h = harness(WORKING);
    h.rollout(STARTED_0237, ENDED_0226);
    await solAfterRestart(h);
    await h.sweep();
    advance(UNKNOWN_LAYOUT_STABLE_MS);
    await h.sweep();
    expect([h.daemon.instanceState, h.recovered()]).toEqual(["stuck", false]);
  });
});

describe("#1641: the transcript outranks the pane while a turn is running", () => {
  it("a pane that reads ready stays working while the rollout shows the turn open, and goes idle once it ends", async () => {
    const h = harness(READY_0156);
    h.rollout(STARTED_2225);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("working");
    h.rollout(ENDED_2241);
    advance(SWEEP_MS);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("idle");
  });

  it("an open turn gone quiet past TRANSCRIPT_OPEN_TURN_QUIET_MS is unknown: the pane decides again", async () => {
    const h = harness(READY_0156);
    h.rollout(STARTED_2225);
    advance(TRANSCRIPT_OPEN_TURN_QUIET_MS);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("idle");
  });

  it("not following a rollout changes nothing: the pane alone decides, as before", async () => {
    const h = harness(READY_0156, { following: false });
    h.rollout(STARTED_2225);                              // a ledger entry without a followed file proves nothing
    await h.sweep();
    expect(h.daemon.instanceState).toBe("idle");
  });
});

describe("#1641: a stuck target with waiting work is visible", () => {
  let seq = 0;
  let clock = 5_000_000;
  const row = (target: string, extra: Partial<OutboxDelivery> = {}): OutboxDelivery => ({
    deliveryId: `d${++seq}`, operationId: `op${seq}`, sourceKey: `k${seq}`, sourceInstance: "leader", sourceDaemonBootId: "b",
    targetInstance: target, targetSession: null, targetDaemonBootId: null, kind: "fleet_inbound", correlationId: null, payload: {},
    state: "queued", attemptNo: 0, createdSeq: seq, managerBootId: null, responseDeliveredAt: null, nextAttemptAt: null,
    lastError: null, reconciliationPending: false, createdAt: new Date(clock).toISOString(), ...extra,
  } as OutboxDelivery);
  function coordinator(rows: OutboxDelivery[], hold: Map<string, string>) {
    const notices: Array<{ to: string; text: string }> = [];
    const deps: WakeCoordinatorDeps = {
      mode: () => "off" as any, available: () => true, listPending: () => rows.filter(r => r.state !== "delivered"),
      isPaused: () => false, pauseReason: () => null, isRestarting: () => false, wake: async () => {}, residentNames: () => [],
      warmCap: () => 0, warmOverflow: () => 2, wokeAt: () => undefined, notAcceptingReason: t => hold.get(t) ?? null,
      notifyTarget: (to, text) => { notices.push({ to, text }); }, notifySender: () => {}, kickPump: () => {}, now: () => clock,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };
    return { c: new WakeCoordinator(deps), notices };
  }

  it("an always-on target that is not accepting: its topic is told once after 30 min, and again only after it took work", () => {
    const rows = [row("sol"), row("sol")];
    const hold = new Map([["sol", "The CLI appears stuck."]]);
    const { c, notices } = coordinator(rows, hold);
    clock += ALWAYS_ON_BLOCK_NOTICE_MS - 1_000;
    c.scan();
    expect(notices).toEqual([]);
    clock += 1_000;
    c.scan(); c.scan();
    expect(notices).toEqual([{ to: "sol", text: "⚠️ sol has 2 message(s) waiting for 30 minutes.\nReason: The CLI appears stuck." }]);
    hold.delete("sol");                                   // recovered: it takes its work
    c.scan();
    hold.set("sol", "The CLI appears stuck.");            // a new episode
    c.scan();
    expect(notices).toHaveLength(2);
    c.stop();
  });

  it("a target that is simply next in line (no reason) is never reported, however long its queue", () => {
    const { c, notices } = coordinator([row("sol")], new Map());
    clock += 3 * ALWAYS_ON_BLOCK_NOTICE_MS;
    c.scan();
    expect(notices).toEqual([]);
    c.stop();
  });

  it("delivery_status: a queued row says why it waits (`waiting_reason`); a delivered one carries none", () => {
    const item = (state: string) => ({ delivery_id: state, target_instance: "agend-dev-sol", state });
    const fm = Object.create(FleetManager.prototype) as any;
    fm.ensureDeliveryOutbox = () => {};
    fm.deliveryOutbox = { queryStatusForInstance: () => ({ items: [item("queued"), item("retry_wait"), item("delivered")], next_cursor: null }) };
    const stuck = { notAcceptingReason: () => "The CLI appears stuck." as string | null };
    fm.lifecycle = { isPaused: () => false, daemons: new Map([["agend-dev-sol", stuck]]) };
    const page = fm.queryDurableDeliveryStatus("agend-leader", {});
    expect(page.items.map((i: any) => i.waiting_reason)).toEqual(["The CLI appears stuck.", "The CLI appears stuck.", undefined]);
    stuck.notAcceptingReason = () => null;
    expect(fm.queryDurableDeliveryStatus("agend-leader", {}).items[0].waiting_reason).toBeNull();
    fm.lifecycle.isPaused = () => true;
    expect(fm.queryDurableDeliveryStatus("agend-leader", {}).items[0].waiting_reason).toBe("The instance is paused.");
  });
});
