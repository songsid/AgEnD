import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/child-process.js", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
import { spawn } from "../src/child-process.js";
import { WindowsCliBridge, WINDOWS_CLI_INVENTORY_FILE, type WindowsCliTask } from "../src/windows-cli.js";
import { RuntimeWindowsBridge, type RuntimeExecutionCoordinator } from "../src/runtime-windows-bridge.js";
import { parseNativeInstanceCreate } from "../src/native-instance-input.js";
import { AgentRuntimeChangeInput } from "../src/agent-runtime-change.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); } });
beforeEach(() => vi.clearAllMocks());
const machineId = "22345678-1234-4321-abcd-123456789012";
const task = (cli: "claude-code" | "codex" = "claude-code") => ({ requestId: randomUUID(), cli, cwd: "C:\\workspace", prompt: "hello", sandbox: "read-only" as const });

describe("AgEnD's remote bridge sends a profile NAME to a Runtime that can honour it", () => {
  const bridge = (capabilities: string[] | undefined) => {
    const call = vi.fn(async (_machine: string, _operation: string, payload: unknown): Promise<WindowsCliTask> => {
      const { task: input } = payload as { task: ReturnType<typeof task> };
      return { id: input.requestId, cli: input.cli, cwd: input.cwd, sandbox: input.sandbox, status: "running", startedAt: 1, output: "" };
    });
    const coordinator = { machine: () => ({ status: "online", platform: "win32", ...(capabilities ? { runtimeInfo: { protocolVersions: [1], capabilities } } : {}) }),
      call, task: () => null, hasActiveTask: () => false, subscribe: () => () => {} } as unknown as RuntimeExecutionCoordinator;
    return { call, bridge: new RuntimeWindowsBridge({}, () => coordinator, { close() {} } as never) };
  };
  it("carries credentialProfile in the run payload and nothing that looks like a folder", async () => {
    const { call, bridge: b } = bridge(["exec", "credential-profiles"]);
    b.start(task(), () => true, { machineId, credentialProfile: "work" }); await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    const payload = call.mock.calls[0][2] as Record<string, unknown>;
    expect(payload.credentialProfile).toBe("work"); expect(Object.keys(payload).sort()).toEqual(["credentialProfile", "task"]);
    expect(JSON.stringify(payload)).not.toMatch(/credentialHome|credential-profiles|\.claude/);
    b.close();
  });
  it("sends none when the agent has none", async () => {
    const { call, bridge: b } = bridge(["exec"]);
    b.start(task(), () => true, { machineId }); await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call.mock.calls[0][2]).not.toHaveProperty("credentialProfile"); b.close();
  });
  it("refuses, before anything is sent, a Runtime that does not report the capability or has not said anything", () => {
    for (const capabilities of [["exec", "mcp", "panes"], [], undefined]) {
      const { call, bridge: b } = bridge(capabilities);
      expect(() => b.start(task(), () => true, { machineId, credentialProfile: "work" })).toThrow(/Runtime is too old to choose a Claude account/);
      expect(call).not.toHaveBeenCalled(); b.close();
    }
  });
  it("refuses a bad name, a folder, or a CLI that has no credential home", () => {
    const { call, bridge: b } = bridge(["exec", "credential-profiles"]);
    for (const bad of ["C:\\x", "../x", "a/b", "", "con"]) expect(() => b.start(task(), () => true, { machineId, credentialProfile: bad }), bad).toThrow(/Credential profile names/);
    expect(() => b.start(task(), () => true, { machineId, credentialHome: "C:\\Users\\me\\.claude" })).toThrow(/never sent to a Runtime/);
    expect(() => b.start(task("codex"), () => true, { machineId, credentialProfile: "work" })).toThrow(/Claude Code only/);
    expect(call).not.toHaveBeenCalled(); b.close();
  });
});

