/**
 * #1217: four lifecycle bugs around a backend switch, found when an instance
 * switched claude-code → muse could not start at all: its stored session id was
 * Claude's, muse said "retained session not found" and exited, and every start
 * failed as "attempt 1/3" forever.
 *
 *  (a) each backend names the words that prove a session is gone;
 *  (b) the unproven-failure count survives a new Daemon (every start builds one);
 *  (c) a session id belongs to the backend that made it — a switch sets it aside,
 *      and update_instance_config restarts on a backend change, fresh;
 *  (d) Claude's "Background work is running" exit prompt is recognised: held for
 *      deliveries, and cancelled with Escape (never answered) by the stop flow.
 *
 * Scratch instance directories, stubbed backend/tmux; no CLI, tmux or fleet.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import type { Logger } from "../src/logger.js";
import { ClaudeCodeBackend, claudeBackgroundWorkExitActive } from "../src/backend/claude-code.js";
import { MuseBackend } from "../src/backend/muse.js";
import { outboundHandlers, type OutboundContext } from "../src/outbound-handlers.js";
import type { CliBackend } from "../src/backend/types.js";
import type { TmuxManager } from "../src/tmux-manager.js";

/** A stand-in with only the members this test's path touches (see resume-timeout-keeps-session). */
const standingIn = <T,>(stub: object): T => stub as unknown as T;

const rootLogger = pino({ level: "silent" }) as Logger;
type AnyDaemon = Daemon & Record<string, any>;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-1217-")); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function makeDaemon(backend = "claude-code"): AnyDaemon {
  return new Daemon("switch-test", {
    working_directory: dir,
    backend,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, dir, true, undefined, undefined, rootLogger) as AnyDaemon;
}
const sessionId = () => (existsSync(join(dir, "session-id")) ? readFileSync(join(dir, "session-id"), "utf8").trim() : null);
const setAside = () => readdirSync(dir).filter(f => f.startsWith("session-id.abandoned-"));

/** The real spawnClaudeWindow failure path; every launch misses (or makes) its budget. */
function arm(d: AnyDaemon, opts: { paneText?: string; alive?: boolean; backend?: Record<string, unknown> } = {}) {
  const commands: string[] = [];
  const buildCommand = vi.fn(() => { const cmd = sessionId() ? `resume ${sessionId()}` : "fresh"; commands.push(cmd); return cmd; });
  d["backend"] = standingIn<CliBackend>({
    binaryName: "claude",
    writeConfig: vi.fn(),
    buildCommand,
    getStartupBudgetMs: vi.fn(() => 60_000),
    ...opts.backend,
  });
  d["tmux"] = standingIn<TmuxManager>({
    killWindow: vi.fn().mockResolvedValue(undefined),
    capturePaneWithHistory: vi.fn().mockResolvedValue(opts.paneText ?? "Loading…"),
  });
  d["killProcessTree"] = vi.fn().mockResolvedValue(undefined);
  d["noteStartupPaneForBackendOutage"] = vi.fn().mockResolvedValue(undefined);
  d["failStartupIfBackendUnreachable"] = vi.fn().mockResolvedValue(undefined);
  d["beginSpawn"] = vi.fn(); d["endSpawn"] = vi.fn();
  d["trySpawn"] = vi.fn(async () => { buildCommand(); return opts.alive ?? false; });
  d["skipResume"] = false;
  return commands;
}

