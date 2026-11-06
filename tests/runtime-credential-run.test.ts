import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { credentialProfilesRoot, ensureCredentialProfile, cachedCredentialLogin } from "../src/runtime-credential-profiles.js";
import type { WindowsCliProbe, WindowsCliTask, WindowsRunOptions } from "../src/windows-cli.js";

const directories: string[] = [], clients: RuntimeClient[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [];
function home(): string { const path = mkdtempSync(join(tmpdir(), "agend-credential-run-")); directories.push(path); return path; }
const claudeTask = () => ({ requestId: randomUUID(), cli: "claude-code" as const, cwd: "C:\\workspace", prompt: "Private fixture request; never invoke a real CLI", sandbox: "read-only" as const });
const codexTask = () => ({ ...claudeTask(), cli: "codex" as const });
class FakeBridge implements RuntimeBridge {
  readonly tasks = new Map<string, WindowsCliTask>(); readonly options = new Map<string, WindowsRunOptions>(); launches = 0;
  readonly probe = vi.fn(async (): Promise<WindowsCliProbe> => ({ home: "C:\\Users\\fixture", clis: [], probedAt: 1 }));
  readonly prepareWorkspace = vi.fn(async (agentId: string) => `C:\\Users\\fixture\\.agend\\workspaces\\${agentId}`);
  start(raw: unknown, _authorized?: () => boolean, options: WindowsRunOptions = {}): WindowsCliTask {
    const task = raw as ReturnType<typeof claudeTask>; this.launches++; this.options.set(task.requestId, options);
    const snapshot: WindowsCliTask = { id: task.requestId, cli: task.cli, cwd: task.cwd, sandbox: task.sandbox, status: "running", startedAt: Date.now(), output: "" };
    this.tasks.set(snapshot.id, snapshot); return { ...snapshot };
  }
  get(id: string): WindowsCliTask | null { const task = this.tasks.get(id); return task ? { ...task } : null; }
  cancel(id: string): WindowsCliTask { const task = this.tasks.get(id)!; Object.assign(task, { status: "cancelled", finishedAt: Date.now(), outcomeConfirmed: true }); return { ...task }; }
  close(): void {}
  releaseUnknown(_id: string): void {}
}
async function fixture(clientOptions: Partial<ConstructorParameters<typeof RuntimeClient>[0]> = {}, withRoot = true) {
  const hub = new RuntimeCoordinator(home()); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Fixture Windows", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)?.pairingFingerprint);
  const claim = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret }); if (claim.status !== "approved") throw Error("Pairing fixture failed");
  const server = createServer((req, res) => { if (!hub.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
  servers.push(server); server.on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
  const runtimeHome = home(), root = credentialProfilesRoot(runtimeHome), store = new RuntimeClientStore(join(runtimeHome, "state")), bridge = new FakeBridge();
  store.saveCredentials({ server: `http://127.0.0.1:${address.port}`, machineId: claim.machineId, credential: claim.credential, name: "Fixture Windows" });
  const login = vi.fn(async (_cli: "claude-code", _directory: string): Promise<boolean | null> => true);
  const client = new RuntimeClient({ store, bridge, reconnectMs: 25, disconnectGraceMs: 500, pollMs: 10, ...(withRoot ? { credentialProfilesRoot: root } : {}), credentialLogin: login, ...clientOptions });
  clients.push(client); await client.start(); await vi.waitFor(() => expect(client.online()).toBe(true));
  return { hub, store, bridge, client, machineId: claim.machineId, root, login };
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); }
});
const finish = async (f: Awaited<ReturnType<typeof fixture>>, id: string) => { f.bridge.cancel(id); await vi.waitFor(() => expect(f.hub.hasActiveTask(f.machineId)).toBe(false)); };
const settled = async (f: Awaited<ReturnType<typeof fixture>>, id: string) => { await vi.waitFor(() => expect(f.hub.task(id)?.finishedAt).toBeDefined()); return f.hub.task(id)!; };

