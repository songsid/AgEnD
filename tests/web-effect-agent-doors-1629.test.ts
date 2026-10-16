import {expect,it,vi} from "vitest";
vi.mock("node:child_process",()=>{const denied=()=>{throw Error("process launch forbidden");};return {spawn:denied,spawnSync:denied,exec:denied,execSync:denied,execFile:denied,execFileSync:denied};});
import {dispatchAgentOperation,type AgentEndpointContext} from "../src/agent-endpoint.js";
import {TOOL_PROFILES,IPC_TYPE_TOOLS,EARLY_AGENT_OP_TOOLS} from "../src/tool-permissions.js";
import {TOOLS} from "../src/channel/mcp-tools.js";
import * as S from "../src/outbound-schemas.js";
const tools=["upload_web_effect","list_web_effects","preview_web_effect","profile_web_effect","apply_web_effect","remove_web_effect","delete_web_effect"];
const ops=["effect-upload","effect-list","effect-preview","effect-profile","effect-apply","effect-remove","effect-delete"];
it.each(tools.map((tool,i)=>[tool,ops[i]!]))("maps and enforces %s across the real agent dispatcher",async(tool,op)=>{
 const handle=vi.fn(async(instance:string,name:string,args:Record<string,unknown>)=>({instance,name,args}));
 const context={fleetConfig:{instances:{own:{tool_set:"standard"}}},logger:{warn:vi.fn()},handleWebThemeHttp:handle} as unknown as AgentEndpointContext;
 const args={fixture:true};expect(await dispatchAgentOperation(context,"own",op,args)).toEqual({instance:"own",name:tool,args});
 expect(EARLY_AGENT_OP_TOOLS[op]).toBe(tool);
 expect(IPC_TYPE_TOOLS["fleet_"+tool]).toBe(tool);
 expect(TOOLS.find(t=>t.name===tool)).toBeDefined();
 for(const profile of ["standard","worker","coordinator","full"] as const)expect(TOOL_PROFILES[profile]).toContain(tool);
 const minimal={...context,fleetConfig:{instances:{own:{tool_set:"minimal"}}}} as unknown as AgentEndpointContext;
 await expect(dispatchAgentOperation(minimal,"own",op,args)).rejects.toThrow(/minimal/i);
 expect(handle).toHaveBeenCalledTimes(1);
});
it.each([
 ["upload",S.UploadWebEffectArgs,{dir:"./effect"}], ["list",S.ListWebEffectsArgs,{}],
 ["preview",S.PreviewWebEffectArgs,{id:"a".repeat(32)}], ["profile",S.ProfileWebEffectArgs,{id:"a".repeat(32)}],
 ["apply",S.ApplyWebEffectArgs,{id:"a".repeat(32),params:{size:2,color:"#ffffff"}}],
 ["remove",S.RemoveWebEffectArgs,{}], ["delete",S.DeleteWebEffectArgs,{id:"a".repeat(32)}],
] as const)("keeps public %s args closed and target-free",(_name,schema,valid)=>{
 expect(schema.safeParse(valid).success).toBe(true);
 for(const field of ["target","instance","principal","holder","by","data_b64","stageId"])expect(schema.safeParse({...valid,[field]:"forged"}).success).toBe(false);
});
