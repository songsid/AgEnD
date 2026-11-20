import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCredentialVault } from "../src/claude-credential-vault.js";
import { fetchClaudeUsage, redactManagedClaudeUsage, type ProviderUsage } from "../src/usage/providers.js";
import { getUsageSnapshot, setUsageFetcherForTests } from "../src/usage/usage-api.js";
const dirs:string[]=[],vaults:ClaudeCredentialVault[]=[];
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();setUsageFetcherForTests(null);for(const v of vaults.splice(0))v.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function rig(){const home=mkdtempSync(join(tmpdir(),"claude-meter-"));dirs.push(home);vi.stubEnv("HOME",home);vi.stubEnv("AGEND_HOME",home);vi.stubEnv("CLAUDE_CONFIG_DIR",join(home,"claude"));writeFileSync(join(home,"fleet.yaml"),"defaults: {}\ninstances: {}\n");const vault=new ClaudeCredentialVault(home);vaults.push(vault);return {home,vault};}
const actor={adapterId:"host",userId:"operator"},value="synthetic-"+"x".repeat(48);
const prior={id:"claude",name:"Claude",status:"ok",hint:"old account",metrics:[{key:"weekly",label:"Weekly",value:42,unit:"%"}],identity:"old@example.com",plan:"max",stale:true} as unknown as ProviderUsage;
it.each(["api-key","setup-token"] as const)("%s does not query a prior subscription and drops its identity/meters",async kind=>{
 const r=rig();r.vault.write(null,0,{kind,value},actor);const fetch=vi.fn(()=>{throw Error("no provider calls allowed");});vi.stubGlobal("fetch",fetch);
 const out=await fetchClaudeUsage();expect(out.metrics).toEqual([]);expect(out.hintI18n?.key).toBe("usage.hint.claude_managed_source");expect(fetch).not.toHaveBeenCalled();
 const publicView=redactManagedClaudeUsage(prior);expect(publicView.metrics).toEqual([]);expect(JSON.stringify(publicView)).not.toContain("old@example.com");expect(JSON.stringify(publicView)).not.toContain("old account");
});
it("serving an already-cached subscription snapshot rechecks the source after a managed save",async()=>{
 const r=rig();let count=0;setUsageFetcherForTests(async()=>{count++;return {fetchedAt:new Date().toISOString(),providers:[prior]};});
 const first=await getUsageSnapshot();expect(first.providers[0]?.metrics).toHaveLength(1);
 r.vault.write(null,0,{kind:"api-key",value},actor);
 const second=await getUsageSnapshot();expect(second.providers[0]?.metrics).toEqual([]);expect(JSON.stringify(second)).not.toContain("old@example.com");expect(count).toBe(1);
});
it("removed and unreadable managed state keep old subscription data hidden; untouched legacy and explicit subscription are retained",()=>{
 const r=rig();expect(redactManagedClaudeUsage(prior)).toBe(prior);
 r.vault.write(null,0,null,actor);expect(redactManagedClaudeUsage(prior).metrics).toEqual([]);
 r.vault.write(null,1,"subscription",actor);expect(redactManagedClaudeUsage(prior)).toBe(prior);
 r.vault.close();vaults.splice(vaults.indexOf(r.vault),1);rmSync(join(r.home,"credential-vault","claude.sqlite"));expect(redactManagedClaudeUsage(prior).metrics).toEqual([]);
});