describe("a run that names a credential profile", () => {
  it("resolves the NAME to this computer's own folder and hands only that folder to the CLI worker", async () => {
    const f = await fixture(), directory = ensureCredentialProfile(f.root, "claude-code", "work"), task = claudeTask();
    await f.hub.call(f.machineId, "run", { task, credentialProfile: "work" });
    expect(f.bridge.options.get(task.requestId)?.credentialHome).toBe(directory);
    expect(f.login).toHaveBeenCalledWith("claude-code", directory);
    expect(cachedCredentialLogin(f.root, "claude-code", "work")).toBe(true);
    await finish(f, task.requestId);
  });
  it("two agents on two profiles each get their own folder; one without a name gets none (the computer's own environment)", async () => {
    const f = await fixture(), work = ensureCredentialProfile(f.root, "claude-code", "work"), home = ensureCredentialProfile(f.root, "claude-code", "home");
    const a = claudeTask(), b = claudeTask(), c = claudeTask();
    await f.hub.call(f.machineId, "run", { task: a, credentialProfile: "work" }); f.bridge.cancel(a.requestId);
    await vi.waitFor(() => expect(f.hub.hasActiveTask(f.machineId)).toBe(false));
    await f.hub.call(f.machineId, "run", { task: b, credentialProfile: "home" }); f.bridge.cancel(b.requestId);
    await vi.waitFor(() => expect(f.hub.hasActiveTask(f.machineId)).toBe(false));
    await f.hub.call(f.machineId, "run", { task: c });
    expect(f.bridge.options.get(a.requestId)?.credentialHome).toBe(work);
    expect(f.bridge.options.get(b.requestId)?.credentialHome).toBe(home);
    expect(f.bridge.options.get(c.requestId)?.credentialHome).toBeUndefined();
    await finish(f, c.requestId);
  });
  it("is refused by AgEnD itself, before it is journaled, when the value is not a name: a path never reaches a Runtime", async () => {
    const f = await fixture();
    for (const bad of ["C:\\Users\\me\\.claude", "..\\x", "../x", "a/b", "\\\\server\\share", "", " ", "con", "work."]) {
      await expect(f.hub.call(f.machineId, "run", { task: claudeTask(), credentialProfile: bad }), JSON.stringify(bad)).rejects.toThrow(/Credential profile names/);
    }
    await expect(f.hub.call(f.machineId, "run", { task: codexTask(), credentialProfile: "work" })).rejects.toThrow(/Claude Code only/);
    expect(f.bridge.launches).toBe(0);
  });
  it("is refused again by the Runtime, even for a frame AgEnD did not vet (defence in depth)", async () => {
    const f = await fixture();
    for (const bad of ["C:\\Users\\me\\.claude", "../x", "a/b", ""]) await expect(f.client.operation("run", { task: claudeTask(), credentialProfile: bad })).rejects.toThrow(/Credential profile names/);
    await expect(f.client.operation("run", { task: claudeTask(), credentialHome: "C:\\x" })).rejects.toThrow(/Invalid runtime run payload/);
    await expect(f.client.operation("run", { task: codexTask(), credentialProfile: "work" })).rejects.toThrow(/Claude Code only/);
    expect(f.bridge.launches).toBe(0);
  });
  it("fails closed as a confirmed failed turn when the profile does not exist here, and starts nothing", async () => {
    const f = await fixture(), task = claudeTask();
    await f.hub.call(f.machineId, "run", { task, credentialProfile: "ghost" });
    const done = await settled(f, task.requestId);
    expect(done).toMatchObject({ status: "failed", outcomeConfirmed: true }); expect(done.error).toMatch(/does not exist on this computer.*agend-runtime login claude-code ghost/);
    expect(f.bridge.launches).toBe(0); expect(f.login).not.toHaveBeenCalled();
  });
  it("fails closed when the profile is signed out, and when its sign-in cannot be confirmed; the default account is never used", async () => {
    const f = await fixture(); ensureCredentialProfile(f.root, "claude-code", "work");
    f.login.mockResolvedValueOnce(false); const a = claudeTask(); await f.hub.call(f.machineId, "run", { task: a, credentialProfile: "work" });
    expect((await settled(f, a.requestId)).error).toMatch(/"work" is not signed in on this computer.*agend-runtime login claude-code work/);
    f.login.mockResolvedValueOnce(null); const b = claudeTask(); await f.hub.call(f.machineId, "run", { task: b, credentialProfile: "work" });
    expect((await settled(f, b.requestId)).error).toMatch(/could not confirm that credential profile "work" is signed in/);
    expect(f.bridge.launches).toBe(0); expect(cachedCredentialLogin(f.root, "claude-code", "work")).toBeNull();
  });
  it("is refused when this Runtime has no profile folder at all (it also does not claim the capability)", async () => {
    const f = await fixture({}, false), task = claudeTask();
    expect(f.hub.machine(f.machineId)?.runtimeInfo?.capabilities ?? []).not.toContain("credential-profiles");
    await f.hub.call(f.machineId, "run", { task, credentialProfile: "work" });
    expect((await settled(f, task.requestId)).error).toMatch(/no credential profile folder/); expect(f.bridge.launches).toBe(0);
  });
  it("is a run on the pairing's default profile when the agent names none, and an explicit name wins over the default", async () => {
    const f = await fixture(), work = ensureCredentialProfile(f.root, "claude-code", "work"), home = ensureCredentialProfile(f.root, "claude-code", "home");
    f.store.setCredentialDefault("work");
    const a = claudeTask(), b = claudeTask(), c = codexTask();
    await f.hub.call(f.machineId, "run", { task: a }); f.bridge.cancel(a.requestId); await vi.waitFor(() => expect(f.hub.hasActiveTask(f.machineId)).toBe(false));
    await f.hub.call(f.machineId, "run", { task: b, credentialProfile: "home" }); f.bridge.cancel(b.requestId); await vi.waitFor(() => expect(f.hub.hasActiveTask(f.machineId)).toBe(false));
    await f.hub.call(f.machineId, "run", { task: c });
    expect(f.bridge.options.get(a.requestId)?.credentialHome).toBe(work);
    expect(f.bridge.options.get(b.requestId)?.credentialHome).toBe(home);
    // The default is a Claude Code sign-in only; another CLI is untouched.
    expect(f.bridge.options.get(c.requestId)?.credentialHome).toBeUndefined();
    await finish(f, c.requestId);
  });
  it("a changed digest is a different run: the same request id with another profile is refused, not re-run", async () => {
    const f = await fixture(); ensureCredentialProfile(f.root, "claude-code", "work"); ensureCredentialProfile(f.root, "claude-code", "home");
    const task = claudeTask(); await f.hub.call(f.machineId, "run", { task, credentialProfile: "work" });
    await expect(f.hub.call(f.machineId, "run", { task, credentialProfile: "home" })).rejects.toThrow(/different request/);
    expect(f.bridge.launches).toBe(1);
    await finish(f, task.requestId);
  });
});

