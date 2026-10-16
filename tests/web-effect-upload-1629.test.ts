import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checkEffectEntry } from "../src/web-effect-bundle.js";
import { readAgentEffect, encodeEffectFiles, decodeEffectFiles, sendEffectInParts, EFFECT_WIRE_LIMIT } from "../src/web-effect-upload.js";
vi.mock("node:child_process",()=>{ const denied=()=>{throw Error("process launch forbidden");};return {spawn:denied,exec:denied,execFile:denied,execSync:denied,spawnSync:denied,execFileSync:denied}; });
const roots:string[]=[];
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function files(code="agend.ready()") { return new Map<string,Uint8Array>([["effect.json",Buffer.from(JSON.stringify({v:1,runtime:"canvas-worker-v1",worker:"worker.js",name:"fixture",title:"Fixture",regions:["chat"],layer:"behind",wants:[]}))],["worker.js",Buffer.from(code)]]); }
function fixture() {
 mkdirSync(join(process.cwd(),".artifacts"),{recursive:true});
 const root=mkdtempSync(join(process.cwd(),".artifacts/upload-test-"));roots.push(root);
 const workspace=join(root,"workspace"),stateDir=join(root,"state"),dir=join(workspace,"effect");
 mkdirSync(dir,{recursive:true});mkdirSync(stateDir);
 for(const [name,bytes] of files())writeFileSync(join(dir,name),bytes);
 return {root,workspace,stateDir,dir,opts:{workspace,stateDir}};
}
it("reads the actual bounded workspace entry and snapshots normalized bytes",async()=>{
 const f=fixture(), r=await readAgentEffect("effect",f.opts);
 expect(r.ok).toBe(true);if(!r.ok)return;
 expect(checkEffectEntry(r.files).ok).toBe(true);
 writeFileSync(join(f.dir,"worker.js"),"// changed");
 expect(Buffer.from(r.files.get("worker.js")!).toString()).toBe("agend.ready()");
 expect(await readAgentEffect(f.dir,f.opts)).toMatchObject({ok:true});
});
it("refuses outside/state paths and symlink roots/files/assets",async()=>{
 const f=fixture();symlinkSync(f.dir,join(f.workspace,"alias"),"dir");
 expect((await readAgentEffect("alias",f.opts)).ok).toBe(false);
 expect((await readAgentEffect(f.dir,{workspace:f.stateDir,stateDir:f.stateDir})).ok).toBe(false);
 expect((await readAgentEffect(f.dir,{workspace:f.workspace,stateDir:f.dir})).ok).toBe(false);
 rmSync(join(f.dir,"worker.js"));symlinkSync(join(f.dir,"effect.json"),join(f.dir,"worker.js"));
 expect((await readAgentEffect(f.dir,f.opts)).ok).toBe(false);
});
it("refuses unsupported files, invalid effects, absent workspaces and unknown input",async()=>{
 const f=fixture();
 for(const v of [null,{},"", "\0bad"])expect((await readAgentEffect(v,f.opts)).ok).toBe(false);
 expect((await readAgentEffect(f.dir,{...f.opts,workspace:undefined})).ok).toBe(false);
 writeFileSync(join(f.dir,"extra.html"),"x");expect((await readAgentEffect(f.dir,f.opts)).ok).toBe(false);
 rmSync(join(f.dir,"extra.html"));writeFileSync(join(f.dir,"effect.json"),"{}");expect((await readAgentEffect(f.dir,f.opts)).ok).toBe(false);
});
it("bounds asset enumeration and all raw bytes",async()=>{
 const f=fixture();mkdirSync(join(f.dir,"assets"));
 for(let i=0;i<17;i++)writeFileSync(join(f.dir,"assets",`a${i}.png`),"x");
 expect((await readAgentEffect(f.dir,f.opts)).ok).toBe(false);
 rmSync(join(f.dir,"assets"),{recursive:true});writeFileSync(join(f.dir,"worker.js"),Buffer.alloc(8*1024*1024+1,32));
 expect((await readAgentEffect(f.dir,f.opts)).ok).toBe(false);
});
it("encodes only normalized CW1 and roundtrips exact code bytes",()=>{
 const code="// 原文\n"+" ".repeat(900000)+"agend.ready()", entry=files(code), wire=encodeEffectFiles(entry);
 expect(wire).not.toBeNull();if(!wire)return;
 expect(wire.length).toBeLessThanOrEqual(EFFECT_WIRE_LIMIT);
 const decoded=decodeEffectFiles(wire);expect(decoded).not.toBeNull();
 expect(Buffer.from(decoded!.get("worker.js")!).toString()).toBe(code);
 const invalid=files();invalid.set("file.html",Buffer.from("x"));expect(encodeEffectFiles(invalid)).toBeNull();
});
it.each([
 Buffer.from("not json"),Buffer.from([0xff]),Buffer.from("{}"),Buffer.from("[]"),Buffer.alloc(EFFECT_WIRE_LIMIT+1,32),
 Buffer.from(JSON.stringify([{path:"worker.js",data_b64:"@@@@"},{path:"effect.json",data_b64:"e30="}])),
 Buffer.from(JSON.stringify([{path:"worker.js",data_b64:"AAAA",extra:"bad"},{path:"effect.json",data_b64:"e30="}])),
 Buffer.from(JSON.stringify([{path:"worker.js",data_b64:"AAAA"},{path:"worker.js",data_b64:"AAAA"}])),
])("refuses malformed/oversized transport %#",bytes=>{expect(decodeEffectFiles(bytes)).toBeNull();});
it("sends each bounded part only after the previous acknowledgement and carries no path",async()=>{
 const source=files("// big\n"+"a".repeat(700000)), chunks:Buffer[]=[], packets:Record<string,unknown>[]=[];let finished=false;
 const answer=await sendEffectInParts(source,async args=>{
  packets.push(args);expect(Object.keys(args).sort()).toEqual(["data_b64","part"]);
  expect(Buffer.byteLength(JSON.stringify(args))).toBeLessThan(512*1024);
  const p=args.part as {index:number;count:number;bytes:number;sha256:string;upload?:string};
  expect(p.index).toBe(chunks.length);if(p.index>0)expect(p.upload).toBe("owned-upload");
  chunks.push(Buffer.from(args.data_b64 as string,"base64"));
  if(p.index<p.count-1){await Promise.resolve();return {upload:"owned-upload"};}
  const wire=Buffer.concat(chunks);expect(wire.length).toBe(p.bytes);expect(createHash("sha256").update(wire).digest("hex")).toBe(p.sha256);
  expect(decodeEffectFiles(wire)).not.toBeNull();finished=true;return {id:"ok"};
 });
 expect(finished).toBe(true);expect(packets.length).toBeGreaterThan(1);expect(answer).toEqual({id:"ok"});
});
it("stops immediately on rejection or missing upload ownership",async()=>{
 const send=vi.fn(async()=>({error:"locked"}));expect(await sendEffectInParts(files("a".repeat(700000)),send)).toEqual({error:"locked"});expect(send).toHaveBeenCalledTimes(1);
 const missing=vi.fn(async()=>({}));expect(await sendEffectInParts(files("a".repeat(700000)),missing)).toMatchObject({error:"upload"});expect(missing).toHaveBeenCalledTimes(1);
 const invalid=vi.fn(async()=>({}));expect(await sendEffectInParts(new Map(),invalid)).toEqual({error:"invalid_effect"});expect(invalid).not.toHaveBeenCalled();
});

