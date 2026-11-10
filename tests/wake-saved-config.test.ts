import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { SupersededStartError } from "../src/instance-lifecycle.js";
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { applyInstanceConfigPatch, type InstanceConfigPatch } from "../src/outbound-handlers.js";
import { credentialProfileHome } from "../src/backend/credential-profile.js";
import * as availability from "../src/backend-availability.js";
import { writePausedMarker, clearPausedMarker, hasPausedMarker, readPausedAt, readPauseReason } from "../src/pause-marker.js";

const rigs: Array<{ dir: string; fm: any }> = [];
afterEach(() => {
  for (const { dir, fm } of rigs.splice(0)) {
    fm.memoryPressure?.stop(); fm.spawnGate.shutdown(); fm.stormWindow.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "agend-wake-config-"));
  vi.stubEnv("HOME", dir); vi.stubEnv("AGEND_HOME", dir); vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  vi.stubEnv("ANTHROPIC_API_KEY", ""); vi.stubEnv("ANTHROPIC_BASE_URL", "");
  const work = join(dir, "workspace"); mkdirSync(work);
  for (const profile of ["before", "after"]) {
    const home = credentialProfileHome(dir, "claude-code", profile);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "inert" } }));
  }
  const capture = join(dir, "launches.jsonl"), helper = join(dir, "owned-cli-env-probe");
  // This inert Node child only records its environment/argv. No CLI, tmux,
  // vendor, model, account, fleet start, or lifecycle command is executed.
  writeFileSync(helper, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.WAKE_CAPTURE, JSON.stringify({home:process.env.CLAUDE_CONFIG_DIR,args:process.argv.slice(2)})+'\\n');\n`, { mode: 0o700 });
  vi.spyOn(availability, "resolveBackendBinary").mockResolvedValue(helper);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, yaml.dump({ defaults: { backend: "claude-code", model: "sonnet" }, instances: {
    worker: { working_directory: work, backend_options: { "claude-code": { credential_profile: "before" } } },
  } }));
  const fm = new FleetManager(dir) as any; rigs.push({ dir, fm }); fm.loadConfig(path);
  fm.startCliEnvProbeWorker = () => ({ promise: Promise.resolve(null), stopped: Promise.resolve(), terminate() {} });
  vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
  const launch = (daemon: any) => {
    daemon.backend.binaryPath = helper;
    const config = daemon.buildBackendConfig();
    const command = daemon.backend.buildCommand(config);
    execFileSync("/bin/sh", ["-c", command], { env: { HOME: dir, AGEND_HOME: dir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, WAKE_CAPTURE: capture }, timeout: 5000 });
    clearPausedMarker(daemon.instanceDir);
  };
  const start = vi.spyOn(Daemon.prototype, "start").mockImplementation(async function (this: Daemon) { launch(this); });
  const stop = vi.spyOn(Daemon.prototype, "stop").mockResolvedValue(undefined);
  vi.spyOn(Daemon.prototype as any, "trySpawn").mockImplementation(async function (this: Daemon) { launch(this); return true; });
  vi.spyOn(Daemon.prototype as any, "resetTranscriptBeforeAdmission").mockResolvedValue(true);
  vi.spyOn(Daemon.prototype as any, "resumeRuntimeMonitors").mockImplementation(() => {});
  const pause = vi.spyOn(Daemon.prototype, "pause").mockImplementation(async function (this: any) {
    this.pauseWakeState = "paused"; this.autoPauseController.markPaused(1234);
    writePausedMarker(this.instanceDir, 1234, "operator");
  });
  await fm.lifecycle.start("worker", fm.fleetConfig.instances.worker, false);
  const old = fm.daemons.get("worker") as Daemon;
  await fm.lifecycle.pause("worker");
  const launches = () => readFileSync(capture, "utf8").trim().split("\n").map(x => JSON.parse(x));
  const save = (patch: InstanceConfigPatch) => {
    let error: string | undefined, result: any;
    applyInstanceConfigPatch(fm, "worker", patch, (value, why) => { result = value; error = why; });
    expect(error).toBeUndefined(); expect(result.success).toBe(true);
    expect(fm.lifecycle.isPaused("worker")).toBe(true); expect(launches()).toHaveLength(1);
    return yaml.load(readFileSync(path, "utf8")) as any;
  };
  return { fm, old, save, launches, launch, start, stop, pause, dir };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function wakeEntered(fm: any): Promise<void> {
  const entered = deferred(), run = fm.lifecycle.wakeInTransition.bind(fm.lifecycle);
  vi.spyOn(fm.lifecycle, "wakeInTransition").mockImplementation((...args: any[]) => {
    const flight = run(...args); entered.resolve(); return flight;
  });
  return entered.promise;
}
async function heldRealPause(r: Awaited<ReturnType<typeof rig>>) {
  r.pause.mockRestore();
  const old = r.old as any;
  await old.autoPauseController.wakeOnDeliver(async () => {});
  old.pauseWakeState = "active"; old.instanceState = "idle";
  clearPausedMarker(old.instanceDir);
  const gate = deferred(), entered = deferred();
  let exited = false, retired = false, settled = false;
  old.tmux = { getWindowId: () => "%inert", capturePane: async () => "",
    getPaneStatus: async () => { if (retired) throw Error("retired synthetic pane"); return { alive: !exited }; } };
  vi.spyOn(old, "checkpointSessionId").mockImplementation(() => { entered.resolve(); return gate.promise; });
  vi.spyOn(old, "sendQuitSequence").mockImplementation(async () => { exited = true; });
  const resumed = vi.spyOn(old, "resumeRuntimeMonitors").mockImplementation(() => {});
  const stopBeforeSettlement: boolean[] = [];
  r.stop.mockImplementation(async () => { stopBeforeSettlement.push(!settled); retired = true; });
  const pausing = old.pause("operator").then(() => { settled = true; });
  void pausing.catch(() => {}); // Cleanup always joins it; observe rejection immediately during red probes.
  await entered.promise;
  return { pausing, release: gate.resolve, resumed, stopBeforeSettlement };
}

describe("a paused fleet Agent adopts saved launch settings at wake", () => {
  it.each(["profile", "model", "both"] as const)("saved %s reaches the next child, without an explicit restart", async kind => {
    const r = await rig();
    const profile = kind !== "model", model = kind !== "profile";
    const raw = r.save({ ...(profile ? { backend_options: { "claude-code": { credential_profile: "after" } } } : {}), ...(model ? { model: "opus" } : {}) });
    if (profile) expect(raw.instances.worker.backend_options["claude-code"].credential_profile).toBe("after");
    if (model) expect(raw.instances.worker.model).toBe("opus");
    await r.fm.explicitWake("worker");
    const child = r.launches().at(-1)!;
    expect(child.home).toBe(credentialProfileHome(r.dir, "claude-code", profile ? "after" : "before"));
    expect(child.args).toContain(model ? "opus" : "sonnet");
    expect(r.launches()).toHaveLength(2); expect(r.fm.lifecycle.isPaused("worker")).toBe(false);
  });
  it("delivery-coordinator wakes use the saved config too, and concurrent wakes join one replacement", async () => {
    const r = await rig(); r.save({ model: "opus" });
    await Promise.all([r.fm.lifecycle.wake("worker", 30_000, undefined, { source: "coordinator" }), r.fm.explicitWake("worker")]);
    expect(r.launches()).toHaveLength(2); expect(r.launches()[1].args).toContain("opus");
    expect(r.stop).toHaveBeenCalledOnce(); expect(r.fm.daemons.get("worker")).not.toBe(r.old);
  });
  it("a changed inherited model is resolved at wake as it is at a cold start", async () => {
    const r = await rig(); r.fm.fleetConfig.defaults.model = "opus"; r.fm.saveFleetConfig();
    expect(r.fm.fleetConfig.instances.worker.model).toBe("opus");
    await r.fm.explicitWake("worker");
    expect(r.launches()[1].args).toContain("opus"); expect(r.launches()).toHaveLength(2);
  });
  it("a failed replacement preserves the pause and can retry the saved profile", async () => {
    const r = await rig(); r.save({ backend_options: { "claude-code": { credential_profile: "after" } } });
    r.start.mockRejectedValueOnce(Error("inert launch failure"));
    await expect(r.fm.explicitWake("worker")).rejects.toThrow("inert launch failure");
    const instanceDir = r.fm.getInstanceDir("worker");
    expect(hasPausedMarker(instanceDir)).toBe(true); expect(readPausedAt(instanceDir)).toBe(1234);
    expect(readPauseReason(instanceDir)).toBe("operator"); expect(r.fm.daemons.has("worker")).toBe(false);
    expect(r.launches()).toHaveLength(1);
    await r.fm.explicitWake("worker");
    expect(r.launches()[1].home).toBe(credentialProfileHome(r.dir, "claude-code", "after"));
    expect(hasPausedMarker(instanceDir)).toBe(false);
  });
  it("a stop requested during replacement cleanup cannot be revived by the old wake", async () => {
    const r = await rig(); r.save({ model: "opus" });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    r.stop.mockImplementationOnce(() => held);
    const waking = r.fm.explicitWake("worker");
    const refused = expect(waking).rejects.toBeInstanceOf(SupersededStartError);
    await vi.waitFor(() => expect(r.stop).toHaveBeenCalledOnce());
    const stopping = r.fm.lifecycle.stop("worker"); release();
    await refused; await stopping;
    expect(r.launches()).toHaveLength(1); expect(r.fm.daemons.has("worker")).toBe(false);
    expect(readPausedAt(r.fm.getInstanceDir("worker"))).toBe(1234);
  });
  it("settles a held real pause before replacing, then reads the latest saved profile and model", async () => {
    const r = await rig(); vi.useFakeTimers();
    const pause = await heldRealPause(r); r.save({ model: "opus" });
    const entered = wakeEntered(r.fm), waking = r.fm.explicitWake("worker");
    try {
      await entered;
      expect(r.stop).not.toHaveBeenCalled(); expect(r.launches()).toHaveLength(1);
      expect(r.fm.daemons.get("worker")).toBe(r.old);
      // A second accepted save during the wait must not be replaced by a pre-wait snapshot.
      r.save({ backend_options: { "claude-code": { credential_profile: "after" } } });
      pause.release(); await vi.advanceTimersByTimeAsync(200);
      await pause.pausing; await waking;
      expect(pause.stopBeforeSettlement).toEqual([false]); expect(pause.resumed).not.toHaveBeenCalled();
      expect(r.launches()).toHaveLength(2);
      expect(r.launches()[1].home).toBe(credentialProfileHome(r.dir, "claude-code", "after"));
      expect(r.launches()[1].args).toContain("opus"); expect(r.fm.daemons.get("worker")).not.toBe(r.old);
    } finally {
      pause.release(); await vi.advanceTimersByTimeAsync(200);
      await Promise.allSettled([pause.pausing, waking]);
    }
  });
  it("a Stop during a held real pause supersedes the waiting cold wake", async () => {
    const r = await rig(); vi.useFakeTimers();
    const pause = await heldRealPause(r); r.save({ model: "opus" });
    const entered = wakeEntered(r.fm), waking = r.fm.explicitWake("worker");
    const outcome = waking.then(() => null, (err: unknown) => err);
    const stops = vi.spyOn(r.fm.lifecycle, "stop");
    let stopping: Promise<void> | undefined;
    try {
      await entered; expect(r.stop).not.toHaveBeenCalled();
      stopping = r.fm.lifecycle.stop("worker");
      pause.release(); await vi.advanceTimersByTimeAsync(200); await pause.pausing;
      expect(await outcome).toBeInstanceOf(SupersededStartError); await stopping;
      expect(stops).toHaveBeenCalledOnce(); // Only the newer Stop, not an extra cold teardown.
      expect(r.launches()).toHaveLength(1); expect(r.fm.daemons.has("worker")).toBe(false);
      expect(pause.stopBeforeSettlement).toEqual([false]); expect(pause.resumed).not.toHaveBeenCalled();
    } finally {
      pause.release(); await vi.advanceTimersByTimeAsync(200);
      await Promise.allSettled([pause.pausing, waking, stopping]);
    }
  });
  it("an owner change while a real pause settles cannot retire the replacement", async () => {
    const r = await rig(); vi.useFakeTimers();
    const pause = await heldRealPause(r); r.save({ model: "opus" });
    const entered = wakeEntered(r.fm), waking = r.fm.explicitWake("worker");
    const outcome = waking.then(() => null, (err: unknown) => err);
    try {
      await entered; expect(r.stop).not.toHaveBeenCalled();
      const replacement = new Daemon("worker", r.fm.fleetConfig.instances.worker, r.fm.getInstanceDir("worker"), false, undefined, undefined, r.fm.logger);
      const stopReplacement = vi.spyOn(replacement, "stop").mockResolvedValue(undefined);
      r.fm.daemons.set("worker", replacement);
      pause.release(); await vi.advanceTimersByTimeAsync(200); await pause.pausing;
      expect(await outcome).toBeInstanceOf(SupersededStartError);
      expect(r.fm.daemons.get("worker")).toBe(replacement); expect(stopReplacement).not.toHaveBeenCalled();
      expect(r.launches()).toHaveLength(1); expect(pause.resumed).not.toHaveBeenCalled();
    } finally {
      pause.release(); await vi.advanceTimersByTimeAsync(200);
      await Promise.allSettled([pause.pausing, waking]);
    }
  });
  it("joins a real wake already in progress without replacing or launching twice", async () => {
    const r = await rig(), gate = deferred(), spawned = deferred();
    vi.spyOn(r.old as any, "trySpawn").mockImplementationOnce(async () => {
      spawned.resolve(); await gate.promise; r.launch(r.old); return true;
    });
    const direct = r.old.wake(); await spawned.promise;
    r.save({ model: "opus" });
    const entered = wakeEntered(r.fm), joined = r.fm.explicitWake("worker");
    try {
      await entered; expect(r.stop).not.toHaveBeenCalled(); expect(r.launches()).toHaveLength(1);
      gate.resolve(); await Promise.all([direct, joined]);
      expect(r.fm.daemons.get("worker")).toBe(r.old); expect(r.launches()).toHaveLength(2);
      expect(r.launches()[1].args).toContain("sonnet"); expect(r.stop).not.toHaveBeenCalled();
    } finally { gate.resolve(); await Promise.allSettled([direct, joined]); }
  });
  it("an unchanged wake preserves the resident daemon and its window path", async () => {
    const r = await rig(); await r.fm.explicitWake("worker");
    expect(r.fm.daemons.get("worker")).toBe(r.old); expect(r.stop).not.toHaveBeenCalled();
    expect(r.launches()).toHaveLength(2); expect(r.launches()[1].home).toBe(r.launches()[0].home);
  });
  it("a hot-only edit does not turn wake into a cold replacement", async () => {
    const r = await rig(); r.save({ description: "New description" });
    await r.fm.explicitWake("worker");
    expect(r.fm.daemons.get("worker")).toBe(r.old); expect(r.stop).not.toHaveBeenCalled(); expect(r.launches()).toHaveLength(2);
  });
});
