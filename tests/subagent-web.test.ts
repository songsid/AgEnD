import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { handleWebRequest, serveAppShell } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { bindGuestRequest, guestRouteDecision } from "../src/web-guest-access.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
const TOKEN="a".repeat(48),origin="https://fixture.example";
const answer={subagents:1,owner:"owned",status:"ok",runs:[{task:"PRIVATE_CHILD_TASK"}]};
function rig({tier="admin",gateway=false,header=false,service=vi.fn(async()=>answer)}:{tier?:"admin"|"read"|"guest";gateway?:boolean;header?:boolean;service?:any}={}) {
 const sessions=new WebSessionStore();const sid=sessions.create({tier,surface:gateway?"gateway":"local",label:"test",tokenEpoch:tokenEpoch(TOKEN),...(gateway?{exposureId:"e1"}:{}),...(tier==="guest"?{owner:{adapterId:"discord",userId:"1"}}:{})}).sessionId as string;
 const req=Object.assign(new EventEmitter(),{method:"GET",url:"/ui/subagents?instance=dev",headers:{host:gateway?"fixture.example":"127.0.0.1:19280",...(header?{"x-agend-token":TOKEN}:{cookie:`${gateway?"__Host-agend_session":"agend_session"}=${sid}`})}});
 if(gateway)bindGatewayRequest(req as never,{surface:"gateway",exposureId:"e1",expectedOrigin:origin,isCurrent:()=>true});
 if(tier==="guest")bindGuestRequest(req as never,{owner:{adapterId:"discord",userId:"1"},scope:()=>new Set(["dev"]),current:()=>true} as never);
 let status=0,body="",finish!:()=>void;const done=new Promise<void>(r=>finish=r);const headers:Record<string,string>={};
 const res={destroyed:false,setHeader:(k:string,v:string)=>headers[k]=v,writeHead:(n:number)=>status=n,end:(s="")=>{body=String(s);finish();}};
 const ctx={webToken:TOKEN,webSessions:sessions,subagentRuns:service,fleetConfig:{instances:{}},logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}};
 return {req,res,ctx,service,sessions,sid,done,status:()=>status,body:()=>body,headers,start(){return handleWebRequest(req as never,res as never,new URL(req.url,"http://127.0.0.1:19280"),ctx as never);}};
}
describe("private sub-Agent web observation",()=>{
 it.each([false,true])("admits only current local admin (header=%s)",async header=>{const r=rig({header});expect(r.start()).toBe(true);await r.done;expect(r.status()).toBe(200);expect(JSON.parse(r.body())).toEqual(answer);expect(r.service).toHaveBeenCalledExactlyOnceWith("dev");});
 it.each([{tier:"read" as const},{tier:"guest" as const},{gateway:true},{gateway:true,header:true}])("refuses before reading: %j",async opts=>{const r=rig(opts);r.start();await r.done;expect(r.status()).toBe(opts.gateway&&opts.header?401:403);expect(r.body()).not.toContain("PRIVATE");expect(r.service).not.toHaveBeenCalled();});
 it("refuses a revoked admin after the asynchronous read",async()=>{let release!:(a:unknown)=>void;const r=rig({service:vi.fn(()=>new Promise(resolve=>release=resolve))});r.start();r.sessions.revokeById(r.sid);release(answer);await r.done;expect(r.status()).toBe(403);expect(r.body()).not.toContain("PRIVATE");});
 it("never projects child data onto guest/public/View allowlists and never renews idle auth",()=>{const url=new URL("/ui/subagents?instance=dev",origin);expect(guestRouteDecision("GET",url,new Set(["dev"])).kind).toBe("deny");expect(isPublicWebRoute("GET",url.pathname)).toBe(false);expect(isPassiveWebRead("GET",url.pathname)).toBe(true);});
 it("bounds saturation with an explicit retry response",async()=>{const r=rig({service:vi.fn(async()=>({...answer,status:"busy",runs:[]}))});r.start();await r.done;expect(r.status()).toBe(429);expect(r.headers["Retry-After"]).toBe("2");expect(r.body()).not.toContain("PRIVATE");});
 it.each(["../dev","","x".repeat(129)])("refuses invalid instance %s",async name=>{const r=rig();r.req.url="/ui/subagents?instance="+encodeURIComponent(name);r.start();await r.done;expect(r.status()).toBe(400);expect(r.service).not.toHaveBeenCalled();});
 it.each([{},{tier:"read" as const},{tier:"guest" as const},{gateway:true}])("offers the module only on the admin shell: %j",opts=>{const r=rig(opts);r.req.url="/ui";serveAppShell(r.req as never,r.res as never,r.ctx as never,"full");expect(r.body().includes('data-subagents="1"')).toBe(!opts.tier&&!opts.gateway);});
 it("does not offer it in public View",()=>{const r=rig();serveAppShell(r.req as never,r.res as never,r.ctx as never,"view-only");expect(r.body()).not.toContain('data-subagents="1"');});
});
