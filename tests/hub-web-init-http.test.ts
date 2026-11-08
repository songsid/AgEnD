/** Real fleet HTTP/D3 cookie, verified fake LDAPS, real initializer/S1 and actual Hub HTTPS; scratch only. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { X509Certificate } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as directoryDriver from "../src/hub/directory/directory.js";
import { WebSessionStore } from "../src/web-session.js";
import { FleetManager } from "../src/fleet-manager.js";
import { HubRuntime } from "../src/hub/runtime.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_CSRF_HEADER } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { directoryCertificates, directoryCaFixture } from "./support/hub-directory-ca-fixture.js";
import { groupWirePeer, PERSON_ID } from "./support/hub-group-directory-wire.js";
import { tempDir } from "./support/hub-init-fixtures.js";
import { freeHubPort } from "./helpers/hub-rig.js";

const prefix="/api/settings/hub/setup";
let certs:ReturnType<typeof directoryCertificates>;
beforeAll(()=>{certs=directoryCertificates();});afterAll(()=>certs.cleanup());
interface Reply {status:number;headers:import("node:http").IncomingHttpHeaders;body:any}
function request(port:number,method:string,path:string,headers:Record<string,string>={},body?:string):Promise<Reply>{return new Promise((resolve,reject)=>{
  const r=httpRequest({host:"127.0.0.1",port,method,path,headers},res=>{let text="";res.on("data",c=>{text+=c;});res.on("end",()=>resolve({status:res.statusCode!,headers:res.headers,body:JSON.parse(text||"{}")}));});
  r.on("error",reject);r.end(body);
});}
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();vi.restoreAllMocks();vi.unstubAllEnvs();});
async function fixture(){
  const home=tempDir("hub-web-http-"),path=join(home,"fleet.yaml");
  writeFileSync(path,"# Existing fleet settings\ninstances: {}\nweb:\n  verified_authority:\n    enabled: true\n",{mode:0o600});
  const users=[{id:PERSON_ID,login:"avery",dn:"CN=Avery,DC=example,DC=test",password:"Dummy-person-only",eligible:true}];
  const peer=await groupWirePeer(certs.leaf,users),fm=new FleetManager(home),internal=fm as any;
  const sink=()=>{};fm.logger={info:sink,warn:sink,error:sink,debug:sink,trace:sink,fatal:sink,child:()=>fm.logger} as any;
  vi.stubEnv("AGEND_FLEET_DATA_DIR",process.env.AGEND_FLEET_DATA_DIR);vi.stubEnv("AGEND_FLEET_CONFIG_PATH",process.env.AGEND_FLEET_CONFIG_PATH);
  fm.loadConfig(path);internal.initializeWebAuthTokens();internal.startHealthServer(0);
  await vi.waitFor(()=>expect(fm.getDashboardAccess().ready).toBe(true));
  const port=(internal.healthServer.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`,token=fm.getDashboardAccess().token!;
  const signIn=async(code?:string)=>{
    code??=(await request(port,"POST","/auth/issue-code",{"x-agend-token":token,origin})).body.code;
    const login=await request(port,"POST","/auth/login",{"content-type":"application/json",origin},JSON.stringify({code}));expect(login.status).toBe(200);
    const value=login.headers["set-cookie"]![0]!.split(";")[0]!,id=value.slice(value.indexOf("=")+1);return {id,cookie:value};
  };
  const host=await signIn();
  const headers=(id=host.id)=>({origin,"content-type":"application/json",cookie:`agend_session=${id}`,[WEB_CSRF_HEADER]:csrfTokenFor(id)});
  const call=(action:string,value?:unknown,extra:Record<string,string>={},id=host.id)=>request(port,action?"POST":"GET",prefix+action,{...headers(id),...extra},value===undefined?undefined:JSON.stringify(value));
  const webPort=await freeHubPort();let memberPort=await freeHubPort();while(memberPort===webPort)memberPort=await freeHubPort();
  const input={name:"Fictional Hub",webOrigin:`https://127.0.0.1:${webPort}`,memberOrigin:`https://127.0.0.1:${memberPort}`,
    webListen:{host:"127.0.0.1",port:webPort},memberListen:{host:"127.0.0.1",port:memberPort},
    directory:{realm:"fictional",url:`ldaps://127.0.0.1:${peer.port}`,caPem:certs.ca,baseDn:"DC=example,DC=test",bindDn:"CN=Reader,DC=example,DC=test",profile:"ad"},
    confirmedCa:[new X509Certificate(certs.ca).fingerprint256],bindPassword:"Dummy-service-only",administratorLogin:"avery",
    retention:{contentDays:30,eventDays:90},coexistence:"dedicated"};
  let runtime:HubRuntime|undefined;
  const r={home,fm,internal,peer,users,port,origin,token,host,headers,call,input,signIn,
    async mount(){runtime=new HubRuntime({home,log:sink});await runtime.apply({hub:fm.getRawFleetConfig().hub});return runtime;},
    async close(){await (await internal.hubSetupInit)?.close();await runtime?.close();const s=internal.healthServer as Server;internal.healthServer=null;
      s.closeAllConnections();await new Promise<void>(resolve=>s.close(()=>resolve()));internal.webSessions?.flush?.();await peer.close();rmSync(home,{recursive:true,force:true});}};
  cleanups.push(r.close);return r;
}

function held() { let release!:()=>void; const promise=new Promise<void>(r=>{release=r;});return {promise,release}; }
/** Pause only after the real verified LDAPS lookup settles; all directory/HTTP replies remain real. */
function holdAdministratorLookup() {
  const entered=held(),resume=held(),real=directoryDriver.createHubDirectory;
  vi.spyOn(directoryDriver,"createHubDirectory").mockImplementation((...args)=>{
    const directory=real(...args),lookup=directory.lookupForInitialization!.bind(directory);
    directory.lookupForInitialization=async login=>{const found=await lookup(login);entered.release();await resume.promise;return found;};
    return directory;
  });
  return {entered:entered.promise,release:resume.release};
}
function noSetupEffects(r:Awaited<ReturnType<typeof fixture>>) {
  expect(r.fm.getRawFleetConfig().hub).toBeUndefined();
  expect(existsSync(join(r.home,"hub/keys/identity.json"))).toBe(false);
  expect(readdirSync(r.home).filter(name=>name.startsWith(".hub-browser-"))).toEqual([]);
}

