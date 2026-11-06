/**
 * #3190 Part 3b, review of #3265: consent and connection at every effect, the shared lock's release, a private npm configuration, containment through held steps,
 * a fresh inventory when an install finishes, a bounded audit for repeated no-op installs, and a signer check that must end cleanly.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliInstallError, INSTALLABLE_CLIS, installEnvironment, installManagedCli, managedCliExecutable, managedInstaller, windowsSignerOf, type InstallDeps } from "../src/runtime-cli-install.js";
import { RUNTIME_INSTALL_LOCK, RuntimeInstallLockError, acquireRuntimeInstallLock } from "../src/runtime-update-lock.js";
import { probeCredentialProfileStatus } from "../src/windows-cli-worker.js";
import { createRuntimeProfile } from "../src/runtime-profile-ownership.js";
import { RuntimeClient, type RuntimeBridge, type RuntimeClientOptions } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { credentialProfilesRoot } from "../src/runtime-credential-profiles.js";
import { setRemoteSwitch } from "../src/runtime-remote-setup.js";

const hooks = vi.hoisted(() => ({ write: undefined as undefined | ((path: string) => void) }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, writeFileSync: ((path: unknown, ...rest: unknown[]) => { hooks.write?.(String(path)); return (fs.writeFileSync as (...args: unknown[]) => void)(path, ...rest); }) as typeof fs.writeFileSync };
});
const codex = INSTALLABLE_CLIS.codex;
const signedByOpenAI = async () => ({ status: "Valid", subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC"' });
const roots: string[] = [];
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-install-review-")); roots.push(path); return path; };
let home: string, node: string, cliRoot: string;
beforeEach(() => {
  home = scratch(); node = join(home, "nodejs", "node.exe"); mkdirSync(join(home, "nodejs", "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(join(home, "nodejs", "node_modules", "npm", "bin", "npm-cli.js"), ""); cliRoot = join(home, "cli");
});
const lockDir = (root = cliRoot): string => join(root, RUNTIME_INSTALL_LOCK);
const held = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

/** A fake npm that writes what a real install leaves. `hold(step)` runs before it answers, so a test can change things while a step is "running". */
function fakeNpm(options: { hold?: (step: "install" | "audit") => Promise<void> | void; calls?: string[] } = {}): NonNullable<InstallDeps["run"]> {
  return async (_file, args, { cwd }) => {
    const step = args[1] === "install" ? "install" : "audit";
    options.calls?.push(step);
    if (step === "install") {
      const packages = Object.fromEntries(Object.entries(codex.integrity).map(([path, integrity]) => [path, { integrity, version: codex.version }]));
      writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ packages }));
      const file = join(cwd, codex.native.path); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "MZ");
    }
    await options.hold?.(step);
    return { code: 0, stdout: "" };
  };
}