it("receives through the real sender exactly once and fences the caller/part/digest",async()=>{
 const {EffectUploads}=await import("../src/web-effect-upload.js");
 const receiver=new EffectUploads(), done=vi.fn(()=>({id:"stored"}));
 const answer=await sendEffectInParts(files("a".repeat(700000)),async args=>receiver.accept("own",args,done));
 expect(answer).toEqual({id:"stored"});expect(done).toHaveBeenCalledTimes(1);
 const packets:Record<string,unknown>[]=[];
 await sendEffectInParts(files("a".repeat(700000)),async args=>{packets.push(args);return {upload:"dummy"};});
 const first=receiver.accept("own",packets[0]!,done);expect(first.upload).toEqual(expect.any(String));
 const second={...packets[1],part:{...(packets[1]!.part as object),upload:first.upload}};
 expect(receiver.accept("other",second,done)).toEqual({error:"effect_upload"});
 expect(receiver.accept("own",{...second,part:{...(second.part as object),upload:"wrong"}},done)).toEqual({error:"effect_upload"});
 expect(done).toHaveBeenCalledTimes(1);
});
it("expires an upload at the monotonic deadline, and forget revokes it",async()=>{
 const {EffectUploads}=await import("../src/web-effect-upload.js");let now=0;
 const receiver=new EffectUploads(()=>now), done=vi.fn(()=>({id:"ok"})),packets:Record<string,unknown>[]=[];
 await sendEffectInParts(files("a".repeat(700000)),async args=>{packets.push(args);return {upload:"dummy"};});
 const first=receiver.accept("own",packets[0]!,done);now=60000;
 expect(receiver.accept("own",{...packets[1],part:{...(packets[1]!.part as object),upload:first.upload}},done)).toEqual({error:"effect_upload"});
 now=60000;const next=receiver.accept("own",packets[0]!,done);receiver.forget("own");
 expect(receiver.accept("own",{...packets[1],part:{...(packets[1]!.part as object),upload:next.upload}},done)).toEqual({error:"effect_upload"});
 expect(done).not.toHaveBeenCalled();
});
it("rejects malformed parts, mismatched digests and every proposed path or target",async()=>{
 const {EffectUploads}=await import("../src/web-effect-upload.js");
 const receiver=new EffectUploads(),done=vi.fn(()=>({id:"ok"})),packets:Record<string,unknown>[]=[];
 await sendEffectInParts(files(),async args=>{packets.push(args);return {id:"ok"};});
 const good=packets[0]!;
 for(const patch of [{dir:"/private"},{instance:"other"},{holder:"mod:anything"},{data_b64:"!!!!"},{part:{...(good.part as object),sha256:"0".repeat(64)}},{part:{...(good.part as object),count:2}},{part:{...(good.part as object),extra:true}}])expect(receiver.accept("own",{...good,...patch},done).error).toEqual(expect.any(String));
 expect(done).not.toHaveBeenCalled();
 expect(receiver.accept("own",good,done)).toEqual({id:"ok"});
 expect(new EffectUploads(()=>NaN).accept("own",good,done)).toEqual({error:"clock_unavailable"});
});
it("caps physically retained uploads and permits one owner's replacement",async()=>{
 const {EffectUploads}=await import("../src/web-effect-upload.js");
 const receiver=new EffectUploads(),done=vi.fn(()=>({id:"ok"})),packets:Record<string,unknown>[]=[];
 await sendEffectInParts(files("a".repeat(700000)),async args=>{packets.push(args);return {upload:"dummy"};});
 for(let i=0;i<32;i++)expect(receiver.accept("own"+i,packets[0]!,done).upload).toEqual(expect.any(String));
 expect(receiver.accept("new",packets[0]!,done)).toEqual({error:"effect_upload_full"});
 expect(receiver.accept("own0",packets[0]!,done).upload).toEqual(expect.any(String));
 receiver.forget("own0");expect(receiver.accept("new",packets[0]!,done).upload).toEqual(expect.any(String));
 expect(done).not.toHaveBeenCalled();
});
it("bounds the bytes actually retained across active owners",async()=>{
 const {EffectUploads,EFFECT_UPLOAD_MEMORY}=await import("../src/web-effect-upload.js");
 const {ASSET_PART_BYTES}=await import("../src/web-asset-parts.js");
 const receiver=new EffectUploads(),done=vi.fn(()=>({})),tokens:string[]=[],bytes=EFFECT_WIRE_LIMIT,count=Math.ceil(bytes/ASSET_PART_BYTES),data_b64=Buffer.alloc(ASSET_PART_BYTES,32).toString("base64");
 let accepted=0,rejected=false;
 for(let index=0;index<10&&!rejected;index++)for(let owner=0;owner<32;owner++){
  const answer=receiver.accept("memory"+owner,{data_b64,part:{index,count,bytes,sha256:"0".repeat(64),...(index?{upload:tokens[owner]}:{})}},done);
  if(answer.error){expect(answer.error).toBe("effect_upload_full");expect((accepted+1)*ASSET_PART_BYTES).toBeGreaterThan(EFFECT_UPLOAD_MEMORY);rejected=true;break;}
  tokens[owner]=answer.upload as string;accepted++;
 }
 expect(rejected).toBe(true);expect(accepted*ASSET_PART_BYTES).toBeLessThanOrEqual(EFFECT_UPLOAD_MEMORY);expect(done).not.toHaveBeenCalled();
});

it.each(["rollback", "negative", "nonfinite", "throw"])("revokes all partial bytes on an unavailable monotonic clock: %s", async fault=>{
 const {EffectUploads}=await import("../src/web-effect-upload.js");let now=100,throws=false;
 const receiver=new EffectUploads(()=>{if(throws)throw Error("clock");return now;}),done=vi.fn(()=>({id:"ok"})),packets:Record<string,unknown>[]=[];
 await sendEffectInParts(files("a".repeat(700000)),async args=>{packets.push(args);return {upload:"dummy"};});
 const first=receiver.accept("own",packets[0]!,done);expect(first.upload).toEqual(expect.any(String));
 if(fault==="throw")throws=true;else now=fault==="rollback"?99:fault==="negative"?-1:NaN;
 expect(receiver.accept("other",packets[0]!,done)).toEqual({error:"clock_unavailable"});
 throws=false;now=101;
 expect(receiver.accept("own",{...packets[1],part:{...(packets[1]!.part as object),upload:first.upload}},done)).toEqual({error:"effect_upload"});
 expect(done).not.toHaveBeenCalled();
});
