import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
const fault=vi.hoisted(()=>({limit:Infinity,calls:0,errorAt:Infinity,zeroAt:Infinity}));
vi.mock("node:fs",async importOriginal=>{
 const fs=await importOriginal<typeof import("node:fs")>();
 return {...fs,writeSync:(fd:number,value:string|Uint8Array,offset?:number,length?:number|string,_position?:number|null)=>{
  const bytes=typeof value==="string"?Buffer.from(value,"utf8"):value;
  const start=typeof value==="string"?0:offset??0;
  const count=typeof value==="string"?bytes.byteLength:typeof length==="number"?length:bytes.byteLength-start;
  fault.calls++;
  if(fault.calls>=fault.errorAt)throw Error("injected write error");
  if(fault.calls>=fault.zeroAt)return 0;
  return fs.writeSync(fd,bytes,start,Math.min(count,fault.limit),null);
 }};
});
vi.mock("node:child_process",()=>{const denied=()=>{throw Error("process launch forbidden");};return {spawn:denied,spawnSync:denied,exec:denied,execSync:denied,execFile:denied,execFileSync:denied};});
import {WebEffectLibrary} from "../src/web-effect-library.js";
const roots:string[]=[];
afterEach(()=>{fault.limit=Infinity;fault.calls=0;fault.errorAt=Infinity;fault.zeroAt=Infinity;for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const parent=join(process.cwd(),".artifacts");mkdirSync(parent,{recursive:true});const dir=mkdtempSync(join(parent,"library-io-"));roots.push(dir);return {dir,lib:new WebEffectLibrary(dir)};}
function stage(lib:WebEffectLibrary,code:string){const files=new Map<string,Uint8Array>([["effect.json",Buffer.from(JSON.stringify({v:1,runtime:"canvas-worker-v1",worker:"worker.js",name:"fixture",title:"界面 🌟",regions:["chat"],layer:"behind",wants:[]}))],["worker.js",Buffer.from(code)]]);const s=lib.stage(files,{kind:"agent",id:"owner"});expect(s.ok).toBe(true);if(!s.ok)throw Error(s.error);return s;}
it("drains positive short byte writes before publishing a multibyte index",()=>{
 const {lib}=fixture(),a=stage(lib,"agend.ready()");expect(lib.commit(a.stageId).ok).toBe(true);
 const b=stage(lib,"// second\nagend.ready()");fault.limit=20;fault.calls=0;
 expect(lib.commit(b.stageId).ok).toBe(true);expect(fault.calls).toBeGreaterThan(1);
 expect(lib.read(a.ids[0]!,{kind:"agent",id:"owner"}).ok).toBe(true);
 const result=lib.read(b.ids[0]!,{kind:"agent",id:"owner"});expect(result.ok&&result.entry.manifest.title).toBe("界面 🌟");
});
it.each(["zero","throw"])("preserves the old readable index on short-then-%s",kind=>{
 const {lib}=fixture(),a=stage(lib,"agend.ready()");expect(lib.commit(a.stageId).ok).toBe(true);
 const old=readFileSync(lib.path),b=stage(lib,"// second\nagend.ready()");fault.limit=20;fault.calls=0;
 if(kind==="zero")fault.zeroAt=2;else fault.errorAt=2;
 expect(lib.commit(b.stageId)).toEqual({ok:false,error:"library_write_failed"});
 expect(readFileSync(lib.path).equals(old)).toBe(true);expect(lib.read(a.ids[0]!,{kind:"agent",id:"owner"}).ok).toBe(true);
 expect(lib.read(b.ids[0]!,{kind:"agent",id:"owner"}).ok).toBe(false);
});
