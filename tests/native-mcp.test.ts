import {randomUUID} from "node:crypto";
import {captureRequestContextCall} from "../src/request-context-call.js";
import {assertRequestContextOperation} from "../src/request-context-policy.js";
import { PassThrough } from "node:stream";
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve,sep } from "node:path";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { NativeMcpSessions } from "../src/native-mcp.js";
import { handleAgentRequest } from "../src/agent-endpoint.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { bindGatewayRequest } from "../src/web-request-context.js";

const name="windows-12345678-1234-4321-abcd-123456789012";
const agentId="12345678-1234-4321-abcd-123456789012",requestId="12345678-1234-4321-abcd-123456789013";
const managers:NativeMcpSessions[]=[],homes:string[]=[];
beforeEach(()=>vi.stubEnv("AGEND_WINDOWS_CLI","1"));
afterEach(()=>{
  for(const manager of managers.splice(0))manager.closeAll();
  for(const home of homes.splice(0)){if(!resolve(home).startsWith(resolve(tmpdir())+sep))throw Error("Unsafe temporary path");rmSync(home,{recursive:true,force:true});}
  vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();
});
function fixture(sandbox:"read-only"|"workspace-write"="workspace-write",configuredSandbox=sandbox,inputReady?:()=>Promise<boolean>) {
  const state={current:true};
  const config={runtime:"windows",native_agent_id:agentId,backend:"codex",native_sandbox:configuredSandbox,tool_set:"worker",working_directory:"C:\\Work"};
  const ctx:any={fleetConfig:{instances:{[name]:config}},dataDir:"unused",logger:{info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn()},
    handleTaskCrudHttp:vi.fn(async(_instance:string,args:Record<string,unknown>)=>({action:args.action,items:[]}))};
  const manager=new NativeMcpSessions(ctx);managers.push(manager);ctx.nativeMcpSessions=()=>manager;
  const lease=manager.grant({instance:name,requestId,sandbox,endpoint:"http://127.0.0.1:19280/agent",stillCurrent:()=>state.current,...(inputReady?{inputReady}:{})});
  return {state,config,ctx,manager,lease};
}
function invoke(f:ReturnType<typeof fixture>,body:unknown,options:{headers?:Record<string,string|string[]|undefined>;remote?:string;hold?:boolean;gateway?:boolean}={}) {
  const req=Object.assign(new PassThrough(),{method:"POST",url:"/agent",headers:{"x-agend-native-token":f.lease.connection.token,...options.headers},socket:{remoteAddress:options.remote ?? "127.0.0.1"}});
  if(options.gateway)bindGatewayRequest(req as never,{surface:"gateway",named:false,exposureId:"test",expectedOrigin:"https://test.invalid",isCurrent:()=>true});
  let status=0,value:any;const res:any={destroyed:false,writableEnded:false,writeHead(code:number){status=code;return res;},end(text:string){value=JSON.parse(text);res.writableEnded=true;}};
  handleAgentRequest(req as never,res,f.ctx);
  if(!options.hold)req.end(JSON.stringify(body));
  return {req,status:()=>status,value:()=>value,done:async()=>{await vi.waitFor(()=>expect(status).not.toBe(0));return {status,value};}};
}
const listing={op:"native-mcp",method:"tools/list",params:{}};
const call=(id:string,tool="task",args:Record<string,unknown>={action:"list"})=>({op:"native-mcp",method:"tools/call",callId:id,params:{name:tool,arguments:args}});

