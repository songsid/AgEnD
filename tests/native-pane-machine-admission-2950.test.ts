/** Mixed pane/exec reservations; no spawned processes and no account calls. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WindowsAgents } from "../src/windows-agents.js";
import { setConfiguredRuntimeSwitches } from "../src/runtime-switches.js";
const dirs:string[]=[];
afterEach(()=>{setConfiguredRuntimeSwitches({});for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){const dir=mkdtempSync(join(tmpdir(),"agend-native-limit-"));dirs.push(dir);const start=vi.fn((task:any)=>({...task,id:task.requestId,status:"working",output:"",startedAt:1}));const bridge:any={start,get:()=>null,prepareWorkspace:vi.fn()};return{dir,start,bridge,store:new WindowsAgents(dir,bridge)};}
async function agent(f:ReturnType<typeof fixture>,machineId?:string){return f.store.create({name:randomUUID(),cwd:"C:\\scratch",sandbox:"read-only",...(machineId?{machineId}:{})});}
it("default permits four persistent agents on each machine rather than one fleet-wide slot",async()=>{
 const f=fixture(),machine=randomUUID();for(const id of [undefined,machine])for(let n=0;n<4;n++){const a=await agent(f,id);f.store.reservePane(a.id,randomUUID());}
 for(const id of [undefined,machine]){const a=await agent(f,id);expect(()=>f.store.reservePane(a.id,randomUUID())).toThrow("concurrent agent limit");expect(f.store.get(a.id).activeId).toBeUndefined();}expect(f.start).not.toHaveBeenCalled();
});
it("unknown exec and pane owners occupy the same per-machine cap across coordinator recreation",async()=>{
 const f=fixture();setConfiguredRuntimeSwitches({max_agents_per_machine:2});const a=await agent(f),b=await agent(f),c=await agent(f);f.store.send(a.id,{requestId:randomUUID(),prompt:"exec"},()=>true);f.store.reservePane(b.id,randomUUID());
 const restored=new WindowsAgents(f.dir,f.bridge);expect(()=>restored.reservePane(c.id,randomUUID())).toThrow("concurrent agent limit");expect(()=>restored.send(c.id,{requestId:randomUUID(),prompt:"exec"},()=>true)).toThrow("concurrent agent limit");expect(f.start).toHaveBeenCalledOnce();expect(restored.get(c.id).turns).toEqual([]);
});
it("lowering the live limit holds only new starts and preserves exact reattach reservations",async()=>{
 const f=fixture(),a=await agent(f),b=await agent(f),c=await agent(f),launch=randomUUID();f.store.reservePane(a.id,launch);f.store.reservePane(b.id,randomUUID());setConfiguredRuntimeSwitches({max_agents_per_machine:1});
 expect(()=>f.store.reservePane(a.id,launch)).not.toThrow();expect(f.store.get(b.id).activeId).toBeDefined();expect(()=>f.store.reservePane(c.id,randomUUID())).toThrow("concurrent agent limit");setConfiguredRuntimeSwitches({max_agents_per_machine:3});expect(()=>f.store.reservePane(c.id,randomUUID())).not.toThrow();
});
it("two admissions without an await reserve synchronously and cannot both pass the final slot",async()=>{
 const f=fixture();setConfiguredRuntimeSwitches({max_agents_per_machine:1});const a=await agent(f),b=await agent(f);f.store.reservePane(a.id,randomUUID());expect(()=>f.store.send(b.id,{requestId:randomUUID(),prompt:"exec"},()=>true)).toThrow("concurrent agent limit");expect(f.start).not.toHaveBeenCalled();
});
