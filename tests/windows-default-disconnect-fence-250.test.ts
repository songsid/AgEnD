/**
 * AGEND-250 (#3771 review P2-4): signing the computer's OWN Antigravity login out (Windows Runtime) and task admission share one fence for that credential. The real RuntimeClient (admission of a
 * run) and the real RemoteAccounts (the Disconnect); the CLI, the Credential Manager and the hub are fixtures. Two arrivals are covered, and neither may consume a credential being removed:
 *  - a run that arrives while the deletion is held;
 *  - a run that was ALREADY accepted and is still waiting (in `openMcp`, so not yet "active") before the Disconnect's checks.
 */
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
import { credentialProfilesRoot } from "../src/runtime-credential-profiles.js";
import { setRemoteSwitch } from "../src/runtime-remote-setup.js";
import type { WindowsCliProbe, WindowsCliTask, WindowsRunOptions } from "../src/windows-cli.js";

const ACTOR = "admin:0123456789abcdef";
const directories: string[] = [], clients: RuntimeClient[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [];
const home = () => { const path = mkdtempSync(join(tmpdir(), "agend-fence-250-")); directories.push(path); return path; };
const agyTask = () => ({ requestId: randomUUID(), cli: "antigravity" as const, cwd: "C:\\workspace", prompt: "Private fixture request; never invoke a real CLI", sandbox: "workspace-write" as const });
class FakeBridge implements RuntimeBridge {
  readonly tasks = new Map<string, WindowsCliTask>(); launches = 0;
  readonly probe = vi.fn(async (): Promise<WindowsCliProbe> => ({ home: "C:\\Users\\fixture", clis: [], probedAt: 1 }));
  readonly prepareWorkspace = vi.fn(async (agentId: string) => `C:\\Users\\fixture\\.agend\\workspaces\\${agentId}`);
  start(raw: unknown, _authorized?: () => boolean, _options: WindowsRunOptions = {}): WindowsCliTask {
    const task = raw as ReturnType<typeof agyTask>; this.launches++;
    const snapshot: WindowsCliTask = { id: task.requestId, cli: task.cli, cwd: task.cwd, sandbox: task.sandbox, status: "running", startedAt: Date.now(), output: "" };
    this.tasks.set(snapshot.id, snapshot); return { ...snapshot };
  }
  get(id: string): WindowsCliTask | null { const task = this.tasks.get(id); return task ? { ...task } : null; }
  cancel(id: string): WindowsCliTask { const task = this.tasks.get(id)!; Object.assign(task, { status: "cancelled", finishedAt: Date.now(), outcomeConfirmed: true }); return { ...task }; }
  close(): void {}
  releaseUnknown(_id: string): void {}
}
async function fixture() {
  const hub = new RuntimeCoordinator(home()); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Fixture Windows", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)?.pairingFingerprint);
  const claim = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret }); if (claim.status !== "approved") throw Error("Pairing fixture failed");
  const server = createServer((req, res) => { if (!hub.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
  servers.push(server); server.on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
  const runtimeHome = home(), root = credentialProfilesRoot(runtimeHome), store = new RuntimeClientStore(join(runtimeHome, "state")), bridge = new FakeBridge();
  store.saveCredentials({ server: `http://127.0.0.1:${address.port}`, machineId: claim.machineId, credential: claim.credential, name: "Fixture Windows" });
  // The Credential Manager and the CLI's status: a deletion that waits for the test, and a ledger of what happened in what order.
  const events: string[] = [];
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const deleteCredential = vi.fn(async () => { events.push("deletion began"); await gate; events.push("deletion finished"); return 0; });
  const defaultStatus = vi.fn(async () => { events.push("verified"); return false as boolean | null; });
  const client = new RuntimeClient({ store, bridge, reconnectMs: 25, disconnectGraceMs: 500, pollMs: 10, credentialProfilesRoot: root,
    remoteAccounts: { find: async () => ({ path: "agy.exe", command: "agy.exe", args: [] }), defaultStatus, deleteCredential, environment: () => ({ PATH: "p" }) } });
  clients.push(client); await client.start(); await vi.waitFor(() => expect(client.online()).toBe(true));
  setRemoteSwitch(store.directory, "accounts", true, undefined, Date.now());
  const remote = () => (client as unknown as { remote(): { handle(op: string, input: unknown): Promise<unknown> } }).remote();
  const signOut = () => remote().handle("accounts.signout", { cli: "antigravity", actor: ACTOR });
  return { hub, bridge, client, machineId: claim.machineId, events, release, deleteCredential, defaultStatus, signOut };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); }
});
const settled = async (f: Fixture, id: string) => { await vi.waitFor(() => expect(f.hub.task(id)?.finishedAt).toBeDefined()); return f.hub.task(id)!; };

describe("P2-4: default-account Disconnect and task admission exclude each other", () => {
  it("a run that arrives while the deletion is held is refused, and never reaches the CLI; the Disconnect then finishes and verifies", async () => {
    const f = await fixture();
    const out = f.signOut();
    await vi.waitFor(() => expect(f.deleteCredential).toHaveBeenCalled());
    const task = agyTask();
    await f.hub.call(f.machineId, "run", { task }).catch(() => {});
    const result = await settled(f, task.requestId);
    expect(result.status).toBe("failed"); expect(result.error).toMatch(/being changed from AgEnD/);
    expect(f.bridge.launches).toBe(0);
    f.events.push("(run refused)");
    f.release();
    expect(await out).toEqual({ loggedIn: false });
    expect(f.events).toEqual(["deletion began", "(run refused)", "deletion finished", "verified"]);
  });
  it("a run that was already accepted and is waiting (openMcp: not active yet) before the checks makes the Disconnect refuse; the credential is not deleted", async () => {
    const f = await fixture();
    let openMcp!: (v: unknown) => void;
    (f.client as unknown as { openMcp: () => Promise<unknown> }).openMcp = () => new Promise(r => { openMcp = r; });
    const task = agyTask();
    const run = f.hub.call(f.machineId, "run", { task, mcp: { tools: ["fixture_tool"] } }).catch(() => {});
    await vi.waitFor(() => expect(typeof openMcp).toBe("function"));
    await expect(f.signOut()).rejects.toThrow(/A task is running on this computer/);
    expect(f.deleteCredential).not.toHaveBeenCalled(); expect(f.defaultStatus).not.toHaveBeenCalled();
    openMcp(undefined); await run;
  });
  it("positive controls: once the Disconnect has ended a run is admitted, and with nothing running the Disconnect goes through", async () => {
    const f = await fixture(); f.release();
    expect(await f.signOut()).toEqual({ loggedIn: false });
    const task = agyTask();
    await f.hub.call(f.machineId, "run", { task });
    expect(f.bridge.launches).toBe(1);
    f.bridge.cancel(task.requestId);
    await vi.waitFor(() => expect(f.hub.hasActiveTask(f.machineId)).toBe(false));
  });
});
