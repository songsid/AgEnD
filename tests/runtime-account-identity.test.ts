import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { RuntimeClient, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { credentialProfilesRoot, ensureCredentialProfile, rememberCredentialStatus, cachedCredentialStatus } from "../src/runtime-credential-profiles.js";
import { probeCredentialProfileStatus, probeNativeClis, type NativeCliExecutable } from "../src/windows-cli-worker.js";
import type { WindowsCliProbe, WindowsCliTask } from "../src/windows-cli.js";

// Fixtures only: example.com addresses. The full address below must appear NOWHERE the Runtime or AgEnD writes, shows or sends.
const RAW = "alice.fixture@example.com", RAW_OTHER = "bob.fixture@example.org";
const rawStatus = (email: string, over: Record<string, unknown> = {}) => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email, orgName: "Fixture Org", subscriptionType: "team", configDirectory: "C:\\fixture", ...over });
const directories: string[] = [], clients: RuntimeClient[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [], sockets: WebSocket[] = [];
function home(): string { const path = mkdtempSync(join(tmpdir(), "agend-account-identity-")); directories.push(path); return path; }
class FakeBridge implements RuntimeBridge {
  probeResult: WindowsCliProbe = { home: "C:\\Users\\fixture", clis: [], probedAt: 1 };
  readonly probe = vi.fn(async () => structuredClone(this.probeResult));
  readonly prepareWorkspace = vi.fn(async (agentId: string) => `C:\\Users\\fixture\\.agend\\workspaces\\${agentId}`);
  start(): WindowsCliTask { throw Error("not used"); }
  get(): WindowsCliTask | null { return null; }
  cancel(): WindowsCliTask { throw Error("not used"); }
  close(): void {}
  releaseUnknown(): void {}
}
const exe: NativeCliExecutable = { path: "C:\\claude.exe", command: "C:\\node.exe", args: ["C:\\cli.js"] };
async function fixture(clientOptions: Partial<ConstructorParameters<typeof RuntimeClient>[0]> = {}) {
  const hubHome = home(), hub = new RuntimeCoordinator(hubHome); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Fixture Windows", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)?.pairingFingerprint);
  const claim = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret }); if (claim.status !== "approved") throw Error("Pairing fixture failed");
  const server = createServer((req, res) => { if (!hub.handlePublicRequest(req, res, new URL(req.url ?? "/", "http://localhost"))) { res.writeHead(404); res.end(); } });
  servers.push(server); server.on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
  const base = `http://127.0.0.1:${address.port}`, runtimeHome = home(), root = credentialProfilesRoot(runtimeHome), store = new RuntimeClientStore(join(runtimeHome, "state")), bridge = new FakeBridge();
  store.saveCredentials({ server: base, machineId: claim.machineId, credential: claim.credential, name: "Fixture Windows" });
  const lines: string[] = [];
  const client = new RuntimeClient({ store, bridge, reconnectMs: 25, pollMs: 10, credentialProfilesRoot: root, credentialWatchMs: 20, report: text => lines.push(text), ...clientOptions });
  clients.push(client); await client.start(); await vi.waitFor(() => expect(client.online()).toBe(true));
  return { hub, hubHome, base, store, bridge, client, machineId: claim.machineId, credential: claim.credential, root, runtimeHome, lines };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); }
});
/** Every file under a folder, as text: what was written to disk. */
function everything(path: string): string {
  let out = ""; for (const entry of readdirSync(path, { withFileTypes: true })) { const full = join(path, entry.name); out += entry.isDirectory() ? everything(full) : statSync(full).size < 1_000_000 ? readFileSync(full, "utf8") : ""; }
  return out;
}