describe("native MCP capabilities and live menus",()=>{
  it("grants one ephemeral child capability and exposes only the supported profile-filtered tools",async()=>{
    const f=fixture();expect(f.lease.connection.token).toMatch(/^[a-f0-9]{64}$/);expect(f.manager.hasActive(name)).toBe(true);
    const {status,value}=await invoke(f,listing).done();expect(status).toBe(200);
    expect(value.tools.map((tool:any)=>tool.name).sort()).toEqual(["list_instances","describe_instance","task","send_to_instance","delegate_task","request_information","report_result","delivery_status","hub_room_list","hub_room_post","hub_room_members","hub_people_search","hub_set_intro"].sort());
    expect(f.lease.connection.tools.sort()).toEqual(value.tools.map((tool:any)=>tool.name).sort());
    expect(value.tools.find((tool:any)=>tool.name==="task").annotations.readOnlyHint).toBe(false);
    expect(value.tools.find((tool:any)=>tool.name==="delegate_task").annotations.readOnlyHint).toBe(false);
    expect(value.tools.find((tool:any)=>tool.name==="list_instances").annotations.readOnlyHint).toBe(true);
    expect(()=>f.manager.grant({instance:name,requestId,sandbox:"workspace-write",endpoint:f.lease.connection.endpoint,stillCurrent:()=>true})).toThrow(/active/);
  });
  it("restricts read-only tools and the task action schema, and rejects guessed writes",async()=>{
    const f=fixture("read-only"),{value}=await invoke(f,listing).done();
    expect(value.tools.map((tool:any)=>tool.name).sort()).toEqual(["list_instances","describe_instance","task","delivery_status","hub_room_list","hub_room_members","hub_people_search"].sort());
    expect(value.tools.find((tool:any)=>tool.name==="task").inputSchema.properties.action.enum).toEqual(["list","get","mine","projects"]);
    expect(value.tools.every((tool:any)=>tool.annotations.readOnlyHint===true)).toBe(true);
    expect((await invoke(f,call("write","task",{action:"create",title:"Must not create"})).done()).status).toBe(403);
    expect((await invoke(f,call("send","send_to_instance",{instance_name:"other",message:"Must not send"})).done()).status).toBe(403);
    expect(f.ctx.handleTaskCrudHttp).not.toHaveBeenCalled();
  });
  it("requires a new lease after policy publication while retaining the original read-only ceiling",async()=>{
    const f=fixture("read-only","workspace-write");
    expect((await invoke(f,call("upgrade","task",{action:"create",title:"No"})).done()).status).toBe(403);
    const grant=()=>f.manager.grant({instance:name,requestId,sandbox:"read-only",endpoint:f.lease.connection.endpoint,stillCurrent:()=>f.state.current});
    f.config.tool_set="minimal";
    expect((await invoke(f,listing).done()).status).toBe(401);
    f.lease=grant();
    expect((await invoke(f,listing).done()).value.tools.map((tool:any)=>tool.name)).toEqual(["delivery_status"]);
    expect((await invoke(f,call("guessed")).done()).status).toBe(403);
    f.config.tool_set="worker";f.ctx.fleetConfig.instances[name].dashboard={task_board:false};
    expect((await invoke(f,listing).done()).status).toBe(401);
    f.lease=grant();
    expect((await invoke(f,listing).done()).value.tools.some((tool:any)=>tool.name==="task")).toBe(false);
    expect((await invoke(f,call("disabled")).done()).status).toBe(403);
  });
  it("revokes on owner loss, profile replacement, close and expiry without durable credentials",async()=>{
    const f=fixture();f.state.current=false;
    expect((await invoke(f,listing).done()).status).toBe(401);expect(f.manager.hasActive(name)).toBe(false);
    const replaced=fixture();replaced.config.native_agent_id="12345678-1234-4321-abcd-123456789099";
    expect((await invoke(replaced,listing).done()).status).toBe(401);
    const closed=fixture();closed.lease.close();expect((await invoke(closed,listing).done()).status).toBe(401);
    vi.useFakeTimers();const expired=fixture();vi.advanceTimersByTime(6*60_000+1);expect(expired.manager.hasActive(name)).toBe(false);
  });
  it.each(["http://example.com/agent","http://127.0.0.1:19280/ui/send","http://user:password@localhost/agent","https://localhost/agent","http://localhost/agent?token=secret"])("refuses a non-local or credential-bearing endpoint %s",address=>{
    const f=fixture();f.lease.close();expect(()=>f.manager.grant({instance:name,requestId,sandbox:"workspace-write",endpoint:address,stillCurrent:()=>true})).toThrow(/endpoint/);
  });
});

