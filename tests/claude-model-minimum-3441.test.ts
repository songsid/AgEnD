import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { claudeMinimumError } from "../src/claude-model-minimum.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sid = "11111111-2222-4333-8444-555555555555";
const row = "● API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.280 or newer is required";
function world() {
  const root = mkdtempSync(join(tmpdir(), "agend-model-minimum-")); roots.push(root);
  writeFileSync(join(root, "session-id"), sid);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const backend = { binaryName: "claude", getReadyPattern: () => /❯/, getSessionId: (): string | null => sid, refreshLaunchBinary: vi.fn() };
  const d: any = new Daemon("general", { backend: "claude-code", working_directory: root, log_level: "silent", restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 }, context_guardian: { max_age_hours: 0, grace_period_ms: 600000 } } as any, root, false, backend as any, undefined, { child: () => logger } as any);
  d.tmux = { getWindowId: () => "@1", capturePane: vi.fn(async () => "❯ ") };
  const pins: Array<string | undefined> = [];
  d.trySpawnInsideGate = vi.fn(async () => { pins.push(d.cliRepairSessionId); d.launchAttempt++; return true; });
  d.resolveClaudeInstallPath = vi.fn(async () => "/new-prefix/bin/claude");
  d.installedClaudeVersion = vi.fn(async () => "2.1.319");
  const warnings: any[] = [], errors: any[] = [];
  d.on("backend_launch_warning", (v: any) => warnings.push(v));
  d.on("pty_error", (v: any) => errors.push(v));
  const ep = new ClaudeCodeBackend(root).getErrorPatterns().find(p => p.type === "outdated_cli")!;
  const fire = () => {
    d.emitErrorPattern(ep, "minimum", row, performance.now());
    return d.modelMinimumFlight ?? Promise.resolve();
  };
  return { d, backend, root, logger, warnings, errors, fire, pins };
}
it("a sufficient installed version repairs once using the exact saved conversation", async () => {
  const w = world(); await w.fire(); await w.fire();
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledOnce(); expect(w.pins).toEqual([sid]);
  expect(w.backend.refreshLaunchBinary).toHaveBeenCalledWith("/new-prefix/bin/claude");
  expect(w.d.installedClaudeVersion).toHaveBeenNthCalledWith(1, "/new-prefix/bin/claude");
  expect(w.d.installedClaudeVersion).toHaveBeenNthCalledWith(2, "/new-prefix/bin/claude");
  expect(w.warnings).toHaveLength(1); expect(w.errors).toHaveLength(0); expect(w.logger.info).toHaveBeenCalled();
  expect(w.d.spawning).toBe(false); expect(readFileSync(join(w.root, "session-id"), "utf8")).toBe(sid);
});
it.each(["2.1.220", null])("an insufficient or unknown installed version (%s) gives one update notice without restarting", async version => {
  const w = world(); w.d.installedClaudeVersion.mockResolvedValue(version);
  await w.fire(); await w.fire();
  expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled(); expect(w.warnings).toHaveLength(1);
  expect(w.warnings[0].message).toContain("2.1.280"); expect(w.warnings[0].message).toContain("/login");
  expect(w.warnings[0].message).not.toMatch(/npm|host shell|run.*claude/i);
  expect(w.d.modelMinimumRepairUsed).toBe(false); expect(w.d.spawning).toBe(false);
});
it("normal startup never inspects executables or starts a model-version repair", async () => {
  const w = world(); expect(await w.d.trySpawn(false)).toBe(true);
  expect(w.d.resolveClaudeInstallPath).not.toHaveBeenCalled(); expect(w.d.installedClaudeVersion).not.toHaveBeenCalled(); expect(w.warnings).toHaveLength(0);
});
it("a later disk update can repair after the earlier no-restart notice", async () => {
  const w = world(); w.d.installedClaudeVersion.mockResolvedValueOnce("2.1.220"); await w.fire(); await w.fire();
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledOnce(); expect(w.warnings).toHaveLength(2); expect(w.pins).toEqual([sid]);
});
it("concurrent detections join one version read and one repair", async () => {
  const w = world(); let release!: (v: string) => void, entered!: () => void;
  const ready = new Promise<void>(r => entered = r);
  w.d.installedClaudeVersion.mockImplementationOnce(() => { entered(); return new Promise(r => release = r); });
  const a = w.fire(), b = w.fire(); expect(a).toBe(b); await ready; release("2.1.319"); await a;
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledOnce(); expect(w.warnings).toHaveLength(1);
});
it.each(["window", "fence", "pause", "health"])("a %s change while reading disk retires the old repair", async what => {
  const w = world(); let release!: (v: string) => void, entered!: () => void;
  const ready = new Promise<void>(r => entered = r);
  w.d.installedClaudeVersion.mockImplementationOnce(() => { entered(); return new Promise(r => release = r); });
  const run = w.fire(); await ready;
  if (what === "window") w.d.tmux = { getWindowId: () => "@2" };
  else if (what === "fence") w.d.launchFenceEpoch++;
  else if (what === "pause") w.d.pauseWakeState = "paused";
  else w.d.healthCheckPaused = true;
  release("2.1.319"); await run; expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled(); expect(w.warnings).toHaveLength(0);
});
it("stop during launcher resolution cannot produce a late notice or respawn", async () => {
  const w = world(); w.d.resolveClaudeInstallPath.mockImplementation(async () => { w.d.deliveryWritesStopping = true; return "/new-prefix/bin/claude"; });
  await w.fire(); expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled(); expect(w.warnings).toHaveLength(0);
});
it("a regressed final disk version cannot authorize a restart", async () => {
  const w = world(); w.d.installedClaudeVersion.mockResolvedValueOnce("2.1.319").mockResolvedValueOnce("2.1.220");
  await w.fire(); await w.fire(); expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled(); expect(w.warnings).toHaveLength(1); expect(w.d.modelMinimumBlocked).toBe(true);
});
it.each(["", "not-a-uuid"])("an unverifiable session %j never selects another conversation", async pin => {
  const w = world(); w.backend.getSessionId = () => null; writeFileSync(join(w.root, "session-id"), pin);
  await w.fire(); expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled(); expect(w.warnings).toHaveLength(1);
  expect(readFileSync(join(w.root, "session-id"), "utf8")).toBe(pin);
});
it("an explicit fresh-start admission cannot be reused as a same-session repair", async () => {
  const w = world(); w.d.skipResume = true; await w.fire(); expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled(); expect(w.warnings).toHaveLength(1);
});
it("a busy pane is never killed for the minimum-version repair", async () => {
  const w = world(); w.d.tmux.capturePane.mockResolvedValue("not an idle composer");
  await w.fire(); expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled(); expect(w.warnings).toHaveLength(1);
});
it("failed replacement readiness blocks delivery without granting another automatic attempt", async () => {
  const w = world(); w.d.trySpawnInsideGate.mockImplementation(async () => { w.d.launchAttempt++; return false; });
  await w.fire(); await w.fire(); expect(w.d.trySpawnInsideGate).toHaveBeenCalledOnce(); expect(w.warnings).toHaveLength(1);
  expect(w.d.modelMinimumBlocked).toBe(true); expect(w.d.healthCheckPaused).toBe(true); expect(w.d.refuseFatalStartupDelivery({ reached: false })).toBe(true);
  expect(readFileSync(join(w.root, "session-id"), "utf8")).toBe(sid);
});
it("queued delivery remains held while the final version read is in flight", async () => {
  const w = world(); let release!: (v: string) => void, entered!: () => void;
  const ready = new Promise<void>(r => entered = r);
  w.d.installedClaudeVersion.mockResolvedValueOnce("2.1.319").mockImplementationOnce(() => { entered(); return new Promise(r => release = r); });
  const run = w.fire(); await ready; expect(w.d.spawning).toBe(true);
  let released = false; const delivery = w.d.waitForSpawnToSettle().then(() => released = true);
  expect(released).toBe(false); expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled(); release("2.1.319");
  await run; await delivery; expect(released).toBe(true); expect(w.d.trySpawnInsideGate).toHaveBeenCalledOnce();
});
it("the non-renewable repair budget survives a later natural spawn", async () => {
  const w = world(); await w.fire(); await w.d.trySpawn(false); await w.fire();
  expect(w.d.trySpawnInsideGate).toHaveBeenCalledTimes(2); expect(w.warnings).toHaveLength(1);
});
it("the backend emits only a valid exact-session argument and preserves ordinary launch behavior", () => {
  const w = world(), backend = new ClaudeCodeBackend(w.root), base = { instanceName: "general", workingDirectory: w.root, instanceDir: w.root, mcpServers: {} };
  expect(backend.buildCommand({ ...base, resumeSessionId: sid })).toContain(`--resume '${sid}'`);
  expect(backend.buildCommand({ ...base, resumeSessionId: "bad; touch /tmp/never" })).not.toContain("bad;");
  expect(backend.buildCommand({ ...base, skipResume: true, resumeSessionId: sid })).not.toContain("--resume");
});
it("only an actual CLI model-version refusal supplies a minimum", () => {
  const backend = new ClaudeCodeBackend("/tmp/only-pattern"); expect(backend.getErrorPatterns().find(p => p.type === "outdated_cli")!.pattern.test(row)).toBe(true);
  expect(claudeMinimumError(row.replace("; version", ";\n version"))).toEqual({ running: "2.1.220", required: "2.1.280" });
  expect(claudeMinimumError("> " + row)).toBeNull(); expect(claudeMinimumError(row.replace("2.1.220", "2.1.319"))).toBeNull();
  expect(claudeMinimumError("This model needs a newer app")).toBeNull();
});
it("a stop during tmux sizing fences the exact respawn effect", async () => {
  const { TmuxManager } = await import("../src/tmux-manager.js"), { tmuxExecHelper } = await import("../src/tmux-exec-helper.js");
  const manager: any = new TmuxManager("owned-fixture", "@1"); let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(r => entered = r); let current = true;
  manager.applyLogicalSize = () => { entered(); return new Promise<void>(r => release = r); };
  const exec = vi.spyOn(tmuxExecHelper, "exec").mockResolvedValue({ stdout: "", stderr: "" });
  const run = manager.respawnWindow("owned-command", "/tmp", () => { if (!current) throw new Error("stopped"); });
  await ready; current = false; release(); await expect(run).rejects.toThrow("stopped"); expect(exec).not.toHaveBeenCalled();
});