describe("what a Runtime reports about the account behind a sign-in", () => {
  it("is the masked e-mail and plan of each profile and of the default sign-in, produced from the CLI's own answer on that computer", async () => {
    const answers = new Map([["work", rawStatus(RAW)], ["home", rawStatus(RAW_OTHER, { subscriptionType: "max" })], ["key", JSON.stringify({ loggedIn: true, authMethod: "api_key" })]]);
    const f = await fixture({ credentialStatus: (cli, directory) => probeCredentialProfileStatus(cli, directory, async () => exe, async (_exe, _args, env) => ({ ok: true, text: answers.get(env.CLAUDE_CONFIG_DIR!.split(/[\\/]/).pop()!) ?? "" })) });
    for (const name of ["work", "home", "key", "empty"]) ensureCredentialProfile(f.root, "claude-code", name);
    f.bridge.probeResult = { home: "C:\\U", probedAt: 2, clis: [{ id: "claude-code", path: "C:\\claude.exe", version: "2.1.316", authenticated: true, runnable: true, supports: { execution: true, resume: true, model: true, mcp: true }, readOnlySupport: true, permissionNote: "", models: [], identity: { maskedEmail: "de***@example.com", plan: "pro" } }] } as WindowsCliProbe;
    expect(f.hub.machine(f.machineId)?.runtimeInfo?.capabilities).toContain("account-identity");
    await f.hub.call(f.machineId, "probe", { force: true });
    const inventory = f.hub.machine(f.machineId)!.inventory!;
    expect(inventory.credentialProfiles?.profiles).toEqual([
      { name: "empty", loggedIn: null }, { name: "home", loggedIn: true, identity: { maskedEmail: "bo***@example.org", plan: "max" } },
      { name: "key", loggedIn: true, identity: { apiKey: true } }, { name: "work", loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "team" } }]);
    expect(inventory.clis[0].identity).toEqual({ maskedEmail: "de***@example.com", plan: "pro" });
    // Nowhere: not in what AgEnD holds, not on the Runtime's disk, not in what the Runtime printed.
    for (const text of [JSON.stringify(f.hub.listMachines()), everything(f.hubHome), everything(f.runtimeHome), f.lines.join("\n")]) for (const secret of [RAW, RAW_OTHER, "alice.fixture", "bob.fixture"]) expect(text).not.toContain(secret);
  });
  it("is the last known answer on a read that is not an explicit detection (no CLI is started), and updates on the next detection", async () => {
    const status = vi.fn(async () => ({ loggedIn: true as const, identity: { maskedEmail: "al***@example.com", plan: "team" as const } }));
    const f = await fixture({ credentialStatus: status }); ensureCredentialProfile(f.root, "claude-code", "work");
    await f.hub.call(f.machineId, "probe", { force: true }); status.mockClear();
    await f.hub.call(f.machineId, "probe", {});
    expect(status).not.toHaveBeenCalled(); expect(f.hub.machine(f.machineId)?.inventory?.credentialProfiles?.profiles[0].identity).toEqual({ maskedEmail: "al***@example.com", plan: "team" });
    status.mockResolvedValue({ loggedIn: true, identity: { maskedEmail: "bo***@example.org", plan: "pro" } as never });
    await f.hub.call(f.machineId, "probe", { force: true }); expect(f.hub.machine(f.machineId)?.inventory?.credentialProfiles?.profiles[0].identity).toEqual({ maskedEmail: "bo***@example.org", plan: "pro" });
  });
  it("is none for a profile that is signed out or unchecked, and a signed-out answer forgets the account it had", async () => {
    const f = await fixture(); ensureCredentialProfile(f.root, "claude-code", "work");
    rememberCredentialStatus(f.root, "claude-code", "work", { loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "team" } });
    expect(cachedCredentialStatus(f.root, "claude-code", "work")?.identity).toEqual({ maskedEmail: "al***@example.com", plan: "team" });
    rememberCredentialStatus(f.root, "claude-code", "work", { loggedIn: false, identity: { maskedEmail: "al***@example.com" } });
    expect(cachedCredentialStatus(f.root, "claude-code", "work")).toEqual({ loggedIn: false });
    rememberCredentialStatus(f.root, "claude-code", "work", { loggedIn: null }); expect(cachedCredentialStatus(f.root, "claude-code", "work")).toEqual({ loggedIn: null });
  });
  it("re-reports by itself when `agend-runtime login` (another window) signs a profile in to a different account", async () => {
    const f = await fixture(); ensureCredentialProfile(f.root, "claude-code", "work");
    rememberCredentialStatus(f.root, "claude-code", "work", { loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "team" } });
    await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.inventory?.credentialProfiles?.profiles[0]?.identity).toEqual({ maskedEmail: "al***@example.com", plan: "team" }));
    rememberCredentialStatus(f.root, "claude-code", "work", { loggedIn: true, identity: { maskedEmail: "bo***@example.org", plan: "max" } });
    await vi.waitFor(() => expect(f.hub.machine(f.machineId)?.inventory?.credentialProfiles?.profiles[0]?.identity).toEqual({ maskedEmail: "bo***@example.org", plan: "max" }));
  });
  it("a Runtime's own gate check keeps the account too (a run on a profile refreshes what is shown)", async () => {
    const f = await fixture({ credentialStatus: async () => ({ loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "team" } }) }); ensureCredentialProfile(f.root, "claude-code", "work");
    await f.client.operation("probe", { force: true });
    expect(cachedCredentialStatus(f.root, "claude-code", "work")).toEqual({ loggedIn: true, identity: { maskedEmail: "al***@example.com", plan: "team" } });
  });
});

