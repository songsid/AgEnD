/**
 * #3190 Part 3b with #3258: a CLI install takes the shared install lock (`.agend-runtime-install.lock`, type "installer") and keeps it, with an `inflight` marker,
 * until its last child process has really ended. On the real Runtime client, an install whose child could not be confirmed ended keeps the Runtime non-idle.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliInstallError, INSTALLABLE_CLIS, installManagedCli, managedCliExecutable, managedInstallRoot, managedInstaller, type InstallDeps } from "../src/runtime-cli-install.js";
import { acquireRuntimeInstallLock, RUNTIME_INSTALL_LOCK, type RuntimeProcessObservation } from "../src/runtime-update-lock.js";
import { ProcessNotConfirmedEnded } from "../src/runtime-remote-accounts.js";
import { RuntimeClient, type RuntimeBridge, type RuntimeClientOptions } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { credentialProfilesRoot } from "../src/runtime-credential-profiles.js";
import { setRemoteSwitch } from "../src/runtime-remote-setup.js";

const codex = INSTALLABLE_CLIS.codex;
const signedByOpenAI = async () => ({ status: "Valid", subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"' });
let home: string, node: string, cliRoot: string;
const roots: string[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agend-cli-install-lock-")); roots.push(home);
  node = join(home, "nodejs", "node.exe"); mkdirSync(join(home, "nodejs", "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(join(home, "nodejs", "node_modules", "npm", "bin", "npm-cli.js"), ""); cliRoot = join(home, "cli");
});
const lockDir = (root = cliRoot): string => join(root, RUNTIME_INSTALL_LOCK);
const dying = (): RuntimeProcessObservation => ({ state: "gone" });

/** A fake npm that writes what a real install leaves, and can stop in the middle on a gate. */
function npm(options: { before?: (step: string) => Promise<void> | void } = {}): NonNullable<InstallDeps["run"]> {
  return async (_file, args, { cwd }) => {
    await options.before?.(args[1] ?? "");
    if (args[1] === "install") {
      const packages = Object.fromEntries(Object.entries(codex.integrity).map(([path, integrity]) => [path, { integrity, version: codex.version }]));
      writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ packages }));
      const file = join(cwd, codex.native.path); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "MZ");
    }
    return { code: 0, stdout: "" };
  };
}
const deps = (extra: Partial<InstallDeps> = {}): InstallDeps => ({ root: cliRoot, nodePath: node, run: npm(), signerOf: signedByOpenAI, ...extra });

