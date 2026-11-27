import {appendFileSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {TranscriptMonitor} from "../src/transcript-monitor.js";
import type {TranscriptTurnEvent} from "../src/transcript-turns.js";
const roots:string[]=[];
afterEach(()=>{vi.useRealTimers();for(const home of roots.splice(0))rmSync(home,{recursive:true,force:true});});
function rig(enabled=true){
 vi.useFakeTimers();const startedAt=Date.parse("2026-11-27T00:00:00Z");vi.setSystemTime(startedAt);
 const rows=readFileSync(join(__dirname,"fixtures/claude-2.1.293-idle-submit-flooded.transcript.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
 const home=mkdtempSync(join(tmpdir(),"claude-owned-turn-"));roots.push(home);
 const sessionId=rows.find(row=>row.type==="user").sessionId,path=join(home,sessionId+".jsonl");
 writeFileSync(path,"");const hook={_agendLaunchId:"current-launch",session_id:sessionId,transcript_path:path};
 writeFileSync(join(home,"statusline.json"),JSON.stringify(hook));
 const monitor=new TranscriptMonitor(home,{debug:vi.fn()} as any,null,()=>({id:"current-launch",startedAt}),enabled);
 monitor.setTranscriptPath(path);vi.setSystemTime(startedAt+100);
 const events:TranscriptTurnEvent[]=[];monitor.on("turns",batch=>events.push(...batch));
 const stamp=(row:any)=>({...row,...(row.timestamp?{timestamp:new Date(startedAt+100).toISOString()}:{})});
 return {home,path,hook,monitor,events,rows:rows.map(stamp),append:(row:unknown)=>appendFileSync(path,JSON.stringify(row)+"\n")};
}
it("the owned Claude monitor emits exact user and native duration boundaries only for bound C launches",async()=>{
 const r=rig();for(const row of r.rows)r.append(row);await r.monitor.pollIncrement();
 expect(r.events.map(row=>row.kind)).toEqual(["start","user","end"]);
 const legacy=rig(false);for(const row of legacy.rows)legacy.append(row);await legacy.monitor.pollIncrement();expect(legacy.events).toEqual([]);
});
it("a mismatched launch marker cannot end or promote transcript records",async()=>{
 const r=rig();writeFileSync(join(r.home,"statusline.json"),JSON.stringify({...r.hook,_agendLaunchId:"old-launch"}));
 for(const row of r.rows)r.append(row);await r.monitor.pollIncrement();expect(r.events).toEqual([]);
});
it("reset retracts an open turn and copied old duration cannot end it",async()=>{
 const r=rig();for(const row of r.rows.filter(row=>row.subtype!=="turn_duration"))r.append(row);await r.monitor.pollIncrement();
 expect(r.events.map(row=>row.kind)).toEqual(["start","user"]);
 vi.setSystemTime(Date.now()+100);r.monitor.resetOffset();expect(r.events.at(-1)?.kind).toBe("retract");
 await r.monitor.pollIncrement();await r.monitor.pollIncrement();
 r.append(r.rows.find(row=>row.subtype==="turn_duration"));await r.monitor.pollIncrement();
 expect(r.events.some(row=>row.kind==="end")).toBe(false);
});
it("a partial terminal line is not completion evidence",async()=>{
 const r=rig(),end=r.rows.find(row=>row.subtype==="turn_duration");
 for(const row of r.rows.filter(row=>row!==end))r.append(row);
 appendFileSync(r.path,JSON.stringify(end));await r.monitor.pollIncrement();expect(r.events.some(row=>row.kind==="end")).toBe(false);
 appendFileSync(r.path,"\n");await r.monitor.pollIncrement();expect(r.events.at(-1)?.kind).toBe("end");
});
