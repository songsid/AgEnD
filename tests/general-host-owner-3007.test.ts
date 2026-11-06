import { execFile as exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INSTANCE_CONFIG } from "../src/config.js";
import { GeneralBindings, selectedGeneralHostSession, type GeneralBindingRecord } from "../src/general-binding.js";
import { confirmGeneralHostExit } from "../src/general-host-owner.js";
import { ClaudeCodeBackend, claudeProjectKey } from "../src/backend/claude-code.js";
import { CodexBackend } from "../src/backend/codex.js";
import { TmuxManager } from "../src/tmux-manager.js";
const execFile = promisify(exec), roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const errno = (code: string) => Object.assign(Error(code), { code });
const owner = { kind: "tmux" as const, windowId: "@7", pid: 12345 };
describe("General's host positive-exit barrier", () => {
  it("requires both positively absent window and ESRCH for the exact old group", async () => {
    expect(await confirmGeneralHostExit(owner, "test", { windows: async () => [], probe: () => { throw errno("ESRCH"); } })).toBe(true);
    expect(await confirmGeneralHostExit(owner, "test", { windows: async () => [{ id: "@7" }], probe: () => { throw errno("ESRCH"); } })).toBe(false);
    expect(await confirmGeneralHostExit(owner, "test", { windows: async () => [], probe: () => true })).toBe(false);
    expect(await confirmGeneralHostExit(owner, "test", { windows: async () => [], probe: () => { throw errno("EPERM"); } })).toBe(false);
    expect(await confirmGeneralHostExit(owner, "test", { windows: async () => { throw Error("tmux read timeout"); }, probe: () => { throw errno("ESRCH"); } })).toBe(false);
    expect(await confirmGeneralHostExit(owner, "test", { windows: async () => { throw Error("no server running"); }, probe: () => { throw errno("ESRCH"); } })).toBe(true);
  });
  it.each(["", "@bad", ":", "@7;kill"])('rejects an invalid owner window "%s" without any lookup', async windowId => {
    const windows = vi.fn(async () => []), probe = vi.fn();
    expect(await confirmGeneralHostExit({ ...owner, windowId }, "test", { windows, probe })).toBe(false);
    expect(windows).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });
  it.skipIf(process.env.AGEND_GENERAL_TMUX_ACCEPTANCE !== "1")("real private tmux: old group exits, another window remains alive", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-general-owner-")); roots.push(root);
    const socket = `agend-test-general-owner-${process.pid}-${randomUUID().slice(0, 8)}`, session = "fixture";
    vi.stubEnv("AGEND_HOME", root); TmuxManager.setSocketName(socket);
    try {
      await execFile("tmux", ["-L", socket, "new-session", "-d", "-s", session, "-n", "first", "exec sleep 60"]);
      const first = (await TmuxManager.listWindows(session))[0].id;
      const other = (await execFile("tmux", ["-L", socket, "new-window", "-d", "-P", "-F", "#{window_id}", "-t", session, "-n", "other", "exec sleep 60"])).stdout.trim();
      const pid = await TmuxManager.getPanePid(session, first), otherPid = await TmuxManager.getPanePid(session, other);
      expect(pid).toBeGreaterThan(1); expect(otherPid).toBeGreaterThan(1);
      const captured = { kind: "tmux" as const, windowId: first, pid: pid! };
      expect(await confirmGeneralHostExit(captured, session)).toBe(false);
      await new TmuxManager(session, first).killWindow();
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) { gone = await confirmGeneralHostExit(captured, session); if (!gone) await new Promise(r => setTimeout(r, 100)); }
      expect(gone).toBe(true); expect(process.kill(otherPid!, 0)).toBe(true);
      expect((await TmuxManager.listWindows(session)).some(row => row.id === other)).toBe(true);
    } finally { await execFile("tmux", ["-L", socket, "kill-server"]).catch(() => {}); TmuxManager.setSocketName(null); }
  }, 15_000);
});

