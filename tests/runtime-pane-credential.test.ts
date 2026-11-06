import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimePaneHost, type RuntimePaneProcess, type RuntimePaneHostOptions } from "../src/runtime-pane-host.js";
import { RuntimePaneStore } from "../src/runtime-pane-store.js";
import { validateRuntimePaneLaunch, validateRuntimePaneRequest, type RuntimePaneLaunch, type RuntimePaneSnapshot } from "../src/runtime-pane-protocol.js";
import { credentialProfilesRoot, ensureCredentialProfile, requireCredentialProfile } from "../src/runtime-credential-profiles.js";
import { startPaneService } from "../src/runtime-pane-service.js";

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); directories.splice(0).forEach(dir => rmSync(dir, { force: true, recursive: true })); });
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-pane-credential-")); directories.push(path); return path; };
function launch(extra: Partial<RuntimePaneLaunch> = {}): RuntimePaneLaunch { return { paneId: randomUUID(), agentId: randomUUID(), instance: "agent-work", cli: "claude-code", cwd: "C:\\scratch", sandbox: "read-only", columns: 80, rows: 24, ...extra }; }
function fakeProcess() {
  let exit: (value: { exitCode: number }) => void = () => {};
  return { pid: 12345, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(() => exit({ exitCode: 0 })),
    onData: () => ({ dispose() {} }), onExit: (fn: typeof exit) => { exit = fn; return { dispose() {} }; } };
}
function setup(overrides: Partial<RuntimePaneHostOptions> = {}) {
  const directory = scratch(), root = credentialProfilesRoot(scratch());
  const store = new RuntimePaneStore(directory), spawn = vi.fn(async () => fakeProcess() as RuntimePaneProcess);
  const login = vi.fn(async (_cli: string, _home: string, _name: string): Promise<boolean | null> => true);
  const host = new RuntimePaneHost({ store, bootId: randomUUID(), online: () => true, maxAgents: () => 4, spawn,
    credentialHome: (cli, name) => requireCredentialProfile(root, cli, name), credentialLogin: login, ...overrides });
  const open = (config: RuntimePaneLaunch, operationId = randomUUID()) => host.request({ action: "open", launch: config, operationId }) as Promise<RuntimePaneSnapshot & { reattached: boolean }>;
  return { directory, root, store, host, spawn, login, open };
}

