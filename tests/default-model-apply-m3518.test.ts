import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import type { ApplyJob } from "../src/apply-job.js";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(secondRunning = false) {
  const dir = mkdtempSync(join(tmpdir(), "default-apply-")); dirs.push(dir);
  const path = join(dir, "fleet.yaml");
  writeFileSync(path, `defaults: {backend: claude-code, model: old}\ninstances:\n  one: {working_directory: /tmp/one}\n  stopped: {working_directory: /tmp/stopped}\n  other: {working_directory: /tmp/other, backend: grok}\n`);
  const fm = new FleetManager(dir); fm.loadConfig(path);
  const runtime = structuredClone(fm.fleetConfig!.instances.one);
  const daemon = { getConfigSnapshot: () => runtime, applyConfigUpdate: vi.fn() };
  fm.lifecycle.daemons.set("one", daemon as never);
  if (secondRunning) {
    const secondConfig = structuredClone(fm.fleetConfig!.instances.stopped);
    fm.lifecycle.daemons.set("stopped", { getConfigSnapshot: () => secondConfig } as never);
  }
  const stop = vi.spyOn(fm, "stopInstance").mockResolvedValue({ backgroundWorkEnded: false });
  const start = vi.spyOn(fm as any, "startInstanceUnattended").mockResolvedValue(undefined);
  fm.fleetConfig!.defaults.model = "new";
  fm.saveFleetConfig();
  return { fm, runtime, daemon, stop, start };
}
async function apply(fm: FleetManager, key: string, choice?: "next-start" | "restart") {
  const { job } = fm.startSettingsApply(key, choice, choice === "restart" ? ["one"] : []) as { job: ApplyJob };
  await vi.waitFor(() => expect(fm.applyJobs.get(job.id)?.status).toBe("done"));
  return fm.applyJobs.get(job.id)!;
}
it("saves without restarting or waking stopped agents; unrelated applies retain the pending choice", async () => {
  const { fm, runtime, daemon, stop, start } = setup();
  const first = await apply(fm, "shared-first-apply");
  expect(first.targets.find(r => r.target === "one")?.status).toBe("next-start");
  expect(first.targets.find(r => r.target === "stopped")?.status).toBe("next-start");
  expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  expect(runtime.model).toBe("old");
  fm.fleetConfig!.instances.one.log_level = "debug"; fm.saveFleetConfig();
  await apply(fm, "shared-unrelated-apply");
  expect(daemon.applyConfigUpdate).toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  expect(fm.getRawFleetConfig().instances?.one?.model).toBeUndefined();
  expect(fm.fleetConfig!.instances.other.model).toBeUndefined();
});
it("restarts a running target only with explicit choice, while stopped targets remain stopped", async () => {
  const { fm, stop, start } = setup();
  const job = await apply(fm, "shared-explicit-restart", "restart");
  expect(stop).toHaveBeenCalledExactlyOnceWith("one");
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0][1].model).toBe("new");
  expect(job.targets.find(r => r.target === "one")?.status).toBe("done");
  expect(job.targets.find(r => r.target === "stopped")?.status).toBe("next-start");
});
it("deferral does not hide a later unrelated cold edit", async () => {
  const { fm, stop } = setup();
  await apply(fm, "shared-cold-first");
  fm.fleetConfig!.instances.one.working_directory = "/tmp/changed"; fm.saveFleetConfig();
  await apply(fm, "shared-cold-second");
  expect(stop).toHaveBeenCalledExactlyOnceWith("one");
});
it("keeps a paused daemon deferred even when a restart of running agents is authorized", async () => {
  const { fm, stop, start } = setup();
  vi.spyOn(fm.lifecycle, "isPaused").mockReturnValue(true);
  const job = await apply(fm, "shared-paused-apply", "restart");
  expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  expect(job.targets.find(r => r.target === "one")?.status).toBe("next-start");
});
it("shows the running identity until an explicit next start, without persisting an agent override", async () => {
  const { fm, runtime } = setup();
  expect(fm.resolveInstanceModel("one").model).toBe("old");
  fm.fleetConfig!.defaults.backend = "codex"; fm.fleetConfig!.defaults.model = "new-codex"; fm.saveFleetConfig();
  expect((fm as any).backendNameForInstance("one")).toBe("claude-code");
  await apply(fm, "shared-backend-deferred");
  expect(fm.resolveInstanceModel("one").model).toBe("old");
  const next = structuredClone(fm.fleetConfig!.instances.one);
  fm.lifecycle.daemons.set("one", { getConfigSnapshot: () => next } as never);
  expect((fm as any).backendNameForInstance("one")).toBe("codex");
  expect(fm.resolveInstanceModel("one").model).toBe("new-codex");
  expect(runtime.model).toBe("old");
  expect(fm.getRawFleetConfig().instances?.one?.model).toBeUndefined();
});
it("an explicit own model edit replaces deferred shared adoption even at the same target value", async () => {
  const { fm, stop } = setup();
  fm.fleetConfig!.instances.one.model = "new";
  fm.saveFleetConfig([{ path: ["instances", "one", "model"], value: "new" }]);
  await apply(fm, "shared-own-model-edit");
  expect(stop).toHaveBeenCalledExactlyOnceWith("one");
  expect(fm.getRawFleetConfig().instances?.one?.model).toBe("new");
});
it("a retry of the same apply key cannot add restart consent", async () => {
  const { fm, stop } = setup();
  const first = await apply(fm, "shared-same-apply-key");
  const second = fm.startSettingsApply("shared-same-apply-key", "restart");
  expect("job" in second && second.job.id).toBe(first.id);
  expect(stop).not.toHaveBeenCalled();
});

