/** Classic shares use private Hub delivery, never the room's channel or chat-log ingress. */
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {FleetManager} from "../src/fleet-manager.js";
import {ClassicChannelManager} from "../src/classic-channel-manager.js";
const roots:string[]=[];
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function rig(type:"discord"|"telegram"="discord",legacyAdmission=false,existingRoot?:string){
 const root=existingRoot??mkdtempSync(join(tmpdir(),"agend-classic-hub-"));if(!roots.includes(root))roots.push(root);const fm=new FleetManager(root);
 const config={working_directory:join(root,"workspace"),backend:"claude-code",tool_set:"full"};
 fm.fleetConfig={defaults:{},instances:legacyAdmission?{roomAgent:config}:{}} as never;
 const classic=new ClassicChannelManager(root,fm.logger);classic.setPrimaryAdapterId("fixture-adapter");
 classic.register("111111111111111111","fixture-adapter","roomAgent","Example room","fixture-owner","claude-code");fm.classicChannels=classic;
 const adapter={id:"fixture-adapter",type,sendText:vi.fn(async()=>({messageId:"fixture-message",chatId:"111111111111111111"})),react:vi.fn(async()=>{}),editMessage:vi.fn(async()=>{})};
 fm.adapter=adapter as never;fm.worlds.set(adapter.id,{id:adapter.id,adapter} as never);
 const responses:any[]=[];fm.instanceIpcClients.set("roomAgent",{connected:true,send:(message:any)=>{responses.push(message);return true;}} as never);
 vi.spyOn(fm as any,"touchActivity").mockImplementation(()=>{});vi.spyOn(fm as any,"setTopicIcon").mockImplementation(()=>{});vi.spyOn(fm as any,"afterReplyRouted").mockImplementation(()=>{});
 vi.spyOn(fm as any,"waitForInstanceIdle").mockResolvedValue(true);
 const inbound:any[]=[];vi.spyOn(fm,"deliverToInstance").mockImplementation(async(_agent,payload,options)=>{if(options?.beforeInput&&!await options.beforeInput())return false;inbound.push(payload);return true;});
 const send=async(tool:string,args:any)=>{responses.length=0;await (fm as any).handleOutboundFromInstance("roomAgent",{tool,args,fleetRequestId:"fixture-rpc",adapterId:adapter.id});return responses.at(-1);};
 const ask=async(contactLimit=true)=>await (fm as any).deliverHubQuestion({agent:"roomAgent",correlationId:"hub-fixture-question",text:"PRIVATE_HUB_QUESTION",contactLimit,beforeInput:async()=>true,stillCurrent:()=>true});
 return {fm,classic,adapter,inbound,send,ask,root};
}
it("lists and resolves a registered Classic room through the same agent-consent path",async()=>{
 const r=rig();expect((r.fm as any).hubMemberAgents()).toContainEqual({name:"roomAgent",display:"Example room",kind:"classic-room"});
 expect((r.fm as any).hubAgentToken("roomAgent")).toMatch(/^[a-f0-9]{64}$/);expect(await r.ask()).toBe(true);
 expect(r.inbound[0]).toMatchObject({type:"fleet_inbound",content:"PRIVATE_HUB_QUESTION",meta:{chat_id:"",thread_id:"",from_instance:"agend-hub"}});
});
it.each(["discord","telegram"] as const)("never routes Hub-turn reply/react/edit to the %s room, even with contact limit off",async platform=>{
 // A room-only target reaches the real channel router, without a Fleet-topic alias.
 const r=rig(platform),history=vi.spyOn(r.fm as any,"getRecentChatLog").mockReturnValue("PRIVATE_ROOM_HISTORY");
 expect(await r.ask(false)).toBe(true);expect(history).not.toHaveBeenCalled();expect(JSON.stringify(r.inbound)).not.toContain("PRIVATE_ROOM_HISTORY");
 const refusals:any[]=[];for(const [tool,args] of [["reply",{text:"PRIVATE_HUB_ANSWER"}],["react",{message_id:"fixture-message",emoji:"👍"}],["edit_message",{message_id:"fixture-message",text:"PRIVATE_HUB_ANSWER"}]] as const){
  refusals.push(await r.send(tool,args));
 }
 expect(r.adapter.sendText).not.toHaveBeenCalled();expect(r.adapter.react).not.toHaveBeenCalled();expect(r.adapter.editMessage).not.toHaveBeenCalled();for(const result of refusals)expect(result.error).toMatch(/Hub|private/i);
});
it("does not release the room-output fence when the Hub report is accepted",async()=>{
 const r=rig("discord");expect(await r.ask()).toBe(true);(r.fm as any).hubReports=async()=>({ok:true});
 expect(await r.fm.hubReport({caller:"roomAgent",correlationId:"hub-fixture-question",text:"Hub answer",callerCurrent:()=>true})).toEqual({ok:true});
 const result=await r.send("reply",{text:"PRIVATE_HUB_ANSWER_AFTER_ACK"});expect(r.adapter.sendText).not.toHaveBeenCalled();expect(result.error).toMatch(/Hub|private/i);
});

