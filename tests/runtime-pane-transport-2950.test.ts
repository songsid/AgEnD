/** Real outbound WebSocket transport; process boundaries are inert, private fixtures. */
import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeClient } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { RuntimePaneHost, type RuntimePaneProcess, type RuntimePaneHostOptions } from "../src/runtime-pane-host.js";
import type { RuntimePaneSnapshot } from "../src/runtime-pane-protocol.js";
import { NativePaneTranscriptReader } from "../src/runtime-pane-transcript.js";
import { PANE_TRANSCRIPT_EMPTY_ANCHOR, validatePaneTranscriptWireBatch } from "../src/runtime-pane-transcript-protocol.js";
import { prepareNativePaneQuotaHistory } from "../src/runtime-pane-quota-history.js";
import { RuntimePanePort } from "../src/runtime-pane-port.js";
import { RuntimeTranscriptSource } from "../src/runtime-transcript-source.js";
import { RuntimeTranscriptDeltaReader } from "../src/runtime-transcript-delta-reader.js";
import { TranscriptMonitor } from "../src/transcript-monitor.js";
import pino from "pino";

const roots: string[] = [], clients: RuntimeClient[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "agend-pane-transport-")); roots.push(path); return path; }
function fakeProcess() {
  let data: (value: string) => void = () => {}, exit: (value: { exitCode: number }) => void = () => {};
  return { pid: 12345, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    kill: vi.fn(() => exit({ exitCode: 0 })), onData: (fn: typeof data) => { data = fn; return { dispose() {} }; },
    onExit: (fn: typeof exit) => { exit = fn; return { dispose() {} }; }, emit: (value: string) => data(value) };
}
async function fixture(overrides: Partial<RuntimePaneHostOptions> = {}) {
  const home = directory(), store = new RuntimeClientStore(directory());
  let hub = new RuntimeCoordinator(home, { requestTimeoutMs: 1000 }); hubs.push(hub);
  const pairing = hub.createPairing(), pending = hub.pair({ code: pairing.code, name: "Pane fixture", platform: "win32" });
  hub.approve(pending.machineId, hub.machine(pending.machineId)!.pairingFingerprint);
  const claim = hub.claim({ machineId: pending.machineId, claimSecret: pending.claimSecret });
  if (claim.status !== "approved") throw Error("Fixture pairing failed");
  const server = createServer(); servers.push(server);
  server.on("upgrade", (request, socket, head) => { if (!hub.handleUpgrade(request, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture port");
  store.saveCredentials({ server: `http://127.0.0.1:${address.port}`, name: "Pane fixture", machineId: claim.machineId, credential: claim.credential });
  const processes: ReturnType<typeof fakeProcess>[] = [];
  const client = new RuntimeClient({ store, reconnectMs: 10, pollMs: 10,
    bridge: { probe: async () => ({ home: "C:\\fixture", clis: [], probedAt: Date.now() }), prepareWorkspace: async () => { throw Error("unused"); },
      start: () => { throw Error("no exec launch"); }, get: () => null, cancel: () => { throw Error("unused"); }, close() {}, releaseUnknown() {} },
    createPaneHost: options => new RuntimePaneHost({ ...options, transcript: (launch, id) => new NativePaneTranscriptReader(launch.cli, launch.cwd, id, { codex: join(home, "codex"), claude: join(home, "claude") }),
      spawn: async () => { const process = fakeProcess(); processes.push(process); return process as RuntimePaneProcess; }, ...overrides }),
  }); clients.push(client); await client.start();
  await vi.waitFor(() => expect(client.online()).toBe(true), { timeout: 5_000 });
  const launch = () => ({ paneId: randomUUID(), agentId: randomUUID(), instance: "pane-agent", cli: "codex" as const, cwd: "C:\\fixture", sandbox: "read-only" as const, columns: 80, rows: 24 });
  const transcript = (id: string, cwd = "C:\\fixture", content = "owned canary") => {
    const dir = join(home, "codex", "sessions", "2026", "11", "03"); mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-test-${id}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n" + JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: content }] } }) + "\n");
    return path;
  };
  return { store, client, processes, machineId: claim.machineId, launch,
    hub: () => hub, restart: () => { hub.close(); hub = new RuntimeCoordinator(home, { requestTimeoutMs: 1000 }); hubs.push(hub); }, home, transcript };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const cursor = (sessionId: string) => ({ sessionId, offset: 0, fileId: null, anchor: PANE_TRANSCRIPT_EMPTY_ANCHOR });
it("explicit remote switch-off refuses live work, then shuts an empty host and allows a new host on switch-on", async () => {
  const f = await fixture(), first = await f.hub().callPane(f.machineId, { action: "open", operationId: randomUUID(), launch: f.launch() }) as RuntimePaneSnapshot;
  await expect(f.hub().shutdownPaneHosts()).rejects.toThrow("shutdown");
  expect(f.processes[0].kill).not.toHaveBeenCalled(); expect(f.processes[0].write).not.toHaveBeenCalled();
  await f.hub().callPane(f.machineId, { action: "close", paneId: first.paneId, launchId: first.launchId, sequence: 1, operationId: randomUUID() });
  await f.hub().shutdownPaneHosts();
  const next = await f.hub().callPane(f.machineId, { action: "open", operationId: randomUUID(), launch: f.launch() }) as RuntimePaneSnapshot;
  expect(next.state).toBe("running"); expect(next.launchId).not.toBe(first.launchId); expect(f.processes).toHaveLength(2);
});
it("a lost shutdown response cannot leave a closed host cached for the next enabled start", async () => {
  const f = await fixture(), inventory = await f.hub().callPane(f.machineId, { action: "list" }) as any;
  const client:any=f.client, send=client.send.bind(client);
  const dropped=vi.spyOn(client,"send").mockImplementation((frame:any)=>{
    if(frame.type==="pane.response"&&frame.ok&&frame.result?.shutdown===true)return;
    send(frame);
  });
  await expect(f.hub().callPane(f.machineId,{action:"shutdown",hostBootId:inventory.hostBootId})).rejects.toThrow("timed out");
  dropped.mockRestore();
  expect(await f.hub().callPane(f.machineId,{action:"open",operationId:randomUUID(),launch:f.launch()})).toMatchObject({state:"running",reattached:false});
  expect(f.processes).toHaveLength(1);
});
it("binds only a unique owned status id, reads its exact native transcript, and keeps paths out of the wire", async () => {
  const f = await fixture(), sessionId = randomUUID(), pane = await f.hub().callPane(f.machineId, { action: "open", operationId: randomUUID(), launch: f.launch() }) as RuntimePaneSnapshot;
  const target = { paneId: pane.paneId, launchId: pane.launchId };
  await expect(f.hub().callPane(f.machineId, { action: "bind-session", ...target, sessionId })).rejects.toThrow("no unique");
  f.processes[0].emit(`Session: ${sessionId}\r\n`);
  expect(await f.hub().callPane(f.machineId, { action: "bind-session", ...target, sessionId })).toMatchObject({ sessionId, commandSequence: 0 });
  f.transcript(sessionId); const result = validatePaneTranscriptWireBatch(await f.hub().callPane(f.machineId, { action: "transcript", ...target, cursor: cursor(sessionId) }), sessionId);
  expect(result).toMatchObject({ state: "ready", gap: false, complete: true }); expect(Buffer.from(result.data, "base64").toString()).toContain("owned canary"); expect(JSON.stringify(result)).not.toContain(f.home);
  await expect(f.hub().callPane(f.machineId, { action: "bind-session", ...target, sessionId: randomUUID() })).rejects.toThrow("pinned elsewhere");
  await expect(f.hub().callPane(f.machineId, { action: "transcript", ...target, cursor: cursor(randomUUID()) })).rejects.toThrow("differs from its owned pane");
  await expect(f.hub().callPane(f.machineId, { action: "transcript", ...target, cursor: cursor(sessionId), path: "/tmp/unowned" } as never)).rejects.toThrow();
  expect(f.processes[0].write).not.toHaveBeenCalled(); expect(JSON.parse(readFileSync(join(f.home, "runtime-machines.json"), "utf8")).commands).toHaveLength(0);
});
it("refuses ambiguous status cards and a correct filename with another workspace's metadata", async () => {
  const f = await fixture(), id = randomUUID(), launch = f.launch(), pane = await f.hub().callPane(f.machineId, { action: "open", operationId: randomUUID(), launch }) as RuntimePaneSnapshot;
  const target = { paneId: pane.paneId, launchId: pane.launchId }; f.processes[0].emit(`Session: ${id}\r\nSession: ${randomUUID()}\r\n`);
  await expect(f.hub().callPane(f.machineId, { action: "bind-session", ...target, sessionId: id })).rejects.toThrow("no unique");
  expect((await f.hub().callPane(f.machineId, { action: "list" }) as any).panes[0].sessionId).toBeUndefined();
  f.processes[0].emit(`\x1b[2J\x1b[HSession: ${id}\r\n`); await f.hub().callPane(f.machineId, { action: "bind-session", ...target, sessionId: id });
  f.transcript(id, "C:\\another-workspace"); await expect(f.hub().callPane(f.machineId, { action: "transcript", ...target, cursor: cursor(id) })).rejects.toThrow("metadata differs");
});
it("retains the same pin and cursor across a coordinator reconnect without repeating input", async () => {
  const f = await fixture(), id = randomUUID(), launch = { ...f.launch(), sessionId: id }, operationId = randomUUID();
  const epoch=f.hub().paneTransportEpoch(f.machineId);expect(epoch).not.toBeNull();
  const pane = await f.hub().callPane(f.machineId, { action: "open", operationId, launch }) as RuntimePaneSnapshot; f.transcript(id);
  const request = { action: "transcript" as const, paneId: pane.paneId, launchId: pane.launchId, cursor: cursor(id) }, first = validatePaneTranscriptWireBatch(await f.hub().callPane(f.machineId, request), id);
  f.restart(); await vi.waitFor(() => expect(f.hub().machine(f.machineId)?.status).toBe("online"));expect(f.hub().paneTransportEpoch(f.machineId)).not.toBe(epoch);
  expect(await f.hub().callPane(f.machineId, { action: "open", operationId, launch })).toMatchObject({ launchId: pane.launchId, sessionId: id });
  const next = validatePaneTranscriptWireBatch(await f.hub().callPane(f.machineId, { ...request, cursor: first.cursor }), id); expect(next.data).toBe(""); expect(next.cursor).toEqual(first.cursor); expect(f.processes).toHaveLength(1); expect(f.processes[0].write).not.toHaveBeenCalled();
});

it("uses independent persistent panes and keeps high-frequency captures out of the exec journal", async () => {
  const f = await fixture();
  expect(f.hub().machine(f.machineId)?.paneProtocol).toBe(1);
  const first = await f.hub().callPane(f.machineId, { action: "open", operationId: randomUUID(), launch: f.launch() }, 2) as RuntimePaneSnapshot;
  const second = await f.hub().callPane(f.machineId, { action: "open", operationId: randomUUID(), launch: f.launch() }, 2) as RuntimePaneSnapshot;
  expect(second.launchId).not.toBe(first.launchId);
  expect(f.processes).toHaveLength(2);
  f.processes[0].emit("READY 第一個\r\n"); f.processes[1].emit("READY 第二個\r\n");
  for (let index = 0; index < 10; index++) {
    const result = await f.hub().callPane(f.machineId, { action: "capture", paneId: first.paneId, launchId: first.launchId }) as any;
    expect(result.text).toContain("READY 第一個");
    expect(result.text).not.toContain("第二個");
  }
  expect(JSON.parse(readFileSync(join(f.home, "runtime-machines.json"), "utf8")).commands).toHaveLength(0);
});
it("lost reply and coordinator reconnect never replay Enter or open a second process", async () => {
  const f = await fixture(), launch = f.launch(), operationId = randomUUID();
  const first = await f.hub().callPane(f.machineId, { action: "open", operationId, launch }) as RuntimePaneSnapshot;
  const key = { action: "key" as const, paneId: first.paneId, launchId: first.launchId, key: "Enter" as const, expectedSeq: first.seq, operationId: randomUUID(), sequence: 1 };
  const send = (f.client as any).send.bind(f.client);
  let dropped = false;
  const spy = vi.spyOn(f.client as any, "send").mockImplementation((value: any) => {
    if (value.type === "pane.response" && !dropped) { dropped = true; return; }
    send(value);
  });
  await expect(f.hub().callPane(f.machineId, key)).rejects.toThrow("timed out");
  spy.mockRestore();
  expect(f.processes[0].write).toHaveBeenCalledExactlyOnceWith("\r");
  f.restart();
  await vi.waitFor(() => expect(f.hub().machine(f.machineId)?.status).toBe("online"));
  await f.hub().callPane(f.machineId, key);
  const resumed = await f.hub().callPane(f.machineId, { action: "open", operationId, launch }) as RuntimePaneSnapshot;
  expect(resumed.launchId).toBe(first.launchId);
  expect(resumed.commandSequence).toBe(1);
  expect(f.processes).toHaveLength(1);
  expect(f.processes[0].write).toHaveBeenCalledOnce();
});
it('feeds the ordinary monitor and positive delivery proof through the authenticated runtime channel',async()=>{
 const f=await fixture(),id=randomUUID(),launch={...f.launch(),sessionId:id};
 const port=new RuntimePanePort({machineId:f.machineId,online:()=>f.hub().machine(f.machineId)?.status==='online',call:request=>f.hub().callPane(f.machineId,request),subscribe:listener=>f.hub().subscribe(listener)},join(f.home,'coordinator-pane.json'),launch);
 await port.open();const path=f.transcript(id),source=new RuntimeTranscriptSource(port,port.runtimeTranscriptReference(cursor(id)));await source.initialize();
 const monitor=new TranscriptMonitor(f.home,pino({level:'silent'})as never,source),use=vi.fn(),text=vi.fn(),turns=vi.fn();monitor.on('tool_use',use);monitor.on('assistant_text',text);monitor.on('turns',turns);
 try{
  const checkpoint=await monitor.reconciliationRuntimeCheckpoint();expect(checkpoint).not.toBeNull();const delivery=randomUUID(),reader=new RuntimeTranscriptDeltaReader(port,checkpoint!,delivery);
  const records=[{type:'event_msg',payload:{type:'task_started',turn_id:'owned'}},{type:'response_item',timestamp:'2026-11-03T00:00:00Z',payload:{type:'message',role:'user',content:[{type:'input_text',text:`[agend-delivery-id:${delivery}] task`}]}},{type:'response_item',payload:{type:'function_call',name:'read',arguments:'{"path":"canary"}'}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]}},{type:'event_msg',payload:{type:'task_complete',turn_id:'owned',last_agent_message:'done'}}];
  appendFileSync(path,records.map(record=>JSON.stringify(record)+'\n').join(''));expect(await reader.look()).toBe('user');await monitor.pollIncrement();
  expect(use).toHaveBeenCalledExactlyOnceWith('read',{path:'canary'});expect(text).toHaveBeenCalledExactlyOnceWith('done');expect(turns).toHaveBeenCalledOnce();expect(turns.mock.calls[0][0].map((event:any)=>event.kind)).toEqual(['start','user','end']);expect(monitor.currentPath()).toBeNull();expect(f.processes[0].write).not.toHaveBeenCalled();
 }finally{monitor.stop();}
});
it('streams only the owned pane raw output into its ordinary diagnostic log across the authenticated channel',async()=>{
 const f=await fixture(),launch=f.launch(),port=new RuntimePanePort({machineId:f.machineId,online:()=>f.hub().machine(f.machineId)?.status==='online',call:request=>f.hub().callPane(f.machineId,request),subscribe:listener=>f.hub().subscribe(listener)},join(f.home,'output-pane.json'),launch);await port.open();const path=join(f.home,'output.log');
 try{await port.pipeOutput(path);f.processes[0].emit('\x1b[31mowned 中文\x1b[0m\r\n');await vi.waitFor(()=>expect(readFileSync(path,'utf8')).toBe('\x1b[31mowned 中文\x1b[0m\r\n'));
  const other=await f.hub().callPane(f.machineId,{action:'open',operationId:randomUUID(),launch:f.launch()}) as RuntimePaneSnapshot;f.processes[1].emit('other pane private output\r\n');await new Promise(resolve=>setTimeout(resolve,550));expect(readFileSync(path,'utf8')).not.toContain('other pane');
  await expect(f.hub().callPane(f.machineId,{action:'output',paneId:launch.paneId,launchId:other.launchId,offset:0})).rejects.toThrow('stale');expect(f.processes[0].write).not.toHaveBeenCalled();
 }finally{port.closeOutput();}
});
it("a dead paired host link is rediscovered only on the next independent request",async()=>{
 const f=await fixture(),client:any=f.client;client.options.createPaneHost=undefined;
 let connected=true;const firstBoot=randomUUID(),nextBoot=randomUUID();
 const oldRequest=vi.fn(async()=>({hostBootId:firstBoot,panes:[]})),nextRequest=vi.fn(async()=>({hostBootId:nextBoot,panes:[]}));
 const open=client.options.openPaneLink=vi.fn().mockResolvedValueOnce({connected:()=>connected,request:oldRequest,stop:async()=>{}}).mockResolvedValueOnce({connected:()=>true,request:nextRequest,stop:async()=>{}});
 expect(await f.hub().callPane(f.machineId,{action:'list'})).toMatchObject({hostBootId:firstBoot});connected=false;
 expect(await f.hub().callPane(f.machineId,{action:'list'})).toMatchObject({hostBootId:nextBoot});
 expect(open).toHaveBeenCalledTimes(2);expect(oldRequest).toHaveBeenCalledOnce();expect(nextRequest).toHaveBeenCalledOnce();expect(f.processes).toHaveLength(0);
});
it("a rejected paired host attachment cannot poison later independent discoveries",async()=>{
 const f=await fixture(),client:any=f.client;client.options.createPaneHost=undefined;
 const boot=randomUUID(),request=vi.fn(async()=>({hostBootId:boot,panes:[]}));
 const open=client.options.openPaneLink=vi.fn().mockRejectedValueOnce(Error('attachment failed')).mockResolvedValueOnce({connected:()=>true,request,stop:async()=>{}});
 await expect(f.hub().callPane(f.machineId,{action:'list'})).rejects.toThrow('attachment failed');expect(request).not.toHaveBeenCalled();
 expect(await f.hub().callPane(f.machineId,{action:'list'})).toMatchObject({hostBootId:boot});expect(open).toHaveBeenCalledTimes(2);expect(request).toHaveBeenCalledOnce();
});

it("paired-PC capture carries only its frozen quota proof; append and reconnect never create another baseline", async () => {
  const root = directory(), codex = join(root, "codex"), folder = join(codex, "sessions"), id = randomUUID(), message = "You've hit your usage limit. Old reset.";
  mkdirSync(folder, { recursive: true }); const path = join(folder, `rollout-test-${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id, cwd: "C:\\fixture", source: "cli" } }) + "\n"
    + JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "task_complete", turn_id: "old", error: { message, codex_error_info: "usage_limit_exceeded" } } }) + "\n");
  const spawned: ReturnType<typeof fakeProcess>[] = [], spawn = vi.fn(async (launch: import("../src/runtime-pane-protocol.js").RuntimePaneLaunch) => {
    const quotaReplay = await prepareNativePaneQuotaHistory(launch, () => new NativePaneTranscriptReader("codex", launch.cwd, id, { codex, claude: join(root, "unused") }));
    const process = Object.assign(fakeProcess(), { ...(quotaReplay ? { quotaReplay } : {}) }); spawned.push(process); return process;
  });
  const f = await fixture({ spawn }), launch = { ...f.launch(), sessionId: id };
  const port = new RuntimePanePort({ machineId: f.machineId, online: () => f.hub().machine(f.machineId)?.status === "online",
    call: request => f.hub().callPane(f.machineId, request), subscribe: listener => f.hub().subscribe(listener) }, join(f.home, "quota-pane.json"), launch);
  await port.open(); spawned[0].emit(`■ ${message}\r\n› Ask Codex to do anything\r\n  Context 100% left`);
  expect(await port.capturePane()).toContain(message); const proof = port.quotaReplayHistory();
  expect(proof?.messages).toEqual([message]); expect(proof?.current()).toBe(true); expect(JSON.stringify(proof)).not.toContain(path);
  spawned[0].emit("\r\nnew output"); await port.getPaneStatus(); expect(proof?.current()).toBe(false);
  await port.capturePane(); expect(port.quotaReplayHistory()?.current()).toBe(true);
  appendFileSync(path, '{"type":"event_msg"}\n'); await port.capturePane();
  expect(proof?.current()).toBe(false); expect(port.quotaReplayHistory()).toBeNull();
  expect((await port.open()).reattached).toBe(true); await port.capturePane(); expect(port.quotaReplayHistory()).toBeNull();
  expect(spawn).toHaveBeenCalledOnce(); expect(spawned[0].write).not.toHaveBeenCalled();
});