describe("AgEnD accepts an account identity in its closed, masked form only", () => {
  async function send(f: Awaited<ReturnType<typeof fixture>>, inventory: unknown) {
    const ws = new WebSocket(f.base.replace("http:", "ws:") + "/runtime/v1/connect", { headers: { Authorization: `Bearer ${f.credential}` } }); sockets.push(ws);
    await once(ws, "open"); const closed = once(ws, "close"), welcome = once(ws, "message");
    ws.send(JSON.stringify({ v: 1, type: "hello", bootId: "identity-boot", inventory }));
    const first = await Promise.race([closed.then(([code, reason]) => ({ code: code as number, reason: String(reason) })), welcome.then(() => ({ code: 0, reason: "" }))]);
    ws.terminate(); return first;
  }
  const withProfile = (identity: unknown, loggedIn: unknown = true) => ({ home: "C:\\U", clis: [], credentialProfiles: { profiles: [{ name: "work", loggedIn, identity }] } });
  const withCli = (identity: unknown, over: Record<string, unknown> = {}) => ({ home: "C:\\U", clis: [{ id: "claude-code", path: "C:\\c.exe", version: "2.1.316", authenticated: true, runnable: true, supports: { execution: true }, readOnlySupport: true, permissionNote: "", models: [], identity, ...over }] });
  it("takes the masked form", async () => {
    const f = await fixture(); (f.client as unknown as { stopped: boolean }).stopped = true;
    expect((await send(f, withProfile({ maskedEmail: "ab***@example.com", plan: "team" }))).code).toBe(0);
    expect((await send(f, withCli({ maskedEmail: "ab***@example.com", plan: "unknown" }))).code).toBe(0);
    expect((await send(f, withProfile({ apiKey: true }))).code).toBe(0);
  });
  it.each([
    ["an unmasked e-mail", { maskedEmail: RAW }],
    ["an unmasked e-mail in another key", { email: RAW }],
    ["a mask that shows too much", { maskedEmail: "alice***@example.com" }],
    ["a non-ASCII mask", { maskedEmail: "é***@example.com" }],
    ["a mask with a trailing address", { maskedEmail: "ab***@example.com,bob@example.org" }],
    ["a plan outside the list", { plan: "gold" }],
    ["a capitalised plan", { plan: "Team" }],
    ["an extra field", { maskedEmail: "ab***@example.com", name: "Alice" }],
    ["an API key with an e-mail", { apiKey: true, maskedEmail: "ab***@example.com" }],
  ])("closes the connection for %s, naming the field and never the value", async (_why, identity) => {
    const f = await fixture(); (f.client as unknown as { stopped: boolean }).stopped = true;
    const output: string[] = []; for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => { output.push(String(chunk)); return true; });
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { output.push(args.map(String).join(" ")); });
    for (const inventory of [withProfile(identity), withCli(identity)]) {
      const result = await send(f, inventory);
      expect(result.code).toBe(1008); expect(result.reason).toMatch(/^Invalid runtime message: Invalid runtime (?:credential profiles|CLI identity) \([A-Za-z ]+\)$/);
      for (const secret of [RAW, "alice", "bob@example.org", "Alice", "gold"]) expect(result.reason).not.toContain(secret);
    }
    for (const secret of [RAW, "alice.fixture"]) { expect(output.join("\n")).not.toContain(secret); expect(everything(f.hubHome)).not.toContain(secret); expect(JSON.stringify(f.hub.listMachines())).not.toContain(secret); }
  });
  it("refuses an identity on something that cannot have one: a signed-out profile, another CLI, a CLI that is not signed in", async () => {
    const f = await fixture(); (f.client as unknown as { stopped: boolean }).stopped = true;
    const good = { maskedEmail: "ab***@example.com", plan: "team" };
    expect((await send(f, withProfile(good, false))).code).toBe(1008); expect((await send(f, withProfile(good, null))).code).toBe(1008);
    expect((await send(f, withCli(good, { id: "codex" }))).code).toBe(1008); expect((await send(f, withCli(good, { authenticated: false }))).code).toBe(1008);
  });
  it("still takes a report from an older Runtime that has no identity at all", async () => {
    const f = await fixture(); (f.client as unknown as { stopped: boolean }).stopped = true;
    expect((await send(f, { home: "C:\\U", clis: [], credentialProfiles: { profiles: [{ name: "work", loggedIn: true }] } })).code).toBe(0);
    expect((await send(f, withCli(undefined))).code).toBe(0);
  });
});

