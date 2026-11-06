import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { credentialProfilesRoot } from "../src/runtime-credential-profiles.js";
import { AUDIT_FILE, setRemoteSwitch } from "../src/runtime-remote-setup.js";
import { CliInstallError, isInstallableCli } from "../src/runtime-cli-install.js";
import type { WindowsCliProbe, WindowsCliTask } from "../src/windows-cli.js";

// #3190 Part 3b: the server asks a computer to install a CLI through `callAccount` (an account.request frame that is NOT journaled), and the Runtime's
// own switch, audit and closed table decide. Real coordinator, real Runtime client, real WebSocket; only the installer is a fake.
const directories: string[] = [], clients: RuntimeClient[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [];
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-install-3b-")); directories.push(path); return path; };
const bridge: RuntimeBridge = { probe: async (): Promise<WindowsCliProbe> => ({ home: "C:\\fixture", clis: [], probedAt: 1 }), prepareWorkspace: async () => "C:\\w", start: () => { throw Error("unused"); },
  get: (): WindowsCliTask | null => null, cancel: () => { throw Error("unused"); }, close: () => {}, releaseUnknown: () => {} };
async function fixture(clientOptions: Partial<ConstructorParameters<typeof RuntimeClient>[0]> = {}, timeout = 5000) {
  const hubHome = scratch(), hub = new RuntimeCoordinator(hubHome, { requestTimeoutMs: timeout }); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Install fixture", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)?.pairingFingerprint);
  const claim = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret }); if (claim.status !== "approved") throw Error("Pairing fixture failed");
  const server = createServer(); servers.push(server);
  server.on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
  const runtimeHome = scratch(), store = new RuntimeClientStore(join(runtimeHome, "state"));
  store.saveCredentials({ server: `http://127.0.0.1:${address.port}`, machineId: claim.machineId, credential: claim.credential, name: "Install fixture" });
  const client = new RuntimeClient({ store, bridge, reconnectMs: 25, pollMs: 10, credentialProfilesRoot: credentialProfilesRoot(store.directory),
    remoteAccounts: { find: async () => null, environment: () => ({}) }, ...clientOptions });
  clients.push(client); await client.start(); await vi.waitFor(() => expect(client.online()).toBe(true));
  await vi.waitFor(() => expect(hub.machine(claim.machineId)?.status).toBe("online"));
  return { hub, hubHome, store, client, machineId: claim.machineId, dir: store.directory };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); }
});
const everything = (path: string): string => { let out = ""; for (const entry of readdirSync(path, { withFileTypes: true })) { const full = join(path, entry.name); out += entry.isDirectory() ? everything(full) : statSync(full).size < 1_000_000 ? readFileSync(full, "utf8") : ""; } return out; };
const audit = (dir: string): string[] => { try { return readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
const installerOf = (install: (cli: string) => Promise<{ version: string }>, knows: (cli: string) => boolean = () => true) => ({ knows, install });
const ACTOR = "admin:0123456789abcdef";

describe("callAccount: the server's way to an account or install operation", () => {
  it("installs through the Runtime when its owner turned the switch on, records it there, and tells the server the version", async () => {
    const install = vi.fn(async (cli: string) => ({ version: cli === "codex" ? "0.165.0" : "2.1.316" }));
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installerOf(install) } });
    expect(f.hub.machine(f.machineId)?.runtimeInfo?.capabilities).toEqual(expect.arrayContaining(["remote-signin", "cli-install"]));
    expect(await f.hub.callAccount(f.machineId, "accounts.switches", {})).toEqual({ accounts: { on: false }, install: { on: false } });
    setRemoteSwitch(f.dir, "install", true, 3_600_000);
    expect(await f.hub.callAccount(f.machineId, "cli.install", { cli: "codex", actor: ACTOR })).toEqual({ version: "0.165.0" });
    expect(install).toHaveBeenCalledWith("codex");
    const lines = audit(f.dir).map(line => JSON.parse(line));
    expect(lines.map(line => `${line.action}|${line.outcome}|${line.cli}|${line.actor}`)).toEqual([`cli.install|started|codex|${ACTOR}`, `cli.install|ok|codex|${ACTOR}`]);
  });
  it("refuses while the switch is off, with the command to run on that computer, and installs nothing", async () => {
    const install = vi.fn(async () => ({ version: "2.1.316" }));
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installerOf(install) } });
    await expect(f.hub.callAccount(f.machineId, "cli.install", { cli: "claude-code", actor: ACTOR })).rejects.toThrow(/agend-runtime remote-setup install on/);
    expect(install).not.toHaveBeenCalled();
    expect(audit(f.dir).map(line => JSON.parse(line)).map(line => `${line.outcome}|${line.reason}`)).toEqual(["refused|switch_off"]);
  });
  it("switch scope: the accounts switch alone never allows an install", async () => {
    const install = vi.fn(async () => ({ version: "2.1.316" }));
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installerOf(install) } });
    setRemoteSwitch(f.dir, "accounts", true);
    await expect(f.hub.callAccount(f.machineId, "cli.install", { cli: "claude-code", actor: ACTOR })).rejects.toThrow(/install on/);
    expect(install).not.toHaveBeenCalled();
  });
  it("shows the installer's own sentence for a failure, and a generic one for anything else (a path would travel in it)", async () => {
    let next: Error = new CliInstallError("integrity-mismatch", "A downloaded package is not the one this AgEnD version expects, so nothing was installed");
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installerOf(async () => { throw next; }) } });
    setRemoteSwitch(f.dir, "install", true);
    await expect(f.hub.callAccount(f.machineId, "cli.install", { cli: "codex", actor: ACTOR })).rejects.toThrow(/not the one this AgEnD version expects/);
    next = new Error("ENOENT: no such file C:\\Users\\secret\\x");
    const error = (await f.hub.callAccount(f.machineId, "cli.install", { cli: "codex", actor: ACTOR }).catch(e => e)) as Error;
    expect(error.message).toMatch(/could not be completed/); expect(error.message).not.toMatch(/secret|ENOENT/);
    expect(audit(f.dir).at(-1)).toMatch(/"outcome":"failed"/);
  });
  it("a Runtime that cannot install does not claim it, and the server does not send it the request", async () => {
    const f = await fixture();
    expect(f.hub.machine(f.machineId)?.runtimeInfo?.capabilities).not.toContain("cli-install");
    await expect(f.hub.callAccount(f.machineId, "cli.install", { cli: "codex", actor: ACTOR })).rejects.toThrow(/Update the Runtime/);
  });
  it("is closed: an extra field, an unknown operation, a path or a command is refused before anything is sent", async () => {
    const install = vi.fn(async () => ({ version: "x" }));
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installerOf(install) } });
    setRemoteSwitch(f.dir, "install", true);
    const call = (operation: string, payload: unknown) => f.hub.callAccount(f.machineId, operation as "cli.install", payload as { cli: string; actor: string });
    await expect(call("cli.install", { cli: "codex", actor: ACTOR, argv: ["calc"] })).rejects.toThrow(/Invalid cli.install request/);
    await expect(call("cli.install", { cli: "codex" })).rejects.toThrow(/actor/);
    await expect(call("cli.install", { cli: "C:\\evil.exe", actor: ACTOR })).rejects.toThrow(/cli/);
    await expect(call("cli.install", { cli: "codex", actor: "a b" })).rejects.toThrow(/actor/);
    await expect(call("shell.run", { cli: "codex", actor: ACTOR })).rejects.toThrow(/Unsupported/);
    expect(install).not.toHaveBeenCalled();
  });
  it("an installable id is not enough: the Runtime refuses a CLI that is not in its table", async () => {
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installerOf(async cli => { throw new CliInstallError("install-failed", `cannot: ${cli}`); }) } });
    setRemoteSwitch(f.dir, "install", true);
    await expect(f.hub.callAccount(f.machineId, "cli.install", { cli: "grok", actor: ACTOR })).rejects.toThrow(/cannot: grok/);
  });
  it("a CLI outside the installer's table is refused before anything is recorded as started", async () => {
    const install = vi.fn(async () => ({ version: "x" }));
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installerOf(install, isInstallableCli) } });
    setRemoteSwitch(f.dir, "install", true);
    await expect(f.hub.callAccount(f.machineId, "cli.install", { cli: "grok", actor: ACTOR })).rejects.toThrow(/not in this Runtime's install list/);
    expect(install).not.toHaveBeenCalled();
    expect(audit(f.dir).map(line => JSON.parse(line)).filter(line => line.action === "cli.install").map(line => line.outcome)).not.toContain("started");
  });
  it("an installer whose `knows` throws is a refusal, folded with the rest: many requests leave a few lines, not one per request", async () => {
    const install = vi.fn(async () => ({ version: "x" }));
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: { knows: () => { throw new Error("C:\\Users\\secret\\boom"); }, install } } });
    setRemoteSwitch(f.dir, "install", true);
    for (let i = 0; i < 40; i++) { const error = (await f.hub.callAccount(f.machineId, "cli.install", { cli: "codex", actor: ACTOR }).catch(e => e)) as Error; expect(error.message).toMatch(/could not be completed/); expect(error.message).not.toMatch(/secret|boom/); }
    expect(install).not.toHaveBeenCalled();
    const lines = audit(f.dir).map(line => JSON.parse(line)).filter(line => line.action === "cli.install");
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.every(line => line.outcome === "refused" && line.reason === "failed")).toBe(true);
    expect(lines.map(line => line.outcome)).not.toContain("started");
  });
  it("a `find` that throws makes 100 sign-in starts a few folded lines, not 100 (the same check-phase rule)", async () => {
    const f = await fixture({ remoteAccounts: { find: async () => { throw new Error("C:\\Users\\secret\\boom"); }, environment: () => ({}) } });
    setRemoteSwitch(f.dir, "accounts", true);
    for (let i = 0; i < 100; i++) {
      const error = (await f.hub.callAccount(f.machineId, "signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor: ACTOR }).catch(e => e)) as Error;
      expect(error.message).not.toMatch(/secret|boom/);
    }
    const lines = audit(f.dir).map(line => JSON.parse(line)).filter(line => line.action === "signin");
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.map(line => line.outcome)).not.toContain("failed");
  });
  it("two installs asked at the same moment: one runs, the other is answered busy", async () => {
    let release = (): void => {}; const gate = new Promise<void>(done => { release = done; });
    const install = vi.fn(async () => { await gate; return { version: "0.165.0" }; });
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installerOf(install) } });
    setRemoteSwitch(f.dir, "install", true);
    const calls = Array.from({ length: 5 }, () => f.hub.callAccount(f.machineId, "cli.install", { cli: "codex", actor: ACTOR }).then(() => "ok", (e: Error) => e.message));
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    release();
    const results = await Promise.all(calls);
    expect(results.filter(r => r === "ok")).toHaveLength(1);
    expect(results.filter(r => r !== "ok").every(r => /Another install is running/.test(r))).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
  });
  it("is not journaled: the request, its actor and its answer reach no file on the server", async () => {
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installerOf(async () => ({ version: "0.165.0" })) } });
    setRemoteSwitch(f.dir, "install", true);
    const before = JSON.parse(readFileSync(join(f.hubHome, "runtime-machines.json"), "utf8")).commands.length;
    await f.hub.callAccount(f.machineId, "cli.install", { cli: "codex", actor: ACTOR });
    await f.hub.callAccount(f.machineId, "accounts.switches", {});
    f.hub.close();
    const written = everything(f.hubHome);
    expect(JSON.parse(readFileSync(join(f.hubHome, "runtime-machines.json"), "utf8")).commands.length).toBe(before);
    expect(written).not.toContain(ACTOR); expect(written).not.toContain("cli.install"); expect(written).not.toContain("account.request");
  });
  it("gives up after its deadline, forgets the call, and ignores a late answer", async () => {
    let release = (): void => {}; const gate = new Promise<void>(done => { release = done; });
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installerOf(async () => { await gate; return { version: "0.165.0" }; }) } });
    setRemoteSwitch(f.dir, "install", true);
    await expect(f.hub.callAccount(f.machineId, "cli.install", { cli: "codex", actor: ACTOR }, 1000)).rejects.toThrow(/did not answer in time/);
    release();
    await new Promise(done => setTimeout(done, 50));
    expect(f.hub.machine(f.machineId)?.status).toBe("online");        // the late answer closed nothing
  });
  it("fails at once when the computer is offline", async () => {
    const f = await fixture();
    await f.client.stop();
    await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.status).toBe("offline"));
    await expect(f.hub.callAccount(f.machineId, "accounts.switches", {})).rejects.toThrow(/offline/);
  });
});

