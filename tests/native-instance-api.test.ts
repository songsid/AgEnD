import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeInstance, handleNativeInstanceRequest } from "../src/native-instance-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_SESSION_COOKIE } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import type { WebApiContext } from "../src/web-api.js";

const token="n".repeat(48),id="12345678-1234-4321-abcd-123456789012",requestId="12345678-1234-4321-abcd-123456789013",name=`windows-${id}`;
const createUrl=new URL("http://localhost/ui/instances");
const url=(suffix="")=>new URL(`http://localhost/ui/instances/${name}${suffix}`);
function request(method="POST",body:unknown={},target=createUrl):IncomingMessage {
  const req=Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
  req.method=method;req.url=target.pathname;req.headers={host:"localhost","x-agend-token":token};return req;
}
class Response extends ServerResponse {
  status=0;body="";
  override writeHead(status:number):this{this.status=status;return this;}
  override end(value?:unknown):this{this.body+=String(value??"");return this;}
}
function fixture(){
  let agent={id,name:"Master",cwd:"C:\\Users\\Test\\.agend\\workspaces\\"+id,cli:"codex",sandbox:"read-only",instructions:"",description:"",turns:[] as Array<{id:string;prompt:string;status:string}>};
  const service={
    get:vi.fn(()=>agent),create:vi.fn(async(_input:unknown,_authorized:()=>boolean)=>({name,runtime:"windows",agent})),
    update:vi.fn(async()=>({name,runtime:"windows",agent})),remove:vi.fn(async()=>undefined),
    cancel:vi.fn(()=>({id:requestId,status:"cancelling"})),recover:vi.fn(()=>agent),
  };
  const ctx={webToken:token as string|null,fleetConfig:{defaults:{},instances:{[name]:{runtime:"windows",native_agent_id:id,working_directory:agent.cwd}}},
    nativeInstanceRuntime:()=>service,emitSseEvent:vi.fn(),getUiStatus:()=>({instances:[{name,runtime:"windows"}]}),deliverToInstance:vi.fn(async()=>true)};
  return{service,agent,ctx,context:ctx as unknown as WebApiContext};
}
async function finish(response:Response,status:number){await vi.waitFor(()=>expect(response.status).toBe(status));return response.body?JSON.parse(response.body):null;}
beforeEach(()=>vi.stubEnv("AGEND_WINDOWS_CLI","1"));
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});

describe("shared instance creation for a Windows runtime",()=>{
  it("maps common identity/settings to the native runtime and leaves a blank directory optional",async()=>{
    const f=fixture(),body={runtime:"windows",topic_name:"General assistant",backend:"claude-code",model:"sonnet",description:"Shared description",systemPrompt:"Shared instructions",sandbox:"read-only",tags:["research"]};
    const req=request("POST",body),res=new Response(req);await createNativeInstance(req,res,createUrl,f.context,body);
    expect(res.status).toBe(201);expect(f.service.create).toHaveBeenCalledWith({name:"General assistant",cli:"claude-code",model:"sonnet",description:"Shared description",instructions:"Shared instructions",sandbox:"read-only",tags:["research"]},expect.any(Function));
    expect(f.service.create.mock.calls[0][0]).not.toHaveProperty("cwd");
    expect(JSON.parse(res.body)).toMatchObject({name,runtime:"windows",agent:{id}});expect(f.ctx.emitSseEvent).toHaveBeenCalledWith("status",expect.any(Object));
  });
  it("keeps a literal native path and can derive a name from that directory",async()=>{
    const f=fixture(),body={runtime:"windows",directory:"J:\\Work\\Analysis\\",backend:"codex"},req=request("POST",body),res=new Response(req);
    await createNativeInstance(req,res,createUrl,f.context,body);
    expect(res.status).toBe(201);expect(f.service.create).toHaveBeenCalledWith(expect.objectContaining({name:"Analysis",cwd:"J:\\Work\\Analysis\\",cli:"codex",sandbox:"read-only"}),expect.any(Function));
  });
  it.each([{runtime:"windows"},{runtime:"windows",topic_name:"X",native_agent_id:id},{runtime:"windows",topic_name:"X",branch:"unsafe"},{runtime:"windows",topic_name:"X",runtimeId:"other"},{runtime:"windows",topic_name:"X",backend:"mock"}])("rejects missing identity and unknown/retargeting creation fields %j",async body=>{
    const f=fixture(),req=request("POST",body),res=new Response(req);await createNativeInstance(req,res,createUrl,f.context,body);
    expect(res.status).toBe(400);expect(f.service.create).not.toHaveBeenCalled();
  });
  it("does not return a created profile after authorization expires during creation",async()=>{
    const f=fixture(),body={runtime:"windows",topic_name:"X"},req=request("POST",body),res=new Response(req);
    let release!:()=>void;f.service.create.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({name,runtime:"windows",agent:f.agent});}));
    const pending=createNativeInstance(req,res,createUrl,f.context,body);await vi.waitFor(()=>expect(f.service.create).toHaveBeenCalledOnce());f.ctx.webToken=null;release();await pending;
    expect(res.status).toBe(403);expect(res.body).not.toContain(f.agent.cwd);expect(f.ctx.emitSseEvent).not.toHaveBeenCalled();
  });
});