// ---- a real Runtime client with a real coordinator, an inert bridge, and the real installer on a fake npm
const hubs: RuntimeCoordinator[] = [], servers: Server[] = [], clients: RuntimeClient[] = [];
async function fixture(extra: Partial<RuntimeClientOptions> = {}, bridgeOverride: Partial<RuntimeBridge> = {}, options: { realAnswers?: boolean } = {}) {
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
    start: vi.fn(() => { throw Error("No fixture run"); }), get: () => null, cancel: vi.fn(), close: vi.fn(), releaseUnknown: vi.fn(), idleForUpdate: () => true, ...bridgeOverride };
  const welcomed = held<void>();
  const client = new RuntimeClient({ store, bridge, reconnectMs: 10, pollMs: 10, credentialProfilesRoot: credentialProfilesRoot(store.directory), credentialLogin: async () => false,
    ...extra, managedUpdate: { ...extra.managedUpdate, authenticated: () => welcomed.resolve() } });
  clients.push(client); await client.start(); await welcomed.promise;
  await vi.waitFor(() => expect(hub.machine(identity.machineId)?.status).toBe("online"));
  const answers: any[] = [], sent: any[] = [], realSend = (client as any).send.bind(client);
  vi.spyOn(client as any, "send").mockImplementation((frame: any) => { if (frame.type === "account.response" && !options.realAnswers) answers.push(frame); else { if (frame.type !== "account.response") sent.push(frame); realSend(frame); } });
  const ask = async (operation: string, payload: unknown): Promise<any> => { const id = `acct-${randomUUID()}`; await (client as any).receive(JSON.stringify({ v: 1, type: "account.request", id, operation, payload })); return answers.find(frame => frame.id === id); };
  const audit = (): any[] => { try { return readFileSync(join(store.directory, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { hub, client, store, bridge, ask, audit, sent, machineId: identity.machineId };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const asked = { cli: "codex", actor: "admin:u1" };

describe("P1: the local switch and the connection are looked at again at every effect of an install", () => {
  type Step = "install" | "audit" | "signer";
  const next: Record<Step, Step[]> = { install: ["audit", "signer"], audit: ["signer"], signer: [] };       // what must NOT start after the change (the swap writes current.json: checked by `done`)
  const changes: Record<string, (f: Awaited<ReturnType<typeof fixture>>, skew: { ms: number }) => void> = {
    "the switch is turned off": f => setRemoteSwitch(f.store.directory, "install", false),
    "the switch's time runs out": (_f, skew) => { skew.ms = 61_000; },
    "the connection is replaced": f => { (f.client as any).socket.terminate(); },
  };
  async function heldInstall(step: Step, change: string | null) {
    const calls: string[] = [], gate = held<void>(), reached = held<void>(), skew = { ms: 0 };
    const holdAt = async (at: Step): Promise<void> => { calls.push(at); if (at === step) { reached.resolve(); await gate.promise; } };
    const installer = managedInstaller({ root: cliRoot, nodePath: node, run: fakeNpm({ hold: s => holdAt(s) }), signerOf: async () => { await holdAt("signer"); return signedByOpenAI(); } });
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer, now: () => Date.now() + skew.ms } });
    setRemoteSwitch(f.store.directory, "install", true, 60_000);
    const answer = f.ask("cli.install", asked);
    await reached.promise;
    if (change) changes[change](f, skew);
    gate.resolve();
    const reply = await answer;
    const done = existsSync(join(cliRoot, "codex", "current.json"));
    return { f, calls, reply, done, installer };
  }
  for (const step of ["install", "audit", "signer"] as Step[]) {
    for (const change of Object.keys(changes)) {
      it(`${change} while ${step === "signer" ? "the publisher check" : `npm ${step}`} is running: nothing new starts, and current.json is never written`, async () => {
        const { f, calls, done, reply } = await heldInstall(step, change);
        for (const later of next[step]) expect(calls).not.toContain(later);
        expect(done).toBe(false); expect(existsSync(join(cliRoot, "codex", codex.version))).toBe(false); expect(existsSync(join(cliRoot, "codex", `${codex.version}.staging`))).toBe(false);
        const lines = f.audit().filter(line => line.action === "cli.install");
        expect(lines.map(line => line.outcome)).toEqual(["started", "refused"]);
        if (change !== "the connection is replaced") { expect(reply.ok).toBe(false); expect(reply.error).toMatch(change === "the switch is turned off" ? /turned off|install/ : /turned off|install/); }
        expect(lines[1].reason).toMatch(/switch_off|failed/);
        expect(existsSync(lockDir())).toBe(false);                      // given back: nothing is running any more
      });
    }
    it(`control: nothing changed while ${step === "signer" ? "the publisher check" : `npm ${step}`} is running, and the install completes`, async () => {
      const { f, calls, reply, done } = await heldInstall(step, null);
      expect(reply.ok).toBe(true); expect(reply.result).toEqual({ version: codex.version }); expect(done).toBe(true);
      expect(calls).toEqual(["install", "audit", "signer"]);
      expect(f.audit().filter(line => line.action === "cli.install").map(line => line.outcome)).toEqual(["started", "ok"]);
    });
  }
  it("a switch turned off just before the folder swap is also caught in the swap's own step (the signer is the last await)", async () => {
    const { calls, done } = await heldInstall("signer", "the switch is turned off");
    expect(calls).toEqual(["install", "audit", "signer"]); expect(done).toBe(false);
  });
  it("the Runtime's own refusal keeps its words: the caller sees the switch sentence, not a generic install failure", async () => {
    const { reply } = await heldInstall("audit", "the switch is turned off");
    expect(reply.error).toMatch(/"install" turned off/); expect(reply.error).not.toMatch(/could not be completed/);
  });
});

describe("P2: the lock is shared by every installer on the install root, and a release that fails is kept and retried", () => {
  it("two independent installers on one install root exclude each other, and a supervisor's lease excludes them both", async () => {
    const installRoot = join(home, "agend-runtime"); mkdirSync(installRoot, { mode: 0o700 }); chmodSync(installRoot, 0o700);
    const gate = held<void>(), reached = held<void>();
    const a = managedInstaller({ root: join(home, "pairing-a", "cli"), nodePath: node, installRoot, run: fakeNpm({ hold: async step => { if (step === "audit") { reached.resolve(); await gate.promise; } } }), signerOf: signedByOpenAI });
    const b = managedInstaller({ root: join(home, "pairing-b", "cli"), nodePath: node, installRoot, run: fakeNpm(), signerOf: signedByOpenAI });
    const first = a.install("codex"); await reached.promise;
    expect(a.running()).toBe(true); expect(b.running()).toBe(false);
    await expect(b.install("codex")).rejects.toMatchObject({ reason: "busy" });
    gate.resolve(); expect((await first).version).toBe(codex.version);
    expect((await b.install("codex")).version).toBe(codex.version);
    expect(existsSync(lockDir(installRoot))).toBe(false);
  });
  it("a release that fails keeps the lease and the busy state, is retried, and is never reported as released", async () => {
    const calls: string[] = [];
    const installer = managedInstaller({ root: cliRoot, nodePath: node, releaseRetryMs: 20, run: fakeNpm({ calls, hold: step => { if (step === "audit") writeFileSync(join(lockDir(), "stuck"), "x"); } }), signerOf: signedByOpenAI });
    const result = await installer.install("codex");
    expect(result.version).toBe(codex.version); expect(result.ended).toBeInstanceOf(Promise);
    expect(existsSync(join(lockDir(), "owner.json"))).toBe(true);        // the lease is kept
    expect(installer.running()).toBe(true);
    await expect(installer.install("claude-code")).rejects.toMatchObject({ reason: "busy" });     // another CLI: the one that is already installed would be a no-op
    await new Promise(done => setTimeout(done, 80)); expect(existsSync(join(lockDir(), "owner.json"))).toBe(true);   // still kept while the obstacle is there
    rmSync(join(lockDir(), "stuck")); await result.ended;
    expect(existsSync(lockDir())).toBe(false); await vi.waitFor(() => expect(installer.running()).toBe(false));
  });
  it("through the Runtime: an install whose lock could not be given back keeps idle() false and holds the update fence until it is", async () => {
    const installer = managedInstaller({ root: cliRoot, nodePath: node, releaseRetryMs: 20, run: fakeNpm({ hold: step => { if (step === "audit") writeFileSync(join(lockDir(), "stuck"), "x"); } }), signerOf: signedByOpenAI });
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer } });
    setRemoteSwitch(f.store.directory, "install", true);
    const reply = await f.ask("cli.install", asked); expect(reply.ok).toBe(true);
    expect((f.client as any).remoteAccounts.idle()).toBe(false); expect(await f.client.prepareUpdate(randomUUID())).toBe(false);
    rmSync(join(lockDir(), "stuck"));
    await vi.waitFor(() => expect((f.client as any).remoteAccounts.idle()).toBe(true));
    expect(await f.client.prepareUpdate(randomUUID())).toBe(true);
  });
});

