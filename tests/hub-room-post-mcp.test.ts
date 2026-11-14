/** Actual stdio MCP child and owned IPC stub; never starts a Fleet or vendor CLI. */
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IpcServer } from "../src/channel/ipc-bridge.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { mayUseTool, toolsFor } from "../src/tool-permissions.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function harness(profile = "worker") {
  const dir = mkdtempSync(join(tmpdir(), "agend-room-mcp-")), socket = join(dir, "channel.sock");
  const server = new IpcServer(socket); await server.listen();
  const state = { online: false, boot: "boot-1" }, calls: {name:string;args:any;operationId?:string}[] = [];
  const ctx: any = { getDaemonBootId: () => state.boot, hubRoomToolsAvailable: () => state.online,
    hubRoomMembers:vi.fn(async(caller:any,room:string)=>({ok:caller.current(),room,members:[{name:"Alex",presence:"online"}]})),
    hubPeopleSearch:vi.fn(async(caller:any,q:string)=>({ok:caller.current(),q,people:[{name:"Alex",login:"alex"}]})),
    hubRoomList: vi.fn(async (caller:any) => ({ok:true,exposureId:"owned-exposure",rooms:caller.current() ? [{id:"room-A",name:"Weekly"}] : []})),
    hubRoomPost: vi.fn(async (caller:any, value:any) => ({ok:caller.current(),messageId:"message-A",agent:caller.agent,...value})) };
  server.on("message", (message:any, peer:any) => {
    if (message.type !== "tool_call") return;
    calls.push({name:message.tool,args:message.args,operationId:message.operationId});
    const permissionTool = message.tool === "hub_room_status" ? "hub_room_list" : message.tool;
    const respond = (result:any,error?:string) => server.send(peer,{requestId:message.requestId,result,error});
    if (!toolsFor(profile as any).has(permissionTool)) { respond(null,"profile refused"); return; }
    const handler = outboundHandlers.get(message.tool);
    if (!handler) { respond(null,"unknown tool"); return; }
    void handler(ctx,message.args,respond,{instanceName:"agent-A",requestId:message.requestId,fleetRequestId:undefined,
      senderSessionName:undefined,operationId:message.operationId,sourceDaemonBootId:state.boot});
  });
  const transport = new StdioClientTransport({ command:process.execPath,args:["--import","tsx",resolve("src/channel/mcp-server.ts")],
    env:{...process.env as Record<string,string>,AGEND_SOCKET_PATH:socket,AGEND_INSTANCE_NAME:"agent-A",AGEND_TOOL_SET:profile},stderr:"pipe" });
  const client = new Client({name:"room-post-control",version:"1"});
  cleanup.push(async () => { await client.close(); await server.close(); rmSync(dir,{recursive:true,force:true}); });
  await client.connect(transport);
  await vi.waitFor(async () => { await client.listTools(); expect(calls.some(c => c.name === "hub_room_status")).toBe(true); });
  return {client,server,state,calls,ctx};
}
it("actual MCP menu follows connection changes and posts only as its IPC owner", async () => {
  const h = await harness();
  expect((await h.client.listTools()).tools.map(t=>t.name)).not.toContain("hub_room_post");
  h.state.online=true; h.server.broadcast({type:"hub_room_tools_changed"});
  expect((await h.client.listTools()).tools.map(t=>t.name)).toEqual(expect.arrayContaining(["hub_room_list","hub_room_post","hub_room_members","hub_people_search"]));
  const members:any=await h.client.callTool({name:"hub_room_members",arguments:{room:"Weekly"}});
  const people:any=await h.client.callTool({name:"hub_people_search",arguments:{q:"Al"}});
  expect(JSON.parse(members.content[0].text)).toMatchObject({ok:true,members:[{name:"Alex"}]});
  expect(JSON.parse(people.content[0].text)).toMatchObject({ok:true,people:[{login:"alex"}]});
  const result:any = await h.client.callTool({name:"hub_room_post",arguments:{room:"Weekly",text:"Update"}});
  expect(result.isError).not.toBe(true);
  const body=JSON.parse(result.content[0].text);
  expect(body).toMatchObject({agent:"agent-A",room:"Weekly",text:"Update"});
  expect(body.operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(h.ctx.hubRoomPost).toHaveBeenCalledTimes(1);
  const bad:any=await h.client.callTool({name:"hub_room_post",arguments:{room:"Weekly",text:"Update",agent:"agent-B"}});
  expect(bad.isError).toBe(true); expect(h.ctx.hubRoomPost).toHaveBeenCalledTimes(1);
  h.state.online=false; h.server.broadcast({type:"hub_room_tools_changed"});
  expect((await h.client.listTools()).tools.map(t=>t.name)).not.toContain("hub_room_post");
  expect((await h.client.listTools()).tools.map(t=>t.name)).not.toContain("hub_people_search");
  const cached:any=await h.client.callTool({name:"hub_room_post",arguments:{room:"Weekly",text:"Cached"}});
  expect(JSON.parse(cached.content[0].text)).toMatchObject({ok:false,code:"unavailable"});
  expect(h.ctx.hubRoomPost).toHaveBeenCalledTimes(1);
});
it("does not widen the minimal tool profile", () => {
  expect(mayUseTool("minimal","hub_room_post")).toBe(false);
  expect(mayUseTool("worker","hub_room_post")).toBe(true);
  expect(mayUseTool("worker","create_instance")).toBe(false);
});
