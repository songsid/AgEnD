/** #1629 CW1: agent-side directory snapshot and bounded multipart transport. No fleet opens a workspace path. */
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { agentFileScope, readAgentFile, type AgentFileContext } from "./agent-file-read.js";
import { checkEffectEntry } from "./web-effect-bundle.js";
import { ASSET_PART_BYTES } from "./web-asset-parts.js";

// Room for base64-wrapped raw metadata; CW1 still limits normalized entries to one MiB.
export const EFFECT_WIRE_LIMIT = 12 * 1024 * 1024;
export const EFFECT_UPLOAD_MEMORY = 64 * 1024 * 1024;
export const EFFECT_UPLOAD_IDLE_MS = 60_000;
const ROOT_FILES = new Set(["effect.json", "worker.js", "poster.png", "cursor.png"]);
const ASSET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}\.(?:png|jpe?g|webp|gif)$/;
const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
export type EffectRead = { ok: true; files: ReadonlyMap<string, Uint8Array> } | { ok: false; reason: string };

/** All paths and bounded reads are on the agent's side. A partial/changed directory is revalidated as one CW1 entry. */
export async function readAgentEffect(dir: unknown, opts: AgentFileContext): Promise<EffectRead> {
  if (typeof dir !== "string" || !dir.trim() || dir.includes("\0") || !opts.workspace) return { ok:false, reason:"an effect directory in your working directory" };
  try {
    const named=isAbsolute(dir)?dir:resolve(opts.workspace,dir), info=await lstat(named);
    if (!info.isDirectory() || info.isSymbolicLink()) return {ok:false,reason:"not a plain directory"};
    const root=await realpath(named), scope=await agentFileScope(opts), workspace=scope.workspace;
    if (!under(root,workspace) || scope.stateBlocked(root)) return {ok:false,reason:"outside the workspace or inside AgEnD state"};
    const paths:string[]=[];
    const directory=await opendir(root);
    for await (const entry of directory) {
      if (ROOT_FILES.has(entry.name) && entry.isFile()) paths.push(entry.name);
      else if (entry.name==="assets" && entry.isDirectory()) {
        const assets=await opendir(join(root,"assets")); let count=0;
        for await (const asset of assets) {
          if (++count>16 || !asset.isFile() || !ASSET_NAME.test(asset.name)) return {ok:false,reason:"at most sixteen plain raster assets"};
          paths.push("assets/"+asset.name);
        }
      } else return {ok:false,reason:"unsupported effect directory entry"};
      if (paths.length>20) return {ok:false,reason:"too many effect files"};
    }
    const files=new Map<string,Uint8Array>(); let remaining=8*1024*1024;
    for (const path of paths.sort()) {
      const read=await readAgentFile(join(root,path),{...opts,maxBytes:remaining});
      if (!read.ok) return read;
      remaining-=read.bytes.length; files.set(path,read.bytes);
    }
    // This is preparation only. The receiving fleet validates again before any claim or limiter record.
    const checked=checkEffectEntry(files);
    return checked.ok?{ok:true,files:checked.files}:{ok:false,reason:"invalid CW1 effect entry"};
  } catch { return {ok:false,reason:"cannot read effect directory"}; }
}

