/** Actual stdio MCP child and owned IPC socket. No Fleet, CLI, adapter, Hub, account or pane. */
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IpcServer } from "../src/channel/ipc-bridge.js";
const clean: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const f of clean.splice(0).reverse())await f();});
async function world(profile="worker"){
  const home=mkdtempSync(join(tmpdir(),"agend-tools-startup-")),dir=join(home,"instances/agent");mkdirSync(dir,{recursive:true});
  const server=new IpcServer(join(dir,"channel.sock"));await server.listen();
  const state={ready:false,statusCalls:0,changes:0,replyCalls:0},held:((available:boolean)=>void)[]=[],timers=new Set<ReturnType<typeof setTimeout>>(),timings:number[]=[],catalogBytes:number[]=[];
  let delay=true;
  server.on("message",(m:any,peer:any)=>{
    if(m.type==="mcp_ready"){state.ready=true;return;}
    if(m.type!=="tool_call")return;
    const respond=(result:unknown)=>server.send(peer,{requestId:m.requestId,result});
    if(m.tool==="hub_room_status"){
      state.statusCalls++;if(!delay){respond({available:false});return;}
      // A real35-second delayed IPC answer. The list request must finish before this timer or a manual release.
      const timer=setTimeout(()=>{timers.delete(timer);respond({available:false});},35000);timers.add(timer);
      held.push(available=>{clearTimeout(timer);timers.delete(timer);respond({available});});
    }else if(m.tool==="reply"){state.replyCalls++;respond({sent:true});}
  });
  const client=new Client({name:"tools-startup-control",version:"1"});
  client.setNotificationHandler(ToolListChangedNotificationSchema,()=>{state.changes++;});
  clean.push(async()=>{for(const t of timers)clearTimeout(t);await client.close();await server.close();rmSync(home,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:process.execPath,args:["--import","tsx",resolve("src/channel/mcp-server.ts")],
    env:{...process.env as Record<string,string>,AGEND_HOME:home,AGEND_SOCKET_PATH:join(dir,"channel.sock"),AGEND_INSTANCE_NAME:"agent",AGEND_TOOL_SET:profile,AGEND_DASHBOARD_OFF:""},stderr:"pipe"}));
  await vi.waitFor(()=>expect(state.ready).toBe(true));
  const fastList=async()=>{
    const start=performance.now();const value=await client.listTools({}, {timeout:900}).then(data=>({ok:true as const,data}),error=>({ok:false as const,error:String(error)}));
    const elapsed=performance.now()-start;timings.push(elapsed);
    expect(value.ok,JSON.stringify(value)).toBe(true);expect(elapsed).toBeLessThan(1000);
    if(!value.ok)throw Error(value.error);catalogBytes.push(Buffer.byteLength(JSON.stringify(value.data)));return value.data.tools.map(t=>t.name);
  };
  return{client,server,state,held,fastList,timings,catalogBytes,release:(available=false,keepDelay=false)=>{delay=keepDelay;for(const f of held.splice(0))f(available);}};
}
it("returns base and Hub tools in under1s while an independent hub_room_status is delayed35s",async()=>{
  const w=await world();
  // Test-owned diagnostic request: the static menu itself must send no Hub-state request.
  const pending=w.client.callTool({name:"hub_room_status",arguments:{}},undefined,{timeout:40000}).then(result=>({ok:true,result}),error=>({ok:false,error:String(error)}));
  await vi.waitFor(()=>expect(w.state.statusCalls).toBe(1));
  const first=await w.fastList();
  expect(first).toEqual(expect.arrayContaining(["reply","report_result","hub_room_list","hub_room_post","hub_room_members","hub_people_search"]));
  const reply:any=await w.client.callTool({name:"reply",arguments:{text:"Owned protocol control"}},undefined,{timeout:900});
  expect(JSON.parse(reply.content[0].text)).toEqual({sent:true});expect(w.state.replyCalls).toBe(1);
  await w.fastList();expect(w.state.statusCalls).toBe(1);const changed=w.state.changes;
  w.release();expect((await pending).ok).toBe(true);await w.fastList();
  expect(w.state.statusCalls).toBe(1);expect(w.state.changes).toBe(changed);
  if(process.env.AGEND_M3183_EVIDENCE_DIR){mkdirSync(process.env.AGEND_M3183_EVIDENCE_DIR,{recursive:true});writeFileSync(join(process.env.AGEND_M3183_EVIDENCE_DIR,"timings.json"),JSON.stringify({statusDelayMs:35000,listElapsedMs:w.timings,catalogTools:first.length,catalogJsonBytes:w.catalogBytes,testOwnedStatusCalls:1,totalStatusCalls:w.state.statusCalls,replyCalls:w.state.replyCalls,initialNotifications:changed,finalNotifications:w.state.changes},null,2));}
});
it("keeps the menu static across Hub-state notifications without status lookups or menu notifications",async()=>{
  const w=await world(),first=await w.fastList(),changes=w.state.changes;
  expect(first).toContain("hub_room_post");
  for(let n=0;n<3;n++)w.server.broadcast({type:"hub_room_tools_changed"});
  await new Promise(resolve=>setTimeout(resolve,20));expect(await w.fastList()).toEqual(first);
  expect(w.state.statusCalls).toBe(0);expect(w.state.changes).toBe(changes);
});
it("keeps the minimal profile ceiling without asking the Hub during tools/list",async()=>{
  const w=await world("minimal"),names=await w.fastList();
  expect(names).not.toContain("hub_room_post");expect(names).not.toContain("hub_people_search");expect(w.state.statusCalls).toBe(0);
});