describe("Hub room native MCP scope",()=>{
  it("keeps offline/online menus static while preserving the native read-only ceiling",async()=>{
    const f=fixture();let online=false;f.ctx.hubRoomToolsAvailable=()=>online;
    const names=(await invoke(f,listing).done()).value.tools.map((t:any)=>t.name);
    expect(names).toEqual(expect.arrayContaining(["hub_room_list","hub_room_post","hub_room_members","hub_people_search"]));
    expect(f.lease.connection.tools).toEqual(expect.arrayContaining(names));
    online=true;expect((await invoke(f,listing).done()).value.tools.map((t:any)=>t.name)).toEqual(names);
    online=false;expect((await invoke(f,listing).done()).value.tools.map((t:any)=>t.name)).toEqual(names);
    const read=fixture("read-only");read.ctx.hubRoomToolsAvailable=()=>true;
    expect((await invoke(read,listing).done()).value.tools.map((t:any)=>t.name)).toContain("hub_room_list");
    expect((await invoke(read,call("post","hub_room_post",{room:"Weekly",text:"No"})).done()).status).toBe(403);
  });
  it.each([
    ["hub_room_list",{}],["hub_room_post",{room:"Weekly",text:"Hello"}],
    ["hub_room_members",{room:"Weekly"}],["hub_people_search",{q:"Alex"}],
  ])("%s remains visible offline but refuses at dispatch without a remote call",async(tool,args)=>{
    const f=fixture();let online=false;f.ctx.hubRoomToolsAvailable=()=>online;
    const remote=vi.fn(async()=>({ok:true,rows:[]}));
    f.ctx.hubRoomList=remote;f.ctx.hubRoomPost=remote;f.ctx.hubRoomMembers=remote;f.ctx.hubPeopleSearch=remote;
    const {status,value}=await invoke(f,call("offline-"+tool,tool as string,args as Record<string,unknown>)).done();
    expect(status).toBe(200);expect(JSON.parse(value.content[0].text)).toMatchObject({ok:false,code:"unavailable",message:"This Fleet isn't connected to a Hub."});
    expect(remote).not.toHaveBeenCalled();
    online=true;const active=await invoke(f,call("online-"+tool,tool as string,args as Record<string,unknown>)).done();
    expect(active.status).toBe(200);expect(JSON.parse(active.value.content[0].text)).toMatchObject({ok:true});expect(remote).toHaveBeenCalledOnce();
  });
  it("retains post operation identity and retires the exact native caller during a suspended call",async()=>{
    const f=fixture();f.ctx.hubRoomToolsAvailable=()=>true;
    let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});
    let captured:(()=>boolean)|undefined;const values:any[]=[];
    f.ctx.hubRoomPost=vi.fn(async(caller:any,value:any)=>{captured=caller.current;values.push(value);await wait;return {ok:caller.current(),code:"uncertain"};});
    const input=call("same-post","hub_room_post",{room:"Weekly",text:"Frozen"});
    const first=invoke(f,input);await vi.waitFor(()=>expect(values).toHaveLength(1));
    const duplicate=invoke(f,input);expect(values[0].operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(captured?.()).toBe(true);f.state.current=false;expect(captured?.()).toBe(false);release();
    expect((await first.done()).status).toBe(401);expect((await duplicate.done()).status).toBe(401);
    expect(f.ctx.hubRoomPost).toHaveBeenCalledTimes(1);
  });
});

describe("native MCP HTTP admission",()=>{
  it.each([
    {headers:{"x-agend-native-token":"invalid"},expected:401},
    {headers:{"x-agend-native-token":["a".repeat(64),"b".repeat(64)]},expected:401},
    {headers:{origin:"http://localhost:19280"},expected:403},
    {headers:{cookie:"session=anything"},expected:403},
    {remote:"192.0.2.1",expected:403},
    {gateway:true,expected:403},
    {headers:{"content-length":"65537"},expected:413},
  ])("refuses before reading the body: %j",async({expected,...options})=>{
    const f=fixture(),response=invoke(f,listing,{...options,hold:true});
    expect(response.status()).toBe(expected);expect(f.ctx.handleTaskCrudHttp).not.toHaveBeenCalled();response.req.destroy();
  });
  it("rechecks owner validity after reading the body and never accepts an instance in the payload",async()=>{
    const f=fixture(),response=invoke(f,listing,{hold:true});f.state.current=false;response.req.end(JSON.stringify(listing));
    expect((await response.done()).status).toBe(401);
    const scoped=fixture();expect((await invoke(scoped,{...call("spoof"),instance:"other"}).done()).status).toBe(400);
    expect(scoped.ctx.handleTaskCrudHttp).not.toHaveBeenCalled();
  });
  it("does not permit a Windows identity's stale disk token to fall back into arbitrary /agent operations",()=>{
    const f=fixture(),home=mkdtempSync(join(tmpdir(),"agend-native-token-"));homes.push(home);f.ctx.dataDir=home;
    mkdirSync(join(home,"instances",name),{recursive:true});writeFileSync(join(home,"instances",name,"agent.token"),"known-old-token");
    const req=Object.assign(new PassThrough(),{method:"POST",url:"/agent",headers:{"x-agend-instance-token":`${encodeURIComponent(name)}:known-old-token`},socket:{remoteAddress:"127.0.0.1"}});
    let status=0;const res:any={writeHead(code:number){status=code;},end(){}};handleAgentRequest(req as never,res,f.ctx);expect(status).toBe(401);req.destroy();
  });
});