describe("P3: npm reads no user or global configuration and installs locally", () => {
  const realNpm = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  it("is given one controlled .npmrc, in the environment and on the command line, and the file is not left in the installed folder", async () => {
    const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run: NonNullable<InstallDeps["run"]> = async (file, args, options) => { seen.push({ args, env: options.env }); return fakeNpm()(file, args, options); };
    await installManagedCli("codex", { root: cliRoot, nodePath: node, run, signerOf: signedByOpenAI, env: { PATH: "p", NPM_CONFIG_PREFIX: "/outside", npm_config_global: "true", npm_config_userconfig: "/evil/.npmrc" } });
    expect(seen).toHaveLength(2);
    const staging = join(cliRoot, "codex", `${codex.version}.staging`), user = join(staging, "agend-user.npmrc"), global = join(staging, "agend-global.npmrc");
    for (const { args, env } of seen) {
      expect(env).toMatchObject({ npm_config_userconfig: user, npm_config_globalconfig: global, npm_config_global: "false", npm_config_prefix: staging, npm_config_registry: "https://registry.npmjs.org/", npm_config_ignore_scripts: "true" });
      expect(Object.keys(env).filter(key => /^NPM_CONFIG_/.test(key))).toEqual([]);
      expect(args).toEqual(expect.arrayContaining(["--userconfig", user, "--globalconfig", global, "--global=false", "--prefix", staging, "--registry", "https://registry.npmjs.org/"]));
    }
    expect(existsSync(join(cliRoot, "codex", codex.version, "agend-user.npmrc"))).toBe(false); expect(existsSync(join(cliRoot, "codex", codex.version, "agend-global.npmrc"))).toBe(false);
  });
  it.skipIf(!existsSync(realNpm))("with the real npm and a hostile user .npmrc (global, an outside prefix, a scoped registry, a token), the answers are still local, private and the real registry", () => {
    const userHome = scratch(), outside = join(userHome, "outside-prefix"), staging = join(userHome, "staging"); mkdirSync(staging, { recursive: true }); mkdirSync(outside);
    writeFileSync(join(userHome, ".npmrc"), `global=true\nprefix=${outside}\n@openai:registry=https://evil.example/\n//registry.npmjs.org/:_authToken=secret-token\nregistry=https://evil.example/\n`);
    const text = "global=false\nregistry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\nupdate-notifier=false\n";
    const config = { user: join(staging, "agend-user.npmrc"), global: join(staging, "agend-global.npmrc") }; writeFileSync(config.user, text); writeFileSync(config.global, text);
    const local = (args: string[]) => [...args, "--userconfig", config.user, "--globalconfig", config.global, "--global=false", "--prefix", staging, "--registry", "https://registry.npmjs.org/"];
    const env = { ...installEnvironment({ PATH: process.env.PATH }, join(userHome, "cache"), config, staging), HOME: userHome, USERPROFILE: userHome, APPDATA: userHome };
    const get = (key: string): string => spawnSync(process.execPath, [realNpm, ...local(["config", "get", key])], { cwd: staging, env, encoding: "utf8" }).stdout.trim();
    // Control: the same hostile file, with no isolation, really is read by this npm (so the test can tell the difference).
    const bare = spawnSync(process.execPath, [realNpm, "config", "get", "global"], { cwd: staging, env: { PATH: process.env.PATH, HOME: userHome, USERPROFILE: userHome }, encoding: "utf8" }).stdout.trim();
    expect(bare).toBe("true");
    expect(get("global")).toBe("false"); expect(get("prefix")).toBe(staging); expect(get("registry")).toBe("https://registry.npmjs.org/");
    expect(get("@openai:registry")).not.toBe("https://evil.example/");
    const list = spawnSync(process.execPath, [realNpm, ...local(["config", "list", "-l"])], { cwd: staging, env, encoding: "utf8" }).stdout;
    expect(list).not.toContain("secret-token"); expect(list).not.toContain("evil.example"); expect(list).not.toContain(outside);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("P4: containment holds for the lookup and through every held step", () => {
  const installed = (root: string): void => { const file = join(root, "codex", codex.version, codex.native.path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "MZ"); writeFileSync(join(root, "codex", "current.json"), JSON.stringify({ version: codex.version })); };
  it("a CLI root that is itself a link is never selected, whatever it holds", () => {
    const real = join(home, "elsewhere"); installed(real);
    expect(managedCliExecutable(real, "codex")).not.toBeNull();       // control: the same tree, reached by its own name
    symlinkSync(real, cliRoot, "dir");
    expect(managedCliExecutable(cliRoot, "codex")).toBeNull();
  });
  it("a link in the middle of the way is not selected either (the id folder, the version folder)", () => {
    const real = join(home, "elsewhere"); installed(real); mkdirSync(cliRoot);
    symlinkSync(join(real, "codex"), join(cliRoot, "codex"), "dir");
    expect(managedCliExecutable(cliRoot, "codex")).toBeNull();
  });
  const swaps: Record<string, (canary: string) => void> = {
    "the CLI root": canary => { renameSync(cliRoot, `${cliRoot}.moved`); symlinkSync(canary, cliRoot, "dir"); },
    "the id folder": canary => { renameSync(join(cliRoot, "codex"), join(cliRoot, "codex.moved")); symlinkSync(canary, join(cliRoot, "codex"), "dir"); },
    "the staging folder": canary => { const staging = join(cliRoot, "codex", `${codex.version}.staging`); renameSync(staging, `${staging}.moved`); symlinkSync(canary, staging, "dir"); },
  };
  for (const [name, swap] of Object.entries(swaps)) {
    for (const step of ["install", "audit", "signer"] as const) {
      it(`${name} replaced by a link to an outside folder while ${step === "signer" ? "the publisher check" : `npm ${step}`} is held: the install stops and the outside folder is untouched`, async () => {
        const canary = join(home, "canary"); mkdirSync(canary); writeFileSync(join(canary, "keep.txt"), "keep"); mkdirSync(join(canary, "0.165.0.staging"), { recursive: true }); writeFileSync(join(canary, "0.165.0.staging", "keep2.txt"), "keep2");
        const before = readdirSync(canary).sort().join();
        let swapped = false; const doSwap = (): void => { if (!swapped) { swapped = true; swap(canary); } };
        const error = await installManagedCli("codex", { root: cliRoot, nodePath: node, installRoot: join(home, "lock-root-ok"), ...(mkdirSync(join(home, "lock-root-ok"), { mode: 0o700 }), {}),
          run: fakeNpm({ hold: s => { if (s === step) doSwap(); } }), signerOf: async () => { if (step === "signer") doSwap(); return signedByOpenAI(); } }).catch((e: unknown) => e) as CliInstallError;
        expect(error).toBeInstanceOf(CliInstallError); expect(error.reason).toBe("install-failed"); expect(error.message).toMatch(/CLI folder was changed during the install/);
        expect(readdirSync(canary).sort().join()).toBe(before);
        expect(readFileSync(join(canary, "keep.txt"), "utf8")).toBe("keep"); expect(readFileSync(join(canary, "0.165.0.staging", "keep2.txt"), "utf8")).toBe("keep2");
        expect(existsSync(join(canary, "current.json"))).toBe(false); expect(existsSync(join(canary, "codex"))).toBe(false);
        expect(lstatSync(name === "the CLI root" ? cliRoot : join(cliRoot, "codex")).isSymbolicLink() || name === "the staging folder").toBe(true);   // the planted link is left alone
      });
    }
  }
  it("control: nothing replaced, the same held steps finish and the program is the one under the CLI root", async () => {
    mkdirSync(join(home, "lock-root-ok"), { mode: 0o700 });
    const result = await installManagedCli("codex", { root: cliRoot, nodePath: node, installRoot: join(home, "lock-root-ok"), run: fakeNpm({ hold: () => {} }), signerOf: signedByOpenAI });
    expect(managedCliExecutable(cliRoot, "codex")?.command).toBe(result.command);
  });
});

describe("P5: a finished install publishes a fresh inventory, with no Detect again", () => {
  it("the coordinator's inventory shows the installed CLI when the install call returns, though the Runtime's cached probe still says the old one", async () => {
    let installedNow = false; const probes: Array<boolean | undefined> = [];
    const clis = (version: string) => [{ id: "codex", path: "C:\\x\\codex.exe", version, authenticated: true, runnable: true, readOnlySupport: true, supports: { execution: true, resume: true, model: true, mcp: true }, permissionNote: "fixture", models: [] }];
    const probe = vi.fn(async (options?: { force?: boolean }) => { probes.push(options?.force); return { home: "C:\\fixture", clis: (options?.force && installedNow ? clis("codex-cli 0.165.0") : clis("codex-cli 0.161.0")) as any, probedAt: 1_793_000_000_000 + probes.length }; });
    const installer = { knows: () => true, install: async () => { installedNow = true; return { version: codex.version }; } };
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer } }, { probe }, { realAnswers: true });
    setRemoteSwitch(f.store.directory, "install", true);
    await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.inventory?.clis[0]?.version).toBe("codex-cli 0.161.0"));
    expect(await f.hub.callAccount(f.machineId, "cli.install", asked)).toEqual({ version: codex.version });
    expect(f.hub.machine(f.machineId)?.inventory?.clis[0]?.version).toBe("codex-cli 0.165.0");      // no further probe or click
    expect(probes).toContain(true);
  });
  it("a detection that fails does not undo a finished install: the call still answers with the version", async () => {
    let fail = false;
    const probe = vi.fn(async () => { if (fail) throw new Error("boom"); return { home: "C:\\fixture", clis: [], probedAt: 1 }; });
    const installer = { knows: () => true, install: async () => { fail = true; return { version: codex.version }; } };
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer } }, { probe });
    setRemoteSwitch(f.store.directory, "install", true);
    expect((await f.ask("cli.install", asked)).result).toEqual({ version: codex.version });
  });
});

