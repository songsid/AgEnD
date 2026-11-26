import {expect,it} from "vitest";
import {FleetManager} from "../src/fleet-manager.js";
import {WebSessionStore,tokenEpoch} from "../src/web-session.js";
import {noAuthority} from "../src/authority/web-authority.js";
const token="a".repeat(48),url=new URL("http://localhost/api/settings/request-context");
function rig(options:{host?:boolean;bound?:boolean;tier?:"admin"|"read"|"guest";webOnly?:boolean;remote?:boolean}={}){
 const sessions=new WebSessionStore(),session=sessions.create({tier:options.tier??"admin",surface:"local",label:"Fixture browser",tokenEpoch:tokenEpoch(token),...(options.host?{host:true}:{}),...(options.bound===false||options.host?{}:{owner:{adapterId:"fixture",userId:"fixture-admin"}})});
 let verified=false,admin=true,epoch=1;
 const fm:any=Object.assign(Object.create(FleetManager.prototype),{webSessions:sessions,adapters:new Map([["fixture",{id:"fixture",type:"telegram"}]]),worlds:new Map(),fleetConfig:{channels:[{id:"fixture",type:"telegram"}],instances:{}},isWebOnlyFleet:()=>options.webOnly===true,adminGate:()=>admin?"ok":"denied",
  webAuthority:({session:live}:any)=>({refusal:verified?null:"not_authorized",authority:verified?{kind:"web-verified",actor:live.owner?{adapter_id:live.owner.adapterId,user_id:live.owner.userId}:{adapter_id:"host",user_id:"operator"},authority_epoch:epoch,session:{handle:live.handle,peer:"loopback",signed_in_at:"2026-01-01T00:00:00Z",authorized_at:"2026-01-01T00:01:00Z"}}:noAuthority(epoch)})});
 Object.defineProperty(fm,"webToken",{value:token});
 const req:any={method:"GET",url:url.pathname,headers:{host:"localhost",cookie:`agend_session=${session.sessionId}`},socket:{remoteAddress:options.remote?"192.0.2.1":"127.0.0.1"}};
 return {fm,req,sessions,session,principal:()=>fm.requestContextControlPrincipal(req,url),verified:(v:boolean)=>verified=v,admin:(v:boolean)=>admin=v,epoch:()=>epoch++};
}
it("recognized unverified administrators can read but carry no decision authority",()=>{
 const f=rig(),p=f.principal()!;expect(p).not.toBeNull();expect(p.verified).toBe(false);expect(p.current()).toBe(true);expect(f.fm.requestContextPolicy).toBeUndefined();
 f.admin(false);expect(p.current()).toBe(false);expect(f.principal()).toBeNull();
});
it("the same currently verified native administrator is eligible away from the host, without a local-only restriction",()=>{
 const f=rig({remote:true});f.verified(true);const p=f.principal()!;expect(p.verified).toBe(true);expect(p.current()).toBe(true);
 f.epoch();expect(p.current()).toBe(false);const next=f.principal()!;f.verified(false);expect(next.current()).toBe(false);expect(f.principal()?.verified).toBe(false);
});
it("the host-issued local session is the host owner even on a chat Fleet, never a bare loopback or replay elsewhere",()=>{
 const f=rig({host:true});expect(f.principal()?.verified).toBe(true);const p=f.principal()!;f.req.socket.remoteAddress="192.0.2.1";expect(p.current()).toBe(false);expect(f.principal()).toBeNull();
 expect(rig({bound:false}).principal()).toBeNull();
});
it.each(["guest","read"]as const)("a %s session cannot become a control principal",tier=>{const f=rig({tier});f.verified(true);expect(f.principal()).toBeNull();});
it("header tokens and revoked sessions never identify an owner control principal",()=>{
 const f=rig();const p=f.principal()!;f.sessions.revokeByHandle(f.session.record.handle);expect(p.current()).toBe(false);expect(f.principal()).toBeNull();delete f.req.headers.cookie;f.req.headers.authorization=`Bearer ${token}`;expect(f.principal()).toBeNull();
});
it("a web-only host can use current web-verified authority remotely, but cannot lend it to a chat Fleet",()=>{
 const f=rig({host:true,webOnly:true,remote:true});f.verified(true);expect(f.principal()?.verified).toBe(true);const other=rig({host:true,remote:true});other.verified(true);expect(other.principal()).toBeNull();
});
