/** Real Daemon/Fleet channel methods; no CLI, socket, service, provider file or account. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Daemon } from "../src/daemon.js";
import { NativeDaemonClient } from "../src/native-daemon-client.js";
import { createNativePaneBackend } from "../src/backend/native-pane.js";
const clean: Array<() => void> = [];
afterEach(() => { for (const f of clean.splice(0).reverse()) f(); vi.restoreAllMocks(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-native-channel-")); clean.push(() => rmSync(dir, { recursive: true, force: true }));
  const backend = createNativePaneBackend("codex", () => ({sessionId:null,contextPercentage:null,statusLineItems:[],resumes:false}));
  const daemon: any = new Daemon("native", {working_directory:"C:\\scratch",backend:"codex",agent_mode:"mcp"} as never, dir, true, backend, undefined, pino({level:"silent"}) as never);
  daemon.setNativePaneLifecycle({backend,host:{executionHost:"remote"},observation:{}} as never);
  let owned = true; const client = new NativeDaemonClient(daemon, () => owned); await client.connect();
  clean.push(() => { void client.close(); });
  return {daemon, client, revoke: () => { owned = false; }};
}
it("the native channel dispatches ordinary messages with the same epoch, wake and raw-paste handlers", async () => {
  const {daemon,client}=await fixture(); const wake=vi.spyOn(daemon,"wake").mockResolvedValue(undefined),push=vi.spyOn(daemon,"pushChannelMessage").mockImplementation(()=>{}),raw=vi.spyOn(daemon,"handleRawPasteIpcMessage").mockImplementation(()=>{}),steer=vi.spyOn(daemon,"steerMessage").mockImplementation(()=>{});
  const meta={message_id:"exact",chat_id:"chat"};expect(client.send({type:"fleet_inbound",content:"hello",meta,delivery_epoch:9})).toBe(true);await Promise.resolve();expect(wake).toHaveBeenCalledOnce();expect(push).toHaveBeenCalledWith("hello",meta,undefined,9);
  expect(client.send({type:"raw_paste",content:"/compact"})).toBe(true);expect(raw).toHaveBeenCalledOnce();expect(client.send({type:"steer",content:"new",meta,delivery_epoch:9})).toBe(true);expect(steer).toHaveBeenCalledWith("new",meta,9);
  expect(client.send({type:"tool_call",tool:"delete_instance"})).toBe(false);expect(client.send({type:"mcp_ready"})).toBe(false);
});
it("reply uses the ordinary pending response and reply guard, without claiming helper stdout ACK",async()=>{
  const {daemon,client}=await fixture(); const frames:any[]=[],written=vi.fn();daemon.on("mcp_tool_response_written",written);
  client.on("message",message=>{frames.push(message);if(message.type==="fleet_outbound")client.send({type:"fleet_outbound_response",fleetRequestId:message.fleetRequestId,result:{message_id:"posted"}});});
  const result=await daemon.handlePaneToolCall({tool:"reply",args:{text:"minimal reply"}},{current:()=>true,allowed:()=>true});
  expect(result).toEqual({result:{message_id:"posted"}});expect(frames).toContainEqual(expect.objectContaining({type:"fleet_outbound",tool:"reply",args:{text:"minimal reply"}}));expect(written).not.toHaveBeenCalled();expect(daemon.pendingIpcRequests.size).toBe(0);
});
it("state and progress use the Fleet channel; queries do not publish external sessions",async()=>{
  const {daemon,client}=await fixture(),frames:any[]=[];client.on("message",frame=>frames.push(frame));
  expect(client.send({type:"query_instance_state",requestId:"query"})).toBe(true);await Promise.resolve();expect(frames).toContainEqual(expect.objectContaining({type:"instance_state_response",requestId:"query",instanceName:"native"}));
  daemon.broadcastFleetMessage({type:"instance_progress",progress:"tool"});expect(frames).toContainEqual({type:"instance_progress",progress:"tool"});expect(client.send({type:"query_sessions"})).toBe(true);expect(frames).toContainEqual({type:"query_sessions_response",sessions:[]});
});
it.each(["owner","stop","freeze","close"])("%s revokes both directions with no late state or tool response",async why=>{
  const f=await fixture(),frames=vi.fn(),raw=vi.spyOn(f.daemon,"handleRawPasteIpcMessage").mockImplementation(()=>{});f.client.on("message",frames);
  let settled=false;f.daemon.pendingIpcRequests.set("old",()=>{settled=true;});
  if(why==="owner")f.revoke();else if(why==="stop")f.daemon.deliveryWritesStopping=true;else if(why==="freeze")f.daemon.runtimeMonitorsFrozen=true;else await f.client.close();
  expect(f.client.send({type:"raw_paste",content:"unowned"})).toBe(false);expect(f.client.send({type:"fleet_outbound_response",fleetRequestId:"old",result:true})).toBe(false);expect(settled).toBe(false);expect(raw).not.toHaveBeenCalled();
  f.daemon.broadcastFleetMessage({type:"instance_progress",progress:"old"});expect(frames).not.toHaveBeenCalled();
});
it("closing an old client permits a new channel but cannot give the old one authority again",async()=>{
 const f=await fixture();await f.client.close();const next=new NativeDaemonClient(f.daemon,()=>true);await next.connect();const old=vi.fn(),fresh=vi.fn();f.client.on("message",old);next.on("message",fresh);f.daemon.broadcastFleetMessage({type:"instance_progress"});expect(old).not.toHaveBeenCalled();expect(fresh).toHaveBeenCalledOnce();expect(f.client.send({type:"query_sessions"})).toBe(false);await next.close();
});
it("a delayed wake cannot deliver through an old native channel after its owner changes",async()=>{
 const f=await fixture();let finish!:()=>void;vi.spyOn(f.daemon,"wake").mockImplementation(()=>new Promise<void>(r=>{finish=r;}));const push=vi.spyOn(f.daemon,"pushChannelMessage").mockImplementation(()=>{}),defer=vi.spyOn(f.daemon,"deferDurableDelivery").mockImplementation(()=>{});
 expect(f.client.send({type:"fleet_inbound",content:"old",meta:{}})).toBe(true);f.revoke();finish();await Promise.resolve();expect(push).not.toHaveBeenCalled();expect(defer).toHaveBeenCalledOnce();
});
it("FleetManager connects its ordinary dispatcher to the current native daemon without a socket or statusline watcher",async()=>{
 const {FleetManager}=await import("../src/fleet-manager.js"),f=await fixture();await f.client.close();const dir=mkdtempSync(join(tmpdir(),"agend-native-fleet-channel-"));clean.push(()=>rmSync(dir,{recursive:true,force:true}));
 const fleet:any=new FleetManager(dir);fleet.daemons.set("native",f.daemon);const state=vi.spyOn(fleet,"cacheInstanceExecutionState").mockImplementation(()=>{}),progress=vi.spyOn(fleet,"cacheInstanceProgress").mockImplementation(()=>{}),watch=vi.spyOn(fleet.statuslineWatcher,"watch").mockImplementation(()=>{throw Error("No coordinator statusline for native CLI");});
 await fleet.connectIpcToInstance("native");const channel=fleet.instanceIpcClients.get("native");expect(channel).toBeInstanceOf(NativeDaemonClient);expect(channel.connected).toBe(true);expect(state).toHaveBeenCalledWith("native",expect.objectContaining({type:"instance_state_response"}));expect(watch).not.toHaveBeenCalled();
 f.daemon.broadcastFleetMessage({type:"instance_progress",progress:"native tool"});expect(progress).toHaveBeenCalledWith("native","native tool");
 const raw=vi.spyOn(f.daemon,"handleRawPasteIpcMessage").mockImplementation(()=>{});expect(await fleet.sendWhenConnected("native",{type:"raw_paste",content:"/compact"})).toBe(true);expect(raw).toHaveBeenCalledOnce();
 fleet.daemons.delete("native");expect(channel.connected).toBe(false);f.daemon.broadcastFleetMessage({type:"instance_progress",progress:"stale"});expect(progress).toHaveBeenCalledTimes(1);await channel.close();
});