describe("P6: repeated installs of what is already installed cannot flood the audit log", () => {
  it("50 requests for a CLI that is at its version add one folded refusal, never a started/ok pair each, and the earlier lines are kept", async () => {
    const install = vi.fn(async () => ({ version: codex.version }));
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer: { knows: () => true, installed: () => true, install } } });
    setRemoteSwitch(f.store.directory, "install", true);
    const before = f.audit().length;
    const answers = [];
    for (let i = 0; i < 50; i++) answers.push(await f.ask("cli.install", asked));
    expect(answers.every(answer => answer.ok === false && /already installed/.test(answer.error))).toBe(true);
    expect(install).not.toHaveBeenCalled();
    const lines = f.audit().slice(before).filter(line => line.action === "cli.install");
    expect(lines.map(line => line.outcome)).toEqual(["refused"]); expect(lines[0].reason).toBe("rate_limited");
    expect(f.audit().slice(0, before)).toEqual(f.audit().slice(0, before));        // what was there is still there
  });
  it("an install that is not there is tried, and the same CLI asked again within the pace is refused (a failing request cannot loop either)", async () => {
    const install = vi.fn(async () => { throw new CliInstallError("install-failed", "npm could not install the package"); });
    let clock = Date.now();
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), now: () => clock, installer: { knows: () => true, installed: () => false, install } } });
    setRemoteSwitch(f.store.directory, "install", true);
    expect((await f.ask("cli.install", asked)).error).toMatch(/npm could not install/);
    for (let i = 0; i < 10; i++) expect((await f.ask("cli.install", asked)).error).toMatch(/just tried/);
    expect(install).toHaveBeenCalledTimes(1);
    clock += 6_000; expect((await f.ask("cli.install", asked)).error).toMatch(/npm could not install/); expect(install).toHaveBeenCalledTimes(2);
    expect(f.audit().filter(line => line.action === "cli.install" && line.outcome === "started")).toHaveLength(2);
  });
  it("managedInstaller.installed is true only for the pinned version that is really there", () => {
    const installer = managedInstaller({ root: cliRoot, nodePath: node });
    expect(installer.installed("codex")).toBe(false); expect(installer.installed("grok")).toBe(false);
    const file = join(cliRoot, "codex", codex.version, codex.native.path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "MZ"); writeFileSync(join(cliRoot, "codex", "current.json"), JSON.stringify({ version: codex.version }));
    expect(installer.installed("codex")).toBe(true);
    writeFileSync(join(cliRoot, "codex", "current.json"), JSON.stringify({ version: "0.0.1" })); expect(installer.installed("codex")).toBe(false);
  });
});

describe("P7: the publisher check must end cleanly before its answer is read", () => {
  const printed = 'Valid|CN="Anthropic, PBC", O="Anthropic, PBC"';
  it("a verifier that exited non-zero, has no exit code, or went over its output limit says nothing, whatever it printed", async () => {
    for (const result of [{ code: 1, stdout: printed }, { code: null, stdout: printed }, { code: 0, stdout: printed, overflow: true }, { code: 2, stdout: printed, overflow: true }]) {
      expect(await windowsSignerOf("C:\\x\\claude.exe", async () => result)).toEqual({ status: "Error", subject: "" });
    }
    expect(await windowsSignerOf("C:\\x\\claude.exe", async () => ({ code: 0, stdout: printed }))).toEqual({ status: "Valid", subject: 'CN="Anthropic, PBC", O="Anthropic, PBC"' });
  });
  it("the install refuses as publisher-mismatch when the verifier failed but printed a valid-looking line, and nothing is switched", async () => {
    const cli = INSTALLABLE_CLIS["claude-code"];
    for (const verdict of [{ code: 1, stdout: printed }, { code: null, stdout: printed }, { code: 0, stdout: printed, overflow: true }]) {
      rmSync(cliRoot, { recursive: true, force: true });
      const run: NonNullable<InstallDeps["run"]> = async (file, args, options) => {
        if (args.includes("-Command")) return verdict;
        const packages = Object.fromEntries(Object.entries(cli.integrity).map(([path, integrity]) => [path, { integrity, version: cli.version }]));
        if (args[1] === "install") { writeFileSync(join(options.cwd, "package-lock.json"), JSON.stringify({ packages })); const f = join(options.cwd, cli.native.path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, "MZ"); }
        return { code: 0, stdout: "" };
      };
      await expect(installManagedCli("claude-code", { root: cliRoot, nodePath: node, run })).rejects.toMatchObject({ reason: "publisher-mismatch" });
      expect(existsSync(join(cliRoot, "claude-code", "current.json"))).toBe(false);
    }
  });
});

