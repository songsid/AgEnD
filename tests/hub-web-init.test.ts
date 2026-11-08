/** Real initializer/config/seal; controlled directory observations, owned scratch files only. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { createHubWebInitializer, type HubWebInitDeps } from "../src/hub/init/web.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { hubIdentityProvider } from "../src/hub/init/identity.js";
import { verifyHubInitialization } from "../src/hub/initialization.js";
import { applyFleetYamlPatches } from "../src/fleet-yaml-patch.js";
import type { HubInitHostOwner } from "../src/hub/init/types.js";
import type { HubDirectory } from "../src/hub/directory/index.js";
import { ADMIN, FakeIdentity, makeTestCerts, tempDir, type TestCerts } from "./support/hub-init-fixtures.js";
import { readHubWebInitEvents } from "../src/hub/init/web-audit.js";

let certs:TestCerts;
const homes:string[]=[];
beforeAll(()=>{certs=makeTestCerts();});
afterAll(()=>rmSync(certs.dir,{recursive:true,force:true}));
afterEach(()=>{for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});vi.restoreAllMocks();});
function held<T>(){let release!:(v:T)=>void;const promise=new Promise<T>(r=>{release=r;});return {promise,release};}
function fixture(options:Partial<HubWebInitDeps>={}){
  const home=tempDir("web-init-" );homes.push(home);writeFileSync(join(home,"fleet.yaml"),"# Keep this comment\ninstances: {}\n",{mode:0o600});
  let clock=Date.now(),live=true,eligible=true;
  const owner:HubInitHostOwner={kind:"host-session",ownerKey:{},sessionId:"host-session",authorityEpoch:9,requestId:"host-request",current:()=>live};
  const input={name:"Fictional Hub",webOrigin:"https://hub.example.test:18443",memberOrigin:"https://hub.example.test:19443",
    webListen:{host:"127.0.0.1",port:18443},memberListen:{host:"127.0.0.1",port:19443},
    directory:{realm:"corp",url:"ldaps://directory.example.test",baseDn:"DC=example,DC=test",bindDn:"CN=Reader",profile:"ad" as const},
    bindPassword:"Dummy-service-only",administratorLogin:"alice",retention:{contentDays:30,eventDays:90},coexistence:"dedicated"};
  const lookup=vi.fn(async()=>({ok:true as const,person:ADMIN})),close=vi.fn(async()=>{});
  const directory:HubDirectory={realm:"corp",lookupForInitialization:lookup,signIn:vi.fn(async()=>({ok:false,reason:"invalid-credentials"} as const)),
    checkEligibility:vi.fn(async()=>eligible?{eligible:true,person:ADMIN} as const:{eligible:false,reason:"disabled"} as const),close};
  const readConfig=()=>yaml.load(readFileSync(join(home,"fleet.yaml"),"utf8")) as any;
  const material={certFile:certs.cert,keyFile:certs.key,cleanup:vi.fn()};
  const deps:HubWebInitDeps={home,readConfig,writeFleet:patches=>applyFleetYamlPatches(join(home,"fleet.yaml"),patches),
    identity:new FakeIdentity(),probe:{pidAlive:()=>false},now:()=>clock,createDirectory:()=>directory,
    checkNetwork:async()=>[],browserCertificate:async()=>material,...options};
  // Caller may replace individual dependencies without changing this fixture's scratch root.
  deps.home=home;deps.readConfig=readConfig;
  const controller=createHubWebInitializer(deps);
  return {home,owner,input,controller,directory,lookup,close,material,readConfig,
    revoke:()=>{live=false;},disable:()=>{eligible=false;},tick:(n:number)=>{clock+=n;}};
}

describe("server-owned initial setup",()=>{
  it("writes the actual S1 keys and signed CLI-compatible seal, enables last and keeps the group policy off",async()=>{
    const r=fixture({identity:hubIdentityProvider()});
    try{
      const draft=await r.controller.prepare(r.input,r.owner);
      expect(draft.ref).toMatch(/^[A-Za-z0-9_-]{32}$/);expect(draft.administrator).toBe(ADMIN.displayName);
      expect(JSON.stringify(draft)).not.toContain(r.input.bindPassword);expect(JSON.stringify(draft)).not.toContain(certs.key);
      expect(r.readConfig().hub).toBeUndefined();expect(existsSync(join(r.home,"hub/keys/identity.json"))).toBe(false);
      await expect(r.controller.test(draft.ref,{...r.owner,requestId:"test-request"})).resolves.toEqual({ok:true});
      const result=await r.controller.commit(draft.ref,{...r.owner,requestId:"commit-request"});
      expect(result.ok).toBe(true);const hub=r.readConfig().hub;
      expect(hub.enabled).toBe(true);expect(hub.administrator).toEqual(ADMIN.key);expect(hub.groupPolicy).toBeUndefined();
      expect(hub.directory.bindPasswordRef).toBe("file:hub/secrets/directory-bind");
      expect(readFileSync(join(r.home,"hub/secrets/directory-bind"),"utf8")).toBe(r.input.bindPassword);
      expect(statSync(join(r.home,"hub/secrets/directory-bind")).mode&0o777).toBe(0o600);
      expect(readFileSync(join(r.home,"fleet.yaml"),"utf8")).toContain("# Keep this comment");
      expect(()=>verifyHubInitialization({home:r.home,hubId:hub.hubId,memberOrigin:hub.memberOrigin,planDigest:hubPlanDigest(hub)})).not.toThrow();
      const events=readHubWebInitEvents(r.home);expect(events.filter(e=>e.operation==="commit"&&e.reason==="authorized")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(r.input.bindPassword);
      await expect(r.controller.commit(draft.ref,r.owner)).rejects.toMatchObject({code:"expired"});
      expect(r.directory.signIn).not.toHaveBeenCalled();expect(r.close).toHaveBeenCalledTimes(3);
    }finally{await r.controller.close();}
  });
  it("normalizes an optional trailing slash before binding certificate staging and the saved origins",async()=>{
    const r=fixture();try{const d=await r.controller.prepare({...r.input,webOrigin:r.input.webOrigin+"/",memberOrigin:r.input.memberOrigin+"/"},r.owner);
      expect(d.webOrigin).toBe(r.input.webOrigin);expect(d.memberOrigin).toBe(r.input.memberOrigin);
      await r.controller.commit(d.ref,r.owner);expect(r.readConfig().hub.webOrigin).toBe(r.input.webOrigin);
    }finally{await r.controller.close();}
  });
  it("supports an absent name and write-only uploaded browser PEMs through the same seal",async()=>{
    const r=fixture({identity:hubIdentityProvider()});try{
      const {name:_,...input}=r.input;
      const keyPem=readFileSync(certs.key,"utf8"),certPem=readFileSync(certs.cert,"utf8");
      const d=await r.controller.prepare({...input,browserTls:{certPem,keyPem}},r.owner);
      expect(JSON.stringify(d)).not.toContain(keyPem);await r.controller.commit(d.ref,r.owner);
      const hub=r.readConfig().hub;expect(Object.hasOwn(hub,"name")).toBe(false);
      expect(readFileSync(join(r.home,"hub/web-tls/cert.pem"),"utf8")).toBe(certPem);
      expect(()=>verifyHubInitialization({home:r.home,hubId:hub.hubId,memberOrigin:hub.memberOrigin,planDigest:hubPlanDigest(hub)})).not.toThrow();
      expect(r.material.cleanup).not.toHaveBeenCalled();
    }finally{await r.controller.close();}
  });
  it("refuses a mismatched uploaded key and audits both test and commit directory refusals",async()=>{
    const r=fixture();try{
      await expect(r.controller.prepare({...r.input,browserTls:{certPem:readFileSync(certs.cert,"utf8"),keyPem:readFileSync(certs.otherKey,"utf8")}},r.owner)).rejects.toMatchObject({code:"invalid"});
      const d=await r.controller.prepare(r.input,r.owner);r.disable();
      await expect(r.controller.test(d.ref,r.owner)).rejects.toMatchObject({code:"directory"});
      await expect(r.controller.commit(d.ref,r.owner)).rejects.toMatchObject({code:"directory"});
      const events=readHubWebInitEvents(r.home);expect(events.filter(e=>e.result==="denied").map(e=>e.operation)).toEqual(["prepare","test","commit"]);
    }finally{await r.controller.close();}
  });
  it.each(["owner","session","epoch","revoked","config","expired","backwards"])("refuses a %s continuation before enabling",async kind=>{
    const r=fixture();try{const d=await r.controller.prepare(r.input,r.owner),owner={...r.owner};
      if(kind==="owner")owner.ownerKey={};if(kind==="session")owner.sessionId="other";if(kind==="epoch")owner.authorityEpoch++;
      if(kind==="revoked")r.revoke();if(kind==="config")writeFileSync(join(r.home,"fleet.yaml"),"instances: {}\nchanged: true\n",{mode:0o600});
      if(kind==="expired")r.tick(300000);if(kind==="backwards")r.tick(-1);
      await expect(r.controller.commit(d.ref,owner)).rejects.toBeDefined();expect(r.readConfig().hub?.enabled).not.toBe(true);expect(existsSync(join(r.home,"hub/keys/identity.json"))).toBe(false);
    }finally{await r.controller.close();}
  });
  it("rechecks immutable administrator eligibility at Save and does not leave a reusable draft",async()=>{
    const r=fixture();try{const d=await r.controller.prepare(r.input,r.owner);r.disable();
      await expect(r.controller.commit(d.ref,r.owner)).rejects.toMatchObject({code:"directory"});
      await expect(r.controller.commit(d.ref,r.owner)).rejects.toMatchObject({code:"expired"});expect(r.readConfig().hub).toBeUndefined();
    }finally{await r.controller.close();}
  });
  it.each(["administrator","path","reference"])("never accepts a browser-supplied %s",async field=>{
    const r=fixture();try{const payload:any=structuredClone(r.input);if(field==="administrator")payload.administrator=ADMIN.key;
      if(field==="path")payload.webTls={certFile:certs.cert,keyFile:certs.key};if(field==="reference")payload.directory.bindPasswordRef="file:foreign";
      await expect(r.controller.prepare(payload,r.owner)).rejects.toMatchObject({code:"invalid"});expect(r.lookup).not.toHaveBeenCalled();
    }finally{await r.controller.close();}
  });
  it("fences read/test operations from another owner record before any new directory read",async()=>{
    const r=fixture();try{const d=await r.controller.prepare(r.input,r.owner);const before=r.lookup.mock.calls.length;
      await expect(r.controller.test(d.ref,{...r.owner,ownerKey:{}})).rejects.toMatchObject({code:"denied"});
      expect(r.lookup).toHaveBeenCalledTimes(before);
      await expect(r.controller.test(d.ref,r.owner)).resolves.toEqual({ok:true});
    }finally{await r.controller.close();}
  });
  it("does not replace the designated immutable administrator when the login is recreated before Save",async()=>{
    let person=ADMIN;const r=fixture({createDirectory:()=>({realm:"corp",lookupForInitialization:async()=>({ok:true,person}),
      signIn:async()=>({ok:false,reason:"unavailable"}),checkEligibility:async()=>({eligible:true,person}),close:async()=>{}})});
    try{const d=await r.controller.prepare(r.input,r.owner);person={...ADMIN,key:{...ADMIN.key,objectId:"22222222-2222-4222-8222-222222222222"}};
      await expect(r.controller.commit(d.ref,r.owner)).rejects.toMatchObject({code:"directory"});expect(r.readConfig().hub).toBeUndefined();
    }finally{await r.controller.close();}
  });
  it("requires exact imported CA fingerprints before service credentials reach a directory",async()=>{
    const r=fixture(),caPem=readFileSync(certs.caCert,"utf8");try{
      await expect(r.controller.prepare({...r.input,directory:{...r.input.directory,caPem}},r.owner)).rejects.toMatchObject({code:"trust"});
      expect(r.lookup).not.toHaveBeenCalled();const fingerprint=new X509Certificate(caPem).fingerprint256;
      const d=await r.controller.prepare({...r.input,directory:{...r.input.directory,caPem},confirmedCa:[fingerprint]},r.owner);
      expect(d.administrator).toBe(ADMIN.displayName);
    }finally{await r.controller.close();}
  });
  it("holds physical operation capacity until a refused directory lookup AND close have settled",async()=>{
    const gate=held<void>(),closing=held<void>(),started=held<void>();let calls=0;
    const r=fixture({createDirectory:()=>({realm:"corp",signIn:async()=>({ok:false,reason:"unavailable"}),
      lookupForInitialization:async()=>{calls++;started.release();await gate.promise;return {ok:true,person:ADMIN};},
      checkEligibility:async()=>({eligible:true,person:ADMIN}),close:async()=>{await closing.promise;}})});
    try{
      const a=r.controller.prepare(r.input,r.owner),b=r.controller.prepare(r.input,r.owner);await started.promise;
      r.revoke();await expect(r.controller.prepare(r.input,{...r.owner,current:()=>true})).rejects.toMatchObject({code:"busy"});
      gate.release();await new Promise(resolve=>setImmediate(resolve));
      await expect(r.controller.prepare(r.input,{...r.owner,current:()=>true})).rejects.toMatchObject({code:"busy"});expect(calls).toBe(2);
      closing.release();await Promise.allSettled([a,b]);
      await expect(r.controller.inspect({...r.owner,current:()=>true})).resolves.toMatchObject({initialized:false});
    }finally{gate.release();closing.release();await r.controller.close();}
  });
  it("cancellation narrows a draft, and close waits for already-started work",async()=>{
    const gate=held<void>(),started=held<void>(),r=fixture({browserCertificate:async()=>{started.release();await gate.promise;return {certFile:certs.cert,keyFile:certs.key,cleanup:vi.fn()};}});
    const pending=r.controller.prepare(r.input,r.owner);await started.promise;
    let closed=false;const stopping=r.controller.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));expect(closed).toBe(false);
    gate.release();await expect(pending).rejects.toMatchObject({code:"denied"});await stopping;expect(r.readConfig().hub).toBeUndefined();
  });
  it("fails closed when the required pre-enable audit fails",async()=>{
    const r=fixture({audit:event=>{if(event.operation==="commit")throw Error("required audit unavailable");}});
    try{const d=await r.controller.prepare(r.input,r.owner);await expect(r.controller.commit(d.ref,r.owner)).rejects.toMatchObject({code:"unavailable"});
      expect(r.readConfig().hub.enabled).toBe(false);
    }finally{await r.controller.close();}
  });
});