describe("a Windows agent's creation request names a profile, never a folder", () => {
  const input = { runtime: "windows", machineId, backend: "claude-code", topic_name: "worker" };
  it("accepts a valid name for Claude Code on a paired computer and passes it on as the profile's NAME", () => {
    const { profile, input: parsed } = parseNativeInstanceCreate({ ...input, credentialProfile: "work" });
    expect(parsed.credentialProfile).toBe("work"); expect(profile).toMatchObject({ cli: "claude-code", machineId, credentialProfile: "work" });
    expect(parseNativeInstanceCreate(input).profile).not.toHaveProperty("credentialProfile");
  });
  it.each(["C:\\Users\\me\\.claude", "..\\x", "../x", "a/b", "", " work", "con", "work."])("refuses %j", bad => {
    expect(() => parseNativeInstanceCreate({ ...input, credentialProfile: bad })).toThrow();
  });
  it("refuses a profile without a paired computer or for another CLI, and an unknown field that would be a folder", () => {
    expect(() => parseNativeInstanceCreate({ runtime: "windows", backend: "claude-code", topic_name: "w", credentialProfile: "work" })).toThrow(/paired Runtime computer/);
    expect(() => parseNativeInstanceCreate({ ...input, backend: "codex", credentialProfile: "work" })).toThrow(/Claude Code sign-in/);
    for (const field of ["credentialHome", "credential_profile_dir", "env", "claudeConfigDir"]) expect(() => parseNativeInstanceCreate({ ...input, [field]: "C:\\x" }), field).toThrow();
  });
});

describe("the Change Runtime request", () => {
  const base = { requestId: randomUUID(), expectedRevision: "a".repeat(64), runtime: "windows", machineId, backend: "claude-code", startNewConversation: true };
  it("takes a name only", () => {
    expect(AgentRuntimeChangeInput.parse({ ...base, credentialProfile: "work" }).credentialProfile).toBe("work");
    for (const bad of ["C:\\x", "../x", "", "con", 5]) expect(() => AgentRuntimeChangeInput.parse({ ...base, credentialProfile: bad })).toThrow();
    for (const extra of [{ runtime: "wsl", machineId: undefined }, { backend: "codex" }, { machineId: undefined }]) expect(() => AgentRuntimeChangeInput.parse({ ...base, credentialProfile: "work", ...extra })).toThrow(/Claude Code sign-in/);
    expect(() => AgentRuntimeChangeInput.parse({ ...base, credentialHome: "C:\\x" })).toThrow();
  });
});

describe("the Runtime's own bridge hands the worker a folder it resolved itself", () => {
  class Child extends EventEmitter { stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); kill = vi.fn(); }
  function local() {
    const dir = mkdtempSync(join(tmpdir(), "agend-credential-bridge-")); directories.push(dir);
    const row = { id: "claude-code", path: "C:\\claude.exe", version: "2.1.316", authenticated: true, runnable: true, readOnlySupport: true, supports: { execution: true, resume: true, model: true, mcp: true }, permissionNote: "", models: [] };
    writeFileSync(join(dir, WINDOWS_CLI_INVENTORY_FILE), JSON.stringify({ clis: [row], home: "C:\\Users\\u", probedAt: 1 }));
    return new WindowsCliBridge(async () => ({ executable: "/fixture/node", args: ["worker.js"] }), join(dir, WINDOWS_CLI_INVENTORY_FILE));
  }
  it("writes credentialHome into the worker's private request, and only when there is one", async () => {
    for (const home of ["C:\\rt\\credential-profiles\\claude-code\\work", undefined]) {
      const child = new Child(); vi.mocked(spawn).mockReturnValue(child as never);
      const written: string[] = []; child.stdin.on("data", chunk => written.push(String(chunk)));
      const b = local(); b.start(task(), () => true, { ...(home ? { credentialHome: home } : {}) });
      await vi.waitFor(() => expect(written.join("")).toContain('"op":"run"'));
      const request = JSON.parse(written.join("").trim()); expect(request.credentialHome).toBe(home); b.close();
    }
  });
  it("refuses a folder that is not a native drive path, or one for another CLI, before any worker starts", () => {
    const b = local();
    for (const bad of ["/home/me/.claude", "..\\x", "\\\\server\\share", "relative", 5]) expect(() => b.start(task(), () => true, { credentialHome: bad as never }), String(bad)).toThrow(/Invalid credential profile folder/);
    expect(() => b.start(task("codex"), () => true, { credentialHome: "C:\\x" })).toThrow(/Invalid credential profile folder/);
    expect(spawn).not.toHaveBeenCalled(); b.close();
  });
});
