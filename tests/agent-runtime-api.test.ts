import {IncomingMessage,ServerResponse} from "node:http";
import {Readable} from "node:stream";
import {describe,it,expect,vi} from "vitest";
import {handleAgentRuntimeChange} from "../src/agent-runtime-api.js";
import {WebSessionStore,csrfTokenFor,tokenEpoch} from "../src/web-session.js";
import {WEB_SESSION_COOKIE} from "../src/web-auth.js";
import {bindGatewayRequest} from "../src/web-request-context.js";
import type {WebApiContext} from "../src/web-api.js";
const token="runtime-change-private-test-token-".repeat(3),path="/ui/instances/agent-1/runtime";
class Response extends ServerResponse{
 status=0;body:any;
 override writeHead(code:number):this{this.status=code;return this;}
 override end(chunk?:unknown):this{this.body=JSON.parse(String(chunk));return this;}
}
function rig(tier:"admin"|"read"|"guest"="admin"){
 const sessions=new WebSessionStore(),session=sessions.create({tier,surface:"local",label:"runtime-change",tokenEpoch:tokenEpoch(token),...(tier==="guest"?{owner:{adapterId:"test",userId:"reader"}}:{})});
 const describe=vi.fn(()=>({revision:"a".repeat(64),runtime:"wsl"})),change=vi.fn(async(_name:string,_input:unknown,current:()=>boolean)=>{if(!current())throw Error("expired");return {ok:true};});
 const service=vi.fn(()=>({describe,change})),ctx={webToken:token,webSessions:sessions,fleetConfig:{instances:{"agent-1":{working_directory:"/private"}}},agentRuntimeChanges:service} as unknown as WebApiContext;
 const request=(method="POST",csrf=true,stream:Readable=Readable.from([JSON.stringify({requestId:"inert-test"})]))=>{
  const req=stream as unknown as IncomingMessage;req.method=method;req.url=path;req.headers={host:"localhost",origin:"http://localhost",cookie:`${WEB_SESSION_COOKIE}=${session.sessionId}`,...(csrf?{"x-agend-csrf":csrfTokenFor(session.sessionId)}:{})};Object.defineProperty(req,"socket",{value:{remoteAddress:"127.0.0.1"},configurable:true});return req;
 };
 const run=(req=request(),url=path)=>{const res=new Response(req);expect(handleAgentRuntimeChange(req,res,new URL(url,"http://localhost"),ctx)).toBe(true);return res;};
 return {ctx,describe,change,service,request,run};
}
describe("Agent Runtime dashboard boundary",()=>{
 it("admits the local dashboard admin for the exact own-key Agent and refuses inherited and missing names",async()=>{
  const r=rig(),get=r.run(r.request("GET"));expect(get.status).toBe(200);expect(r.describe).toHaveBeenCalledWith("agent-1");
  const post=r.run();await vi.waitFor(()=>expect(post.status).toBe(200));expect(r.change).toHaveBeenCalledOnce();expect(r.change.mock.calls[0][0]).toBe("agent-1");
  expect(r.run(r.request("GET"),"/ui/instances/constructor/runtime").status).toBe(404);expect(r.run(r.request("GET"),"/ui/instances/missing/runtime").status).toBe(404);expect(r.describe).toHaveBeenCalledOnce();
 });
 it.each(["read","guest"] as const)("does not expose or allocate Runtime changes for a %s session",tier=>{
  const r=rig(tier);expect(r.run(r.request("GET")).status).toBe(403);expect(r.run().status).toBe(403);expect(r.service).not.toHaveBeenCalled();
 });
 it("refuses missing browser CSRF and the public gateway before constructing the service",()=>{
  const r=rig();expect(r.run(r.request("POST",false)).status).toBe(403);
  const req=r.request();bindGatewayRequest(req,{surface:"gateway",exposureId:"a".repeat(32),expectedOrigin:"https://public.example.test",isCurrent:()=>true});expect(r.run(req).status).toBe(403);expect(r.service).not.toHaveBeenCalled();
 });
 it("asks authorization again after the held body before any allocation",async()=>{
  const r=rig(),stream=new Readable({read(){}}),res=r.run(r.request("POST",true,stream));Object.assign(r.ctx,{webToken:"revoked-token"});stream.push(JSON.stringify({requestId:"held"}));stream.push(null);
  await vi.waitFor(()=>expect(res.status).toBe(403));expect(r.service).not.toHaveBeenCalled();expect(r.change).not.toHaveBeenCalled();
 });
});
