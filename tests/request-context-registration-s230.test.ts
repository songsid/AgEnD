import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {DeliveryOutbox} from "../src/delivery-outbox.js";
import {FleetManager} from "../src/fleet-manager.js";
import {setProcessFleetLock,releaseProcessFleetLock} from "../src/fleet-lock.js";
import {rotateHubAgentIncarnation,hubAgentIncarnationToken} from "../src/hub-agent-incarnation-record.js";
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function rig(){
 const h=mkdtempSync(join(tmpdir(),"work-registration-"));cleanup.push(()=>rmSync(h,{recursive:true,force:true}));
 const record={pid:process.pid,nonce:randomUUID(),createdAt:new Date().toISOString(),role:"fleet" as const},path=join(h,"fleet.lock"),serialized=JSON.stringify(record);
 writeFileSync(path,serialized);setProcessFleetLock({path,record,serialized});cleanup.push(()=>releaseProcessFleetLock());
 const box=new DeliveryOutbox(join(h,"delivery-outbox.db"),"boot",{requestContextDispatchVersion:1,requestContextRelayVersion:1});cleanup.push(()=>box.close());
 box.requestContextInstallation().activate({epoch:"e",owner:"fleet",activatedAt:1,invalidates:[],offeredLatestDeadline:null},{owner:"fleet",current:()=>true},{current:()=>true,release(){}},()=>true,0);
 const entry=rotateHubAgentIncarnation(undefined,"a".repeat(64),false,1),file=join(h,"hub-member","agent-incarnations.json");mkdirSync(join(h,"hub-member"));
 const save=(value:unknown)=>writeFileSync(file,JSON.stringify({worker:value}));save(entry);
 const m:any=Object.create(FleetManager.prototype);Object.assign(m,{dataDir:h,deliveryOutbox:box,requestContextAdmission:{available:()=>false},logger:{warn:vi.fn()},contactGeneration:()=>hubAgentIncarnationToken("worker",JSON.parse(readFileSync(file,"utf8")).worker.id)});
 const retirement={current:()=>true,retired:vi.fn(async()=>true)};
 return {m,box,entry,file,save,retirement};
}
it("durable pending birth is consumed only after work commits and a restart resumes its exact generation",async()=>{
 const r=rig(),first=await r.m.registerRequestContextWork("worker",r.retirement);
 expect(JSON.parse(readFileSync(r.file,"utf8")).worker.requestWork).toBe("registered");
 expect(await r.m.registerRequestContextWork("worker",r.retirement)).toEqual(first);
 (r.box as any).db.prepare("DELETE FROM request_context_work_v1 WHERE instance='worker'").run();
 await expect(r.m.registerRequestContextWork("worker",r.retirement)).rejects.toThrow(/consumed/);
});
it("crash after work commit before marker consumption resumes rather than recreates the work",async()=>{
 const r=rig(),incarnation=hubAgentIncarnationToken("worker",r.entry.id!),first=r.box.requestContextWork.retain({instance:"worker",incarnation,generation:randomUUID()});
 expect(await r.m.registerRequestContextWork("worker",r.retirement)).toEqual(first);expect(JSON.parse(readFileSync(r.file,"utf8")).worker.requestWork).toBe("registered");
});
it("a new incarnation CASes only its recorded predecessor after exact old launch and IPC retirement",async()=>{
 const r=rig(),old=await r.m.registerRequestContextWork("worker",r.retirement),next=rotateHubAgentIncarnation(JSON.parse(readFileSync(r.file,"utf8")).worker,"b".repeat(64),false,2);r.save(next);
 r.retirement.retired.mockResolvedValueOnce(false);await expect(r.m.registerRequestContextWork("worker",r.retirement)).rejects.toThrow(/not retired/);expect(r.box.requestContextWork.read("worker")).toEqual(old);
 const value=await r.m.registerRequestContextWork("worker",r.retirement);expect(value.incarnation).not.toBe(old.incarnation);expect(value.generation).not.toBe(old.generation);
});
it("a lifecycle file change during the retirement await cannot register or consume evidence",async()=>{
 const r=rig();r.retirement.retired.mockImplementationOnce(async()=>{r.save(rotateHubAgentIncarnation(r.entry,"b".repeat(64),false,2));return true;});
 await expect(r.m.registerRequestContextWork("worker",r.retirement)).rejects.toThrow(/not retired/);expect(r.box.requestContextWork.read("worker")).toBeNull();
 expect(JSON.parse(readFileSync(r.file,"utf8")).worker.requestWork).toBe("pending");
});
