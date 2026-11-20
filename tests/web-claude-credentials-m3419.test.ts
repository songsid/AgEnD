import { afterEach, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { ClaudeCredentialVault } from "../src/claude-credential-vault.js";
import { FleetManager } from "../src/fleet-manager.js";
const clean: (()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const f of clean.splice(0).reverse())await f();});
const path="/ui/claude-credentials", value="synthetic-"+"x".repeat(48), actor={platform:"host" as const,adapterId:"host",userId:"operator",label:"Operator"};
async function fixture(){
 const home=mkdtempSync(join(tmpdir(),"web-claude-")),vault=new ClaudeCredentialVault(home);clean.push(()=>rmSync(home,{recursive:true,force:true}),()=>vault.close());
 const token="test-web-"+"a".repeat(32),sessions=new WebSessionStore({});let verified=true,gateway=false;
 let observe!:()=>void;const admitted=new Promise<void>(r=>{observe=r;});
 const write=vi.fn((p:string|null,r:number,c:any,a:any)=>vault.write(p,r,c,a));
 const ctx={webToken:token,webSessions:sessions,contactActor:()=>{observe();return verified?actor:null;},
  claudeCredentialMetadata:(p:string|null)=>vault.metadata(p),writeClaudeCredential:write,
  auditClaudeCredential:(a:any,action:string,outcome:string)=>vault.audit(a,null,action,null,null,outcome)} as unknown as WebApiContext;
 const server=createServer((req,res)=>{if(gateway)bindGatewayRequest(req,{surface:"gateway",exposureId:"synthetic-link",expectedOrigin:origin,isCurrent:()=>true});if(!handleWebRequest(req,res,new URL(req.url!,origin),ctx)){res.writeHead(404);res.end();}});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));clean.push(()=>new Promise<void>(r=>server.close(()=>r())));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 function session(tier:"admin"|"read"|"guest"="admin"){
  const made=sessions.create({tier,surface:gateway?"gateway":"local",...(gateway?{exposureId:"synthetic-link"}:{}),label:"Test browser",tokenEpoch:tokenEpoch(token),...(tier==="guest"?{owner:{adapterId:"test-adapter",userId:"guest"}}:{})});
  return {cookie:`${gateway?"__Host-agend_session":"agend_session"}=${made.sessionId}`,origin,"x-agend-csrf":csrfTokenFor(made.sessionId),"content-type":"application/json"};
 }
 function open(method:string,headers:Record<string,string>,query="",target=path){
  let req:ReturnType<typeof request>;
  const done=new Promise<{status:number;body:any}>((resolve,reject)=>{req=request(origin+target+query,{method,headers},res=>{let data="";res.on("data",c=>data+=c);res.on("end",()=>resolve({status:res.statusCode!,body:data?JSON.parse(data):null}));});req.on("error",reject);});
  return {req:req!,done};
 }
 async function call(method:string,body?:unknown,headers:Record<string,string>=session(),query=""){
  const data=body===undefined?undefined:JSON.stringify(body);const c=open(method,{...headers,...(data?{"content-length":String(Buffer.byteLength(data))}:{})},query);c.req.end(data);return c.done;
 }
 return {home,vault,write,ctx,session,open,call,admitted,setVerified:(v:boolean)=>{verified=v;},setGateway:(v:boolean)=>{gateway=v;},token};
}
it("real HTTP route saves both kinds, returns metadata only and removes with revision CAS",async()=>{
 const f=await fixture(),one=await f.call("PUT",{profile:null,revision:0,kind:"setup-token",value});expect(one.status).toBe(200);expect(one.body.credential).toMatchObject({kind:"setup-token",revision:1,state:"saved-unverified"});
 expect((await f.call("GET")).body).toEqual(one.body);expect(JSON.stringify(one.body)).not.toContain(value);
 expect((await f.call("PUT",{profile:null,revision:0,kind:"api-key",value})).status).toBe(409);
 const two=await f.call("PUT",{profile:null,revision:1,kind:"api-key",value});expect(two.status).toBe(200);
 expect((await f.call("DELETE",{profile:null,revision:2,confirm:true})).body.credential).toMatchObject({kind:null,revision:3,state:"not-connected"});
 expect((await f.call("PUT",{profile:null,revision:0,kind:"api-key",value})).status).toBe(409);
 expect(JSON.stringify(f.vault.history())).not.toContain(value);
 expect(f.vault.history().filter((x:any)=>x.outcome==="ok").map((x:any)=>x.action)).toEqual(["remove","replace","set"]);
});
it("refuses unverified/local LAN/public/header/guest/read sessions and CSRF without a write",async()=>{
 const f=await fixture(),body={profile:null,revision:0,kind:"api-key",value};
 f.setVerified(false);expect((await f.call("PUT",body)).status).toBe(403);f.setVerified(true);
 f.setGateway(true);expect((await f.call("PUT",body)).status).toBe(403);expect((await f.call("GET")).status).toBe(403);f.setGateway(false);
 expect((await f.call("PUT",body,{...f.session(),"x-forwarded-for":"192.0.2.20"})).status).toBe(403);
 for(const tier of ["guest","read"] as const)expect((await f.call("PUT",body,f.session(tier))).status).toBeGreaterThanOrEqual(400);
 expect((await f.call("PUT",body,{authorization:`Bearer ${f.token}`,origin:f.session().origin} as any)).status).toBeGreaterThanOrEqual(400);
 const h=f.session();delete (h as any)["x-agend-csrf"];expect((await f.call("PUT",body,h)).status).toBeGreaterThanOrEqual(400);
 expect(f.write).not.toHaveBeenCalled();expect(f.vault.metadata(null)).toBeNull();
 expect(f.vault.history().some((x:any)=>x.outcome==="local-verified-admin-required")).toBe(true);
});
it("revocation while body arrives refuses at the final checkpoint",async()=>{
 const f=await fixture(),data=JSON.stringify({profile:null,revision:0,kind:"api-key",value}),c=f.open("PUT",{...f.session(),"content-length":String(Buffer.byteLength(data))});
 c.req.write(data.slice(0,10));await f.admitted;f.setVerified(false);
 c.req.end(data.slice(10));expect((await c.done).status).toBe(403);expect(f.write).not.toHaveBeenCalled();
});
it("strict bounded bodies and safe storage errors never echo a credential",async()=>{
 const f=await fixture();
 for(const body of [{profile:null,revision:0,kind:"api-key",value,extra:true},{profile:"../bad",revision:0,kind:"api-key",value},{profile:null,revision:0,kind:"api-key",value:value+'\n'}])expect((await f.call("PUT",body)).status).toBe(400);
 expect((await f.call("PUT",{profile:null,revision:0,kind:"api-key",value:"z".repeat(19000)})).status).toBe(413);
 f.write.mockImplementation(()=>{throw Error(value);});const e=await f.call("PUT",{profile:null,revision:0,kind:"api-key",value});expect(e).toEqual({status:503,body:{error:"credential_unavailable"}});
 expect(JSON.stringify(f.vault.history())).not.toContain(value);
});
it("Fleet composition refuses unknown profiles, configured consumers and concurrent login",async()=>{
 const f=await fixture(),fm=Object.create(FleetManager.prototype) as any;
 Object.assign(fm,{dataDir:f.home,accountUses:()=>({agents:[{name:"helper",backend:"claude-code",profile:null}],classic:[],fleetDefaults:new Map()}),loginWindow:{holderFor:()=>null},keepAliveInUse:()=>false});
 expect(()=>fm.writeClaudeCredential(null,0,{kind:"api-key",value},actor)).toThrow("in-use");
 expect(()=>fm.writeClaudeCredential("missing",0,{kind:"api-key",value},actor)).toThrow("profile-unknown");
 fm.accountUses=()=>({agents:[],classic:[],fleetDefaults:new Map()});fm.loginWindow.holderFor=()=>({});
 expect(()=>fm.writeClaudeCredential(null,0,{kind:"api-key",value},actor)).toThrow("in-use");
 fm.loginWindow.holderFor=()=>null;expect(fm.writeClaudeCredential(null,0,{kind:"api-key",value},actor)).toMatchObject({revision:1});
});