describe("P2-1 (follow-up): the folders are looked at before the wait for the lock and again straight after it, before anything is written", () => {
  const ownProof = { pid: process.pid, birth: "638980000000000000", boot: "a".repeat(64) };
  /** An observer that stops the lock's acquisition (its first await) until the test lets it go, and says when it got there. */
  const pausedLock = () => { const gate = held<void>(), reached = held<void>(); return { reached, gate, lockOptions: { observe: async (pid: number) => { reached.resolve(); await gate.promise; return pid === process.pid ? { state: "alive" as const, proof: ownProof } : { state: "gone" as const }; } } }; };
  const canaryFolder = (): string => { const canary = join(home, "canary"); mkdirSync(canary); writeFileSync(join(canary, "keep.txt"), "keep"); return canary; };
  const run = async (change: ((canary: string) => void) | null, extra: Partial<InstallDeps> = {}) => {
    const canary = canaryFolder(), installRoot = join(home, "agend-runtime"); mkdirSync(installRoot, { mode: 0o700 }); chmodSync(installRoot, 0o700);
    const lock = pausedLock();
    const install = installManagedCli("codex", { root: cliRoot, nodePath: node, installRoot, run: fakeNpm(), signerOf: signedByOpenAI, lockOptions: lock.lockOptions, ...extra }).then(value => value as unknown, (error: unknown) => error);
    await lock.reached.promise;
    change?.(canary); lock.gate.resolve();
    return { outcome: await install, canary, installRoot };
  };
  const refused = (outcome: unknown): void => { expect(outcome).toBeInstanceOf(CliInstallError); expect((outcome as CliInstallError).reason).toBe("install-failed"); expect((outcome as CliInstallError).message).toMatch(/CLI folder was changed during the install/); };
  it("the CLI root replaced by a link to an outside folder while the lock is awaited: refused, and nothing is created in the outside folder", async () => {
    const { outcome, canary, installRoot } = await run(c => { renameSync(cliRoot, `${cliRoot}.moved`); symlinkSync(c, cliRoot, "dir"); });
    refused(outcome); expect(readdirSync(canary)).toEqual(["keep.txt"]); expect(existsSync(lockDir(installRoot))).toBe(false);
  });
  it("an id folder that existed, replaced by a link to an outside folder while the lock is awaited: refused, the outside folder untouched", async () => {
    mkdirSync(join(cliRoot, "codex"), { recursive: true });
    const { outcome, canary } = await run(c => { renameSync(join(cliRoot, "codex"), join(cliRoot, "codex.moved")); symlinkSync(c, join(cliRoot, "codex"), "dir"); });
    refused(outcome); expect(readdirSync(canary)).toEqual(["keep.txt"]);
  });
  it("an id folder that did not exist and appeared while the lock was awaited is not adopted: refused, and what appeared is left alone", async () => {
    mkdirSync(cliRoot, { recursive: true });
    const { outcome } = await run(() => { mkdirSync(join(cliRoot, "codex")); writeFileSync(join(cliRoot, "codex", "planted.txt"), "x"); });
    refused(outcome); expect(readdirSync(join(cliRoot, "codex"))).toEqual(["planted.txt"]);
  });
  it("the CLI root replaced by ANOTHER plain folder at the same path is refused too (a different folder is not taken as the baseline), and gets nothing written", async () => {
    const { outcome } = await run(() => { renameSync(cliRoot, `${cliRoot}.moved`); mkdirSync(cliRoot); });
    refused(outcome); expect(readdirSync(cliRoot)).toEqual([]);
  });
  it("an existing id folder replaced by another plain folder is refused as well", async () => {
    mkdirSync(join(cliRoot, "codex"), { recursive: true });
    const { outcome } = await run(() => { renameSync(join(cliRoot, "codex"), join(cliRoot, "codex.moved")); mkdirSync(join(cliRoot, "codex")); });
    refused(outcome); expect(readdirSync(join(cliRoot, "codex"))).toEqual([]);
  });
  it("control: nothing replaced while the lock is awaited, and the install completes", async () => {
    const { outcome, installRoot } = await run(null);
    expect((outcome as { version: string }).version).toBe(codex.version); expect(existsSync(lockDir(installRoot))).toBe(false);
    expect(managedCliExecutable(cliRoot, "codex")).not.toBeNull();
  });
});

describe("P2-2 (follow-up): a lock that cannot be looked at, or a marker that fails to be written, is never taken for released", () => {
  const notRoot = process.getuid?.() !== 0;
  it.skipIf(!notRoot)("an owner record that cannot be read at release (a passing I/O or permission failure) keeps the lease, the busy state and the update fence until it can be", async () => {
    const owner = (): string => join(lockDir(), "owner.json");
    const installer = managedInstaller({ root: cliRoot, nodePath: node, releaseRetryMs: 20, run: fakeNpm(), signerOf: signedByOpenAI,
      rename: (from, to) => { renameSync(from, to); if (to.endsWith("current.json")) chmodSync(owner(), 0); } });
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer } });
    setRemoteSwitch(f.store.directory, "install", true);
    const reply = await f.ask("cli.install", asked); expect(reply.ok).toBe(true);
    await new Promise(done => setTimeout(done, 100));                                // several retries go by while it is unreadable
    expect(existsSync(lockDir())).toBe(true); expect(existsSync(join(lockDir(), "inflight"))).toBe(true);     // not treated as released: nothing was unlinked
    expect(installer.running()).toBe(true); expect((f.client as any).remoteAccounts.idle()).toBe(false); expect((f.client as any).locallyIdle()).toBe(false);
    expect(await f.client.prepareUpdate(randomUUID())).toBe(false);
    chmodSync(owner(), 0o600);
    await vi.waitFor(() => expect(existsSync(lockDir())).toBe(false));
    await vi.waitFor(() => expect((f.client as any).remoteAccounts.idle()).toBe(true)); expect(installer.running()).toBe(false);
    expect((f.client as any).locallyIdle()).toBe(true); expect(await f.client.prepareUpdate(randomUUID())).toBe(true);
  });
  it("only positive evidence ends the wait without a release: another owner's record, or the lock folder gone with its root present", async () => {
    for (const how of ["another owner", "folder gone"] as const) {
      rmSync(cliRoot, { recursive: true, force: true });
      const result = await installManagedCli("codex", { root: cliRoot, nodePath: node, releaseRetryMs: 20, run: fakeNpm(), signerOf: signedByOpenAI,
        rename: (from, to) => { renameSync(from, to); if (to.endsWith("current.json")) { if (how === "another owner") writeFileSync(join(lockDir(), "owner.json"), JSON.stringify({ version: 1, type: "installer", nonce: randomUUID(), pid: process.pid, birth: "1".repeat(18), boot: "e".repeat(64) })); else rmSync(lockDir(), { recursive: true, force: true }); } } });
      expect(result.version).toBe(codex.version); expect(result.ended).toBeUndefined();     // nothing left to give back: no wait
    }
  });
  it("an unreadable (malformed) owner record is NOT evidence: the wait goes on", async () => {
    const result = await installManagedCli("codex", { root: cliRoot, nodePath: node, releaseRetryMs: 20, run: fakeNpm(), signerOf: signedByOpenAI,
      rename: (from, to) => { renameSync(from, to); if (to.endsWith("current.json")) writeFileSync(join(lockDir(), "owner.json"), "{ not json"); } });
    expect(result.ended).toBeInstanceOf(Promise);
    let done = false; void result.ended!.then(() => { done = true; });
    await new Promise(wait => setTimeout(wait, 100)); expect(done).toBe(false);
    rmSync(lockDir(), { recursive: true, force: true });            // an operator clears it: now the root is there and the folder is gone
    await vi.waitFor(() => expect(done).toBe(true));
  });
  it("a marker that fails to be written (even one that landed half-way) throws with `ended`, keeps the lock while it cannot be released, and clears everything once it can", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    hooks.write = path => {
      if (!path.endsWith("inflight")) return;
      hooks.write = undefined;
      fs.writeFileSync(path, "partial"); fs.writeFileSync(join(lockDir(), "stuck"), "x");      // the marker is on disk, and the first release cannot work
      throw new Error("disk full");
    };
    const error = await installManagedCli("codex", { root: cliRoot, nodePath: node, releaseRetryMs: 20, run: fakeNpm(), signerOf: signedByOpenAI }).catch((e: unknown) => e) as CliInstallError;
    expect(error).toBeInstanceOf(CliInstallError); expect(error.reason).toBe("install-failed"); expect(error.message).toBe("This computer could not lock its Runtime install folder, so nothing was installed");
    expect(error.ended).toBeInstanceOf(Promise);
    expect(existsSync(join(lockDir(), "owner.json"))).toBe(true); expect(existsSync(join(cliRoot, "codex"))).toBe(false);
    rmSync(join(lockDir(), "stuck")); await error.ended;
    expect(existsSync(lockDir())).toBe(false);
    expect((await installManagedCli("codex", { root: cliRoot, nodePath: node, run: fakeNpm(), signerOf: signedByOpenAI })).version).toBe(codex.version);
  });
  it("a marker that fails to be written but whose lock releases at once has no `ended` to wait for", async () => {
    hooks.write = path => { if (path.endsWith("inflight")) { hooks.write = undefined; throw new Error("disk full"); } };
    const error = await installManagedCli("codex", { root: cliRoot, nodePath: node, run: fakeNpm(), signerOf: signedByOpenAI }).catch((e: unknown) => e) as CliInstallError;
    expect(error).toBeInstanceOf(CliInstallError); expect(error.ended).toBeUndefined(); expect(existsSync(lockDir())).toBe(false);
  });
});

