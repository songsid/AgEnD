import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs/promises",async original=>({...await original<typeof import("node:fs/promises")>(),access:vi.fn(async()=>{throw new Error("Linux directory access forbidden in this fixture");})}));
import { access } from "node:fs/promises";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { CreateInstanceArgs } from "../src/outbound-schemas.js";
import type { SettingsExecution } from "../src/settings-transaction.js";

const result={name:"windows-native-id",runtime:"windows",agent:{id:"12345678-1234-4321-abcd-123456789012",cwd:"C:\\Users\\Test\\.agend\\workspaces\\12345678-1234-4321-abcd-123456789012"}};
function fixture(){
  const create=vi.fn(async(_input:Record<string,unknown>,_authorized:()=>boolean,_execution?:SettingsExecution)=>result as any);
  const stopping=vi.fn(()=>false);
  const ctx={fleetConfig:{instances:{},defaults:{backend:"claude-code"}},isPlannedRestart:stopping,nativeInstanceRuntime:()=>({create}),getInstanceDir:vi.fn(()=>{throw Error("Linux instance directory must not be touched");})} as unknown as LifecycleContext;
  const lifecycle=new InstanceLifecycle(ctx),respond=vi.fn();
  return {create,ctx,stopping,lifecycle,respond};
}
beforeEach(()=>{vi.clearAllMocks();});

describe("create_instance runtime dispatch",()=>{
  it("documents and preserves the Windows runtime and explicit file policy in the MCP schema",()=>{
    expect(CreateInstanceArgs.parse({runtime:"windows",sandbox:"workspace-write",topic_name:"Native",backend:"grok"})).toMatchObject({runtime:"windows",sandbox:"workspace-write",backend:"grok"});
    expect(CreateInstanceArgs.safeParse({runtime:"other",topic_name:"Bad"}).success).toBe(false);
    expect(CreateInstanceArgs.safeParse({runtime:"windows",sandbox:"danger-full-access",topic_name:"Bad"}).success).toBe(false);
  });
  it("creates an independent native workspace through the shared registry without Linux operations",async()=>{
    const f=fixture();await f.lifecycle.handleCreate({runtime:"windows",topic_name:"General assistant"},f.respond);
    expect(f.create).toHaveBeenCalledWith({name:"General assistant",cli:"codex",cwd:undefined,model:undefined,description:"",instructions:"",sandbox:"read-only"},expect.any(Function),undefined);
    expect(f.respond).toHaveBeenCalledWith(result);expect(access).not.toHaveBeenCalled();expect(f.ctx.getInstanceDir).not.toHaveBeenCalled();
  });
  it("uses Windows basename and forwards native fields without resolving a Linux path",async()=>{
    const f=fixture();await f.lifecycle.handleCreate({runtime:"windows",directory:"J:\\Work\\Native assistant\\",backend:"grok",model:"grok-code-fast-1",sandbox:"workspace-write",description:"Native tools",systemPrompt:"Use the specified CLI",tags:["native"]},f.respond);
    expect(f.create.mock.calls[0][0]).toEqual({name:"Native assistant",cwd:"J:\\Work\\Native assistant\\",cli:"grok",model:"grok-code-fast-1",sandbox:"workspace-write",description:"Native tools",instructions:"Use the specified CLI",tags:["native"]});
    expect(access).not.toHaveBeenCalled();expect(f.respond).toHaveBeenCalledWith(result);
  });
  it.each(["branch","detach","worktree_path","backend_options","workflow","start_point","tool_set","skipPermissions","lightweight","model_failover","unknown_option"])("refuses unsupported native %s before starting any work",async field=>{
    const f=fixture();await f.lifecycle.handleCreate({runtime:"windows",topic_name:"Bad",[field]:field==="detach"?false:"value"},f.respond);
    expect(f.create).not.toHaveBeenCalled();expect(access).not.toHaveBeenCalled();expect(f.respond.mock.calls[0][1]).toContain(field);
  });
  it("rejects oversized native metadata before handing it to the adapter",async()=>{
    const f=fixture();await f.lifecycle.handleCreate({runtime:"windows",topic_name:"Bad",tags:["x".repeat(65)]},f.respond);
    expect(f.create).not.toHaveBeenCalled();expect(f.respond.mock.calls[0][1]).toContain("tags");
  });
  it("does not fall back to Linux when a runtime is unknown or unavailable",async()=>{
    const f=fixture();await f.lifecycle.handleCreate({runtime:"other" as any,topic_name:"Bad"},f.respond);
    expect(f.respond.mock.calls[0][1]).toContain("Unknown instance runtime");
    (f.ctx as any).nativeInstanceRuntime=undefined;await f.lifecycle.handleCreate({runtime:"windows",topic_name:"Bad"},f.respond);
    expect(f.respond.mock.calls.at(-1)?.[1]).toContain("Windows runtime is unavailable");expect(access).not.toHaveBeenCalled();
  });
  it("refuses creation while the fleet is stopping",async()=>{
    const f=fixture();f.stopping.mockReturnValue(true);await f.lifecycle.handleCreate({runtime:"windows",topic_name:"Later"},f.respond);
    expect(f.create).not.toHaveBeenCalled();expect(f.respond.mock.calls[0][1]).toContain("stopping");
  });
  it("passes the same settings execution to the native adapter and rechecks before its deferred mutation",async()=>{
    const f=fixture();let alive=true,release!:()=>void,created=false;
    const hold=new Promise<void>(done=>{release=done;});
    const execution={assert:vi.fn(()=>{if(!alive)throw Error("settings_execution_stale");})} as unknown as SettingsExecution;
    f.create.mockImplementationOnce(async(_input,authorized,passed)=>{expect(passed).toBe(execution);expect(authorized()).toBe(true);await hold;authorized();created=true;return result as any;});
    const pending=f.lifecycle.handleCreate({runtime:"windows",topic_name:"Held"},f.respond,undefined,execution);
    await Promise.resolve();alive=false;release();await pending;
    expect(created).toBe(false);expect(f.respond.mock.calls[0][1]).toContain("settings_execution_stale");expect(access).not.toHaveBeenCalled();
  });
  it("keeps explicit WSL creation on its existing Linux validation path",async()=>{
    const f=fixture();await f.lifecycle.handleCreate({runtime:"wsl",directory:"/missing/linux/path",topic_name:"Linux"},f.respond);
    expect(access).toHaveBeenCalledWith("/missing/linux/path");expect(f.create).not.toHaveBeenCalled();expect(f.respond.mock.calls[0][1]).toContain("Directory does not exist");
  });
  it("does not silently treat a Windows sandbox policy as a Linux option",async()=>{
    const f=fixture();await f.lifecycle.handleCreate({topic_name:"Linux",sandbox:"read-only"},f.respond);
    expect(f.respond.mock.calls[0][1]).toContain("only by the Windows runtime");expect(access).not.toHaveBeenCalled();
  });
});
