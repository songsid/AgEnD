/** Dormant HTTP transport, synthetic principals; no authority/browser/provider calls. */
import {PassThrough} from "node:stream";
import {randomUUID} from "node:crypto";
import {expect,it,vi} from "vitest";
import {handleRequestContactApi,type RequestContactApiHost} from "../src/request-contact-api.js";
import type {RequestContactCardV1,RequestContactPrincipal} from "../src/request-contact-types.js";
const id=`R${randomUUID()}`,path=`/ui/api/request-contact-authorizations/${id}`;
const snapshot={ticketRevision:1,policyRevision:0,imageSha256:"a".repeat(64)};
const decision={snapshot,decision:"approve-once"};
function rig(){
 let verified=false,live=true,allowed=true,userId="demo-admin",binding="session-a";
 const card:RequestContactCardV1={version:1,engine:"request-v1",ticket:{id,revision:1,state:"pending",source:"source",target:"target",verb:"send_to_instance",message:"PRIVATE_SYNTHETIC_REQUEST",createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString()},sourceLabel:"Demo source",targetLabel:"Demo target",requester:{kind:"person",platform:"discord",userId:"demo-person"},ingress:"restricted-room",sourceAudience:null,returnAudience:null,grantCandidates:[],reason:"restricted-request",approvalScope:"root-request",authority:"none",snapshot,actions:{canDecide:false,canGrant:true,requiresVerification:true}};
 const principal=():RequestContactPrincipal=>({person:{platform:"discord",adapterId:"fixture",userId,label:"Demo admin"},binding,verified,current:()=>live});
 const host:RequestContactApiHost={principal:vi.fn(principal),permitContinuation:vi.fn(()=>true),canRead:vi.fn(()=>allowed),read:vi.fn(()=>card),list:vi.fn(()=>({version:1 as const,items:[card],nextCursor:null})),decide:vi.fn(()=>({...card,ticket:{...card.ticket,state:"approved" as const}}))};
 const request=(method="GET",url=path,body?:unknown,selectedHost:RequestContactApiHost|undefined=host)=>{
  const req=Object.assign(new PassThrough(),{method,url,headers:{}});let finish!:()=>void;
  const done=new Promise<void>(resolve=>{finish=resolve;}),res:any={destroyed:false,writableEnded:false,status:0,body:"",writeHead:(status:number)=>{res.status=status;},end:(text:string)=>{res.body=text;res.writableEnded=true;finish();}};
  const consumed=handleRequestContactApi(req as any,res,new URL(url,"http://localhost"),selectedHost);if(body!==undefined)req.end(typeof body==="string"?body:JSON.stringify(body));
  return {req,res,consumed,done:async()=>{await done;return {status:res.status,body:JSON.parse(res.body)};}};
 };
 return {host,card,request,verified:(v:boolean)=>{verified=v;},live:(v:boolean)=>{live=v;},allowed:(v:boolean)=>{allowed=v;},user:(v:string)=>{userId=v;},binding:(v:string)=>{binding=v;}};
}
it("OFF host is absent: no card, identity lookup or migration is exposed",()=>{
 const req:any={method:"GET"},res:any={writeHead:vi.fn(),end:vi.fn()};expect(handleRequestContactApi(req,res,new URL(path,"http://localhost"))).toBe(true);expect(res.writeHead).toHaveBeenCalledWith(404,expect.anything());expect(res.end).toHaveBeenCalledWith('{"error":"not-found"}');
});
it("leaves legacy endpoint semantics to the existing owner",()=>{const f=rig();expect(f.request("GET","/ui/api/contact-authorizations").consumed).toBe(false);});
it("an unverified recognized manager can read the same card, without deciding or authorizing",async()=>{
 const f=rig(),r=await f.request().done();expect(r.status).toBe(200);expect(r.body).toMatchObject({authority:"none",actions:{requiresVerification:true,canDecide:false},ticket:{id}});expect(f.host.decide).not.toHaveBeenCalled();
});
it("no admitted identity is refused before reading card data",async()=>{const f=rig();f.live(false);expect(await f.request().done()).toEqual({status:401,body:{error:"sign-in-required"}});expect(f.host.read).not.toHaveBeenCalled();});
it.each(["session","account","role"])("an awaited card read rechecks its %s before returning private content",async change=>{
 const f=rig();let release!:(v:RequestContactCardV1)=>void;vi.mocked(f.host.read).mockReturnValue(new Promise(done=>{release=done;}));const r=f.request();
 if(change==="session")f.binding("session-b");if(change==="account")f.user("other-admin");if(change==="role")f.allowed(false);release(f.card);
 const result=await r.done();expect([403,404]).toContain(result.status);expect(JSON.stringify(result)).not.toContain("PRIVATE_SYNTHETIC_REQUEST");
});
it("list drops a card whose current target scope was revoked after the awaited read",async()=>{
 const f=rig();let release!:(v:any)=>void;vi.mocked(f.host.list).mockReturnValue(new Promise(done=>{release=done;}));const r=f.request("GET","/ui/api/request-contact-authorizations");f.allowed(false);release({version:1,items:[f.card],nextCursor:null});
 expect(await r.done()).toEqual({status:200,body:{version:1,items:[],nextCursor:null}});
});
it("an unverified decision cannot wait for browser verification and dispatch automatically",async()=>{
 const f=rig(),r=f.request("POST",`${path}/decision`);expect(await r.done()).toEqual({status:403,body:{error:"verification-required"}});f.verified(true);r.req.end(JSON.stringify(decision));await Promise.resolve();expect(f.host.decide).not.toHaveBeenCalled();
});
it.each(["revoked","account","session"])("a verified decision rechecks %s after its body read",async change=>{
 const f=rig();f.verified(true);const r=f.request("POST",`${path}/decision`);if(change==="revoked")f.verified(false);if(change==="account")f.user("other-admin");if(change==="session")f.binding("session-b");r.req.end(JSON.stringify(decision));
 expect((await r.done()).status).toBe(403);expect(f.host.decide).not.toHaveBeenCalled();
});
it("a resumed browser still needs its new explicit decision request, then the exact CAS is forwarded",async()=>{
 const f=rig();await f.request().done();f.verified(true);await f.request().done();expect(f.host.decide).not.toHaveBeenCalled();expect((await f.request("POST",`${path}/decision`,decision).done()).status).toBe(200);
 expect(f.host.decide).toHaveBeenCalledWith(id,decision,expect.objectContaining({verified:true}));
});
it("continuation/CSRF refusal prevents the writer",async()=>{
 const f=rig();f.verified(true);vi.mocked(f.host.permitContinuation).mockImplementation((_req,res)=>{res.writeHead(403);res.end('{"error":"csrf"}');return false;});expect(await f.request("POST",`${path}/decision`,decision).done()).toEqual({status:403,body:{error:"csrf"}});expect(f.host.decide).not.toHaveBeenCalled();
});
it.each(["actor","engine","rootContextId","forwards"])("client %s cannot select identity, writer or provenance",async key=>{
 const f=rig();f.verified(true);expect((await f.request("POST",`${path}/decision`,{...decision,[key]:"injected"}).done()).status).toBe(400);expect(f.host.decide).not.toHaveBeenCalled();
});
it.each(["person=someone","status=nope","agent=a&agent=b","cursor="])("list rejects unsupported or ambiguous filter %s",async query=>{
 const f=rig();expect((await f.request("GET",`/ui/api/request-contact-authorizations?${query}`).done()).status).toBe(400);expect(f.host.list).not.toHaveBeenCalled();
});
it.each(["conflict","policy-conflict","operation-conflict","expired","already-decided","stale-generation"])("preserves writer %s without retry",async code=>{
 const f=rig();f.verified(true);vi.mocked(f.host.decide).mockImplementation(()=>{throw Error(code);});expect(await f.request("POST",`${path}/decision`,decision).done()).toEqual({status:409,body:{error:code}});expect(f.host.decide).toHaveBeenCalledTimes(1);
});
it("storage failures are unavailable without leaking private exception text",async()=>{const f=rig();vi.mocked(f.host.read).mockImplementation(()=>{throw Error("PRIVATE_STORAGE_PATH");});expect(await f.request().done()).toEqual({status:503,body:{error:"unavailable"}});});

it("unsupported legacy input returns a safe held-upgrade reason instead of a raw machine error",async()=>{
 const f=rig();f.verified(true);vi.mocked(f.host.decide).mockImplementation(()=>{throw Object.assign(Error("PRIVATE_STORAGE_DETAIL"),{code:"request-context-legacy-decision-upgrade-required"});});
 const result=await f.request("POST",`${path}/decision`,decision).done();expect(result.status).toBe(409);expect(result.body.error).toBe("upgrade-required");expect(result.body.message).toBeTruthy();expect(JSON.stringify(result)).not.toContain("PRIVATE_STORAGE_DETAIL");
});
it("All passes its explicit status to the scoped collection owner",async()=>{
 const f=rig();expect((await f.request("GET","/ui/api/request-contact-authorizations?status=all").done()).status).toBe(200);expect(f.host.list).toHaveBeenCalledWith({status:"all"},expect.anything());
});