describe("P2-3 (follow-up): the detection that follows an install is asked about consent and the connection at each of its steps", () => {
  type F = Awaited<ReturnType<typeof fixture>>;
  const makeProfiles = (f: F, names: string[]): string => { const root = credentialProfilesRoot(f.store.directory); for (const name of names) createRuntimeProfile(root, "claude-code", name); return root; };
  const clis = (version: string) => [{ id: "codex", path: "C:\\x\\codex.exe", version, authenticated: true, runnable: true, readOnlySupport: true, supports: { execution: true, resume: true, model: true, mcp: true }, permissionNote: "fixture", models: [] }];
  const changes: Record<string, (f: F, skew: { ms: number }) => void> = {
    "the switch is turned off": f => setRemoteSwitch(f.store.directory, "install", false),
    "the switch's time runs out": (_f, skew) => { skew.ms = 61_000; },
    "the connection is replaced": f => { (f.client as any).socket.terminate(); },
  };
  /** Holds either the bridge's forced probe or the first profile's status; `change` happens while it is held. */
  async function after(holdAt: "probe" | "status", change: string | null) {
    const gate = held<void>(), reached = held<void>(), skew = { ms: 0 };
    let installedNow = false;
    const probe = vi.fn(async (options?: { force?: boolean }) => {
      if (options?.force && holdAt === "probe") { reached.resolve(); await gate.promise; }
      return { home: "C:\\fixture", clis: clis(options?.force && installedNow ? "codex-cli 0.165.0" : "codex-cli 0.161.0") as any, probedAt: 1_793_000_000_000 };
    });
    const credentialStatus = vi.fn(async () => { if (holdAt === "status" && credentialStatus.mock.calls.length === 1) { reached.resolve(); await gate.promise; } return { loggedIn: true as boolean | null }; });
    const installer = { knows: () => true, install: async () => { installedNow = true; return { version: codex.version }; } };
    const f = await fixture({ credentialStatus, remoteAccounts: { find: async () => null, environment: () => ({}), installer, now: () => Date.now() + skew.ms } }, { probe });
    const root = makeProfiles(f, ["alpha", "beta"]);
    setRemoteSwitch(f.store.directory, "install", true, 60_000);
    const fresh = (): number => f.sent.filter(frame => frame.type === "inventory" && frame.inventory?.clis?.[0]?.version === "codex-cli 0.165.0").length;     // the forced detection's own report (the cached re-report of an ordinary change shows the old version)
    const before = { frames: fresh(), status: credentialStatus.mock.calls.length };
    const asked2 = f.ask("cli.install", asked);
    await reached.promise;
    if (change) changes[change](f, skew);
    gate.resolve();
    const reply = await asked2;
    await new Promise(done => setTimeout(done, 50));
    return { f, root, probe, credentialStatus, reply, before, inventoryFrames: fresh() - before.frames, statusCalls: credentialStatus.mock.calls.length - before.status };
  }
  for (const holdAt of ["probe", "status"] as const) {
    for (const change of Object.keys(changes)) {
      it(`${change} while the detection's ${holdAt === "probe" ? "CLI probe" : "first profile status"} is held: the install is still answered, and no further probe, status or inventory follows`, async () => {
        const { f, root, reply, inventoryFrames, statusCalls } = await after(holdAt, change);
        if (change !== "the connection is replaced") expect(reply.result).toEqual({ version: codex.version });
        else expect(f.audit().filter(line => line.action === "cli.install").map(line => line.outcome)).toEqual(["started", "ok"]);      // done, though the answer had nowhere to go
        expect(inventoryFrames).toBe(0);
        expect(statusCalls).toBe(holdAt === "probe" ? 0 : 1);                                  // the profile that was already running is the only one; the next never starts
        const cache = (() => { try { return readFileSync(join(root, "status.json"), "utf8"); } catch { return ""; } })();
        expect(cache).not.toContain("beta");                                                    // and nothing is written for a profile after consent was withdrawn
        if (holdAt === "status") expect(cache).not.toContain("alpha");                          // not even for the one whose answer arrived after
      });
    }
    it(`control: consent unchanged while the detection's ${holdAt === "probe" ? "CLI probe" : "first profile status"} is held: it runs to the end and sends the new inventory`, async () => {
      const { f, reply, credentialStatus, inventoryFrames } = await after(holdAt, null);
      expect(reply.result).toEqual({ version: codex.version });
      expect(credentialStatus).toHaveBeenCalledTimes(2); expect(inventoryFrames).toBeGreaterThanOrEqual(1);
      const last = f.sent.filter(frame => frame.type === "inventory").at(-1);
      expect(last.inventory.clis[0].version).toBe("codex-cli 0.165.0");
    });
  }
  it("consent already gone when the install ends: the detection does not even start, and the install is answered", async () => {
    const probe = vi.fn(async () => ({ home: "C:\\fixture", clis: [], probedAt: 1 }));
    const gate = held<void>();
    const installer = { knows: () => true, install: async () => { setRemoteSwitch(dirOf(f), "install", false); gate.resolve(); return { version: codex.version }; } };
    const dirOf = (x: F): string => x.store.directory;
    const f = await fixture({ remoteAccounts: { find: async () => null, environment: () => ({}), installer } }, { probe });
    setRemoteSwitch(f.store.directory, "install", true);
    const forced = (): number => (probe.mock.calls as unknown as Array<[{ force?: boolean } | undefined]>).filter(([options]) => options?.force).length;
    expect((await f.ask("cli.install", asked)).result).toEqual({ version: codex.version });
    expect(forced()).toBe(0);                                                                 // no forced probe was started
  });
});

