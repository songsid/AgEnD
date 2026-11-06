import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { credentialProfilesRoot } from "../src/runtime-credential-profiles.js";
import { createRuntimeProfile } from "../src/runtime-profile-ownership.js";
import { PANE_HOST_DIRECTORY, PANE_HOST_STATE_DIRECTORY, PANE_IN_PROCESS_DIRECTORY, PANE_LEDGER_FILE, paneLedgerFiles } from "../src/runtime-pane-store.js";
import { AUDIT_FILE, setRemoteSwitch } from "../src/runtime-remote-setup.js";
import { readRuntimeInfo } from "../src/runtime-build-info.js";
import type { WindowsCliProbe, WindowsCliTask } from "../src/windows-cli.js";

function held<T = void>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const directories: string[] = [], clients: RuntimeClient[] = [], closers: Array<() => Promise<void>> = [];
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), "agend-client-remote-")); directories.push(path); return path; };
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const close of closers.splice(0)) await close();
  for (const path of directories.splice(0)) { if (!resolve(path).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture path"); rmSync(path, { recursive: true, force: true }); }
});
const bridge: RuntimeBridge = { probe: async (): Promise<WindowsCliProbe> => ({ home: "C:\\fixture", clis: [], probedAt: 1 }), prepareWorkspace: async () => "C:\\w", start: () => { throw Error("no CLI runs here"); },
  get: (): WindowsCliTask | null => null, cancel: () => { throw Error("unused"); }, close: () => {}, releaseUnknown: () => {} };
class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); pid = 9; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  kill(): boolean { queueMicrotask(() => { this.exitCode = 1; this.emit("close", 1); }); return true; }
}
async function fixture(clientOptions: Partial<ConstructorParameters<typeof RuntimeClient>[0]> = {}) {
  const http = createServer(), sockets = new WebSocketServer({ server: http }), machineId = randomUUID(), frames: any[] = []; let socket: WebSocket | undefined, hello: any, helloCount = 0;
  const welcomed = new Promise<void>(done => sockets.on("connection", ws => { socket = ws; ws.on("message", raw => { const frame = JSON.parse(raw.toString()); if (frame.type === "hello") { hello = frame; helloCount++; ws.send(JSON.stringify({ v: 1, type: "welcome", machineId, generation: 1 })); done(); } else frames.push(frame); }); }));
  http.listen(0, "127.0.0.1"); await once(http, "listening"); const address = http.address(); if (!address || typeof address === "string") throw Error("No fixture port");
  closers.push(async () => { for (const ws of sockets.clients) ws.terminate(); await new Promise<void>(done => sockets.close(() => done())); http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); });
  const home = scratch(), root = credentialProfilesRoot(join(home, "state")), store = new RuntimeClientStore(join(home, "state"));
  store.saveCredentials({ server: `http://127.0.0.1:${address.port}`, machineId, credential: "a".repeat(64), name: "Remote fixture" });
  const children: FakeChild[] = [];
  const client = new RuntimeClient({ store, bridge, reconnectMs: 25, pollMs: 10, credentialProfilesRoot: root, credentialLogin: async () => false,
    remoteAccounts: { find: async () => ({ path: "claude.exe", command: "claude.exe", args: [] }), environment: () => ({ PATH: "p" }), runLogout: async () => 0,
      signIn: { scratchRoot: scratch(), spawn: () => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; } } }, ...clientOptions });
  clients.push(client); await client.start(); await welcomed; await vi.waitFor(() => expect(client.online()).toBe(true));
  const send = (frame: unknown): void => socket!.send(JSON.stringify(frame));
  const call = async (operation: string, payload: unknown, id = `a-${randomUUID()}`): Promise<any> => { send({ v: 1, type: "account.request", id, operation, payload }); await vi.waitFor(() => expect(frames.some(f => f.id === id)).toBe(true)); return frames.find(f => f.id === id); };
  return { client, store, root, home: store.directory, frames, children, hello: () => hello, call, send, machineId, drop: () => socket!.terminate(), hellos: () => helloCount };
}

