import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SettingsBaselines} from "../src/settings-baseline.js";
import {PassThrough} from "node:stream";
import {afterEach,expect,it,vi} from "vitest";
import {SettingsHttpConfirmation} from "../src/settings-http-confirmation.js";
import {SettingsConfirmationStore} from "../src/settings-confirmation.js";
import {prepareSettingsEffect} from "../src/settings-effect.js";
import {handleRequestContextControlApi,type RequestContextControlHost,type RequestContextControlView} from "../src/request-context-control-api.js";
import {settingsFingerprint} from "../src/settings-transaction.js";
const roots:string[]=[];
const stores:SettingsConfirmationStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const path="/api/settings/request-context";
function rig(){
 let alive=true,verified=true,strict=true,binding="signed-in-admin",enrolment=1;
 const view:RequestContextControlView={revision:4,enabled:false,everActivated:false,attempted:false,phase:"off",canChange:true,blockers:[],goBack:{attemptIds:["20261126T010203Z-abcdef12"],availableUntil:"2026-12-03T01:02:03.000Z",timeZone:"UTC"}};
 const writes=vi.fn(),csrf=vi.fn(()=>true);
 const host:RequestContextControlHost={principal:req=>req.headers.cookie?{binding,verified,current:()=>alive}:null,
  permitContinuation:csrf,snapshot:()=>structuredClone(view),read:()=>structuredClone(view),recheck:vi.fn(()=>structuredClone(view)),
  change:(input,actor)=>{
   // Production owner must check this again at its irreversible transaction, not merely at the HTTP boundary.
   if(!actor.execution||!actor.current())throw Error("verification-required");
   if(input.revision!==view.revision)throw Error("stale");
   return actor.execution.commit(()=>{writes(input);Object.assign(view,{revision:view.revision+1,enabled:input.action==="enable",everActivated:true,phase:input.action==="enable"?"on":"draining"});return structuredClone(view);});
  }};
 let activeHost=host;
 const store=new SettingsConfirmationStore({audit:vi.fn()});stores.push(store);
 const gate=new SettingsHttpConfirmation(store,{principal:req=>req.headers.cookie?{id:"admin-session",label:"Demo admin",source:"public_link",requester:{handle:"demo-handle",label:"Demo admin"},current:()=>alive}:null,
  requestContextControl:()=>activeHost,
  baseline:async()=>({config:{instances:{},defaults:{}}as any,classic:{},requestContextControl:()=>structuredClone(view),fingerprint:settingsFingerprint(view)}),snapshot:()=>({settings:1}),
  selfConfirm:()=>!strict&&verified?{label:"Demo admin",current:()=>alive&&verified}:null,
  totp:{state:()=>"ready",confirm:(_req,id,code,digest)=>{
   if(code!=="123456"||store.confirmDigest(id)!==digest)return {error:"wrong"};
   const expected=enrolment;return {label:"Demo admin",current:()=>alive&&verified&&enrolment===expected};
  }}});
 const request=async(method:string,target:string,body?:unknown,key="same-control")=>new Promise<{status:number;body:any}>((resolve,reject)=>{
  const req=Object.assign(new PassThrough(),{method,url:target,headers:{cookie:"never-replayed","idempotency-key":key}});
  const res:any={headersSent:false,destroyed:false,statusCode:200,writeHead(code:number){this.statusCode=code;this.headersSent=true;},setHeader:vi.fn(),end(text:string){resolve({status:this.statusCode,body:JSON.parse(text)});}};
  const next=(r:any,s:any,u:URL)=>{if(r!==req)expect(r.headers.cookie).toBeUndefined();return handleRequestContextControlApi(r,s,u,activeHost);};
  try{if(!gate.handle(req as any,res,new URL(target,"http://localhost"),next))next(req,res,new URL(target,"http://localhost"));req.end(body===undefined?undefined:JSON.stringify(body));}catch(e){reject(e);}
 });
 return {view,host,store,writes,csrf,request,verify:(v:boolean)=>verified=v,strict:(v:boolean)=>strict=v,revoke:()=>alive=false,replace:()=>binding="replacement-admin",reenrol:()=>enrolment++,retarget:()=>activeHost={...host},
  settle:async(id:string)=>{await vi.waitFor(()=>expect(store.get(id,"admin-session")?.state).not.toBe("applying"));return store.get(id,"admin-session")!;}};
}
it("a remote strict admin's On is a standard digest-bound pending change, then exactly one confirmed replay",async()=>{
 const r=rig(),held=await r.request("POST",path,{revision:4,action:"enable"});expect(held.status).toBe(202);expect(r.writes).not.toHaveBeenCalled();
 expect(held.body.pending_change).toMatchObject({state:"pending",totp:"ready"});const id=held.body.pending_change.id;
 const wrong=await r.request("POST",`/api/settings/pending/${id}/confirm-totp`,{code:"123456",digest:"wrong"});expect(wrong.status).toBe(401);expect(r.writes).not.toHaveBeenCalled();
 const confirmed=await r.request("POST",`/api/settings/pending/${id}/confirm-totp`,{code:"123456",digest:held.body.pending_change.confirm_digest});expect(confirmed.status).toBe(202);
 expect((await r.settle(id)).state).toBe("applied");expect(r.writes).toHaveBeenCalledOnce();expect(r.view.phase).toBe("on");
 expect((await r.request("POST",path,{revision:4,action:"enable"})).body.pending_change.id).toBe(id);expect(r.writes).toHaveBeenCalledOnce();
});
it("an ordinary verified admin follows the existing self-confirmation shortcut and receives the bare control result",async()=>{
 const r=rig();r.strict(false);const held=await r.request("POST",path,{revision:4,action:"disable"});expect(held.status).toBe(202);
 const done=await r.settle(held.body.pending_change.id);expect(done.state).toBe("applied");expect(done.outcome?.result).toMatchObject({phase:"draining",revision:5});
});
it.each(["unverified","revoked","replaced","offer-changed","retargeted"])("%s cannot apply the earlier offer",async kind=>{
 const r=rig(),held=await r.request("POST",path,{revision:4,action:"enable"}),id=held.body.pending_change.id;
 if(kind==="unverified")r.verify(false);else if(kind==="revoked")r.revoke();else if(kind==="replaced")r.replace();else if(kind==="retargeted")r.retarget();else r.view.goBack!.availableUntil="2026-12-04T01:02:03.000Z";
 await r.store.decide(id,"confirm",{label:"admin",current:()=>true});expect(r.writes).not.toHaveBeenCalled();expect(r.store.get(id,"admin-session")?.state).not.toBe("applied");
});
it("Check again stays read-only for an eligible unverified browser and never creates a confirmation",async()=>{
 const r=rig();r.verify(false);const read=await r.request("POST",path,{revision:4,action:"check"});expect(read.status).toBe(200);expect(r.host.recheck).toHaveBeenCalledOnce();expect(r.store.list("admin-session")).toHaveLength(0);expect(r.writes).not.toHaveBeenCalled();
 expect((await r.request("POST",path,{revision:4,action:"enable"})).status).toBe(403);
});
it("the Settings effect binds the entire offered state, exact resolution and strict action schema",()=>{
 const r=rig(),context={config:null,classic:{},requestContextControl:()=>r.view};
 const old=prepareSettingsEffect("POST",path,{revision:4,action:"enable"},context).diff!.fingerprint;r.view.goBack!.attemptIds=["20261127T010203Z-abcdef12"];
 expect(prepareSettingsEffect("POST",path,{revision:4,action:"enable"},context).diff!.fingerprint).not.toBe(old);
 expect(()=>prepareSettingsEffect("POST",path,{revision:4,action:"resolve",blockerId:"other",resolution:"stop-work"},context)).toThrow("stale");
 expect(()=>prepareSettingsEffect("POST",path,{revision:4,action:"enable",verified:true},context)).toThrow("invalid-request");
});

it("the real bounded baseline captures the control offer consistently with its committed fingerprint",async()=>{
 const root=mkdtempSync(join(tmpdir(),"settings-control-s230-"));roots.push(root);const r=rig();
 const baseline=new SettingsBaselines({dataDir:root,configPath:()=>null,config:()=>null,current:()=>1,requestContextControl:()=>structuredClone(r.view)});
 const first=await baseline.read();expect(first.fingerprint).toBe(baseline.captureCommitted());r.view.revision++;expect((await baseline.read()).fingerprint).not.toBe(first.fingerprint);
 let reads=0;const changed=new SettingsBaselines({dataDir:root,configPath:()=>null,config:()=>null,current:()=>1,requestContextControl:()=>({...r.view,revision:reads++})});
 await expect(changed.read()).rejects.toThrow("settings_changed");
});