describe("(b) the unproven-failure count survives a restart", () => {
  it("three starts, three Daemon objects: the third gives up and starts fresh (it used to say 1/3 forever)", async () => {
    writeFileSync(join(dir, "session-id"), "conv-1");
    const messages: string[] = [];
    for (let start = 1; start <= 2; start++) {
      const d = makeDaemon();                       // what every start does: a new Daemon
      arm(d);
      await d["spawnClaudeWindow"]().catch((e: Error) => messages.push(e.message));
    }
    expect(messages).toEqual([
      expect.stringContaining("attempt 1/3"),
      expect.stringContaining("attempt 2/3"),
    ]);
    expect(sessionId()).toBe("conv-1");
    const third = makeDaemon();
    arm(third);
    const lost = vi.fn();
    third.on("context_lost", lost);
    await expect(third["spawnClaudeWindow"]()).rejects.toThrow(/failed to start after retry/);
    expect(sessionId()).toBeNull();
    expect(setAside()).toHaveLength(1);
    expect(lost).toHaveBeenCalledWith("switch-test", "resume_repeatedly_failed");
  });

  it("a different session id starts the count again", async () => {
    writeFileSync(join(dir, "session-id"), "conv-1");
    const a = makeDaemon(); arm(a);
    await expect(a["spawnClaudeWindow"]()).rejects.toThrow(/attempt 1\/3/);
    writeFileSync(join(dir, "session-id"), "conv-2");
    const b = makeDaemon(); arm(b);
    await expect(b["spawnClaudeWindow"]()).rejects.toThrow(/attempt 1\/3/);
  });

  it("a successful resume ends the count", async () => {
    writeFileSync(join(dir, "session-id"), "conv-1");
    const a = makeDaemon(); arm(a);
    await expect(a["spawnClaudeWindow"]()).rejects.toThrow(/attempt 1\/3/);
    const ok = makeDaemon(); arm(ok, { alive: true });
    await ok["spawnClaudeWindow"]();
    expect(existsSync(join(dir, "resume-failures.json"))).toBe(false);
    const c = makeDaemon(); arm(c);
    await expect(c["spawnClaudeWindow"]()).rejects.toThrow(/attempt 1\/3/);
  });
});

describe("(a) each backend's own words prove a session is gone", () => {
  const MUSE_SAYS = "retained session not found: session e8c8f313-a6d5-4517-9cde-2dbe66a42d57 has no saved log";

  it("muse: its message is proof — set aside on the first failure, not counted to three", async () => {
    writeFileSync(join(dir, "session-id"), "e8c8f313-a6d5-4517-9cde-2dbe66a42d57");
    const d = makeDaemon("muse");
    const muse = new MuseBackend(dir);
    arm(d, { paneText: MUSE_SAYS, backend: { resumeMissingPattern: () => muse.resumeMissingPattern() } });
    const lost = vi.fn();
    d.on("context_lost", lost);
    await expect(d["spawnClaudeWindow"]()).rejects.toThrow(/failed to start after retry/);
    expect(setAside()).toHaveLength(1);
    expect(lost).not.toHaveBeenCalled();
  });

  it("each pattern matches only its own CLI's words", () => {
    const muse = new MuseBackend(dir).resumeMissingPattern();
    const claude = ClaudeCodeBackend.prototype.resumeMissingPattern.call(null);
    expect(muse.test(MUSE_SAYS)).toBe(true);
    expect(muse.test("No conversation found to resume")).toBe(false);
    expect(claude.test("No conversation found to resume")).toBe(true);
    expect(claude.test(MUSE_SAYS)).toBe(false);
  });

  it("a backend that names none keeps the phrasing AgEnD always used", () => {
    const d = makeDaemon();
    d["backend"] = standingIn<CliBackend>({ binaryName: "x" });
    expect(d["paneSaysNoConversation"]("No previous session found")).toBe(true);
    expect(d["paneSaysNoConversation"](MUSE_SAYS)).toBe(false);
  });
});