describe("the shared install lock (#3258) is held for the whole install", () => {
  it("is the shared installer lock with an inflight marker while the install runs, refuses a second install as busy, and is gone when it ends", async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    let seen: { record: any; inflight: boolean } | undefined;
    const first = installManagedCli("codex", deps({ run: npm({ before: async step => { if (step === "audit") { seen = { record: JSON.parse(readFileSync(join(lockDir(), "owner.json"), "utf8")), inflight: existsSync(join(lockDir(), "inflight")) }; await gate; } } }) }));
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen!.record).toMatchObject({ version: 1, type: "installer", pid: process.pid }); expect(seen!.inflight).toBe(true);
    await expect(installManagedCli("codex", deps())).rejects.toMatchObject({ reason: "busy", message: expect.stringMatching(/install or Runtime update is already running/) });
    expect(existsSync(lockDir())).toBe(true);                            // the refused one did not touch the first one's lock
    release(); expect((await first).version).toBe(codex.version);
    expect(existsSync(lockDir())).toBe(false);
    expect((await installManagedCli("codex", deps({ run: npm() }))).version).toBe(codex.version);   // already installed: nothing needed, nothing left behind
    expect(existsSync(lockDir())).toBe(false);
  });
  it("is released after a failed install too, so the next one can run", async () => {
    await expect(installManagedCli("codex", deps({ signerOf: async () => ({ status: "NotSigned", subject: "" }) }))).rejects.toMatchObject({ reason: "publisher-mismatch" });
    expect(existsSync(lockDir())).toBe(false);
    expect((await installManagedCli("codex", deps())).version).toBe(codex.version);
  });
  it("a lock held by someone else (an update, install.ps1, another Runtime) makes the install busy, and nothing is written", async () => {
    mkdirSync(cliRoot, { recursive: true, mode: 0o700 });
    const other = await acquireRuntimeInstallLock(cliRoot, { type: "supervisor", ownProof: { pid: process.pid, birth: "638980000000000000", boot: "b".repeat(64) }, observe: async () => ({ state: "alive", proof: { pid: process.pid, birth: "638980000000000000", boot: "b".repeat(64) } }) });
    const run = vi.fn(npm());
    await expect(installManagedCli("codex", deps({ run, lockOptions: { ownProof: other.record, observe: async () => ({ state: "alive", proof: other.record }) } }))).rejects.toMatchObject({ reason: "busy" });
    expect(run).not.toHaveBeenCalled(); expect(existsSync(join(cliRoot, "codex"))).toBe(false);
    other.release();
    expect((await installManagedCli("codex", deps())).version).toBe(codex.version);
  });
  it("an owner that is gone but left its inflight marker is uncertainty: the install is refused, the marker and the owner's record stay", async () => {
    mkdirSync(lockDir(), { recursive: true, mode: 0o700 }); chmodSync(cliRoot, 0o700);
    const stale = { version: 1, type: "installer", nonce: randomUUID(), pid: 999_999, birth: "638980000000000000", boot: "c".repeat(64) };
    writeFileSync(join(lockDir(), "owner.json"), JSON.stringify(stale), { mode: 0o600 }); writeFileSync(join(lockDir(), "inflight"), "{}", { mode: 0o600 });
    const run = vi.fn(npm());
    await expect(installManagedCli("codex", deps({ run, lockOptions: { ownProof: { pid: process.pid, birth: "638980000000000001", boot: "d".repeat(64) }, observe: async pid => pid === process.pid ? { state: "alive", proof: { pid, birth: "638980000000000001", boot: "d".repeat(64) } } : dying() } }))).rejects.toMatchObject({ reason: "busy" });
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(lockDir(), "inflight"))).toBe(true); expect(JSON.parse(readFileSync(join(lockDir(), "owner.json"), "utf8")).nonce).toBe(stale.nonce);
  });
  it("a dead owner with no marker is reclaimed (a clean crash between installs) and the install goes on", async () => {
    mkdirSync(lockDir(), { recursive: true, mode: 0o700 }); chmodSync(cliRoot, 0o700);
    writeFileSync(join(lockDir(), "owner.json"), JSON.stringify({ version: 1, type: "installer", nonce: randomUUID(), pid: 999_999, birth: "638980000000000000", boot: "c".repeat(64) }), { mode: 0o600 });
    expect((await installManagedCli("codex", deps({ lockOptions: { ownProof: { pid: process.pid, birth: "638980000000000001", boot: "d".repeat(64) }, observe: async pid => pid === process.pid ? { state: "alive", proof: { pid, birth: "638980000000000001", boot: "d".repeat(64) } } : dying() } }))).version).toBe(codex.version);
    expect(existsSync(lockDir())).toBe(false);
  });
  it("an unsafe lock folder (a link) is one fixed sentence, and nothing is installed", async () => {
    mkdirSync(cliRoot, { recursive: true, mode: 0o700 }); mkdirSync(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), lockDir(), "dir");
    const error = await installManagedCli("codex", deps()).catch((e: unknown) => e) as CliInstallError;
    expect(error).toBeInstanceOf(CliInstallError); expect(error.reason).toBe("install-failed"); expect(error.message).toBe("This computer could not lock its Runtime install folder, so nothing was installed");
    expect(existsSync(join(cliRoot, "codex"))).toBe(false);
  });
  it("uses an explicit installRoot (the managed Runtime install root) for the lock, and leaves nothing in the CLI folder", async () => {
    const installRoot = join(home, "agend-runtime"); mkdirSync(installRoot, { mode: 0o700 }); chmodSync(installRoot, 0o700);
    let at: string | undefined;
    await installManagedCli("codex", deps({ installRoot, run: npm({ before: step => { if (step === "install") at = [existsSync(lockDir(installRoot)), existsSync(lockDir(cliRoot))].join(); } }) }));
    expect(at).toBe("true,false"); expect(existsSync(lockDir(installRoot))).toBe(false);
  });
  it("finds the managed install root from where the code runs: <root>\\<version>\\dist\\file, with bin\\current.txt or the receipt; a ZIP copy has none", () => {
    const root = join(home, "agend-runtime"); mkdirSync(join(root, "2.3.5+abcd1234", "dist"), { recursive: true }); const file = join(root, "2.3.5+abcd1234", "dist", "runtime-cli-install.js");
    expect(managedInstallRoot(file)).toBeNull();
    mkdirSync(join(root, "bin")); writeFileSync(join(root, "bin", "current.txt"), "2.3.5+abcd1234"); expect(managedInstallRoot(file)).toBe(root);
    rmSync(join(root, "bin"), { recursive: true }); expect(managedInstallRoot(file)).toBeNull(); writeFileSync(join(root, ".agend-runtime-install.json"), "{}"); expect(managedInstallRoot(file)).toBe(root);
    expect(managedInstallRoot(join(home, "zip", "dist", "runtime-cli-install.js"))).toBeNull();
  });
});

