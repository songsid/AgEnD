import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ClaudeTurnBoundaries, type ClaudeTurnBinding } from "../src/claude-turn-boundaries.js";
import { TranscriptTurnLedger } from "../src/transcript-turns.js";
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8").trim().split("\n").map(line => JSON.parse(line));
function world() {
 const sessionId=randomUUID(), start=100;
 const binding:ClaudeTurnBinding={launchId:"owned-launch",startedAt:start,sessionId,transcriptPath:`/private/${sessionId}.jsonl`};
 const parser=new ClaudeTurnBoundaries();
 const record=(type:string,extra:Record<string,unknown>={})=>({type,uuid:randomUUID(),isSidechain:false,sessionId,timestamp:new Date(200).toISOString(),...extra});
 const user=record("user",{message:{role:"user",content:"exact admitted input"}});
 const assistant=record("assistant",{parentUuid:user.uuid,message:{role:"assistant",stop_reason:"end_turn",content:[]}});
 const duration=record("system",{subtype:"turn_duration",parentUuid:assistant.uuid,durationMs:1});
 return {parser,binding,record,user,assistant,duration,observe:(r:unknown)=>parser.observe(r,binding,300)};
}
it("requires the native duration, rather than the API end_turn or reply tool",()=>{
 const w=world(),events=w.observe(w.user);expect(events.map(x=>x.kind)).toEqual(["start","user"]);
 expect(w.observe(w.assistant)).toEqual([]);
 expect(w.observe(w.duration)).toEqual([{kind:"end",turnId:(events[0] as any).turnId,end:"complete"}]);
 expect(w.observe(w.duration)).toEqual([]);
});
it.each(["parent","session","launch","path","sidechain","history"])("never closes from another scope: %s",kind=>{
 const w=world();w.observe(w.user);w.observe(w.assistant);
 const end:Record<string,any>={...w.duration},binding={...w.binding};
 if(kind==="parent")end.parentUuid=randomUUID();if(kind==="session")end.sessionId=randomUUID();
 if(kind==="launch")binding.launchId="replacement";if(kind==="path")binding.transcriptPath="/another.jsonl";
 if(kind==="sidechain")end.isSidechain=true;if(kind==="history")end.timestamp=new Date(50).toISOString();
 expect(w.parser.observe(end,binding,300).some(x=>x.kind==="end")).toBe(false);
});
it("keeps a steer and tool results within one provider turn",()=>{
 const w=world(),start=w.observe(w.user)[0];w.observe(w.assistant);
 const result=w.record("user",{parentUuid:w.assistant.uuid,message:{role:"user",content:[{type:"tool_result",tool_use_id:"call",content:"not a prompt"}]}});
 expect(w.observe(result)).toEqual([]);
 const steer=w.record("user",{parentUuid:result.uuid,message:{role:"user",content:"admitted steer"}});
 expect(w.observe(steer)).toEqual([{kind:"user",turnId:(start as any).turnId,text:"admitted steer",at:200}]);
 const final=w.record("assistant",{parentUuid:steer.uuid,message:{role:"assistant",stop_reason:"end_turn",content:[]}});w.observe(final);
 expect(w.observe({...w.duration,parentUuid:final.uuid})).toEqual([{kind:"end",turnId:(start as any).turnId,end:"complete"}]);
});
it("retracts on compaction/reset and never treats an API error retry as a terminal",()=>{
 const w=world();w.observe(w.user);
 expect(w.observe({...w.assistant,isApiErrorMessage:true})).toEqual([]);
 const reset=w.observe(w.record("system",{subtype:"compact_boundary",isMeta:true}));expect(reset[0]?.kind).toBe("retract");
 expect(w.observe(w.duration)).toEqual([]);expect(w.parser.reset()).toEqual([]);
});
it.each(["claude-2.1.293-idle-submit-flooded.transcript.jsonl","claude-2.1.293-steer-consumed-mid-turn.transcript.jsonl","claude-2.1.293-steer-consumed-after-turn.transcript.jsonl"])("closes recorded native turns with exact user text: %s",name=>{
 const rows=fixture(name),user=rows.find(r=>r.type==="user"&&r.message?.role==="user"&&typeof r.message.content==="string");expect(user).toBeTruthy();
 const binding={launchId:"recorded-fixture",sessionId:user.sessionId,startedAt:0,transcriptPath:`/private/${user.sessionId}.jsonl`};
 const parser=new ClaudeTurnBoundaries(),ledger=new TranscriptTurnLedger();let ends=0;
 for(const row of rows){const events=parser.observe(row,binding,Date.now());ends+=events.filter(x=>x.kind==="end").length;ledger.observe(events);}
 expect(ends).toBeGreaterThan(0);expect(ledger.verdict(user.message.content,Date.parse(user.timestamp))).toBe("ended");
});
it("a recorded interrupt is unknown-end evidence, never a successful end",()=>{
 const w=world();w.observe(w.user);w.observe(w.assistant);
 const rows=fixture("turn-question-m3239/claude-rehearsal.jsonl");
 const interruption=rows.find(row=>JSON.stringify(row.message).includes("[Request interrupted by user"));
 expect(interruption).toBeTruthy();
 expect(w.parser.observe(interruption,w.binding,Date.now())).toEqual([{kind:"retract",turnId:`claude:${w.binding.sessionId}:${w.user.uuid}`,reason:"interrupt"}]);
 expect(w.observe(w.duration)).toEqual([]);
});
it("a previous turn's duration cannot close a resent prompt",()=>{
 const w=world(),first=w.observe(w.user)[0];w.observe(w.assistant);w.observe(w.duration);
 const next=w.record("user",{message:{role:"user",content:"resent independent input"}}),start=w.observe(next)[0];
 expect((start as any).turnId).not.toBe((first as any).turnId);
 expect(w.observe(w.duration)).toEqual([]);
 const ledger=new TranscriptTurnLedger();ledger.observe([start,...w.observe(next)]);expect(ledger.openSince()).not.toBeNull();
});

it("a duration attached to an observed user rather than its main assistant cannot end the turn",()=>{
 const w=world();w.observe(w.user);w.observe(w.assistant);
 expect(w.observe({...w.duration,parentUuid:w.user.uuid})).toEqual([]);
});

it("the recorded resent-turn fragment does not borrow its earlier duration",()=>{
 const rows=fixture("claude-2.1.325-queued-merged-into-resent-turn.transcript.jsonl"),user=rows.find(row=>row.type==="user");
 const parser=new ClaudeTurnBoundaries(),binding={launchId:"recorded-resend",sessionId:user.sessionId,startedAt:0,transcriptPath:`/private/${user.sessionId}.jsonl`};
 const events=rows.flatMap(row=>parser.observe(row,binding,Date.now()));
 expect(events.map(event=>event.kind)).toEqual(["start","user","user"]);
 expect(parser.observe(rows[0],binding,Date.now())).toEqual([]);
});
