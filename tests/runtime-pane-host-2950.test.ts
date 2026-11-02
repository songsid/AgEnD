import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimePaneHost, persistentNativeArguments, type RuntimePaneProcess } from "../src/runtime-pane-host.js";
import { RuntimePaneStore, writeNativePaneExit } from "../src/runtime-pane-store.js";
import { RuntimePaneScreen } from "../src/runtime-pane-screen.js";
import { validateRuntimePaneRequest, type RuntimePaneLaunch, type RuntimePaneSnapshot } from "../src/runtime-pane-protocol.js";

const directories: string[] = [];
const screens: RuntimePaneScreen[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); screens.splice(0).forEach(screen => screen.dispose()); directories.splice(0).forEach(dir => rmSync(dir, { force: true, recursive: true })); });
function launch(): RuntimePaneLaunch { return { paneId: randomUUID(), agentId: randomUUID(), instance: "agent-中文", cli: "codex", cwd: "C:\\scratch", sandbox: "read-only", columns: 80, rows: 24 }; }
function fakeProcess() {
  let data: (text: string) => void = () => {};
  let exit: (value: { exitCode: number }) => void = () => {};
  return { pid: 12345, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(() => exit({ exitCode: 0 })),
    onData: (fn: typeof data) => { data = fn; return { dispose() {} }; }, onExit: (fn: typeof exit) => { exit = fn; return { dispose() {} }; },
    emit: (value: string) => data(value), finish: (code: number) => exit({ exitCode: code }) };
}
function setup(max = 4) {
  const directory = mkdtempSync(join(tmpdir(), "agend-pane-host-")); directories.push(directory);
  const store = new RuntimePaneStore(directory);
  const processes: ReturnType<typeof fakeProcess>[] = [];
  const spawn = vi.fn(async () => { const process = fakeProcess(); processes.push(process); return process as RuntimePaneProcess; });
  let online = true, limit = max;
  const host = new RuntimePaneHost({ store, bootId: randomUUID(), online: () => online, maxAgents: () => limit, spawn });
  const open = async (config = launch(), operationId = randomUUID()) => await host.request({ action: "open", launch: config, operationId }) as RuntimePaneSnapshot;
  const key = (snapshot: RuntimePaneSnapshot, sequence: number, operationId = randomUUID()) => ({ action: "key", paneId: snapshot.paneId, launchId: snapshot.launchId, key: "Enter", sequence, operationId });
  return { directory, store, host, processes, spawn, open, key, offline: () => { online = false; }, limit: (value: number) => { limit = value; } };
}

