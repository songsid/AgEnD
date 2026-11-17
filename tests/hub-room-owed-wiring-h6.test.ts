import {randomUUID} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Daemon} from "../src/daemon.js";
import {TurnWatch} from "../src/dispatcher-liveness.js";
import {FleetManager} from "../src/fleet-manager.js";
import {withHubRoomReplyWarning} from "../src/hub-room-reply-warning.js";
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it("H6 daemon reports a settled completed turn even after reply, fences input/reset races, and leaves the human board signal separate",async()=>{
 vi.useFakeTimers();let generation="owned-generation";const sent:any[]=[];
 const d:any=Object.assign(Object.create(Daemon.prototype),{name:"worker",config:{backend:"kiro-cli"},backend:{binaryName:"kiro-cli"},turnWatch:new TurnWatch(),turnEndTimer:null,roomConversationState:{},roomConversationGeneration:()=>generation,hubRoomInputEpoch:0,hubRoomTurnBoot:"owned",hubRoomTurnSequence:0,broadcastFleetMessage:(m:any)=>sent.push(m)});
 d.noteTurnEdge("working");d.turnWatch.tool("mcp__agend__reply",{text:"Private owner reply"},Date.now());d.noteTurnEdge("idle");await vi.advanceTimersByTimeAsync(4999);expect(sent).toEqual([]);await vi.advanceTimersByTimeAsync(1);expect(sent).toEqual([{type:"hub_room_turn_ended",generation,turn:"owned:1"}]);
 d.noteTurnEdge("idle");await vi.advanceTimersByTimeAsync(5000);expect(sent).toHaveLength(1);
 d.noteTurnEdge("working");d.noteTurnEdge("idle");d.hubRoomInputEpoch++;await vi.advanceTimersByTimeAsync(5000);expect(sent).toHaveLength(1);
 d.noteTurnEdge("working");d.noteTurnEdge("idle");generation="new-generation";await vi.advanceTimersByTimeAsync(5000);expect(sent).toHaveLength(1);
 d.noteTurnEdge("working");d.noteTurnEdge("idle");d.noteTurnEdge("working");await vi.advanceTimersByTimeAsync(5000);expect(sent).toHaveLength(1);d.noteTurnEdge("idle");await vi.advanceTimersByTimeAsync(5000);expect(sent[1]).toMatchObject({generation:"new-generation"});
});
it("H6 actual Fleet reply result adds guidance after private delivery, while failed sends remain errors",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"agend-h6-reply-")),fm:any=new FleetManager(dir),ipc=vi.fn(()=>true),sendText=vi.fn().mockResolvedValue({messageId:"sent",chatId:"owned-chat"}),adapter={id:"owned",type:"discord",sendText};
 fm.adapter=adapter;fm.worlds.set("owned",{adapter});fm.instanceIpcClients.set("worker",{send:ipc});fm.hubRoomOwed={replyWarning:()=>"Still owe Hub: report_result."};vi.spyOn(fm,"afterReplyRouted").mockResolvedValue(undefined);
 try{await fm.handleOutboundFromInstance("worker",{tool:"reply",args:{chat_id:"owned-chat",thread_id:"owned-topic",text:"Private owner reply"},fleetRequestId:"reply-one",adapterId:"owned"});await vi.waitFor(()=>expect(ipc).toHaveBeenCalledWith(expect.objectContaining({result:{messageId:"sent",chatId:"owned-chat",hub_warning:"Still owe Hub: report_result."}})));expect(sendText.mock.calls[0][1]).toBe("Private owner reply");
 sendText.mockRejectedValueOnce(Error("inert failure"));await fm.handleOutboundFromInstance("worker",{tool:"reply",args:{chat_id:"owned-chat",thread_id:"owned-topic",text:"Other private reply"},fleetRequestId:"reply-two",adapterId:"owned"});await vi.waitFor(()=>expect(ipc).toHaveBeenCalledWith(expect.objectContaining({fleetRequestId:"reply-two",result:null,error:"inert failure"})));
 }finally{fm.stormWindow.shutdown();rmSync(dir,{recursive:true,force:true});}
});
it("H6 warning failure cannot change an already successful platform outcome",()=>{
 const result={messageId:"sent"};expect(withHubRoomReplyWarning(result,()=>{throw Error("inert");})).toBe(result);expect(withHubRoomReplyWarning({error:"failed"},"owed")).toEqual({error:"failed"});expect(withHubRoomReplyWarning("sent","owed")).toBe("sent\n\nowed");
});