it("keeps private room output closed across Fleet restart and beyond the contact-limit expiry",async()=>{
 const first=rig();expect(await first.ask()).toBe(true);const held=JSON.parse(readFileSync(join(first.root,"hub-classic-private.json"),"utf8"));expect(JSON.stringify(held)).not.toContain("PRIVATE_HUB_QUESTION");vi.useFakeTimers();vi.setSystemTime(Date.now()+31*60_000);
 const next=rig("discord",false,first.root);expect((next.fm as any).contactWindows().restricted("roomAgent")).toBe(false);const result=await next.send("reply",{text:"PRIVATE_LATE_ANSWER"});expect(next.adapter.sendText).not.toHaveBeenCalled();expect(result.error).toMatch(/Hub|private/i);
});
it("suppresses private-turn progress and public room notices",async()=>{
 const r=rig();expect(await r.ask(false)).toBe(true);const bubble:any={instanceName:"roomAgent",toolProgress:"Earlier room task"};(r.fm as any).cancelButtons.set("fixture-bubble",bubble);
 (r.fm as any).cacheInstanceProgress("roomAgent","PRIVATE_HUB_TOOL_PROGRESS");(r.fm as any).cacheInstanceActivity("roomAgent","PRIVATE_HUB_ACTIVITY");(r.fm as any).refreshBubble(bubble);expect((r.fm as any).instanceActivity.has("roomAgent")).toBe(false);expect(bubble.toolProgress).toBe("Earlier room task");expect((r.fm as any).instanceProgress.has("roomAgent")).toBe(false);
 expect((r.fm as any).sendToInstanceTopic("roomAgent","PRIVATE_HUB_NOTICE")).toBeNull();await r.fm.sendHangNotification("roomAgent");await r.fm.notifyNormalExit("roomAgent");expect(r.adapter.sendText).not.toHaveBeenCalled();
});
it("only a new room-person handoff after fresh idle and completed Hub work can reopen room output",async()=>{
 const r=rig();expect(await r.ask()).toBe(true);let pending=true;(r.fm as any).hubPrivateQuestions=()=>pending;let release!:(idle:boolean)=>void;
 const idle=vi.spyOn(r.fm as any,"waitForInstanceIdle").mockClear().mockResolvedValueOnce(true).mockImplementationOnce(()=>new Promise<boolean>(resolve=>{release=resolve;})).mockResolvedValue(true);
 const publicInput={type:"fleet_inbound",content:"A new room question",meta:{chat_id:"111111111111111111",user_id:"fixture-room-person"}};
 const turn=(FleetManager.prototype as any).deliverWithIdleGate.call(r.fm,"roomAgent",publicInput,1000,0,false);await vi.waitFor(()=>expect(idle).toHaveBeenCalledTimes(2));
 expect((await r.send("reply",{text:"PRIVATE_WHILE_WAITING"})).error).toMatch(/Hub|private/i);expect(r.adapter.sendText).not.toHaveBeenCalled();pending=false;release(true);expect(await turn).toBe(true);
 expect(idle.mock.calls[1]![2]).toBeGreaterThan(0);expect((await r.send("reply",{text:"A normal room answer"})).error).toBeUndefined();expect(r.adapter.sendText).toHaveBeenCalledTimes(1);
});
it("never reopens public output for a peer notification",async()=>{
 const r=rig();expect(await r.ask()).toBe(true);expect(await (r.fm as any).prepareClassicForPerson("roomAgent",{type:"fleet_inbound",meta:{chat_id:"111111111111111111",user_id:"instance:peer",from_instance:"peer"}},0)).toBeNull();
 const result=await r.send("reply",{text:"PRIVATE_ANSWER"});expect(r.adapter.sendText).not.toHaveBeenCalled();expect(result.error).toMatch(/Hub|private/i);
});
it("treats unreadable privacy state as a refusal before input or public output",async()=>{
 const r=rig();writeFileSync(join(r.root,"hub-classic-private.json"),"not-json");await expect(r.ask()).rejects.toThrow();expect(r.inbound).toHaveLength(0);expect((await r.send("reply",{text:"Private"})).error).toMatch(/Hub|private/i);expect(r.adapter.sendText).not.toHaveBeenCalled();
});
it("uses the normal reserved report path without room history in answer metadata",async()=>{
 const r=rig();expect(await r.ask()).toBe(true);vi.spyOn(r.fm as any,"getDaemonBootId").mockReturnValue("fixture-boot");const report=vi.fn(async(_input:unknown)=>({ok:true}));(r.fm as any).hubReports=report;
 const history=vi.spyOn(r.fm as any,"getRecentChatLog").mockReturnValue("PRIVATE_ROOM_CHAT_SENTINEL");const result=await r.send("report_result",{target_instance:"agend-hub",correlation_id:"hub-fixture-question",summary:"The final Hub answer"});
 expect(result.error).toBeUndefined();expect(report).toHaveBeenCalledTimes(1);expect(report.mock.calls[0]![0]).toMatchObject({caller:"roomAgent",correlationId:"hub-fixture-question",text:"The final Hub answer"});expect(JSON.stringify(report.mock.calls)).not.toContain("PRIVATE_ROOM_CHAT_SENTINEL");expect(history).not.toHaveBeenCalled();expect(r.adapter.sendText).not.toHaveBeenCalled();
});
it("retains the Classic incarnation until its registry loads after restart, then rotates on retarget",()=>{
 const first=rig(),token=(first.fm as any).hubAgentToken("roomAgent");const restarted=new FleetManager(first.root);restarted.fleetConfig={defaults:{},instances:{}} as never;(restarted as any).observeHubAgentIncarnations();restarted.classicChannels=first.classic;
 expect((restarted as any).hubAgentToken("roomAgent")).toBe(token);first.classic.getAll()[0]!.channelId="222222222222222222";expect((restarted as any).hubAgentToken("roomAgent")).not.toBe(token);
});
it("a stopped and re-added Classic room does not inherit its old Hub consent",async()=>{
 const r=rig(),before=(r.fm as any).hubAgentToken("roomAgent");vi.spyOn(r.fm,"stopInstance").mockResolvedValue({backgroundWorkEnded:false} as never);vi.spyOn(r.fm as any,"reregisterClassicChannels").mockImplementation(()=>{});
 await r.fm.handleClassicStop("111111111111111111","fixture-adapter");r.classic.register("111111111111111111","fixture-adapter","roomAgent","Example room","fixture-owner","claude-code");expect((r.fm as any).hubAgentToken("roomAgent")).not.toBe(before);
});