describe("#2950 closed persistent pane protocol", () => {
  it.each(["command", "argv", "env", "executable", "shell"])("refuses arbitrary %s fields", field => {
    expect(() => validateRuntimePaneRequest({ action: "open", operationId: randomUUID(), launch: { ...launch(), [field]: "whoami" } })).toThrow("fields");
  });
  it("refuses terminal escapes in literal input and unbounded/unknown operations", () => {
    const request = { action: "input", paneId: randomUUID(), launchId: randomUUID(), operationId: randomUUID(), sequence: 1, kind: "paste", text: "\x1b[201~execute" };
    expect(() => validateRuntimePaneRequest(request)).toThrow("literal");
    expect(() => validateRuntimePaneRequest({ ...request, text: "x".repeat(65537) })).toThrow("literal");
    expect(() => validateRuntimePaneRequest({ action: "shell", command: "whoami" })).toThrow("Unknown");
    expect(() => validateRuntimePaneRequest({ ...request, text: "safe", sequence: 0 })).toThrow();
  });
  it("constructs configured native CLI arguments with explicit permission policy and no shell", () => {
    const original = launch(), sessionId = randomUUID();
    expect(persistentNativeArguments({ ...original, sessionId })).toContain("resume");
    expect(persistentNativeArguments({ ...original, sessionId })).toContain(sessionId);
    const args = persistentNativeArguments({ ...original, cli: "claude-code", sessionId });
    expect(args).toEqual(["--permission-mode", "default", "--tools", "Read,Glob,Grep", "--resume", sessionId]);
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});

describe("#2950 terminal screen", () => {
  function screen(columns = 80, rows = 24) { const result = new RuntimePaneScreen(columns, rows, () => {}); screens.push(result); return result; }
  it("captures VT cells, Unicode, erase and wrapped logical lines", async () => {
    const terminal = screen(40, 10);
    const long = "https://example.invalid/" + "x".repeat(50);
    await terminal.write("old\r\x1b[2K中文 😀\r\n\x1b[31mred\x1b[0m\r\n" + long);
    const plain = await terminal.capture();
    expect(plain).toContain("中文 😀\nred\n");
    expect(plain).not.toContain("old");
    expect(await terminal.capture({ joined: true })).toContain(long);
    expect(await terminal.capture({ ansi: true })).toContain("\x1b[31m");
  });
  it("handles alternate-screen transitions without confusing scrollback with the current screen", async () => {
    const terminal = screen();
    await terminal.write("history\r\n\x1b[?1049h\x1b[2Jmodal");
    expect(await terminal.capture()).toContain("modal");
    expect(await terminal.capture()).not.toContain("history");
    await terminal.write("\x1b[?1049l");
    expect(await terminal.capture()).toContain("history");
  });
  it("uses bracketed paste only when the CLI requested it and bounds pending parser memory", async () => {
    const terminal = screen();
    expect(terminal.bracketedPaste("x\ny")).toBe("x\ry");
    await terminal.write("\x1b[?2004h");
    expect(terminal.bracketedPaste("x\ny")).toBe("\x1b[200~x\ry\x1b[201~");
    await expect(terminal.write("x".repeat(2 * 1024 * 1024 + 1))).rejects.toThrow("backpressure");
    await expect(terminal.capture()).rejects.toThrow("unavailable");
  });
});

describe("#2950 persistent pane ownership and replay", () => {
  it("reserves per machine before await; lowering a limit stops no running agent", async () => {
    const fixture = setup(2);
    const first = await fixture.open(), second = await fixture.open();
    expect(first.agentId).not.toBe(second.agentId);
    await expect(fixture.open()).rejects.toThrow("limit");
    fixture.limit(1);
    expect(fixture.host.list()).toHaveLength(2);
    expect(fixture.processes.every(process => process.kill.mock.calls.length === 0)).toBe(true);
    await expect(fixture.open()).rejects.toThrow("limit");
  });
  it("parallel opens cannot oversubscribe a single machine slot", async () => {
    const fixture = setup(1);
    const results = await Promise.allSettled([fixture.open(), fixture.open()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(fixture.spawn).toHaveBeenCalledOnce();
  });
  it("keeps an admitted launch alive when its connection drops during native startup", async () => {
    const fixture = setup();
    let release!: (process: RuntimePaneProcess) => void;
    fixture.spawn.mockImplementationOnce(() => new Promise<RuntimePaneProcess>(done => { release = done; }));
    const pending = fixture.open(); await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce());
    const process = fakeProcess(); fixture.offline(); release(process);
    expect((await pending).state).toBe("running"); expect(process.kill).not.toHaveBeenCalled();
    process.finish(0);
  });
  it("joins duplicate opens without starting another CLI and keeps one pane per agent", async () => {
    const fixture = setup(), config = launch(), operationId = randomUUID();
    const first = await fixture.open(config, operationId);
    expect(await fixture.open(config, operationId)).toEqual(first);
    expect(fixture.spawn).toHaveBeenCalledOnce();
    await expect(fixture.open({ ...config, paneId: randomUUID() })).rejects.toThrow("already");
    await expect(fixture.open(config)).rejects.toThrow("another launch");
  });
  it("records a command before writing and duplicate response recovery never repeats Enter", async () => {
    const fixture = setup(), snapshot = await fixture.open();
    const request = fixture.key(snapshot, 1);
    fixture.processes[0].write.mockImplementation(() => {
      expect(new RuntimePaneStore(fixture.directory).get(snapshot.paneId)?.lastCommand?.state).toBe("prepared");
    });
    await fixture.host.request(request);
    await fixture.host.request(request);
    expect(fixture.processes[0].write).toHaveBeenCalledExactlyOnceWith("\r");
    await expect(fixture.host.request(fixture.key(snapshot, 1))).rejects.toThrow("another command");
    await expect(fixture.host.request(fixture.key(snapshot, 3))).rejects.toThrow("gap");
    await expect(fixture.host.request({ ...fixture.key(snapshot, 2), launchId: randomUUID() })).rejects.toThrow("stale");
  });
  it("holds after an ambiguous input failure, accepting no later write", async () => {
    const fixture = setup(), snapshot = await fixture.open();
    fixture.processes[0].write.mockImplementationOnce(() => { throw Error("native pipe failed after acceptance"); });
    const request = fixture.key(snapshot, 1);
    await expect(fixture.host.request(request)).rejects.toThrow("pipe failed");
    await expect(fixture.host.request(request)).rejects.toThrow("unknown");
    await expect(fixture.host.request(fixture.key(snapshot, 2))).rejects.toThrow("unknown");
    expect(fixture.processes[0].write).toHaveBeenCalledOnce();
  });
  it("failed persistence never writes to the CLI", async () => {
    const fixture = setup(), snapshot = await fixture.open();
    vi.spyOn(fixture.store, "put").mockImplementationOnce(() => { throw Error("disk full"); });
    await expect(fixture.host.request(fixture.key(snapshot, 1))).rejects.toThrow("disk full");
    expect(fixture.processes[0].write).not.toHaveBeenCalled();
  });
  it("keeps screens and process identities across a coordinator disconnect; refuses disconnected input", async () => {
    const fixture = setup(), snapshot = await fixture.open();
    fixture.processes[0].emit("READY 中文\r\n");
    const capture = await fixture.host.request({ action: "capture", paneId: snapshot.paneId, launchId: snapshot.launchId }) as any;
    expect(capture.text).toContain("READY 中文");
    expect(capture.snapshot.seq).toBe(1);
    fixture.offline();
    await expect(fixture.host.request(fixture.key(snapshot, 1))).rejects.toThrow("disconnected");
    expect(fixture.host.list()[0].launchId).toBe(snapshot.launchId);
    expect(fixture.processes[0].kill).not.toHaveBeenCalled();
  });
  it("runner restart keeps unknown panes reserved without replay, while other agents may use free slots", async () => {
    const fixture = setup(), config = launch(), operationId = randomUUID();
    await fixture.open(config, operationId);
    const restarted = new RuntimePaneStore(fixture.directory); restarted.recoverInterrupted();
    const spawn = vi.fn(async () => fakeProcess());
    const host = new RuntimePaneHost({ store: restarted, bootId: randomUUID(), online: () => true, maxAgents: () => 4, spawn });
    await expect(host.request({ action: "open", launch: config, operationId })).rejects.toThrow("unknown");
    await expect(host.request({ action: "open", launch: { ...config, paneId: randomUUID() }, operationId: randomUUID() })).rejects.toThrow("already");
    expect(spawn).not.toHaveBeenCalled();
    await host.request({ action: "open", launch: launch(), operationId: randomUUID() });
    expect(spawn).toHaveBeenCalledOnce();
  });
  it("failed native creation remains uncertain because a partial child has not been ruled out", async () => {
    const fixture = setup(); fixture.spawn.mockRejectedValueOnce(Error("partial native startup"));
    await expect(fixture.open()).rejects.toThrow("partial native");
    expect(fixture.host.list()[0].state).toBe("unknown");
  });
  it("only an exact durable helper exit receipt releases a lost runner reservation", async () => {
    const fixture = setup(), snapshot = await fixture.open();
    const record = fixture.store.get(snapshot.paneId)!;
    writeNativePaneExit({ directory: fixture.directory, launchId: snapshot.launchId }, record.launch, record.pid!, 1);
    const restarted = new RuntimePaneStore(fixture.directory); restarted.recoverInterrupted();
    expect(restarted.get(snapshot.paneId)?.snapshot).toMatchObject({ state: "exited", exitCode: 1 });
  });
  it("a different process or agent in an exit receipt holds rather than releasing admission", async () => {
    const fixture = setup(), snapshot = await fixture.open();
    const record = fixture.store.get(snapshot.paneId)!;
    writeNativePaneExit({ directory: fixture.directory, launchId: snapshot.launchId }, record.launch, record.pid! + 1, 0);
    const restarted = new RuntimePaneStore(fixture.directory);
    expect(() => restarted.recoverInterrupted()).toThrow("identity differs");
    expect(restarted.get(snapshot.paneId)?.snapshot.state).toBe("unknown");
  });
  it("compacts exited snapshots without allowing their old open ids to run again", async () => {
    const fixture = setup(), snapshot = await fixture.open(), base = fixture.store.get(snapshot.paneId)!;
    const panes: Record<string, typeof base> = {};
    for (let index = 0; index < 256; index++) {
      const row = structuredClone(base), paneId = randomUUID();
      row.launch.paneId = paneId; row.snapshot.paneId = paneId; row.snapshot.state = "exited";
      row.openDigest = RuntimePaneStore.digest(row.launch); panes[paneId] = row;
    }
    writeFileSync(join(fixture.directory, "panes.json"), JSON.stringify({ version: 1, panes }));
    const first = Object.values(panes)[0], restarted = new RuntimePaneStore(fixture.directory);
    restarted.put(base);
    expect(restarted.list()).toHaveLength(256);
    expect(restarted.get(first.launch.paneId)).toBeUndefined();
    expect(() => restarted.put(first)).toThrow("never be replayed");
  });
  it("positive exit releases admission and retains session/config metadata without storing input", async () => {
    const fixture = setup(1), snapshot = await fixture.open();
    const secretText = "sensitive task text";
    await fixture.host.request({ action: "input", paneId: snapshot.paneId, launchId: snapshot.launchId, operationId: randomUUID(), sequence: 1, kind: "paste", text: secretText });
    expect(readFileSync(join(fixture.directory, "panes.json"), "utf8")).not.toContain(secretText);
    fixture.processes[0].finish(9);
    expect(fixture.host.list()[0]).toMatchObject({ state: "exited", exitCode: 9 });
    await fixture.open();
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
  });
  it("close waits for positive exit and otherwise preserves an unknown reservation", async () => {
    const fixture = setup(), snapshot = await fixture.open();
    fixture.processes[0].kill.mockImplementationOnce(() => {});
    vi.useFakeTimers();
    const close = fixture.host.request({ action: "close", paneId: snapshot.paneId, launchId: snapshot.launchId, operationId: randomUUID(), sequence: 1 });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await close).toMatchObject({ state: "unknown" });
    expect(fixture.host.list()[0].state).toBe("unknown");
  });
});
it('reserves the coordinator-selected launch before issuing an exact helper scope, including before the open ACK',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'agend-pane-scope-'));directories.push(directory);const store=new RuntimePaneStore(directory),bootId=randomUUID(),config={...launch(),launchId:randomUUID(),mcpTools:['reply']};
 const grant=vi.fn((owner,tools)=>{expect(store.get(config.paneId)?.snapshot).toMatchObject(owner);return{endpoint:'http://127.0.0.1:12345/agent',token:'a'.repeat(64),tools,owner};});
 const spawn=vi.fn(async(_launch,owner)=>{expect(owner.mcp.owner).toEqual({hostBootId:bootId,paneId:config.paneId,launchId:config.launchId,agentId:config.agentId,instance:config.instance});return fakeProcess();});
 const host=new RuntimePaneHost({store,bootId,online:()=>true,maxAgents:()=>4,mcpConnection:grant,spawn});
 const pane=await host.request({action:'open',launch:config,operationId:randomUUID()})as RuntimePaneSnapshot;expect(pane.launchId).toBe(config.launchId);expect(grant).toHaveBeenCalledOnce();expect(spawn).toHaveBeenCalledOnce();
 await expect(host.request({action:'open',launch:{...config,paneId:randomUUID(),agentId:randomUUID()},operationId:randomUUID()})).rejects.toThrow('launch identity');await host.stop();
});