describe("shared canonical Windows instance routes",()=>{
  it("uses the canonical identity for GET, PATCH and DELETE",async()=>{
    const f=fixture();
    const get=request("GET",{},url()),getRes=new Response(get);expect(handleNativeInstanceRequest(get,getRes,url(),f.context)).toBe(true);
    expect(await finish(getRes,200)).toMatchObject({name,runtime:"windows",agent:{id}});expect(f.service.get).toHaveBeenCalledWith(name);
    const patch={display_name:"Shared name",description:"Updated",systemPrompt:"New instructions",model:"gpt-5.5",native_sandbox:"read-only",tags:["review"]};
    const req=request("PATCH",patch,url()),res=new Response(req);handleNativeInstanceRequest(req,res,url(),f.context);await finish(res,200);
    expect(f.service.update).toHaveBeenCalledWith(name,patch,expect.any(Function));
    const del=request("DELETE",{},url()),delRes=new Response(del);handleNativeInstanceRequest(del,delRes,url(),f.context);
    expect(await finish(delRes,200)).toEqual({deleted:name});expect(f.service.remove).toHaveBeenCalledWith(name,expect.any(Function));
  });
  it.each([{runtime:"wsl"},{native_agent_id:requestId},{backend:"grok"},{threadId:requestId},{cwd:"J:\\Other"},{}])("refuses structural retargeting and unknown PATCH fields %j",async patch=>{
    const f=fixture(),req=request("PATCH",patch,url()),res=new Response(req);handleNativeInstanceRequest(req,res,url(),f.context);
    await finish(res,400);expect(f.service.update).not.toHaveBeenCalled();
  });
  it("does not intercept a Linux instance or a UUID-looking name absent from the common registry",()=>{
    const f=fixture(),req=request("GET",{},url()),res=new Response(req);(f.ctx.fleetConfig.instances[name] as any).runtime="wsl";
    expect(handleNativeInstanceRequest(req,res,url(),f.context)).toBe(false);
    const other=new URL(`http://localhost/ui/instances/windows-${requestId}`);expect(handleNativeInstanceRequest(req,res,other,f.context)).toBe(false);expect(res.status).toBe(0);
  });
  it("sends through common Fleet delivery and deduplicates a repeated request ID",async()=>{
    const f=fixture(),body={requestId,prompt:"Analyze this"};
    f.ctx.deliverToInstance.mockImplementationOnce(async()=>{f.agent.turns.push({id:requestId,prompt:body.prompt,status:"starting"});return true;});
    const req=request("POST",body,url("/messages")),res=new Response(req);handleNativeInstanceRequest(req,res,url("/messages"),f.context);await finish(res,202);
    expect(f.ctx.deliverToInstance).toHaveBeenCalledWith(name,expect.objectContaining({type:"fleet_inbound",content:body.prompt,requestId,targetSession:name,meta:expect.objectContaining({source:"web",message_id:`native:${requestId}:user`})}),{stillCurrent:expect.any(Function)});
    const repeat=request("POST",body,url("/messages")),repeatRes=new Response(repeat);handleNativeInstanceRequest(repeat,repeatRes,url("/messages"),f.context);
    expect(await finish(repeatRes,200)).toMatchObject({accepted:true,repeated:true});expect(f.ctx.deliverToInstance).toHaveBeenCalledTimes(1);
    const changed=request("POST",{...body,prompt:"Other"},url("/messages")),changedRes=new Response(changed);handleNativeInstanceRequest(changed,changedRes,url("/messages"),f.context);await finish(changedRes,400);expect(f.ctx.deliverToInstance).toHaveBeenCalledTimes(1);
  });
  it("rejects whitespace/extra fields before dispatch and handles explicit cancellation/recovery",async()=>{
    const f=fixture();
    for(const body of [{requestId,prompt:" "},{requestId,prompt:"hello",executable:"evil"}]){
      const req=request("POST",body,url("/messages")),res=new Response(req);handleNativeInstanceRequest(req,res,url("/messages"),f.context);await finish(res,400);
    }
    expect(f.ctx.deliverToInstance).not.toHaveBeenCalled();
    const cancel=request("POST",{},url("/cancel")),cancelRes=new Response(cancel);handleNativeInstanceRequest(cancel,cancelRes,url("/cancel"),f.context);await finish(cancelRes,202);expect(f.service.cancel).toHaveBeenCalledWith(name);
    const recover=request("POST",{confirmedStopped:true},url("/recover")),recoverRes=new Response(recover);handleNativeInstanceRequest(recover,recoverRes,url("/recover"),f.context);await finish(recoverRes,200);expect(f.service.recover).toHaveBeenCalledWith(name,true);
  });
  it.each(["PATCH","DELETE","message"])("rechecks authorization after asynchronous %s before replying or emitting content",async operation=>{
    const f=fixture(),suffix=operation==="message"?"/messages":"",method=operation==="message"?"POST":operation,body=operation==="PATCH"?{description:"changed"}:operation==="message"?{requestId,prompt:"Private prompt"}:{};
    let release!:()=>void;
    if(operation==="PATCH")f.service.update.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({name,runtime:"windows",agent:f.agent});}));
    else if(operation==="DELETE")f.service.remove.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve(undefined);}));
    else f.ctx.deliverToInstance.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve(true);}));
    const req=request(method,body,url(suffix)),res=new Response(req);handleNativeInstanceRequest(req,res,url(suffix),f.context);
    await vi.waitFor(()=>expect(release).toBeTypeOf("function"));f.ctx.webToken=null;release();await finish(res,403);
    expect(res.body).not.toContain("Private prompt");expect(f.ctx.emitSseEvent).not.toHaveBeenCalled();
  });
});

