/** Owned HTTPS/SQLite Hub; synthetic people and Fleet; headless browsers; no vendor or model calls. */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
const repo = process.env.REPO!, out = process.env.OUT!, pwDir = process.env.PW_DIR || repo + "/node_modules", baseline = false;
if (!repo || !out || !pwDir) throw Error("REPO/OUT/PW_DIR required");
mkdirSync(out, { recursive: true });
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { freeHubPort } = await import(repo + "/tests/helpers/hub-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { personKeyString } = await import(repo + "/src/hub/identity.ts");
const port = await freeHubPort(), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin,realAudit:true });
const {HUB_ROOM_INVITATIONS_MIGRATION,createHubRoomInvitations}=await import(repo+"/src/hub/invitations.ts");
HUB_ROOM_INVITATIONS_MIGRATION.up(rig.db);rig.httpDeps.roomInvitations=(core,host)=>createHubRoomInvitations(core,host);await rig.restartHttp();
const keys = mkdtempSync(join(out, "owned-keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>((r, j) => { server.once("error", j); server.listen(port, "127.0.0.1", r); });
const pw = createRequire(pwDir + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? {executablePath:process.env.CHROME}:{}), headless: true, args: ["--no-sandbox"] });
const receipt: any = { source: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseline, cases: [], pageErrors: [], foreign: [] };
const check = (ok: unknown, msg: string) => { if (!ok) throw Error(msg); };
const shot = async (p: any, n: string) => { await p.evaluate(() => document.fonts.ready); await p.screenshot({ path: join(out, n + ".png"), fullPage: false }); };