describe("native MCP dispatch, stable calls and result tracking",()=>{
  it("uses the authenticated identity and coalesces same-id calls regardless of argument key order",async()=>{
    const f=fixture();let release!:(value:unknown)=>void;
    f.ctx.handleTaskCrudHttp.mockImplementationOnce(()=>new Promise(done=>{release=done;}));
    const first=invoke(f,call("stable","task",{action:"list",filter_assignee:name}));
    await vi.waitFor(()=>expect(f.ctx.handleTaskCrudHttp).toHaveBeenCalledTimes(1));
    const repeated=invoke(f,call("stable","task",{filter_assignee:name,action:"list"}));
    expect((await invoke(f,call("stable","task",{action:"get",id:"M-1"})).done()).status).toBe(409);
    release({items:[]});const [a,b]=await Promise.all([first.done(),repeated.done()]);expect(a.value).toEqual(b.value);
    expect(f.ctx.handleTaskCrudHttp).toHaveBeenCalledWith(name,{action:"list",filter_assignee:name});
    expect(f.ctx.handleTaskCrudHttp).toHaveBeenCalledTimes(1);
  });
  it("denies a result after owner or tool access is revoked while awaiting dispatch",async()=>{
    const f=fixture();let release!:(value:unknown)=>void;
    f.ctx.handleTaskCrudHttp.mockImplementationOnce(()=>new Promise(done=>{release=done;}));
    const pending=invoke(f,call("revoked"));await vi.waitFor(()=>expect(release).toBeTypeOf("function"));f.config.tool_set="minimal";release({items:["private"]});
    expect((await pending.done()).status).toBe(401);expect(pending.value().error).not.toContain("private");
  });
  it("fences delayed outbound admission to its original lease even after a new turn starts for the same instance",async()=>{
    const f=fixture(),get=outboundHandlers.get.bind(outboundHandlers),admitted=vi.fn(()=>({deliveryId:"must-not-admit",state:"queued",duplicate:false}));
    f.ctx.admitDurableDelivery=admitted;
    let release!:()=>void;const wait=new Promise<void>(done=>{release=done;});let entered=false;
    vi.spyOn(outboundHandlers,"get").mockImplementation(tool=>tool==="send_to_instance" ? (async(ctx,_args,respond,meta)=>{
      const admit=ctx.admitDurableDelivery!;entered=true;await wait;
      const receipt=admit({operationId:meta.operationId!,sourceInstance:meta.instanceName,targetInstance:"peer",kind:"fleet_inbound",correlationId:"exchange",payload:{}});
      respond(receipt);
    }) : get(tool));
    const previous=invoke(f,call("delayed","send_to_instance",{instance_name:"peer",message:"Old turn"}));
    await vi.waitFor(()=>expect(entered).toBe(true));f.lease.close();
    const next=f.manager.grant({instance:name,requestId:"12345678-1234-4321-abcd-123456789014",sandbox:"workspace-write",endpoint:f.lease.connection.endpoint,stillCurrent:()=>true});
    expect(f.manager.hasActive(name)).toBe(true);expect(next.connection.token).not.toBe(f.lease.connection.token);
    release();expect((await previous.done()).status).toBe(401);expect(admitted).not.toHaveBeenCalled();
  });
  it("keeps real context methods bound to their owner while guarding task admission",async()=>{
    const f=fixture();
    f.ctx.handleTaskCrudHttp=vi.fn(function(this:any,instance:string,args:Record<string,unknown>){expect(this).toBe(f.ctx);return Promise.resolve({instance,action:args.action});});
    const response=await invoke(f,call("bound-task")).done();expect(response.status).toBe(200);
    expect(JSON.parse(response.value.content[0].text)).toEqual({instance:name,action:"list"});
  });
  it("returns bounded results and rejects invalid schemas without dispatching",async()=>{
    const f=fixture();f.ctx.handleTaskCrudHttp.mockResolvedValueOnce({items:["x".repeat(70*1024)]});
    const oversized=await invoke(f,call("big")).done();expect(oversized.status).toBe(200);expect(oversized.value.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(oversized.value))).toBeLessThan(65536);
    const invalid=await invoke(f,call("invalid","task",{action:"invented"})).done();expect(invalid.value.isError).toBe(true);
    expect(f.ctx.handleTaskCrudHttp).toHaveBeenCalledTimes(1);
  });
  it.each([false,true])("retains successful explicit report correlations after close (detail=%s), so the adapter can avoid a duplicate fallback",async(detail)=>{
    const f=fixture(),get=outboundHandlers.get.bind(outboundHandlers);
    vi.spyOn(outboundHandlers,"get").mockImplementation(tool=>tool==="report_result" ? ((_ctx,_args,respond)=>{respond({sent:true,queued:true,delivery_id:"native-report"});}) : get(tool));
    const reported=await invoke(f,call("report","report_result",{target_instance:"lead",correlation_id:"exchange-1",summary:"Done",detail})).done();
    expect(reported.value.isError).not.toBe(true);
    const ack=JSON.parse(reported.value.content[0].text);expect(ack.queued).toBe(true);
    if(detail) expect(ack.operation_id).toBeTypeOf("string");else expect(ack).not.toHaveProperty("operation_id");
    f.lease.close();expect(f.lease.reportedCorrelations()).toEqual(["exchange-1"]);
    expect(f.lease.reportedCorrelations("lead")).toEqual(["exchange-1"]);
  });
  it("does not let a report to another target suppress the original requester's same correlation",async()=>{
    const f=fixture(),get=outboundHandlers.get.bind(outboundHandlers);
    vi.spyOn(outboundHandlers,"get").mockImplementation(tool=>tool==="report_result" ? ((_ctx,_args,respond)=>{respond({queued:true});}) : get(tool));
    const response=await invoke(f,call("other-report","report_result",{target_instance:"other",correlation_id:"exchange-1",summary:"For the other target"})).done();
    expect(response.value.isError).not.toBe(true);
    expect(f.lease.reportedCorrelations("lead")).toEqual([]);
    expect(f.lease.reportedCorrelations("other")).toEqual(["exchange-1"]);
    expect(f.lease.reportedCorrelations()).toEqual(["exchange-1"]);
  });
  it.each([false,true])("does not mark failed reports as sent (detail=%s)",async(detail)=>{
    const f=fixture(),get=outboundHandlers.get.bind(outboundHandlers);
    vi.spyOn(outboundHandlers,"get").mockImplementation(tool=>tool==="report_result" ? ((_ctx,_args,respond)=>{respond(null,"Not queued");}) : get(tool));
    expect((await invoke(f,call("report","report_result",{target_instance:"lead",correlation_id:"exchange-1",summary:"Done",detail})).done()).value.isError).toBe(true);
    expect(f.lease.reportedCorrelations()).toEqual([]);
  });
});
it("S-226 R1 an unscoped legacy grant and its calls have no root reference",async()=>{
 const f=fixture(),root="00000000-0000-4000-8000-000000000099";expect(f.manager.drainView(root)).toMatchObject({unknown:false,references:[]});await invoke(f,call("legacy-read")).done();expect(f.manager.drainView(root)).toMatchObject({unknown:false,references:[]});
});

