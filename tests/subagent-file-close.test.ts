import {vi,it,expect} from "vitest";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
const control=vi.hoisted(()=>({next:null as null|{entered:()=>void;hold:Promise<void>}}));
vi.mock("node:fs/promises",async original=>{
 const fs=await original<typeof import("node:fs/promises")>();
 return {...fs,open:async(...args:Parameters<typeof fs.open>)=>{
  const handle=await fs.open(...args),pending=control.next;control.next=null;
  if(pending){const close=handle.close.bind(handle);handle.close=async()=>{pending.entered();await pending.hold;await close();};}
  return handle;
 }};
});
import {readSubagentFile} from "../src/subagent-service.js";
it("an actual regular-file read does not settle before its actual close finishes",async()=>{
 const root=await mkdtemp(join(tmpdir(),"agend-subagent-close-"));const file=join(root,"records");await writeFile(file,"owned record\n");
 let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(r=>release=r),closing=new Promise<void>(r=>entered=r);control.next={entered,hold};
 let settled=false;const read=readSubagentFile(root,file).then(v=>{settled=true;return v;});
 try{await closing;await Promise.resolve();expect(settled).toBe(false);release();expect(await read).toBe("owned record\n");}finally{release();await read;await rm(root,{recursive:true,force:true});control.next=null;}
});
