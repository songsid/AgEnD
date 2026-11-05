/** Remote runtimes retain M-2239 P1-2: detection requires an administrator's explicit press. */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
import { RuntimeWindowsBridge, type RuntimeExecutionCoordinator } from "../src/runtime-windows-bridge.js";
import { WindowsCliBridge, WINDOWS_CLI_INVENTORY_FILE, type WindowsCliProbe } from "../src/windows-cli.js";

const directories: string[] = [], clients: RuntimeClient[] = [];
const cached: WindowsCliProbe = { home: "C:\\Users\\fixture", clis: [], probedAt: 12345 };
function home() { const dir = mkdtempSync(join(tmpdir(), "agend-runtime-detection-")); directories.push(dir); return dir; }
class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING; bufferedAmount = 0;
  readonly frames: any[] = [];
  send(text: string) { this.frames.push(JSON.parse(text)); }
  open(machineId: string) {
    this.readyState = WebSocket.OPEN; this.emit("open");
    this.emit("message", Buffer.from(JSON.stringify({v:1,type:"welcome",machineId,generation:1})), false);
  }
  close(code = 1000) { this.readyState = WebSocket.CLOSED; this.emit("close", code); }
  terminate() { this.close(); }
}
function bridge() {
  return { probe: vi.fn(async () => structuredClone(cached)), prepareWorkspace: vi.fn(async () => "C:\\fixture"),
    start: vi.fn(() => { throw Error("Detection policy tests never execute a CLI"); }), get: () => null,
    cancel: () => { throw Error("No fixture task"); }, close() {}, releaseUnknown() {} } satisfies RuntimeBridge;
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const dir of directories.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe detection fixture cleanup");
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runtime detection admission", () => {
  it("starts and reconnects with cached inventory, never detects on a timer, and detects only for force:true", async () => {
    vi.useFakeTimers();
    const store = new RuntimeClientStore(home()), machineId = randomUUID(), worker = bridge(), sockets: Socket[] = [];
    store.saveCredentials({server:"http://127.0.0.1:1",machineId,credential:"c".repeat(64),name:"Fixture"});
    const client = new RuntimeClient({store,bridge:worker,reconnectMs:25,socketFactory:()=>{
      const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket;
    }}); clients.push(client);
    await client.start(); sockets[0].open(machineId);
    expect(client.online()).toBe(true); expect(worker.probe).toHaveBeenCalledExactlyOnceWith({force:false});
    const report=sockets[0].frames.find(frame=>frame.type==="hello").runtimeInfo;
    expect(report).toBeDefined();expect(report).toMatchObject({protocolVersions:[1],capabilities:["exec","mcp"]});expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(worker.probe).toHaveBeenCalledTimes(1);
    sockets[0].close(1006); await vi.advanceTimersByTimeAsync(25); sockets[1].open(machineId);
    expect(sockets[1].frames.find(frame => frame.type === "hello").inventory).toEqual(cached);
    expect(worker.probe).toHaveBeenCalledTimes(1);
    expect(await client.operation("probe", {})).toEqual(cached);
    expect(worker.probe).toHaveBeenLastCalledWith({force:false});
    expect(await client.operation("probe", {force:true})).toEqual(cached);
    expect(worker.probe).toHaveBeenLastCalledWith({force:true});
    await expect(client.operation("probe", {force:"yes"})).rejects.toThrow("Invalid discovery request");
    expect(worker.probe).toHaveBeenCalledTimes(3); expect(worker.start).not.toHaveBeenCalled();
  });
  it("loads the default bridge's detection from this private runtime profile after each restart", async () => {
    const directory = home();
    writeFileSync(join(directory, WINDOWS_CLI_INVENTORY_FILE), JSON.stringify(cached));
    for (let restart = 0; restart < 2; restart++) {
      const client = new RuntimeClient({store:new RuntimeClientStore(directory)}); clients.push(client);
      expect(await client.operation("probe", {})).toEqual(cached);
    }
    const fresh = new RuntimeClient({store:new RuntimeClientStore(home())}); clients.push(fresh);
    expect(await fresh.operation("probe", {})).toEqual({clis:[],home:"",probedAt:null});
  });
  it("keeps absent and cached remote inventory reads local, forwarding force only for explicit detection", async () => {
    const machineId = randomUUID();
    const machine: {status:string;platform:string;inventory?:WindowsCliProbe} = {status:"online",platform:"win32"};
    const call = vi.fn(async () => structuredClone(cached));
    const remote: RuntimeExecutionCoordinator = {machine:()=>machine,call,task:()=>null,hasActiveTask:()=>false,subscribe:()=>()=>{}};
    const local = new WindowsCliBridge(async () => { throw Error("No worker may start for an inventory read"); });
    const router = new RuntimeWindowsBridge({},()=>remote,local);
    try {
      expect(await router.probe({machineId})).toEqual({clis:[],home:"",probedAt:null}); expect(call).not.toHaveBeenCalled();
      machine.inventory = structuredClone(cached);
      const result = await router.probe({machineId}); result.clis.push({} as never);
      expect(machine.inventory).toEqual(cached); expect(call).not.toHaveBeenCalled();
      expect(await router.probe({machineId,force:true})).toEqual(cached);
      expect(call).toHaveBeenCalledExactlyOnceWith(machineId,"probe",{force:true});
    } finally { router.close(); }
  });
});
