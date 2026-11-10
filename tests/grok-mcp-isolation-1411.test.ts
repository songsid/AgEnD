/** #1411: the real config writer/launch command with an owned fake Grok and owned MCP children only. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as atomic from "../src/atomic-write.js";
import { legacyGrokMcpKey } from "../src/backend/grok-mcp.js";
import { GrokBackend } from "../src/backend/grok.js";
import { shellQuote, type CliBackendConfig } from "../src/backend/types.js";
const rigs: Array<{root: string; socket: Server}> = [];
afterEach(async () => { vi.restoreAllMocks();for (const r of rigs.splice(0)) { await new Promise<void>(done => r.socket.close(() => done())); rmSync(r.root, {recursive:true,force:true}); } });
async function rig() {
  const root=mkdtempSync(join(tmpdir(),"agend-grok-1411-")),socket=createServer(),socketPath=join(root,"s");
  rigs.push({root,socket}); await new Promise<void>((done,fail)=>{socket.once("error",fail);socket.listen(socketPath,done);});
  const cwd=join(root,"work"),child=join(root,"owned-mcp.cjs"),fake=join(root,"fake-grok.cjs");mkdirSync(cwd);
  writeFileSync(child,'console.log(JSON.stringify({instance:process.env.AGEND_INSTANCE_NAME,toolSet:process.env.AGEND_TOOL_SET}));\n');
  // Model only project MCP discovery. Every command comes from this fixture's own writer; no vendor or real CLI.
  writeFileSync(fake,`const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');
// A configured shared leader would reuse the first launch's environment.\nconst envFile=p.join(process.env.HOME,'fake-shared-leader.json');\nif(!process.argv.includes('--no-leader')){if(fs.existsSync(envFile))Object.assign(process.env,JSON.parse(fs.readFileSync(envFile,'utf8')));else fs.writeFileSync(envFile,JSON.stringify({AGEND_GROK_MCP_DIR:process.env.AGEND_GROK_MCP_DIR,AGEND_GROK_MCP_BINDING:process.env.AGEND_GROK_MCP_BINDING}));}\nconst c=JSON.parse(fs.readFileSync(p.join(process.cwd(),'.mcp.json'),'utf8'));
const rows=Object.entries(c.mcpServers).map(([key,e])=>{const r=cp.spawnSync(e.command,e.args||[],{env:process.env,encoding:'utf8',timeout:2000});
if(r.status!==0)throw Error('fixture MCP child failed '+r.stderr);return{key,...JSON.parse(r.stdout)}});console.log(JSON.stringify(rows));`);
  function agent(name:string,toolSet="developer") {
    const dir=join(root,"instances",name);mkdirSync(dir,{recursive:true});const backend=new GrokBackend(dir);
    (backend as unknown as {binaryPath:string}).binaryPath=`${shellQuote(process.execPath)} ${shellQuote(fake)}`;
    const config={workingDirectory:cwd,instanceDir:dir,instanceName:name,mcpServers:{agend:{command:process.execPath,args:[child],env:{AGEND_SOCKET_PATH:socketPath,AGEND_TOOL_SET:toolSet}}}} as CliBackendConfig;
    backend.writeConfig(config);return{backend,config};
  }
  function raw(a:ReturnType<typeof agent>, change=(s:string)=>s) {
    return spawnSync("/bin/sh",["-c",change(a.backend.buildCommand(a.config))],{cwd,env:{HOME:root,PATH:"/usr/bin:/bin",...(process.env.NODE_OPTIONS?{NODE_OPTIONS:process.env.NODE_OPTIONS}:{}),...(process.env.AGEND_TEST_GUARD_LOG?{AGEND_TEST_GUARD_LOG:process.env.AGEND_TEST_GUARD_LOG}:{})},encoding:"utf8",timeout:4000});
  }
  function launch(a:ReturnType<typeof agent>) {
    const result=raw(a);expect(result.status,result.stderr).toBe(0);return JSON.parse(result.stdout) as Array<{key:string;instance:string;toolSet:string}>;
  }
  return{root,cwd,agent,launch,raw,fake,child,socketPath};
}
describe("Grok MCP configuration belongs to its launch, not every agent sharing cwd",()=>{
  it("single-agent control keeps its identity and tool set",async()=>{const r=await rig(),a=r.agent("single-worker");expect(r.launch(a).map(x=>[x.instance,x.toolSet])).toEqual([["single-worker","developer"]]);});
  it.each(["worker-a","worker-b"])("%s cannot load the other same-cwd agent's identity/config",async name=>{
    const r=await rig(),a=r.agent("worker-a"),b=r.agent("worker-b","reader");
    expect(r.launch(a).map(x=>x.instance)).toEqual(["worker-a"]);
    expect(r.launch(name==="worker-a"?a:b).map(x=>[x.instance,x.toolSet])).toEqual([[name,name==="worker-a"?"developer":"reader"]]);
  });
  it("forces process-local MCP even if a shared Grok leader is configured",async()=>{
    const r=await rig(),a=r.agent("worker-a"),b=r.agent("worker-b","reader");expect(r.launch(a).map(x=>x.instance)).toEqual(["worker-a"]);expect(r.launch(b).map(x=>x.instance)).toEqual(["worker-b"]);expect(existsSync(join(r.root,"fake-shared-leader.json"))).toBe(false);
  });
  it("an env-less Grok launch gets no AgEnD identity or tools, with a clear error",async()=>{
    const r=await rig();r.agent("single-worker");const result=spawnSync(process.execPath,[r.fake],{cwd:r.cwd,env:{HOME:r.root,PATH:"/usr/bin:/bin"},encoding:"utf8",timeout:4000});
    expect(result.status).not.toBe(0);expect(result.stdout).toBe("");expect(result.stderr).toContain("missing or conflicting Grok launch binding; no tools loaded");
  });
  it("a conflicting directory with the original binding fails closed",async()=>{
    const r=await rig(),a=r.agent("worker-a"),b=r.agent("worker-b");const result=r.raw(a,cmd=>cmd.replace(`AGEND_GROK_MCP_DIR=${shellQuote(a.config.instanceDir)}`,`AGEND_GROK_MCP_DIR=${shellQuote(b.config.instanceDir)}`));
    expect(result.status).not.toBe(0);expect(result.stdout).toBe("");expect(result.stderr).toContain("missing or conflicting Grok launch binding; no tools loaded");
  });
  it("changing the requested config without writing its private binding loads nothing",async()=>{
    const r=await rig(),a=r.agent("worker-a");a.config.instanceName="someone-else";const result=r.raw(a);expect(result.status).not.toBe(0);expect(result.stdout).toBe("");expect(result.stderr).toContain("no tools loaded");
  });
  it("the shared shim has no identity, socket or launch binding; user entry bytes survive every write",async()=>{
    const r=await rig();
    // A deliberately oddly spaced, valid entry. The fixture does not execute this user command.
    const entry='"user": { "command" : "example", "args": [ "a",  "b" ] } \t\n';
    writeFileSync(join(r.cwd,".mcp.json"),' { "other" : [ 1,  2 ], "mcpServers": { '+entry+' } }\n');
    r.agent("worker-a");const first=readFileSync(join(r.cwd,".mcp.json"),"utf8");r.agent("worker-b");const second=readFileSync(join(r.cwd,".mcp.json"),"utf8");
    expect(first).toContain(entry);expect(first).toContain('"other" : [ 1,  2 ]');expect(second).toBe(first);expect(second).not.toMatch(/worker-[ab]|AGEND_INSTANCE_NAME|AGEND_SOCKET_PATH|AGEND_TOOL_SET/);
  });
  it("cleanup of A keeps B's shared shim, identity and tool set",async()=>{
    const r=await rig(),a=r.agent("worker-a"),b=r.agent("worker-b","reader");a.backend.cleanup(a.config);expect(r.launch(b).map(x=>[x.instance,x.toolSet])).toEqual([["worker-b","reader"]]);expect(r.raw(a).stdout).toBe("");
  });
  it("CJK, spaces and shell metacharacters stay in the private identity only",async()=>{
    const r=await rig(),name="審閱 Agent ' $HOME",a=r.agent(name);expect(r.launch(a).map(x=>x.instance)).toEqual([name]);expect(readFileSync(join(r.cwd,".mcp.json"),"utf8")).not.toContain(name);
  });
  it("migrates only proven same-fleet generated wrappers, including a CJK key; user bytes survive",async()=>{
    const r=await rig();const entries:Record<string,unknown>={};
    for(const name of["old-a","審閱者"]){const dir=join(r.root,"instances",name);mkdirSync(dir,{recursive:true});const path=join(dir,"mcp-wrapper-agend.sh");
      writeFileSync(path,`#!/bin/bash\nexport AGEND_SOCKET_PATH=${shellQuote(r.socketPath)}\nexport AGEND_INSTANCE_NAME=${shellQuote(name)}\n# Wait for IPC socket to be ready (up to 10s)\nfor i in $(seq 1 20); do [ -S "$AGEND_SOCKET_PATH" ] && break; sleep 0.5; done\nexec ${shellQuote(process.execPath)} ${shellQuote(r.child)}\n`,{mode:0o700});entries[legacyGrokMcpKey("agend",name)]={command:path,args:[]};}
    const user='"agend-user": { "command" : "user-server", "args" : [ "one",  "two" ] }';
    writeFileSync(join(r.cwd,".mcp.json"),'{"keep":"untouched", "mcpServers": {'+Object.entries(entries).map(([k,v])=>JSON.stringify(k)+':'+JSON.stringify(v)).join(',')+','+user+'}}');
    r.agent("new-worker");const text=readFileSync(join(r.cwd,".mcp.json"),"utf8");expect(text).toContain(user);expect(text).toContain('"keep":"untouched"');expect(Object.keys(JSON.parse(text).mcpServers)).toEqual(["agend-user","agend"]);
  });
  it("migrates a canonical old wrapper with properly quoted multiline prompt and description",async()=>{
    const r=await rig(),name="old-worker",dir=join(r.root,"instances",name);mkdirSync(dir,{recursive:true});const path=join(dir,"mcp-wrapper-agend.sh");
    writeFileSync(path,`#!/bin/bash\nexport AGEND_SOCKET_PATH=${shellQuote(r.socketPath)}\nexport AGEND_INSTANCE_NAME=${shellQuote(name)}\nexport AGEND_CUSTOM_PROMPT=${shellQuote("first-line\nsecond-line 'quoted' $HOME")}\nexport AGEND_DESCRIPTION=${shellQuote("description\nnext line")}\n# Wait for IPC socket to be ready (up to 10s)\nfor i in $(seq 1 20); do [ -S "$AGEND_SOCKET_PATH" ] && break; sleep 0.5; done\nexec ${shellQuote(process.execPath)} ${shellQuote(r.child)}\n`);
    writeFileSync(join(r.cwd,".mcp.json"),JSON.stringify({mcpServers:{"agend-old-worker":{command:path,args:[]}}}));const a=r.agent("new-worker");expect(Object.keys(JSON.parse(readFileSync(join(r.cwd,".mcp.json"),"utf8")).mcpServers)).toEqual(["agend"]);expect(r.launch(a).map(x=>x.instance)).toEqual(["new-worker"]);
  });
  it.each(["foreign","wrong-key","symlink","extra-script"])("refuses a %s old identity-bearing entry without touching user config",async kind=>{
    const r=await rig(),dir=join(r.root,kind==="foreign"?"other-fleet":"instances","old-worker");mkdirSync(dir,{recursive:true});const real=join(dir,"mcp-wrapper-agend.sh");
    const body=`#!/bin/bash\nexport AGEND_SOCKET_PATH=${shellQuote(r.socketPath)}\nexport AGEND_INSTANCE_NAME='old-worker'\n# Wait for IPC socket to be ready (up to 10s)\nfor i in $(seq 1 20); do [ -S "$AGEND_SOCKET_PATH" ] && break; sleep 0.5; done\nexec ${shellQuote(process.execPath)} ${shellQuote(r.child)}\n`;
    const saved=kind==="extra-script"?body.replace("\nexec ", "\necho user-extra-script\nexec "):body;writeFileSync(real,saved);let path=real;if(kind==="symlink"){const d=join(r.root,"links","old-worker");mkdirSync(d,{recursive:true});path=join(d,"mcp-wrapper-agend.sh");symlinkSync(real,path);}
    const text=JSON.stringify({mcpServers:{[kind==="wrong-key"?"someone-else":"agend-old-worker"]:{command:path,args:[]}}});writeFileSync(join(r.cwd,".mcp.json"),text);
    expect(()=>r.agent("new-worker")).toThrow(/legacy AgEnD binding/);expect(readFileSync(join(r.cwd,".mcp.json"),"utf8")).toBe(text);expect(readFileSync(real,"utf8")).toBe(saved);
  });
  it.each(['{broken','{"mcpServers": []}','{"mcpServers":{},"mcpServers":{}}','{"mcpServers":{"agend":{"command":"user-command"}}}'])("malformed/ambiguous/conflicting project remains unchanged: %s",async text=>{
    const r=await rig();writeFileSync(join(r.cwd,".mcp.json"),text);expect(()=>r.agent("a")).toThrow();expect(readFileSync(join(r.cwd,".mcp.json"),"utf8")).toBe(text);
  });
  it("private manifest and wrapper stay owner-only",async()=>{const r=await rig(),a=r.agent("a");expect(statSync(a.config.instanceDir).mode&0o777).toBe(0o700);expect(statSync(join(a.config.instanceDir,"grok-mcp.json")).mode&0o777).toBe(0o600);expect(statSync(join(a.config.instanceDir,"mcp-wrapper-agend.sh")).mode&0o777).toBe(0o700);});
  it("a concurrent project edit before rename is kept and refuses launch preparation",async()=>{
    const r=await rig(),path=join(r.cwd,".mcp.json"),real=atomic.atomicWriteFileSync,changed='{"mcpServers":{}, "userEdit":"keep"}';
    vi.spyOn(atomic,"atomicWriteFileSync").mockImplementation((p,data,opts)=>real(p,data,{...opts,beforeRename:tmp=>{if(p===path)writeFileSync(path,changed);opts?.beforeRename?.(tmp);}}));
    expect(()=>r.agent("a")).toThrow(/changed during preparation/);expect(readFileSync(path,"utf8")).toBe(changed);expect(existsSync(join(r.root,"instances","a","grok-mcp.json"))).toBe(false);
  });

  it("a copied wrapper at another directory still refuses its conflicting directory",async()=>{
    const r=await rig(),a=r.agent("worker-a"),b=r.agent("worker-b");writeFileSync(join(b.config.instanceDir,"mcp-wrapper-agend.sh"),readFileSync(join(a.config.instanceDir,"mcp-wrapper-agend.sh")));
    const result=r.raw(a,cmd=>cmd.replace(`AGEND_GROK_MCP_DIR=${shellQuote(a.config.instanceDir)}`,`AGEND_GROK_MCP_DIR=${shellQuote(b.config.instanceDir)}`));expect(result.status).not.toBe(0);expect(result.stdout).toBe("");expect(result.stderr).toContain("no tools loaded");
  });
  it("a tool-set change without rewriting private config is unbound",async()=>{
    const r=await rig(),a=r.agent("a");a.config.mcpServers.agend.env.AGEND_TOOL_SET="reader";const result=r.raw(a);expect(result.status).not.toBe(0);expect(result.stdout).toBe("");expect(result.stderr).toContain("no tools loaded");
  });
  it("a canonical-looking user wrapper without the generated contour is not migrated",async()=>{
    const r=await rig(),dir=join(r.root,"instances","user");mkdirSync(dir,{recursive:true});const path=join(dir,"mcp-wrapper-agend.sh");writeFileSync(path,"#!/bin/bash\necho user-owned\n");
    const entry='"agend-user" : { "command" : '+JSON.stringify(path)+', "args" : [] }';writeFileSync(join(r.cwd,".mcp.json"),'{"mcpServers":{'+entry+'}}');r.agent("a");expect(readFileSync(join(r.cwd,".mcp.json"),"utf8")).toContain(entry);expect(readFileSync(path,"utf8")).toContain("user-owned");
  });

});
