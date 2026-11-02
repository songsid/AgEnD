import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WindowsAgents } from "../src/windows-agents.js";
import { codexTaskArgs, type NativeTaskInput } from "../src/windows-cli-worker.js";
import type { WindowsCliBridge, WindowsCliTask, WindowsRunOptions } from "../src/windows-cli.js";
const dirs: string[] = [];
const input = { name:"Godot", cwd:"J:\\Game", description:"Game tools", instructions:"Use Windows tools", sandbox:"read-only" };
const first = "12345678-1234-4321-abcd-123456789012", second = "12345678-1234-4321-abcd-123456789013";
afterEach(() => { for (const dir of dirs.splice(0)) { if (!resolve(dir).startsWith(resolve(tmpdir()) + "/") && !resolve(dir).startsWith(resolve(tmpdir()) + "\\")) throw Error("Unsafe scratch directory"); rmSync(dir,{recursive:true,force:true}); } });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(),"agend-winagents-")); dirs.push(dir);
  const start = vi.fn((value: NativeTaskInput, _auth: () => boolean, _options: WindowsRunOptions): WindowsCliTask => ({id:value.requestId,cli:value.cli,...(value.model ? { model:value.model } : {}),cwd:value.cwd,sandbox:value.sandbox,status:"starting",output:"",startedAt:1}));
  const prepareWorkspace = vi.fn(async (id: string) => `C:\\Users\\Test\\.agend\\workspaces\\${id}`);
  const bridge = { start, prepareWorkspace, get:vi.fn(() => null), releaseUnknown:vi.fn() } as unknown as WindowsCliBridge;
  return { dir, bridge, start, prepareWorkspace, store:new WindowsAgents(dir,bridge) };
}
describe("native Windows agents", () => {
  it("forwards the execution-only MCP lease and context without storing them in conversations",async()=>{
    const f=fixture(),agent=await f.store.create(input);
    const mcp={endpoint:"http://127.0.0.1:19280/agent",token:"a".repeat(64),tools:["query_task"]},context="from_instance: coordinator; correlation_id: test-context";
    f.store.send(agent.id,{requestId:first,prompt:"raw user prompt"},()=>true,{mcp,context});
    expect(f.start.mock.calls[0][2]).toMatchObject({mcp,context});
    expect(f.store.get(agent.id).turns[0].prompt).toBe("raw user prompt");
    const stored=readFileSync(join(f.dir,"windows-agents.json"),"utf8");
    expect(stored).not.toContain(mcp.token);expect(stored).not.toContain(context);expect(stored).not.toContain(mcp.endpoint);
  });
  it.each([undefined,"","   "])("creates a distinct durable workspace when cwd is %j", async cwd => {
    const f=fixture(), agent=await f.store.create({...input,cwd});
    expect(f.prepareWorkspace).toHaveBeenCalledWith(agent.id,expect.any(Function));
    expect(agent.cwd).toBe(`C:\\Users\\Test\\.agend\\workspaces\\${agent.id}`);
    expect(new WindowsAgents(f.dir,f.bridge).get(agent.id).cwd).toBe(agent.cwd);
    const other=await f.store.create({...input,name:"Other",cwd:""});
    expect(other.cwd).not.toBe(agent.cwd);
    f.store.send(agent.id,{requestId:first,prompt:"hello"},()=>true);
    expect(f.start.mock.calls[0][0].cwd).toBe(agent.cwd);
    f.start.mock.calls[0][2].onSettled!({...f.start.mock.results[0].value,status:"completed",threadId:second,outcomeConfirmed:true});
    new WindowsAgents(f.dir,f.bridge).send(agent.id,{requestId:second,prompt:"follow up"},()=>true);
    expect(f.start.mock.calls[1][0].cwd).toBe(agent.cwd);
    expect(f.start.mock.calls[1][2].resumeSessionId).toBe(second);
  });
  it("keeps the name available and stores no phantom profile when workspace preparation fails", async () => {
    const f=fixture(); f.prepareWorkspace.mockRejectedValueOnce(new Error("Disk not available"));
    await expect(f.store.create({...input,cwd:""})).rejects.toThrow("Disk not available");
    expect(f.store.list()).toEqual([]);
    expect(new WindowsAgents(f.dir,f.bridge).list()).toEqual([]);
    expect((await f.store.create({...input,cwd:""})).name).toBe(input.name);
  });
  it("does not persist a prepared workspace after authorization expires", async () => {
    const f=fixture(); let allowed=true, finish!: () => void;
    f.prepareWorkspace.mockImplementationOnce(id=>new Promise(resolve=>{finish=()=>resolve(`C:\\Users\\Test\\.agend\\workspaces\\${id}`);}));
    const pending=f.store.create({...input,cwd:""},()=>allowed);
    allowed=false; finish();
    await expect(pending).rejects.toThrow(/Authorization expired/);
    expect(f.store.list()).toEqual([]);
  });
  it("rechecks duplicate names after concurrent workspace preparation", async () => {
    const f=fixture(), release:Array<()=>void>=[];
    f.prepareWorkspace.mockImplementation(id=>new Promise(resolve=>release.push(()=>resolve(`C:\\Users\\Test\\.agend\\workspaces\\${id}`))));
    const a=f.store.create({...input,cwd:""}), b=f.store.create({...input,name:input.name.toUpperCase(),cwd:""});
    release.forEach(done=>done());
    const results=await Promise.allSettled([a,b]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
    expect(f.store.list()).toHaveLength(1);
  });
  it("rechecks the profile limit after a workspace preparation yields", async () => {
    const f=fixture();
    for(let i=0;i<15;i++)await f.store.create({...input,name:`Agent ${i}`});
    let finish!:()=>void;
    f.prepareWorkspace.mockImplementationOnce(id=>new Promise(resolve=>{finish=()=>resolve(`C:\\Users\\Test\\.agend\\workspaces\\${id}`);}));
    const pending=f.store.create({...input,name:"Waiting",cwd:""});
    await f.store.create({...input,name:"Last"}); finish();
    await expect(pending).rejects.toThrow(/at most 16/);
    expect(f.store.list()).toHaveLength(16);
  });
  it.each([null,false,123,[],"relative","C:\\bad\npath"])("rejects an invalid provided cwd %j rather than treating it as omitted", async cwd => {
    const f=fixture();
    await expect(f.store.create({...input,cwd})).rejects.toThrow(/Windows working directory/);
    expect(f.prepareWorkspace).not.toHaveBeenCalled(); expect(f.store.list()).toEqual([]);
  });
  it("persists a named Windows workspace without creating a Linux/tmux instance", async () => {
    const f=fixture(), agent=await f.store.create(input);
    expect(new WindowsAgents(f.dir,f.bridge).get(agent.id)).toMatchObject({...input,turns:[],blocked:false});
    expect(f.start).not.toHaveBeenCalled();
    expect(f.prepareWorkspace).not.toHaveBeenCalled();
    await expect(f.store.create({...input,cwd:"/mnt/j/Game"})).rejects.toThrow(/Windows/);
    await expect(f.store.create({...input,name:"godot"})).rejects.toThrow(/already/);
  });
  it("claims messages durably, deduplicates them and resumes only that agent's exact thread", async () => {
    const f=fixture(), agent=await f.store.create(input);
    f.store.send(agent.id,{requestId:first,prompt:"hello"},()=>true);
    f.store.send(agent.id,{requestId:first,prompt:"hello"},()=>true);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(() => f.store.send(agent.id,{requestId:first,prompt:"other"},()=>true)).toThrow(/different/);
    const task=f.start.mock.results[0].value;
    f.start.mock.calls[0][2].onSettled!({...task,status:"completed",threadId:second,outcomeConfirmed:true,output:"answer"});
    f.store.send(agent.id,{requestId:second,prompt:"follow up"},()=>true);
    expect(f.start.mock.calls[1][2].resumeSessionId).toBe(second);
    expect(f.start.mock.calls[1][0].prompt).toContain("User task:\nfollow up");
    expect(f.start.mock.calls[0][0].prompt).toContain("Use Windows tools");
  });
  it("blocks a disconnected active conversation after restart until an explicit stopped-process acknowledgement", async () => {
    const f=fixture(), agent=await f.store.create(input);
    f.store.send(agent.id,{requestId:first,prompt:"hello"},()=>true);
    const restored = new WindowsAgents(f.dir,f.bridge);
    expect(restored.get(agent.id).blocked).toBe(true);
    expect(() => restored.send(agent.id,{requestId:second,prompt:"next"},()=>true)).toThrow(/unlock/);
    expect(() => restored.recover(agent.id,false)).toThrow(/Confirm/);
    restored.recover(agent.id,true);
    expect(restored.get(agent.id).blocked).toBe(false);
  });
  it("rolls back a refused submission so no phantom active conversation is left", async () => {
    const f=fixture(), agent=await f.store.create(input);
    f.start.mockImplementationOnce(() => {throw Error("busy");});
    expect(() => f.store.send(agent.id,{requestId:first,prompt:"hello"},()=>true)).toThrow("busy");
    expect(new WindowsAgents(f.dir,f.bridge).get(agent.id)).toMatchObject({turns:[],blocked:false});
  });
  it("resumes a specified UUID through argv while retaining the selected sandbox", () => {
    const args=codexTaskArgs({requestId:first,cli:"codex",cwd:"J:\\Game",prompt:"next",sandbox:"read-only"},second);
    expect(args).toEqual(["-C","J:\\Game","--sandbox","read-only","exec","resume","--json","--skip-git-repo-check",second,"-"]);
    expect(() => codexTaskArgs({requestId:first,cli:"codex",cwd:"J:\\Game",prompt:"next",sandbox:"read-only"},"--last")).toThrow(/conversation/);
  });
  it.each([
    { cli:"claude-code", model:"opus[1m]" },
    { cli:"antigravity", model:"gemini-3.8-flash-medium" },
    { cli:"grok", model:"grok-4.6" },
    { cli:"muse", model:"muse-wonder-1.0" },
  ])("persists $cli and its model across restart and passes both on every turn", async ({cli,model}) => {
    const f=fixture(), agent=await f.store.create({...input,cli,model,sandbox:"workspace-write"});
    const persisted=JSON.parse(readFileSync(join(f.dir,"windows-agents.json"),"utf8"));
    expect(persisted.agents[0]).toMatchObject({id:agent.id,cli,model});
    const restored=new WindowsAgents(f.dir,f.bridge);
    expect(restored.get(agent.id)).toMatchObject({cli,model,sandbox:"workspace-write"});
    restored.send(agent.id,{requestId:first,prompt:"first turn"},()=>true);
    expect(f.start.mock.calls[0][0]).toMatchObject({cli,model});
    f.start.mock.calls[0][2].onSettled!({...f.start.mock.results[0].value,status:"completed",threadId:second,outcomeConfirmed:true,finishedAt:2,output:"answer"});
    const resumed=new WindowsAgents(f.dir,f.bridge);
    resumed.send(agent.id,{requestId:second,prompt:"second turn"},()=>true);
    expect(f.start.mock.calls[1][0]).toMatchObject({cli,model,prompt:expect.stringContaining("User task:\nsecond turn")});
    expect(f.start.mock.calls[1][2].resumeSessionId).toBe(second);
  });
  it("loads legacy version-1 profiles as Codex and keeps their exact saved conversation", () => {
    const f=fixture();
    writeFileSync(join(f.dir,"windows-agents.json"),JSON.stringify({version:1,agents:[{
      ...input,id:first,createdAt:1,threadId:second,turns:[],
    }],requests:{}}));
    const restored=new WindowsAgents(f.dir,f.bridge);
    expect(restored.get(first)).toMatchObject({cli:"codex",threadId:second,blocked:false});
    expect(restored.get(first)).not.toHaveProperty("model");
    restored.send(first,{requestId:first,prompt:"continue legacy conversation"},()=>true);
    expect(f.start.mock.calls[0][0]).toMatchObject({cli:"codex",prompt:expect.stringContaining("User task:\ncontinue legacy conversation")});
    expect(f.start.mock.calls[0][0]).not.toHaveProperty("model");
    expect(f.start.mock.calls[0][2].resumeSessionId).toBe(second);
  });
  it("uses native model defaults for empty values and rejects invalid custom model IDs", async () => {
    const f=fixture(), agent=await f.store.create({...input,cli:"claude-code",model:" "});
    expect(agent).toMatchObject({cli:"claude-code"}); expect(agent).not.toHaveProperty("model");
    f.store.send(agent.id,{requestId:first,prompt:"hello"},()=>true);
    expect(f.start.mock.calls[0][0]).not.toHaveProperty("model");
    await expect(f.store.create({...input,name:"Invalid",model:"sonnet;whoami"})).rejects.toThrow(/model/);
  });
  it.each(["antigravity","grok","opencode","muse"])("refuses to promise read-only access for %s", async cli => {
    const f=fixture();
    await expect(f.store.create({...input,cli})).rejects.toThrow(/read-only/);
    expect(f.store.list()).toEqual([]);
    expect(f.start).not.toHaveBeenCalled();
  });
  it("does not create profiles for unknown CLIs or adapters without verified execution", async () => {
    const f=fixture();
    await expect(f.store.create({...input,cli:"mock"})).rejects.toThrow(/supported Windows CLI/);
    await expect(f.store.create({...input,cli:"kiro-cli",sandbox:"workspace-write"})).rejects.toThrow(/schema/);
    expect(f.store.list()).toEqual([]);
  });
  it("does not present a completed turn as a reusable conversation if the provider supplied no ID", async () => {
    const f=fixture(), agent=await f.store.create({...input,cli:"claude-code"});
    f.store.send(agent.id,{requestId:first,prompt:"hello"},()=>true);
    f.start.mock.calls[0][2].onSettled!({...f.start.mock.results[0].value,status:"completed",outcomeConfirmed:true,finishedAt:2,output:"answer"});
    const restored=new WindowsAgents(f.dir,f.bridge).get(agent.id);
    expect(restored).toMatchObject({cli:"claude-code",blocked:false});
    expect(restored).not.toHaveProperty("threadId");
    expect(restored.turns[0]).toMatchObject({status:"failed",error:expect.stringContaining("no conversation id")});
  });
});