describe("shared native instance authorization boundary",()=>{
  it("is opt-in and does not use the native service while disabled",async()=>{
    const f=fixture();vi.stubEnv("AGEND_WINDOWS_CLI","");const req=request("POST",{runtime:"windows",topic_name:"X"}),res=new Response(req);
    await createNativeInstance(req,res,createUrl,f.context,{runtime:"windows",topic_name:"X"});expect(res.status).toBe(404);expect(f.service.create).not.toHaveBeenCalled();
  });
  it.each(["missing","cross-origin","public"])("refuses %s requests before common runtime access",async kind=>{
    const f=fixture(),req=request("POST",{runtime:"windows",topic_name:"X"}),res=new Response(req);
    if(kind==="missing")delete req.headers["x-agend-token"];
    if(kind==="cross-origin")req.headers.origin="https://other.example";
    if(kind==="public")bindGatewayRequest(req,{surface:"gateway",exposureId:"a".repeat(32),expectedOrigin:"https://public.example",isCurrent:()=>true});
    await createNativeInstance(req,res,createUrl,f.context,{runtime:"windows",topic_name:"X"});expect(res.status).toBe(403);expect(f.service.create).not.toHaveBeenCalled();
  });
  it.each(["admin","read","guest"] as const)("requires admin and CSRF for %s cookie sessions",async tier=>{
    const f=fixture(),sessions=new WebSessionStore(),session=sessions.create({tier,surface:"local",label:"test",tokenEpoch:tokenEpoch(token),...(tier==="guest"?{owner:{adapterId:"tg",userId:"1"}}:{})});
    (f.ctx as any).webSessions=sessions;
    const create=async(csrf:boolean)=>{const req=request("POST",{runtime:"windows",topic_name:"X"}),res=new Response(req);delete req.headers["x-agend-token"];req.headers.cookie=`${WEB_SESSION_COOKIE}=${session.sessionId}`;req.headers.origin="http://localhost";if(csrf)req.headers["x-agend-csrf"]=csrfTokenFor(session.sessionId);await createNativeInstance(req,res,createUrl,f.context,{runtime:"windows",topic_name:"X"});return res;};
    expect((await create(false)).status).toBe(403);expect((await create(true)).status).toBe(tier==="admin"?201:403);
  });
  it("rechecks authorization after reading an operation body",async()=>{
    const f=fixture(),req=request("PATCH",{description:"changed"},url()),res=new Response(req);handleNativeInstanceRequest(req,res,url(),f.context);f.ctx.webToken=null;
    await finish(res,403);expect(f.service.update).not.toHaveBeenCalled();
  });
});
it("native pane compatibility Cancel/Delete routes through the ordinary Fleet lifecycle rather than the exec worker",async()=>{
 const f=fixture();Object.assign(f.ctx.fleetConfig.instances[name],{native_adapter:"pane"});const cancel=vi.fn(()=>true),remove=vi.fn(async()=>{});Object.assign(f.ctx,{cancelInstance:cancel,removeInstance:remove});
 const req=request("POST",{},url("/cancel")),res=new Response(req);handleNativeInstanceRequest(req,res,url("/cancel"),f.context);await finish(res,202);expect(cancel).toHaveBeenCalledExactlyOnceWith(name);expect(f.service.cancel).not.toHaveBeenCalled();
 const del=request("DELETE",{},url()),delRes=new Response(del);handleNativeInstanceRequest(del,delRes,url(),f.context);await finish(delRes,200);expect(remove).toHaveBeenCalledWith(name,expect.objectContaining({source:"dashboard-confirmed"}),undefined);expect(f.service.remove).not.toHaveBeenCalled();
});
describe('persistent pane adapters use shared lifecycle rather than per-turn compatibility',()=>{
 it('PATCH calls the serialized native pane settings transaction and never the exec updater',async()=>{
  const f=fixture();Object.assign(f.ctx.fleetConfig.instances[name],{native_adapter:'pane'});const update=vi.fn(async()=>({name,agent:f.agent}));f.context.updateNativePaneConfig=update;
  const patch={display_name:'Renamed'},req=request('PATCH',patch,url()),res=new Response(req);expect(handleNativeInstanceRequest(req,res,url(),f.context)).toBe(true);await finish(res,200);expect(update).toHaveBeenCalledWith(name,patch,expect.any(Function));expect(f.service.update).not.toHaveBeenCalled();
 });
 it.each(['messages','recover'])('refuses the exec-only %s alias without entering its journal or recovery',async operation=>{
  const f=fixture();Object.assign(f.ctx.fleetConfig.instances[name],{native_adapter:'pane'});const req=request('POST',operation==='messages'?{requestId,prompt:'hello'}:{confirmedStopped:true},url('/'+operation)),res=new Response(req);
  handleNativeInstanceRequest(req,res,url('/'+operation),f.context);await finish(res,400);expect(f.ctx.deliverToInstance).not.toHaveBeenCalled();expect(f.service.recover).not.toHaveBeenCalled();expect(f.service.cancel).not.toHaveBeenCalled();
 });
});