const {default:Database}=await import("better-sqlite3");
const {HubExposureStore,HUB_EXPOSURE_MIGRATION}=await import(repo+"/src/hub/member/exposures.ts");
const {createHubMemberExposureApi}=await import(repo+"/src/hub/member/exposure-api.ts");
const {HubMemberSharingJournal,HUB_MEMBER_SHARING_MIGRATION}=await import(repo+"/src/hub/member/sharing-journal.ts");
const {HubMemberSharing}=await import(repo+"/src/hub/member/sharing.ts");
const {sharingResult}=await import(repo+"/src/hub/member/sharing-result.ts");
const {memberAgentCatalog}=await import(repo+"/src/hub/member/agent-catalog.ts");
const {createHubAudit,HUB_AUDIT_MIGRATION}=await import(repo+"/src/hub/audit/index.ts");
const {HubMemberAgentIntro}=await import(repo+"/src/hub/member/agent-intro.ts");
const {randomBytes}=await import("node:crypto");
const cases=[{device:"desk",theme:"light",lang:"en"},{device:"phone",theme:"dark",lang:"zh-TW"}];
try{
 for(const [index,c] of cases.entries()){
  const login=`owner${index}`,owner=rig.addPerson(login,"Owner"),reader=rig.addPerson(`reader${index}`,"Reader"),fleetId=randomUUID();
  rig.store.mutate({requestId:randomUUID(),at:Date.now(),actor:{kind:"local-host"},action:"fixture",result:"completed"},state=>{state.fleets.push({id:fleetId,owner,generation:1,credentialHash:"a".repeat(64),status:"active",label:"Example Fleet"});});
  const link=rig.link(fleetId,owner,1,["welcome-caps-v1","agent-catalog-v1","exposure-request-v1","agent-intro-v1"]);rig.http.memberConnected!(link);
  const db=new Database(":memory:");for(const m of [HUB_EXPOSURE_MIGRATION,HUB_MEMBER_SHARING_MIGRATION,HUB_AUDIT_MIGRATION])m.up(db);
  let floor=0,revision=0,intro:any=null,running=false;
  const sources=[{instance:"notes",displayName:"Notes",description:"Keeps project notes.\nPrivate instructions stay private.",kind:"agent",general:false},{instance:"docs",displayName:"Documents",description:c.lang==="en"?"Explains project documents.":"我負責解說專案文件。",kind:"agent",general:false}];
  const store=new HubExposureStore(db,{floor:{read:()=>floor,raise:n=>{floor=n;}},audit:createHubAudit({db,contentKey:randomBytes(32)}),views:new Map(),binding:()=>({owner,fleetId})});store.initialize();
  const agents=()=>sources.map(row=>{const e=store.list().find(x=>x.agent===row.instance)?.committed?.exposure;return {...row,kind:"agent" as const,avatar:null,shareable:true as const,incarnation:"d".repeat(64),exposure:e?{id:e.id,revision:e.revision,state:e.state}:null};});
  const publish=async()=>{await rig.http.receive(rig.frame("exposure.snapshot",{revision:++revision,exposures:store.list().flatMap(row=>row.committed?[row.committed.exposure]:[])},link),link);await rig.http.receive(rig.frame("agent.catalog",memberAgentCatalog(true,agents(),true),link),link);await intro?.defaults();};
  const api=createHubMemberExposureApi({store,agents:()=>sources.map(s=>({name:s.instance,display:s.displayName})),afterCommit:async()=>{},readinessCandidate:row=>({ok:true,policyDigest:row.exposure.policyDigest,exposureRevision:row.exposure.revision})});
  const journal=new HubMemberSharingJournal({db,binding:"owned-intro-rig",owner,fleetId,agentToken:()=>"d".repeat(64),current:()=>true,now:Date.now});
  const domain=new HubMemberSharing({journal,store,api,current:()=>true,now:Date.now,enabled:()=>true,agents,catalog:()=>memberAgentCatalog(true,agents(),true),snapshot:publish,notice:async()=>true});
  const at=Date.now();await domain.apply(randomUUID(),{by:owner,byName:"Owner",catalogRevision:memberAgentCatalog(true,agents(),true).revision,share:["notes"],stop:[],createdAt:at,expiresAt:at+600000});
  const old=store.list().find(row=>row.agent==="notes")!.committed!.exposure;rig.db.prepare("INSERT INTO hub_agent_intro_existing VALUES(?)").run(old.id);
  intro=new HubMemberAgentIntro({current:()=>true,exposures:()=>store.list().flatMap(row=>row.committed?.exposure.state==="published"?[{agent:row.agent,id:row.committed.exposure.id,revision:row.committed.exposure.revision,description:sources.find(s=>s.instance===row.agent)!.description}]:[])});
  intro.connected({features:link.features,linkEpoch:link.linkEpoch,current:()=>link.current(),exchange:async frame=>(await rig.http.receive(frame,link))!} as never);await intro.defaults();
  const seen=new Set<string>();const timer=setInterval(()=>{if(running)return;running=true;void(async()=>{for(const entry of rig.sent){if(entry.fleetId!==fleetId||seen.has(entry.frame.requestId))continue;seen.add(entry.frame.requestId);if(entry.frame.type==="exposure.request"){const record=await domain.apply(entry.frame.requestId,entry.frame.payload);await rig.http.receive({...rig.frame("exposure.request-result",sharingResult(record),link),requestId:record.id},link);}else if(entry.frame.type==="agent.catalog-refresh")await publish();}})().catch(e=>receipt.pageErrors.push(String(e))).finally(()=>{running=false;});},20);
  const ctx=await browser.newContext({viewport:c.device==="phone"?{width:390,height:844}:{width:1366,height:900},isMobile:c.device==="phone",hasTouch:c.device==="phone",locale:c.lang==="en"?"en-US":"zh-TW",colorScheme:c.theme,ignoreHTTPSErrors:true});
  await ctx.addInitScript({content:`window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});localStorage.setItem('agend_tour_done','1');`});
  await ctx.route("**/*",(route:any)=>{if(new URL(route.request().url()).origin!==origin){receipt.foreign.push("blocked");return route.abort();}return route.continue();});
  const p=await ctx.newPage();p.setDefaultTimeout(15000);p.on("pageerror",(e:any)=>receipt.pageErrors.push(String(e)));const tag=`${c.device}-${c.theme}-${c.lang}`;
  try{
   await p.goto(origin+"/ui/hub/exposures");await p.fill("#hubLogin",login);await p.fill("#hubPassword","pw-"+login);await p.locator(".hub-signin button[type=submit]").click();
   await p.locator(".hub-intro-notice").waitFor();await shot(p,`${tag}-notice`);
   await p.locator(".hub-intro-notice button").last().click();await p.locator(".hub-intro-notice").waitFor({state:"detached"});
   await p.locator('[data-share-agent="docs"]').check();await p.locator(".hub-share-bar .btn-primary").click();await p.locator("[data-grant-picker] .hub-intro-sharing-preview").waitFor();
   check((await p.locator(".hub-intro-sharing-preview").innerText()).includes(sources[1].description),"sharing default not shown");await shot(p,`${tag}-preview`);
   await p.locator(".hub-intro-sharing-preview button").first().click();const value=c.lang==="en"?"I explain release documents.":"我負責解說版本文件。";
   await p.locator(".hub-intro-sharing-preview input").fill(value);await shot(p,`${tag}-editor`);await p.locator(".hub-intro-sharing-preview .hub-agent-intro button").click();
   await p.locator(".hub-intro-sharing-preview input").waitFor({state:"detached"});check((await p.locator(".hub-intro-sharing-preview").innerText()).includes(value),"reviewed intro missing");
   check(await p.locator("form form").count()===0,"nested forms");check(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"horizontal overflow");await shot(p,`${tag}-edited`);
   receipt.cases.push({tag,status:"PASS",checks:["existing-share notice lists the agent","notice acknowledgement persists","sharing previews the first line","inline edit saves without granting","no nested forms or horizontal overflow"]});
  }finally{clearInterval(timer);await ctx.close();while(running)await new Promise(r=>setTimeout(r,10));intro.close();db.close();}
 }
}catch(e:any){receipt.error=String(e?.stack||e);}
finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));await rig.close();rmSync(keys,{recursive:true,force:true});receipt.status=receipt.cases.length===2&&!receipt.pageErrors.length&&!receipt.error?"PASS":"FAIL";writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));}
process.exitCode=receipt.status==="PASS"?0:1;
