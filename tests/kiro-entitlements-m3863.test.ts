/** Offline quota protocol matrix: every fetch is intercepted, no real credentials or vendor calls. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fetchKiroUsage } from "../src/usage/providers.js";
let home: string;
const calls: Array<{url:string;init:RequestInit}> = [];
let response: unknown, status = 200;
const oldHome=process.env.KIRO_CLI_HOME;
const arn=(region='us-east-1',id='selected')=>`arn:aws:codewhisperer:${region}:000000000000:profile/${id}`;
const token=(extra:Record<string,unknown>={})=>({access_token:'fixture-selected',expires_at:'2099-01-01T00:00:00Z',...extra});
function seed(tokens:Record<string,unknown>,profile?:unknown){
 const db=new Database(join(home,'data.sqlite3'));db.exec('CREATE TABLE auth_kv(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT)');
 for(const [k,v] of Object.entries(tokens))db.prepare('INSERT INTO auth_kv VALUES(?,?)').run(k,JSON.stringify(v));
 if(profile!==undefined)db.prepare('INSERT INTO state VALUES(?,?)').run('api.codewhisperer.profile',JSON.stringify(profile));db.close();
}
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'kiro-entitlements-'));process.env.KIRO_CLI_HOME=home;calls.length=0;status=200;response={subscriptionInfo:{subscriptionTitle:'KIRO PRO'},nextDateReset:2000000000,usageBreakdownList:[{resourceType:'CREDIT',displayNamePlural:'Credits',currentUsageWithPrecision:10,usageLimitWithPrecision:100}]};vi.stubGlobal('fetch',vi.fn(async(url:unknown,init:RequestInit)=>{calls.push({url:String(url),init});return new Response(JSON.stringify(response),{status});}));});
afterEach(()=>{vi.unstubAllGlobals();if(oldHome===undefined)delete process.env.KIRO_CLI_HOME;else process.env.KIRO_CLI_HOME=oldHome;rmSync(home,{recursive:true,force:true});});
it.each(['KIRO FREE','KIRO PRO','KIRO PRO+','KIRO POWER','KIRO PRO MAX'].flatMap(plan=>['social','idc'].map(auth=>({plan,auth}))))('$auth uses returned $plan entitlement and reset, never a login-derived plan',async({plan,auth})=>{
 seed({'kirocli:odic:token':token(auth==='idc'?{start_url:'https://identity.example.test/start'}:{provider:'builder-id'})},{arn:arn()});
 (response as any).subscriptionInfo.subscriptionTitle=plan;
 const r=await fetchKiroUsage();expect(calls).toHaveLength(1);expect(r.plan).toBe(plan.toLowerCase().replace(/(^|\s)\S/g,c=>c.toUpperCase()));expect(r.unlimited).not.toBe(true);expect(r.metrics[0]).toMatchObject({type:'percent',used:10,resetsAt:new Date(2000000000*1000).toISOString()});
});
it('uses the native selected token and profile runtime region, not a later-expiring legacy token or auth region',async()=>{
 seed({'kirocli:odic:token':token({start_url:'https://identity.example.test/start',region:'us-west-2'}),'codewhisperer:odic:token':token({access_token:'fixture-other',expires_at:'2199-01-01T00:00:00Z',region:'us-east-1'})},{arn:arn('eu-central-1')});
 await fetchKiroUsage();expect(calls).toHaveLength(1);expect(calls[0].url).toBe('https://q.eu-central-1.amazonaws.com/');expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer fixture-selected');expect(JSON.parse(String(calls[0].init.body))).toEqual({profileArn:arn('eu-central-1')});
});
it('binds a legacy login to the selected profile rather than the other live token expiry',async()=>{
 seed({'kirocli:social:token':token({profile_arn:arn('us-east-1','selected')}),'codewhisperer:odic:token':token({access_token:'fixture-other',profile_arn:arn('us-east-1','other'),expires_at:'2199-01-01T00:00:00Z'})},{arn:arn()});
 await fetchKiroUsage();expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer fixture-selected');
});
it('does not guess between ambiguous legacy accounts',async()=>{
 seed({'kirocli:social:token':token(),'codewhisperer:odic:token':token({access_token:'fixture-other',expires_at:'2199-01-01T00:00:00Z'})});
 const r=await fetchKiroUsage();expect(calls).toEqual([]);expect(r.metrics).toEqual([]);expect(r.hint).toMatch(/not measurable.*account/i);expect(r.unlimited).not.toBe(true);
});
it('does not fall back to another account when the selected native login expired',async()=>{
 seed({'kirocli:odic:token':token({expires_at:'2000-01-01T00:00:00Z'}),'kirocli:social:token':token({access_token:'fixture-other'})},{arn:arn()});
 const r=await fetchKiroUsage();expect(calls).toEqual([]);expect(r.hint).toMatch(/refresh|expired/i);
});
it.each([{arn:'not-an-arn'},{arn:arn('unsupported-region')},{arn:42}])('refuses an unusable native profile without sending credentials elsewhere: %j',async profile=>{
 seed({'kirocli:odic:token':token()},profile);const r=await fetchKiroUsage();expect(calls).toEqual([]);expect(r.hint).toMatch(/not measurable.*profile|not measurable.*region/i);expect(r.unlimited).not.toBe(true);
});
it.each([401,403])('treats HTTP %i as unmeasurable with the actual reason, not an entitlement or forced refresh',async code=>{
 seed({'kirocli:odic:token':token()},{arn:arn()});status=code;const r=await fetchKiroUsage();expect(calls).toHaveLength(1);expect(r.metrics).toEqual([]);expect(String(r.hint??r.error)).toMatch(new RegExp(`not measurable.*${code}`,'i'));expect(r.unlimited).not.toBe(true);
});
it.each([{}, {usageBreakdownList:[]}, {usageBreakdownList:[{resourceType:'CREDIT',currentUsage:0,usageLimit:0}]}])('missing/zero quotas are explicitly unmeasurable, never free or unlimited: %j',async body=>{
 seed({'kirocli:odic:token':token()},{arn:arn()});response=body;const r=await fetchKiroUsage();expect(r.metrics).toEqual([]);expect(r.hint).toMatch(/not measurable/i);expect(r.unlimited).not.toBe(true);
});
it('keeps paid overage separate from included credit usage and preserves explicit caps',async()=>{
 seed({'kirocli:odic:token':token()},{arn:arn()});(response as any).overageConfiguration={overageStatus:'ENABLED'};Object.assign((response as any).usageBreakdownList[0],{currentUsageWithPrecision:25,currentOveragesWithPrecision:5,overageCapWithPrecision:50,overageCharges:0.2});
 const r=await fetchKiroUsage();expect(r.metrics.find(m=>m.type==='percent')).toMatchObject({used:20});expect(r.metrics.find(m=>/overage credits/i.test(m.label))).toMatchObject({type:'percent',used:10});expect(r.unlimited).not.toBe(true);
});
it('shows an active trial pool with expiry instead of silently losing it',async()=>{
 seed({'kirocli:odic:token':token()},{arn:arn()});(response as any).usageBreakdownList[0].freeTrialInfo={freeTrialStatus:'ACTIVE',currentUsageWithPrecision:50,usageLimitWithPrecision:500,freeTrialExpiry:2000000000};
 const r=await fetchKiroUsage();expect(r.metrics.find(m=>/trial/i.test(m.label))).toMatchObject({type:'percent',used:10,resetKind:'expiry',resetsAt:new Date(2000000000*1000).toISOString()});expect(r.unlimited).not.toBe(true);
});
it('does not present an included-plan gauge when bonus spend is ambiguous',async()=>{
 seed({'kirocli:odic:token':token()},{arn:arn()});(response as any).usageBreakdownList[0].bonuses=[{status:'ACTIVE',currentUsage:5,usageLimit:10,expiresAt:2000000000}];
 const r=await fetchKiroUsage();expect(r.metrics.filter(m=>m.type==='percent').every(m=>/bonus/i.test(m.label))).toBe(true);expect(r.hint).toMatch(/not measurable.*bonus/i);expect(r.unlimited).not.toBe(true);
});

it('does not substitute a profile belonging to another native account', async () => {
 seed({'kirocli:odic:token':token({profile_arn:arn('us-east-1','other')})},{arn:arn()});
 const r=await fetchKiroUsage();expect(calls).toEqual([]);expect(r.hint).toMatch(/not measurable.*profile/i);
});
it('does not hide a malformed selected native token by falling back to a legacy token', async () => {
 seed({'kirocli:odic:token':{access_token:42},'codewhisperer:odic:token':token()},{arn:arn()});
 const r=await fetchKiroUsage();expect(calls).toEqual([]);expect(r.hint).toMatch(/not measurable.*account/i);
});
it.each([{currentUsageWithPrecision:-1},{currentUsageWithPrecision:'10'}, {currentUsageWithPrecision:101}, {currentOveragesWithPrecision:11}])('rejects invalid or relationally impossible plan counters: %j',async counter=>{
 seed({'kirocli:odic:token':token()},{arn:arn()});Object.assign((response as any).usageBreakdownList[0],counter);
 const r=await fetchKiroUsage();expect(r.metrics).toEqual([]);expect(r.hint).toMatch(/not measurable/i);
});
it('does not interpret a millisecond epoch as a billing reset in the distant future',async()=>{
 seed({'kirocli:odic:token':token()},{arn:arn()});(response as any).nextDateReset=2000000000000;
 const r=await fetchKiroUsage();expect(r.metrics[0].resetsAt).toBeNull();
});
it('reads selected identity without modifying the CLI database', async()=>{
 seed({'kirocli:odic:token':token()},{arn:arn()});const path=join(home,'data.sqlite3');
 const before=readFileSync(path);const stamp=statSync(path).mtimeMs;await fetchKiroUsage();
 expect(readFileSync(path)).toEqual(before);expect(statSync(path).mtimeMs).toBe(stamp);
});

it('does not retry a vendor outage or reinterpret it as unlimited capacity',async()=>{
 seed({'kirocli:odic:token':token()},{arn:arn()});status=503;
 const r=await fetchKiroUsage();expect(calls).toHaveLength(1);expect(r.status).toBe('error');expect(r.metrics).toEqual([]);expect(r.unlimited).not.toBe(true);
});
it('keeps the monthly plan gauge when only an expired historical bonus remains',async()=>{
 seed({'kirocli:odic:token':token()},{arn:arn()});
 (response as any).usageBreakdownList[0].bonuses=[{status:'EXPIRED',currentUsage:5,usageLimit:10,expiresAt:1000000000}];
 const r=await fetchKiroUsage();expect(r.metrics.find(m=>m.type==='percent')).toMatchObject({used:10});expect(r.hint).toBeUndefined();expect(r.metrics.some(m=>/bonus/i.test(m.label))).toBe(false);
});
it('gives an actionable sign-in hint on HTTP 401 without trying to refresh',async()=>{
 seed({'kirocli:odic:token':token()},{arn:arn()});status=401;
 const r=await fetchKiroUsage();expect(calls).toHaveLength(1);expect(r.hint).toMatch(/kiro-cli.*sign in/i);expect(r.metrics).toEqual([]);expect(r.unlimited).not.toBe(true);
});