describe("P2-1 (second follow-up): the default layout, where the lock lives in the CLI folder itself (no separate install root)", () => {
  const ownProof = { pid: process.pid, birth: "638980000000000000", boot: "a".repeat(64) };
  const pausedLock = () => { const gate = held<void>(), reached = held<void>(); return { reached, gate, lockOptions: { observe: async (pid: number) => { reached.resolve(); await gate.promise; return pid === process.pid ? { state: "alive" as const, proof: ownProof } : { state: "gone" as const }; } } }; };
  const run = async (change: ((canary: string) => void) | null) => {
    const canary = join(home, "canary"); mkdirSync(canary);
    const lock = pausedLock();
    const install = installManagedCli("codex", { root: cliRoot, nodePath: node, run: fakeNpm(), signerOf: signedByOpenAI, lockOptions: lock.lockOptions }).then(value => value as unknown, (error: unknown) => error);
    await lock.reached.promise;
    change?.(canary);
    const written: string[] = []; hooks.write = path => { written.push(path); };       // every file written from here on, wherever the path leads (even if the folder is tidied afterwards)
    lock.gate.resolve();
    const outcome = await install; hooks.write = undefined;
    return { outcome, canary, written };
  };
  const refused = (outcome: unknown): void => { expect(outcome).toBeInstanceOf(CliInstallError); expect((outcome as CliInstallError).reason).toBe("install-failed"); expect((outcome as CliInstallError).message).toMatch(/CLI folder was changed during the install/); };
  it("the CLI folder (which is also the lock's folder) replaced by a link to an outside folder while the observation is awaited: refused, and the outside folder stays completely empty", async () => {
    const { outcome, canary, written } = await run(c => { renameSync(cliRoot, `${cliRoot}.moved`); symlinkSync(c, cliRoot, "dir"); });
    refused(outcome); expect(readdirSync(canary)).toEqual([]);                      // no lock folder, no owner record, no marker, no id folder
    expect(written.filter(path => path.startsWith(cliRoot))).toEqual([]);           // and nothing was even written through the link: no owner record, no marker
  });
  it("the CLI folder replaced by another plain folder of the same name: refused, and the new folder gets nothing", async () => {
    const { outcome, written } = await run(() => { renameSync(cliRoot, `${cliRoot}.moved`); mkdirSync(cliRoot); });
    refused(outcome); expect(readdirSync(cliRoot)).toEqual([]); expect(written.filter(path => path.startsWith(cliRoot))).toEqual([]);
  });
  it("control: nothing replaced while the observation is awaited, and the install completes with the lock in the CLI folder", async () => {
    const { outcome } = await run(null);
    expect((outcome as { version: string }).version).toBe(codex.version); expect(existsSync(lockDir())).toBe(false); expect(managedCliExecutable(cliRoot, "codex")).not.toBeNull();
  });
  describe("the lock module itself refuses a root that changed while it waited", () => {
    const attempt = async (stale: boolean, change: (canary: string, root: string) => void) => {
      const root = join(home, "lock-root"); mkdirSync(root, { mode: 0o700 }); chmodSync(root, 0o700); const canary = join(home, "canary"); mkdirSync(canary);
      if (stale) { mkdirSync(lockDir(root), { mode: 0o700 }); writeFileSync(join(lockDir(root), "owner.json"), JSON.stringify({ version: 1, type: "installer", nonce: randomUUID(), pid: 999_999, birth: "638980000000000000", boot: "c".repeat(64) }), { mode: 0o600 }); }
      const gate = held<void>(), reached = held<void>();
      const attempted = acquireRuntimeInstallLock(root, { type: "installer", ...(stale ? { ownProof } : {}), observe: async pid => { reached.resolve(); await gate.promise; return pid === process.pid ? { state: "alive", proof: ownProof } : { state: "gone" }; } }).then(lock => lock as unknown, (error: unknown) => error);
      await reached.promise; change(canary, root); gate.resolve();
      return { outcome: await attempted, canary, root };
    };
    for (const stale of [false, true]) {
      it(`${stale ? "reclaiming a dead owner's lock" : "taking a free lock"}: a root swapped for a link meanwhile is refused as changed and nothing is created in the outside folder`, async () => {
        const { outcome, canary } = await attempt(stale, (c, root) => { renameSync(root, `${root}.moved`); symlinkSync(c, root, "dir"); });
        expect(outcome).toBeInstanceOf(RuntimeInstallLockError); expect((outcome as RuntimeInstallLockError).reason).toBe("changed"); expect(readdirSync(canary)).toEqual([]);
      });
      it(`${stale ? "reclaiming a dead owner's lock" : "taking a free lock"}: a root replaced by another plain folder meanwhile is refused as changed`, async () => {
        const { outcome, root } = await attempt(stale, (_c, r) => { renameSync(r, `${r}.moved`); mkdirSync(r); });
        expect(outcome).toBeInstanceOf(RuntimeInstallLockError); expect((outcome as RuntimeInstallLockError).reason).toBe("changed"); expect(readdirSync(root)).toEqual([]);
      });
    }
  });
});

describe("P2-2 (second follow-up): only a complete record of another owner, in the very folder the lock was taken in, ends the wait without a release", () => {
  const other = { version: 1, type: "installer", nonce: randomUUID(), pid: process.pid, birth: "1".repeat(18), boot: "e".repeat(64) };
  /** An install that succeeds and, at its last rename, leaves the lock folder in the state `change` makes; the wait for the release is what is observed. */
  const finished = (change: () => void) => installManagedCli("codex", { root: cliRoot, nodePath: node, releaseRetryMs: 20, run: fakeNpm(), signerOf: signedByOpenAI,
    rename: (from, to) => { renameSync(from, to); if (to.endsWith("current.json")) change(); } });
  const stays = async (result: { ended?: Promise<unknown> }): Promise<() => boolean> => {
    expect(result.ended).toBeInstanceOf(Promise);
    let done = false; void result.ended!.then(() => { done = true; });
    await new Promise(wait => setTimeout(wait, 100)); expect(done).toBe(false);
    return () => done;
  };
  const invalid: Record<string, () => void> = {
    "an empty nonce": () => writeFileSync(join(lockDir(), "owner.json"), '{"nonce":""}'),
    "a different string nonce on an object with nothing else": () => writeFileSync(join(lockDir(), "owner.json"), JSON.stringify({ nonce: "not-a-uuid" })),
    "a well-formed record whose nonce is not a UUID": () => writeFileSync(join(lockDir(), "owner.json"), JSON.stringify({ ...other, nonce: "abc" })),
    "a record with a field too many": () => writeFileSync(join(lockDir(), "owner.json"), JSON.stringify({ ...other, extra: 1 })),
    "an owner record that is a link to a valid other owner": () => { const target = join(home, "elsewhere.json"); writeFileSync(target, JSON.stringify(other)); rmSync(join(lockDir(), "owner.json")); symlinkSync(target, join(lockDir(), "owner.json")); },
  };
  for (const [name, change] of Object.entries(invalid)) {
    it(`${name} is not evidence: the wait goes on until the lock folder is really gone`, async () => {
      const result = await finished(change); const done = await stays(result);
      rmSync(lockDir(), { recursive: true, force: true });
      await vi.waitFor(() => expect(done()).toBe(true));
    });
  }
  it("the CLI folder moved away and an empty folder of the same name put in its place does not read as 'the lock is gone': the wait goes on until the original folder is back and released", async () => {
    const result = await finished(() => { renameSync(cliRoot, `${cliRoot}.moved`); mkdirSync(cliRoot); });
    const done = await stays(result);
    expect(existsSync(join(`${cliRoot}.moved`, RUNTIME_INSTALL_LOCK, "owner.json"))).toBe(true);        // the lock is still there, in the folder that was moved
    rmSync(cliRoot, { recursive: true }); renameSync(`${cliRoot}.moved`, cliRoot);
    await vi.waitFor(() => expect(done()).toBe(true)); expect(existsSync(lockDir())).toBe(false);       // and it was really released
  });
  it("controls: a complete, valid record of another owner, and the lock folder really gone from the very same CLI folder, end the wait at once", async () => {
    for (const change of [() => writeFileSync(join(lockDir(), "owner.json"), JSON.stringify({ ...other, nonce: randomUUID() })), () => rmSync(lockDir(), { recursive: true, force: true })]) {
      rmSync(cliRoot, { recursive: true, force: true });
      const result = await finished(change);
      expect(result.ended).toBeUndefined();
    }
  });
});

