import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";

const dirs: string[] = [];
const priorHome = process.env.CODEX_HOME;
afterEach(() => {
  vi.restoreAllMocks();
  if (priorHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = priorHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function legacyFleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-legacy-"));
  dirs.push(dir);
  const cwd = join(dir, "project");
  const shared = join(dir, "shared-codex");
  const instance = join(dir, "instances", "legacy");
  mkdirSync(cwd);
  mkdirSync(join(instance, "codex-home"), { recursive: true });
  const rolloutDir = join(shared, "sessions", "2026", "09", "24");
  mkdirSync(rolloutDir, { recursive: true });
  const id = "01a0d2a2-325b-7d61-be56-f23c0470c199";
  const rollout = join(rolloutDir, `rollout-${id}.jsonl`);
  writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\nold content stays on disk\n");
  process.env.CODEX_HOME = shared;
  const fleet = new FleetManager(dir);
  fleet.fleetConfig = { defaults: { backend: "codex" }, instances: { legacy: { working_directory: cwd, backend: "codex" } } } as any;
  vi.spyOn(Daemon.prototype, "start").mockResolvedValue(undefined);
  const notify = vi.spyOn(fleet, "notifyInstanceTopicConfirmed").mockResolvedValue(true);
  const config = {
    working_directory: cwd, backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent",
  } as any;
  return { dir, cwd, instance, rollout, fleet, notify, config };
}

describe("safety-first Codex upgrade", () => {
  it("does not count a dispatched but rejected platform send as a migration notice", async () => {
    const f = legacyFleet();
    const sendText = vi.fn().mockRejectedValueOnce(new Error("platform refused"))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(f.fleet as any, "getAdapterForInstance").mockReturnValue({ sendText });
    vi.spyOn(f.fleet as any, "getInstanceAdapterId").mockReturnValue("discord");
    vi.spyOn(f.fleet as any, "getChannelConfig").mockReturnValue({ group_id: "guild" });
    f.fleet.fleetConfig!.instances.legacy.topic_id = "topic";
    f.notify.mockRestore();
    expect(await f.fleet.notifyInstanceTopicConfirmed("legacy", "notice")).toBe(false);
    expect(await f.fleet.notifyInstanceTopicConfirmed("legacy", "notice")).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledWith("guild", "notice", { threadId: "topic" });
  });

  it("lets a verified live pane override an old crash-loop skip, but never guesses an ID", () => {
    const f = legacyFleet();
    const id = "01a0d2a2-325b-7d61-be56-f23c0470c199";
    const backend = { binaryName: "codex", getSessionId: vi.fn(() => id) } as any;
    const logger = { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } as any;
    const daemon = new Daemon("legacy", f.config, f.instance, false, backend, undefined, logger);
    (daemon as any).skipResume = true;
    expect((daemon as any).checkpointLivePaneBeforeReplacement()).toBe(id);
    expect((daemon as any).skipResume).toBe(false);
    expect(readFileSync(join(f.instance, "session-id"), "utf8")).toBe(id);

    const unknown = new Daemon("legacy", f.config, f.instance, false,
      { binaryName: "codex", getSessionId: () => null } as any, undefined, logger);
    (unknown as any).skipResume = true;
    expect((unknown as any).checkpointLivePaneBeforeReplacement()).toBeNull();
    expect((unknown as any).skipResume).toBe(true);

    rmSync(join(f.instance, "session-id"));
    mkdirSync(join(f.instance, "session-id")); // force the durable checkpoint to fail
    const unwritable = new Daemon("legacy", f.config, f.instance, false, backend, undefined, logger);
    (unwritable as any).skipResume = true;
    expect((unwritable as any).checkpointLivePaneBeforeReplacement()).toBeNull();
    expect((unwritable as any).skipResume).toBe(true);
  });

  it("starts without guessing --last, notifies once, and preserves the old rollout", async () => {
    const f = legacyFleet();
    await f.fleet.lifecycle.start("legacy", f.config, true);
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify.mock.calls[0][1]).toContain("agend fleet codex-resume legacy <session-id>");
    expect(existsSync(join(f.instance, "codex-migration-notified"))).toBe(true);
    expect(existsSync(f.rollout)).toBe(true);
    f.fleet.lifecycle.daemons.delete("legacy");
    await f.fleet.lifecycle.start("legacy", f.config, true);
    expect(f.notify).toHaveBeenCalledOnce();
  });

  it("does not mark an undelivered upgrade notice as delivered", async () => {
    const f = legacyFleet();
    f.notify.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await f.fleet.lifecycle.start("legacy", f.config, true);
    expect(existsSync(join(f.instance, "codex-migration-pending"))).toBe(true);
    expect(existsSync(join(f.instance, "codex-migration-notified"))).toBe(false);
    f.fleet.lifecycle.daemons.delete("legacy");
    await f.fleet.lifecycle.start("legacy", f.config, true);
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(existsSync(join(f.instance, "codex-migration-notified"))).toBe(true);
    expect(existsSync(join(f.instance, "codex-migration-pending"))).toBe(false);
  });

  it("holds an existing but unverifiable identity; never treats it as migration", async () => {
    const f = legacyFleet();
    rmSync(f.rollout);
    writeFileSync(join(f.instance, "session-id"), "old-unverified-id");
    const held = vi.spyOn(f.fleet, "notifyInstanceTopic").mockReturnValue(true);
    await f.fleet.lifecycle.start("legacy", f.config, true);
    expect(held).toHaveBeenCalledOnce();
    expect(held.mock.calls[0][1]).toContain("identity could not be verified");
    expect(f.notify).not.toHaveBeenCalled();
    expect(existsSync(join(f.instance, "codex-migration-pending"))).toBe(false);
    expect(existsSync(join(f.instance, "session-id"))).toBe(true);
    expect(f.fleet.lifecycle.daemons.has("legacy")).toBe(false);
  });

  it("does not mistake a newly created ID for proof that the old pane was resumed", async () => {
    const f = legacyFleet();
    const id = "01a0d2a2-325b-7d61-be56-f23c0470c199";
    vi.spyOn(Daemon.prototype, "start").mockImplementation(async function () {
      writeFileSync(join(f.instance, "session-id"), id);
      writeFileSync(join(f.instance, "codex-session.json"), JSON.stringify({
        id, owner: "legacy", cwd: f.cwd, rolloutPath: f.rollout,
      }));
    });
    await f.fleet.lifecycle.start("legacy", f.config, true);
    expect(f.notify).toHaveBeenCalledOnce();
  });

  it("retains a pending notice even after a fresh session acquired a valid ID", async () => {
    const f = legacyFleet();
    const id = "01a0d2a2-325b-7d61-be56-f23c0470c199";
    f.notify.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.spyOn(Daemon.prototype, "start").mockImplementation(async function () {
      writeFileSync(join(f.instance, "session-id"), id);
      writeFileSync(join(f.instance, "codex-session.json"), JSON.stringify({
        id, owner: "legacy", cwd: f.cwd, rolloutPath: f.rollout,
      }));
    });
    await f.fleet.lifecycle.start("legacy", f.config, true);
    expect(existsSync(join(f.instance, "codex-migration-pending"))).toBe(true);
    f.fleet.lifecycle.daemons.delete("legacy");
    await f.fleet.lifecycle.start("legacy", f.config, true);
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(existsSync(join(f.instance, "codex-migration-notified"))).toBe(true);
    expect(existsSync(join(f.instance, "codex-migration-pending"))).toBe(false);
  });

  it("retries a rejected upgrade notice while the new instance stays running", async () => {
    vi.useFakeTimers();
    try {
      const f = legacyFleet();
      f.notify.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await f.fleet.lifecycle.start("legacy", f.config, true);
      expect(existsSync(join(f.instance, "codex-migration-pending"))).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.notify).toHaveBeenCalledTimes(2);
      expect(existsSync(join(f.instance, "codex-migration-notified"))).toBe(true);
      expect(existsSync(join(f.instance, "codex-migration-pending"))).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("continues silently only when the live old pane supplied a verified ID", async () => {
    const f = legacyFleet();
    vi.spyOn(Daemon.prototype, "getRecoveredLegacyCodexSessionId").mockReturnValue("01a0d2a2-325b-7d61-be56-f23c0470c199");
    await f.fleet.lifecycle.start("legacy", f.config, true);
    expect(f.notify).not.toHaveBeenCalled();
    expect(existsSync(join(f.instance, "codex-migration-notified"))).toBe(false);
  });
});