describe("the lock is asserted at every step and at the swap", () => {
  it("a lock that changed before the swap stops the install: current.json and the old install stay, the new folder never lands", async () => {
    mkdirSync(join(cliRoot, "codex", "0.0.1"), { recursive: true }); writeFileSync(join(cliRoot, "codex", "0.0.1", "marker"), "old"); writeFileSync(join(cliRoot, "codex", "current.json"), JSON.stringify({ version: "0.0.1" }));
    const error = await installManagedCli("codex", deps({ signerOf: async () => { writeFileSync(join(lockDir(), "owner.json"), JSON.stringify({ version: 1, type: "installer", nonce: randomUUID(), pid: process.pid, birth: "1".repeat(18), boot: "e".repeat(64) }), { mode: 0o600 }); return signedByOpenAI(); } })).catch((e: unknown) => e) as CliInstallError;
    expect(error).toBeInstanceOf(CliInstallError); expect(error.reason).toBe("install-failed"); expect(error.message).toMatch(/install lock changed/);
    expect(JSON.parse(readFileSync(join(cliRoot, "codex", "current.json"), "utf8"))).toEqual({ version: "0.0.1" });
    expect(readFileSync(join(cliRoot, "codex", "0.0.1", "marker"), "utf8")).toBe("old");
    expect(existsSync(join(cliRoot, "codex", codex.version))).toBe(false); expect(existsSync(join(cliRoot, "codex", `${codex.version}.staging`))).toBe(false);
    expect(managedCliExecutable(cliRoot, "codex")).toBeNull();
  });
  it("a lock that changes between the new folder landing and the pointer write rolls the folder back", async () => {
    mkdirSync(join(cliRoot, "codex", "0.0.1"), { recursive: true }); writeFileSync(join(cliRoot, "codex", "current.json"), JSON.stringify({ version: "0.0.1" }));
    let renames = 0;
    const error = await installManagedCli("codex", deps({ rename: (from, to) => { renames++; renameSync(from, to); if (renames === 1) writeFileSync(join(lockDir(), "owner.json"), JSON.stringify({ version: 1, type: "installer", nonce: randomUUID(), pid: process.pid, birth: "1".repeat(18), boot: "e".repeat(64) })); } })).catch((e: unknown) => e) as CliInstallError;
    expect(error).toBeInstanceOf(CliInstallError);
    expect(JSON.parse(readFileSync(join(cliRoot, "codex", "current.json"), "utf8"))).toEqual({ version: "0.0.1" }); expect(existsSync(join(cliRoot, "codex", codex.version))).toBe(false);
  });
});