it("installed versions are read from a real package without executing its non-executable launcher", async () => {
  const w = world(), pkg = join(w.root, "node_modules", "@anthropic-ai", "claude-code"), launcher = join(pkg, "cli.js");
  mkdirSync(pkg, {recursive:true}); writeFileSync(launcher, "This is inert, non-executable fixture data", {mode:0o600});
  writeFileSync(join(pkg,"package.json"), JSON.stringify({name:"@anthropic-ai/claude-code",version:"2.1.319"}));
  const read = (Daemon.prototype as any).installedClaudeVersion;
  expect(await read.call(w.d,launcher)).toBe("2.1.319");
  writeFileSync(join(pkg,"package.json"), JSON.stringify({name:"@anthropic-ai/claude-code",version:"2.1.220"}));
  expect(await read.call(w.d,launcher)).toBe("2.1.220");
  writeFileSync(join(pkg,"package.json"), "unreadable metadata"); expect(await read.call(w.d,launcher)).toBeNull();
});

it.each(["paused","pausing","waking","spawning","health-held"])("an already %s daemon cannot admit a model-version restart", async state => {
  const w = world();
  if(state === "spawning")w.d.spawning = true;
  else if(state === "health-held")w.d.healthCheckPaused = true;
  else w.d.pauseWakeState = state;
  await w.fire(); expect(w.d.resolveClaudeInstallPath).not.toHaveBeenCalled();
  expect(w.d.trySpawnInsideGate).not.toHaveBeenCalled();expect(w.warnings).toHaveLength(0);
});