describe("what a Runtime tells AgEnD about its profiles", () => {
  it("is the `credential-profiles` capability plus names and signed-in yes/no from an explicit detection; no path, e-mail or token", async () => {
    const f = await fixture(); ensureCredentialProfile(f.root, "claude-code", "work"); ensureCredentialProfile(f.root, "claude-code", "home");
    f.login.mockImplementation(async (_cli, directory) => directory.endsWith("work"));
    f.store.setCredentialDefault("work");
    expect(f.hub.machine(f.machineId)?.runtimeInfo?.capabilities).toContain("credential-profiles");
    await f.hub.call(f.machineId, "probe", { force: true });
    const machine = f.hub.machine(f.machineId)!, report = machine.inventory?.credentialProfiles;
    expect(report).toEqual({ profiles: [{ name: "home", loggedIn: false }, { name: "work", loggedIn: true }], default: "work" });
    expect(JSON.stringify(machine)).not.toContain(f.root); expect(JSON.stringify(machine)).not.toMatch(/credential-profiles[\\/]/);
  });
  it("a read that is not an explicit detection starts no CLI: names from the disk, the last known answer, otherwise unknown", async () => {
    const f = await fixture(); ensureCredentialProfile(f.root, "claude-code", "fresh");
    f.login.mockClear(); await f.hub.call(f.machineId, "probe", {});
    expect(f.login).not.toHaveBeenCalled();
    expect(f.hub.machine(f.machineId)?.inventory?.credentialProfiles?.profiles).toEqual([{ name: "fresh", loggedIn: null }]);
  });
  it("is the Runtime's own report: whatever the CLI worker's inventory carries, only names and yes/no leave this computer", async () => {
    const f = await fixture(); ensureCredentialProfile(f.root, "claude-code", "work");
    (f.bridge as { probe: unknown }).probe = vi.fn(async () => ({ home: "C:\\Users\\fixture", clis: [], probedAt: 2, credentialProfiles: { profiles: [{ name: "evil", loggedIn: true, path: "C:\\secret" }] } }));
    await f.hub.call(f.machineId, "probe", { force: true });
    expect(f.hub.machine(f.machineId)?.inventory?.credentialProfiles?.profiles.map(row => row.name)).toEqual(["work"]);
    expect(JSON.stringify(f.hub.machine(f.machineId))).not.toContain("secret");
  });
});