describe("(c) a session id belongs to the backend that made it", () => {
  it("an id owned by another backend is set aside and this start is fresh", async () => {
    writeFileSync(join(dir, "session-id"), "claude-conv");
    writeFileSync(join(dir, "session-id.backend"), "claude-code");
    const d = makeDaemon("muse");
    const commands = arm(d, { alive: true });
    await d["spawnClaudeWindow"]();
    expect(commands).toEqual(["fresh"]);
    expect(setAside()).toHaveLength(1);
    expect(readFileSync(join(dir, "session-id.backend"), "utf8")).toBe("muse");
  });

  it("also when the start was already fresh (a switch restarts with freshStart): the old id is never recorded as the new backend's", async () => {
    writeFileSync(join(dir, "session-id"), "claude-conv");
    writeFileSync(join(dir, "session-id.backend"), "claude-code");
    const d = makeDaemon("muse");
    arm(d, { alive: true });
    d["skipResume"] = true;
    await d["spawnClaudeWindow"]();
    expect(sessionId()).toBeNull();
    const next = makeDaemon("muse");
    const commands = arm(next, { alive: true });
    await next["spawnClaudeWindow"]();
    expect(commands).toEqual(["fresh"]);
  });

  it("the owner's own id is resumed; an id with no recorded owner is left to the resume itself", async () => {
    writeFileSync(join(dir, "session-id"), "muse-conv");
    writeFileSync(join(dir, "session-id.backend"), "muse");
    const own = makeDaemon("muse");
    const ownCommands = arm(own, { alive: true });
    await own["spawnClaudeWindow"]();
    expect(ownCommands).toEqual(["resume muse-conv"]);
    expect(sessionId()).toBe("muse-conv");
    rmSync(join(dir, "session-id.backend"));
    const legacy = makeDaemon("muse");
    const commands = arm(legacy, { alive: true });
    await legacy["spawnClaudeWindow"]();
    expect(commands).toEqual(["resume muse-conv"]);
    expect(setAside()).toEqual([]);
  });

  describe("update_instance_config", () => {
    function context(status: "running" | "stopped" = "running") {
      const instance: Record<string, unknown> = { working_directory: "/tmp/w", backend: "claude-code" };
      const restartSingleInstance = vi.fn(async () => {});
      const ctx = {
        dataDir: dir,
        fleetConfig: { defaults: {}, instances: { worker: instance } },
        classicChannels: { getAll: () => [] },
        saveFleetConfig: vi.fn(),
        restartSingleInstance,
        lifecycle: { daemons: new Map(), isPaused: () => false },
        instanceIpcClients: new Map(),
        getInstanceStatus: () => status,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      } as unknown as OutboundContext;
      return { ctx, instance, restartSingleInstance };
    }
    async function call(ctx: OutboundContext, args: unknown): Promise<Record<string, unknown>> {
      let result: unknown = null;
      let error: string | undefined;
      await outboundHandlers.get("update_instance_config")!(ctx, args as never, (r, e) => { result = r; error = e; }, {} as never);
      await new Promise(r => setTimeout(r, 20));
      if (error) throw new Error(error);
      return result as Record<string, unknown>;
    }

    it("a backend change restarts the running instance, fresh (it used to be saved and left running as the old CLI)", async () => {
      const { ctx, instance, restartSingleInstance } = context();
      const result = await call(ctx, { name: "worker", config: { backend: "muse" } });
      expect(instance.backend).toBe("muse");
      expect(restartSingleInstance).toHaveBeenCalledWith("worker", { freshStart: true });
      expect(result).toMatchObject({ success: true, restarted: true, backend_switched: true });
    });

    it("a stopped instance is not started; the change applies when it next starts", async () => {
      const { ctx, restartSingleInstance } = context("stopped");
      const result = await call(ctx, { name: "worker", config: { backend: "muse" } });
      expect(restartSingleInstance).not.toHaveBeenCalled();
      expect(String(result.note)).toContain("new backend apply");
    });

    it("an unrelated change does not restart", async () => {
      const { ctx, restartSingleInstance } = context();
      await call(ctx, { name: "worker", config: { description: "x" } });
      expect(restartSingleInstance).not.toHaveBeenCalled();
    });
  });
});