describe("P2-3 (second follow-up): consent is asked again after the CLI is found and before its status program is started", () => {
  it("probeCredentialProfileStatus: consent withdrawn while the CLI lookup is held starts nothing, and an unchanged consent runs the program", async () => {
    const exe = { path: "claude.exe", command: "claude.exe", args: [] as string[] };
    for (const withdrawn of [true, false]) {
      let on = true; const gate = held<void>(), reached = held<void>();
      const run = vi.fn(async () => ({ ok: true, text: '{"loggedIn":true}' }));
      const probing = probeCredentialProfileStatus("claude-code", join(home, "profile"), async () => { reached.resolve(); await gate.promise; return exe; }, run, () => on).then(value => value as unknown, (error: unknown) => error);
      await reached.promise; if (withdrawn) on = false; gate.resolve();
      const outcome = await probing;
      if (withdrawn) { expect(outcome).toBeInstanceOf(Error); expect((outcome as Error).message).toMatch(/Authorization expired during CLI discovery/); expect(run).not.toHaveBeenCalled(); }
      else { expect(outcome).toMatchObject({ loggedIn: true }); expect(run).toHaveBeenCalledTimes(1); }
    }
    const before = vi.fn(async () => exe), run2 = vi.fn(async () => ({ ok: true, text: "{}" }));
    await expect(probeCredentialProfileStatus("claude-code", home, before, run2, () => false)).rejects.toThrow(/Authorization expired/);
    expect(before).not.toHaveBeenCalled(); expect(run2).not.toHaveBeenCalled();                    // not even the lookup, when consent is already gone
  });

  type F = Awaited<ReturnType<typeof fixture>>;
  const clis = (version: string) => [{ id: "codex", path: "C:\\x\\codex.exe", version, authenticated: true, runnable: true, readOnlySupport: true, supports: { execution: true, resume: true, model: true, mcp: true }, permissionNote: "fixture", models: [] }];
  const changes: Record<string, (f: F, skew: { ms: number }) => void> = {
    "the switch is turned off": f => setRemoteSwitch(f.store.directory, "install", false),
    "the switch's time runs out": (_f, skew) => { skew.ms = 61_000; },
    "the connection is replaced": f => { (f.client as any).socket.terminate(); },
  };
  /** The real status probe through the real client (no `credentialStatus` seam): the Runtime's CLI lookup is held; the program it finds records that it was started. */
  async function afterFind(change: string | null) {
    const marker = join(home, "status-ran.txt"), script = join(home, "fake-claude.cjs");
    writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n"); console.log(JSON.stringify({ loggedIn: true }));\n`);
    const gate = held<void>(), reached = held<void>(), skew = { ms: 0 };
    let installedNow = false, finds = 0;
    const find = vi.fn(async () => { finds++; if (finds === 1) { reached.resolve(); await gate.promise; } return { path: process.execPath, command: process.execPath, args: [script] }; });
    const probe = vi.fn(async (options?: { force?: boolean }) => ({ home: "C:\\fixture", clis: clis(options?.force && installedNow ? "codex-cli 0.165.0" : "codex-cli 0.161.0") as any, probedAt: 1_793_000_000_000 }));
    const installer = { knows: () => true, install: async () => { installedNow = true; return { version: codex.version }; } };
    const f = await fixture({ credentialLogin: undefined, remoteAccounts: { find, environment: () => ({}), installer, now: () => Date.now() + skew.ms } }, { probe });
    const root = credentialProfilesRoot(f.store.directory); for (const name of ["alpha", "beta"]) createRuntimeProfile(root, "claude-code", name);
    setRemoteSwitch(f.store.directory, "install", true, 60_000);
    const fresh = (): number => f.sent.filter(frame => frame.type === "inventory" && frame.inventory?.clis?.[0]?.version === "codex-cli 0.165.0").length;
    const before = fresh();
    const asked2 = f.ask("cli.install", asked);
    await reached.promise;
    if (change) changes[change](f, skew);
    gate.resolve();
    const reply = await asked2;
    await new Promise(done => setTimeout(done, 300));
    const ran = existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0;
    const cache = (() => { try { return readFileSync(join(root, "status.json"), "utf8"); } catch { return ""; } })();
    return { f, reply, ran, cache, finds, frames: fresh() - before };
  }
  for (const change of Object.keys(changes)) {
    it(`${change} while the Runtime's CLI lookup is held: the status program is never started, nothing is cached or sent, and the install is still answered`, async () => {
      const { f, reply, ran, cache, finds, frames } = await afterFind(change);
      if (change !== "the connection is replaced") expect(reply.result).toEqual({ version: codex.version });
      else expect(f.audit().filter(line => line.action === "cli.install").map(line => line.outcome)).toEqual(["started", "ok"]);
      expect(ran).toBe(0); expect(finds).toBe(1);                                      // the held lookup is the only one: the next profile never starts
      expect(cache).not.toContain("alpha"); expect(cache).not.toContain("beta"); expect(frames).toBe(0);
    });
  }
  it("control: consent unchanged while the lookup is held: the status program runs for both profiles, the cache is written and the new inventory is sent", async () => {
    const { reply, ran, cache, frames } = await afterFind(null);
    expect(reply.result).toEqual({ version: codex.version }); expect(ran).toBe(2); expect(cache).toContain("alpha"); expect(cache).toContain("beta"); expect(frames).toBeGreaterThanOrEqual(1);
  });
});