describe("a persistent terminal launch that names a credential profile", () => {
  it("is a NAME in the closed protocol: a path, another CLI or a bad value is refused before any host sees it", () => {
    const ok = launch({ credentialProfile: "work" });
    expect(validateRuntimePaneLaunch(ok).credentialProfile).toBe("work");
    for (const bad of ["C:\\Users\\me\\.claude", "../x", "a/b", "", "con", "work."]) expect(() => validateRuntimePaneLaunch({ ...ok, credentialProfile: bad }), bad).toThrow(/Credential profile names/);
    expect(() => validateRuntimePaneLaunch({ ...ok, cli: "codex" })).toThrow(/Claude Code only/);
    expect(() => validateRuntimePaneLaunch({ ...ok, credentialHome: "C:\\x" } as never)).toThrow(/fields/);
    expect(() => validateRuntimePaneRequest({ action: "open", operationId: randomUUID(), launch: { ...ok, env: { CLAUDE_CONFIG_DIR: "C:\\x" } } })).toThrow(/fields/);
  });
  it("is resolved by the host to its own folder and handed to the worker through the owner, never through the launch", async () => {
    const f = setup(), directory = ensureCredentialProfile(f.root, "claude-code", "work"), config = launch({ credentialProfile: "work" });
    const snapshot = await f.open(config);
    expect(snapshot.state).toBe("running");
    const [spawned, owner] = f.spawn.mock.calls[0] as unknown as [RuntimePaneLaunch, { credentialHome?: string }];
    expect(owner.credentialHome).toBe(directory); expect(spawned.credentialProfile).toBe("work");
    expect(JSON.stringify(spawned)).not.toContain(directory);
    expect(f.login).toHaveBeenCalledWith("claude-code", directory, "work");
  });
  it("two panes on two profiles each get their own folder; a pane with no profile gets none", async () => {
    const f = setup(), work = ensureCredentialProfile(f.root, "claude-code", "work"), home = ensureCredentialProfile(f.root, "claude-code", "home");
    await f.open(launch({ credentialProfile: "work" })); await f.open(launch({ credentialProfile: "home" })); await f.open(launch());
    const owners = f.spawn.mock.calls.map(call => (call as unknown as [unknown, { credentialHome?: string }])[1].credentialHome);
    expect(owners).toEqual([work, home, undefined]);
  });
  it("fails closed before any reservation for an unknown profile: nothing starts and no pane identity is consumed", async () => {
    const f = setup(), config = launch({ credentialProfile: "ghost" }), operationId = randomUUID();
    await expect(f.open(config, operationId)).rejects.toThrow(/does not exist on this computer.*agend-runtime login claude-code ghost/);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.store.list()).toEqual([]);
    // The same open works once the profile exists: the refusal consumed nothing.
    ensureCredentialProfile(f.root, "claude-code", "ghost"); expect((await f.open(config, operationId)).state).toBe("running");
  });
  it("fails closed for a profile that is signed out, or whose sign-in cannot be confirmed", async () => {
    const f = setup(); ensureCredentialProfile(f.root, "claude-code", "work");
    f.login.mockResolvedValueOnce(false); await expect(f.open(launch({ credentialProfile: "work" }))).rejects.toThrow(/"work" is not signed in on this computer/);
    f.login.mockResolvedValueOnce(null); await expect(f.open(launch({ credentialProfile: "work" }))).rejects.toThrow(/could not confirm/);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.store.list()).toEqual([]);
  });
  it("is refused by a host that cannot honour profiles, rather than started on the default account", async () => {
    const f = setup({ credentialHome: undefined, credentialLogin: undefined }); ensureCredentialProfile(f.root, "claude-code", "work");
    await expect(f.open(launch({ credentialProfile: "work" }))).rejects.toThrow(/cannot select a credential profile/);
    const lonely = setup({ credentialLogin: undefined }); ensureCredentialProfile(lonely.root, "claude-code", "work");
    await expect(lonely.open(launch({ credentialProfile: "work" }))).rejects.toThrow(/cannot confirm a credential profile's sign-in/);
    expect(f.spawn).not.toHaveBeenCalled(); expect(lonely.spawn).not.toHaveBeenCalled();
  });
  it("does not ask the CLI again for a reattach of the same open (a running terminal is never blocked by a later sign-out)", async () => {
    const f = setup(); ensureCredentialProfile(f.root, "claude-code", "work");
    const config = launch({ credentialProfile: "work" }), operationId = randomUUID();
    await f.open(config, operationId); f.login.mockClear(); f.login.mockResolvedValue(false);
    const again = await f.open(config, operationId);
    expect(again.reattached).toBe(true); expect(f.login).not.toHaveBeenCalled(); expect(f.spawn).toHaveBeenCalledTimes(1);
  });
  it("a launch for another profile under the same pane id is another launch, not a reattach", async () => {
    const f = setup(); ensureCredentialProfile(f.root, "claude-code", "work"); ensureCredentialProfile(f.root, "claude-code", "home");
    const config = launch({ credentialProfile: "work" }), operationId = randomUUID();
    await f.open(config, operationId);
    await expect(f.open({ ...config, credentialProfile: "home" }, operationId)).rejects.toThrow(/already belongs to another launch/);
  });
});

describe("the pane host process wiring", () => {
  const start = async (extra: Partial<Parameters<typeof startPaneService>[0]> = {}) => {
    let captured: RuntimePaneHostOptions | undefined;
    const service = await startPaneService({ directory: scratch(), scope: "a".repeat(64), createHost: options => { captured = options; return new RuntimePaneHost(options); }, ...extra });
    return { service, options: captured! };
  };
  it("resolves names only under the credential root it was started with, and asks the CLI's own status for sign-in", async () => {
    const root = credentialProfilesRoot(scratch()), directory = ensureCredentialProfile(root, "claude-code", "work");
    const probeLogin = vi.fn(async () => true), { service, options } = await start({ credentialRoot: root, probeLogin });
    try {
      expect(options.credentialHome?.("claude-code", "work")).toBe(directory);
      expect(() => options.credentialHome?.("claude-code", "../work")).toThrow(/Credential profile names/);
      expect(() => options.credentialHome?.("claude-code", "ghost")).toThrow(/does not exist/);
      expect(await options.credentialLogin?.("claude-code", directory, "work")).toBe(true);
      expect(probeLogin).toHaveBeenCalledWith("claude-code", directory);
    } finally { await service.close(); }
  });
  it("without a credential root it offers no profile at all, so a launch that names one is refused", async () => {
    const { service, options } = await start();
    try { expect(options.credentialHome).toBeUndefined(); expect(options.credentialLogin).toBeUndefined(); } finally { await service.close(); }
  });
});
