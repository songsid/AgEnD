import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { CLI_RUNTIME_SWITCH, cliSwitchAllowed } from "../src/backend/cli-runtime-switch.js";
import { Daemon } from "../src/daemon.js";
import { AntigravityBackend } from "../src/backend/antigravity.js";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale } from "../src/locale.js";

let dir: string;
const models = [
 { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
 { id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
];
beforeEach(() => {
 dir = mkdtempSync(join(tmpdir(), "agend-agy3180-"));
 vi.stubEnv("AGEND_HOME", dir); setLocale("en");
 mkdirSync(join(dir, "cli-env"));
 writeFileSync(join(dir, "cli-env/antigravity.json"), JSON.stringify({ probedAt: Date.now(), models }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
function fleet(result: unknown, effort = "high") {
 const config = join(dir, "fleet.yaml");
 writeFileSync(config, yaml.dump({ defaults: {}, instances: { ag: { backend: "antigravity", working_directory: dir, model: models[0]!.id, effort } } }));
 const fm: any = new FleetManager(dir); fm.loadConfig(config);
 const send = vi.fn((message: any) => { if (message.runtime_switch) queueMicrotask(() => fm.runtimeSwitchWaiters.get(message.runtime_switch.id)?.(result)); return true; });
 fm.instanceIpcClients.set("ag", { connected: true, send });
 const restart = vi.fn(async () => {}); fm.restartSingleInstance = restart;
 const saved = () => (yaml.load(readFileSync(config, "utf8")) as any).instances.ag;
 return { fm, send, restart, saved };
}
describe("agy shared switch route", () => {
 it("registers the evidenced floor for both operations, and only agy's executable", () => {
  const e = CLI_RUNTIME_SWITCH.antigravity!;
  for (const step of [{ model: models[0]!.id, effort: null }, { model: null, effort: "low" }]) {
   expect(cliSwitchAllowed(e, step, "1.4.7")).toBe(true);
   for (const v of [null, "1.4.6"]) expect(cliSwitchAllowed(e, step, v)).toBe(false);
  }
  expect(e.matchExe("/rig/bin/agy")).toBe(true); expect(e.matchExe("/rig/bin/agy-helper")).toBe(false);
  expect(e.knownModel!("not-in-catalog")).toBe(false);
 });
 it("persists a confirmed effort before sending the verified spec, without restarting", async () => {
  const f = fleet({ outcome: "switched", confirmed: true, shown: "low" });
  expect(await f.fm.applyEffort("ag", "low")).toMatch(/running session/);
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ content: "/effort low", runtime_switch: expect.objectContaining({ cli: { backend: "antigravity", model: null, effort: "low" } }) }));
  expect(f.saved().effort).toBe("low"); expect(f.restart).not.toHaveBeenCalled();
 });
 it.each([{ outcome: "not_sent", reason: "busy" }, { outcome: "not_sent", reason: "version", version: "1.4.6" }, { outcome: "mismatch", shown: "refused" }, { outcome: "not_confirmed" }])("restarts with the saved effort when the switch returns %j", async result => {
  const f = fleet(result); await f.fm.applyEffort("ag", "low");
  expect(f.saved().effort).toBe("low"); expect(f.restart).toHaveBeenCalledOnce();
 });
 it("the real IPC parser keeps model+effort under the idle/version gate and refuses a mismatched wire", async () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };
  const d: any = new Daemon("ag", { working_directory: dir, backend: "antigravity", log_level: "silent", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 } } as any, dir, false, new AntigravityBackend(dir), undefined, logger as any);
  const results: unknown[] = []; d.ipcServer = { broadcast: (m: unknown) => results.push(m), send() {} };
  d.tmux = { isWindowAlive: async () => true, getWindowId: () => "@1" };
  d.wake = async () => {};
  d.cliSwitchGate = vi.fn(async () => ({ pane: "before" }));
  d.verifyCliSwitch = vi.fn(async () => ({ outcome: "switched", confirmed: true, shown: models[1]!.label }));
  d.deliverMessage = vi.fn(async (_text: string, _x: unknown, opts: any) => { opts.verdict.reached = true; opts.verdict.paneWriteStarted = true; opts.onPaneWritten?.(); return true; });
  vi.spyOn(d, "queueRawPaste");
  const message = { type: "raw_paste", content: "/model claude-sonnet-5-5-low", runtime_switch: { id: "ag-switch", kind: "model", requested: models[0]!.id, cli: { backend: "antigravity", model: models[0]!.id, effort: "low" } } };
  d.handleRawPasteIpcMessage(message); await d.pasteLock;
  expect(d.cliSwitchGate).toHaveBeenCalledWith(message.runtime_switch.cli);
  expect(d.verifyCliSwitch).toHaveBeenCalledWith(message.runtime_switch.cli, { pane: "before" });
  expect(results).toContainEqual({ type: "runtime_switch_result", id: "ag-switch", outcome: "switched", confirmed: true, shown: models[1]!.label });
  expect(d.queueRawPaste.mock.calls[0]![4]).toMatchObject({ cli: message.runtime_switch.cli });
  d.queueRawPaste.mockClear();
  d.handleRawPasteIpcMessage({ ...message, content: "/model claude-sonnet-5-5-high" });
  expect(d.queueRawPaste).not.toHaveBeenCalled();
  expect(results).toContainEqual({ type: "runtime_switch_result", id: "ag-switch", outcome: "not_sent", reason: "command" });
 });
 it("a model switch carries the configured supported effort and saves the requested model for restart", async () => {
  const f = fleet({ outcome: "switched", confirmed: true, shown: models[1]!.label }, "low");
  await f.fm.applyModel("ag", models[0]!.id);
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ content: "/model claude-sonnet-5-5-low", runtime_switch: expect.objectContaining({ cli: { backend: "antigravity", model: models[0]!.id, effort: "low" } }) }));
  expect(f.saved().model).toBe(models[0]!.id); expect(f.saved().effort).toBe("low"); expect(f.restart).not.toHaveBeenCalled();
 });
 it("unknown catalog model is never typed; the saved choice takes the restart path", async () => {
  const f = fleet({ outcome: "switched" }); await f.fm.applyModel("ag", "not-in-catalog");
  expect(f.send).not.toHaveBeenCalled(); expect(f.restart).toHaveBeenCalledOnce(); expect(f.saved().model).toBe("not-in-catalog");
 });
});
