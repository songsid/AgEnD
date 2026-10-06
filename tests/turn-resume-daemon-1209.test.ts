/**
 * #1209 daemon wiring tests: the fences around the pure gate.
 *
 * Real Daemon + stub backend/tmux + fixture claude transcript stores
 * (CLAUDE_CONFIG_DIR pointed at tmp; production seam readers do the
 * reading) + fake timers. No fleet, no CLI, no host IO.
 *
 * Each test pins one wire the pure matrix suite cannot see: cancel during
 * the grace hold (#1199), respawn/stop fences during the hold, crash-loop
 * and outbox flags reaching the gate, consume-once across boots, the
 * double-wait deny clamp, completion-delivery clearing (P2), and
 * no-re-arm for resumed continuations (P3a).
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  forbidden: vi.fn((..._args: unknown[]): never => { throw new Error("Forbidden host IO in turn-resume-daemon harness"); }),
}));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  exec: hooks.forbidden, execFile: hooks.forbidden, execSync: hooks.forbidden,
  execFileSync: hooks.forbidden, spawn: hooks.forbidden, spawnSync: hooks.forbidden, fork: hooks.forbidden,
}));
vi.mock("node:net", async importOriginal => ({
  ...await importOriginal<typeof import("node:net")>(),
  createServer: hooks.forbidden, createConnection: hooks.forbidden, connect: hooks.forbidden,
}));
vi.mock("../src/backend/factory.js", () => ({ createBackend: hooks.forbidden }));
vi.mock("../src/logger.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/logger.js")>(),
  createLogger: () => pino({ level: "silent" }),
}));

import { Daemon } from "../src/daemon.js";
import { claudeProjectKey } from "../src/backend/claude-code.js";
import type { Logger } from "../src/logger.js";
import { writeInFlightTurnMarker, type InFlightTurnMarker } from "../src/turn-resume.js";
import type { TurnFingerprint } from "../src/backend/session-signals.js";

const T0 = Date.parse("2026-10-05T00:00:00.000Z");
const S0 = T0 + 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const dirs: string[] = [];
const logger = pino({ level: "silent" }) as unknown as Logger;
const oldClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

const fp = (over: Partial<TurnFingerprint> = {}): TurnFingerprint => ({
  sessionId: "sess-1", storeMtimeMs: T0, tailTimestampMs: T0, tailKind: "assistant", ...over,
});
const testMarker = (over: Partial<InFlightTurnMarker> = {}): InFlightTurnMarker => ({
  version: 1,
  deliveryId: "d-1",
  correlationId: "c-1",
  messageId: "m-1",
  chatId: "chat-1",
  threadId: "thread-1",
  adapterId: "adapter-1",
  backend: "claude-code",
  cwd: "/w",
  armedAt: T0,
  before: fp(),
  ...over,
});
const meta = () => ({
  chat_id: "chat-1", thread_id: "thread-1", adapter_id: "adapter-1",
  message_id: "m-1", correlation_id: "c-1",
});
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function claudeFixture(cwd: string, transcriptLines: string[]): { configDir: string } {
  const configDir = mkdtempSync(join(tmpdir(), "agend-resume-claude-home-"));
  dirs.push(configDir);
  const dir = join(configDir, "projects", claudeProjectKey(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sess-1.jsonl"), transcriptLines.join("\n") + "\n");
  process.env.CLAUDE_CONFIG_DIR = configDir;
  return { configDir };
}
const turnAt = (ms: number) => JSON.stringify({ type: "assistant", timestamp: iso(ms), sessionId: "sess-1" });
const bookkeeping = () => JSON.stringify({ type: "cost-state", sessionId: "sess-1" });

function makeDaemon(dir: string) {
  const backend = {
    binaryName: "claude", replyCompletionGuard: true,
    getReadyPattern: () => /^READY$/m, getBusyPattern: () => /WORKING/,
    getCancelKey: () => "Escape",
  } as any;
  const daemon = new Daemon("worker", {
    backend: "claude-code", working_directory: dir,
    log_level: "silent", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, dir, true, backend, undefined, logger) as any;
  daemon.tmux = { capturePane: vi.fn(async () => "READY") };
  daemon.pushChannelMessage = vi.fn();
  daemon.mcpServerAlive = vi.fn(() => ({ alive: true, source: "connection" }));
  daemon.ipcServer = { broadcast: vi.fn(), send: vi.fn(() => true) };
  daemon.wake = vi.fn(async () => {});
  daemon.start = hooks.forbidden;
  daemon.stop = hooks.forbidden;
  daemon.trySpawn = hooks.forbidden;
  daemon.handleCrash = hooks.forbidden;
  return daemon;
}

beforeEach(() => {
  hooks.forbidden.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  const forbiddenCalls = hooks.forbidden.mock.calls.length;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (oldClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = oldClaudeConfigDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(forbiddenCalls, "no process, backend construction, or socket IO").toBe(0);
});

describe("P1: cancel / respawn / stop during the grace hold", () => {
  function heldGate(dir: string) {
    claudeFixture(dir, [turnAt(T0), bookkeeping()]);
    const daemon = makeDaemon(dir);
    writeInFlightTurnMarker(dir, testMarker({ cwd: dir }));
    daemon.lastSpawnAt = S0;
    vi.setSystemTime(new Date(S0 + 5_000));
    return daemon;
  }

  it("cancel-in-hold → no inject (fence rechecked after the wait, #1199)", async () => {
    const daemon = heldGate(mkdtempSync(join(tmpdir(), "agend-resume-hold-")));
    dirs.push(daemon.instanceDir);
    const pending = (daemon as any).maybeResumeInterruptedTurn();
    await flush();
    daemon.clearPendingDeliveries();
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(pending).resolves.toBe("skipped-stale");
    expect(daemon.pushChannelMessage).not.toHaveBeenCalled();
  });

  it("respawn-in-hold → no inject", async () => {
    const daemon = heldGate(mkdtempSync(join(tmpdir(), "agend-resume-hold-")));
    dirs.push(daemon.instanceDir);
    const pending = (daemon as any).maybeResumeInterruptedTurn();
    await flush();
    daemon.spawnGeneration++;
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(pending).resolves.toBe("skipped-stale");
    expect(daemon.pushChannelMessage).not.toHaveBeenCalled();
  });

  it("stop-fence-in-hold → no inject", async () => {
    const daemon = heldGate(mkdtempSync(join(tmpdir(), "agend-resume-hold-")));
    dirs.push(daemon.instanceDir);
    const pending = (daemon as any).maybeResumeInterruptedTurn();
    await flush();
    daemon.launchFenceEpoch++;
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(pending).resolves.toBe("skipped-stale");
    expect(daemon.pushChannelMessage).not.toHaveBeenCalled();
  });

  it("undisturbed hold → injects once the grace passes", async () => {
    const daemon = heldGate(mkdtempSync(join(tmpdir(), "agend-resume-hold-")));
    dirs.push(daemon.instanceDir);
    const pending = (daemon as any).maybeResumeInterruptedTurn();
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(pending).resolves.toBe("injected");
    expect(daemon.pushChannelMessage).toHaveBeenCalledTimes(1);
    const [text, sentMeta] = daemon.pushChannelMessage.mock.calls[0];
    expect(text).toMatch(/Original request: c-1/);
    expect(sentMeta).toMatchObject({ correlation_id: "c-1", chat_id: "chat-1" });
  });
});

describe("P1: crash-loop, outbox, and reengaged reach the gate", () => {
  function terminalDaemon(extra: { crashLoop?: boolean; outbox?: unknown; transcriptTail?: string[] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "agend-resume-term-"));
    dirs.push(dir);
    claudeFixture(dir, extra.transcriptTail ?? [turnAt(T0), bookkeeping()]);
    const daemon = makeDaemon(dir);
    writeInFlightTurnMarker(dir, testMarker({ cwd: dir }));
    daemon.lastSpawnAt = S0;
    vi.setSystemTime(new Date(S0 + 20_000));
    if (extra.crashLoop) daemon.bootSkippedResume = true;
    if (extra.outbox) daemon.setDeliveryOutboxPort(extra.outbox as any);
    return daemon;
  }

  it("crash-loop boot → skip even when idle (#835)", async () => {
    const daemon = terminalDaemon({ crashLoop: true });
    await expect(daemon.maybeResumeInterruptedTurn()).resolves.toBe("skipped-crash-loop");
    expect(daemon.pushChannelMessage).not.toHaveBeenCalled();
  });

  it("outbox-pending delivery → skip, durable path owns it", async () => {
    const port = {
      begin: vi.fn(), markEnterStarted: vi.fn(), abort: vi.fn(),
      complete: vi.fn(), retryBeforeBegin: vi.fn(),
      get: vi.fn(() => ({ state: "queued" })),
    };
    const daemon = terminalDaemon({ outbox: port });
    await expect(daemon.maybeResumeInterruptedTurn()).resolves.toBe("skipped-delivery-pending");
    expect(daemon.pushChannelMessage).not.toHaveBeenCalled();
    expect(port.get).toHaveBeenCalledWith("d-1");
  });

  it("terminal outbox row does not block", async () => {
    const port = {
      begin: vi.fn(), markEnterStarted: vi.fn(), abort: vi.fn(),
      complete: vi.fn(), retryBeforeBegin: vi.fn(),
      get: vi.fn(() => ({ state: "delivered" })),
    };
    const daemon = terminalDaemon({ outbox: port });
    await expect(daemon.maybeResumeInterruptedTurn()).resolves.toBe("injected");
  });

  it("live reengaged transcript → skip (end-to-end through the real reader)", async () => {
    const daemon = terminalDaemon({ transcriptTail: [turnAt(T0), turnAt(S0 + 30_000)] });
    await expect(daemon.maybeResumeInterruptedTurn()).resolves.toBe("skipped-cli-reengaged");
    expect(daemon.pushChannelMessage).not.toHaveBeenCalled();
  });

  it("second boot finds nothing (consume-once across boots)", async () => {
    const daemon = terminalDaemon();
    await expect(daemon.maybeResumeInterruptedTurn()).resolves.toBe("injected");
    await expect(daemon.maybeResumeInterruptedTurn()).resolves.toBe("none");
    expect(daemon.pushChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("double wait denies instead of waiting forever (clock stepped back)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-resume-term-"));
    dirs.push(dir);
    claudeFixture(dir, [turnAt(T0), bookkeeping()]);
    const daemon = makeDaemon(dir);
    writeInFlightTurnMarker(dir, testMarker({ cwd: dir }));
    daemon.lastSpawnAt = S0;
    vi.setSystemTime(new Date(S0 + 5_000));
    const pending = daemon.maybeResumeInterruptedTurn();
    await flush();
    vi.setSystemTime(new Date(S0 + 1_000));
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(pending).resolves.toBe("skipped-unobservable");
    expect(daemon.pushChannelMessage).not.toHaveBeenCalled();
  });
});

describe("marker lifecycle on the daemon", () => {
  function armedDaemon() {
    const dir = mkdtempSync(join(tmpdir(), "agend-resume-arm-"));
    dirs.push(dir);
    const { configDir } = claudeFixture(dir, [turnAt(T0)]);
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const daemon = makeDaemon(dir);
    daemon.markTurnStarted(meta(), "do the thing\nnow");
    return daemon;
  }
  const markerPath = (daemon: any) => join(daemon.instanceDir, "in-flight-turn.json");

  it("arm writes the marker; guard completion clears it", () => {
    const daemon = armedDaemon();
    expect(existsSync(markerPath(daemon))).toBe(true);
    expect(daemon.turnReplyGuard.complete(1)).toBe(true);
    expect(existsSync(markerPath(daemon))).toBe(false);
  });

  it("cancel clears the marker even with no idle edge (#1199)", () => {
    const daemon = armedDaemon();
    expect(existsSync(markerPath(daemon))).toBe(true);
    daemon.clearPendingDeliveries();
    expect(existsSync(markerPath(daemon))).toBe(false);
  });

  it("P2: a delivered completion clears the marker before any idle edge", async () => {
    const daemon = armedDaemon();
    expect(existsSync(markerPath(daemon))).toBe(true);
    const socket = new EventEmitter() as any;
    daemon.socketSessionNames.set(socket, "worker");
    daemon.handleToolCall({ tool: "reply", args: { text: "done" }, requestId: 7 }, socket);
    const pending = [...daemon.pendingIpcRequests.entries()].find(([key]: [string, unknown]) =>
      String(key).endsWith("7"));
    expect(pending).toBeDefined();
    pending![1]({ result: { ok: true } });
    await flush();
    expect(existsSync(markerPath(daemon))).toBe(false);
    expect(daemon.turnReplyGuard.snapshot()).not.toBeNull();
  });

  it("P3a: a resumed continuation arms the guard but writes no marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-resume-arm-"));
    dirs.push(dir);
    const { configDir } = claudeFixture(dir, [turnAt(T0)]);
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const daemon = makeDaemon(dir);
    daemon.markTurnStarted({ ...meta(), resumedContinuationOf: "d-1" }, "continuation text");
    expect(daemon.turnReplyGuard.snapshot()).not.toBeNull();
    expect(existsSync(markerPath(daemon))).toBe(false);
  });
});
