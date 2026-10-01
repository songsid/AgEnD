/**
 * Phase 2a (design: docs/design/phase2-submit-contract.md §3.3, §1.6), daemon
 * side of "woke, then slept again" (Bug2). Live evidence: doupo-dev-claude's
 * last-inbound-at was a week old (only user channel messages updated it), so a
 * daemon created to wake it paused 1–2 s after it became ready
 * (14:46:42→44, 14:48:08→09) — before the queued work could reach it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon, readLastInboundAt, writeLastInboundAt } from "../src/daemon.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const WEEK_AGO = () => Date.now() - 7 * 24 * 60 * 60_000;

/** A daemon whose persisted last inbound is a week old and whose idle threshold is 10 minutes. */
function staleDaemon() {
  const dir = mkdtempSync(join(tmpdir(), "agend-2a-"));
  dirs.push(dir);
  writeLastInboundAt(dir, WEEK_AGO());
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("worker", {
    working_directory: dir, backend: "claude-code", log_level: "silent", auto_pause_after: 10,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
  } as any, dir, false, { binaryName: "claude" } as any, undefined, { child: () => logger } as any) as any;
  const pauses: Array<{ reason?: string }> = [];
  daemon.on("auto_pause_requested", (e: any) => pauses.push(e));
  const idle = () => daemon.applyInstanceStateSnapshot(
    { state: "idle", observedAt: Date.now(), stateChangedAt: Date.now(), unchangedForMs: 0 }, "❯");
  return { daemon, dir, pauses, idle };
}

describe("a woken daemon is not paused on an inherited idle clock", () => {
  it("baseline: a daemon seeded from a week-old last inbound pauses on its first idle snapshot", () => {
    const { pauses, idle } = staleDaemon();
    idle();
    expect(pauses).toEqual([expect.objectContaining({ reason: "idle" })]);
  });

  it("seedActivityNow (wake/restart/explicit start) gives it a fresh idle window", () => {
    const { daemon, pauses, idle } = staleDaemon();
    daemon.seedActivityNow();
    idle();
    expect(pauses).toEqual([]);
  });
});

describe("submitted work is activity", () => {
  it("a durable submission restarts the idle clock and persists it", () => {
    const { daemon, dir, pauses, idle } = staleDaemon();
    const before = Date.now();
    daemon.finishDurableSubmission({ deliveryId: "d1", attemptNo: 1 }, { proof: "positive" });
    expect(readLastInboundAt(dir)).toBeGreaterThanOrEqual(before);
    idle();
    expect(pauses).toEqual([]);
  });

  it("an unverified submission still counts (the text reached the CLI)", () => {
    const { daemon, pauses, idle } = staleDaemon();
    daemon.finishDurableSubmission({ deliveryId: "d1", attemptNo: 1 }, { proof: "unverified", phase: "submit" });
    idle();
    expect(pauses).toEqual([]);
  });
});

describe("the work lease holds only the idle-timeout pause", () => {
  it("a held lease suppresses the idle pause; releasing it lets the next idle snapshot pause", () => {
    const { daemon, pauses, idle } = staleDaemon();
    let leased = true;
    daemon.setWorkLeaseCheck(() => leased);
    idle();
    expect(pauses).toEqual([]);
    leased = false;
    idle();
    expect(pauses).toEqual([expect.objectContaining({ reason: "idle" })]);
  });

  it("an auth-deferred pause goes ahead under a lease", () => {
    const { daemon, pauses, idle } = staleDaemon();
    daemon.setWorkLeaseCheck(() => true);
    daemon.requestPauseWhenIdle();
    idle();
    expect(pauses).toEqual([expect.objectContaining({ reason: "auth" })]);
  });

  it("a throwing lease check is no lease (fails toward the existing behaviour)", () => {
    const { daemon, pauses, idle } = staleDaemon();
    daemon.setWorkLeaseCheck(() => { throw new Error("db closed"); });
    idle();
    expect(pauses).toHaveLength(1);
  });
});

describe("the pause reason reaches the marker", async () => {
  const { readPauseReason, hasPausedMarker } = await import("../src/pause-marker.js");
  /** Drive the real Daemon.pause against a pane that exits at once. */
  function pausable() {
    const made = staleDaemon();
    const d = made.daemon;
    d.saveSessionId = () => {};
    d.sendQuitSequence = async () => {};
    d.tmux = { getPaneStatus: async () => ({ alive: false }) };
    return made;
  }

  it("records the caller's reason (idle / warm_cap / operator)", async () => {
    for (const reason of ["idle", "warm_cap", "operator"] as const) {
      const { daemon, dir } = pausable();
      await daemon.pause(reason);
      expect(hasPausedMarker(dir)).toBe(true);
      expect(readPauseReason(dir)).toBe(reason);
    }
  });

  it("an auth-deferred pause from a stuck pane records auth", async () => {
    const { daemon, dir } = pausable();
    daemon.instanceState = "stuck";
    daemon.pauseAllowStuck = true;
    await daemon.pause("idle");
    expect(readPauseReason(dir)).toBe("auth");
  });
});
