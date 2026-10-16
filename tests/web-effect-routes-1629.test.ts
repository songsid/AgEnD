/** Owned scratch HTTP listener; no FleetManager lifecycle, account, provider, child process or preview frame. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WebEffectLibrary } from "../src/web-effect-library.js";
import { WebEffectProfiles } from "../src/web-effect-profiles.js";
import { WebEffectService } from "../src/web-effect-service.js";
import { ThemeStore } from "../src/web-theme-store.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { webPersonKey } from "../src/web-profile.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { encodeEffectFiles } from "../src/web-effect-upload.js";
const roots:string[]=[], servers:Server[]=[];
afterEach(async()=>{ vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(s=>new Promise<void>(resolve=>{s.closeAllConnections();s.close(()=>resolve());})));for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true}); });
const owner=(id:string)=>({adapterId:"discord",userId:id});
const input=()=>encodeEffectFiles(new Map([["effect.json",Buffer.from(JSON.stringify({v:1,runtime:"canvas-worker-v1",worker:"worker.js",name:"fixture",title:"Fixture",regions:["chat"],layer:"front",wants:[]}))],["worker.js",Buffer.from("agend.ready()")]]))!;
const profile=()=>({v:1,device:"standard",verdict:"ok",reason:null,samples:1,fps_p50:60,fps_p10:60,fps_floor:54,long_task_p95:null,long_task_samples:0,attributed_long_task_p95:null,attributed_samples:0,attribution:"unknown",load_ms:null});
async function fixture(idleMs?:number){
 mkdirSync(".artifacts",{recursive:true});const root=mkdtempSync(join(process.cwd(),".artifacts/effect-routes-"));roots.push(root);
 const library=new WebEffectLibrary(root),themes=new ThemeStore(root),profiles=new WebEffectProfiles(root);let wall=0;const sessions=new WebSessionStore({now:()=>wall,...(idleMs===undefined?{}:{policy:{local:{absoluteMs:60000,idleMs}}})}),token="test-effect-token",changed=vi.fn();
 library.registerReferenceSource("themes",()=>themes.placedEffects().flatMap(row=>row.ids.map(id=>({id,holder:`instance:${row.name}`}))));
 const service=new WebEffectService({library,themes,profiles,known:n=>n==="own",changed});
 const ctx={webToken:token,webSessions:sessions,effectService:service} as unknown as WebApiContext;
 const server=createServer((req,res)=>{if(!handleWebRequest(req,res,new URL(req.url!,"http://localhost"),ctx)){res.writeHead(404);res.end();}});servers.push(server);
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`;
 const session=(id="alice",tier:"admin"|"read"="admin")=>{const made=sessions.create({tier,surface:"local",label:"test",tokenEpoch:tokenEpoch(token),owner:owner(id)});return {id:made.sessionId,cookie:`agend_session=${made.sessionId}`,headers:{cookie:`agend_session=${made.sessionId}`,origin,"x-agend-csrf":csrfTokenFor(made.sessionId)}};};
 const call=(method:string,path:string,headers:Record<string,string>={},body?:Buffer|string)=>new Promise<{status:number;body:any;headers:Record<string,unknown>} >((resolve,reject)=>{const r=request({host:"127.0.0.1",port,method,path,headers},res=>{const chunks:Buffer[]=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve({status:res.statusCode!,headers:res.headers,body:res.headers["content-type"]==="image/png"?Buffer.concat(chunks):JSON.parse(Buffer.concat(chunks).toString())}));});r.on("error",reject);r.setTimeout(5000,()=>r.destroy(Error("scratch HTTP deadline")));r.end(body);});
 return {root,library,themes,profiles,sessions,token,service,ctx,session,call,changed,origin,at:(n:number)=>{wall=n;}};
}
describe("#1629 human-only effects routes",()=>{
 it("real session upload/list/apply/resource/report/remove/delete, with no implicit claim or export grant",async()=>{
  const f=await fixture(),a=f.session(),b=f.session("bob");const upload=await f.call("POST","/ui/effects/upload",a.headers,input());expect(upload.status).toBe(200);const id=upload.body.id;
  expect((await f.call("GET","/ui/effects",a.headers)).body).toMatchObject({effects:[{id}]});expect((await f.call("GET","/ui/effects",b.headers)).body).toEqual({effects:[]});
  expect((await f.call("POST","/ui/effects/apply",a.headers,JSON.stringify({instance:"own",id}))).status).toBe(200);
  expect((await f.call("GET",`/ui/effects/resource/${id}?instance=own`,b.headers)).body).toMatchObject({id,code:"agend.ready()"});expect((await f.call("GET",`/ui/effects/resource/${id}`,b.headers)).status).toBe(404);
  expect((await f.call("POST",`/ui/effects/profile/${id}?instance=own`,b.headers,JSON.stringify(profile()))).status).toBe(200);expect((await f.call("POST",`/ui/effects/profile/${id}?instance=own`,b.headers,JSON.stringify(profile()))).status).toBe(429);
  expect((await f.call("GET",`/ui/effects/profile/${id}`,b.headers)).status).toBe(404);expect((await f.call("GET",`/ui/effects/profile/${id}`,a.headers)).body).toMatchObject({records:[{source:"reported_host"}]});
  expect(f.library.read(id,{kind:"human",id:webPersonKey(owner("bob"))}).ok).toBe(false);
  expect((await f.call("POST","/ui/effects/remove",b.headers,JSON.stringify({instance:"own",id}))).status).toBe(200);expect((await f.call("GET",`/ui/effects/resource/${id}?instance=own`,b.headers)).status).toBe(404);
  expect((await f.call("DELETE",`/ui/effects/${id}`,a.headers)).status).toBe(200);
 });
 it("poster responses have private no-store/nosniff/sandbox headers and the same resource ACL",async()=>{
  const f=await fixture(),a=f.session(),b=f.session("bob"),files=new Map<string,Uint8Array>(JSON.parse(input().toString()).map((file:{path:string;data_b64:string})=>[file.path,Buffer.from(file.data_b64,"base64")]));
  files.set("poster.png",Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=","base64"));const uploaded=await f.call("POST","/ui/effects/upload",a.headers,encodeEffectFiles(files)!);expect(uploaded.status).toBe(200);const id=uploaded.body.id;
  const image=await f.call("GET",`/ui/effects/image/${id}/poster.png`,a.headers);expect(image.status).toBe(200);expect(image.headers).toMatchObject({"content-type":"image/png","cache-control":"private, no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; sandbox"});expect(Buffer.isBuffer(image.body)).toBe(true);
  expect((await f.call("GET",`/ui/effects/image/${id}/poster.png`,b.headers)).status).toBe(404);await f.call("POST","/ui/effects/apply",a.headers,JSON.stringify({id,instance:"own"}));expect((await f.call("GET",`/ui/effects/image/${id}/poster.png?instance=own`,b.headers)).status).toBe(200);expect((await f.call("GET",`/ui/effects/image/${id}/cursor.png?instance=own`,b.headers)).status).toBe(404);
 });
 it("anonymous/header-token/read-only/missing-CSRF callers cannot write a human claim",async()=>{
  const f=await fixture(),ro=f.session("reader","read"),a=f.session();
  expect((await f.call("GET","/ui/effects")).status).toBe(401);
  for(const method of ["GET","POST"]){const r=await f.call(method,method==="GET"?"/ui/effects":"/ui/effects/upload",{"x-agend-token":f.token},method==="POST"?input():undefined);expect(r.status).toBe(403);}
  expect((await f.call("GET","/ui/effects",ro.headers)).status).toBe(200);expect((await f.call("POST","/ui/effects/upload",ro.headers,input())).status).toBe(403);
  expect((await f.call("POST","/ui/effects/upload",{cookie:a.cookie},input())).status).toBe(401);expect(f.changed).not.toHaveBeenCalled();
 });
 it("sharing is explicit and actor-bound; a body cannot set caller, provenance or holder",async()=>{
  const f=await fixture(),a=f.session(),b=f.session("bob"),id=(await f.call("POST","/ui/effects/upload",a.headers,input())).body.id;
  expect((await f.call("POST","/ui/effects/share",b.headers,JSON.stringify({id,shared:true}))).status).toBe(404);
  for(const extra of [{person:webPersonKey(owner("alice"))},{by:"human"},{holder:"mod:"+"a".repeat(32)}])expect((await f.call("POST","/ui/effects/share",b.headers,JSON.stringify({id,shared:true,...extra}))).status).toBe(400);
  expect((await f.call("POST","/ui/effects/share",a.headers,JSON.stringify({id,shared:true}))).status).toBe(200);expect((await f.call("GET","/ui/effects",b.headers)).body).toMatchObject({effects:[{id}]});
 });
 it("invalid UTF-8 cannot be hidden behind a duplicate JSON field",async()=>{
  const f=await fixture(),a=f.session(),id=(await f.call("POST","/ui/effects/upload",a.headers,input())).body.id;
  const bytes=Buffer.concat([Buffer.from('{"id":"'),Buffer.from([0xff]),Buffer.from(`","id":"${id}","shared":true}`)]);
  expect((await f.call("POST","/ui/effects/share",a.headers,bytes)).status).toBe(400);expect((await f.call("GET","/ui/effects",f.session("bob").headers)).body).toEqual({effects:[]});
 });
 it("a revoked session while the body is held cannot publish or mutate",async()=>{
  const f=await fixture(),a=f.session();const spy=vi.spyOn(f.service,"upload");
  let status=0;const res:any={headersSent:false,destroyed:false,writeHead(n:number){status=n;this.headersSent=true;},end(){},setHeader(){}};
  const req=Object.assign(new EventEmitter(),{method:"POST",url:"/ui/effects/upload",headers:{...a.headers,host:new URL(f.origin).host},destroy(){},resume(){}});
  expect(handleWebRequest(req as never,res,new URL(`${f.origin}/ui/effects/upload`),f.ctx)).toBe(true);expect(status).toBe(0);expect(req.listenerCount("data")).toBe(1);req.emit("data",input().subarray(0,10));f.sessions.revokeById(a.id);req.emit("data",input().subarray(10));req.emit("end");await Promise.resolve();await Promise.resolve();expect(status).toBe(401);expect(spy).not.toHaveBeenCalled();
 });
 it("every route is excluded from public routing and refused with a gateway context even if routed directly",async()=>{
  const f=await fixture();const paths=["/ui/effects","/ui/effects/placements",`/ui/effects/image/${"a".repeat(32)}/poster.png`,`/ui/effects/resource/${"a".repeat(32)}`,`/ui/effects/profile/${"a".repeat(32)}`,"/ui/effects/upload","/ui/effects/apply","/ui/effects/remove","/ui/effects/share",`/ui/effects/${"a".repeat(32)}`];
  const made=f.sessions.create({tier:"admin",surface:"gateway",exposureId:"e".repeat(32),label:"test",tokenEpoch:tokenEpoch(f.token)});
  for(const method of ["GET","POST","DELETE"]){for(const path of paths){expect(isPublicWebRoute(method,path)).toBe(false);let status=0;const res:any={headersSent:false,setHeader(){},writeHead(n:number){status=n;this.headersSent=true;},end(){}};
   const req=Object.assign(new EventEmitter(),{method,url:path,headers:{host:"x.trycloudflare.com",origin:"https://x.trycloudflare.com",cookie:`__Host-agend_session=${made.sessionId}`,"x-agend-csrf":csrfTokenFor(made.sessionId)},destroy(){},resume(){}});bindGatewayRequest(req,{surface:"gateway",exposureId:"e".repeat(32),expectedOrigin:"https://x.trycloudflare.com",isCurrent:()=>true});
   expect(handleWebRequest(req as never,res,new URL(`https://x.trycloudflare.com${path}`),f.ctx)).toBe(true);expect(status).toBe(method==="GET"?404:403);
  }}
 });
 it("automatic resource reads and profile posts do not keep an idle session alive, while CSRF still applies",async()=>{
  const f=await fixture(1000),a=f.session(),id=(await f.call("POST","/ui/effects/upload",a.headers,input())).body.id;
  f.at(500);expect((await f.call("GET",`/ui/effects/resource/${id}`,a.headers)).status).toBe(200);
  expect((await f.call("POST",`/ui/effects/profile/${id}`,{cookie:a.cookie},JSON.stringify(profile()))).status).toBe(401);
  f.at(800);expect((await f.call("POST",`/ui/effects/profile/${id}`,a.headers,JSON.stringify(profile()))).status).toBe(200);
  f.at(1001);expect((await f.call("GET","/ui/effects",a.headers)).status).toBe(401);
 });
 it("malformed and excessive request bodies refuse without reaching a store",async()=>{
  const f=await fixture(),a=f.session(),spy=vi.spyOn(f.service,"apply");expect((await f.call("POST","/ui/effects/apply",a.headers,"{" )).status).toBe(400);const oversized=await f.call("POST","/ui/effects/apply",a.headers," ".repeat(16385)).then(()=>"accepted",error=>error.code);expect(oversized).toBe("ECONNRESET");expect(spy).not.toHaveBeenCalled();
 });
});
