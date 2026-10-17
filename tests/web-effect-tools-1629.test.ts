import {afterEach,expect,it,vi} from "vitest";
import {mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {WebEffectLibrary} from "../src/web-effect-library.js";
import {WebEffectTools,type EffectPlacementInput} from "../src/web-effect-tools.js";
import {AppearanceLimiter,type AppearanceBucket} from "../src/web-appearance-policy.js";
import {sendEffectInParts} from "../src/web-effect-upload.js";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function files(code="agend.ready()",regions=["chat"],params?:unknown){return new Map<string,Uint8Array>([["effect.json",Buffer.from(JSON.stringify({v:1,runtime:"canvas-worker-v1",worker:"worker.js",name:"fixture",title:"Fixture",regions,layer:"front",wants:[],...(params?{params}:{})}))],["worker.js",Buffer.from(code)]]);}
function fixture(){
 const parent=join(process.cwd(),".artifacts");mkdirSync(parent,{recursive:true});const dir=mkdtempSync(join(parent,"effect-tools-"));roots.push(dir);
 let now=0,refusal:string|null=null;const lib=new WebEffectLibrary(dir),limiter=new AppearanceLimiter(()=>now),placements=new Map<string,EffectPlacementInput[]>();
 const placed=(name:string)=>placements.get(name)??[];
 const place=vi.fn((name:string,entries:Array<string|EffectPlacementInput>)=>{placements.set(name,entries.map(e=>typeof e==="string"?placed(name).find(p=>p.id===e)??{id:e}:e));return {ok:true as const,rev:1};});
 lib.registerReferenceSource("themes",()=>[...placements].flatMap(([name,entries])=>entries.map(e=>({id:e.id,holder:"instance:"+name}))));
 const changed=vi.fn(),preview=vi.fn(async(name:string,id:string,title:string)=>({posted:{instance:name,id,title}}));
 const authorize=vi.fn((name:string,buckets:readonly AppearanceBucket[])=>{if(refusal)return {error:refusal};const l=limiter.check(name,buckets);return l.ok?null:{...l};});
 const tools=new WebEffectTools({library:lib,limiter,authorize,placed,place,changed,preview,profiles:id=>({id,records:[]}),clock:()=>now});
 return {dir,lib,limiter,tools,place,placed,placements,changed,preview,advance:(ms:number)=>{now+=ms;},refuse:(s:string|null)=>{refusal=s;}};
}
async function upload(f:ReturnType<typeof fixture>,instance="own",input=files()){
 const result=await sendEffectInParts(input,async args=>f.tools.upload(instance,args));expect(result.id).toEqual(expect.any(String));return result.id as string;
}
it("uploads real wire parts into the real scoped library, once",async()=>{
 const f=fixture(),id=await upload(f,"own",files("a".repeat(700000)));
 expect(f.lib.read(id,{kind:"agent",id:"own"}).ok).toBe(true);
 expect(f.lib.read(id,{kind:"agent",id:"other"}).ok).toBe(false);
 expect(f.changed).toHaveBeenCalledTimes(1);
 expect(f.limiter.remaining("own").uploads).toBeDefined();
});
it("places a chat effect in the caller's own chat, using an explicit placement",async()=>{
 const f=fixture(),id=await upload(f,"own",files("agend.ready()",["chat","page"]));
 expect(f.tools.apply("own",{id})).toMatchObject({id,region:"chat"});
 expect(f.place).toHaveBeenCalledWith("own",[{id}]);
 expect(f.tools.apply("other",{id})).toMatchObject({error:"not_found"});
});
it("#2017: an effect whose regions lack chat is refused before any write, change count or notice; read access is checked first",async()=>{
 const f=fixture(),page=await upload(f,"own",files("agend.ready()",["page","header"]));f.changed.mockClear();f.advance(30000);
 expect(f.tools.apply("other",{id:page}),"unreadable stays not_found").toEqual({error:"not_found"});
 for(let i=0;i<2;i++)expect(f.tools.apply("own",{id:page}),"refused again on a repeat").toEqual({error:"effect_region",message:"This effect's regions do not include chat."});
 expect([f.place.mock.calls.length,f.changed.mock.calls.length,f.placed("own")]).toEqual([0,0,[]]);
 const chat=await upload(f,"own",files("// chat"));f.changed.mockClear();
 expect(f.tools.apply("own",{id:chat}),"no change was counted: the next apply is not rate-limited").toMatchObject({id:chat,region:"chat"});
});
it("#2017: an older placement without chat stays, is retained beside a new one and can be removed",async()=>{
 const f=fixture(),page=await upload(f,"own",files("agend.ready()",["page"])),chat=await upload(f,"own",files("// chat"));
 f.placements.set("own",[{id:page,params:{kept:true}}]);
 expect(f.tools.apply("own",{id:chat})).toMatchObject({id:chat});
 expect(f.place).toHaveBeenLastCalledWith("own",[page,{id:chat}]);
 expect(f.placed("own")).toEqual([{id:page,params:{kept:true}},{id:chat}]);
 f.advance(30000);
 expect(f.tools.apply("own",{id:page}),"but never placed again explicitly").toMatchObject({error:"effect_region"});
 expect(f.tools.remove("own",{id:page})).toMatchObject({removed:[page]});
 expect(f.placed("own")).toEqual([{id:chat}]);
});
it("validates typed params and cannot accept a target/holder or invalid overrides",async()=>{
 const f=fixture(),id=await upload(f,"own",files("agend.ready()",["chat"],{size:{type:"number",min:1,max:10,default:2}}));
 for(const args of [{id,params:null},{id,params:{unknown:1}},{id,params:{size:11}},{id,instance:"other"},{id,holder:"mod:any"}])expect(f.tools.apply("own",args).error).toEqual(expect.any(String));
 expect(f.place).not.toHaveBeenCalled();
 expect(f.tools.apply("own",{id,params:{size:3}})).toMatchObject({region:"chat",params:{size:3}});
 expect(f.place).toHaveBeenCalledWith("own",[{id,params:{size:3}}]);
});
it("restamps the explicit target and retains the other host entry by string",async()=>{
 const f=fixture(),a=await upload(f),b=await upload(f,"second",files("// second"));
 f.placements.set("own",[{id:a,params:{old:true}},{id:b}]);
 expect(f.tools.apply("own",{id:a})).toMatchObject({id:a});
 expect(f.place).toHaveBeenLastCalledWith("own",[{id:a},b]);
});
it("does not record refused/invalid writes, shares the change limiter and caps placements at two",async()=>{
 const f=fixture(),id=await upload(f);f.refuse("locked");
 expect(f.tools.apply("own",{id})).toEqual({error:"locked"});expect(f.tools.remove("own",{})).toEqual({error:"locked"});expect(f.tools.delete("own",{id})).toEqual({error:"locked"});
 f.refuse(null);expect(f.tools.apply("own",{id,params:{bad:1}}).error).toBeDefined();
 expect(f.tools.apply("own",{id})).toMatchObject({id});
 expect(f.tools.remove("own",{})).toMatchObject({error:"rate_limited"});f.advance(30000);
 expect(f.tools.remove("own",{})).toMatchObject({removed:[id]});
 f.advance(30000);f.placements.set("own",[{id:"b".repeat(32)},{id:"c".repeat(32)}]);
 expect(f.tools.apply("own",{id})).toMatchObject({error:"effects"});
 f.placements.set("own",[]);expect(f.tools.apply("own",{id})).toMatchObject({id});
});
it("removes only its own placements and deletes only an unused own claim",async()=>{
 const f=fixture(),id=await upload(f);f.placements.set("other",[{id}]);
 expect(f.tools.delete("own",{id})).toEqual({error:"effect_in_use"});
 expect(f.tools.remove("own",{})).toEqual({removed:[]});
 expect(f.placed("other")).toEqual([{id}]);f.placements.set("other",[]);
 expect(f.tools.delete("other",{id})).toEqual({error:"not_found"});
 expect(f.tools.delete("own",{id})).toEqual({deleted:id});
});
it("lists/profiles/previews only own or human-shared effects and binds the preview resource",async()=>{
 const f=fixture(),id=await upload(f);
 expect(f.tools.list("other")).toEqual({effects:[]});
 expect(f.tools.profile("other",{id})).toEqual({error:"not_found"});
 expect(await f.tools.preview("other",{id})).toEqual({error:"not_found"});
 expect(await f.tools.preview("own",{id})).toEqual({posted:{instance:"own",id,title:"Fixture"}});
 expect(f.preview).toHaveBeenCalledTimes(1);
 expect(f.tools.handle("own","list_web_effects",{instance:"other"})).toEqual({error:"effect_args"});
});
it("rechecks authority on later parts and never publishes or spends quota after revocation",async()=>{
 const f=fixture();let calls=0;
 const answer=await sendEffectInParts(files("a".repeat(700000)),async args=>{
  if(calls++>0)f.refuse("locked");return f.tools.upload("own",args);
 });
 expect(answer).toEqual({error:"locked"});expect(f.lib.list({kind:"agent",id:"own"})).toMatchObject({entries:[]});
 expect(f.limiter.remaining("own").uploads).toBe(3);expect(f.changed).not.toHaveBeenCalled();
});
it("aborts a staged upload when the durable claim write fails, without charging",async()=>{
 const f=fixture(),abort=vi.spyOn(f.lib,"abort");vi.spyOn(f.lib,"commit").mockReturnValue({ok:false,error:"index_failure"});
 const answer=await sendEffectInParts(files(),async args=>f.tools.upload("own",args));
 expect(answer).toEqual({error:"index_failure"});expect(abort).toHaveBeenCalledOnce();
 expect(f.lib.list({kind:"agent",id:"own"})).toMatchObject({entries:[]});expect(f.limiter.remaining("own").uploads).toBe(3);expect(f.changed).not.toHaveBeenCalled();
});
it("lists and profiles a human-shared effect without revealing a private one",()=>{
 const f=fixture(),human={kind:"human" as const,id:"operator"};
 const claim=(code:string)=>{const s=f.lib.stage(files(code),human);if(!s.ok)throw Error(s.error);const r=f.lib.commit(s.stageId);if(!r.ok)throw Error(r.error);return r.ids[0]!;};
 const shared=claim("// shared"),secret=claim("// private");expect(f.lib.setShared(shared,human,true).ok).toBe(true);
 expect(f.tools.list("own")).toMatchObject({effects:[{id:shared}]});expect(f.tools.profile("own",{id:shared})).toEqual({id:shared,records:[]});
 expect(f.tools.profile("own",{id:secret})).toEqual({error:"not_found"});
});
