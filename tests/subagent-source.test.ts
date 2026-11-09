import { mkdtempSync,rmSync } from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,it,expect,vi} from "vitest";
import {Daemon} from "../src/daemon.js";
import {claudeProjectKey} from "../src/backend/claude-code.js";
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
function world(backend="claude-code"){
 const root=mkdtempSync(join(tmpdir(),"agend-subagent-source-"));roots.push(root);
 const logger={info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn()};
 const d:any=new Daemon("dev",{backend,working_directory:root,log_level:"silent",restart_policy:{max_retries:0,backoff:"linear",reset_after:0},context_guardian:{max_age_hours:0,grace_period_ms:600000}} as any,root,false,{binaryName:"inert",getSessionId:()=>null} as any,undefined,{child:()=>logger} as any);
 const sid="11111111-2222-4333-8444-555555555555";let path=join(root,sid+".jsonl");d.transcriptMonitor={currentPath:()=>path};d.tmux={getWindowId:()=>"@1"};
 return {d,root,sid,setPath:(p:string)=>path=p};
}
describe("only the current owned transcript supplies child evidence",()=>{
 it("uses the selected profile's Claude project root, exact session and launch owner",()=>{
  const {d,root,sid}=world();d.claudeConfigDir=()=>join(root,"selected-profile");const first=d.subagentSource();
  expect(first).toMatchObject({backend:"claude-code",sessionId:sid,cwd:root,path:join(root,sid+".jsonl"),root:join(root,"selected-profile/projects",claudeProjectKey(root))});
  d.launchFenceEpoch++;expect(d.subagentSource().owner).not.toBe(first.owner);
 });
 it.each(["no-monitor","no-tmux","stopped","spawning","frozen","bad-session","wrong-claude-filename"])("offers nothing for %s",condition=>{
  const {d,root,sid,setPath}=world();if(condition==="no-monitor")d.transcriptMonitor=null;if(condition==="no-tmux")d.tmux=null;if(condition==="stopped")d.processStatus="stopped";if(condition==="spawning")d.spawning=true;if(condition==="frozen")d.runtimeMonitorsFrozen=true;if(condition==="bad-session")setPath(join(root,"arbitrary.jsonl"));if(condition==="wrong-claude-filename")setPath(join(root,"rollout-"+sid+".jsonl"));expect(d.subagentSource()).toBeNull();
 });
 it.each(["kiro","opencode","muse"])("does not widen unsupported %s history",backend=>{expect(world(backend).d.subagentSource()).toBeNull();});
 it("derives the Codex UUID only from its selected rollout, not cwd latest discovery",()=>{const {d,root,sid,setPath}=world("codex");setPath(join(root,"rollout-2026-11-09T15-18-16-"+sid+".jsonl"));expect(d.subagentSource()).toMatchObject({backend:"codex",sessionId:sid,cwd:root});expect(d.subagentSource().root).toMatch(/sessions$/);});
});