describe("(d) Claude's \"Background work is running\" exit prompt", () => {
  // Claude Code 2.1.289, replayed from a live pane's output log.
  const PROMPT = [
    "● Running python3 - <<'EOF' p=\"src/delivery-reconciliation.t… · 59s",
    "* Generating… (2m 22s · ↓ 8.9k tokens)",
    "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
    "   Background work is running",
    "   The following will stop when you exit:",
    "   shell · python3 - <<'EOF' p=\"src/delivery-reconciliation.…",
    "   ❯ 1. Exit and stop tasks",
    "     2. Move to background and exit",
    "     3. Stay",
    "   Enter to confirm · Esc to cancel",
  ].join("\n");

  it("is recognised whole, at the bottom of the pane — not when quoted, and not without its options", () => {
    expect(claudeBackgroundWorkExitActive(PROMPT)).toBe(true);
    expect(claudeBackgroundWorkExitActive(`${PROMPT}\n\n❯ \n  ⏵⏵ bypass permissions on`)).toBe(false);
    expect(claudeBackgroundWorkExitActive(PROMPT.replace("     3. Stay\n", ""))).toBe(false);
    expect(claudeBackgroundWorkExitActive(PROMPT.replace("Exit and stop tasks", "Exit"))).toBe(false);
  });

  it("deliveries hold on it and never answer it: a passive dialog with no keys", () => {
    const dialog = new ClaudeCodeBackend(dir).getRuntimeDialogs().find(d => d.isActive === claudeBackgroundWorkExitActive);
    expect(dialog).toMatchObject({ keys: [], holdOnly: true, blocksDelivery: true });
    expect(dialog!.pattern.test(PROMPT)).toBe(true);
  });

  it("the stop flow cancels it with Escape and stops the process — no option is chosen, and it does not wait out the grace", async () => {
    vi.useFakeTimers();
    const d = makeDaemon();
    const keys: string[] = [];
    const killed: string[] = [];
    let alive = true;
    const getPaneStatus = vi.fn(async () => ({ alive }));
    d["backend"] = standingIn<CliBackend>({ binaryName: "claude", quitBlockedByDialog: claudeBackgroundWorkExitActive, getQuitCommand: () => "/exit" });
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@1",
      capturePane: vi.fn(async () => PROMPT),
      getPaneStatus,
      sendSpecialKey: vi.fn(async (k: string) => { keys.push(k); return true; }),
      killWindow: vi.fn(async () => {}),
      pasteText: vi.fn(async () => true),
    });
    d["checkpointSessionId"] = vi.fn(async () => {});
    d["sendQuitSequence"] = vi.fn(async () => true);
    d["killProcessTree"] = vi.fn(async (...args: unknown[]) => { killed.push(String(args[0])); alive = false; });
    const stopping = d.stop().catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(keys).toEqual(["Escape"]);
    expect(killed[0]).toBe("SIGTERM");
    // One poll, not the 3s grace: it saw the prompt and moved on.
    expect(getPaneStatus.mock.calls.length).toBeLessThan(5);
  });

  it("an idle pause does the same: Escape, then SIGTERM", async () => {
    vi.useFakeTimers();
    const d = makeDaemon();
    const keys: string[] = [];
    const killed: string[] = [];
    let alive = true;
    const getPaneStatus = vi.fn(async () => ({ alive }));
    d["backend"] = standingIn<CliBackend>({ binaryName: "claude", quitBlockedByDialog: claudeBackgroundWorkExitActive });
    d["tmux"] = standingIn<TmuxManager>({
      getWindowId: () => "@1",
      capturePane: vi.fn(async () => PROMPT),
      getPaneStatus,
      sendSpecialKey: vi.fn(async (k: string) => { keys.push(k); return true; }),
    });
    d["instanceState"] = "idle";
    d["freezeRuntimeMonitors"] = vi.fn();
    d["checkpointSessionId"] = vi.fn(async () => {});
    d["sendQuitSequence"] = vi.fn(async () => true);
    d["killProcessTree"] = vi.fn(async (...args: unknown[]) => { killed.push(String(args[0])); alive = false; });
    const pausing = d.pause("idle" as never).catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    await pausing;
    expect(keys).toEqual(["Escape"]);
    expect(killed[0]).toBe("SIGTERM");
    expect(getPaneStatus.mock.calls.length).toBeLessThan(5);
  });

  it("a quit with no such prompt is left to exit on its own, as before", async () => {
    const d = makeDaemon();
    d["backend"] = standingIn<CliBackend>({ binaryName: "claude", quitBlockedByDialog: claudeBackgroundWorkExitActive });
    const sendSpecialKey = vi.fn();
    d["tmux"] = standingIn<TmuxManager>({ capturePane: vi.fn(async () => "❯ \n  ⏵⏵ bypass permissions on"), sendSpecialKey });
    expect(await d["cancelQuitConfirmation"]("stop")).toBe(false);
    expect(sendSpecialKey).not.toHaveBeenCalled();
  });
});
