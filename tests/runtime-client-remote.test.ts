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
  const http = createServer(), sockets = new WebSocketServer({ server: http }), machineId = randomUUID(), frames: any[] = []; let socket: WebSocket | undefined, hello: any;
  const welcomed = new Promise<void>(done => sockets.on("connection", ws => { socket = ws; ws.on("message", raw => { const frame = JSON.parse(raw.toString()); if (frame.type === "hello") { hello = frame; ws.send(JSON.stringify({ v: 1, type: "welcome", machineId, generation: 1 })); done(); } else frames.push(frame); }); }));
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
  return { client, store, root, home: store.directory, frames, children, hello: () => hello, call, send, machineId };
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
  it("this program's own version information claims remote-signin but never cli-install (nothing installs yet)", () => {
    const info = readRuntimeInfo({ panes: false }); expect(info.capabilities).toContain("remote-signin"); expect(info.capabilities).not.toContain("cli-install");
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
