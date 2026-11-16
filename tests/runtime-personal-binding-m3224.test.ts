import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeClientStore } from "../src/runtime-client-store.js";
const roots: string[] = [];
const fixture = () => { const root=mkdtempSync(join(tmpdir(),"personal-binding-"));roots.push(root);return new RuntimeClientStore(root); };
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true});});
const credentials={server:"https://hub.example.test",machineId:"11111111-2222-4333-8444-555555555555",credential:"a".repeat(64),name:"Computer"};
describe("a locally chosen personal Runtime binding",()=>{
  it("survives a process restart independently of connection credentials",()=>{
    const s=fixture();s.setPersonalAgent("C:\\Shared");s.saveCredentials(credentials);
    expect(new RuntimeClientStore(s.directory).personalAgent()).toEqual({folder:"C:\\Shared"});
    expect(readFileSync(join(s.directory,"connection.json"),"utf8")).not.toContain("Shared");
  });
  it("cannot convert a paired ordinary Runtime or silently change a personal folder",()=>{
    const ordinary=fixture();ordinary.saveCredentials(credentials);expect(()=>ordinary.setPersonalAgent("C:\\Shared")).toThrow(/separate personal/);
    const s=fixture();s.setPersonalAgent("C:\\Shared");s.saveCredentials(credentials);
    expect(()=>s.setPersonalAgent("D:\\Different")).toThrow(/disconnect/);expect(()=>s.setPersonalAgent(undefined)).toThrow(/Disconnect/);
    expect(s.personalAgent()).toEqual({folder:"C:\\Shared"});
  });
  it("fails closed on malformed binding state instead of becoming an ordinary Runtime",()=>{
    const s=fixture();for(const raw of [{version:2,folder:"C:\\Shared"},{version:1,folder:"relative"},{version:1,folder:"C:\\Shared",tools:true}]){
      writeFileSync(join(s.directory,"personal-agent.json"),JSON.stringify(raw),{mode:0o600});
      expect(()=>new RuntimeClientStore(s.directory).personalAgent()).toThrow(/Invalid local personal/);
    }
  });
  it("disconnect forgets the binding along with its credential, without touching shared content",()=>{
    const s=fixture();s.setPersonalAgent("C:\\Shared");s.saveCredentials(credentials);s.forgetCredentials();
    expect(new RuntimeClientStore(s.directory).personalAgent()).toBeUndefined();expect(s.credentials()).toBeNull();
  });
});
