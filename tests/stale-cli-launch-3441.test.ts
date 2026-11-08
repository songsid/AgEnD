import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import type { CliLaunchSnapshot } from "../src/cli-launch-inspect.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of roots.splice(0))
  rmSync(p, { recursive: true, force: true }); });
const sid = "11111111-2222-4333-8444-555555555555";
function snapshot(stale: boolean): CliLaunchSnapshot {
  return { chain: [{ pid: 1001, start: "123", dev: 1, ino: 10 }], process: { pid: 1001, start: "123", dev: 1, ino: 10, exe: stale ? "/prefix/node_modules/@anthropic-ai/.claude-code-random/bin/claude.exe (deleted)" : "/prefix/node_modules/@anthropic-ai/claude-code/bin/claude.exe", version: stale ? null : "2.1.319", reason: stale ? "deleted" : null }, installed: { path: "/prefix/bin/claude", real: "/prefix/node_modules/@anthropic-ai/claude-code/bin/claude.exe", version: "2.1.319", stamp: "1:20:1024:1" } };
}
function world() {
  const root = mkdtempSync(join(tmpdir(), "agend-stale-cli-"));
  roots.push(root);
  writeFileSync(join(root, "session-id"), sid);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const backend = { binaryName: "claude", getReadyPattern: () => /❯/, getSessionId: () => sid, launchBinaryPath: () => "/prefix/bin/claude", refreshLaunchBinary: vi.fn() };
  const d: any = new Daemon("general", { backend: "claude-code", working_directory: root, log_level: "silent", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { max_age_hours: 0, grace_period_ms: 600000 } } as any, root, false, backend as any, undefined, { child: () => logger } as any);
  d.tmux = { getWindowId: () => "@1", capturePane: vi.fn(async () => "❯ ") };
  d.trySpawnInsideGate = vi.fn(async () => { d.launchAttempt++; return true; });
  d.inspectCliLaunch = vi.fn(async () => snapshot(false));
  d.refreshCliLaunchPath = vi.fn(async () => "/prefix/bin/claude");
  d.beginSpawn();
  const warnings: any[] = [];
  d.on("backend_launch_warning", (v: any) => warnings.push(v));
  return { d, backend, root, logger, warnings };
}
it("a deleted npm Claude executable gets exactly one same-session restart before spawn admission releases", async () => {
  const w = world();
  w.d.inspectCliLaunch.mockResolvedValueOnce(snapshot(true)).mockResolvedValueOnce(snapshot(true)).mockResolvedValue(snapshot(false));
  expect(await w.d.trySpawn(false)).toBe(true);
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledTimes(2);
  expect(w.d.trySpawnInsideGate.mock.calls[1][0]).toBe(true);
  expect(w.d.spawning).toBe(true);
  expect(readFileSync(join(w.root, "session-id"), "utf8")).toBe(sid);
  expect(w.warnings).toHaveLength(1);
  w.d.endSpawn();
});
it("a replacement which is still deleted cannot enter an automatic restart loop or discard its session", async () => {
  const w = world();
  w.d.inspectCliLaunch.mockResolvedValue(snapshot(true));
  await expect(w.d.trySpawn(false)).rejects.toThrow();
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledTimes(2);
  expect(readFileSync(join(w.root, "session-id"), "utf8")).toBe(sid);
  w.d.endSpawn();
});
it("Claude's exact minimum-version refusal is a recognized CLI error", () => {
  const backend = new ClaudeCodeBackend("/tmp/agend-stale-pattern-only");
  const row = backend.getErrorPatterns().find(p => p.type === "outdated_cli");
  expect(row).toBeDefined();
  expect(row!.pattern.test("● API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.280 or newer is required")).toBe(true);
});
it("healthy and unknown inspections do not change the launch owner or restart anything", async () => {
  for (const value of [snapshot(false), null]) {
    const w = world(), generation = w.d.spawnGeneration;
    w.d.inspectCliLaunch.mockResolvedValue(value);
    expect(await w.d.trySpawn(false)).toBe(true);
    expect(w.d.trySpawnInsideGate).toHaveBeenCalledTimes(1);
    expect(w.d.spawnGeneration).toBe(generation);
    expect(w.warnings).toHaveLength(0);
    w.d.endSpawn();
  }
});
it("an npm temporary image also gets one repair even before it is unlinked", async () => {
  const w = world(), old = snapshot(true);
  old.process.reason = "npm-temporary" as any;
  old.process.exe = old.process.exe.replace(" (deleted)", "");
  w.d.inspectCliLaunch.mockResolvedValueOnce(old).mockResolvedValueOnce(old).mockResolvedValue(snapshot(false));
  await w.d.trySpawn(false);
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledTimes(2);
  w.d.endSpawn();
});
it("a fresh CLI minimum refusal restarts once only when the installed version meets the supplied floor", async () => {
  const w = world(), old = snapshot(false);
  old.process.version = "2.1.220";
  w.d.endSpawn();
  w.d.inspectCliLaunch.mockResolvedValueOnce(old).mockResolvedValueOnce(old).mockResolvedValue(snapshot(false));
  const resumed: string[] = [];
  w.d.trySpawnInsideGate.mockImplementation(async () => { resumed.push(w.d.cliRepairSessionId); w.d.launchAttempt++; return true; });
  await w.d.checkCliLaunchIntegrity(false, { running: "2.1.220", required: "2.1.280" });
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledTimes(1);
  expect(resumed).toEqual([sid]);
  expect(w.warnings).toHaveLength(1);
  expect(w.d.spawning).toBe(false);
});
it.each(["2.1.220", null])("an insufficient or unknown installed version (%s) posts one update notice and never restarts", async (version) => {
  const w = world(), old = snapshot(false);
  old.process.version = "2.1.220";
  old.installed!.version = version;
  w.d.endSpawn();
  w.d.inspectCliLaunch.mockResolvedValue(old);
  await w.d.checkCliLaunchIntegrity(false, { running: "2.1.220", required: "2.1.280" });
  await w.d.checkCliLaunchIntegrity(false, { running: "2.1.220", required: "2.1.280" });
  expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled();
  expect(w.warnings).toHaveLength(1);
  expect(w.warnings[0].message).toContain("2.1.280");
  expect(w.warnings[0].message).toContain("/login");
  expect(w.warnings[0].message).not.toMatch(/npm|host shell|run.*claude/i);
  expect(w.d.cliLaunchRepairUsed).toBe(false);
});
it("a resumed old refusal cannot restart the current compatible process", async () => {
  const w = world();
  w.d.endSpawn();
  await w.d.checkCliLaunchIntegrity(false, { running: "2.1.220", required: "2.1.280" });
  expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled();
  expect(w.warnings).toHaveLength(0);
});
it("the real error-pattern dispatch selects the minimum guard instead of a duplicate generic notice", async () => {
  const w = world(), old = snapshot(false);
  old.process.version = "2.1.220";
  old.installed!.version = "2.1.250";
  w.d.endSpawn();
  w.d.inspectCliLaunch.mockResolvedValue(old);
  const ep = new ClaudeCodeBackend(w.root).getErrorPatterns().find(p => p.type === "outdated_cli")!, errors: any[] = [];
  w.d.on("pty_error", (v: any) => errors.push(v));
  w.d.emitErrorPattern(ep, "minimum", "● API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.280 or newer is required", performance.now());
  await w.d.cliLaunchIntegrityFlight;
  expect(w.warnings).toHaveLength(1);
  expect(errors).toHaveLength(0);
  expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled();
});
it("concurrent detections join the one physical repair and one notice", async () => {
  const w = world();
  w.d.endSpawn();
  let release!: (v: any) => void, entered!: () => void;
  const ready = new Promise<void>(r => entered = r);
  w.d.inspectCliLaunch.mockImplementationOnce(() => { entered(); return new Promise(r => release = r); }).mockResolvedValueOnce(snapshot(true)).mockResolvedValue(snapshot(false));
  const a = w.d.checkCliLaunchIntegrity(false), b = w.d.checkCliLaunchIntegrity(false);
  expect(a).toBe(b);
  await ready;
  release(snapshot(true));
  await a;
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledTimes(1);
  expect(w.warnings).toHaveLength(1);
});
it.each(["window", "fence", "pause"])("a %s change during inspection cancels the old action without touching a replacement", async (what) => {
  const w = world();
  let release!: (v: any) => void, entered!: () => void;
  const ready = new Promise<void>(r => entered = r);
  w.d.inspectCliLaunch.mockImplementationOnce(() => { entered(); return new Promise(r => release = r); });
  const run = w.d.trySpawn(false);
  await ready;
  if (what === "window")
    w.d.tmux = { getWindowId: () => "@2" };
  else if (what === "fence")
    w.d.launchFenceEpoch++;
  else
    w.d.pauseWakeState = "paused";
  release(snapshot(true));
  await run;
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledTimes(1);
  expect(w.warnings).toHaveLength(0);
  w.d.endSpawn();
});
it("a different PID/start identity at final revalidation never authorizes the repair", async () => {
  const w = world(), changed = snapshot(true);
  changed.process.start = "999";
  changed.chain[0]!.start = "999";
  w.d.inspectCliLaunch.mockResolvedValueOnce(snapshot(true)).mockResolvedValueOnce(changed);
  await w.d.trySpawn(false);
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledTimes(1);
  expect(w.warnings).toHaveLength(0);
  w.d.endSpawn();
});
it("a stop during the fresh path lookup never launches its now-stale repair", async () => {
  const w = world();
  w.d.inspectCliLaunch.mockResolvedValue(snapshot(true));
  w.d.refreshCliLaunchPath.mockImplementation(async () => { w.d.launchFenceEpoch++; return "/new/claude"; });
  await w.d.trySpawn(false);
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledTimes(1);
  expect(w.warnings).toHaveLength(0);
  w.d.endSpawn();
});
it("a failed runtime replacement holds delivery and never grants another retry", async () => {
  const w = world();
  w.d.endSpawn();
  w.d.inspectCliLaunch.mockResolvedValue(snapshot(true));
  await w.d.checkCliLaunchIntegrity(false);
  await w.d.checkCliLaunchIntegrity(false);
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledTimes(1);
  expect(w.warnings).toHaveLength(1);
  expect(w.d.cliLaunchIntegrityBlocked).toBe(true);
  const verdict: any = { reached: false };
  expect(w.d.refuseFatalStartupDelivery(verdict)).toBe(true);
  expect(readFileSync(join(w.root, "session-id"), "utf8")).toBe(sid);
});
it("holds delivery across a missing npm target until the stable replacement is available", async () => {
  vi.useFakeTimers();
  const w = world();
  w.d.endSpawn();
  const absent = snapshot(true);
  absent.installed = null;
  let entered!: () => void;
  const waiting = new Promise<void>(r => entered = r);
  w.d.inspectCliLaunch.mockImplementationOnce(async () => { entered(); return absent; }).mockResolvedValueOnce(snapshot(true)).mockResolvedValueOnce(snapshot(true)).mockResolvedValue(snapshot(false));
  try {
    const run = w.d.checkCliLaunchIntegrity(false);
    await waiting;
    await vi.advanceTimersByTimeAsync(0);
    expect(w.d.spawning).toBe(true);
    expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled();
    let released = false;
    const delivery = w.d.waitForSpawnToSettle().then(() => released = true);
    await vi.advanceTimersByTimeAsync(249);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    await delivery;
    expect(w.d.trySpawnInsideGate).toHaveBeenCalledOnce();
    expect(released).toBe(true);
    expect(w.warnings).toHaveLength(1);
  }
  finally {
    vi.useRealTimers();
  }
});
it("a missing stable install times out without launching or consuming another repair", async () => {
  vi.useFakeTimers();
  const w = world();
  w.d.endSpawn();
  const absent = snapshot(true);
  absent.installed = null;
  w.d.inspectCliLaunch.mockResolvedValue(absent);
  try {
    const run = w.d.checkCliLaunchIntegrity(false);
    await vi.advanceTimersByTimeAsync(10001);
    await run;
    await w.d.checkCliLaunchIntegrity(false);
    expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled();
    expect(w.d.cliLaunchIntegrityBlocked).toBe(true);
    expect(w.warnings).toHaveLength(1);
  }
  finally {
    vi.useRealTimers();
  }
});
it("a live turn or dialog is never killed for an optional executable repair", async () => {
  const w = world();
  w.d.endSpawn();
  w.d.inspectCliLaunch.mockResolvedValue(snapshot(true));
  w.d.tmux.capturePane.mockResolvedValue("not an idle composer");
  await w.d.checkCliLaunchIntegrity(false);
  expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled();
  expect(w.warnings).toHaveLength(1);
  expect(w.d.cliLaunchIntegrityBlocked).toBe(true);
});
it("an exceptional repair failure is terminal startup evidence, not a failed-resume retry", async () => {
  const w = world();
  w.d.inspectCliLaunch.mockResolvedValue(snapshot(true));
  w.d.refreshCliLaunchPath.mockRejectedValue(new Error("disk disappeared"));
  await expect(w.d.trySpawn(false)).rejects.toMatchObject({ name: "UnsupportedCliError" });
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledOnce();
  expect(readFileSync(join(w.root, "session-id"), "utf8")).toBe(sid);
  w.d.endSpawn();
});
it("the repair budget cannot renew after a later natural spawn", async () => {
  const w = world();
  w.d.inspectCliLaunch.mockResolvedValueOnce(snapshot(true)).mockResolvedValueOnce(snapshot(true)).mockResolvedValue(snapshot(false));
  await w.d.trySpawn(false);
  w.d.endSpawn();
  w.d.beginSpawn();
  w.d.inspectCliLaunch.mockResolvedValue(snapshot(true));
  await expect(w.d.trySpawn(false)).rejects.toThrow();
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledTimes(3);
  w.d.endSpawn();
});
it("an explicit fresh start never resurrects the old saved UUID during repair", async () => {
  const w = world();
  w.d.skipResume = true;
  w.d.inspectCliLaunch.mockResolvedValueOnce(snapshot(true)).mockResolvedValueOnce(snapshot(true)).mockResolvedValue(snapshot(false));
  const pins: any[] = [];
  w.d.trySpawnInsideGate.mockImplementation(async () => { pins.push(w.d.cliRepairSessionId); w.d.launchAttempt++; return true; });
  await w.d.trySpawn(false);
  expect(pins).toEqual([undefined, undefined]);
  w.d.endSpawn();
});
it("the backend emits only a validated, explicit same-session repair argument", () => {
  const w = world(), backend = new ClaudeCodeBackend(w.root), base = { instanceName: "general", workingDirectory: w.root, instanceDir: w.root, mcpServers: {} };
  const resumed = backend.buildCommand({ ...base, resumeSessionId: sid });
  expect(resumed).toContain(`--resume '${sid}'`);
  expect(resumed).not.toContain("--continue");
  const fresh = backend.buildCommand({ ...base, resumeSessionId: sid, skipResume: true });
  expect(fresh).not.toContain("--resume");
  const bad = backend.buildCommand({ ...base, resumeSessionId: "bad; touch /tmp/never" });
  expect(bad).not.toContain("bad;");
});
it("a repair superseded while tmux applies sizing never reaches respawn-window", async () => {
  const { TmuxManager } = await import("../src/tmux-manager.js"), { tmuxExecHelper } = await import("../src/tmux-exec-helper.js");
  const manager: any = new TmuxManager("owned-fixture", "@1");
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(r => entered = r);
  manager.applyLogicalSize = () => { entered(); return new Promise<void>(r => release = r); };
  const exec = vi.spyOn(tmuxExecHelper, "exec").mockResolvedValue({ stdout: "", stderr: "" });
  let current = true;
  const run = manager.respawnWindow("owned-command", "/tmp", () => { if (!current)
    throw new Error("stopped"); });
  await ready;
  current = false;
  release();
  await expect(run).rejects.toThrow("stopped");
  expect(exec).not.toHaveBeenCalled();
});
it("minimum checks inspect the currently resolved install, not the backend's cached old executable", async () => {
  const w = world();
  w.d.endSpawn();
  const old = snapshot(false);
  old.process.version = "2.1.220";
  w.d.refreshCliLaunchPath.mockResolvedValue("/new-prefix/bin/claude");
  w.d.inspectCliLaunch.mockImplementation(async (path?: string) => path === "/new-prefix/bin/claude" ? old : { ...old, installed: { ...old.installed!, version: "2.1.220" } });
  w.d.trySpawnInsideGate.mockImplementation(async () => { w.d.launchAttempt++; w.d.inspectCliLaunch.mockResolvedValue(snapshot(false)); return true; });
  await w.d.checkCliLaunchIntegrity(false, { running: "2.1.220", required: "2.1.280" });
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledOnce();
  expect(w.d.inspectCliLaunch.mock.calls[0][0]).toBe("/new-prefix/bin/claude");
});
it("a late completed package read cannot cross the missing-install deadline", async () => {
  vi.useFakeTimers();
  const w = world(); w.d.endSpawn(); const absent = snapshot(true); absent.installed = null;
  let release!: (value: CliLaunchSnapshot) => void, entered!: () => void;
  const reading = new Promise<void>(r => entered = r);
  w.d.inspectCliLaunch.mockResolvedValueOnce(absent).mockImplementationOnce(() => {
    entered(); return new Promise(r => release = r);
  });
  try {
    const run = w.d.checkCliLaunchIntegrity(false);
    await vi.advanceTimersByTimeAsync(250); await reading;
    await vi.advanceTimersByTimeAsync(10_000); release(snapshot(true)); await run;
    expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled();
    expect(w.d.cliLaunchIntegrityBlocked).toBe(true); expect(w.warnings).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});
it.each(["", "not-a-session-uuid"])("unverifiable saved session %j never falls back to --continue or a fresh conversation", async pin => {
  const w = world(); writeFileSync(join(w.root, "session-id"), pin);
  // Do not let the fixture backend manufacture a valid session at checkpoint.
  w.backend.getSessionId = () => null as any;
  w.d.inspectCliLaunch.mockResolvedValue(snapshot(true));
  await expect(w.d.trySpawn(false)).rejects.toMatchObject({name:"UnsupportedCliError"});
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledOnce(); expect(readFileSync(join(w.root,"session-id"),"utf8")).toBe(pin); w.d.endSpawn();
});