it("S-232 actual exec HTTP tool entry refuses a Hub derivative before its task owner",async()=>{
 const f=fixture();f.lease.close();const id=randomUUID(),scope=captureRequestContextCall({token:randomUUID(),inputId:"input",wireSha256:"a".repeat(64),owner:{instance:name,incarnation:"v1",workGeneration:"work",daemonBootId:"boot",spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0},context:{ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"fixture",ingress:"hub",initiatingActor:{kind:"person",platform:"hub",hubId:"demo-hub",id:"directory/demo-person"},source:{instance:name,incarnation:"v1"},sourceAudience:{kind:"hub",ref:randomUUID()}}},()=>true);
 f.ctx.requestContextPolicy={assert:assertRequestContextOperation};f.lease=f.manager.grant({instance:name,requestId,sandbox:"workspace-write",endpoint:"http://127.0.0.1:19280/agent",stillCurrent:()=>true,requestContext:scope});
 const answer=await invoke(f,call("hub-create","task",{action:"create",title:"must not write"})).done();expect(answer.value.isError).toBe(true);expect(JSON.stringify(answer.value)).toContain("task cards");expect(f.ctx.handleTaskCrudHttp).not.toHaveBeenCalled();
});

describe("S-230 owned exec input boundary",()=>{
 it("lists startup tools but coalesces the original call until positive input, with no early dispatch",async()=>{
  let resolve!:(value:boolean)=>void;const ready=new Promise<boolean>(done=>resolve=done),f=fixture("workspace-write","workspace-write",()=>ready);
  expect((await invoke(f,listing).done()).status).toBe(200);
  const first=invoke(f,call("before-input")),retry=invoke(f,call("before-input"));await new Promise<void>(done=>setImmediate(done));expect(f.ctx.handleTaskCrudHttp).not.toHaveBeenCalled();
  expect((await invoke(f,call("before-input","task",{action:"mine"})).done()).status).toBe(409);
  resolve(true);expect((await first.done()).status).toBe(200);expect((await retry.done()).status).toBe(200);expect(f.ctx.handleTaskCrudHttp).toHaveBeenCalledOnce();
 });
 it.each(["failed","closed","owner-changed"])("%s input releases the waiting call without running it or borrowing a newer grant",async how=>{
  let resolve!:(value:boolean)=>void;const ready=new Promise<boolean>(done=>resolve=done),f=fixture("workspace-write","workspace-write",()=>ready),pending=invoke(f,call("waiting"));
  await new Promise<void>(done=>setImmediate(done));expect(f.ctx.handleTaskCrudHttp).not.toHaveBeenCalled();
  if(how==="closed")f.lease.close();else{if(how==="owner-changed")f.state.current=false;resolve(how!=="failed");}
  const response=await pending.done();expect(response.status).toBe(how==="failed"?200:401);expect(f.ctx.handleTaskCrudHttp).not.toHaveBeenCalled();
  resolve(true);await new Promise<void>(done=>setImmediate(done));expect(f.ctx.handleTaskCrudHttp).not.toHaveBeenCalled();
 });
 it("the actual scoped factory cannot issue a grant missing the positive input boundary",()=>{
  const f=fixture();f.manager.setRequestContextRequired(true,true);
  expect(()=>f.manager.grant({instance:name,requestId,sandbox:"workspace-write",endpoint:f.lease.connection.endpoint,stillCurrent:()=>true,requestContext:{current:()=>true,snapshot:{owner:{instance:name}}}as any})).toThrow("owned input proof boundary");
 });
});

describe("S-230 native factory retirement",()=>{
 it("revoking a legacy grant is not proof that its first-hop body/handler is gone",async()=>{
  const f=fixture(),held=invoke(f,listing,{hold:true});expect(f.manager.requestContextPhysicallyIdle()).toBe(false);
  f.manager.closeAll();expect(()=>f.manager.retireForRequestContext()).toThrow("handlers remain");
  held.req.end(JSON.stringify(listing));expect((await held.done()).status).toBe(401);
  await vi.waitFor(()=>expect(f.manager.requestContextPhysicallyIdle()).toBe(true));f.manager.retireForRequestContext();
  expect(()=>f.manager.grant({instance:name,requestId,sandbox:"workspace-write",endpoint:"http://127.0.0.1:19280/agent",stillCurrent:()=>true})).toThrow("factory is retired");
  expect((await invoke(f,listing).done()).status).toBe(401);
 });
});