describe("initial setup from the actual host launch session",()=>{
  it("marks setup only on the exact local host shell, without constructing the initializer",async()=>{
    const r=await fixture(),create=vi.spyOn(r.fm,"hubSetup");
    const shell=(id:string,extra:Record<string,string>={})=>new Promise<string>((resolve,reject)=>{
      const q=httpRequest({host:"127.0.0.1",port:r.port,path:"/settings/hub",headers:{cookie:`agend_session=${id}`,...extra}},res=>{
        let text="";res.on("data",c=>text+=c);res.on("end",()=>resolve(text));});q.on("error",reject);q.end();
    });
    expect(await shell(r.host.id)).toContain('data-hub-setup="1"');
    const other=await r.signIn(r.fm.issueDashboardLogin()!.display);
    expect(await shell(other.id)).not.toContain('data-hub-setup="1"');
    expect(await shell(r.host.id,{"x-forwarded-for":"198.51.100.1"})).not.toContain('data-hub-setup="1"');
    expect(create).not.toHaveBeenCalled();expect(r.peer.bindRecords).toHaveLength(0);noSetupEffects(r);
  },20_000);

  it("completes setup through the public route, mounts HTTPS and imports setup audit before accepting browser sign-in",async()=>{
    const r=await fixture();expect((await r.call("")).body).toMatchObject({initialized:false,existingFleet:false});
    const prepared=await r.call("/prepare",r.input);expect(prepared.status).toBe(200);expect(prepared.body.ref).toBeTypeOf("string");
    expect(existsSync(join(r.home,"hub/keys/identity.json"))).toBe(false);
    expect((await r.call("/test",{ref:prepared.body.ref})).body).toEqual({ok:true});
    const committed=await r.call("/commit",{ref:prepared.body.ref});expect(committed.status).toBe(200);expect(committed.body.ok).toBe(true);
    const runtime=await r.mount();expect(runtime.currentHolds()).toEqual([]);expect(runtime.serverHealth(r.fm.getRawFleetConfig().hub)).toBe("ready");
    const cert=readFileSync(join(r.home,"hub/web-tls/cert.pem"));
    const page=await new Promise<{status:number;body:string}>((resolve,reject)=>{
      const req=httpsRequest({host:"127.0.0.1",port:r.input.webListen.port,path:"/ui/hub",ca:cert,agent:false},res=>{let body="";res.on("data",c=>{body+=c;});res.on("end",()=>resolve({status:res.statusCode!,body}));});req.on("error",reject);req.end();});
    expect(page.status).toBe(200);expect(page.body).toContain("AgEnD");
    const db=new Database(join(r.home,"hub/hub.sqlite"),{readonly:true});try{
      expect(db.prepare("SELECT * FROM hub_web_initialization_audit").all().length).toBeGreaterThanOrEqual(4);
      expect(db.prepare("SELECT action FROM hub_audit WHERE action='hub-initialization.commit'").all()).toHaveLength(1);
      expect(db.prepare("SELECT * FROM hub_sessions").all()).toHaveLength(0);
    }finally{db.close();}
    expect(r.peer.bindRecords.length).toBeGreaterThan(0);expect(r.peer.bindRecords.every(b=>b.dn===r.input.directory.bindDn&&b.password==="Dummy-service-only")).toBe(true);
    expect((await r.call("/commit",{ref:prepared.body.ref})).status).toBe(410);
  },20_000);
  it("rejects non-host, guest, header, wrong-origin, missing-CSRF, public and forwarded requests before constructing setup",async()=>{
    const r=await fixture(),create=vi.spyOn(r.fm,"hubSetup");const other=await r.signIn(r.fm.issueDashboardLogin()!.display);
    const attempts=[await r.call("/prepare",r.input,{},other.id),await r.call("/prepare",r.input,{origin:"https://outside.example.test"}),
      await r.call("/prepare",r.input,{[WEB_CSRF_HEADER]:"wrong"}),await r.call("/prepare",r.input,{"x-agend-token":r.token}),
      await r.call("/prepare",r.input,{authorization:"Bearer "+r.token}),await r.call("/prepare",r.input,{"x-forwarded-for":"198.51.100.1"}),
      await r.call("/prepare",r.input,{host:"public.example.test"})];
    expect(attempts.every(a=>a.status===403)).toBe(true);expect(create).not.toHaveBeenCalled();expect(r.peer.bindRecords).toHaveLength(0);
    const reqOf=()=>({method:"POST",headers:{host:`127.0.0.1:${r.port}`,...r.headers()},socket:{remoteAddress:"127.0.0.1"}} as any);
    const gateway=reqOf();bindGatewayRequest(gateway,{surface:"gateway",exposureId:"e".repeat(32),expectedOrigin:r.origin,isCurrent:()=>true});
    expect(r.fm.hubSetupSession(gateway)).toBeNull();const lan=reqOf();lan.socket.remoteAddress="198.51.100.2";expect(r.fm.hubSetupSession(lan)).toBeNull();
    const guest=r.internal.webSessions.create({tier:"guest",surface:"local",label:"guest",owner:{adapterId:"test",userId:"guest"},tokenEpoch:tokenEpoch(r.token)});
    expect([401,403]).toContain((await r.call("/prepare",r.input,{},guest.sessionId)).status);
  },20_000);
  it("detects a newly occupied port at Save before identity or config writes",async()=>{
    const r=await fixture(),d=await r.call("/prepare",r.input),occupied=createServer();expect(d.status).toBe(200);
    await new Promise<void>(resolve=>occupied.listen(r.input.webListen.port,"127.0.0.1",resolve));
    try{expect((await r.call("/commit",{ref:d.body.ref})).body).toEqual({error:"network"});
      expect(r.fm.getRawFleetConfig().hub).toBeUndefined();expect(existsSync(join(r.home,"hub/keys/identity.json"))).toBe(false);
    }finally{await new Promise<void>(resolve=>occupied.close(()=>resolve()));}
  },20_000);
  it("a session revoked while the body is held never constructs the setup controller",async()=>{
    const r=await fixture(),create=vi.spyOn(r.fm,"hubSetup"),source=vi.spyOn(r.fm,"hubSetupSession");
    let response!:Promise<Reply>;let req!:ReturnType<typeof httpRequest>;
    response=new Promise((resolve,reject)=>{req=httpRequest({host:"127.0.0.1",port:r.port,method:"POST",path:prefix+"/prepare",headers:r.headers()},res=>{
      let text="";res.on("data",c=>{text+=c;});res.on("end",()=>resolve({status:res.statusCode!,headers:res.headers,body:JSON.parse(text)}));});req.on("error",reject);});
    req.write("{");await vi.waitFor(()=>expect(source).toHaveBeenCalledOnce());r.internal.webSessions.revokeById(r.host.id);req.end('"name":"stale"}');
    expect([401,403]).toContain((await response).status);expect(create).not.toHaveBeenCalled();expect(r.peer.bindRecords).toHaveLength(0);
  },20_000);
  it("inspects CA without credentials, refuses a wrong pin before bind, then returns only the verified public CA",async()=>{
    const r=await fixture(),ca=await directoryCaFixture(certs.leaf,certs.ca,{requireBind:true});
    try{const d=await r.call("/ca/inspect",{url:ca.url});expect(d.status).toBe(200);expect(ca.binds).toHaveLength(0);expect(ca.applicationBytes()).toBe(0);
      const credentials={bindDn:"CN=Reader,DC=example,DC=test",bindPassword:"Dummy-service-only"};
      expect((await r.call("/ca/fetch",{ref:d.body.ref,fingerprint:"AA".repeat(32),...credentials})).status).toBe(503);expect(ca.binds).toHaveLength(0);
      const got=await r.call("/ca/fetch",{ref:d.body.ref,fingerprint:d.body.certificate.fingerprint256,...credentials});
      expect(got.status).toBe(200);expect(new X509Certificate(got.body.caPem).fingerprint256).toBe(new X509Certificate(certs.ca).fingerprint256);
      expect(JSON.stringify(got.body)).not.toContain(credentials.bindPassword);expect(ca.binds.length).toBeGreaterThan(0);
      expect(r.fm.getRawFleetConfig().hub).toBeUndefined();expect(existsSync(join(r.home,"hub/keys/identity.json"))).toBe(false);
    }finally{await ca.close();}
  },20_000);
  it.each(["epoch","session-store","unchanged"] as const)("rechecks the fleet authority identity after held prepare: %s",async change=>{
    const r=await fixture(),gate=holdAdministratorLookup(),oldSessions=r.internal.webSessions;
    const response=r.call("/prepare",r.input);
    try {
      await gate.entered;const epoch=r.fm.webAuthorityState().epoch;
      if(change==="epoch")expect(r.fm.revokeWebAuthority().epoch).toBeGreaterThan(epoch);
      if(change==="session-store")r.internal.webSessions=new WebSessionStore();
      // The original cookie/record itself is still valid: only the captured fleet epoch/store identity changed.
      expect(oldSessions.authenticate(r.host.id,tokenEpoch(r.token),{touch:false})).not.toBeNull();
      gate.release();const result=await response;
      if(change==="unchanged") {expect(result.status).toBe(200);expect(result.body.ref).toBeTypeOf("string");
        expect((await r.call("/cancel",{ref:result.body.ref})).status).toBe(200);}
      else {expect(result.body).toEqual({error:"denied"});expect(result.status).toBe(403);}
      noSetupEffects(r);
    } finally {gate.release();r.internal.webSessions=oldSessions;await response;}
  },20_000);
  it("a disconnected held prepare cannot leave a draft or initialization effect",async()=>{
    const r=await fixture(),gate=holdAdministratorLookup(),control=await r.fm.hubSetup(),prepare=vi.spyOn(control,"prepare"),closed=held();
    const observe=(req:import("node:http").IncomingMessage,res:import("node:http").ServerResponse)=>{
      if(req.url===prefix+"/prepare")res.once("close",closed.release);
    };
    const server=r.internal.healthServer as Server;server.prependListener("request",observe);
    const req=httpRequest({host:"127.0.0.1",port:r.port,method:"POST",path:prefix+"/prepare",headers:r.headers()});
    req.on("error",()=>{});req.end(JSON.stringify(r.input));
    try {
      await gate.entered;expect(prepare).toHaveBeenCalledOnce();
      const settled=(prepare.mock.results[0]!.value as ReturnType<typeof control.prepare>).then(value=>({value,error:null}),error=>({value:null,error}));
      req.destroy();await closed.promise;gate.release();
      const result=await settled;expect(result.error).toMatchObject({code:"denied"});expect(result.value).toBeNull();noSetupEffects(r);
      // The request died, not the D3 session. A later independent request can still use it.
      expect((await r.call("")).body).toMatchObject({initialized:false,incomplete:false});
    } finally {req.destroy();gate.release();server.removeListener("request",observe);}
  },20_000);
  it("keeps the captured host session when another valid cookie replaces the request cookie",async()=>{
    const r=await fixture(),second=await r.signIn();
    const req={method:"POST",headers:{host:`127.0.0.1:${r.port}`,...r.headers()},socket:{remoteAddress:"127.0.0.1"}} as any;
    const proof=r.fm.hubSetupSession(req)!;expect(proof.current()).toBe(true);
    Object.assign(req.headers,r.headers(second.id));
    expect(r.internal.webSessions.authenticate(r.host.id,tokenEpoch(r.token),{touch:false})).not.toBeNull();
    expect(r.internal.webSessions.authenticate(second.id,tokenEpoch(r.token),{touch:false})).not.toBeNull();
    expect(proof.current()).toBe(false);
    Object.assign(req.headers,r.headers());expect(proof.current()).toBe(true);
  },20_000);
  it("a late revoked D3 session and a disabled candidate never enable or mint a Hub session",async()=>{
    const r=await fixture(),prepared=await r.call("/prepare",r.input);expect(prepared.status).toBe(200);
    r.users[0]!.eligible=false;
    expect((await r.call("/commit",{ref:prepared.body.ref})).body).toEqual({error:"directory"});expect(r.fm.getRawFleetConfig().hub).toBeUndefined();
    r.users[0]!.eligible=true;const again=await r.call("/prepare",r.input);expect(again.status).toBe(200);
    r.internal.webSessions.revokeById(r.host.id);
    expect([401,403]).toContain((await r.call("/commit",{ref:again.body.ref})).status);expect(r.fm.getRawFleetConfig().hub).toBeUndefined();
  },20_000);
});
