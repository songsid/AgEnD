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
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon, PaneStateMachine, TRANSCRIPT_OPEN_TURN_QUIET_MS, UNKNOWN_LAYOUT_STABLE_MS } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import type { TranscriptTurnEvent } from "../src/transcript-turns.js";
import { CodexRolloutSource, lastRolloutTurnBoundary, ROLLOUT_TURN_SCAN_MAX_BYTES } from "../src/transcript-sources.js";
import { resetSharedRolloutIndexesForTests } from "../src/rollout-index.js";
import { ALWAYS_ON_BLOCK_NOTICE_MS, WakeCoordinator, type WakeCoordinatorDeps } from "../src/wake-coordinator.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";
import type { OutboxDelivery } from "../src/delivery-outbox.js";

const FIX = fileURLToPath(new URL("./fixtures/codex-0160-false-stuck-1641/", import.meta.url));
const IDLE_LOOKING = readFileSync(join(FIX, "warnings-footer-idle-composer.pane.txt"), "utf8");
const WORKING = readFileSync(join(FIX, "working-0s-warnings-footer.pane.txt"), "utf8");
const READY_0156 = readFileSync(fileURLToPath(new URL("./fixtures/codex-0156-ready.pane.txt", import.meta.url)), "utf8");
const LOADING_0159 = readFileSync(fileURLToPath(new URL("./fixtures/codex-0159-resume-loading.pane.txt", import.meta.url)), "utf8");
/** The rollout records themselves, as codex writes them (the source parses these). */
const ROLLOUT_LINES = readFileSync(join(FIX, "rollout-task-events.jsonl"), "utf8").trim().split("\n");
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
const monitors: Array<{ stop(): void }> = [];
// Both clocks are fake: elapsed time moves Date and performance.now together; a wall-clock correction moves Date alone.
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "performance"] }); vi.setSystemTime(Date.parse("2026-10-11T09:28:15Z")); setLocale("en"); });
afterEach(() => {
  for (const m of monitors.splice(0)) m.stop();
  resetSharedRolloutIndexesForTests();
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** Time passing (both clocks). */
const advance = (ms: number) => { vi.advanceTimersByTime(ms); };
/** A wall-clock correction only (NTP, a suspended VM): performance.now does not move. */
const jumpWallClock = (ms: number) => { vi.setSystemTime(Date.now() + ms); };

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
  daemon.transcriptMonitor = { following: () => opts.following !== false, turnStateKnown: () => true };
  const sweep = () => daemon.captureAndEvaluateInstanceState("safety_sweep");
  const rollout = (...events: TranscriptTurnEvent[]) => { daemon.transcriptTurns.observe(events, performance.now()); daemon.transcriptActivityAt = performance.now(); };
  const recoveries = () => logger.info.mock.calls.filter(([, msg]) => typeof msg === "string" && msg.startsWith("Stuck instance recovered")).length;
  const recovered = () => recoveries() > 0;
  return { daemon, state, sweep, rollout, recovered, recoveries, logger, dir };
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

const META = JSON.stringify({ type: "session_meta", payload: { id: "01a0ed7a-923c-7901-814b-3fc596fea75a", cwd: "/tmp" } });
/** History a baseline must never replay: a user message, a tool call and its output, an assistant answer. */
const CHATTER = [
  JSON.stringify({ timestamp: "2026-10-11T14:25:17.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "history-user-text" }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"command\":[\"ls\"]}" } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call_output", name: "shell" } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "history answer" }] } }),
];

describe("#1641 R1: the real rollout source → monitor → daemon, and the edges Prism found", () => {
  beforeEach(() => { resetSharedRolloutIndexesForTests(0); });   // each poll lists the scratch tree afresh
  /** A rollout for cwd /tmp (the harness's working directory) under a scratch sessions dir, read by the REAL source. */
  async function realRollout(h: ReturnType<typeof harness>, history: string[] = []) {
    const sessions = join(h.dir, "sessions"), day = join(sessions, "2026", "10", "11");
    mkdirSync(day, { recursive: true });
    const file = join(day, "rollout-2026-10-11T09-00-00-01a0ed7a-923c-7901-814b-3fc596fea75a.jsonl");
    writeFileSync(file, [META, ...history].map(l => l + "\n").join(""));
    const monitor = h.daemon.buildTranscriptMonitor(new CodexRolloutSource("/tmp", sessions));
    monitors.push(monitor);
    h.daemon.transcriptMonitor = monitor;
    monitor.startPolling(3_600_000);                        // following needs a polling monitor; polls are driven below
    const poll = () => monitor.pollIncrement();
    await poll();                                          // adopts the file at its end
    return { file, poll, append: (line: string) => appendFileSync(file, line + "\n") };
  }

  /** A second rollout for the same cwd, newer than the first: what a restarted codex writes. */
  function newerRollout(h: ReturnType<typeof harness>, lines: string[] = []) {
    const file = join(h.dir, "sessions", "2026", "10", "11", "rollout-2026-10-11T10-00-00-01a0ed7b-0000-7000-8000-000000000000.jsonl");
    writeFileSync(file, [META, ...lines].map(l => l + "\n").join(""));
    const later = (statSync(file).mtimeMs + 3_600_000) / 1000;   // file times are real time (Date is faked here)
    utimesSync(file, later, later);
    return file;
  }

  it("R2 P1: a turn already running when the source attached (task_started before the EOF baseline) holds the pane working", async () => {
    for (const [history, want] of [
      [[ROLLOUT_LINES[0]!, ROLLOUT_LINES[1]!, ROLLOUT_LINES[2]!, ...CHATTER], "working"],   // Prism's witness: open at attach
      [[ROLLOUT_LINES[2]!, ...CHATTER, ROLLOUT_LINES[3]!], "idle"],                       // control: it had ended
      [[], "idle"],                                                                        // no turn ever started: known closed
    ] as const) {
      const h = harness(READY_0156);
      const tools: unknown[] = [];
      const r = await realRollout(h, [...history]);
      h.daemon.transcriptMonitor.on("tool_use", (name: string) => tools.push(name));
      h.daemon.transcriptMonitor.on("assistant_text", (text: string) => tools.push(text));
      await r.poll();
      await h.sweep();
      expect(h.daemon.instanceState, JSON.stringify(history.map(l => l.slice(0, 60)))).toBe(want);
      // Only the boundary is carried in: no tool, text or user record of the history is replayed.
      expect(tools).toEqual([]);
      expect(h.daemon.transcriptTurns.verdict("history-user-text", 0)).toBe("unknown");
    }
  });

  it("R2 P1: the carried-in turn ends when its task_complete arrives, and a steer after the baseline belongs to it", async () => {
    const h = harness(READY_0156);
    const r = await realRollout(h, [ROLLOUT_LINES[2]!, ...CHATTER]);
    const steer = JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "steer-after-baseline" }] } });
    const armedAt = Date.now();
    r.append(steer); await r.poll();
    await h.sweep();
    expect(h.daemon.instanceState).toBe("working");
    expect(h.daemon.transcriptTurns.verdict("steer-after-baseline", armedAt)).toBe("running");
    r.append(ROLLOUT_LINES[3]!); await r.poll();
    advance(SWEEP_MS);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("idle");
    expect(h.daemon.transcriptTurns.verdict("steer-after-baseline", armedAt)).toBe("ended");
  });

  it("R2 P1: the boundary scan reads across chunks and stops at its bound: beyond it the state is unknown, not closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1641-scan-"));
    dirs.push(dir);
    const file = join(dir, "r.jsonl");
    for (const tail of [1, 128 * 1024, 256 * 1024 - 200, 256 * 1024 + 300, 700 * 1024]) {
      // The boundary line lands before, across and after the 256 KiB chunk edge, under `tail` bytes of later records.
      const filler = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(tail) }] } });
      writeFileSync(file, [META, ROLLOUT_LINES[0]!, ROLLOUT_LINES[2]!, filler].map(l => l + "\n").join(""));
      const size = readFileSync(file).length;
      expect(await lastRolloutTurnBoundary(file, size), `tail ${tail}`).toEqual({ kind: "start", turnId: "01a12b5a-8a28-7c71-be92-80abb14607e2" });
      expect(await lastRolloutTurnBoundary(file, size, tail + 10), `bound ${tail}`).toBeNull();
    }
    writeFileSync(file, [META, ROLLOUT_LINES[2]!, ROLLOUT_LINES[3]!].map(l => l + "\n").join(""));
    expect(await lastRolloutTurnBoundary(file, readFileSync(file).length)).toEqual({ kind: "end", turnId: "01a12b5a-8a28-7c71-be92-80abb14607e2" });
    writeFileSync(file, META + "\n");
    expect(await lastRolloutTurnBoundary(file, readFileSync(file).length)).toEqual({ kind: "none" });
  });

  it("R2 P1: an unknown baseline (no boundary within the scan) keeps the old fallbacks — the pane decides, recovery waits #978's window", async () => {
    const h = harness(IDLE_LOOKING);
    // A turn that started more than the scan bound before the baseline: its start is out of reach.
    const filler = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(ROLLOUT_TURN_SCAN_MAX_BYTES) }] } });
    const r = await realRollout(h, [ROLLOUT_LINES[0]!, ROLLOUT_LINES[1]!, filler]);
    await r.poll();
    expect([h.daemon.transcriptMonitor.following(), h.daemon.transcriptMonitor.turnStateKnown()]).toEqual([true, false]);
    await solAfterRestart(h);
    await h.sweep();
    expect([h.daemon.instanceState, h.recovered()]).toEqual(["stuck", false]);   // not "closed": no instant recovery
    advance(UNKNOWN_LAYOUT_STABLE_MS);
    await h.sweep();
    expect([h.daemon.instanceState, h.recovered()]).toEqual(["idle", true]);
    // The next boundary read makes it known again: a turn starting holds the pane, its end releases it.
    for (const [line, known, want] of [[ROLLOUT_LINES[2]!, true, "working"], [ROLLOUT_LINES[3]!, true, "idle"]] as const) {
      (h.daemon.transcriptMonitor as any).source.turnKnown = false;     // each boundary on its own proves the state
      r.append(line); await r.poll();
      expect(h.daemon.transcriptMonitor.turnStateKnown()).toBe(known);
      advance(SWEEP_MS);
      await h.sweep();
      expect(h.daemon.instanceState === "stuck" ? "working" : h.daemon.instanceState).toBe(want);   // held busy may read stuck
    }
  });

  it("R2 P2: a switch to a newer rollout withdraws the old one's open turn; a turn open in the new one still holds", async () => {
    for (const [newLines, want] of [
      [[], "idle"],                                   // Prism's witness: A's open turn must not keep vetoing
      [[ROLLOUT_LINES[2]!.replace(/01a12b5a/g, "01a12b5c")], "working"],   // B's own open turn does
    ] as const) {
      const h = harness(READY_0156);
      const r = await realRollout(h);
      r.append(ROLLOUT_LINES[2]!); await r.poll();
      await h.sweep();
      expect(h.daemon.instanceState).toBe("working");
      newerRollout(h, [...newLines]);
      await r.poll();
      expect(h.daemon.transcriptMonitor.turnStateKnown()).toBe(true);   // B is new: read from its start, every boundary seen
      advance(SWEEP_MS);
      await h.sweep();
      // Held busy reads `stuck` here (the still pane outlived STUCK_MS) — busy either way, never idle.
      const read = h.daemon.instanceState === "stuck" ? "working" : h.daemon.instanceState;
      expect(read, `B holds ${newLines.length} records`).toBe(want);
    }
  });

  it("R2 P2: Prism's control — A ends first, then B: idle; and a switch noticed by a checkpoint withdraws A's turn too", async () => {
    const h = harness(READY_0156);
    const r = await realRollout(h);
    const armedAt = Date.now();
    r.append(ROLLOUT_LINES[2]!); r.append(CHATTER[0]!.replace(/"timestamp":"[^"]*"/, `"timestamp":"${new Date().toISOString()}"`));
    r.append(ROLLOUT_LINES[3]!); await r.poll();
    newerRollout(h); await r.poll();
    await h.sweep();
    expect(h.daemon.instanceState).toBe("idle");
    // Only an OPEN turn is withdrawn: one that ended in A keeps its verdict for the reply guard.
    expect(h.daemon.transcriptTurns.verdict("history-user-text", armedAt)).toBe("ended");

    const h2 = harness(READY_0156);
    const r2 = await realRollout(h2);
    r2.append(ROLLOUT_LINES[2]!); await r2.poll();
    await h2.sweep();
    expect(h2.daemon.instanceState).toBe("working");
    newerRollout(h2);
    expect(await h2.daemon.transcriptMonitor.reconciliationCheckpoint()).not.toBeNull();   // the switch happens here
    await r2.poll();
    advance(SWEEP_MS);
    await h2.sweep();
    expect(h2.daemon.instanceState).toBe("idle");
  });

  it("R2 P2: a re-baseline of the same rollout drops what was read and re-derives the turn from the file", async () => {
    for (const [lines, want] of [[[ROLLOUT_LINES[2]!], "working"], [[ROLLOUT_LINES[2]!, ROLLOUT_LINES[3]!], "idle"]] as const) {
      const h = harness(READY_0156);
      const r = await realRollout(h);
      for (const l of lines) r.append(l);
      await r.poll();
      h.daemon.transcriptMonitor.resetOffset();
      expect(h.daemon.transcriptTurns.openSince()).toBeNull();          // withdrawn with the re-baseline
      await r.poll();                                                    // re-adopted at its end: the scan decides
      advance(SWEEP_MS);
      await h.sweep();
      expect(h.daemon.instanceState, `${lines.length} records`).toBe(want);
    }
  });

  /** The delivery path's own checkpoint (durableAttemptEvidence → reconciliationCheckpoint), as before a pane write. */
  const deliveryCheckpoint = (h: ReturnType<typeof harness>) => h.daemon.durableAttemptEvidence(undefined, false, false);

  it("R3 P1: a checkpoint that moves past a task_started in the same rollout hands it to the ledger — it is never skipped", async () => {
    const h = harness(READY_0156);
    const r = await realRollout(h);
    const tools: unknown[] = [];
    h.daemon.transcriptMonitor.on("tool_use", (name: string) => tools.push(name));
    await h.sweep();
    expect(h.daemon.instanceState).toBe("idle");                      // control: A holds no turn
    const armedAt = Date.now();
    const steer = JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "skipped-steer" }] } });
    r.append(ROLLOUT_LINES[2]!); r.append(steer); r.append(CHATTER[1]!);
    await deliveryCheckpoint(h);                                     // Prism's witness (a): no poll in between
    await h.sweep();
    expect(h.daemon.instanceState).toBe("working");
    expect(h.daemon.transcriptTurns.verdict("skipped-steer", armedAt)).toBe("running");   // user records are taken too
    expect(tools).toEqual([]);                                        // tool and text records stay skipped, as before
    await r.poll();
    advance(1_000);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("working");                   // and the next poll does not lose it
    r.append(ROLLOUT_LINES[3]!); await r.poll();
    advance(SWEEP_MS);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("idle");
  });

  it("R3 P1: a checkpoint that switches to a newer rollout carries its open turn in before it returns; a completed one stays idle", async () => {
    for (const [lines, want] of [
      [[ROLLOUT_LINES[2]!], "working"],                               // Prism's witness (b)
      [[ROLLOUT_LINES[2]!, ROLLOUT_LINES[3]!], "idle"],                // control: B's turn completed
    ] as const) {
      const h = harness(READY_0156);
      await realRollout(h);
      await h.sweep();
      expect(h.daemon.instanceState).toBe("idle");
      newerRollout(h, [...lines]);
      const evidence = await deliveryCheckpoint(h);
      expect(JSON.stringify(evidence)).toContain("01a0ed7b");          // the checkpoint is B's
      await h.sweep();
      expect(h.daemon.instanceState, `B holds ${lines.length}`).toBe(want);
      await (h.daemon.transcriptMonitor as any).pollIncrement();       // and a poll after it agrees
      advance(1_000);
      await h.sweep();
      expect(h.daemon.instanceState, `B holds ${lines.length}, polled`).toBe(want);
    }
  });

  it("P1-1: open → working, closed → idle, through the real source; a lost rollout is unknown (the pane decides)", async () => {
    const h = harness(READY_0156);
    const r = await realRollout(h);
    expect(h.daemon.transcriptMonitor.following()).toBe(true);
    r.append(ROLLOUT_LINES[2]!); await r.poll();           // task_started
    await h.sweep();
    expect(h.daemon.instanceState).toBe("working");
    r.append(ROLLOUT_LINES[3]!); await r.poll();           // task_complete
    advance(SWEEP_MS);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("idle");
    r.append(ROLLOUT_LINES[2]!.replace(/01a12b5a/g, "01a12b5b")); await r.poll();   // another turn starts
    unlinkSync(r.file); await r.poll();                    // and the rollout disappears: not following any more
    expect(h.daemon.transcriptMonitor.following()).toBe(false);
    advance(SWEEP_MS);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("idle");
  });

  it("P1-1: a monitor that is not polling is not following, whatever its source last read", async () => {
    const h = harness(READY_0156);
    const r = await realRollout(h);
    r.append(ROLLOUT_LINES[2]!); await r.poll();
    h.daemon.transcriptMonitor.stop();
    expect(h.daemon.transcriptMonitor.following()).toBe(false);
  });

  it("P1-2: output that overtook the probe cannot keep an idle-looking pane idle while a turn is open", async () => {
    for (const open of [true, false]) {
      const h = harness(READY_0156);
      await h.sweep();
      expect(h.daemon.instanceState).toBe("idle");
      if (open) h.rollout(STARTED_2225);
      let release!: (pane: string) => void;
      h.daemon.tmux.capturePane = () => new Promise<string>(r => { release = r; });
      const expected = Date.now();
      h.daemon.instanceStateLastOutputAt = expected;
      const probe = h.daemon.captureAndEvaluateInstanceState("output_probe", expected);
      advance(1);
      h.daemon.instanceStateLastOutputAt = Date.now();     // more output while the capture was in flight
      release(READY_0156);
      await probe;
      expect(h.daemon.instanceState, open ? "open turn" : "cosmetic output, no turn").toBe(open ? "working" : "idle");
    }
  });

  it("P2-1: once recovered, a still pane stays idle sweep after sweep — one recovery logged, no flapping back to stuck", async () => {
    const h = harness(IDLE_LOOKING, { following: false });
    await solAfterRestart(h);
    await h.sweep();
    advance(UNKNOWN_LAYOUT_STABLE_MS);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("idle");
    const states: string[] = [];
    for (let i = 0; i < 3; i++) { advance(SWEEP_MS); await h.sweep(); states.push(h.daemon.instanceState); }
    expect([states, h.recoveries()]).toEqual([["idle", "idle", "idle"], 1]);
  });

  it("P2-2: codex's resume load (the #1031 transient) never recovers, however long it holds; the idle composer does", async () => {
    const h = harness(LOADING_0159, { following: false });
    h.daemon.spawnGeneration++;
    h.daemon.inputTransientGuardGeneration = h.daemon.spawnGeneration;
    expect(h.daemon.inputTransientInPane(LOADING_0159)).toBeTruthy();
    await solAfterRestart(h);
    await h.sweep();
    advance(UNKNOWN_LAYOUT_STABLE_MS);
    await h.sweep();
    expect([h.daemon.instanceState, h.recovered()]).toEqual(["stuck", false]);
  });

  it("P2-3: the open-turn hold runs on elapsed time — a wall-clock jump, forward or back, does not end it", async () => {
    const h = harness(READY_0156);
    h.rollout(STARTED_2225);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("working");
    // (The pane's own stuck timer is wall-clock and older than #1641, so a forward jump may read it stuck; what
    // matters here is that the hold is not lifted: never idle while the turn is open.)
    jumpWallClock(TRANSCRIPT_OPEN_TURN_QUIET_MS + 1);
    await h.sweep();
    expect(h.daemon.instanceState).not.toBe("idle");
    jumpWallClock(-2 * TRANSCRIPT_OPEN_TURN_QUIET_MS);
    await h.sweep();
    expect(h.daemon.instanceState).not.toBe("idle");
    jumpWallClock(TRANSCRIPT_OPEN_TURN_QUIET_MS - 1);        // the wall clock back where it was (older wall-clock timers aside)
    advance(TRANSCRIPT_OPEN_TURN_QUIET_MS);                 // real elapsed quiet: the pane decides
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

  it("P2-4: a delivered queue ends the episode — the next blocked queue is reported again after its own 30 min", () => {
    const rows = [row("sol")];
    const hold = new Map([["sol", "The CLI appears stuck."]]);
    const { c, notices } = coordinator(rows, hold);
    clock += ALWAYS_ON_BLOCK_NOTICE_MS;
    c.scan(); c.scan();
    expect(notices).toHaveLength(1);
    rows[0]!.state = "delivered" as any;
    c.noteDelivered("sol");
    c.scan();                                             // nothing pending: the scan never visits the target
    rows.push(row("sol"));
    clock += ALWAYS_ON_BLOCK_NOTICE_MS;
    c.scan(); c.scan();
    expect(notices).toHaveLength(2);
    c.stop();
  });

  it("P2-4: a delivery ends the episode even with more still queued: stuck again, the remaining wait is reported again", () => {
    const rows = [row("sol"), row("sol")];
    const { c, notices } = coordinator(rows, new Map([["sol", "The CLI appears stuck."]]));
    clock += ALWAYS_ON_BLOCK_NOTICE_MS;
    c.scan();
    expect(notices).toHaveLength(1);
    rows[0]!.state = "delivered" as any;                  // it took one, then went stuck again with the other waiting
    c.noteDelivered("sol");
    c.scan();
    expect(notices).toHaveLength(2);
    c.scan();
    expect(notices).toHaveLength(2);                       // once per episode
    c.stop();
  });

  it("P2-4: an emptied queue (no delivery noted) also ends the episode", () => {
    const rows = [row("sol")];
    const { c, notices } = coordinator(rows, new Map([["sol", "The CLI appears stuck."]]));
    clock += ALWAYS_ON_BLOCK_NOTICE_MS;
    c.scan();
    rows.splice(0);
    c.scan();
    rows.push(row("sol"));
    clock += ALWAYS_ON_BLOCK_NOTICE_MS;
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