describe("explicit persistent-pane recovery boundary",()=>{
 const launchId="12345678-1234-4321-abcd-123456789099";
 it("routes only exact stopped-process confirmation through the pane lifecycle, never exec recovery",async()=>{
  const f=fixture();Object.assign(f.ctx.fleetConfig.instances[name],{native_adapter:"pane"});const recover=vi.fn(async(_name:string,_launchId:string,_current:()=>boolean)=>{});f.context.recoverNativePane=recover;
  const req=request("POST",{confirmedStopped:true,launchId},url("/recover-pane")),res=new Response(req);handleNativeInstanceRequest(req,res,url("/recover-pane"),f.context);await finish(res,200);
  expect(recover).toHaveBeenCalledWith(name,launchId,expect.any(Function));expect(recover.mock.calls[0][2]()).toBe(true);expect(f.service.recover).not.toHaveBeenCalled();
 });
 it.each([{}, {confirmedStopped:false,launchId}, {confirmedStopped:true,launchId:"wrong"}, {confirmedStopped:true,launchId,force:true}])("rejects an unconfirmed or unscoped body %j",async body=>{
  const f=fixture();Object.assign(f.ctx.fleetConfig.instances[name],{native_adapter:"pane"});const recover=vi.fn(async(_name:string,_launchId:string,_current:()=>boolean)=>{});f.context.recoverNativePane=recover;
  const req=request("POST",body,url("/recover-pane")),res=new Response(req);handleNativeInstanceRequest(req,res,url("/recover-pane"),f.context);await finish(res,400);expect(recover).not.toHaveBeenCalled();
 });
 it.each(["guest","gateway","missing"])("refuses %s authority before any recovery",async kind=>{
  const f=fixture();Object.assign(f.ctx.fleetConfig.instances[name],{native_adapter:"pane"});const recover=vi.fn(async(_name:string,_launchId:string,_current:()=>boolean)=>{});f.context.recoverNativePane=recover;
  const req=request("POST",{confirmedStopped:true,launchId},url("/recover-pane")),res=new Response(req);
  if(kind==="gateway")bindGatewayRequest(req,{kind:"edge-public",gatewayId:"test"} as never);
  else if(kind==="missing")delete req.headers["x-agend-token"];
  else {const sessions=new WebSessionStore(),session=sessions.create({tier:"guest",surface:"local",label:"test",tokenEpoch:tokenEpoch(token),owner:{adapterId:"tg",userId:"1"}});Object.assign(f.context,{webSessions:sessions});delete req.headers["x-agend-token"];req.headers.cookie=`${WEB_SESSION_COOKIE}=${session.sessionId}`;req.headers.origin="http://localhost";req.headers["x-agend-csrf"]=csrfTokenFor(session.sessionId);}
  handleNativeInstanceRequest(req,res,url("/recover-pane"),f.context);await finish(res,403);expect(recover).not.toHaveBeenCalled();
 });
});

