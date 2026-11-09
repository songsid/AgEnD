import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentService, readSubagentFile, type SubagentSource } from "../src/subagent-service.js";
import { subagentFixture } from "./helpers/subagent-fixtures.js";
const dirs: string[] = [];
const deferred = <T>() => { let resolve!: (v:T)=>void; const promise = new Promise<T>(r=>resolve=r); return { promise, resolve }; };
// Filesystem positives use an explicit deadline clock; only the deadline case advances it.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true}))); });
async function rig() {
 const root = await mkdtemp(join(tmpdir(),"agend-subagents-")); dirs.push(root);
 const f = subagentFixture("claude-code"), path = join(root, f.sessionId+".jsonl");
 await writeFile(path, f.parent.map(r=>JSON.stringify(r)).join("\n")+"\n");
 const childDir=join(root,f.sessionId,"subagents"); await mkdir(childDir,{recursive:true});
 for(const [id,c] of f.children) { await writeFile(join(childDir,`agent-${id}.jsonl`), c.records.map(r=>JSON.stringify(r)).join("\n")+"\n"); await writeFile(join(childDir,`agent-${id}.meta.json`),JSON.stringify(c.meta)); }
 const source: SubagentSource={backend:f.backend,sessionId:f.sessionId,cwd:f.cwd,path,root,owner:"generation-1"};
 return {source,f};
}
describe("bounded optional sub-Agent filesystem observation",()=>{
 it("reads real parent/child files and only caches the current owner",async()=>{
  const {source,f}=await rig(); let owner=source; const read=vi.fn(readSubagentFile); let now=f.now;
  const s=new SubagentService(()=>owner,read,()=>now);
  expect((await s.read("dev")).runs.map(r=>r.state)).toEqual(["completed","completed"]);
  const calls=read.mock.calls.length; await s.read("dev"); expect(read).toHaveBeenCalledTimes(calls);
  owner={...source,owner:"generation-2"}; await s.read("dev"); expect(read.mock.calls.length).toBeGreaterThan(calls);
  now+=2001; await s.read("dev"); expect(read.mock.calls.length).toBeGreaterThan(calls*2);
 });
 it("refuses outside-root files and symlinks at both file and directory boundaries",async()=>{
  const {source}=await rig(); const outside=await mkdtemp(join(tmpdir(),"agend-subagent-outside-"));dirs.push(outside);
  await writeFile(join(outside,"data"),"secret");
  await symlink(join(outside,"data"),join(source.root,"link")); await symlink(outside,join(source.root,"nested"));
  expect(await readSubagentFile(source.root,join(outside,"data"))).toBeNull();
  expect(await readSubagentFile(source.root,join(source.root,"link"))).toBeNull();
  expect(await readSubagentFile(source.root,join(source.root,"nested/data"))).toBeNull();
  expect(await readSubagentFile(source.root,source.path,8)).toBeNull();
  expect(await readSubagentFile(source.root,source.root)).toBeNull();
 });
 it("keeps partial parent data unavailable and missing/partial children unconfirmed",async()=>{
  const {source}=await rig(); const s=new SubagentService(()=>source);
  await writeFile(source.path,'{"incomplete":'); expect((await s.read("dev")).status).toBe("unavailable");
  const f=subagentFixture("claude-code"); await writeFile(source.path,f.parent.map(r=>JSON.stringify(r)).join("\n")+"\n");
  await writeFile(join(source.root,source.sessionId,"subagents/agent-ab5b36ac3f402d58b.meta.json"),'{');
  expect((await s.read("dev")).runs.map(r=>r.state)).toEqual(["unknown","completed"]);
 });
 it.each(["claude-code", "codex"] as const)("reads recent %s launch evidence from a mature parent without reading the whole file",async backend=>{
  const {source:old}=await rig(),f=subagentFixture(backend),root=join(old.root,"mature"),day=backend==="codex"?join(root,"2026/11/09"):root;await mkdir(day,{recursive:true});
  const path=join(day,backend==="codex"?`rollout-2026-11-09T15-18-16-${f.sessionId}.jsonl`:f.sessionId+".jsonl");
  const noise=JSON.stringify({padding:"x".repeat(4096)})+"\n",parent=JSON.stringify(f.parent[0])+"\n"+noise.repeat(800)+f.parent.map(r=>JSON.stringify(r)).join("\n")+"\n";await writeFile(path,parent);
  expect(await readSubagentFile(root,path)).toBeNull();const tail=await readSubagentFile(root,path,2*1024*1024,true);expect(Buffer.byteLength(tail!)).toBeLessThanOrEqual(2*1024*1024);expect(tail).toContain(f.sessionId);
  for(const[id,c]of f.children){const child=backend==="codex"?join(day,`rollout-2026-11-09T15-18-36-${id}`):join(root,f.sessionId,"subagents",`agent-${id}`);await mkdir(join(child,".."),{recursive:true});await writeFile(child+".jsonl",c.records.map(r=>JSON.stringify(r)).join("\n")+"\n");if(c.meta)await writeFile(child+".meta.json",JSON.stringify(c.meta));}
  const source={...old,backend:f.backend,root,path,sessionId:f.sessionId,cwd:f.cwd};vi.useFakeTimers();expect((await new SubagentService(()=>source,readSubagentFile,()=>f.now).read("dev")).runs.map(r=>r.state)).toEqual(["completed","completed"]);
  await writeFile(path,JSON.stringify(f.parent[0])+"\n"+noise.repeat(800));expect((await new SubagentService(()=>source,readSubagentFile,()=>f.now).read("dev")).runs).toEqual([]);
 });
 it("drops disclosure if the launch owner changes during an awaited read",async()=>{
  const {source}=await rig(); let current:SubagentSource|null=source;const hold=deferred<string|null>();const entered=deferred<void>();
  const s=new SubagentService(()=>current,async()=>{entered.resolve();return hold.promise;});
  const p=s.read("dev"); await entered.promise;current={...source,owner:"replacement"};hold.resolve("\n");
  expect(await p).toEqual({subagents:1,owner:null,status:"unavailable",runs:[]});
 });
 it("logical deadlines keep the shared physical slots held through read AND cleanup settlement",async()=>{
  const {source}=await rig(); vi.useFakeTimers();
  const readDone=deferred<void>(),closeDone=deferred<void>(),readEntered=deferred<void>(),closeEntered=deferred<void>();
  const reader=vi.fn(async()=>{readEntered.resolve();await readDone.promise;try{return "\n";}finally{closeEntered.resolve();await closeDone.promise;}});
  const a=new SubagentService(()=>source,reader), b=new SubagentService(()=>({...source,owner:"other"}),reader);
  const pa=a.read("a"), same=a.read("a"), pb=b.read("b");await readEntered.promise;
  await vi.advanceTimersByTimeAsync(1000); expect((await pa).status).toBe("unavailable");await same;await pb;
  expect(reader).toHaveBeenCalledTimes(2);
  const thirdRead=vi.fn(async()=>"\n"),third=new SubagentService(()=>({...source,owner:"third"}),thirdRead);
  expect((await third.read("c")).status).toBe("busy");expect(thirdRead).not.toHaveBeenCalled();
  readDone.resolve();await closeEntered.promise;
  expect((await third.read("c")).status).toBe("busy");expect(thirdRead).not.toHaveBeenCalled();
  closeDone.resolve();await vi.advanceTimersByTimeAsync(0);
  expect((await third.read("c")).status).toBe("ok");expect(thirdRead).toHaveBeenCalledTimes(1);
 });
 it("discovers Codex only in bounded parent days and treats duplicate paths as ambiguous",async()=>{
  const {source:old}=await rig(), f=subagentFixture("codex"), root=join(old.root,"sessions"), day=join(root,"2026/11/09"); await mkdir(day,{recursive:true});
  const path=join(day,`rollout-2026-11-09T15-18-16-${f.sessionId}.jsonl`);await writeFile(path,f.parent.map(r=>JSON.stringify(r)).join("\n")+"\n");
  for(const[id,c]of f.children)await writeFile(join(day,`rollout-2026-11-09T15-18-36-${id}.jsonl`),c.records.map(r=>JSON.stringify(r)).join("\n")+"\n");
  const source={...old,backend:f.backend,sessionId:f.sessionId,cwd:f.cwd,path,root};
  expect((await new SubagentService(()=>source,readSubagentFile,()=>f.now).read("dev")).runs.map(r=>r.state)).toEqual(["completed","completed"]);
  const [id,c]=f.children.entries().next().value!;await writeFile(join(day,`rollout-2026-11-09T15-19-36-${id}.jsonl`),c.records.map(r=>JSON.stringify(r)).join("\n")+"\n");
  const duplicate=await new SubagentService(()=>source,readSubagentFile,()=>f.now).read("dev");expect(duplicate.runs.find(r=>r.name==="Descartes")?.state).toBe("unknown");expect(duplicate.runs.find(r=>r.name==="Kant")?.state).toBe("completed");
  await Promise.all(Array.from({length:257},(_,n)=>writeFile(join(day,`unrelated-${n}`),"")));
  expect((await new SubagentService(()=>source,readSubagentFile,()=>f.now).read("dev")).runs.map(r=>r.state)).toEqual(["unknown","unknown"]);
 });
 it("a failed reader returns its physical capacity",async()=>{
  const {source}=await rig(); const failed=new SubagentService(()=>source,async()=>{throw Error("read");});
  for(let n=0;n<3;n++) await expect(failed.read("dev")).rejects.toThrow("read");
  expect((await new SubagentService(()=>source,async()=>"\n").read("dev")).status).toBe("ok");
 });
});