describe("capabilities", () => {
  it("a Runtime with a profile folder and a way to run the CLI reports remote-signin, and cli-install only with an installer", async () => {
    const f = await fixture();
    expect(f.hello().runtimeInfo.capabilities).toContain("remote-signin"); expect(f.hello().runtimeInfo.capabilities).not.toContain("cli-install");
    const g = await fixture({ remoteAccounts: { installer: { knows: () => true, install: async () => ({ version: "2.1.318" }) } } });
    expect(g.hello().runtimeInfo.capabilities).toEqual(expect.arrayContaining(["remote-signin", "cli-install"]));
  });
  it("a Runtime without a profile folder offers neither, and answers an account request with a plain refusal", async () => {
    const f = await fixture({ credentialProfilesRoot: undefined });
    expect(f.hello().runtimeInfo.capabilities).not.toContain("remote-signin");
    const reply = await f.call("accounts.switches", {}); expect(reply).toMatchObject({ type: "account.response", ok: false }); expect(reply.error).toMatch(/no credential profile folder/);
  });
  it("this program's own version information claims cli-install only where it has an installer (native Windows), so AgEnD never offers an install to a Runtime that cannot", () => {
    const info = readRuntimeInfo({ panes: false, install: false }); expect(info.capabilities).toContain("remote-signin"); expect(info.capabilities).not.toContain("cli-install");
    expect(readRuntimeInfo({ panes: false, install: true }).capabilities).toContain("cli-install");
    expect(readRuntimeInfo({ panes: false }).capabilities.includes("cli-install")).toBe(process.platform === "win32");
  });
});

