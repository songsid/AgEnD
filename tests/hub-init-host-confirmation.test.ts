/** Initializer authority only: private scratch files and fake S1; no browser route or directory authority mocked in. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import type { HubIdentityProvider, HubInitHostOwner, HubInitPlan } from "../src/hub/init/types.js";
import { FakeIdentity, ADMIN, makeTestCerts, tempDir, type TestCerts } from "./support/hub-init-fixtures.js";
import { applyFleetYamlPatches } from "../src/fleet-yaml-patch.js";

let certs:TestCerts;
beforeAll(()=>{certs=makeTestCerts();});
function held<T>(){let release!:(value:T)=>void;const wait=new Promise<T>(r=>{release=r;});return {wait,release};}
function plan():HubInitPlan{return {name:"Fictional Hub",webOrigin:"https://hub.example.test:8443",memberOrigin:"https://hub.example.test:9443",
  directory:{realm:"corp",url:"ldaps://directory.example.test",baseDn:"DC=example,DC=test",bindDn:"CN=Reader",profile:"ad"},
  bindPasswordRef:"file:hub/secrets/directory-bind",administrator:{...ADMIN.key},retention:{contentDays:30,eventDays:90},
  coexistence:"dedicated",webListen:{host:"127.0.0.1",port:8443},memberListen:{host:"127.0.0.1",port:9443},webTls:{certFile:certs.cert,keyFile:certs.key}};}
function fixture(){
  const home=tempDir("hub-init-owner-"),identity=new FakeIdentity();let now=Date.now(),live=true;
  const owner:HubInitHostOwner={kind:"host-session",ownerKey:{},sessionId:"host-session",authorityEpoch:7,requestId:"prepare-request",current:()=>live};
  return {home,identity,owner,now:()=>now,tick:(n:number)=>{now+=n;},revoke:()=>{live=false;},resume:()=>{live=true;},
    config:()=>existsSync(join(home,"fleet.yaml"))?yaml.load(readFileSync(join(home,"fleet.yaml"),"utf8")) as {hub:{enabled:boolean}}:null,
    receipt:()=>JSON.parse(readFileSync(join(home,"hub/init/operation.json"),"utf8"))};
}
const secret={bindPassword:"dummy-service-secret"};

describe("explicit browser source and owner binding",()=>{
  it.each(["terminal","owner-key","session","epoch"])("never substitutes %s for the host-session that prepared the exact plan",async mismatch=>{
    const r=fixture(),init=createHubInitializer({home:r.home,identity:r.identity,probe:{pidAlive:()=>false}}),p=plan();
    const c=await init.prepareConfirmation(p,secret,r.owner),other={...r.owner};
    if(mismatch==="owner-key")other.ownerKey={};
    if(mismatch==="session")other.sessionId="another-session";
    if(mismatch==="epoch")other.authorityEpoch++;
    await expect(init.commit(p,c.reference,mismatch==="terminal"?undefined:other)).rejects.toThrow(/another source or host session/);
    expect(existsSync(join(r.home,"hub"))).toBe(false);
    await expect(init.commit(p,c.reference,r.owner)).rejects.toThrow(/already used/);
  });
  it("never presents a terminal reference as browser confirmation",async()=>{
    const r=fixture(),init=createHubInitializer({home:r.home,identity:r.identity,probe:{pidAlive:()=>false}}),p=plan();
    const c=await init.prepareConfirmation(p,secret);
    await expect(init.commit(p,c.reference,r.owner)).rejects.toThrow(/another source/);
    expect(r.config()).toBeNull();
  });
  it("allows a new request from the same owner and binds durable provenance without persisting cookie/owner records or the service secret",async()=>{
    const r=fixture(),init=createHubInitializer({home:r.home,identity:r.identity,probe:{pidAlive:()=>false}}),p=plan();
    Object.assign(r.owner.ownerKey,{cookie:"never-store-this-cookie"});
    const c=await init.prepareConfirmation(p,secret,r.owner);
    await init.commit(p,c.reference,{...r.owner,requestId:"commit-request"});
    expect(r.config()?.hub.enabled).toBe(true);
    const receipt=r.receipt(),proof=receipt.confirmations[0];
    expect(proof.source).toEqual({kind:"host-session",sessionId:r.owner.sessionId,authorityEpoch:7,requestId:"commit-request"});
    const {confirmationId,...signed}=proof;
    const canonical=(v:any):string=>v&&typeof v==="object"?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")}}`:JSON.stringify(v);
    expect(confirmationId).toBe(createHash("sha256").update(canonical(signed)).digest("hex").slice(0,32));
    expect(JSON.parse(readFileSync(join(r.home,"hub/init-manifest.json"),"utf8")).confirmationId).toBe(confirmationId);
    const body=JSON.stringify(receipt);
    for(const value of [secret.bindPassword,c.reference,"never-store-this-cookie"])expect(body).not.toContain(value);
  });
  it.each(["revoked","thenable","backward","expired"])("refuses a %s host proof before any initialization effect",async kind=>{
    const r=fixture(),init=createHubInitializer({home:r.home,identity:r.identity,probe:{pidAlive:()=>false},now:r.now}),p=plan();
    const c=await init.prepareConfirmation(p,secret,r.owner);
    const owner={...r.owner,current:()=>{
      if(kind==="revoked")return false;
      if(kind==="thenable")return Promise.resolve(true) as unknown as boolean;
      r.tick(kind==="backward"?-1:10*60_000);return true;
    }};
    await expect(init.commit(p,c.reference,owner)).rejects.toThrow();
    expect(r.config()).toBeNull();expect(existsSync(join(r.home,"hub"))).toBe(false);
  });
});

describe("browser continuation and physical initialization ownership",()=>{
  it("a held identity creation records only ownership after revocation, remains off, and resumes through the normal CLI fallback",async()=>{
    const r=fixture(),gate=held<void>(),started=held<void>();
    const identity:HubIdentityProvider={available:true,read:r.identity.read.bind(r.identity),seal:r.identity.seal.bind(r.identity),
      async provision(input){started.release();await gate.wait;return r.identity.provision(input);}};
    const init=createHubInitializer({home:r.home,identity,probe:{pidAlive:()=>false}}),p=plan();
    const c=await init.prepareConfirmation(p,secret,r.owner),pending=init.commit(p,c.reference,r.owner);
    await started.wait;r.revoke();gate.release();await expect(pending).rejects.toThrow(/no longer current/);
    expect(r.receipt().done).toEqual(["started","identity"]);expect(r.config()).toBeNull();
    expect(existsSync(join(r.home,"hub/secrets/directory-bind"))).toBe(false);
    const fresh=await init.prepareConfirmation(p,secret);await init.commit(p,fresh.reference);
    expect(r.config()?.hub.enabled).toBe(true);
  });
  it("a held seal cannot publish a manifest or enabled switch after session revocation",async()=>{
    const r=fixture(),gate=held<void>(),started=held<void>();
    const identity:HubIdentityProvider={available:true,read:r.identity.read.bind(r.identity),provision:r.identity.provision.bind(r.identity),
      async seal(input){started.release();await gate.wait;return r.identity.seal(input);}};
    const init=createHubInitializer({home:r.home,identity,probe:{pidAlive:()=>false}}),p=plan();
    const c=await init.prepareConfirmation(p,secret,r.owner),pending=init.commit(p,c.reference,r.owner);
    await started.wait;r.revoke();gate.release();await expect(pending).rejects.toThrow(/no longer current/);
    expect(r.config()?.hub.enabled).toBe(false);expect(existsSync(join(r.home,"hub/init-manifest.json"))).toBe(false);
  });
  it("serializes two live commits before S1 key creation",async()=>{
    const r=fixture(),gate=held<void>(),started=held<void>();
    const identity:HubIdentityProvider={available:true,read:r.identity.read.bind(r.identity),seal:r.identity.seal.bind(r.identity),
      async provision(input){started.release();await gate.wait;return r.identity.provision(input);}};
    const init=createHubInitializer({home:r.home,identity,probe:{pidAlive:()=>false}}),p=plan();
    const a=await init.prepareConfirmation(p,secret,r.owner),b=await init.prepareConfirmation(p,secret,r.owner);
    const pending=init.commit(p,a.reference,r.owner);await started.wait;
    await expect(init.commit(p,b.reference,r.owner)).rejects.toThrow(/still running/);
    gate.release();await pending;expect(r.config()?.hub.enabled).toBe(true);
  });
  it("uses the same caller-supplied synchronous config writer for every Hub patch and enables last",async()=>{
    const r=fixture(),writes:any[]=[],writeFleet=vi.fn((patches:any[])=>{writes.push(structuredClone(patches));applyFleetYamlPatches(join(r.home,"fleet.yaml"),patches);});
    writeFileSync(join(r.home,"fleet.yaml"),"# existing Settings config\ninstances: {}\n",{mode:0o600});
    const init=createHubInitializer({home:r.home,identity:r.identity,probe:{pidAlive:()=>false},writeFleet}),p=plan();
    const c=await init.prepareConfirmation(p,secret,r.owner);await init.commit(p,c.reference,r.owner);
    expect(writes.at(-1)).toEqual([{path:["hub","enabled"],value:true}]);
    expect(writes.flat().filter(p=>p.path.join(".")==="hub.enabled"&&p.value===true)).toHaveLength(1);
    expect(r.config()?.hub.enabled).toBe(true);
  });
});


describe("persistent server cleanup and required pre-enable audit",()=>{
  it.each(["discard","close"])("%s narrows a pending browser draft without leaving a usable confirmation",async cleanup=>{
    const r=fixture(),init=createHubInitializer({home:r.home,identity:r.identity,probe:{pidAlive:()=>false}}),p=plan();
    const c=await init.prepareConfirmation(p,secret,r.owner);
    if(cleanup==="discard")init.discardConfirmation!(c.reference);else init.close!();
    await expect(init.commit(p,c.reference,r.owner)).rejects.toThrow();
    expect(r.config()).toBeNull();
  });
  it.each(["throw","thenable","revoke"])("a required audit %s never enables the Hub",async mode=>{
    const r=fixture(),audit=vi.fn(()=>{if(mode==="throw")throw Error("audit unavailable");if(mode==="revoke")r.revoke();if(mode==="thenable")return Promise.resolve() as unknown as void;});
    const init=createHubInitializer({home:r.home,identity:r.identity,probe:{pidAlive:()=>false},beforeEnable:audit}),p=plan();
    const c=await init.prepareConfirmation(p,secret,r.owner);
    await expect(init.commit(p,c.reference,r.owner)).rejects.toThrow();
    expect(audit).toHaveBeenCalledOnce();expect(r.config()?.hub.enabled).toBe(false);
    expect(r.receipt().done).not.toContain("enabled");
  });
});
