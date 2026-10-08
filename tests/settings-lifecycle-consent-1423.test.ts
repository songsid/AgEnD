import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
const processFake = vi.hoisted(() => ({ run: null as null | ((args: string[], options: any, cb: any) => void), calls: [] as string[][] }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execFile: vi.fn((_file: string, args: string[], options: any, cb: any) => { processFake.calls.push(args); processFake.run?.(args, options, (error: unknown, stdout: string, stderr: string) => cb(error, { stdout, stderr })); return new EventEmitter(); }),
  execFileSync: vi.fn(() => ""),
}));
import { FleetManager } from "../src/fleet-manager.js";
import { Daemon } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";
import { SettingsExecution } from "../src/settings-transaction.js";
const roots: string[] = [], caps: SettingsExecution[] = [];
afterEach(() => { for (const c of caps.splice(0)) c.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  processFake.run = null; processFake.calls.length = 0; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function hold<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fleet() {
  const root = mkdtempSync(join(tmpdir(), "agend-test-lifecycle-consent-")); roots.push(root); vi.stubEnv("AGEND_HOME", root);
  const configPath = join(root, "fleet.yaml"); writeFileSync(configPath, "instances: {}\n");
  const fm = new FleetManager(root) as any; fm.loadConfig(configPath);
  const remove = vi.fn(async () => {}); fm.worlds.set("primary", { adapter: { deleteTopic: remove } });
  vi.spyOn(fm, "connectIpcToInstance").mockResolvedValue(undefined);
  let alive = true; const cap = new SettingsExecution({ current: () => alive, snapshot: () => fm.fleetConfig }); caps.push(cap);
  const project = join(root, "project"); mkdirSync(project);
  return { fm, cap, root, project, remove, revoke: () => { alive = false; } };
}
function daemon() {
  const root = mkdtempSync(join(tmpdir(), "agend-test-daemon-consent-")); roots.push(root); const dir = join(root, "instance"); mkdirSync(dir);
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } } as any;
  const d = new Daemon("worker", { working_directory: root, backend: "kiro-cli", log_level: "silent",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 } } as any,
    dir, false, undefined, undefined, logger) as any;
  let alive = true; const cap = new SettingsExecution({ current: () => alive, snapshot: () => null }); caps.push(cap); d.startupAdmission = () => cap.assert();
  return { d, root, cap, revoke: () => { alive = false; } };
}
describe("#1423 real lifecycle and nested startup boundaries", () => {
  it("cleans an acquired topic after revoked capture, without starting", async () => {
    const h = fleet(), pending = hold<string>(); vi.spyOn(h.fm, "createForumTopic").mockReturnValue(pending.promise);
    const start = vi.spyOn(h.fm.lifecycle, "start").mockResolvedValue(undefined), respond = vi.fn();
    const creating = h.fm.lifecycle.handleCreate({ directory: h.project, topic_name: "worker" }, respond, "primary", h.cap);
    await vi.waitFor(() => expect(h.fm.createForumTopic).toHaveBeenCalledOnce()); h.revoke(); pending.resolve("901"); await creating;
    expect(start).not.toHaveBeenCalled(); expect(h.remove).toHaveBeenCalledWith("901"); expect(h.fm.fleetConfig.instances).toEqual({}); expect(respond.mock.calls[0][1]).toContain("stale");
  });
  it("same-topic retry failure restores the previous config and retains its topic", async () => {
    const h = fleet(); const old = { working_directory: join(h.root, "previous"), topic_id: "901", channel_id: "primary", model: "previous" };
    h.fm.fleetConfig.instances["worker-t901"] = old; h.fm.saveFleetConfig();
    const cap = new SettingsExecution({ current: () => true, snapshot: () => h.fm.fleetConfig }); caps.push(cap);
    vi.spyOn(h.fm, "createForumTopic").mockResolvedValue("901"); vi.spyOn(h.fm.lifecycle, "start").mockRejectedValue(new Error("startup failed"));
    await h.fm.lifecycle.handleCreate({ directory: h.project, topic_name: "worker" }, vi.fn(), "primary", cap);
    expect(h.fm.fleetConfig.instances["worker-t901"]).toEqual(old); expect(h.remove).not.toHaveBeenCalled();
    expect((yaml.load(readFileSync(h.fm.configPath, "utf8")) as any).instances["worker-t901"].model).toBe("previous");
  });
  it("an ordinary edit while startup is held keeps the retained config and referenced topic", async () => {
    const h = fleet(), pending = hold(); vi.spyOn(h.fm, "createForumTopic").mockResolvedValue("901");
    vi.spyOn(h.fm.lifecycle, "start").mockReturnValue(pending.promise);
    const creating = h.fm.lifecycle.handleCreate({ directory: h.project, topic_name: "worker" }, vi.fn(), "primary", h.cap);
    await vi.waitFor(() => expect(h.fm.lifecycle.start).toHaveBeenCalledOnce()); h.fm.fleetConfig.instances["worker-t901"].model = "newer"; h.fm.saveFleetConfig();
    h.revoke(); pending.resolve(); await creating;
    expect(h.fm.fleetConfig.instances["worker-t901"].model).toBe("newer"); expect(h.remove).not.toHaveBeenCalled(); expect(existsSync(h.project)).toBe(true);
  });
  it("a worktree acquired after revocation is compensated, not leaked", async () => {
    const h = fleet(), pending = hold(), path = join(h.root, "private-worktree");
    processFake.run = (args, _options, cb) => {
      if (args[0] === "worktree" && args[1] === "add") { void pending.promise.then(() => { mkdirSync(path); cb(null, "", ""); }); }
      else { if (args[0] === "worktree" && args[1] === "remove") rmSync(path, { recursive: true, force: true }); cb(null, "", ""); }
    };
    const topic = vi.spyOn(h.fm, "createForumTopic").mockResolvedValue("901"), respond = vi.fn();
    const creating = h.fm.lifecycle.handleCreate({ directory: h.project, branch: "branch", worktree_path: path, topic_name: "worker" }, respond, "primary", h.cap);
    await vi.waitFor(() => expect(processFake.calls.some(x => x[0] === "worktree" && x[1] === "add")).toBe(true)); h.revoke(); pending.resolve(); await creating;
    expect(processFake.calls.some(x => x[0] === "worktree" && x[1] === "remove")).toBe(true); expect(existsSync(path)).toBe(false); expect(topic).not.toHaveBeenCalled();
  });
  it("held backend preparation cannot create config, token, command or window after revocation", async () => {
    const h = daemon(), pending = hold(); h.d.backend = { binaryName: "kiro-cli", prepareLaunch: vi.fn(() => pending.promise), writeConfig: vi.fn(), buildCommand: vi.fn(() => "kiro-cli") };
    vi.spyOn(TmuxManager, "ensureSession").mockRejectedValue(new Error("forbidden tmux"));
    const result = h.d.trySpawnInsideGate().catch((e: Error) => e); await vi.waitFor(() => expect(h.d.backend.prepareLaunch).toHaveBeenCalledOnce()); h.revoke(); pending.resolve();
    expect(await result).toMatchObject({ code: "settings_execution_stale" }); expect(h.d.backend.writeConfig).not.toHaveBeenCalled(); expect(h.d.backend.buildCommand).not.toHaveBeenCalled(); expect(TmuxManager.ensureSession).not.toHaveBeenCalled();
  });
  it("agent-switch final readiness cannot paste after revocation", async () => {
    const h = daemon(), pending = hold<string>(); h.d.backend = { binaryName: "kiro-cli", agentSwitch: () => ({ agent: "ours", command: "/agent swap ours", readActive: () => "other", confirm: vi.fn() }) };
    h.d.tmux = { getWindowId: () => "@1", capturePane: vi.fn(async () => "other"), pasteBuffer: vi.fn(), sendSpecialKey: vi.fn(), deleteBackward: vi.fn() };
    h.d.paneReadinessForDelivery = vi.fn(() => pending.promise); const switching = h.d.ensureBackendAgent().catch((e: Error) => e);
    await vi.waitFor(() => expect(h.d.paneReadinessForDelivery).toHaveBeenCalledOnce()); h.revoke(); pending.resolve("ready");
    expect(await switching).toMatchObject({ code: "settings_execution_stale" }); expect(h.d.tmux.pasteBuffer).not.toHaveBeenCalled(); expect(h.d.tmux.sendSpecialKey).not.toHaveBeenCalled();
  });
  it("startup capture cancellation is propagated instead of treated as an unknown ready screen", async () => {
    const h = daemon(), pending = hold<string>(); h.d.backend = { getStartupDialogs: () => [], getReadyPattern: () => /ready/ }; h.d.tmux = { capturePane: vi.fn(() => pending.promise) };
    const scanning = h.d.dismissDialogsUntilReady(1000).catch((e: Error) => e); h.revoke(); pending.resolve("ready");
    expect(await scanning).toMatchObject({ code: "settings_execution_stale" });
  });
  it("a Classic compensation receipt cannot restart a newer fleet generation", async () => {
    const h = fleet(), restore = h.fm.captureClassicSettingsRestoration("classic", ["backend"]);
    const restart = vi.spyOn(h.fm, "restartClassicInstanceFromSettings").mockResolvedValue(undefined); h.fm.settingsGeneration++;
    const refused = await restore().catch((error: Error) => error);
    expect(refused).toBeInstanceOf(Error); expect(refused.message).toContain("stale"); expect(restart).not.toHaveBeenCalled();
  });
});
