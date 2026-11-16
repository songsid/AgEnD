import { describe, expect, it } from "vitest";
import { stagePersonalAgent, type PersonalStageHost } from "../src/runtime-personal-stage.js";
const shared = "C:\\Users\\Alex\\Hub agent";
function fixture() {
  const files = new Map<string,string>(), reads:string[]=[];let cleaned=0,created=0;
  files.set("C:\\Users\\Alex\\.codex\\auth.json", JSON.stringify({ auth_mode:"chatgpt",tokens:{access_token:"owner-access",refresh_token:"owner-refresh",account_id:"owner"},hooks:{command:"never-copy"} }));
  files.set("C:\\Users\\Alex\\.claude\\.credentials.json", JSON.stringify({ claudeAiOauth:{accessToken:"owner-access",refreshToken:"owner-refresh"},mcpServers:{private:{command:"never-copy"}} }));
  files.set("C:\\Users\\Alex\\.codex\\config.toml", "private-canary");
  const host:PersonalStageHost={ platform:"win32",userHome:"C:\\Users\\Alex",environment:{SystemRoot:"C:\\Windows",LOCALAPPDATA:"C:\\Users\\Alex\\AppData\\Local"},
    realDirectory:p=>p,readPrivate:p=>{reads.push(p);if(!files.has(p))throw Error("private-file-error");return files.get(p)!;},
    writePrivate:(p,v)=>{expect(files.has(p)).toBe(false);files.set(p,v);},create:()=>{created++;return {work:"C:\\Private\\job\\work",home:"C:\\Private\\job\\auth",cleanup:()=>{cleaned++;for(const p of files.keys())if(p.startsWith("C:\\Private\\job\\"))files.delete(p);}};} };
  const input={cli:"codex" as const,question:"When is the meeting?",folder:shared,runtimeReads:["C:\\Tools\\Codex"]};
  return {host,files,reads,input,get cleaned(){return cleaned;},get created(){return created;}};
}
describe("worker-owned personal authentication staging",()=>{
  it("copies only the selected account's authentication and generates its own profile",()=>{
    const f=fixture(),source=f.files.get("C:\\Users\\Alex\\.codex\\auth.json");const s=stagePersonalAgent(f.input,f.host);
    expect(f.reads).toEqual(["C:\\Users\\Alex\\.codex\\auth.json"]);expect(s.plan.args).toContain("--strict-config");
    expect(f.files.get("C:\\Private\\job\\auth\\auth.json")).not.toContain("never-copy");
    expect(f.files.get("C:\\Private\\job\\auth\\config.toml")).not.toContain("private-canary");
    expect(f.files.get("C:\\Users\\Alex\\.codex\\auth.json")).toBe(source);s.cleanup();expect(f.cleaned).toBe(1);
    expect(f.files.has("C:\\Users\\Alex\\.codex\\auth.json")).toBe(true);
  });
  it("copies Claude OAuth without its personal connectors or settings",()=>{
    const f=fixture();const s=stagePersonalAgent({...f.input,cli:"claude-code"},f.host);
    expect(f.reads).toEqual(["C:\\Users\\Alex\\.claude\\.credentials.json"]);
    expect(f.files.get("C:\\Private\\job\\auth\\.credentials.json")).not.toContain("mcpServers");
    expect(s.plan.args[s.plan.args.indexOf("--tools")+1]).toBe("Read,Glob,Grep");s.cleanup();
  });
  it("refuses missing selected authentication without falling back to another login",()=>{
    const f=fixture();f.host.environment.CODEX_HOME="D:\\Selected";
    expect(()=>stagePersonalAgent(f.input,f.host)).toThrow("authentication-unavailable");expect(f.reads).toEqual(["D:\\Selected\\auth.json"]);expect(f.cleaned).toBe(1);
  });
  it("refuses unsupported platforms or bad folders before touching authentication",()=>{
    const f=fixture();f.host.platform="linux";expect(()=>stagePersonalAgent(f.input,f.host)).toThrow("unsupported-platform");
    f.host.platform="win32";f.host.realDirectory=p=>p===shared?"C:\\Windows":p;
    expect(()=>stagePersonalAgent(f.input,f.host)).toThrow("folder-invalid");expect(f.reads).toEqual([]);expect(f.created).toBe(0);
  });
  it("refuses ambiguous local account selection rather than choosing a spelling",()=>{
    const f=fixture();f.host.environment.CODEX_HOME="D:\\One";f.host.environment.codex_home="D:\\Two";
    expect(()=>stagePersonalAgent(f.input,f.host)).toThrow("profile-unavailable");expect(f.reads).toEqual([]);
  });
});
