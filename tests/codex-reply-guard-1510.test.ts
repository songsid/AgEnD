/**
 * #1510: the reply-completion guard covers codex, its turn end read from the rollout.
 *
 * Part 1 replays the real codex 0.162.0 rollout (tests/fixtures/reply-guard-1510) through the production
 * CodexRolloutSource and the turn ledger. Part 2 runs the real Daemon with the real CodexBackend and the recorded
 * panes: only the pane writer, the IPC and the MCP liveness probe are stubbed.
 */
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";
import { setLocale } from "../src/locale.js";
import type { Logger } from "../src/logger.js";
import { RolloutIndex } from "../src/rollout-index.js";
import { CodexRolloutSource } from "../src/transcript-sources.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import { TranscriptTurnLedger, type TranscriptTurnEvent } from "../src/transcript-turns.js";

vi.mock("../src/backend/types.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/backend/types.js")>(),
  resolveBinary: (name: string) => name,
}));

const FIX = join(import.meta.dirname, "fixtures", "reply-guard-1510", "codex-0.162.0");
const ROLLOUT = readFileSync(join(FIX, "rollout.jsonl"), "utf8").trim().split("\n");
const frame = (name: string) => readFileSync(join(FIX, "frames", `${name}.txt`), "utf8");
const logger = pino({ level: "silent" }) as Logger;
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "agend-1510-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The rollout's user records: text → wall time (the guard's arm happens at the paste, i.e. then). */
const userAt = new Map<string, number>();
for (const line of ROLLOUT) {
  const o = JSON.parse(line);
  if (o.type === "response_item" && o.payload.type === "message" && o.payload.role === "user") userAt.set(o.payload.content[0].text, Date.parse(o.timestamp));
}