it.each(["unexpected retry","concurrent launcher"])("a %s inside repair cannot pass its attempt window or affect the newer owner", async kind => {
  const w = world(), respawn = vi.fn();
  w.d.trySpawnInsideGate.mockImplementation(async (_reuse: boolean, _budget: number | undefined, admission: (attempt: number) => boolean) => {
    const ownedAttempt = ++w.d.launchAttempt;
    if (!admission(ownedAttempt)) throw new Error("initial admission refused");
    respawn();
    const otherAttempt = ++w.d.launchAttempt;
    if (!admission(kind === "unexpected retry" ? otherAttempt : ownedAttempt)) throw new Error("superseded");
    respawn(); return true;
  });
  await w.fire(); expect(respawn).toHaveBeenCalledOnce(); expect(w.d.modelMinimumRepairUsed).toBe(true);
  expect(w.d.healthCheckPaused).toBe(false); expect(w.d.modelMinimumBlocked).toBe(false); expect(w.warnings).toHaveLength(0);
});
it("the restart uses the UUID checkpointed after the claim rather than a stale file", async () => {
  const w = world(), stale = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  writeFileSync(join(w.root,"session-id"),stale);
  w.backend.getSessionId = vi.fn(() => {
    expect(w.d.modelMinimumRepairUsed).toBe(true); expect(w.d.spawning).toBe(true); return sid;
  });
  await w.fire(); expect(w.backend.getSessionId).toHaveBeenCalled(); expect(w.pins).toEqual([sid]);
  expect(readFileSync(join(w.root,"session-id"),"utf8")).toBe(sid);
});

it("model repair keeps the backend's ordinary resume startup budget", async () => {
  const w = world(); w.d.backend.getStartupBudgetMs = vi.fn(() => 60_000);
  await w.fire(); expect(w.d.backend.getStartupBudgetMs).toHaveBeenCalledWith({resume:true});
  expect(w.d.trySpawnInsideGate.mock.calls[0][1]).toBe(60_000); expect(w.pins).toEqual([sid]);
});