it("profile removal cannot leave a live managed secret attached to a reused name",async()=>{
 const f=await fixture(),fm=Object.create(FleetManager.prototype) as any;
 mkdirSync(join(f.home,"credential-profiles/claude-code/spare"),{recursive:true});
 Object.assign(fm,{dataDir:f.home});f.vault.write("spare",0,{kind:"api-key",value},actor);
 expect(await fm.removeAccountProfile("claude-code","spare","spare","test-admin")).toEqual({ok:false,error:"credential_connected"});
 expect(f.vault.metadata("spare")?.kind).toBe("api-key");
});

it("rechecks managed-secret ownership after an awaited sign-in cancellation",async()=>{
 const f=await fixture(),fm=Object.create(FleetManager.prototype) as any;
 mkdirSync(join(f.home,"credential-profiles/claude-code/spare"),{recursive:true});
 let finish!:(value:boolean)=>void;const held=new Promise<boolean>(r=>{finish=r;});let entered!:()=>void;const began=new Promise<void>(r=>{entered=r;});
 Object.assign(fm,{dataDir:f.home,profileSignInsInstance:{cancelAccount:()=>{entered();return held;}},logger:{info:()=>{}}});
 const removing=fm.removeAccountProfile("claude-code","spare","spare","test-admin",undefined,{cancelSignIn:true});await began;
 f.vault.write("spare",0,{kind:"api-key",value},actor);finish(true);
 expect(await removing).toEqual({ok:false,error:"credential_connected"});
});