describe("a child process that could not be confirmed ended keeps the lock, its marker and the staging folder", () => {
  it("until it really ends: then the lock, the marker and the staging folder go, and the next install runs", async () => {
    let ended!: () => void; const closed = new Promise<void>(done => { ended = done; });
    const run: NonNullable<InstallDeps["run"]> = async (_f, args, { cwd }) => { if (args[1] === "install") { writeFileSync(join(cwd, "partial"), "x"); throw new ProcessNotConfirmedEnded(closed); } return { code: 0, stdout: "" }; };
    const error = await installManagedCli("codex", deps({ run })).catch((e: unknown) => e) as CliInstallError;
    expect(error).toBeInstanceOf(CliInstallError); expect(error.reason).toBe("install-failed"); expect(error.ended).toBeInstanceOf(Promise);
    expect(existsSync(join(lockDir(), "owner.json"))).toBe(true); expect(existsSync(join(lockDir(), "inflight"))).toBe(true);
    expect(existsSync(join(cliRoot, "codex", `${codex.version}.staging`, "partial"))).toBe(true);
    await expect(installManagedCli("codex", deps())).rejects.toMatchObject({ reason: "busy" });
    expect(existsSync(join(lockDir(), "inflight"))).toBe(true);
    ended(); await vi.waitFor(() => expect(existsSync(lockDir())).toBe(false));
    expect(existsSync(join(cliRoot, "codex", `${codex.version}.staging`))).toBe(false);
    expect((await installManagedCli("codex", deps())).version).toBe(codex.version);
  });
  it("is reported as cancelled when the Runtime was stopping, and as timed-out when the deadline ran out", async () => {
    for (const [reason, stop] of [["cancelled", true], ["timed-out", false]] as const) {
      rmSync(cliRoot, { recursive: true, force: true });
      const controller = new AbortController(); let ended!: () => void; const closed = new Promise<void>(done => { ended = done; });
      const run: NonNullable<InstallDeps["run"]> = async () => { if (stop) controller.abort(); else await new Promise(done => setTimeout(done, 30)); throw new ProcessNotConfirmedEnded(closed); };
      const error = await installManagedCli("codex", deps({ run, ...(stop ? { signal: controller.signal } : { deadlineMs: 5 }) })).catch((e: unknown) => e) as CliInstallError;
      expect(error.reason).toBe(reason); expect(error.ended).toBeInstanceOf(Promise);
      ended(); await vi.waitFor(() => expect(existsSync(lockDir())).toBe(false));
    }
  });
  it("managedInstaller counts the install as running until the child ended, not only until the call returned", async () => {
    let ended!: () => void; const closed = new Promise<void>(done => { ended = done; });
    const installer = managedInstaller({ root: cliRoot, nodePath: node, run: async () => { throw new ProcessNotConfirmedEnded(closed); }, signerOf: signedByOpenAI });
    expect(installer.running()).toBe(false);
    await expect(installer.install("codex")).rejects.toBeInstanceOf(CliInstallError);
    expect(installer.running()).toBe(true);
    ended(); await vi.waitFor(() => expect(installer.running()).toBe(false));
  });
});

describe("the real process runner: no shell, a whole-tree kill, close as the only proof", () => {
  const fakeNode = (script: string): string => {
    const dir = join(home, "real-node"); mkdirSync(join(dir, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "npm", "bin", "npm-cli.js"), script);
    const exe = join(dir, "node"); if (!existsSync(exe)) symlinkSync(process.execPath, exe); return exe;
  };
  it("the deadline stops an npm that never ends, confirms its close, and releases the lock", async () => {
    const exe = fakeNode("setInterval(() => {}, 1000);");
    const started = Date.now();
    await expect(installManagedCli("codex", { root: cliRoot, nodePath: exe, signerOf: signedByOpenAI, deadlineMs: 400, killWaitMs: 5000 })).rejects.toMatchObject({ reason: "timed-out" });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(existsSync(lockDir())).toBe(false); expect(existsSync(join(cliRoot, "codex", `${codex.version}.staging`))).toBe(false);
  }, 15_000);
  it("output past 512 KiB stops the child and is an install failure", async () => {
    const exe = fakeNode("process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);");
    await expect(installManagedCli("codex", { root: cliRoot, nodePath: exe, signerOf: signedByOpenAI, killWaitMs: 5000 })).rejects.toMatchObject({ reason: "install-failed", message: expect.stringMatching(/far larger/) });
    expect(existsSync(lockDir())).toBe(false);
  }, 15_000);
  it("a program that exits non-zero is an ordinary failure, and an aborted signal never starts one", async () => {
    const exe = fakeNode("process.exit(3);");
    await expect(installManagedCli("codex", { root: cliRoot, nodePath: exe, signerOf: signedByOpenAI })).rejects.toMatchObject({ reason: "install-failed" });
    const controller = new AbortController(); controller.abort();
    await expect(installManagedCli("codex", { root: cliRoot, nodePath: exe, signerOf: signedByOpenAI, signal: controller.signal })).rejects.toMatchObject({ reason: "cancelled" });
    expect(existsSync(lockDir())).toBe(false);
  }, 15_000);
});

