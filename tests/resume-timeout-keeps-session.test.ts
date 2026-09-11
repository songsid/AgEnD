import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Daemon } from "../src/daemon.js";
import type { Logger } from "../src/logger.js";

/**
 * Silent conversation loss (external report: 3-core host, 22 instances, CPU
 * saturated). A cold start that needed longer than its budget was treated as a
 * broken session: spawnClaudeWindow deleted session-id, restarted fresh and
 * returned normally, so the fleet reported success while nine instances had
 * quietly lost their history.
 *
 * The rule these tests hold: abandoning a session requires positive proof from
 * the CLI that there is nothing to resume. Running out of budget is not proof.
 */
const rootLogger = pino({ level: "silent" }) as Logger;
type AnyDaemon = Daemon & Record<string, any>;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-resume-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeDaemon(): AnyDaemon {
  const d = new Daemon("resume-test", {
    working_directory: dir,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, dir, true, undefined, undefined, rootLogger) as AnyDaemon;
  writeFileSync(join(dir, "session-id"), "conversation-abc");
  return d;
}

const sessionExists = () => existsSync(join(dir, "session-id"));
const setAside = () => readdirSync(dir).filter(f => f.startsWith("session-id.abandoned-"));

describe("a startup that merely ran out of budget must not cost the conversation", () => {
  it("does not treat a timeout as proof that the session is gone", () => {
    const d = makeDaemon();
    // What a slow cold start actually leaves on the pane: no verdict at all.
    expect(d.paneSaysNoConversation("Loading…\n$ claude --continue --model opus")).toBe(false);
    expect(d.paneSaysNoConversation(undefined)).toBe(false);
    expect(d.paneSaysNoConversation("")).toBe(false);
  });

  it("a bare --continue in the pane is not a verdict either", () => {
    // The old pattern matched this, so any pane merely showing the flag — a
    // usage error, an echoed invocation — could discard the session.
    const d = makeDaemon();
    expect(d.paneSaysNoConversation("error: unrecognized option '--continue'")).toBe(false);
  });

  it("still recognises the CLI actually saying there is nothing to resume", () => {
    const d = makeDaemon();
    for (const said of [
      "No conversation found to resume",
      "no conversation to continue",
      "No previous session found",
    ]) {
      expect(d.paneSaysNoConversation(said), said).toBe(true);
    }
  });
});

describe("setting a session aside is recoverable, not destructive", () => {
  it("keeps the id on disk under a dated name instead of deleting it", () => {
    const d = makeDaemon();

    d.setSessionAside("cli_reported_no_conversation");

    expect(sessionExists(), "the live id is cleared").toBe(false);
    expect(setAside(), "but it is still on disk").toHaveLength(1);
  });

  it("keeps only the newest few, so they cannot accumulate forever", () => {
    const d = makeDaemon();
    for (let i = 0; i < 9; i++) {
      writeFileSync(join(dir, "session-id"), `conversation-${i}`);
      d.setSessionAside("test");
    }
    expect(setAside().length, "bounded").toBeLessThanOrEqual(5);
  });

  it("does nothing when there was no session to begin with", () => {
    const d = makeDaemon();
    rmSync(join(dir, "session-id"));

    d.setSessionAside("test");

    expect(setAside()).toHaveLength(0);
  });
});

/** Drive the real failure path in spawnClaudeWindow, not just its helpers. */
function armForFailedResume(d: AnyDaemon, opts: { paneText?: string } = {}) {
  d.backend = {
    binaryName: "claude",
    writeConfig: vi.fn(),
    buildCommand: vi.fn(() => "claude"),
    getStartupBudgetMs: vi.fn(() => 60_000),
  };
  d.tmux = {
    killWindow: vi.fn().mockResolvedValue(undefined),
    capturePaneWithHistory: vi.fn().mockResolvedValue(opts.paneText ?? "Loading…"),
  };
  d.killProcessTree = vi.fn().mockResolvedValue(undefined);
  d.noteStartupPaneForBackendOutage = vi.fn().mockResolvedValue(undefined);
  d.failStartupIfBackendUnreachable = vi.fn().mockResolvedValue(undefined);
  d.beginSpawn = vi.fn(); d.endSpawn = vi.fn();
  d.trySpawn = vi.fn().mockResolvedValue(false);          // every launch misses its budget
  d.skipResume = false;
}

describe("giving up is bounded and never silent (through spawnClaudeWindow)", () => {
  it("keeps the session and fails the attempt while the cause is unproven", async () => {
    const d = makeDaemon();
    armForFailedResume(d);

    await expect(d.spawnClaudeWindow(), "the attempt must fail, not fake success").rejects.toThrow(/session kept/);

    expect(sessionExists(), "the conversation is still there for the fleet's retry").toBe(true);
    expect(setAside(), "and nothing was set aside yet").toHaveLength(0);
  });

  it("starts fresh only after repeated unproven failures, and says the context is lost", async () => {
    const d = makeDaemon();
    armForFailedResume(d);
    const lost = vi.fn();
    d.on("context_lost", lost);

    // Earlier attempts keep the session…
    await expect(d.spawnClaudeWindow()).rejects.toThrow();
    await expect(d.spawnClaudeWindow()).rejects.toThrow();
    expect(sessionExists(), "still kept").toBe(true);
    expect(lost, "nothing announced yet").not.toHaveBeenCalled();

    // …until the bound is reached, and then it is announced rather than silent.
    await expect(d.spawnClaudeWindow()).rejects.toThrow(/failed to start after retry/);

    expect(sessionExists(), "the live id is cleared").toBe(false);
    expect(setAside(), "but recoverable on disk").toHaveLength(1);
    expect(lost, "the loss is surfaced, not reported as a plain success").toHaveBeenCalledWith(
      "resume-test", "resume_repeatedly_failed",
    );
  });

  it("abandons immediately when the CLI proves there is nothing to resume", async () => {
    const d = makeDaemon();
    armForFailedResume(d, { paneText: "No conversation found to resume" });
    const lost = vi.fn();
    d.on("context_lost", lost);

    await expect(d.spawnClaudeWindow()).rejects.toThrow();

    expect(sessionExists(), "proven gone, so it is set aside on the first failure").toBe(false);
    expect(setAside()).toHaveLength(1);
    expect(lost, "a proven-gone session is not a surprise context loss").not.toHaveBeenCalled();
  });
});

/**
 * The load side of the same incident: startup concurrency was derived from free
 * memory alone, so any host with ~3GB free cold-started ten CLIs at once. On
 * three cores that saturated the CPU, which is what pushed healthy starts past
 * their budget in the first place.
 */
describe("startup concurrency respects cores, not just memory", () => {
  it("clamps to the core count on a small host", async () => {
    const { deriveSpawnConcurrency } = await import("../src/fleet-manager.js");
    // 16GB free would have said 10 under the memory-only rule.
    expect(deriveSpawnConcurrency(16_384, 3), "three cores cannot run ten cold starts").toBe(3);
  });

  it("still lets memory bind when cores are plentiful", async () => {
    const { deriveSpawnConcurrency } = await import("../src/fleet-manager.js");
    expect(deriveSpawnConcurrency(900, 32)).toBe(3);
  });

  it("keeps a floor of 2 and a ceiling of 10", async () => {
    const { deriveSpawnConcurrency } = await import("../src/fleet-manager.js");
    expect(deriveSpawnConcurrency(1, 1), "never zero").toBe(2);
    expect(deriveSpawnConcurrency(64_000, 64), "never unbounded").toBe(10);
  });

  it("spawnConcurrency actually delegates to it (wiring, not just the formula)", async () => {
    const { FleetManager, deriveSpawnConcurrency } = await import("../src/fleet-manager.js");
    const { freemem, cpus } = await import("node:os");
    const fm = new FleetManager(dir) as any;
    fm.fleetConfig = { defaults: {}, instances: {} };

    expect(fm.spawnConcurrency())
      .toBe(deriveSpawnConcurrency(Math.round(freemem() / (1024 * 1024)), cpus().length));
  });

  it("an explicit setting still wins", async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = new FleetManager(dir) as any;
    fm.fleetConfig = { defaults: { startup: { concurrency: 8 } }, instances: {} };
    expect(fm.spawnConcurrency()).toBe(8);
  });
});