/** Reads what only the coordinator knows (its private pending table and its one way to write a frame), to prove what did NOT happen. */
const inside = (hub: RuntimeCoordinator) => hub as unknown as { accountPending: Map<string, { machineId: string; generation: number; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
  connections: Map<string, unknown>; message(connection: unknown, raw: Buffer): Promise<void> };
const SESSION = "0123456789abcdef0123456789abcdef";
const EVERY_OPERATION: Array<[string, unknown]> = [
  ["accounts.switches", {}],
  ["signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor: ACTOR }],
  ["signin.capture", { sessionId: SESSION }], ["signin.status", { sessionId: SESSION }], ["signin.write", { sessionId: SESSION, input: "x" }], ["signin.close", { sessionId: SESSION }],
  ["accounts.check", { cli: "claude-code", profile: "work" }], ["accounts.signout", { cli: "claude-code", profile: "work", actor: ACTOR }], ["accounts.remove", { cli: "claude-code", profile: "work", actor: ACTOR }],
  ["cli.install", { cli: "codex", actor: ACTOR }],
];
const frameTypes = (send: { mock: { calls: unknown[][] } }): string[] => send.mock.calls.map(([, value]) => (value as { type: string }).type);

describe("callAccount: a connection that goes away, an answer from the wrong connection", () => {
  it("a Runtime that disconnects in the middle of a call rejects it and leaves nothing pending", async () => {
    let release = (): void => {}; const gate = new Promise<void>(done => { release = done; });
    const install = vi.fn(async () => { await gate; return { version: "0.165.0" }; });
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installerOf(install) } });
    setRemoteSwitch(f.dir, "install", true);
    const call = f.hub.callAccount(f.machineId, "cli.install", { cli: "codex", actor: ACTOR }).then(() => "answered", (e: Error) => e.message);
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    expect(inside(f.hub).accountPending.size).toBe(1);
    // stop() now waits for the work in flight (3a's fence), and ends the connection first; the fake installer ignores the abort, so it is let go here.
    const stopping = f.client.stop();
    expect(await call).toMatch(/Runtime disconnected/);
    expect(inside(f.hub).accountPending.size).toBe(0);
    release(); await stopping;
  });
  it("an answer that names a pending call of another generation is refused, and does not settle that call", async () => {
    const f = await fixture(), hub = inside(f.hub), connection = hub.connections.get(f.machineId) as { generation: number };
    const id = randomUUID(); let settled: string | null = null;
    hub.accountPending.set(id, { machineId: f.machineId, generation: connection.generation + 1, resolve: () => { settled = "resolved"; }, reject: () => { settled = "rejected"; }, timer: setTimeout(() => {}, 0) });
    const frame = Buffer.from(JSON.stringify({ v: 1, type: "account.response", id, ok: true, result: { leaked: true } }));
    await expect(hub.message(connection, frame)).rejects.toThrow(/belongs to another connection/);
    expect(settled).toBeNull(); expect(hub.accountPending.has(id)).toBe(true);
    // The same answer for a call of this connection's own generation settles it, so the refusal above is about the generation and nothing else.
    const own = randomUUID(); let value: unknown;
    hub.accountPending.set(own, { machineId: f.machineId, generation: connection.generation, resolve: v => { value = v; }, reject: () => {}, timer: setTimeout(() => {}, 0) });
    await hub.message(connection, Buffer.from(JSON.stringify({ v: 1, type: "account.response", id: own, ok: true, result: { fine: 1 } })));
    expect(value).toEqual({ fine: 1 }); expect(hub.accountPending.has(own)).toBe(false);
    clearTimeout(hub.accountPending.get(id)!.timer); hub.accountPending.delete(id);
  });
  it("an answer for another computer's pending call is refused too", async () => {
    const f = await fixture(), hub = inside(f.hub), connection = hub.connections.get(f.machineId) as { generation: number };
    const id = randomUUID();
    hub.accountPending.set(id, { machineId: randomUUID(), generation: connection.generation, resolve: () => { throw Error("must not settle"); }, reject: () => { throw Error("must not settle"); }, timer: setTimeout(() => {}, 0) });
    await expect(hub.message(connection, Buffer.from(JSON.stringify({ v: 1, type: "account.response", id, ok: true, result: 1 })))).rejects.toThrow(/belongs to another connection/);
    clearTimeout(hub.accountPending.get(id)!.timer); hub.accountPending.delete(id);
  });
});