it("never starts a private Hub turn over an unfinished public room turn",async()=>{
 const r=rig();vi.spyOn(r.fm as any,"waitForInstanceIdle").mockResolvedValue(false);expect(await r.ask()).toBe(false);expect(r.inbound).toHaveLength(0);expect((await r.send("reply",{text:"The normal room answer"})).error).toBeUndefined();expect(r.adapter.sendText).toHaveBeenCalledTimes(1);
});

it("refuses an ambiguous Fleet/Classic target instead of borrowing another agent's consent",async()=>{const r=rig("discord",true);expect((r.fm as any).hubMemberAgents()).toEqual([]);expect((r.fm as any).hubAgentToken("roomAgent")).toBeNull();expect(await r.ask()).toBe(false);expect(r.inbound).toHaveLength(0);});

it("does not reopen the room when a new person's final handoff is refused or disconnected",async()=>{
 const r=rig();expect(await r.ask()).toBe(true);const person={type:"fleet_inbound",content:"New room question",meta:{chat_id:"111111111111111111",user_id:"fixture-person"}};
 expect(await (r.fm as any).handOffAfterBeforeInput("roomAgent",person,0,undefined,async()=>false)).toBe(false);
 expect((await r.send("reply",{text:"PRIVATE_REFUSED_HANDOFF"})).error).toMatch(/Hub|private/i);expect(r.adapter.sendText).not.toHaveBeenCalled();
 (r.fm.instanceIpcClients.get("roomAgent") as any).connected=false;
 expect(await (r.fm as any).handOffAfterBeforeInput("roomAgent",person,0,undefined,async()=>true)).toBe(false);
 expect((r.fm as any).classicHubPrivateBlocked("roomAgent")).toBe(true);
});
it("rechecks the private turn after asynchronous reply validation",async()=>{
 const r=rig();let release!:(v:null)=>void;vi.spyOn(r.fm as any,"replyStickerProblem").mockImplementationOnce(()=>new Promise<null>(resolve=>{release=resolve;}));
 const sending=r.send("reply",{text:"MUST_NOT_LEAK_AFTER_AWAIT"});await vi.waitFor(()=>expect(release).toBeTypeOf("function"));expect(await r.ask()).toBe(true);release(null);const result=await sending;
 expect(r.adapter.sendText).not.toHaveBeenCalled();expect(result.error).toMatch(/Hub|private/i);
});

it("keeps private output fenced after the Classic room is unregistered",async()=>{
 const r=rig();expect(await r.ask()).toBe(true);r.classic.unregister("111111111111111111","fixture-adapter");
 const result=await r.send("reply",{text:"PRIVATE_AFTER_UNREGISTER"});expect(r.adapter.sendText).not.toHaveBeenCalled();expect(result.error).toMatch(/Hub|private/i);
});