describe("account frames", () => {
  it("are answered in their own frame type, and an off switch answers with the command to run", async () => {
    const f = await fixture();
    expect(await f.call("accounts.switches", {})).toMatchObject({ type: "account.response", ok: true, result: { accounts: { on: false }, install: { on: false } } });
    const refused = await f.call("signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor: "admin:u1" });
    expect(refused).toMatchObject({ ok: false }); expect(refused.error).toMatch(/agend-runtime remote-setup accounts on/);
    expect(f.frames.some(frame => frame.type === "response")).toBe(false);
  });
  it("carry a whole sign-in: start, the reduced screen, a code, the check, close; with the switch on this computer only", async () => {
    const f = await fixture(); setRemoteSwitch(f.home, "accounts", true);
    const started = await f.call("signin.start", { cli: "claude-code", profile: "work", method: "subscription", actor: "admin:u1" }); expect(started.ok).toBe(true);
    const sessionId = started.result.sessionId as string;
    f.children[0]!.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s\nPaste code here if prompted >");
    expect((await f.call("signin.capture", { sessionId })).result.screen).toBe("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s\nPaste code here if prompted >\n");
    expect((await f.call("signin.write", { sessionId, input: "\x15ABC-123\r" })).result).toEqual({ accepted: true });
    expect((await f.call("signin.close", { sessionId })).result).toEqual({ closed: true });
    const audit = readFileSync(join(f.home, AUDIT_FILE), "utf8"); expect(audit).not.toMatch(/claude\.com|ABC-123|state=/);
  });
  it("a malformed account frame is a protocol error that ends the connection, like any other malformed frame", async () => {
    const f = await fixture(); const closed = new Promise<number>(done => { (f.client as any).socket.on("close", (code: number) => done(code)); });
    f.send({ v: 1, type: "account.request", id: "x", operation: "run", payload: {} });
    expect(await closed).toBe(1008);
  });
  it("an unknown or extra-field frame is refused the same way", async () => {
    const f = await fixture(); const closed = new Promise<number>(done => { (f.client as any).socket.on("close", (code: number) => done(code)); });
    f.send({ v: 1, type: "account.request", id: "x", operation: "accounts.switches", payload: {}, argv: ["cmd"] });
    expect(await closed).toBe(1008);
  });
});

describe("remove and sign-out refuse while something runs under the profile", () => {
  const ledger = (launch: Record<string, unknown>, state: string) => JSON.stringify({ version: 1, panes: { p1: { launch, snapshot: { state } } } });
  const remove = (f: Awaited<ReturnType<typeof fixture>>) => f.call("accounts.remove", { cli: "claude-code", profile: "work", actor: "admin:u1" });
  const write = (file: string, text: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };
  it("reads the pane ledgers from the one place the pane store defines (the production pane host's folder and the in-process one)", () => {
    expect(paneLedgerFiles("R")).toEqual([join("R", "pane-host", "state", "panes.json"), join("R", "panes", "panes.json")]);
    expect(PANE_HOST_DIRECTORY).toBe("pane-host"); expect(PANE_HOST_STATE_DIRECTORY).toBe("state"); expect(PANE_IN_PROCESS_DIRECTORY).toBe("panes"); expect(PANE_LEDGER_FILE).toBe("panes.json");
  });
  it("a running terminal in the PRODUCTION pane host's ledger keeps the profile; an exited one does not", async () => {
    const f = await fixture(); setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work"); const [production] = paneLedgerFiles(f.home);
    write(production!, ledger({ cli: "claude-code", credentialProfile: "WORK" }, "running"));
    expect((await remove(f)).error).toMatch(/running terminal/);
    write(production!, "{ not json"); expect((await remove(f)).error).toMatch(/could not confirm whether a terminal is running/);   // an unreadable ledger cannot show it is free
    write(production!, ledger({ cli: "claude-code", credentialProfile: "work" }, "exited")); expect((await remove(f)).ok).toBe(true);
    expect(existsSync(join(f.root, "claude-code", "work"))).toBe(false);
  });
  it("also reads the in-process host's ledger", async () => {
    const f = await fixture(); setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work");
    write(paneLedgerFiles(f.home)[1]!, ledger({ cli: "claude-code", credentialProfile: "work" }, "running")); expect((await remove(f)).error).toMatch(/running terminal/);
  });
  it("a Claude Code terminal that names no profile runs under the pairing's default, so it keeps the default profile (and only that one)", async () => {
    const f = await fixture(); setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work"); createRuntimeProfile(f.root, "claude-code", "other");
    write(paneLedgerFiles(f.home)[0]!, ledger({ cli: "claude-code" }, "running"));
    f.store.setCredentialDefault("other");
    expect((await remove(f)).ok).toBe(true);                                                    // "work" is not the default: free; ("other" is the default, and is in use)
    createRuntimeProfile(f.root, "claude-code", "work");
    expect((await f.call("accounts.signout", { cli: "claude-code", profile: "other", actor: "admin:u1" })).error).toMatch(/running terminal/);
    f.store.setCredentialDefault(undefined);
    expect((await f.call("accounts.signout", { cli: "claude-code", profile: "other", actor: "admin:u1" })).error ?? "").not.toMatch(/running terminal/);
  });
  it("a Codex terminal with no profile, or an exited default-profile terminal, keeps nothing", async () => {
    const f = await fixture(); setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work"); f.store.setCredentialDefault("work");
    write(paneLedgerFiles(f.home)[0]!, JSON.stringify({ version: 1, panes: { a: { launch: { cli: "codex" }, snapshot: { state: "running" } }, b: { launch: { cli: "claude-code" }, snapshot: { state: "exited" } } } }));
    expect((await f.call("accounts.remove", { cli: "claude-code", profile: "work", actor: "admin:u1" })).error).toMatch(/default for agents/);   // refused for the default, not for a terminal
    f.store.setCredentialDefault(undefined); expect((await remove(f)).ok).toBe(true);
  });
  it("the pairing's default profile keeps it (only this computer knows)", async () => {
    const f = await fixture(); setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work"); f.store.setCredentialDefault("work");
    expect((await remove(f)).error).toMatch(/default for agents/);
    expect(existsSync(join(f.root, "claude-code", "work"))).toBe(true);
  });
});

describe("a state this computer cannot confirm is not reported as a running terminal", () => {
  const ledger = (rows: Record<string, unknown>) => JSON.stringify({ version: 1, panes: rows });
  const write = (file: string, text: string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };
  const BOOT_A = "a".repeat(64), BOOT_B = "b".repeat(64);
  it("an unreadable ledger is refused with its own reason and a message that sends the person to that computer, not to stop a terminal", async () => {
    const f = await fixture(); setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work");
    write(paneLedgerFiles(f.home)[0]!, "{ not json");
    const reply = await f.call("accounts.remove", { cli: "claude-code", profile: "work", actor: "admin:u1" });
    expect(reply.ok).toBe(false); expect(reply.error).toMatch(/could not confirm whether a terminal is running.*Check that computer/); expect(reply.error).not.toMatch(/stop it first|in use by a running/);
    expect(existsSync(join(f.root, "claude-code", "work"))).toBe(true);
    expect(readFileSync(join(f.home, AUDIT_FILE), "utf8")).toMatch(/"reason":"unconfirmed"/);
  });
  it("a terminal recorded under another boot of the computer cannot still be running, so a restart does not block sign-out or remove", async () => {
    const f = await fixture({ remoteAccounts: { find: async () => ({ path: "claude.exe", command: "claude.exe", args: [] }), environment: () => ({ PATH: "p" }), runLogout: async () => 0, systemBootId: async () => BOOT_B } });
    setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work");
    write(paneLedgerFiles(f.home)[0]!, ledger({ old: { launch: { cli: "claude-code", credentialProfile: "work" }, snapshot: { state: "running" }, systemBootId: BOOT_A } }));
    expect((await f.call("accounts.remove", { cli: "claude-code", profile: "work", actor: "admin:u1" })).ok).toBe(true);
  });
  it("a terminal of THIS boot still blocks, and so does one with no boot proof, and one when the boot cannot be read", async () => {
    for (const [row, boot] of [[{ systemBootId: BOOT_B }, BOOT_B], [{}, BOOT_B], [{ systemBootId: BOOT_A }, undefined]] as Array<[Record<string, unknown>, string | undefined]>) {
      const f = await fixture({ remoteAccounts: { find: async () => ({ path: "claude.exe", command: "claude.exe", args: [] }), environment: () => ({ PATH: "p" }), runLogout: async () => 0, systemBootId: async () => boot } });
      setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work");
      write(paneLedgerFiles(f.home)[0]!, ledger({ live: { launch: { cli: "claude-code", credentialProfile: "work" }, snapshot: { state: "running" }, ...row } }));
      expect((await f.call("accounts.remove", { cli: "claude-code", profile: "work", actor: "admin:u1" })).error, JSON.stringify(row)).toMatch(/running terminal/);
    }
  });
  it("an unreadable default profile only matters when a terminal needs it", async () => {
    const f = await fixture(); setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work");
    writeFileSync(join(f.home, "credential-default.json"), "{ not json");
    write(paneLedgerFiles(f.home)[0]!, ledger({ named: { launch: { cli: "claude-code", credentialProfile: "elsewhere" }, snapshot: { state: "running" } } }));
    expect((await f.call("accounts.signout", { cli: "claude-code", profile: "work", actor: "admin:u1" })).error ?? "").not.toMatch(/could not confirm/);
    write(paneLedgerFiles(f.home)[0]!, ledger({ nameless: { launch: { cli: "claude-code" }, snapshot: { state: "running" } } }));
    createRuntimeProfile(f.root, "claude-code", "second");                                       // (the first sign-out of "work" started its 5 s wait)
    expect((await f.call("accounts.signout", { cli: "claude-code", profile: "second", actor: "admin:u1" })).error).toMatch(/could not confirm whether a terminal is running/);
  });
});


// ---------------------------------------------------------------- the connection, stop, tasks and terminals
const holdLookup = () => { let resolve!: (value: { path: string; command: string; args: string[] }) => void; const promise = new Promise<{ path: string; command: string; args: string[] }>(done => { resolve = done; }); return { promise, resolve }; };
const startFrame = (id: string, profile = "late") => ({ v: 1, type: "account.request", id, operation: "signin.start", payload: { cli: "claude-code", profile, method: "subscription", actor: "admin:u1" } });
const claudeTask = (profile: string) => ({ task: { requestId: randomUUID(), cli: "claude-code" as const, cwd: "C:\\workspace", prompt: "Private fixture request; never invoke a real CLI", sandbox: "read-only" as const }, credentialProfile: profile });

describe("a request belongs to the connection that asked", () => {
  it("a start still waiting when the connection drops and comes back: the late answer is never sent to the new connection, and nothing is created or started", async () => {
    const lookup = holdLookup(); const f = await fixture({ remoteAccounts: { find: () => lookup.promise, environment: () => ({ PATH: "p" }), runLogout: async () => 0,
      signIn: { scratchRoot: scratch(), spawn: () => { const child = new FakeChild(); spawnedChildren.push(child); return child as unknown as ChildProcess; } } } });
    setRemoteSwitch(f.home, "accounts", true); const spawnedChildren: FakeChild[] = []; const id = "late-1";
    f.send(startFrame(id)); await new Promise(done => setTimeout(done, 40));
    const before = f.hellos(); f.drop(); await vi.waitFor(() => expect(f.hellos()).toBe(before + 1)); await vi.waitFor(() => expect(f.client.online()).toBe(true));
    lookup.resolve({ path: "claude.exe", command: "claude.exe", args: [] }); await new Promise(done => setTimeout(done, 150));
    expect(f.frames.some(frame => frame.id === id)).toBe(false);                                   // no answer on the new connection
    expect(spawnedChildren).toHaveLength(0); expect(existsSync(join(f.root, "claude-code", "late"))).toBe(false);
    const next = await f.call("accounts.switches", {}); expect(next.ok).toBe(true);                  // the new connection works normally
  });
  it("a sign-in opened over a connection is ended when that connection drops", async () => {
    const spawnedChildren: FakeChild[] = []; const f = await fixture({ remoteAccounts: { find: async () => ({ path: "claude.exe", command: "claude.exe", args: [] }), environment: () => ({ PATH: "p" }), runLogout: async () => 0,
      signIn: { scratchRoot: scratch(), spawn: () => { const child = new FakeChild(); spawnedChildren.push(child); return child as unknown as ChildProcess; } } } });
    setRemoteSwitch(f.home, "accounts", true); expect((await f.call("signin.start", startFrame("x").payload)).ok).toBe(true);
    const before = f.hellos(); f.drop(); await vi.waitFor(() => expect(f.hellos()).toBe(before + 1)); await vi.waitFor(() => expect(f.client.online()).toBe(true));
    await vi.waitFor(() => expect(spawnedChildren[0]!.exitCode).not.toBeNull());
  });
  it("stop while a start is waiting for the CLI lookup: stop waits for it, and no child or folder comes out of it", async () => {
    const lookup = holdLookup(), spawnedChildren: FakeChild[] = []; const f = await fixture({ remoteAccounts: { find: () => lookup.promise, environment: () => ({ PATH: "p" }), runLogout: async () => 0,
      signIn: { scratchRoot: scratch(), spawn: () => { const child = new FakeChild(); spawnedChildren.push(child); return child as unknown as ChildProcess; } } } });
    setRemoteSwitch(f.home, "accounts", true); f.send(startFrame("held-1")); await new Promise(done => setTimeout(done, 40));
    let stopped = false; const stopping = f.client.stop().then(() => { stopped = true; }); await new Promise(done => setTimeout(done, 60));
    expect(stopped).toBe(false); lookup.resolve({ path: "claude.exe", command: "claude.exe", args: [] }); await stopping;
    expect(spawnedChildren).toHaveLength(0); expect(existsSync(join(f.root, "claude-code", "late"))).toBe(false);
  });
});

describe("tasks and terminals meet the same reservation as a removal", () => {
  const removeFrame = (id: string) => ({ v: 1, type: "account.request", id, operation: "accounts.remove", payload: { cli: "claude-code", profile: "work", actor: "admin:u1" } });
  const holdInspector = () => { let release!: () => void; const gate = new Promise<void>(done => { release = done; }); let calls = 0; return { release, calls: () => calls, inspect: async (paths: readonly string[]) => { if (++calls === 1) await gate; return paths.map(() => false); } }; };
  it("while a removal is under way (its inspection waits), a task that names the profile is not started, and the profile is not removed from under a task that was already admitted", async () => {
    const hold = holdInspector(); const f = await fixture({ remoteAccounts: { find: async () => ({ path: "claude.exe", command: "claude.exe", args: [] }), environment: () => ({ PATH: "p" }), runLogout: async () => 0, ownership: { inspect: hold.inspect } } });
    setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work");
    f.send(removeFrame("rm-1")); await vi.waitFor(() => expect(hold.calls()).toBe(1));
    const task = await f.client.operation("run", claudeTask("work")) as { status: string; error?: string }; expect(task.status).toBe("failed"); expect(task.error).toMatch(/is being changed from AgEnD/);
    hold.release(); await vi.waitFor(() => expect(f.frames.some(frame => frame.id === "rm-1")).toBe(true)); expect(f.frames.find(frame => frame.id === "rm-1").ok).toBe(true);
  });
  it("a task admitted before the removal started is found by the removal (it is registered in the same step as admission)", async () => {
    const login = held<boolean>(); const f = await fixture({ credentialLogin: () => login.promise, bridge: { ...bridge, start: () => { throw new Error("stop here"); } } as never });
    setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work");
    const pending = f.client.operation("run", claudeTask("work"));            // admitted, and now waiting for the profile's sign-in check
    expect((f.client as any).activeProfiles.size).toBe(1);
    const removed = await f.call("accounts.remove", { cli: "claude-code", profile: "work", actor: "admin:u1" }); expect(removed.ok).toBe(false); expect(removed.error).toMatch(/running task/);
    expect(existsSync(join(f.root, "claude-code", "work"))).toBe(true); login.resolve(true); await pending;
  });
  const launch = (profile: string) => ({ paneId: randomUUID(), agentId: randomUUID(), instance: "pane-agent", cli: "claude-code", cwd: "C:\\fixture", sandbox: "read-only", columns: 80, rows: 24, credentialProfile: profile });
  it("a terminal that would open under a profile being removed is refused", async () => {
    const paneId1 = randomUUID();
    const hold = holdInspector(); const f = await fixture({ remoteAccounts: { find: async () => ({ path: "claude.exe", command: "claude.exe", args: [] }), environment: () => ({ PATH: "p" }), runLogout: async () => 0, ownership: { inspect: hold.inspect } } });
    setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work");
    f.send(removeFrame("rm-2")); await vi.waitFor(() => expect(hold.calls()).toBe(1));
    f.send({ v: 1, type: "pane.request", id: paneId1, maxAgents: 4, request: { action: "open", operationId: randomUUID(), launch: launch("work") } });
    await vi.waitFor(() => expect(f.frames.some(frame => frame.id === paneId1)).toBe(true)); const refused = f.frames.find(frame => frame.id === paneId1);
    expect(refused.ok).toBe(false); expect(refused.error).toMatch(/is being changed from AgEnD/); hold.release(); await vi.waitFor(() => expect(f.frames.some(frame => frame.id === "rm-2")).toBe(true));
  });
  it("a terminal whose open is still waiting for the pane host counts as using its profile, so the removal refuses", async () => {
    const opening = held<never>(); const f = await fixture({ openPaneLink: () => opening.promise as never });
    setRemoteSwitch(f.home, "accounts", true); createRuntimeProfile(f.root, "claude-code", "work");
    f.send({ v: 1, type: "pane.request", id: randomUUID(), maxAgents: 4, request: { action: "open", operationId: randomUUID(), launch: launch("work") } }); await new Promise(done => setTimeout(done, 60));
    const refused = await f.call("accounts.remove", { cli: "claude-code", profile: "work", actor: "admin:u1" }); expect(refused.ok).toBe(false); expect(refused.error).toMatch(/running terminal/); expect(existsSync(join(f.root, "claude-code", "work"))).toBe(true);
    opening.promise.catch(() => {}); opening.reject(new Error("closed"));
  });
});
