import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { credentialProfilesRoot } from "../src/runtime-credential-profiles.js";
import { AUDIT_FILE, setRemoteSwitch } from "../src/runtime-remote-setup.js";
import { CliInstallError } from "../src/runtime-cli-install.js";
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
const ACTOR = "admin:0123456789abcdef";

describe("callAccount: the server's way to an account or install operation", () => {
  it("installs through the Runtime when its owner turned the switch on, records it there, and tells the server the version", async () => {
    const install = vi.fn(async (cli: string) => ({ version: cli === "codex" ? "0.165.0" : "2.1.316" }));
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), install } });
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
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), install } });
    await expect(f.hub.callAccount(f.machineId, "cli.install", { cli: "claude-code", actor: ACTOR })).rejects.toThrow(/agend-runtime remote-setup install on/);
    expect(install).not.toHaveBeenCalled();
    expect(audit(f.dir).map(line => JSON.parse(line)).map(line => `${line.outcome}|${line.reason}`)).toEqual(["refused|switch_off"]);
  });
  it("switch scope: the accounts switch alone never allows an install", async () => {
    const install = vi.fn(async () => ({ version: "2.1.316" }));
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), install } });
    setRemoteSwitch(f.dir, "accounts", true);
    await expect(f.hub.callAccount(f.machineId, "cli.install", { cli: "claude-code", actor: ACTOR })).rejects.toThrow(/install on/);
    expect(install).not.toHaveBeenCalled();
  });
  it("shows the installer's own sentence for a failure, and a generic one for anything else (a path would travel in it)", async () => {
    let next: Error = new CliInstallError("integrity-mismatch", "A downloaded package is not the one this AgEnD version expects, so nothing was installed");
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), install: async () => { throw next; } } });
    setRemoteSwitch(f.dir, "install", true);
    await expect(f.hub.callAccount(f.machineId, "cli.install", { cli: "codex", actor: ACTOR })).rejects.toThrow(/not the one this AgEnD version expects/);
    next = new Error("ENOENT: no such file C:\\Users\\secret\\x");
    const error = await f.hub.callAccount(f.machineId, "cli.install", { cli: "codex", actor: ACTOR }).catch(e => e as Error);
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
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), install } });
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
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), install: async cli => { throw new CliInstallError("install-failed", `cannot: ${cli}`); } } });
    setRemoteSwitch(f.dir, "install", true);
    await expect(f.hub.callAccount(f.machineId, "cli.install", { cli: "grok", actor: ACTOR })).rejects.toThrow(/cannot: grok/);
  });
  it("is not journaled: the request, its actor and its answer reach no file on the server", async () => {
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), install: async () => ({ version: "0.165.0" }) } });
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
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), install: async () => { await gate; return { version: "0.165.0" }; } } });
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
