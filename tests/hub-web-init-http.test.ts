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
    async close(){await (await internal.hubSetupInit)?.close();await (await internal.hubDirectoryInit)?.close();await internal.hubRuntime?.close();await runtime?.close();const s=internal.healthServer as Server;internal.healthServer=null;
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


const directoryPrefix = "/api/settings/hub/directory";
describe("AD settings from the local host session", () => {
  it("acquires D3 authority before the shared control, with no directory sign-in", async () => {
    const r = await fixture(), read = vi.fn((_context: unknown) => ({ directory: { realm: "fictional" }, bindPasswordSet: true, reauthentication: "host" }));
    const create = vi.spyOn(r.fm, "hubDirectorySettings").mockResolvedValue({ read } as any);
    const response = await request(r.port, "GET", directoryPrefix, r.headers());
    expect(response.status).toBe(200); expect(response.body.reauthentication).toBe("host");
    expect(create).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[0]).toMatchObject({ actor: { kind: "host-owner", sessionId: expect.any(String), requestId: expect.any(String) } });
    expect(r.peer.bindRecords).toHaveLength(0);
  }, 20_000);
});


describe("host AD HTTP boundaries", () => {
  it("refuses other admin, guest, header, cross-site, CSRF, forwarded and public requests before acquiring the controller", async () => {
    const r = await fixture(), create = vi.spyOn(r.fm, "hubDirectorySettings");
    const other = await r.signIn(r.fm.issueDashboardLogin()!.display);
    const guest = r.internal.webSessions.create({tier:"guest", surface:"local", label:"guest", owner:{adapterId:"test",userId:"guest"}, tokenEpoch:tokenEpoch(r.token)});
    const call = (extra:Record<string,string> = {}, id=r.host.id, path=directoryPrefix+"/prepare", method="POST", body="{}") => request(r.port, method, path, {...r.headers(id), ...extra}, body);
    const responses = [await call({},other.id), await call({},guest.sessionId), await call({"x-agend-token":r.token}),
      await call({authorization:"Bearer "+r.token}), await call({origin:"https://outside.example.test"}), await call({[WEB_CSRF_HEADER]:"wrong"}),
      await call({"x-forwarded-for":"198.51.100.1"}), await call({host:"public.example.test"})];
    expect(responses).toHaveLength(8); expect(responses.every(x=>[401,403].includes(x.status))).toBe(true);
    expect((await call({},r.host.id,directoryPrefix+"/prepare?override=host")).status).toBe(400);
    expect((await call({},r.host.id,directoryPrefix+"/save","GET","")).status).toBe(405);
    expect((await call({"content-type":"text/plain"})).status).toBe(400);
    expect((await call({},r.host.id,directoryPrefix+"/prepare","POST",'{"ref":1,"ref":2}')).status).toBe(400);
    expect(create).not.toHaveBeenCalled(); expect(r.peer.bindRecords).toHaveLength(0);
  },20_000);

  it.each(["prepare","test","cancel","save"] as const)("routes %s through the same host actor without browser rotation",async action=>{
    const r=await fixture(),result=action==="save"?{state:"restored",receiptId:"fixture",directoryEpoch:2}:{ok:true};
    const effect=vi.fn((_input:unknown,_context:unknown)=>result);
    vi.spyOn(r.fm,"hubDirectorySettings").mockResolvedValue({[action==="save"?"apply":action]:effect} as any);
    const response=await request(r.port,"POST",directoryPrefix+"/"+action,r.headers(),JSON.stringify({ref:"fixture"}));
    expect(response.status).toBe(action==="save"?503:200);expect(response.body).toEqual(result);
    expect(effect).toHaveBeenCalledExactlyOnceWith({ref:"fixture"},expect.objectContaining({actor:expect.objectContaining({kind:"host-owner"}),current:expect.any(Function),signal:expect.any(AbortSignal)}));
    expect(r.peer.bindRecords).toHaveLength(0);
  },20_000);

  it.each(["current","revoked"])("a settled Save result under %s D3 authority never promises an uncommitted outcome",async state=>{
    const r=await fixture(),entered=held(),resume=held();let current=true,committed=false;
    const actual=r.fm.hubSetupSession.bind(r.fm);
    vi.spyOn(r.fm,"hubSetupSession").mockImplementation(req=>{const owner=actual(req);return owner&&{...owner,current:()=>current&&owner.current()};});
    const result={state:"ready",receiptId:"settled-fixture",directoryEpoch:1};
    const apply=vi.fn(async()=>{committed=true;entered.release();await resume.promise;return result;});
    vi.spyOn(r.fm,"hubDirectorySettings").mockResolvedValue({apply} as any);
    const response=request(r.port,"POST",directoryPrefix+"/save",r.headers(),JSON.stringify({ref:"fixture"}));
    try{
      await entered.promise;expect(committed).toBe(true);current=state==="current";resume.release();
      const saved=await response;expect(apply).toHaveBeenCalledOnce();
      expect(saved.status).toBe(state==="current"?200:403);
      expect(saved.body).toEqual(state==="current"?result:{ok:false,code:"revoked"});
      expect(saved.body.committed).not.toBe(false); // A revoked response says nothing about the durable Save outcome.
    }finally{resume.release();await response;}
  },20_000);

  it("a revoked authority during a held body cannot acquire the control",async()=>{
    const r=await fixture(),create=vi.spyOn(r.fm,"hubDirectorySettings"),source=vi.spyOn(r.fm,"hubSetupSession");
    let client!:ReturnType<typeof httpRequest>;
    const response=new Promise<Reply>((resolve,reject)=>{
      client=httpRequest({host:"127.0.0.1",port:r.port,method:"POST",path:directoryPrefix+"/prepare",headers:r.headers()},res=>{let text="";res.on("data",c=>text+=c);res.on("end",()=>resolve({status:res.statusCode!,headers:res.headers,body:JSON.parse(text)}));});client.on("error",reject);
    });
    client.write("{");await vi.waitFor(()=>expect(source).toHaveBeenCalledOnce());
    const state=r.fm.webAuthorityState();vi.spyOn(r.fm,"webAuthorityState").mockReturnValue({...state,epoch:state.epoch+1});
    client.end('"ref":"dummy"}');expect((await response).status).toBe(403);
    expect(create).not.toHaveBeenCalled();expect(r.peer.bindRecords).toHaveLength(0);
  },20_000);

  it.each(["epoch","session","disconnect"])("a held factory cannot continue after %s invalidation", async mode => {
    const r=await fixture(), entered=held(), resume=held(), closed=held(), settled=held(); let released=false;
    const read=vi.fn(),create=vi.spyOn(r.fm,"hubDirectorySettings").mockImplementation(async()=>{entered.release();await resume.promise;return {read} as any;});
    const server=r.internal.healthServer as Server;
    const observe=(req:import("node:http").IncomingMessage,res:import("node:http").ServerResponse)=>{
      if(req.url!==directoryPrefix)return;
      res.once("close",closed.release);
      const remove=res.removeListener.bind(res);
      vi.spyOn(res,"removeListener").mockImplementation((event,listener)=>{const out=remove(event,listener);if(event==="close"&&released)settled.release();return out;});
    };
    server.prependListener("request",observe);
    let client:ReturnType<typeof httpRequest>;
    const response=new Promise<Reply|null>((resolve,reject)=>{
      client=httpRequest({host:"127.0.0.1",port:r.port,path:directoryPrefix,headers:r.headers()},res=>{let text="";res.on("data",c=>text+=c);res.on("aborted",()=>resolve(null));res.on("end",()=>resolve({status:res.statusCode!,headers:res.headers,body:JSON.parse(text)}));});
      client.on("error",()=>resolve(null));client.end();
    });
    try{
      await entered.promise; expect(create).toHaveBeenCalledOnce();
      if(mode==="disconnect"){client!.destroy();await closed.promise;}
      else if(mode==="session")r.internal.webSessions.revokeById(r.host.id);
      else {const original=r.fm.webAuthorityState.bind(r.fm),state=original();vi.spyOn(r.fm,"webAuthorityState").mockReturnValue({...state,epoch:state.epoch+1});}
      released=true;resume.release();await settled.promise;
      expect(read).not.toHaveBeenCalled();const result=await response;expect(result?.status??null).toBe(mode==="disconnect"?null:403);
    }finally{resume.release();server.removeListener("request",observe);client!.destroy();await response;}
  },20_000);

  it("reports only a bounded error and preserves busy Retry-After",async()=>{
    const r=await fixture(),create=vi.spyOn(r.fm,"hubDirectorySettings").mockRejectedValue(Error("Dummy-private-directory-detail"));
    const unavailable=await request(r.port,"GET",directoryPrefix,r.headers());
    expect(unavailable.status).toBe(503);expect(unavailable.body).toEqual({ok:false,code:"unavailable"});
    const {HubProtocolError}=await import("../src/hub/validation.js");create.mockRejectedValue(new HubProtocolError("backpressure"));
    const busy=await request(r.port,"GET",directoryPrefix,r.headers());expect(busy.status).toBe(429);expect(busy.headers["retry-after"]).toBe("10");
    expect(JSON.stringify([unavailable,busy])).not.toContain("Dummy-private-directory-detail");
  },20_000);

  it.each(["running","off"])("replaces an unreachable AD through D3 and the real shared writer while %s, without AD sign-in",async mode=>{
    const r=await fixture(),replacement=await groupWirePeer(certs.leaf,r.users);
    try{
      const draft=await r.call("/prepare",r.input);expect(draft.status).toBe(200);
      expect((await r.call("/commit",{ref:draft.body.ref})).status).toBe(200);
      r.internal.hubEffectsReady=true;await r.internal.applyHubSwitches();
      const runtime=r.internal.hubRuntime as HubRuntime;expect(runtime.serverHealth(r.fm.getRawFleetConfig().hub)).toBe("ready");
      if(mode==="off") { r.fm.saveFleetConfig([{path:["hub","enabled"],value:false}]); await r.internal.applyHubSwitches(); }
      expect(runtime.serverHealth(r.fm.getRawFleetConfig().hub)).toBe(mode==="off"?"off":"ready");
      const identity=readFileSync(join(r.home,"hub/keys/identity.json")),certificate=readFileSync(join(r.home,"hub/web-tls/cert.pem"));
      await r.peer.close(); // Actual owned old LDAPS listener is unreachable throughout read/prepare/test/Save.
      const call=(action:string,value?:unknown)=>request(r.port,action?"POST":"GET",directoryPrefix+action,r.headers(),value===undefined?undefined:JSON.stringify(value));
      const view=await call("");expect(view.status).toBe(200);expect(view.body.reauthentication).toBe("host");
      const source=runtime.directorySettings()!.source(),signin=vi.spyOn(source.directory,"signIn"),eligibility=vi.spyOn(source.directory,"checkEligibility");
      expect(view.body.directory.bindPasswordRef).toBeUndefined();expect(JSON.stringify(view.body)).not.toContain(r.input.bindPassword);
      const {realm:_realm,profile:_profile,...editable}=view.body.directory;
      const prepared=await call("/prepare",{directory:{...editable,url:`ldaps://127.0.0.1:${replacement.port}`},bindPassword:"Dummy-service-only"});
      expect(prepared.status).toBe(200);expect(prepared.body.trust).toMatchObject({leafFingerprint:new X509Certificate(certs.leaf.cert).fingerprint256.replace(/:/g,"")});
      expect((await call("/test",{ref:prepared.body.ref})).body.code).toBe("trust");
      const confirmed={ref:prepared.body.ref,confirmation:prepared.body.trust.challenge};
      r.users[0]!.eligible=false;
      expect((await call("/test",confirmed)).status).toBe(403);
      expect((r.fm.getRawFleetConfig().hub as {directory:{url:string}}).directory.url).toBe(r.input.directory.url);
      expect(runtime.directoryDecision()!.inspect().directoryEpoch).toBe(0);
      r.users[0]!.eligible=true;
      expect((await call("/test",confirmed)).status).toBe(200);
      const saved=await call("/save",confirmed);expect(saved.status).toBe(200);expect(saved.body.state).toBe("ready");
      expect((saved.headers["set-cookie"]??[]).some(c=>c.startsWith("agend_hub_"))).toBe(false);expect(signin).not.toHaveBeenCalled();expect(eligibility).not.toHaveBeenCalled();
      expect(runtime.serverHealth(r.fm.getRawFleetConfig().hub)).toBe(mode==="off"?"off":"ready");
      expect((r.fm.getRawFleetConfig().hub as {directory:{url:string}}).directory.url).toBe(`ldaps://127.0.0.1:${replacement.port}`);
      expect(readFileSync(join(r.home,"hub/keys/identity.json"))).toEqual(identity);expect(readFileSync(join(r.home,"hub/web-tls/cert.pem"))).toEqual(certificate);
      const db=new Database(join(r.home,"hub/hub.sqlite"),{readonly:true});try{
        expect(db.prepare("SELECT * FROM hub_sessions").all()).toHaveLength(0);
        const operation=JSON.parse((db.prepare("SELECT body FROM hub_settings_operations WHERE id=?").get(saved.body.receiptId) as {body:string}).body);
        expect(operation.actor.kind).toBe("host-owner");expect(operation.changes).toEqual(["server","secret"]);
        expect(db.prepare("SELECT * FROM hub_settings_security_targets").all()).toHaveLength(2);
        expect(JSON.parse((db.prepare("SELECT body FROM hub_group_policy WHERE singleton=1").get() as {body:string}).body).state).toBe("never-enabled");
      }finally{db.close();}
      expect(replacement.bindRecords.length).toBeGreaterThan(0);
      expect(replacement.bindRecords.every(b=>b.dn===r.input.directory.bindDn&&b.password==="Dummy-service-only")).toBe(true);
    }finally{await replacement.close();}
  },30_000);
});
