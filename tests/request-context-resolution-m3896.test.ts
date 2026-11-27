import Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it} from "vitest";
import {activateRequestContextBarrier,assertRequestContextCompatibility,registerRequestContextDispatcher} from "../src/request-context-compatibility.js";
import {decodeRequestContextResolution,readRequestContextResolution,writeRequestContextResolution,type RequestContextResolution} from "../src/request-context-resolution.js";
import {requestContextDigest} from "../src/request-context-store.js";
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function rig(){
 const home=mkdtempSync(join(tmpdir(),"resolution-m3896-")),path=join(home,"box.db"),db=new Database(path);
 cleanup.push(()=>rmSync(home,{recursive:true,force:true}),()=>db.close());
 db.exec("CREATE TABLE deliveries(id TEXT);CREATE TABLE delivery_attempts(id TEXT);CREATE TABLE other_rows(id TEXT);CREATE TABLE request_context_drain_v1(root_id TEXT PRIMARY KEY,epoch TEXT NOT NULL,owner TEXT NOT NULL)");
 registerRequestContextDispatcher(db,1);activateRequestContextBarrier(db,1);
 const value:RequestContextResolution={version:1,rootId:randomUUID(),fenceEpoch:randomUUID(),owner:"fleet",ownerBinding:"a".repeat(64),blockerSha256:"b".repeat(64),closedAt:1,
  receipts:[{receiptId:randomUUID(),inputSha256:"c".repeat(64),receiptSha256:"d".repeat(64)}]};
 db.prepare("INSERT INTO request_context_drain_v1 VALUES (?,?,?)").run(value.rootId,value.fenceEpoch,value.owner);
 const write=()=>db.transaction(()=>writeRequestContextResolution(db,value))();
 return {home,path,db,value,write};
}
it("the published beta.27 reader opens never-abandoned v1 and refuses the eighth guard",async()=>{
 const f=rig(),fixture=new URL("./fixtures/request-context-resolution-m3896/beta27-reader.mjs",import.meta.url).href;
 const legacy=await import(fixture);
 expect(legacy.assertRequestContextCompatibility(f.db,1)).toBe("active");
 expect(readRequestContextResolution(f.db,f.value.rootId)).toBeNull();
 f.write();expect(()=>legacy.assertRequestContextCompatibility(f.db,1)).toThrow(/guard set/);
 expect(assertRequestContextCompatibility(f.db,1)).toBe("active");expect(readRequestContextResolution(f.db,f.value.rootId)).toEqual(f.value);
});
it("functionless connections still read, back up and write unrelated tables",async()=>{
 const f=rig();f.write();const bare=new Database(f.path);cleanup.push(()=>bare.close());
 expect(bare.prepare("SELECT count(*) n FROM request_context_drain_v1").get()).toEqual({n:1});
 bare.prepare("INSERT INTO other_rows VALUES (?)").run("safe unrelated write");
 await bare.backup(join(f.home,"backup.db"));
 const backup=new Database(join(f.home,"backup.db"),{readonly:true});try{expect(backup.prepare("SELECT * FROM other_rows").all()).toEqual([{id:"safe unrelated write"}]);}finally{backup.close();}
 expect(()=>bare.prepare("UPDATE request_context_drain_v1 SET owner='different'").run()).toThrow(/function/);
});
it("the guard remains after collection of every resolution, so old binaries never reopen the home",async()=>{
 const f=rig();f.write();f.db.prepare("DELETE FROM request_context_drain_v1").run();
 const fixture=new URL("./fixtures/request-context-resolution-m3896/beta27-reader.mjs",import.meta.url).href,legacy=await import(fixture);
 expect(()=>legacy.assertRequestContextCompatibility(f.db,1)).toThrow(/guard set/);
 expect(assertRequestContextCompatibility(f.db,1)).toBe("active");
});
it("rollback before commit leaves the old v1 shape, and committed replay is exact",()=>{
 const f=rig();expect(()=>f.db.transaction(()=>{writeRequestContextResolution(f.db,f.value);throw Error("crash-before-commit");})()).toThrow(/crash/);
 expect((f.db.pragma("table_info(request_context_drain_v1)") as Array<{name:string}>).map(row=>row.name)).toEqual(["root_id","epoch","owner"]);
 f.write();f.write();expect(readRequestContextResolution(f.db,f.value.rootId)).toEqual(f.value);
 expect(()=>f.db.transaction(()=>writeRequestContextResolution(f.db,{...f.value,closedAt:2}))()).toThrow(/changed/);
});
it("strict bounded images refuse unknown versions, duplicate keys, digests and malformed records",()=>{
 const f=rig(),raw=JSON.stringify(f.value),digest=requestContextDigest(f.value);
 expect(decodeRequestContextResolution(raw,digest)).toEqual(f.value);
 for(const bad of [{...f.value,version:2},{...f.value,extra:true},{...f.value,receipts:[...f.value.receipts,...f.value.receipts]}])
  expect(()=>decodeRequestContextResolution(JSON.stringify(bad),requestContextDigest(bad))).toThrow();
 expect(()=>decodeRequestContextResolution(raw.replace('"version":1','"version":1,"version":1'),digest)).toThrow();
 expect(()=>decodeRequestContextResolution(" ".repeat(32769)+raw,digest)).toThrow();
 expect(()=>decodeRequestContextResolution(raw,"e".repeat(64))).toThrow();
});
