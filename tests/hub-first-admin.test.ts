/** Real initialization and browser HTTP/session authority, fake directory only. No service or real accounts. */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { createHubInitializer } from "../src/hub/init/initializer.js";
import { runHubInitWizard } from "../src/hub/init/wizard.js";
import { hubPlanDigest } from "../src/hub/init/plan-digest.js";
import { setLocale } from "../src/locale.js";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { ADMIN, FakeIdentity, fakeDirectory, makeTestCerts, scriptedIO, tempDir } from "./support/hub-init-fixtures.js";
let r: Awaited<ReturnType<typeof s3bRig>> | undefined;
afterEach(async () => { await r?.close(); r = undefined; setLocale("en"); });
const claims = () => r!.db.prepare("SELECT value FROM audit_rows").all().map((v:any)=>JSON.parse(v.value)).filter((v:any)=>v.action === "administrator.claimed");
const count = (table:string) => (r!.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as any).n;

describe("first Hub administrator", () => {
  it.each(["en", "zh-TW"] as const)("designates without any personal password and claims only through the real browser sign-in in %s", async lang => {
    setLocale(lang);
    const home = tempDir("hub-first-admin-"), certs = makeTestCerts();
    const directory = fakeDirectory({ alice: { ok:true,person:ADMIN } });
    let personalBinds = 0;
    const create = ((...args:Parameters<typeof directory.create>)=> { const d = directory.create(...args); d.signIn = async()=>{personalBinds++;return {ok:true,person:ADMIN}}; return d; }) as typeof directory.create;
    const io = scriptedIO(["Example Hub","https://hub.example.test:8443","","127.0.0.1:8443","127.0.0.1:9443",certs.cert,certs.key,
      "corp","ldaps://directory.example.test",certs.caCert,"y","2","DC=example,DC=test","CN=Reader,DC=example,DC=test",{hidden:"Dummy-service-only"},
      "alice","y","7","30","initialize","no"]);
    expect(await runHubInitWizard({home,io:io.io,initializer:createHubInitializer({home,identity:new FakeIdentity(),probe:{pidAlive:()=>false}}),
      createDirectory:create,readFile:p=>readFileSync(p,"utf8"),checkNetwork:async()=>[],service:{installed:()=>false,install:async()=>{throw Error("service forbidden")}}})).toBe("initialized");
    expect(io.remaining()).toBe(0); expect(personalBinds).toBe(0); expect(directory.calls).toEqual([{bindPassword:"Dummy-service-only",login:"alice"}]);
    expect(io.prompts.filter(p=>/password|密碼/i.test(p))).toHaveLength(1);
    expect(io.text()).toContain(lang === "en" ? "first successful browser sign-in" : "首次成功在瀏覽器登入");
    const hub = (yaml.load(readFileSync(join(home,"fleet.yaml"),"utf8")) as any).hub;
    expect(hub.administrator).toEqual(ADMIN.key);
    expect(JSON.parse(readFileSync(join(home,"hub/init-manifest.json"),"utf8")).planDigest).toBe(hubPlanDigest(hub));
    r = await s3bRig({administrator:hub.administrator});
    expect(count("hub_people")).toBe(0); expect(claims()).toHaveLength(0);
    const outsider = r.addPerson("other","Other Person");
    const ordinary = await r.signIn("other"); expect(ordinary.body).toMatchObject({admin:false});
    expect((await r.call(ordinary,"GET","/hub/v1/admin/overview")).status).toBe(403);
    expect(outsider).not.toEqual(hub.administrator); expect(claims()).toHaveLength(0);
    const first = await r.signIn("admin"); expect(first.status).toBe(200); expect(first.body).toMatchObject({admin:true});
    expect((await r.call(first,"GET","/hub/v1/admin/overview")).status).toBe(200);
    expect(claims()).toHaveLength(1); expect(claims()[0]).toMatchObject({actor:{kind:"person",person:ADMIN.key},result:"completed"});
    await r.signIn("admin"); expect(claims()).toHaveLength(1);
  });

  it("does not claim on a wrong password, unavailable directory, or a fabricated fleet cookie", async () => {
    r = await s3bRig();
    const wrong = await fetch(`${r.base}/hub/v1/session`,{method:"POST",headers:{Origin:r.config.webOrigin,"Content-Type":"application/json"},body:JSON.stringify({login:"admin",password:"wrong"})});
    expect(wrong.status).toBe(403);
    expect((await r.call(null,"GET","/hub/v1/admin/overview",undefined,{Cookie:"agend_session="+"a".repeat(64)})).status).toBe(401);
    const signIn = r.directory.signIn; r.directory.signIn = async()=>({ok:false,reason:"unavailable"});
    expect((await r.signIn("admin")).status).toBe(503); r.directory.signIn = signIn;
    expect(count("hub_people")).toBe(0); expect(count("hub_sessions")).toBe(0); expect(claims()).toHaveLength(0);
  });

  it("rolls the claim, person and session back when required claim audit fails; a retry claims once", async () => {
    r = await s3bRig(); r.setAuditFails(true,"administrator.claimed");
    expect((await r.signIn("admin")).status).toBe(500);
    expect(count("hub_people")).toBe(0); expect(count("hub_sessions")).toBe(0); expect(claims()).toHaveLength(0);
    r.setAuditFails(false); expect((await r.signIn("admin")).body).toMatchObject({admin:true}); expect(claims()).toHaveLength(1);
  });

  it("claims once under concurrent successful sign-ins", async () => {
    r = await s3bRig(); const all = await Promise.all([r.signIn("admin"),r.signIn("admin")]);
    expect(all.map(s=>s.status)).toEqual([200,200]); expect(claims()).toHaveLength(1); expect(count("hub_sessions")).toBe(2);
  });

  it("keeps a renamed identity designated and never grants a recreated login its authority", async () => {
    r = await s3bRig(); const expected = {...r.admin}; r.rename("admin","renamed"); r.addPerson("admin","Replacement");
    expect((await r.signIn("admin")).body).toMatchObject({admin:false}); expect(claims()).toHaveLength(0);
    const original = await r.signIn("renamed"); expect(original.body).toMatchObject({admin:true});
    expect(claims()).toHaveLength(1); expect(claims()[0].actor.person).toEqual(expected);
    r.setEligible("renamed",false); expect((await r.call(original,"GET","/hub/v1/admin/overview")).status).toBe(401);
  });

  it("withholds a claim if the Hub is disabled while sign-in is in flight", async () => {
    r = await s3bRig(); const original = r.directory.signIn;
    let release!:()=>void, entered!:()=>void;
    const wait = new Promise<void>(resolve=>release=resolve), started = new Promise<void>(resolve=>entered=resolve);
    r.directory.signIn = async(...args)=>{entered();await wait;return original(...args)};
    const pending = r.signIn("admin"); await started; r.disable(); release();
    expect((await pending).status).toBe(503); expect(count("hub_people")).toBe(0); expect(claims()).toHaveLength(0);
  });
});
