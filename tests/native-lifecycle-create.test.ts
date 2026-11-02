import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs/promises",async original=>({...await original<typeof import("node:fs/promises")>(),access:vi.fn(async()=>{throw new Error("Linux directory access forbidden in this fixture");})}));
import { access } from "node:fs/promises";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
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

describe("create_instance runtime dispatch (M-2239: Windows is web-only)",()=>{
  it("does not fall back to Linux when a runtime is unknown",async()=>{
    const f=fixture();await f.lifecycle.handleCreate({runtime:"other" as any,topic_name:"Bad"},f.respond);
    expect(f.respond.mock.calls[0][1]).toContain("Unknown instance runtime");expect(access).not.toHaveBeenCalled();
  });
  it("M-2239 P1-1: a Windows runtime is refused here — only the admin web dashboard creates one",async()=>{
    const f=fixture();await f.lifecycle.handleCreate({runtime:"windows",topic_name:"Native",directory:"J:\\Work"},f.respond);
    expect(f.respond).toHaveBeenCalledWith(null,expect.stringContaining("web dashboard"));
    expect(f.create).not.toHaveBeenCalled();expect(access).not.toHaveBeenCalled();expect(f.ctx.getInstanceDir).not.toHaveBeenCalled();
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
