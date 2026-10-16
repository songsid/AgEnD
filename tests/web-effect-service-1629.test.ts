import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebEffectLibrary } from "../src/web-effect-library.js";
import { ThemeStore } from "../src/web-theme-store.js";
import { WebEffectProfiles } from "../src/web-effect-profiles.js";
import { WebEffectService } from "../src/web-effect-service.js";
import { encodeEffectFiles } from "../src/web-effect-upload.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const files = (code = "agend.ready()") => new Map<string, Uint8Array>([["effect.json", Buffer.from(JSON.stringify({ v:1, runtime:"canvas-worker-v1", worker:"worker.js", name:"fixture", title:"Fixture", regions:["chat"], layer:"front", wants:["state"], params:{ n:{ type:"int", min:1, max:5, default:2 } } }))], ["worker.js", Buffer.from(code)]]);
const report = () => ({ v:1, device:"standard", verdict:"ok", reason:null, samples:1, fps_p50:60, fps_p10:60, fps_floor:54, long_task_p95:null, long_task_samples:0, attributed_long_task_p95:null, attributed_samples:0, attribution:"unknown", load_ms:2 });
function fixture() {
  mkdirSync(".artifacts", { recursive:true }); const root = mkdtempSync(join(process.cwd(), ".artifacts/effect-service-")); roots.push(root);
  const library = new WebEffectLibrary(root), themes = new ThemeStore(root), profiles = new WebEffectProfiles(root); let now = 0;
  library.registerReferenceSource("themes", () => { if (!themes.readable()) throw Error("unreadable"); return themes.placedEffects().flatMap(p => p.ids.map(id => ({ id, holder:`instance:${p.name}` }))); });
  const changed = vi.fn(), service = new WebEffectService({ library, themes, profiles, known:n => ["own","other"].includes(n), changed, monotonic:() => now });
  const upload = (person = "alice", code = "agend.ready()") => { const r = service.upload(person, encodeEffectFiles(files(code))!); expect(r.id, JSON.stringify(r)).toEqual(expect.any(String)); return r.id as string; };
  return { root, library, themes, profiles, service, changed, upload, at:(n:number) => { now=n; } };
}
describe("#1629 session-owned human effects service", () => {
  it("uploads only a validated bounded entry and lists only own or human-shared claims", () => {
    const f=fixture(), id=f.upload(); expect(f.service.list("alice")).toMatchObject({ effects:[{id, profiles:{status:"unmeasured",records:[]}}] }); expect(f.service.list("bob")).toEqual({effects:[]});
    expect(f.service.upload("bob",Buffer.from("{}"))).toEqual({error:"invalid_effect"}); expect(f.service.share("bob",{id,shared:true})).toMatchObject({error:"not_found"});
    expect(f.service.share("alice",{id,shared:true})).toEqual({id,shared:true}); expect(f.service.list("bob")).toMatchObject({effects:[{id}]});
    expect(f.service.share("alice",{id,shared:false})).toEqual({id,shared:false}); expect(f.service.list("bob")).toEqual({effects:[]});
  });
  it("aborts failed durable upload commits without announcing an upload", () => {
    const f=fixture(), abort=vi.spyOn(f.library,"abort");vi.spyOn(f.library,"commit").mockReturnValue({ok:false,error:"disk"});
    expect(f.service.upload("alice",encodeEffectFiles(files())!)).toEqual({error:"disk"});expect(abort).toHaveBeenCalledOnce();expect(f.changed).not.toHaveBeenCalled();
  });
  it("explicit human apply validates params and stamps host provenance, retaining other people's entries unchanged", () => {
    const f=fixture(), a=f.upload(), b=f.upload("bob","// second");
    expect(f.service.apply("alice",{instance:"own",id:b})).toEqual({error:"not_found"});expect(f.service.apply("bob",{instance:"own",id:b,params:{n:3}})).toMatchObject({id:b});
    const before=f.themes.get("own").placements.effects[0];expect(f.service.apply("alice",{instance:"own",id:a,params:{n:4}})).toMatchObject({id:a,params:{n:4}});
    expect(f.themes.get("own").placements.effects).toEqual([before,{id:a,by:"human",at:expect.any(Number),params:{n:4}}]);
    expect(f.service.apply("alice",{instance:"own",id:a,params:{n:2}})).toMatchObject({params:{}});expect(f.themes.get("own").placements.effects[1]).not.toHaveProperty("params");
  });
  it.each([{params:{n:6}},{params:{unknown:1}},{params:null},{by:"human"},{holder:"instance:other"},{instance:"missing"}])("refused apply %j leaves all placements unchanged", extra => {
    const f=fixture(), id=f.upload();expect(f.service.apply("alice",{instance:"own",id,...extra})).toHaveProperty("error");expect(f.themes.get("own").placements.effects).toEqual([]);
  });
  it("retained runtime read requires exact current instance placement; it never grants export/profile or a claim", () => {
    const f=fixture(), id=f.upload();expect(f.service.resource("bob",id,"own")).toEqual({error:"not_found"});expect(f.service.apply("alice",{instance:"own",id,params:{n:4}})).toMatchObject({id});
    // A retention provider is not itself authority to call an arbitrary named instance's runtime route.
    f.library.registerReferenceSource("extra",()=>[{id,holder:"instance:other"}]);
    expect(f.service.resource("bob",id,"other")).toEqual({error:"not_found"});expect(f.service.resource("bob",id,"missing")).toEqual({error:"not_found"});
    expect(f.service.resource("bob",id,"own")).toMatchObject({id,code:"agend.ready()",params:{n:4},wants:["state"],assets:[]});expect(f.service.placements("bob","own")).toMatchObject({effects:[{id,by:"human",params:{n:4}}]});
    expect(f.service.resource("bob",id)).toEqual({error:"not_found"});expect(f.service.profile("bob",id)).toEqual({error:"not_found"});expect(f.library.read(id,{kind:"human",id:"bob"}).ok).toBe(false);
    expect(f.service.remove("bob",{instance:"own",id})).toMatchObject({removed:[id]});expect(f.service.resource("bob",id,"own")).toEqual({error:"not_found"});expect(f.library.read(id,{kind:"human",id:"alice"}).ok).toBe(true);
  });
  it("independent human claims cannot be deleted through another person's id or an in-use placement", () => {
    const f=fixture(), id=f.upload();expect(f.service.delete("bob",id)).toEqual({error:"not_found"});f.service.apply("alice",{instance:"own",id});expect(f.service.delete("alice",id)).toEqual({error:"effect_in_use"});
    f.service.remove("alice",{instance:"own"});expect(f.service.delete("alice",id)).toEqual({deleted:id});expect(f.service.resource("alice",id)).toEqual({error:"not_found"});
  });
  it("profile writes require own/shared or the exact current placement, are diagnostic and rate bounded", () => {
    const f=fixture(), id=f.upload();expect(f.service.report("bob",id,report())).toEqual({error:"not_found"});f.service.apply("alice",{instance:"own",id});
    expect(f.service.report("bob",id,report(),"other")).toEqual({error:"not_found"});expect(f.service.report("bob",id,report(),"own")).toEqual({ok:true});
    const before=f.themes.get("own");expect(f.service.report("bob",id,report(),"own")).toEqual({error:"profile_rate_limited"});f.at(9999);expect(f.service.report("bob",id,report(),"own")).toEqual({error:"profile_rate_limited"});f.at(10000);expect(f.service.report("bob",id,report(),"own")).toEqual({ok:true});
    expect(f.service.profile("alice",id)).toMatchObject({records:[{source:"reported_host"},{source:"reported_host"}]});expect(f.themes.get("own")).toEqual(before);expect(f.service.profileSummary(id)).toMatchObject({records:[{source:"reported_host"}]});
    f.at(20000);expect(f.service.report("bob",id,{...report(),content:"private"},"own")).toEqual({error:"profile_args"});expect(f.service.report("bob",id,report(),"own")).toEqual({ok:true});
    f.service.remove("alice",{instance:"own"});f.at(30000);expect(f.service.report("bob",id,report(),"own")).toEqual({error:"not_found"});
  });
  it("host poster/cursor stay out of Worker assets and use the same own/reference ACL", () => {
    const f=fixture(), entry=files(), manifest=JSON.parse(Buffer.from(entry.get("effect.json")!).toString());manifest.poster="poster.png";manifest.cursor={hotspot:[0,0]};entry.set("effect.json",Buffer.from(JSON.stringify(manifest)));
    const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=","base64");for(const name of ["poster.png","cursor.png","assets/star.png"])entry.set(name,png);
    const uploaded=f.service.upload("alice",encodeEffectFiles(entry)!);expect(uploaded.id,JSON.stringify(uploaded)).toEqual(expect.any(String));const id=uploaded.id as string;
    expect(f.service.resource("alice",id)).toMatchObject({assets:[{name:"assets/star.png",mime:"image/png",data_b64:expect.any(String)}]});expect((f.service.resource("alice",id).assets as unknown[])).toHaveLength(1);
    expect(f.service.image("alice",id,"poster")).toMatchObject({ok:true,bytes:expect.any(Uint8Array)});expect(f.service.image("bob",id,"poster")).toEqual({ok:false,error:"not_found"});
    f.service.apply("alice",{instance:"own",id});expect(f.service.image("bob",id,"cursor","own")).toMatchObject({ok:true});expect(f.service.image("bob",id,"cursor","other")).toEqual({ok:false,error:"not_found"});
  });
  it("unreadable theme references and invalid placed params fail closed", () => {
    const f=fixture(),id=f.upload();f.service.apply("alice",{instance:"own",id});f.themes.setPlacements("own",{effects:[{id,params:{n:999}}]},"human",()=>null);
    expect(f.service.resource("bob",id,"own")).toHaveProperty("error");expect(f.service.placements("bob","own")).toMatchObject({effects:[]});
    const g=fixture(),other=g.upload();writeFileSync(join(g.root,"web-themes.json"),"{");const service=new WebEffectService({library:g.library,themes:new ThemeStore(g.root),profiles:g.profiles,known:()=>true,changed:vi.fn()});expect(service.apply("alice",{instance:"own",id:other})).toEqual({error:"themes_unreadable"});expect(service.remove("alice",{instance:"own"})).toEqual({error:"themes_unreadable"});expect(service.placements("alice","own")).toEqual({error:"themes_unreadable"});
  });
  it("latest per-class summaries select distinct last values and leave full history available on demand", () => {
    const f=fixture(),id=f.upload();expect(f.profiles.record(id,report()).ok).toBe(true);expect(f.profiles.record(id,{...report(),fps_p50:30,fps_p10:30}).ok).toBe(true);expect(f.profiles.record(id,{...report(),device:"constrained",fps_p50:40,fps_p10:40}).ok).toBe(true);
    expect(f.service.profileSummary(id)).toMatchObject({records:[{device:"standard",fps_p50:30},{device:"constrained",fps_p50:40}]});expect((f.service.profile("alice",id).records as unknown[])).toHaveLength(3);
  });
  it("diagnostic ingress has a global live-key bound and releases it at the monotonic minute boundary", () => {
    const f=fixture(),id=f.upload();f.service.share("alice",{id,shared:true});
    // This control isolates the in-memory ingress budget; ordinary tests exercise the real durable writer.
    const writer=vi.spyOn(f.profiles,"record").mockReturnValue({ok:true,profile:{...report(),source:"reported_host",at:1}} as ReturnType<WebEffectProfiles["record"]>);
    for(let n=0;n<1024;n++)expect(f.service.report(`person-${n}`,id,report())).toEqual({ok:true});
    expect(f.service.report("overflow",id,report())).toEqual({error:"profile_rate_limited"});expect(writer).toHaveBeenCalledTimes(1024);
    f.at(59999);expect(f.service.report("overflow",id,report())).toEqual({error:"profile_rate_limited"});f.at(60000);expect(f.service.report("overflow",id,report())).toEqual({ok:true});
  });
  it("report clock failure/rollback refuses without updating a record", () => {
    const f=fixture(), id=f.upload();f.at(100);expect(f.service.report("alice",id,report())).toEqual({ok:true});f.at(99);expect(f.service.report("alice",id,report())).toEqual({error:"profile_clock"});f.at(NaN);expect(f.service.report("alice",id,report())).toEqual({error:"profile_clock"});expect(f.profiles.read(id)).toMatchObject({records:[expect.any(Object)]});
  });
  it.each(["","x".repeat(257)])("invalid host principal %j cannot upload/share/read/write", person => {
    const f=fixture(), id=f.upload();expect(f.service.upload(person,encodeEffectFiles(files())!)).toHaveProperty("error");expect(f.service.share(person,{id,shared:true})).toHaveProperty("error");expect(f.service.resource(person,id)).toHaveProperty("error");expect(f.service.remove(person,{instance:"own"})).toHaveProperty("error");expect(f.service.report(person,id,report())).toHaveProperty("error");
  });
});