/** The one transport representation; normalized entries only, no directory path, caller or holder. */
export function encodeEffectFiles(files: ReadonlyMap<string,Uint8Array>): Buffer | null {
  const checked=checkEffectEntry(files);
  if (!checked.ok) return null;
  const bytes=Buffer.from(JSON.stringify([...checked.files].map(([path,data])=>({path,data_b64:Buffer.from(data).toString("base64")}))));
  return bytes.length<=EFFECT_WIRE_LIMIT?bytes:null;
}
export function decodeEffectFiles(bytes: Uint8Array): ReadonlyMap<string,Uint8Array> | null {
  if (bytes.byteLength>EFFECT_WIRE_LIMIT) return null;
  try {
    const value:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    if (!Array.isArray(value) || value.length<2 || value.length>20) return null;
    const files=new Map<string,Uint8Array>(); let total=0;
    for (const entry of value) {
      if (!entry || typeof entry!=="object" || Object.keys(entry).sort().join(",")!=="data_b64,path" || typeof entry.path!=="string" || files.has(entry.path) || typeof entry.data_b64!=="string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data_b64)) return null;
      const data=Buffer.from(entry.data_b64,"base64");total+=data.length;
      if (total>8*1024*1024) return null;
      files.set(entry.path,data);
    }
    const checked=checkEffectEntry(files);
    return checked.ok?checked.files:null;
  } catch { return null; }
}

/** Every part fits the existing endpoint/IPC limit; a part is acknowledged before the next is sent. */
export async function sendEffectInParts(files: ReadonlyMap<string,Uint8Array>, send: (args:Record<string,unknown>)=>Promise<Record<string,unknown>>): Promise<Record<string,unknown>> {
  const all=encodeEffectFiles(files);
  if (!all) return {error:"invalid_effect"};
  const sha256=createHash("sha256").update(all).digest("hex"), count=Math.ceil(all.length/ASSET_PART_BYTES);
  let upload:string|undefined, answer:Record<string,unknown>={};
  for(let index=0;index<count;index++) {
    answer=await send({data_b64:all.subarray(index*ASSET_PART_BYTES,(index+1)*ASSET_PART_BYTES).toString("base64"),part:{index,count,bytes:all.length,sha256,...(upload?{upload}:{})}});
    if (typeof answer.error==="string" || Array.isArray(answer.errors)) return answer;
    if (index<count-1) { if (typeof answer.upload!=="string") return {error:"upload",message:"The fleet did not accept the upload part."}; upload=answer.upload; }
  }
  return answer;
}

interface PendingEffectUpload { id:string; count:number; next:number; bytes:number; sha256:string; received:number; chunks:Buffer[]; last:number }
/** Receiving side: caller identity comes from IPC/session, never the part's fields. No filesystem path is accepted. */
export class EffectUploads {
  private readonly pending=new Map<string,PendingEffectUpload>();
  private lastClock: number | null = null;
  constructor(private readonly clock:()=>number=()=>performance.now()) {}
  forget(instance:string):void { this.pending.delete(instance); }
  accept(instance:string,args:Record<string,unknown>,complete:(files:ReadonlyMap<string,Uint8Array>)=>Record<string,unknown>):Record<string,unknown> {
    const fail=(error:string)=>{this.pending.delete(instance);return {error};};
    let now: number;
    try { now = this.clock(); } catch { this.pending.clear(); return {error:"clock_unavailable"}; }
    if (!Number.isFinite(now) || now < 0 || this.lastClock !== null && now < this.lastClock) { this.pending.clear(); return {error:"clock_unavailable"}; }
    this.lastClock = now;
    for(const [name,p] of this.pending)if(now-p.last>=EFFECT_UPLOAD_IDLE_MS)this.pending.delete(name);
    if(!args || typeof args !== "object" || Array.isArray(args)) return fail("effect_part");
    if(Object.keys(args).sort().join(",")!=="data_b64,part" || typeof args.data_b64!=="string" || args.data_b64.length>Math.ceil(ASSET_PART_BYTES/3)*4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.data_b64)) return fail("effect_part");
    const raw=args.part;
    if(!raw || typeof raw!=="object" || Array.isArray(raw))return fail("effect_part");
    const p=raw as Record<string,unknown>,keys=Object.keys(p).sort().join(",");
    if(keys!=="bytes,count,index,sha256" && keys!=="bytes,count,index,sha256,upload")return fail("effect_part");
    if(!Number.isSafeInteger(p.index)||!Number.isSafeInteger(p.count)||!Number.isSafeInteger(p.bytes)||typeof p.sha256!=="string"||!/^[0-9a-f]{64}$/.test(p.sha256))return fail("effect_part");
    const index=p.index as number,count=p.count as number,bytes=p.bytes as number;
    if(bytes<1||bytes>EFFECT_WIRE_LIMIT||count!==Math.ceil(bytes/ASSET_PART_BYTES)||index<0||index>=count)return fail("effect_part");
    const chunk=Buffer.from(args.data_b64,"base64");
    if(chunk.toString("base64")!==args.data_b64||chunk.length!==(index<count-1?ASSET_PART_BYTES:bytes-index*ASSET_PART_BYTES))return fail("effect_part");
    if(index===0) {
      if(p.upload!==undefined)return fail("effect_part");
      if(!this.pending.has(instance)&&this.pending.size>=32)return fail("effect_upload_full");
      this.pending.set(instance,{id:randomBytes(16).toString("hex"),count,next:0,bytes,sha256:p.sha256,received:0,chunks:[],last:now});
    }
    const up=this.pending.get(instance);
    if(!up || (index!==0&&p.upload!==up.id) || index!==up.next || bytes!==up.bytes||count!==up.count||p.sha256!==up.sha256)return fail("effect_upload");
    if ([...this.pending.values()].reduce((n,p)=>n+p.received,chunk.length)>EFFECT_UPLOAD_MEMORY)return fail("effect_upload_full");
    up.chunks.push(chunk);up.received+=chunk.length;up.next++;up.last=now;
    if(up.next<up.count)return {upload:up.id,received:up.received};
    this.pending.delete(instance);
    const all=Buffer.concat(up.chunks);
    if(all.length!==up.bytes||createHash("sha256").update(all).digest("hex")!==up.sha256)return {error:"effect_digest"};
    const files=decodeEffectFiles(all);
    return files?complete(files):{error:"invalid_effect"};
  }
}