describe("callAccount: the capability gate stops the frame before it is written", () => {
  it("control: a Runtime that reports the capability is sent an account.request (so the checks below would see one)", async () => {
    const f = await fixture(), send = vi.spyOn(f.hub as unknown as { send(connection: unknown, value: unknown): void }, "send");
    await f.hub.callAccount(f.machineId, "accounts.switches", {});
    expect(frameTypes(send)).toEqual(["account.request"]);
  });
  it("a Runtime without cli-install is never sent cli.install: no frame is written, not only a rejection", async () => {
    const f = await fixture(), send = vi.spyOn(f.hub as unknown as { send(connection: unknown, value: unknown): void }, "send");
    expect(f.hub.machine(f.machineId)?.runtimeInfo?.capabilities).toContain("remote-signin");
    expect(f.hub.machine(f.machineId)?.runtimeInfo?.capabilities).not.toContain("cli-install");
    await expect(f.hub.callAccount(f.machineId, "cli.install", { cli: "codex", actor: ACTOR })).rejects.toThrow(/Update the Runtime/);
    expect(send).not.toHaveBeenCalled(); expect(inside(f.hub).accountPending.size).toBe(0);
  });
  it("a Runtime without remote-signin is sent none of the accounts.* or signin.* operations, nor cli.install", async () => {
    const f = await fixture({ credentialProfilesRoot: undefined }), send = vi.spyOn(f.hub as unknown as { send(connection: unknown, value: unknown): void }, "send");
    expect(f.hub.machine(f.machineId)?.runtimeInfo?.capabilities).not.toContain("remote-signin");
    expect(f.hub.machine(f.machineId)?.runtimeInfo?.capabilities).not.toContain("cli-install");
    for (const [operation, payload] of EVERY_OPERATION) {
      await expect(f.hub.callAccount(f.machineId, operation as "cli.install", payload as { cli: string; actor: string }), operation).rejects.toThrow(/Update the Runtime/);
    }
    expect(send).not.toHaveBeenCalled();
    expect(frameTypes(send)).toEqual([]); expect(inside(f.hub).accountPending.size).toBe(0);
  });
});
