/** Account work and the managed-update fences, on the real authenticated websocket endpoints with an inert bridge. */
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeClient, type RuntimeBridge, type RuntimeClientOptions } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { credentialProfilesRoot } from "../src/runtime-credential-profiles.js";
import { setRemoteSwitch } from "../src/runtime-remote-setup.js";

const roots: string[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [], clients: RuntimeClient[] = [];
const directory = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-remote-update-")); roots.push(path); return path; };
function held<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); pid = 9; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  kill(): boolean { queueMicrotask(() => { this.exitCode = 1; this.emit("close", 1); }); return true; }
}
async function fixture(extra: Partial<RuntimeClientOptions> = {}, trial?: string) {
  const hub = new RuntimeCoordinator(directory()); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Fixture", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)!.pairingFingerprint);
  const identity = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret });
  if (identity.status !== "approved") throw Error("Fixture approval failed");
  const server = createServer(); servers.push(server);
  server.on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port, store = new RuntimeClientStore(directory());
  store.saveCredentials({ server: `http://127.0.0.1:${port}`, name: "Fixture", machineId: identity.machineId, credential: identity.credential });
  const bridge: RuntimeBridge = { probe: vi.fn(async () => ({ home: "C:\\fixture", clis: [], probedAt: 1 })), prepareWorkspace: vi.fn(async () => "C:\\fixture"),
    start: vi.fn(() => { throw Error("No fixture run"); }), get: () => null, cancel: vi.fn(), close: vi.fn(), releaseUnknown: vi.fn(), idleForUpdate: () => true };
  const children: FakeChild[] = [], find = vi.fn(async () => ({ path: "claude.exe", command: "claude.exe", args: [] as string[] }));
  const authenticated = held<void>();
  const client = new RuntimeClient({ store, bridge, reconnectMs: 10, pollMs: 10, credentialProfilesRoot: credentialProfilesRoot(store.directory), credentialLogin: async () => false,
    remoteAccounts: { find, environment: () => ({ PATH: "p" }), runLogout: async () => 0, signIn: { scratchRoot: directory(), spawn: () => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; } } },
    ...extra, managedUpdate: { ...(trial ? { trialId: trial } : {}), ...extra.managedUpdate, authenticated: value => { extra.managedUpdate?.authenticated?.(value); authenticated.resolve(); } } });
  clients.push(client); await client.start(); await authenticated.promise;
  // The frames a real AgEnD would send are fed to the client itself; its answers are captured (the coordinator has no account frames yet).
  const answers: any[] = [], realSend = (client as any).send.bind(client);
  vi.spyOn(client as any, "send").mockImplementation((frame: any) => { if (frame.type === "account.response") answers.push(frame); else realSend(frame); });
  const ask = async (operation: string, payload: unknown): Promise<any> => { const id = `acct-${randomUUID()}`; await (client as any).receive(JSON.stringify({ v: 1, type: "account.request", id, operation, payload })); return answers.find(frame => frame.id === id); };
  return { hub, client, bridge, store, find, children, ask, answers };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const start = (profile = "work") => ({ cli: "claude-code", profile, method: "subscription", actor: "admin:u1" });

it("an account request that arrives while an update is being prepared (the fence is held) is refused, and runs nothing", async () => {
  const drained = held<void>(), entered = held<void>();
  const f = await fixture({ drainPaneHostForUpdate: async () => { entered.resolve(); await drained.promise; } }); setRemoteSwitch(f.store.directory, "accounts", true);
  const preparing = f.client.prepareUpdate(randomUUID()); await entered.promise;
  const answer = await f.ask("signin.start", start()); expect(answer.ok).toBe(false); expect(answer.error).toMatch(/holding new work/); expect(f.find).not.toHaveBeenCalled(); expect(f.children).toHaveLength(0);
  drained.resolve(); await preparing.catch(() => false);
});
it("an account request is refused during a managed update trial (before activation) and runs nothing", async () => {
  const f = await fixture({ reconnectMs: 60_000 }, randomUUID()); setRemoteSwitch(f.store.directory, "accounts", true);
  expect((f.client as any).trialFence).toBeDefined();
  const answer = await f.ask("signin.start", start()); expect(answer.ok).toBe(false); expect(answer.error).toMatch(/holding new work/); expect(f.find).not.toHaveBeenCalled(); expect(f.children).toHaveLength(0);
});
it("an open remote sign-in keeps the Runtime from being idle: an update is not prepared until it is closed and its child is confirmed gone", async () => {
  const f = await fixture(); setRemoteSwitch(f.store.directory, "accounts", true);
  const started = await f.ask("signin.start", start()); expect(started.ok).toBe(true); const sessionId = started.result.sessionId as string;
  expect((f.client as any).locallyIdle()).toBe(false); expect(await f.client.prepareUpdate(randomUUID())).toBe(false); expect(f.bridge.close).not.toHaveBeenCalled(); expect(f.client.online()).toBe(true);
  const closed = await f.ask("signin.close", { sessionId }); expect(closed.ok).toBe(true); expect(f.children[0]!.exitCode).not.toBeNull();
  expect((f.client as any).locallyIdle()).toBe(true); expect(await f.client.prepareUpdate(randomUUID())).toBe(true);
});
it("a sign-in whose child could not be confirmed gone still holds the Runtime non-idle", async () => {
  let kills = 0; let stuck: FakeChild | undefined; const f = await fixture({ remoteAccounts: { find: async () => ({ path: "claude.exe", command: "claude.exe", args: [] }), environment: () => ({ PATH: "p" }), runLogout: async () => 0,
    signIn: { scratchRoot: directory(), kill: () => { kills++; }, spawn: () => { stuck = new FakeChild(); return stuck as unknown as ChildProcess; } } } });
  setRemoteSwitch(f.store.directory, "accounts", true); const started = await f.ask("signin.start", start()); expect(started.ok).toBe(true);
  vi.useFakeTimers({ toFake: ["setTimeout"] }); const closing = f.ask("signin.close", { sessionId: started.result.sessionId }); await vi.advanceTimersByTimeAsync(6000); const closed = await closing; vi.useRealTimers();
  expect(closed.ok).toBe(false); expect(kills).toBeGreaterThan(0); expect((f.client as any).locallyIdle()).toBe(false); expect(await f.client.prepareUpdate(randomUUID())).toBe(false);
  stuck!.exitCode = 1; stuck!.emit("close", 1);                                                                                  // the process really ends, so the Runtime can be stopped at the end of the test
});
it("a request in flight holds the activity too: an update cannot be prepared while a CLI lookup is still waiting", async () => {
  const lookup = held<{ path: string; command: string; args: string[] }>(); const f = await fixture({ remoteAccounts: { find: () => lookup.promise, environment: () => ({ PATH: "p" }), runLogout: async () => 0, signIn: { scratchRoot: directory(), spawn: () => new FakeChild() as unknown as ChildProcess } } });
  setRemoteSwitch(f.store.directory, "accounts", true); const waiting = f.ask("signin.start", start());
  await new Promise(done => setTimeout(done, 30)); expect(await f.client.prepareUpdate(randomUUID())).toBe(false);
  lookup.resolve({ path: "claude.exe", command: "claude.exe", args: [] }); const answer = await waiting; expect(answer.ok).toBe(true); (f.client as any).remoteAccounts?.stop?.();
});