describe("explicit fresh Claude conversation boundary",()=>{
 const launchId="12345678-1234-4321-abcd-123456789099",sessionId="12345678-1234-4321-abcd-123456789088";
 it("requires explicit new-conversation confirmation and binds the exact displayed launch/session",async()=>{
  const f=fixture();Object.assign(f.ctx.fleetConfig.instances[name],{native_adapter:"pane"});const fresh=vi.fn(async()=>{});f.context.startFreshNativePane=fresh;
  const req=request("POST",{confirmedNewConversation:true,launchId,sessionId},url("/new-conversation")),res=new Response(req);
  handleNativeInstanceRequest(req,res,url("/new-conversation"),f.context);await finish(res,200);
  expect(fresh).toHaveBeenCalledWith(name,launchId,sessionId,expect.any(Function));expect(f.service.recover).not.toHaveBeenCalled();
 });
 it("accepts an explicit null UUID only through the same admin new-conversation boundary",async()=>{
  const f=fixture();Object.assign(f.ctx.fleetConfig.instances[name],{native_adapter:"pane"});const fresh=vi.fn(async()=>{});f.context.startFreshNativePane=fresh;
  const req=request("POST",{confirmedNewConversation:true,launchId,sessionId:null},url("/new-conversation")),res=new Response(req);handleNativeInstanceRequest(req,res,url("/new-conversation"),f.context);await finish(res,200);expect(fresh).toHaveBeenCalledWith(name,launchId,null,expect.any(Function));
 });
 it.each([{}, {confirmedNewConversation:false,launchId,sessionId}, {confirmedNewConversation:true,launchId}, {confirmedNewConversation:true,launchId,sessionId,force:true}])("rejects unconfirmed/unscoped body %j",async body=>{
  const f=fixture();Object.assign(f.ctx.fleetConfig.instances[name],{native_adapter:"pane"});const fresh=vi.fn(async()=>{});f.context.startFreshNativePane=fresh;
  const req=request("POST",body,url("/new-conversation")),res=new Response(req);handleNativeInstanceRequest(req,res,url("/new-conversation"),f.context);await finish(res,400);expect(fresh).not.toHaveBeenCalled();
 });
 it.each(["guest","gateway","missing"])("refuses %s before a new conversation",async kind=>{
  const f=fixture();Object.assign(f.ctx.fleetConfig.instances[name],{native_adapter:"pane"});const fresh=vi.fn(async()=>{});f.context.startFreshNativePane=fresh;
  const req=request("POST",{confirmedNewConversation:true,launchId,sessionId},url("/new-conversation")),res=new Response(req);
  if(kind==="gateway")bindGatewayRequest(req,{kind:"edge-public",gatewayId:"test"} as never);
  else if(kind==="missing")delete req.headers["x-agend-token"];
  else {const sessions=new WebSessionStore(),session=sessions.create({tier:"guest",surface:"local",label:"test",tokenEpoch:tokenEpoch(token),owner:{adapterId:"tg",userId:"1"}});Object.assign(f.context,{webSessions:sessions});delete req.headers["x-agend-token"];req.headers.cookie=`${WEB_SESSION_COOKIE}=${session.sessionId}`;req.headers.origin="http://localhost";req.headers["x-agend-csrf"]=csrfTokenFor(session.sessionId);}
  handleNativeInstanceRequest(req,res,url("/new-conversation"),f.context);await finish(res,403);expect(fresh).not.toHaveBeenCalled();
 });
});
