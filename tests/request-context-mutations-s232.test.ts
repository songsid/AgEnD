import {randomUUID} from "node:crypto";
import {expect,it,vi} from "vitest";
import {FleetManager} from "../src/fleet-manager.js";
import {captureRequestContextCall} from "../src/request-context-call.js";
import {assertRequestContextOperation} from "../src/request-context-policy.js";
import {applyInstanceConfigPatch,outboundHandlers} from "../src/outbound-handlers.js";
import {nativeAgentAdmissionContext} from "../src/native-agent-admission.js";
import {dispatchAgentOperation} from "../src/agent-endpoint.js";
function fixture(){const id=randomUUID(),lease=captureRequestContextCall({token:randomUUID(),inputId:"input",wireSha256:"a".repeat(64),owner:{instance:"worker",incarnation:"v1",workGeneration:"work",daemonBootId:"boot",spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0},context:{ref:{version:1,contextId:id,rootContextId:id},rootEvidenceRef:"accepted",ingress:"hub",initiatingActor:{kind:"person",platform:"hub",hubId:"demo-hub",id:"directory/demo-person"},source:{instance:"worker",incarnation:"v1"},sourceAudience:{kind:"hub",ref:randomUUID()}}},()=>true),admission={coverage:"covered"as const,lease},policy={assert:assertRequestContextOperation};return {lease,admission,policy};}
it("actual TaskBoard, scheduler, config and theme commit owners refuse captured Hub work",async()=>{
 const f=fixture(),fm:any=Object.create(FleetManager.prototype),write=vi.fn();fm.requestContextPolicy=f.policy;fm.scheduler={db:{},create:write,update:write,delete:write};fm.fleetConfig={instances:{worker:{working_directory:"/fixture"}}};Object.defineProperty(fm,"appearanceTools",{value:{handle:write}});Object.defineProperty(fm,"webAppearance",{value:{handleTool:write}});
 await expect(fm.handleTaskCrudHttp("worker",{action:"create",title:"Not created"},undefined,f.admission)).rejects.toThrow(/later work/);
 expect(()=>fm.performScheduleOp("worker","create",{target:"worker",cron:"* * * * *",message:"Not scheduled"},{chatId:"",threadId:null,requestContextAdmission:f.admission})).toThrow(/later work/);
 expect(()=>fm.saveFleetConfig([],f.admission)).toThrow(/separate owner/);
 await expect(fm.handleWebThemeHttp("worker","set_web_theme",{},f.admission)).rejects.toThrow(/separate owner/);expect(write).not.toHaveBeenCalled();
});
it("actual config patch refuses before changing the in-memory config",()=>{
 const f=fixture(),save=vi.fn(),raw:any={requestContextPolicy:f.policy,fleetConfig:{instances:{worker:{working_directory:"/fixture",model:"original"}}},saveFleetConfig:save},ctx=nativeAgentAdmissionContext(raw,{instance:"worker",current:()=>true,taskAllowed:()=>true,requestContext:f.lease,operation:{tool:"update_instance_config",args:{name:"worker",config:{model:"changed"}}}}),respond=vi.fn();
 applyInstanceConfigPatch(ctx,"worker",{model:"changed"},respond);expect(raw.fleetConfig.instances.worker.model).toBe("original");expect(save).not.toHaveBeenCalled();expect(respond).toHaveBeenCalledWith(null,expect.stringContaining("separate owner"));
});
it("the actual HTTP dispatcher refuses Hub task CRUD before its early-return branch",async()=>{
 const f=fixture(),write=vi.fn(),ctx=nativeAgentAdmissionContext({requestContextPolicy:f.policy,fleetConfig:{instances:{worker:{tool_set:"worker"}}},logger:{warn:vi.fn()},handleTaskCrudHttp:write}as any,{instance:"worker",current:()=>true,taskAllowed:()=>true,requestContext:f.lease,operation:{tool:"task",args:{action:"create"}}});
 await expect(dispatchAgentOperation(ctx,"worker","task",{action:"create",title:"Not created"})).rejects.toThrow(/later work/);expect(write).not.toHaveBeenCalled();
});
it("canonical outbound handler dispatch refuses delegate and broadcast before a send loop",async()=>{
 const f=fixture(),write=vi.fn(),ctx:any={requestContextPolicy:f.policy,admitDurableDelivery:write,requestContextCallAdmission:f.admission};
 for(const tool of ["delegate_task","broadcast"]){const respond=vi.fn();await outboundHandlers.get(tool)!(ctx,{target_instance:"other",task:"No",message:"No"},respond,{instanceName:"worker",requestId:undefined,fleetRequestId:undefined,senderSessionName:undefined});expect(respond).toHaveBeenCalledWith(null,expect.any(String));}expect(write).not.toHaveBeenCalled();
});

it("partial installation cannot reach Fleet legacy admission, and OFF does no projection read",()=>{
 const f=fixture(),fm:any=Object.create(FleetManager.prototype);fm.requestContextPolicy=f.policy;expect(()=>fm.admitDurableDelivery({})).toThrow(/no legacy fallback/);fm.requestContextPolicy=undefined;fm.requestContextRelay={};expect(()=>fm.admitDurableDelivery({})).toThrow(/no legacy fallback/);fm.requestContextRelay=undefined;const read=vi.fn(()=>{throw Error("OFF read");});fm.deliveryOutbox={requestContextForDelivery:read};expect(fm.requestDeliveryView("unused")).toBeNull();expect(read).not.toHaveBeenCalled();
});
