/** Exact runner proof on synthetic local state only. Never opens a provider home or CLI. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,symlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID,createHash } from "node:crypto";
import { nativeCodexSessionState } from "../src/runtime-pane-transcript.js";
const cleanup:string[]=[];afterEach(()=>{vi.restoreAllMocks();for(const p of cleanup.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"codex-proof-"));cleanup.push(root);const cwd=join(root,"cwd"),codex=join(root,"codex"),id=randomUUID();mkdirSync(cwd);mkdirSync(codex);
 const active=join(codex,"sessions","2026","11","04"),archive=join(codex,"archived_sessions");mkdirSync(active,{recursive:true});mkdirSync(archive);
 const dbPath=join(codex,"state_5.sqlite"),db=new DatabaseSync(dbPath);db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY)");db.close();
 const path=join(active,`rollout-2026-11-04T00-00-00-${id}.jsonl`),meta=JSON.stringify({type:"session_meta",payload:{id,cwd}})+"\n";
 return{root,cwd,codex,id,active,archive,dbPath,path,meta,proof:(current=()=>true)=>nativeCodexSessionState(cwd,id,current,{codex,claude:join(root,"unused")})};}
it("completed exact absence proves absent without writing the DB or creating sidecars",async()=>{const f=fixture(),before=readFileSync(f.dbPath),files=readdirSync(f.codex);expect(await f.proof()).toBe("absent");expect(readFileSync(f.dbPath)).toEqual(before);expect(readdirSync(f.codex)).toEqual(files);});
it("a valid active rollout proves saved only after discovery completes",async()=>{const f=fixture();for(let n=0;n<140;n++)writeFileSync(join(f.active,`rollout-other-${n}-${randomUUID()}.jsonl`),"unrelated");writeFileSync(f.path,f.meta);expect(await f.proof()).toBe("saved");});
it.each(["archive","duplicate","wrong-cwd","wrong-id","empty","malformed","link"])("%s cannot prove missing or saved",async kind=>{const f=fixture();if(kind==="archive")writeFileSync(join(f.archive,`rollout-${f.id}.jsonl`),f.meta);
 else if(kind==="link"){const other=join(f.root,"other");writeFileSync(other,f.meta);symlinkSync(other,f.path);}
 else{writeFileSync(f.path,kind==="empty"?"":kind==="malformed"?"{\n":kind==="wrong-cwd"||kind==="wrong-id"?JSON.stringify({type:"session_meta",payload:{id:kind==="wrong-id"?randomUUID():f.id,cwd:kind==="wrong-cwd"?f.root:f.cwd}})+"\n":f.meta);if(kind==="duplicate")writeFileSync(join(f.active,`rollout-second-${f.id}.jsonl`),f.meta);}
 expect(await f.proof()).toBe("unknown");});
it.each(["row","index","wal","schema","corrupt","future-db"])("stale/unsafe %s evidence stays unknown",async kind=>{const f=fixture();if(kind==="row"){const db=new DatabaseSync(f.dbPath);db.prepare("INSERT INTO threads VALUES(?)").run(f.id);db.close();}
 if(kind==="index")writeFileSync(join(f.codex,"session_index.jsonl"),JSON.stringify({id:f.id,title:"stale"})+"\n");
 if(kind==="wal")writeFileSync(f.dbPath+"-wal","uncheckpointed");if(kind==="schema"){const db=new DatabaseSync(f.dbPath);db.exec("DROP TABLE threads");db.close();}
 if(kind==="corrupt")writeFileSync(f.dbPath,"not sqlite");if(kind==="future-db")writeFileSync(join(f.codex,"state_6.sqlite"),"unsupported");
 const hash=()=>createHash("sha256").update(readFileSync(f.dbPath)).digest("hex"),before=hash();expect(await f.proof()).toBe("unknown");expect(hash()).toBe(before);});
it("a revoked or expired proof cannot manufacture absence",async()=>{const f=fixture();expect(await f.proof(()=>false)).toBe("unknown");let now=0;vi.spyOn(performance,"now").mockImplementation(()=>now+=700);expect(await f.proof()).toBe("unknown");});
it("an unsafe date directory is unknown even when it contains no matching filename",async()=>{const f=fixture(),outside=join(f.root,"elsewhere");mkdirSync(outside);symlinkSync(outside,join(f.codex,"sessions","2027"),"dir");expect(await f.proof()).toBe("unknown");});
it("a completed absence proof rejects a WAL created after the immutable query",async()=>{const f=fixture();const mod=await import("../src/runtime-pane-codex-index.js");vi.spyOn(mod,"codexIndexHasNoThread").mockImplementation(async()=>{writeFileSync(f.dbPath+"-wal","changed");return true;});expect(await f.proof()).toBe("unknown");});
it("a partial walk cannot become absence when its entry bound is exceeded",async()=>{const f=fixture();for(let n=0;n<16385;n++)writeFileSync(join(f.active,`unrelated-${n}`),"");vi.spyOn(performance,"now").mockReturnValue(0);expect(await f.proof()).toBe("unknown");});
