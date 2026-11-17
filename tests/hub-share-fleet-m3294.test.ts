import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { memberAgentCatalog } from "../src/hub/member/agent-catalog.js";
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it("lists General and eligible Classic rooms, refuses Windows exec, and projects no working folder or CLI configuration",()=>{
  const root=mkdtempSync(join(tmpdir(),"agend-share-fleet-"));roots.push(root);const fm=new FleetManager(root);
  fm.fleetConfig={defaults:{},instances:{
    general:{general_topic:true,working_directory:join(root,"fleet"),backend:"codex",tool_set:"coordinator",display_name:"General"},
    docs:{working_directory:join(root,"docs"),backend:"claude-code",description:"Document questions",status_emojis:{delivered:"📚"}},
    remote:{runtime:"windows",native_adapter:"exec",machine_id:"fixture-machine",working_directory:"C:/work",backend:"codex"},
  }} as never;
  const classic=new ClassicChannelManager(root,fm.logger);classic.setPrimaryAdapterId("fixture-adapter");
  classic.register("111111111111111111","fixture-adapter","support","Support room","fixture-owner","claude-code");fm.classicChannels=classic;
  vi.spyOn(fm as any,"webIdentityImage").mockReturnValue({agentColor:"#123456"});
  const sources=(fm as any).hubCatalogAgents(),catalog=memberAgentCatalog(true,sources);
  expect(catalog.agents).toContainEqual(expect.objectContaining({instance:"general",general:true,shareable:true}));
  expect(catalog.agents).toContainEqual(expect.objectContaining({instance:"support",kind:"classic-room",shareable:true}));
  expect(catalog.agents).toContainEqual(expect.objectContaining({instance:"remote",shareable:false,reason:"remote-windows"}));
  expect(catalog.agents).toContainEqual(expect.objectContaining({instance:"docs",description:"Document questions",avatar:{emoji:"📚",color:"#123456"}}));
  const bytes=JSON.stringify(catalog);for(const hidden of [root,"working_directory","coordinator","claude-code","machine_id","incarnation"])expect(bytes).not.toContain(hidden);
  const token=sources.find((s:any)=>s.instance==="support").incarnation;
  classic.getAll()[0]!.channelId="222222222222222222";
  const changed=(fm as any).hubCatalogAgents();expect(changed.find((s:any)=>s.instance==="support").incarnation).not.toBe(token);
  expect(memberAgentCatalog(true,changed).revision).not.toBe(catalog.revision);
});
it("does not expose ambiguous Fleet/Classic names as shareable rows",()=>{
  const root=mkdtempSync(join(tmpdir(),"agend-share-ambiguous-"));roots.push(root);const fm=new FleetManager(root);
  fm.fleetConfig={defaults:{},instances:{same:{backend:"codex",working_directory:root}}} as never;
  const classic=new ClassicChannelManager(root,fm.logger);classic.register("111111111111111111","fixture-adapter","same","Example room","fixture-owner","codex");fm.classicChannels=classic;
  expect((fm as any).hubCatalogAgents()).toEqual([]);
});