describe("the recorded codex 0.162.0 rollout, through the production CodexRolloutSource", () => {
  /** A sessions tree holding one rollout for `cwd`; `lines` are appended as codex would write them. */
  function rollout(cwd: string, followedCwd = cwd) {
    const sessions = join(temp(), "sessions"), day = join(sessions, "2026", "10", "10");
    mkdirSync(day, { recursive: true });
    const file = join(day, "rollout-2026-10-10T01-27-41-01a121b4.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: "01a121b4", cwd } }) + "\n");
    const source = new CodexRolloutSource(followedCwd, sessions, Date.now(), new RolloutIndex(sessions, { ttlMs: 0 }));
    source.reset(); // the file is new to this source: read from its start
    return { file, source, append: (lines: string[]) => appendFileSync(file, lines.map(l => l + "\n").join("")) };
  }
  async function replay(lines: string[]) {
    const r = rollout("/home/user/project");
    r.append(lines);
    const ledger = new TranscriptTurnLedger();
    const turns: TranscriptTurnEvent[] = [];
    const events = await r.source.poll();
    turns.push(...events.turns ?? []);
    ledger.observe(turns);
    return { ledger, turns, r };
  }
  const verdictFor = (ledger: TranscriptTurnLedger, text: string) => ledger.verdict(text, userAt.get(text)!);

  it("each turn is one start and one end; a steer and a message typed while streaming stay inside their turn", async () => {
    const { turns } = await replay(ROLLOUT);
    const starts = turns.filter(t => t.kind === "start").length, ends = turns.filter(t => t.kind === "end");
    expect(starts).toBe(ends.length);
    expect(ends.map(e => (e as { end: string }).end)).toEqual(["complete", "complete", "complete", "complete", "aborted", "complete", "error", "error", "complete"]);
  });

  it.each([
    ["hello one", "ended"],
    ["run the tool third", "ended"], // the 20 s tool run
    ["slow then esc", "aborted"],
    ["turn with e500", "error"],
    ["turn with capacity", "error"],
    ["tool then steer", "ended"],
    ["STEER message mid tool", "ended"], // injected after the tool output, inside the same turn
    ["SECOND typed while streaming", "ended"], // folded into the turn it was typed into
  ] as const)("%s → %s", async (text, verdict) => {
    const { ledger } = await replay(ROLLOUT);
    expect(verdictFor(ledger, text)).toBe(verdict);
  });

  it("while the 20 s tool runs (rollout cut before its task_complete) the turn is running; once written, ended", async () => {
    const end = ROLLOUT.findIndex(l => l.includes('"task_complete"') && ROLLOUT.slice(0, ROLLOUT.indexOf(l)).some(p => p.includes("run the tool third")));
    const r = rollout("/home/user/project");
    const ledger = new TranscriptTurnLedger();
    r.append(ROLLOUT.slice(0, end));
    ledger.observe((await r.source.poll()).turns ?? []);
    expect(verdictFor(ledger, "run the tool third")).toBe("running");
    r.append(ROLLOUT.slice(end));
    ledger.observe((await r.source.poll()).turns ?? []);
    expect(verdictFor(ledger, "run the tool third")).toBe("ended");
  });

  it("a steer re-arms with its own text: until the turn it joined ends, running", async () => {
    const cut = ROLLOUT.findIndex(l => l.includes("STEER message mid tool")) + 2;
    const { ledger } = await replay(ROLLOUT.slice(0, cut));
    expect(verdictFor(ledger, "STEER message mid tool")).toBe("running");
  });

  it("the TranscriptMonitor hands each poll's turn boundaries over in one batch, in transcript order", async () => {
    const r = rollout("/home/user/project");
    r.append(ROLLOUT.slice(0, 12));
    const monitor = new TranscriptMonitor(temp(), logger, r.source);
    const batches: TranscriptTurnEvent[][] = [];
    monitor.on("turns", (turns: TranscriptTurnEvent[]) => batches.push(turns));
    await monitor.pollIncrement();
    expect(batches).toHaveLength(1);
    expect(batches[0].map(t => t.kind)).toEqual((await replay(ROLLOUT.slice(0, 12))).turns.map(t => t.kind));
    monitor.stop();
  });

  it("unknown, never ended: a delivery not in this rollout (another instance in the same cwd), an earlier same-words turn, a different cwd", async () => {
    const { ledger } = await replay(ROLLOUT);
    expect(ledger.verdict("a message this instance never got", Date.parse("2026-10-09T17:27:00Z"))).toBe("unknown");
    expect(ledger.verdict("hello one", userAt.get("hello one")! + 60_000), "same words, armed a minute later").toBe("unknown");
    const other = rollout("/home/user/project", "/home/user/other");
    other.append(ROLLOUT);
    expect((await other.source.poll()).turns).toBeUndefined();
  });
});

describe("the real Daemon with the real CodexBackend: recovery only when the rollout proves the turn ended", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T00:00:00.000Z")); setLocale("en"); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  function harness() {
    const dir = temp();
    const backend = new CodexBackend(dir);
    const daemon = new Daemon("worker", {
      backend: "codex", working_directory: dir, reply_completion_guard: true, log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, dir, true, backend, undefined, logger) as any;
    let pane = "";
    const writes: string[] = [];
    daemon.tmux = { capturePane: vi.fn(async () => pane) };
    daemon.deliverMessage = vi.fn(async (text: string, _s?: unknown, opts?: { deliveryEpoch?: number }) => {
      if (opts?.deliveryEpoch !== undefined && !daemon.isDeliveryEpochCurrent(opts.deliveryEpoch)) return false;
      writes.push(text);
      return true;
    });
    daemon.deliverDaemonReply = vi.fn(async () => true);
    daemon.mcpServerAlive = vi.fn(() => ({ alive: true, source: "connection" }));
    daemon.ipcServer = { broadcast: vi.fn(), send: vi.fn(() => true) };
    daemon.instanceStateMonitorActive = true;
    daemon.instanceStateReadyPattern = backend.getReadyPattern();
    daemon.instanceStateMachine = new PaneStateMachine(backend.getReadyPattern(), 600_000, Date.now(), backend.getBusyPattern());
    const detected = vi.fn();
    daemon.on("reply_drop_detected", detected);
    let turnSeq = 0;
    const h = {
      daemon, writes, detected,
      recovery: () => writes.filter(text => text.startsWith("[system:reply-required]")),
      async inbound(content = "do the task") {
        daemon.pushChannelMessage(content, { chat_id: "guild-1", thread_id: "channel-1", adapter_id: "discord", message_id: "m-1", correlation_id: "cid-1" });
        await daemon.pasteLock;
      },
      /** What the rollout poll would hand the daemon: a turn holding `text` (default: our delivery), then its end. */
      transcript(turns: TranscriptTurnEvent[]) { daemon.transcriptTurns.observe(turns); },
      ourTurn(end?: "complete" | "aborted" | "error", text = writes[0]) {
        const id = `turn-${++turnSeq}`;
        return [{ kind: "start", turnId: id }, { kind: "user", turnId: id, text, at: Date.now() },
          ...(end ? [{ kind: "end", turnId: id, end }] : [])] as TranscriptTurnEvent[];
      },
      async capture(next: string) {
        pane = next;
        const at = Date.now();
        daemon.instanceStateLastOutputAt = at;
        daemon.applyInstanceStateSnapshot(daemon.instanceStateMachine.recordOutput(at));
        vi.advanceTimersByTime(2_100);
        await daemon.captureAndEvaluateInstanceState("idle_debounce", at);
        await daemon.pasteLock;
      },
      async confirmIdle() {
        vi.advanceTimersByTime(61_000);
        await daemon.captureAndEvaluateInstanceState("idle_debounce", daemon.instanceStateLastOutputAt);
        await daemon.pasteLock;
      },
      /** A silent turn on the recorded panes: busy through the tool run, then idle, then the window. */
      async silentTurn() {
        await h.inbound();
        await h.capture(frame("tool-mid"));
        await h.capture(frame("tool-idle"));
        await h.confirmIdle();
      },
    };
    return h;
  }

  it("the rollout shows our turn ended, no reply: exactly one recovery prompt", async () => {
    const h = harness();
    await h.inbound();
    h.transcript(h.ourTurn("complete"));
    await h.capture(frame("tool-mid")); await h.capture(frame("tool-idle")); await h.confirmIdle();
    expect(h.recovery()).toHaveLength(1);
    expect(h.detected).toHaveBeenCalledTimes(1);
  });

  it("no evidence in the rollout (another instance's rollout followed, or none): never a recovery — fail-safe", async () => {
    const h = harness();
    await h.inbound();
    h.transcript(h.ourTurn("complete", "someone else's message in the same cwd"));
    await h.capture(frame("tool-mid")); await h.capture(frame("tool-idle")); await h.confirmIdle();
    expect(h.recovery()).toEqual([]);
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("idle on screen but still running in the rollout: held, re-checked a window later, recovered once it ends", async () => {
    const h = harness();
    await h.inbound();
    const turn = h.ourTurn();
    h.transcript(turn);
    await h.capture(frame("tool-mid")); await h.capture(frame("tool-idle")); await h.confirmIdle();
    expect(h.recovery()).toEqual([]);
    expect(h.daemon.turnReplyGuard.snapshot()).not.toBeNull();
    h.transcript([{ kind: "end", turnId: (turn[0] as { turnId: string }).turnId, end: "complete" }]);
    await h.confirmIdle();
    expect(h.recovery()).toHaveLength(1);
  });

  it.each(["aborted", "error"] as const)("our turn %s: no recovery, the obligation is closed", async end => {
    const h = harness();
    await h.inbound();
    h.transcript(h.ourTurn(end));
    await h.capture(frame("tool-mid")); await h.capture(frame("tool-idle")); await h.confirmIdle();
    expect(h.recovery()).toEqual([]);
    expect(h.daemon.turnReplyGuard.snapshot()).toBeNull();
  });

  it("a delivered reply settles it: no recovery whatever the rollout says", async () => {
    const h = harness();
    await h.inbound();
    h.transcript(h.ourTurn("complete"));
    const socket = new EventEmitter() as any;
    h.daemon.socketSessionNames.set(socket, "worker");
    h.daemon.handleToolCall({ tool: "reply", args: { text: "done" }, requestId: 1 }, socket);
    const pending = [...h.daemon.pendingIpcRequests.entries()].find(([key]: any) => key.endsWith("_1"));
    pending![1]({ result: { ok: true } });
    await h.capture(frame("tool-mid")); await h.capture(frame("tool-idle")); await h.confirmIdle();
    expect(h.recovery()).toEqual([]);
  });

  it("the daemon's ledger follows the monitor's turn batches", async () => {
    const h = harness();
    const monitor = new EventEmitter();
    h.daemon.followTranscriptTurns(monitor);
    await h.inbound();
    monitor.emit("turns", h.ourTurn("complete"));
    expect(h.daemon.transcriptTurns.verdict(h.writes[0], Date.now())).toBe("ended");
  });

  it("the pane alone never decides: the recorded tool-run frames read busy until task_complete's frame", async () => {
    const b = new CodexBackend(temp());
    for (const f of ["tool-start", "tool-mid", "tool-last-busy"]) expect(b.getBusyPattern().test(frame(f)), f).toBe(true);
    expect(b.getBusyPattern().test(frame("tool-idle"))).toBe(false);
  });
});
