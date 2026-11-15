import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { CLI_RUNTIME_SWITCH, cliSwitchAllowed } from "../src/backend/cli-runtime-switch.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";

let dir: string;
const models = [
 { id: "grok-code-fast-1", label: "grok-code-fast-1" },
 { id: "grok-4", label: "grok-4" },
];
beforeEach(() => {
 dir = mkdtempSync(join(tmpdir(), "agend-grok3180-"));
 vi.stubEnv("AGEND_HOME", dir); setLocale("en");
 mkdirSync(join(dir, "cli-env"));
 writeFileSync(join(dir, "cli-env/antigravity.json"), JSON.stringify({ probedAt: Date.now(), models }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
function fleet(result: unknown, effort = "high") {
 const config = join(dir, "fleet.yaml");
 writeFileSync(config, yaml.dump({ defaults: {}, instances: { ag: { backend: "grok", working_directory: dir, model: models[0]!.id, effort } } }));
 const fm: any = new FleetManager(dir); fm.loadConfig(config);
 const send = vi.fn((message: any) => { if (message.runtime_switch) queueMicrotask(() => fm.runtimeSwitchWaiters.get(message.runtime_switch.id)?.(result)); return true; });
 fm.instanceIpcClients.set("ag", { connected: true, send });
 const restart = vi.fn(async () => {}); fm.restartSingleInstance = restart;
 const saved = () => (yaml.load(readFileSync(config, "utf8")) as any).instances.ag;
 return { fm, send, restart, saved };
}
describe("Grok shared switch route", () => {
 it("registers the evidenced floor for both operations, and only agy's executable", () => {
  const e = CLI_RUNTIME_SWITCH.grok!;
  for (const step of [{ model: models[0]!.id, effort: null }, { model: null, effort: "low" }]) {
   expect(cliSwitchAllowed(e, step, "1.0.70")).toBe(true);
   for (const v of [null, "1.0.69"]) expect(cliSwitchAllowed(e, step, v)).toBe(false);
  }
  expect(e.matchExe("/rig/bin/grok")).toBe(true); expect(e.matchExe("/rig/bin/grok-helper")).toBe(false);

 });
 it("persists a confirmed effort before sending the verified spec, without restarting", async () => {
  const f = fleet({ outcome: "switched", confirmed: true, shown: "low" });
  expect(await f.fm.applyEffort("ag", "low")).toMatch(/running session/);
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ content: "/effort low", runtime_switch: expect.objectContaining({ cli: { backend: "grok", model: null, effort: "low" } }) }));
  expect(f.saved().effort).toBe("low"); expect(f.restart).not.toHaveBeenCalled();
 });
 it.each([{ outcome: "not_sent", reason: "busy" }, { outcome: "not_sent", reason: "version", version: "1.0.69" }, { outcome: "mismatch", shown: "refused" }, { outcome: "not_confirmed" }])("restarts with the saved effort when the switch returns %j", async result => {
  const f = fleet(result); await f.fm.applyEffort("ag", "low");
  expect(f.saved().effort).toBe("low"); expect(f.restart).toHaveBeenCalledOnce();
 });
 it("a model switch carries the configured supported effort and saves the requested model for restart", async () => {
  const f = fleet({ outcome: "switched", confirmed: true, shown: models[1]!.label }, "low");
  await f.fm.applyModel("ag", models[1]!.id);
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ content: "/model grok-4 low", runtime_switch: expect.objectContaining({ cli: { backend: "grok", model: models[1]!.id, effort: "low" } }) }));
  expect(f.saved().model).toBe(models[1]!.id); expect(f.saved().effort).toBe("low"); expect(f.restart).not.toHaveBeenCalled();
 });
 it("a malformed model is never typed; the saved choice takes the restart path", async () => {
  const f = fleet({ outcome: "switched" }); await f.fm.applyModel("ag", "grok-4 extra-text");
  expect(f.send).not.toHaveBeenCalled(); expect(f.restart).toHaveBeenCalledOnce(); expect(f.saved().model).toBe("grok-4 extra-text");
 });
});