function pinFixture(backend: "codex" | "claude-code") {
  const root = mkdtempSync(join(tmpdir(), "agend-general-host-pin-")); roots.push(root);
  const instanceDir = join(root, "instances", "general"), cwd = join(root, "host"), provider = join(root, "provider");
  mkdirSync(instanceDir, { recursive: true }); mkdirSync(cwd); mkdirSync(provider);
  const binding = randomUUID(), agentId = randomUUID(), machine = randomUUID(), pin = randomUUID();
  const host = { ...structuredClone(DEFAULT_INSTANCE_CONFIG), general_topic: true, working_directory: cwd, backend };
  const windows = { ...host, runtime: "windows" as const, native_adapter: "pane" as const, native_agent_id: agentId,
    native_general_binding: binding, machine_id: machine, native_sandbox: "workspace-write" as const, working_directory: "C:\\fixture\\general" };
  const record: GeneralBindingRecord = { version: 1, name: "general", revision: randomUUID(), active: "host",
    host: { config: host, pin: { backend, sessionId: pin } }, windows: [{ id: binding, agentId, machineId: machine, cli: backend, config: windows }],
    pending: { id: randomUUID(), phase: "selected", from: binding, to: "host", source: windows, target: host, at: Date.now() } };
  const store = new GeneralBindings(root); store.write(record);
  return { root, instanceDir, cwd, provider, record, pin, store, config: { instanceName: "general", instanceDir, workingDirectory: cwd, mcpServers: {}, skipResume: true } };
}
describe("General's exact saved host conversation on switch-back", () => {
  it("only supplies a pin while the exact host selection is unfinished, not ordinary later restarts", () => {
    const f = pinFixture("claude-code");
    expect(selectedGeneralHostSession(f.instanceDir, "general", "claude-code", f.cwd)).toBe(f.pin);
    expect(() => selectedGeneralHostSession(f.instanceDir, "general", "codex", f.cwd)).toThrow("scope differs");
    expect(() => selectedGeneralHostSession(f.instanceDir, "general", "claude-code", join(f.cwd, "other"))).toThrow("scope differs");
    delete f.record.pending; f.store.write(f.record);
    expect(selectedGeneralHostSession(f.instanceDir, "general", "claude-code", f.cwd)).toBeNull();
  });
  it("Claude resumes the retained UUID even if the ordinary crash fallback says fresh; missing never means continue/fresh", () => {
    const f = pinFixture("claude-code"); vi.stubEnv("CLAUDE_CONFIG_DIR", f.provider);
    const dir = join(f.provider, "projects", claudeProjectKey(f.cwd)); mkdirSync(dir, { recursive: true });
    const path = join(dir, `${f.pin}.jsonl`); writeFileSync(path, "{}");
    const backend = new ClaudeCodeBackend(f.instanceDir);
    const cmd = backend.buildCommand(f.config);
    expect(cmd).toContain(` --resume '${f.pin}'`); expect(cmd).not.toContain("--continue");
    rmSync(path); expect(() => backend.buildCommand(f.config)).toThrow("General");
  });
  it("Codex resumes the proven saved UUID, never a newer sibling, and holds if its exact rollout is missing", () => {
    const f = pinFixture("codex"); vi.stubEnv("CODEX_HOME", f.provider);
    const dir = join(f.provider, "sessions", "2026", "11", "04"); mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-11-04T01-02-03-${f.pin}.jsonl`);
    writeFileSync(path, [
      { type: "session_meta", payload: { id: f.pin, cwd: f.cwd, source: "cli", originator: "codex-tui", cli_version: "0.165.0" } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
      { timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "task_complete", turn_id: "old", error: { message: "You've hit your usage limit. Old.", codex_error_info: "usage_limit_exceeded" } } },
    ].map(v => JSON.stringify(v)).join("\n") + "\n");
    const backend = new CodexBackend(f.instanceDir); backend.writeConfig(f.config);
    expect(backend.buildCommand(f.config)).toContain(` resume '${f.pin}' `);
    expect(backend.quotaReplayHistory()?.messages).toEqual(["You've hit your usage limit. Old."]);
    expect(backend.quotaReplayHistory()?.current()).toBe(true);
    rmSync(path); expect(() => backend.buildCommand(f.config)).toThrow("General");
  });
});
