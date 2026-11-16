import { describe, expect, it, vi } from "vitest";
import { probeNativeClis, type NativeProbeOptions } from "../src/windows-cli-worker.js";
function options():NativeProbeOptions {
  return {personal:true,personalFolder:"C:\\Shared",find:async id=>({path:`C:\\Tools\\${id}.exe`,command:`C:\\Tools\\${id}.exe`,args:[]}),
    run:async()=>({ok:true,text:'--json --sandbox --print --output-format --input-format --permission-prompts --tools --strict-mcp-config --mcp-config --allowedTools --config Logged in using ChatGPT'}),
    readModels:()=>[],personalCheck:async cli=>cli==="codex"?"sandbox-unavailable":"ready"};
}
describe("independent per-computer personal profile detection",()=>{
  it("keeps Claude's result when Codex cannot enforce its sandbox, regardless of versions",async()=>{
    const value=options(),check=vi.fn(value.personalCheck!);value.personalCheck=check;
    const result=await probeNativeClis(value);
    expect(result.clis.map(row=>[row.id,row.personalStatus])).toEqual([["codex","sandbox-unavailable"],["claude-code","ready"]]);
    expect(check).toHaveBeenCalledTimes(2);expect(check.mock.calls.every(([, ,folder])=>folder==="C:\\Shared")).toBe(true);
  });
  it("refuses missing local folder binding before starting discovery",async()=>{
    const value=options(),find=vi.fn(value.find!);value.find=find;delete value.personalFolder;
    await expect(probeNativeClis(value)).rejects.toThrow(/locally bound folder/);expect(find).not.toHaveBeenCalled();
  });
});