describe("the default sign-in's account, from the CLI probe on the Windows computer", () => {
  it("is masked in the row before the Runtime stores or sends it, from the same `auth status` answer as `authenticated`", async () => {
    const run = vi.fn(async (_exe: NativeCliExecutable, args: string[]) => {
      const text = args.join(" ");
      if (text.includes("auth status")) return { ok: true, text: rawStatus(RAW) };
      if (text.includes("--version")) return { ok: true, text: "2.1.316 (Claude Code)" };
      if (text.includes("--help")) return { ok: true, text: "--print --output-format --input-format --permission-prompts --tools --strict-mcp-config --mcp-config --allowedTools" };
      return { ok: false, text: "" };
    });
    const result = await probeNativeClis({ find: async id => id === "claude-code" ? exe : null, run, readModels: () => [] });
    const row = result.clis.find(cli => cli.id === "claude-code")!;
    expect(row.authenticated).toBe(true); expect(row.identity).toEqual({ maskedEmail: "al***@example.com", plan: "team" });
    expect(JSON.stringify(result)).not.toContain("alice.fixture");
    expect(run.mock.calls.filter(call => call[1].includes("status"))).toHaveLength(1);   // one answer serves both
  });
  it("has none for a signed-out or API-key sign-in, and none for another CLI", async () => {
    const probe = async (status: string) => (await probeNativeClis({ find: async id => id === "claude-code" ? exe : null, readModels: () => [],
      run: async (_exe, args) => args.join(" ").includes("auth status") ? { ok: true, text: status } : args.includes("--version") ? { ok: true, text: "2.1.316" } : { ok: true, text: "--print --output-format --input-format --permission-prompts" } })).clis.find(cli => cli.id === "claude-code")!;
    expect((await probe(rawStatus(RAW, { loggedIn: false }))).identity).toBeUndefined();
    expect((await probe(JSON.stringify({ loggedIn: true, authMethod: "api_key" }))).identity).toEqual({ apiKey: true });
    expect((await probe("not json")).identity).toBeUndefined();
  });
});
