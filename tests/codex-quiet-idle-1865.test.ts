/**
 * #1865: after the beta.13 restart sol's resumed codex painted its footer without the Context item
 * (`⚠ 2 warnings · f2 to view` only), so its idle composer read `working` — and the #1641 recovery, which runs on the
 * `stuck` path, waited out the whole 15-minute stuck window. The rollout's last turn had ended. A safety sweep that sees
 * a closed turn and the same live empty composer for UNKNOWN_LAYOUT_STABLE_MS recovers it to idle without that wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon, PaneStateMachine, UNKNOWN_LAYOUT_STABLE_MS } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import type { TranscriptTurnEvent } from "../src/transcript-turns.js";
import { setLocale } from "../src/locale.js";

const FIX = fileURLToPath(new URL("./fixtures/codex-0160-false-stuck-1641/", import.meta.url));
const IDLE_LOOKING = readFileSync(join(FIX, "warnings-footer-idle-composer.pane.txt"), "utf8");
const ROLLOUT: TranscriptTurnEvent[] = readFileSync(join(FIX, "rollout-task-events.jsonl"), "utf8").trim().split("\n").map(line => {
  const p = JSON.parse(line).payload;
  return p.type === "task_started" ? { kind: "start", turnId: p.turn_id } : { kind: "end", turnId: p.turn_id, end: "complete" };
});
const [STARTED_0237, ENDED_0226, STARTED_2225] = ROLLOUT;

/** The fleet's hang_detector window (sol's fleet: 15 minutes). */
const STUCK_MS = 15 * 60_000;
const SWEEP_MS = 60_000;
const dirs: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "performance"] }); vi.setSystemTime(Date.parse("2026-10-15T09:51:00Z")); setLocale("en"); });
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(pane: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-1865-"));
  dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@7");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backend = new CodexBackend(dir);
  const daemon = new Daemon("agend-dev-sol", {
    working_directory: "/tmp", backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 15, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, backend as any, undefined, { child: () => logger } as any) as any;
  daemon.tmux = { capturePane: async () => pane, isWindowAlive: async () => true, getWindowId: () => "@7" };
  daemon.controlClient = { isIdle: () => true, hasOutputSince: () => false, getLastOutputAt: () => 0, getObservationResetAt: () => 0 };
  daemon.instanceStateMachine = new PaneStateMachine(backend.getReadyPattern(), STUCK_MS, Date.now(), backend.getBusyPattern());
  daemon.instanceStateMonitorActive = true;
  daemon.transcriptMonitor = { following: () => true, turnStateKnown: () => true };
  const rollout = (...events: TranscriptTurnEvent[]) => { daemon.transcriptTurns.observe(events, performance.now()); daemon.transcriptActivityAt = performance.now(); };
  return { daemon, sweep: () => daemon.captureAndEvaluateInstanceState("safety_sweep"), rollout };
}

describe("#1865: codex's idle composer with a closed rollout turn recovers on the sweep, not at the stuck deadline", () => {
  it("closed turn: working at the first sweep, idle once the composer held still for the #978 window", async () => {
    const h = harness(IDLE_LOOKING);
    h.rollout(STARTED_0237, ENDED_0226);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("working");      // one look is not a hold
    vi.advanceTimersByTime(UNKNOWN_LAYOUT_STABLE_MS - 1);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("working");
    vi.advanceTimersByTime(SWEEP_MS);
    await h.sweep();
    expect(h.daemon.instanceState).toBe("idle");         // minutes, not the 15-minute stuck window
  });

  it("only the safety sweep, and only codex, recovers a working reading", async () => {
    const probed = harness(IDLE_LOOKING);
    probed.rollout(STARTED_0237, ENDED_0226);
    for (let i = 0; i < 3; i++) { await probed.daemon.captureAndEvaluateInstanceState("initial"); vi.advanceTimersByTime(SWEEP_MS); }
    expect(probed.daemon.instanceState).toBe("working");
    const other = harness(IDLE_LOOKING);
    Object.defineProperty(other.daemon.backend, "binaryName", { value: "muse" });
    other.rollout(STARTED_0237, ENDED_0226);
    for (let i = 0; i < 3; i++) { await other.sweep(); vi.advanceTimersByTime(SWEEP_MS); }
    expect(other.daemon.instanceState).toBe("working");
  });

  it("an open turn stays working on the same pane", async () => {
    const h = harness(IDLE_LOOKING);
    h.rollout(STARTED_2225);
    await h.sweep();
    vi.advanceTimersByTime(SWEEP_MS);
    h.rollout();                                          // the rollout is still moving
    await h.sweep();
    expect(h.daemon.instanceState).toBe("working");
  });
});
