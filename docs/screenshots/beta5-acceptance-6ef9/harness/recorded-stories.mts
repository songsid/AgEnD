// Additional offline observations from the frozen product and recorded panes; never starts a backend CLI.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
const repo=process.env.REPO!,out=process.env.OUT!;
const {ClaudeCodeBackend}=await import(repo+"/src/backend/claude-code.ts");
const {MuseBackend,museApprovalRequestIdentity}=await import(repo+"/src/backend/muse.ts");
const inputs:Record<string,string>={};
const read=(path:string)=>{const value=readFileSync(repo+"/"+path,"utf8");inputs[path]=createHash("sha256").update(value).digest("hex");return value;};
const frame=(name:string)=>read("tests/fixtures/"+name+".pane.txt");
const active=(backend:any,pane:string,kind="runtime")=>(kind==="startup"?backend.getStartupDialogs():backend.getRuntimeDialogs()).filter((d:any)=>{d.pattern.lastIndex=0;return d.isActive?d.isActive(pane):d.pattern.test(pane);});
const view=(d:any)=>({keys:d.keys,holdOnly:d.holdOnly??false,blocksDelivery:d.blocksDelivery??false,inputBlocked:d.inputBlocked??false,interactionKind:d.interactionKind??null,retrySafe:d.retrySafe??null});
const claude=new ClaudeCodeBackend(process.env.HOME+"/claude-observation");
const cold=frame("claude-2.1.322-cold-resume-live-summary-newfocus");
const coldDialog=active(claude,cold,"startup")[0];
assert.deepEqual(coldDialog.retrySafe,{max:3,afterMs:1000});assert.deepEqual(coldDialog.keys,["Escape"]);
const files=["claude-2.1.322-file-send-plain","claude-2.1.322-file-send-plain-two","claude-2.1.322-file-send-lookalike"].map(name=>{
 const hit=active(claude,frame(name));assert.equal(hit.length,1);assert.equal(hit[0].holdOnly,true);assert.deepEqual(hit[0].keys,[]);return{name,...view(hit[0])};
});
const danger=active(claude,frame("claude-2.1.322-bypass-dangerous-rm-prompt"))[0];
assert.equal(danger.interactionKind,"dangerous_command");assert.deepEqual(danger.keys,["Down","Enter"]);
const muse=new MuseBackend(process.env.HOME+"/muse-observation");
const escalated=frame("muse-1.4.15/approval-escalated");const permission=active(muse,escalated)[0];
assert.equal(permission.holdOnly,true);assert.deepEqual(permission.keys,[]);assert.equal(museApprovalRequestIdentity(escalated),"echo hi");
const test=read("tests/muse-1.4.15-audit.test.ts");
const catalog=JSON.parse(/const CATALOG = (\[[\s\S]*?\]);/.exec(test)![1].replace(/,\s*\]$/u,"]")) as string[];assert.equal(catalog.length,23);
const idle=frame("muse-1.4.15/meta-done");
const composer=(text:string)=>idle.split("\n").map(l=>l==="❯"?"❯ "+text:l).join("\n");
const tips=catalog.map(tip=>{const pane=composer(tip);const draft=muse.inputDraft(pane)?.rows;assert.equal(muse.isPeriodicRedrawIdlePane(pane),true);assert.deepEqual(draft,[]);return{tip,idle:true,draftRows:draft};});
for(const typed of ["/effort adjusts reasoning","/effort adjusts reasoning depth vs speed now"]){assert.equal(muse.isPeriodicRedrawIdlePane(composer(typed)),false);assert.deepEqual(muse.inputDraft(composer(typed))?.rows,[typed]);}
const result={candidate:execFileSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).trim(),scope:"Production backend parsers with recorded fixtures, no CLI/model/account/network. Retry timing and answered-dialog readiness exercised separately by the 12-test Daemon suite.",coldResume:view(coldDialog),fileCards:files,dangerousCommand:view(danger),museEscalated:{...view(permission),identity:museApprovalRequestIdentity(escalated)},tips,typedControls:2,inputs};
writeFileSync(out,JSON.stringify(result,null,2)+"\n");console.log("PASS: cold-resume bound; 3 file cards held; dangerous card declined; muse escalation held; 23 tips empty and 2 typed controls retained.");
