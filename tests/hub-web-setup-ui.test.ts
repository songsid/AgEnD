/** Mounted production Settings form. Public protocol replies; no OS service, real directory or user account. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto, X509Certificate } from "node:crypto";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { directoryCertificates } from "./support/hub-directory-ca-fixture.js";
let mod:any, section:any, i18n:any;
const pages:AppPage[]=[],calls:Array<{path:string;init:any}>=[];
const hubId="90000000-0000-4000-8000-000000000001";
const ref="a".repeat(32),probeRef="b".repeat(32),pem="-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n";
const prepared={v:1,ref,expiresAt:Date.now()+300000,administrator:"Avery",webOrigin:"https://hub.example.test:19443",memberOrigin:"https://hub.example.test:19444",certificate:{fingerprint:"AA:BB:PUBLIC",validTo:"2030-01-01"},existingFleet:false};
const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return {promise,resolve};};
beforeAll(async()=>{const p=page();mod=await import("/ui/js/settings-hub-setup.js");section=await import("/ui/js/settings-hub-section.js");i18n=await import("/assets/app-i18n.js");p.restore();});
afterEach(async()=>{for(const p of pages.splice(0)){await p.unmount();p.restore();}vi.restoreAllMocks();vi.unstubAllGlobals();calls.length=0;});
function fetcher(reply:(path:string,init:any)=>any=path=>path.endsWith("/prepare")?prepared:{ok:true}){
  vi.stubGlobal("fetch",vi.fn(async(path:string,init:any={})=>{calls.push({path,init});const body=path==="/api/settings/hub/setup"?await reply(path,init)??{v:1,initialized:false,incomplete:false,existingFleet:false}:await reply(path,init);
    return {ok:!body?.error,status:body?.error?409:200,json:async()=>body};}));
}
function defaults(path:string){return path==="/api/settings/hub/setup"?{v:1,initialized:false,incomplete:false,existingFleet:false}:path.endsWith("/prepare")?prepared:{ok:true};}
async function mount(options:{marked?:boolean;publicLink?:boolean;language?:string;component?:any;props?:any}={}){
  const p=page({url:"http://127.0.0.1:19290/settings/hub",storage:{agend_lang:options.language??"en"}});pages.push(p);
  vi.stubGlobal("crypto",webcrypto);p.document.body.dataset.hubSetup=options.marked===false?"":"1";
  if(options.publicLink)p.document.body.dataset.publicLink="1";
  i18n.setLang(options.language??"en",{store:false});await p.mount(h(options.component??mod.HubSetupSettings,options.props??{}));await settle(12);return p;
}
const textButton=(p:AppPage,text:string)=>[...p.root.querySelectorAll("button")].find((b:any)=>b.textContent===text);
async function click(p:AppPage,text:string){const b=textButton(p,text);expect(b, text).toBeTruthy();fire(b,"click");await settle(12);}
async function fill(p:AppPage,name:string,value:string){const e=p.root.querySelector("#hubSetup-"+name);expect(e,name).toBeTruthy();e.value=value;fire(e,e.tagName==="SELECT"?"change":"input");await settle(3);}
async function submit(p:AppPage){fire(p.root.querySelector("form"),"submit");await settle(15);}
async function toDirectory(p:AppPage){await click(p,"Set up on this computer");await fill(p,"webOrigin",prepared.webOrigin);await fill(p,"memberOrigin",prepared.memberOrigin);await submit(p);}
async function toAdmin(p:AppPage){await toDirectory(p);for(const [k,v] of Object.entries({realm:"fictional",url:"ldaps://directory.example.test:636",baseDn:"DC=example,DC=test",bindDn:"CN=Reader,DC=example,DC=test",bindPassword:"Dummy-service-only"}))await fill(p,k,v);await submit(p);await fill(p,"administratorLogin","avery");}
describe("host-only browser Hub setup",()=>{
  it.each([{marked:false},{publicLink:true}])("does no reads or effects without the local page capability %j",async opts=>{
    fetcher(()=>{throw Error("unexpected");});const p=await mount(opts);expect(calls).toEqual([]);expect(p.root.querySelector("form")).toBeNull();
  });
  it("a remote/retained Settings shell does not import or mount setup",async()=>{
    fetcher(defaults);const p=await mount({marked:false,component:section.HubSection,props:{hubHost:false,overPublicLink:false}});
    expect(calls.some(c=>c.path.startsWith("/api/settings/hub/setup"))).toBe(false);expect(p.root.querySelector("#hub-setup")).toBeNull();
  });
  it.each([undefined,{v:2,initialized:false,incomplete:false,existingFleet:false},{v:1,initialized:true,incomplete:false,existingFleet:false},{v:1,initialized:false,incomplete:true,existingFleet:false}])("refuses absent/incompatible/existing setup views %j",async view=>{
    fetcher(()=>view??{});const p=await mount();expect(textButton(p,"Set up on this computer")).toBeUndefined();expect(p.root.querySelector("form")).toBeNull();
  });
  it("tests the exact server draft, clears write-only secrets and creates once with no browser-supplied authority",async()=>{
    fetcher(path=>path.endsWith("/commit")?{ok:true,hubId,webOrigin:prepared.webOrigin}:defaults(path));const p=await mount();await toAdmin(p);await submit(p);
    expect(p.root.textContent).toContain("AA:BB:PUBLIC");expect(p.root.textContent).toContain("Avery");expect(p.root.textContent).toContain("ldaps://directory.example.test:636");expect(p.root.textContent).toContain("CN=Reader,DC=example,DC=test");expect(p.root.textContent).not.toContain("Dummy-service-only");
    const prep=calls.find(c=>c.path.endsWith("/prepare"))!;expect(JSON.parse(prep.init.body)).toMatchObject({directory:{realm:"fictional"},bindPassword:"Dummy-service-only",administratorLogin:"avery",confirmedCa:[]});
    expect(JSON.parse(prep.init.body)).not.toHaveProperty("name");expect(JSON.parse(prep.init.body)).not.toHaveProperty("administrator");
    expect(calls.filter(c=>c.path.endsWith("/test")).map(c=>JSON.parse(c.init.body))).toEqual([{ref}]);
    const button=textButton(p,"Create Hub");fire(button,"click");fire(button,"click");await settle(15);
    expect(calls.filter(c=>c.path.endsWith("/commit")).map(c=>JSON.parse(c.init.body))).toEqual([{ref}]);
    expect(p.root.textContent).toContain("Hub created");expect(p.root.querySelector(`a[href="${prepared.webOrigin}/ui/hub"]`)).toBeNull();
    expect(p.root.textContent).not.toContain("Hub is online");expect(p.root.querySelector("input[type=password]")).toBeNull();
  });
  it("withholds sign-in until a fresh read confirms the exact created Hub is ready", async () => {
    const held = deferred(); let committed = false;
    fetcher(path => path.endsWith("/commit") ? (committed = true, {ok:true,hubId,webOrigin:prepared.webOrigin})
      : path === "/api/settings/hub/setup" && committed ? held.promise : defaults(path));
    const p = await mount(); await toAdmin(p); await submit(p); await click(p, "Create Hub");
    expect(p.root.querySelector(`a[href="${prepared.webOrigin}/ui/hub"]`)).toBeNull();
    expect(p.root.textContent).toContain("Checking whether the Hub is ready");
    held.resolve({v:1,initialized:true,runtime:{hubId,webOrigin:prepared.webOrigin,state:"ready"}}); await settle(15);
    expect(p.root.querySelector(`a[href="${prepared.webOrigin}/ui/hub"]`)?.textContent).toBe("Open Hub sign-in");
    expect(p.root.querySelector('a[href="/settings/hub"]')).toBeNull();
    expect(calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
  });
  it.each(["different Hub", "different origin", "old server", "unavailable"])("does not open sign-in on %s; checking again never repeats Create", async kind => {
    let committed = false, good = false;
    fetcher(path => path.endsWith("/commit") ? (committed = true, {ok:true,hubId,webOrigin:prepared.webOrigin})
      : path === "/api/settings/hub/setup" && committed ? {v:1,initialized:true,...(kind === "old server" && !good ? {} : {runtime:{
        hubId:kind === "different Hub" && !good ? "other" : hubId,
        webOrigin:kind === "different origin" && !good ? "https://other.example.test" : prepared.webOrigin,
        state:kind === "unavailable" && !good ? "unavailable" : "ready"}})} : defaults(path));
    const p = await mount(); await toAdmin(p); await submit(p); await click(p, "Create Hub");
    expect(p.root.querySelector(`a[href="${prepared.webOrigin}/ui/hub"]`)).toBeNull();
    good = true; await click(p, "Check again");
    expect(p.root.querySelector(`a[href="${prepared.webOrigin}/ui/hub"]`)).toBeTruthy();
    expect(calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
  });
  it("automatically checks a starting Hub, bounds the reads and keeps Create one-shot", async () => {
    const later: Array<() => void> = [], original = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb:any, ms?:number, ...args:any[]) => {
      if (ms === 2000) { later.push(cb); return 0; }
      return original(cb, ms, ...args);
    }) as typeof setTimeout);
    let committed = false, state = "starting";
    fetcher(path => path.endsWith("/commit") ? (committed = true, {ok:true,hubId,webOrigin:prepared.webOrigin})
      : path === "/api/settings/hub/setup" && committed ? {v:1,initialized:true,runtime:{hubId,webOrigin:prepared.webOrigin,state}} : defaults(path));
    const p = await mount(); await toAdmin(p); await submit(p); await click(p, "Create Hub");
    for (let i = 0; i < 29; i++) { expect(later).toHaveLength(1); later.shift()!(); await settle(5); }
    expect(later).toHaveLength(0); expect(textButton(p, "Check again")).toBeTruthy();
    expect(calls.filter(c => c.path === "/api/settings/hub/setup")).toHaveLength(31);
    await click(p, "Check again"); expect(later).toHaveLength(1);
    state = "ready"; later.shift()!(); await settle(12);
    expect(p.root.querySelector(`a[href="${prepared.webOrigin}/ui/hub"]`)).toBeTruthy();
    expect(later).toHaveLength(0); expect(calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
  });
  it("retires a held readiness read when the page unmounts", async () => {
    const held = deferred(); let committed = false;
    fetcher(path => path.endsWith("/commit") ? (committed = true, {ok:true,hubId,webOrigin:prepared.webOrigin})
      : path === "/api/settings/hub/setup" && committed ? held.promise : defaults(path));
    const p = await mount(); await toAdmin(p); await submit(p); await click(p, "Create Hub");
    const reading = calls.at(-1)!; await p.unmount();
    held.resolve({v:1,initialized:true,runtime:{hubId,webOrigin:prepared.webOrigin,state:"ready"}}); await settle(15);
    expect(reading.init.signal.aborted).toBe(true); expect(p.root.textContent).toBe("");
  });
  it("session end removes the created card and fences a held readiness reply", async () => {
    const held = deferred(); let committed = false, end!:()=>void, ended = false;
    fetcher(path => path.endsWith("/commit") ? (committed = true, {ok:true,hubId,webOrigin:prepared.webOrigin})
      : path === "/api/settings/hub/setup" && committed ? held.promise : defaults(path));
    const p = await mount(); await p.unmount();
    (globalThis as any).window.AgendAuth = {sessionEnded:()=>ended,onSessionEnd:(cb:()=>void)=>{end=cb;return ()=>{};}};
    await p.mount(h(mod.HubSetupSettings,{})); await settle(12); await toAdmin(p); await submit(p); await click(p, "Create Hub");
    const reading = calls.at(-1)!; ended = true; end();
    held.resolve({v:1,initialized:true,runtime:{hubId,webOrigin:prepared.webOrigin,state:"ready"}}); await settle(15);
    expect(reading.init.signal.aborted).toBe(true);
    expect(p.root.querySelector(`a[href="${prepared.webOrigin}/ui/hub"]`)).toBeNull();
    expect(p.root.textContent).toContain("no longer allowed");
  });
  it("a held prepare after unmount cancels its returned draft and never tests or commits it",async()=>{
    const held=deferred();fetcher(path=>path.endsWith("/prepare")?held.promise:defaults(path));const p=await mount();await toAdmin(p);await submit(p);
    await p.unmount();held.resolve(prepared);await settle(15);
    expect(calls.some(c=>c.path.endsWith("/test")||c.path.endsWith("/commit"))).toBe(false);
    expect(calls.filter(c=>c.path.endsWith("/cancel")).map(c=>JSON.parse(c.init.body))).toContainEqual({ref});
    expect(calls.find(c=>c.path.endsWith("/prepare"))!.init.signal.aborted).toBe(true);
  });
  it("a session ending during test clears secrets and blocks review or creation",async()=>{
    const held=deferred();let end!:()=>void,ended=false;
    fetcher(path=>path.endsWith("/test")?held.promise:defaults(path));const p=await mount();
    (globalThis as any).window.AgendAuth={sessionEnded:()=>ended,onSessionEnd:(cb:()=>void)=>{end=cb;return ()=>{};}};
    // Remount to subscribe to the authentic session lifecycle API.
    await p.unmount();await p.mount(h(mod.HubSetupSettings,{}));await settle(12);await toAdmin(p);await submit(p);
    ended=true;end();held.resolve({ok:true});await settle(15);
    expect(p.root.querySelector("input[type=password]")).toBeNull();expect(textButton(p,"Create Hub")).toBeUndefined();expect(calls.some(c=>c.path.endsWith("/commit"))).toBe(false);
  });
  it("back cancels the reviewed draft; edits require another service password and test",async()=>{
    fetcher(defaults);const p=await mount();await toAdmin(p);await submit(p);await click(p,"Back");
    expect(calls.filter(c=>c.path.endsWith("/cancel")).map(c=>JSON.parse(c.init.body))).toContainEqual({ref});
    expect(p.root.querySelector("#hubSetup-bindPassword").value).toBe("");expect(textButton(p,"Create Hub")).toBeUndefined();
  });
  it("a refused test cannot leave a usable review",async()=>{
    fetcher(path=>path.endsWith("/test")?{error:"directory"}:defaults(path));const p=await mount();await toAdmin(p);await submit(p);
    expect(textButton(p,"Create Hub")).toBeUndefined();expect(p.root.textContent).toContain("could not be verified");expect(calls.some(c=>c.path.endsWith("/cancel"))).toBe(true);
  });
  it("a lost commit response is not retried and only offers checking Settings",async()=>{
    fetcher(path=>path.endsWith("/commit")?Promise.reject(Error("lost")):defaults(path));const p=await mount();await toAdmin(p);await submit(p);await click(p,"Create Hub");
    expect(p.root.textContent).toContain("result could not be confirmed");expect(textButton(p,"Create Hub")).toBeUndefined();expect(p.root.querySelector('a[href="/settings/hub"]')).toBeTruthy();
    expect(calls.filter(c=>c.path.endsWith("/commit"))).toHaveLength(1);
  });
  it.each(["ldaps://directory.example.test:636", "ldaps://directory.example.test"])("inspection sends no credentials and Stop never fetches CA (%s)",async url=>{
    fetcher(path=>path.endsWith("/ca/inspect")?{ref:probeRef,server:"ldaps://directory.example.test:636",certificate:{fingerprint256:"AA:PUBLIC",validTo:"2030",subject:"Fake directory",issuer:"Fake CA"}}:defaults(path));
    const p=await mount();await toDirectory(p);await fill(p,"url",url);await fill(p,"ca","fetch");await click(p,"Inspect server certificate");
    expect(JSON.parse(calls.find(c=>c.path.endsWith("/ca/inspect"))!.init.body)).toEqual({url});
    expect(calls.some(c=>c.path.endsWith("/ca/fetch"))).toBe(false);await click(p,"Stop: fingerprint does not match");
    expect(textButton(p,"Fingerprint matches — fetch CA")).toBeUndefined();expect(calls.some(c=>c.path.endsWith("/ca/fetch"))).toBe(false);
  });
  it("uses the shown leaf pin, then separately requires all fetched CA fingerprints before prepare",async()=>{
    fetcher(path=>path.endsWith("/ca/inspect")?{ref:probeRef,server:"ldaps://directory.example.test:636",certificate:{fingerprint256:"AA:PUBLIC"}}:path.endsWith("/ca/fetch")?{caPem:pem}:defaults(path));
    const p=await mount();await toDirectory(p);await fill(p,"url","ldaps://directory.example.test:636");await fill(p,"ca","fetch");await click(p,"Inspect server certificate");await click(p,"Fingerprint matches — fetch CA");
    expect(JSON.parse(calls.find(c=>c.path.endsWith("/ca/fetch"))!.init.body)).toEqual({ref:probeRef,fingerprint:"AA:PUBLIC"});
    await vi.waitFor(()=>expect(p.root.querySelector('input[type="checkbox"]')).toBeTruthy());await submit(p);
    expect(p.root.textContent).toContain("confirm every CA fingerprint");expect(calls.some(c=>c.path.endsWith("/prepare"))).toBe(false);
    const ca=p.root.querySelector('input[type="checkbox"]');ca.checked=true;fire(ca,"change");await settle(5);await submit(p);
    expect(p.root.querySelector("#hubSetup-administratorLogin")).toBeTruthy();
  });
  it("sends exactly the imported public CA fingerprints after their confirmation",async()=>{
    fetcher(defaults);const p=await mount();await toAdmin(p);await click(p,"Back");await fill(p,"ca","paste");await fill(p,"caPem",pem);
    await vi.waitFor(()=>expect(p.root.querySelector('input[type="checkbox"]')).toBeTruthy());
    const cb=p.root.querySelector('input[type="checkbox"]');cb.checked=true;fire(cb,"change");await settle(5);await submit(p);await submit(p);
    const sent=JSON.parse(calls.find(c=>c.path.endsWith("/prepare"))!.init.body);
    expect(sent.directory.caPem).toBe(pem);expect(sent.confirmedCa).toEqual(await mod.setupCaFingerprints(pem));expect(sent.confirmedCa).toHaveLength(1);
  });
  it("computes actual SHA-256 of each DER CA and rejects mixed text/too many certificates",async()=>{
    const c=directoryCertificates();try{expect(await mod.setupCaFingerprints(c.ca)).toEqual([new X509Certificate(c.ca).fingerprint256]);}finally{c.cleanup();}
    await expect(mod.setupCaFingerprints("secret\n"+pem)).rejects.toThrow();await expect(mod.setupCaFingerprints(pem.repeat(5))).rejects.toThrow();
  });
  it.each(["en","zh-TW"])("owns all copy in %s and shows errors in plain words",async language=>{
    fetcher(()=>({error:"network"}));const p=await mount({language});expect(p.root.textContent).not.toContain("hubSetup.");expect(p.root.textContent).not.toContain("ECONN");
    expect(p.root.textContent).toContain(language==="en"?"port is in use":"連接埠已被占用");
  });
});