import { ClassicChannelManager } from "../src/classic-channel-manager.js";
it("a Classic room's named login does not turn a deferred backend edit into a profile restart", async () => {
  const { fm, stop, start } = setup();
  const dir = (fm as any).dataDir;
  fm.lifecycle.daemons.delete("one"); // this case isolates the Classic profile path, not an independent Fleet credential edit
  writeFileSync(join(dir, "classicBot.yaml"), "channels:\n  example-room:\n    channelId: example-channel\n    adapterId: discord\n    instanceName: example-room\n");
  const classic = new ClassicChannelManager(dir, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any);
  classic.configureAdapters([{ id: "discord", type: "discord" }]);
  (fm as any).classicChannels = classic;
  fm.fleetConfig!.defaults.backend_options = { "claude-code": { credential_profile: "example-profile" } };
  fm.saveFleetConfig();
  const room = { backend: "claude-code", model: "new", working_directory: "/tmp/example-room",
    backend_options: { "claude-code": { credential_profile: "example-profile" } } };
  fm.lifecycle.daemons.set("example-room", { getConfigSnapshot: () => room } as never);
  const restartClassic = vi.spyOn(fm as any, "startClassicInstanceUnattended").mockResolvedValue(undefined);
  vi.spyOn(fm as any, "reregisterClassicChannels").mockImplementation(() => undefined);
  fm.fleetConfig!.defaults.backend = "codex"; fm.fleetConfig!.defaults.model = "gpt-test"; fm.saveFleetConfig();
  const job = await apply(fm, "shared-classic-deferred");
  expect(job.targets.find(r => r.target === "example-room")?.status).toBe("next-start");
  expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(restartClassic).not.toHaveBeenCalled();
  writeFileSync(join(dir, "classicBot.yaml"), "channels:\n  example-room:\n    channelId: example-channel\n    adapterId: discord\n    instanceName: example-room\n    description: Example room description\n");
  await (fm as any).reloadClassicConfigFromDisk();
  expect(stop).not.toHaveBeenCalled(); expect(restartClassic).not.toHaveBeenCalled();
});

it("R1: restart consent covers only the names shown in the confirmation", async () => {
  const { fm, stop } = setup(true);
  const { job } = fm.startSettingsApply("shared-confirmed-names", "restart", ["one"]) as { job: ApplyJob };
  await vi.waitFor(() => expect(fm.applyJobs.get(job.id)?.status).toBe("done"));
  expect(stop).toHaveBeenCalledExactlyOnceWith("one");
  expect(fm.applyJobs.get(job.id)?.targets.find(r => r.target === "stopped")?.status).toBe("next-start");
});
it("R1: a restart mode without a confirmed target list never restarts", async () => {
  const { fm, stop } = setup();
  const { job: pending } = fm.startSettingsApply("shared-no-confirmed-names", "restart") as { job: ApplyJob };
  await vi.waitFor(() => expect(fm.applyJobs.get(pending.id)?.status).toBe("done"));
  const job = fm.applyJobs.get(pending.id)!;
  expect(stop).not.toHaveBeenCalled();
  expect(job.targets.find(r => r.target === "one")?.status).toBe("next-start");
});