it("H6 Claude/Codex compaction-only spinner is not an unanswered turn; actual transcript activity qualifies",async()=>{
 vi.useFakeTimers();const dir=mkdtempSync(join(tmpdir(),"agend-h6-turn-")),sent:any[]=[];
 const d:any=Object.assign(Object.create(Daemon.prototype),{name:"worker",instanceDir:dir,config:{backend:"codex"},backend:{binaryName:"codex"},logger:{warn(){},info(){},debug(){},error(){}},followLog:{reset(){},observe(){}},transcriptTurns:{reset(){},observe(){}},interactionOwner:()=>({}),turnWatch:new TurnWatch(),turnEndTimer:null,roomConversationState:{},roomConversationGeneration:()=>"owned",hubRoomInputEpoch:0,hubRoomTranscriptActivity:0,hubRoomTurnActivityStart:null,hubRoomTurnBoot:"owned",hubRoomTurnSequence:0,broadcastFleetMessage:(m:any)=>sent.push(m)});
 try{const monitor=d.buildTranscriptMonitor(null);d.transcriptMonitor=monitor;vi.spyOn(monitor,"following").mockReturnValue(true);
 d.noteTurnEdge("working");d.noteTurnEdge("idle");await vi.advanceTimersByTimeAsync(5000);expect(sent.filter(m=>m.type==="hub_room_turn_ended")).toEqual([]);
 d.noteTurnEdge("working");monitor.emit("tool_use","mcp__agend__reply",{text:"Owner reply"});monitor.emit("tool_result");d.noteTurnEdge("idle");await vi.advanceTimersByTimeAsync(5000);expect(sent.filter(m=>m.type==="hub_room_turn_ended")).toHaveLength(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it("H6 Fleet binds cold room input to the daemon generation after wake, without changing one-to-one Hub metadata",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"agend-h6-cold-")),fm:any=new FleetManager(dir),generation=randomUUID();
 vi.spyOn(fm,"hubAgentConfig").mockReturnValue({backend:"claude-code"});fm.daemons.set("worker",{roomConversationGeneration:()=>generation});let meta:any;
 vi.spyOn(fm,"deliverToInstance").mockImplementation(async(_agent:any,payload:any,opts:any)=>{expect(payload.meta.hub_room_context_generation).toBeUndefined();await opts.beforeInput();meta=payload.meta;return true;});
 try{await fm.deliverHubQuestion({agent:"worker",correlationId:`hub-room-${randomUUID()}`,text:"Question",contactLimit:false,stillCurrent:()=>true,beforeInput:async()=>true});expect(meta.hub_room_context_generation).toBe(generation);
 await fm.deliverHubQuestion({agent:"worker",correlationId:`hub-${randomUUID()}`,text:"Direct question",contactLimit:false,stillCurrent:()=>true,beforeInput:async()=>true});expect(meta.hub_room_context_generation).toBeUndefined();
 }finally{fm.stormWindow.shutdown();rmSync(dir,{recursive:true,force:true});}
});

it("H6 private reminder can reach a ClassicBot agent without enabling unrelated notification paths",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"agend-h6-classic-")),fm:any=new FleetManager(dir);fm.fleetConfig={instances:{}};vi.spyOn(fm,"hubAgentConfig").mockReturnValue({backend:"claude-code"});const delivered=vi.spyOn(fm,"deliverToInstance").mockResolvedValue(true);
 const input={agent:"classic-room",id:randomUUID(),kind:"answer-reminder",text:"Use report_result for the pending Hub question.",beforeInput:async()=>true,stillCurrent:()=>true};
 try{expect(await fm.deliverHubRoomNotification(input)).toBe(true);expect(delivered.mock.calls[0][1]).toMatchObject({meta:{from_instance:"agend-hub",requires_reply:"false",task_summary:"Hub room answer reminder"}});delivered.mockClear();expect(await fm.deliverHubRoomNotification({...input,kind:"post-answer"})).toBe(false);expect(delivered).not.toHaveBeenCalled();}
 finally{fm.stormWindow.shutdown();rmSync(dir,{recursive:true,force:true});}
});