// ---- on the real Runtime client: the update fence waits for an install that has not really ended
const hubs: RuntimeCoordinator[] = [], servers: Server[] = [], clients: RuntimeClient[] = [];
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-install-fence-")); roots.push(path); return path; };
async function fixture(extra: Partial<RuntimeClientOptions> = {}) {
  const hub = new RuntimeCoordinator(scratch()); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Fixture", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)!.pairingFingerprint);
  const identity = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret });
  if (identity.status !== "approved") throw Error("Fixture approval failed");
  const server = createServer(); servers.push(server);
  server.on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port, store = new RuntimeClientStore(scratch());
  store.saveCredentials({ server: `http://127.0.0.1:${port}`, name: "Fixture", machineId: identity.machineId, credential: identity.credential });
  const bridge: RuntimeBridge = { probe: vi.fn(async () => ({ home: "C:\\fixture", clis: [], probedAt: 1 })), prepareWorkspace: vi.fn(async () => "C:\\fixture"),
    start: vi.fn(() => { throw Error("No fixture run"); }), get: () => null, cancel: vi.fn(), close: vi.fn(), releaseUnknown: vi.fn(), idleForUpdate: () => true };
  let authenticated!: () => void; const welcomed = new Promise<void>(done => { authenticated = done; });
  const client = new RuntimeClient({ store, bridge, reconnectMs: 10, pollMs: 10, credentialProfilesRoot: credentialProfilesRoot(store.directory), credentialLogin: async () => false,
    ...extra, managedUpdate: { ...extra.managedUpdate, authenticated: () => authenticated() } });
  clients.push(client); await client.start(); await welcomed;
  const answers: any[] = [], realSend = (client as any).send.bind(client);
  vi.spyOn(client as any, "send").mockImplementation((frame: any) => { if (frame.type === "account.response") answers.push(frame); else realSend(frame); });
  const ask = async (operation: string, payload: unknown): Promise<any> => { const id = `acct-${randomUUID()}`; await (client as any).receive(JSON.stringify({ v: 1, type: "account.request", id, operation, payload })); return answers.find(frame => frame.id === id); };
  return { client, store, bridge, ask };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("an install that has not really ended keeps the Runtime busy, whatever the connection or the server does", () => {
  const installer = (install: (cli: string) => Promise<{ version: string }>) => ({ knows: () => true, install });
  it("answers the request, but idle() stays false and prepareUpdate is refused until the child ended; only then is the Runtime idle", async () => {
    let ended!: () => void; const closed = new Promise<void>(done => { ended = done; });
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installer(async () => { throw new CliInstallError("timed-out", "The install did not finish in time and was stopped", { ended: closed }); }) } });
    setRemoteSwitch(f.store.directory, "install", true);
    const answer = await f.ask("cli.install", { cli: "codex", actor: "admin:u1" });
    expect(answer.ok).toBe(false); expect(answer.error).toMatch(/did not finish in time/);
    expect((f.client as any).remoteAccounts.idle()).toBe(false); expect((f.client as any).locallyIdle()).toBe(false);
    expect(await f.client.prepareUpdate(randomUUID())).toBe(false); expect(f.bridge.close).not.toHaveBeenCalled(); expect(f.client.online()).toBe(true);
    // Another install is refused while it has not ended, with no call to the installer.
    const again = await f.ask("cli.install", { cli: "codex", actor: "admin:u1" }); expect(again.ok).toBe(false); expect(again.error).toMatch(/has not finished ending/);
    ended(); await vi.waitFor(() => expect((f.client as any).remoteAccounts.idle()).toBe(true));
    expect((f.client as any).locallyIdle()).toBe(true); expect(await f.client.prepareUpdate(randomUUID())).toBe(true);
  });
  it("a plain failure (every child confirmed ended) leaves the Runtime idle at once", async () => {
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installer(async () => { throw new CliInstallError("install-failed", "npm could not install the package"); }) } });
    setRemoteSwitch(f.store.directory, "install", true);
    const answer = await f.ask("cli.install", { cli: "codex", actor: "admin:u1" }); expect(answer.ok).toBe(false);
    expect((f.client as any).remoteAccounts.idle()).toBe(true); expect((f.client as any).locallyIdle()).toBe(true);
  });
  it("a connection that goes away while the install runs does not cancel it or release anything: only the child's end does", async () => {
    let ended!: () => void; const closed = new Promise<void>(done => { ended = done; });
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: installer(async () => { await gate; throw new CliInstallError("cancelled", "The install was cancelled", { ended: closed }); }) } });
    setRemoteSwitch(f.store.directory, "install", true);
    const asked = f.ask("cli.install", { cli: "codex", actor: "admin:u1" });
    await vi.waitFor(() => expect((f.client as any).remoteAccounts.idle()).toBe(false));
    (f.client as any).socket?.terminate();                                   // the connection is lost; the install is not told
    expect((f.client as any).remoteAccounts.idle()).toBe(false);
    release(); await asked;
    expect((f.client as any).remoteAccounts.idle()).toBe(false); expect(await f.client.prepareUpdate(randomUUID())).toBe(false);
    ended(); await vi.waitFor(() => expect((f.client as any).remoteAccounts.idle()).toBe(true));
  });
});