it("keeps the legacy DELETE route for a profile literally named credential",async()=>{
 const f=await fixture(),remove=vi.fn(async()=>({ok:true as const}));f.ctx.removeAccountProfile=remove;
 const data=JSON.stringify({confirm:"credential"}),c=f.open("DELETE",{...f.session(),"content-length":String(Buffer.byteLength(data))},"","/ui/accounts/claude-code/credential");c.req.end(data);
 expect((await c.done).status).toBe(200);expect(remove).toHaveBeenCalledWith("claude-code","credential","credential",expect.any(String));
});
it("selecting subscription needs explicit confirmation, current local verified authority and revision CAS",async()=>{
 const f=await fixture();await f.call("PUT",{profile:null,revision:0,kind:"api-key",value});
 const body={profile:null,revision:1,source:"subscription",confirm:true};
 expect((await f.call("POST",{...body,confirm:false})).status).toBe(400);
 f.setVerified(false);expect((await f.call("POST",body)).status).toBe(403);f.setVerified(true);
 f.setGateway(true);expect((await f.call("POST",body)).status).toBe(403);f.setGateway(false);
 expect((await f.call("POST",body,{...f.session(),"x-agend-csrf":"wrong"})).status).toBe(401);
 expect((await f.call("POST",body)).body.credential).toMatchObject({source:"subscription",revision:2,kind:null});
 expect((await f.call("POST",body)).status).toBe(409);
 expect(f.vault.history().some((row:any)=>row.action==="select-subscription"&&row.outcome==="ok")).toBe(true);
});

it("setup-token controls share the real local verified/CSRF gate and reject secret-bearing or executable request fields",async()=>{
 const f=await fixture(),operate=vi.fn(async()=>({login:{id:"a".repeat(32),revision:1,phase:"authorization",mine:true,url:"https://claude.ai/oauth/authorize?fixture=1"}}));
 (f.ctx as any).claudeSetupTokenOperation=operate;
 const body={operation:"start",profile:null,revision:0};
 const call=async(headers=f.session(),data=body as any)=>{const wire=JSON.stringify(data),q=f.open("POST",{...headers,"content-length":String(Buffer.byteLength(wire))},"","/ui/claude-credentials/setup-token");q.req.end(wire);return q.done;};
 f.setVerified(false);expect((await call()).status).toBe(403);f.setVerified(true);
 f.setGateway(true);expect((await call()).status).toBe(403);f.setGateway(false);
 expect((await call({...f.session(),"x-agend-csrf":"wrong"})).status).toBe(401);
 expect((await call(f.session("read"))).status).toBeGreaterThanOrEqual(400);
 expect((await call(f.session(),{...body,argv:["other"]})).status).toBe(400);expect(operate).not.toHaveBeenCalled();
 const response=await call();expect(response.status).toBe(200);expect(operate).toHaveBeenCalledOnce();
 const [owner,request]=operate.mock.calls[0] as any;expect(owner.current()).toBe(true);expect(owner.actor).toMatchObject({adapterId:"host",userId:"operator"});expect(request).toEqual(body);
 f.setVerified(false);expect(owner.current()).toBe(false);
});
