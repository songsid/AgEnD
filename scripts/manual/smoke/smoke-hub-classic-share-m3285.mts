/** Real Fleet shell/local exposure+confirmation APIs; inert pairing and representative readiness. No model or chat service. */
import {mkdirSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {randomBytes} from "node:crypto";
import {execFileSync} from "node:child_process";
if(process.platform!=="linux")throw Error("Run headless inside Linux/WSL only");
if(!process.env.CHROME?.startsWith("/home/")||process.env.CHROME.includes("/mnt/"))throw Error("Pin the Linux headless shell; Windows browsers are forbidden");
const repo=process.env.REPO!,out=resolve(process.env.OUT??".artifacts/m3285/browser");mkdirSync(out,{recursive:true});
const {bootFixture}=await import("../smoke-fixture/index.mts");
const fx=await bootFixture({port:Number(process.env.HP??55185),host:false,classic:false,webYaml:"  verified_authority:\n    enabled: false",roster:[{name:"example-general",displayName:"General",backend:"claude-code",general:true}]});
const fm=fx.fm as any;
for(const name of ["startInstance","startInstanceUnattended","restartInstance","restartFleet","stopInstance"])fm[name]=async()=>{throw Error("No CLI lifecycle in this walk");};
const {ClassicChannelManager}=await import(repo+"/src/classic-channel-manager.ts");
const {default:Database}=await import("better-sqlite3");
const {applyHubMigrations}=await import(repo+"/src/hub/db.ts");
const {createHubAudit,HUB_AUDIT_MIGRATION}=await import(repo+"/src/hub/audit/index.ts");
const {HubExposureStore,HUB_EXPOSURE_MIGRATION}=await import(repo+"/src/hub/member/exposures.ts");
const {createHubMemberExposureApi}=await import(repo+"/src/hub/member/exposure-api.ts");
const classic=new ClassicChannelManager(fx.dir,fm.logger);classic.setPrimaryAdapterId("fixture-adapter");classic.register("111111111111111111","fixture-adapter","classic-example","Example room","fixture-owner","claude-code");fm.classicChannels=classic;
const db=new Database(":memory:");applyHubMigrations(db,[HUB_AUDIT_MIGRATION,HUB_EXPOSURE_MIGRATION]);let floor=0;
const store=new HubExposureStore(db,{floor:{read:()=>floor,raise:(value:number)=>{floor=value;}},audit:createHubAudit({db,contentKey:randomBytes(32)}),views:new Map(),binding:()=>({owner:{realm:"example",objectId:"11111111-1111-4111-8111-111111111111"},fleetId:"22222222-2222-4222-8222-222222222222"})});store.initialize();
const api=createHubMemberExposureApi({store,agents:()=>fm.hubMemberAgents(),afterCommit:async()=>"pending",readinessCandidate:c=>fm.hubAgentToken(c.agent)?{ok:true,policyDigest:c.exposure.policyDigest,exposureRevision:c.exposure.revision}:{ok:false,reasonCode:"provider-unavailable"}});fm.attachHubMemberExposures(api);
const receipt:any={source:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),scope:"Actual Fleet shell and local exposure/confirmation APIs; inert paired view and representative readiness; all identities synthetic; no Hub/chat/model/Windows connection",checks:[],pictures:[]};
const check=(name:string,ok:unknown)=>{receipt.checks.push({name,pass:!!ok});if(!ok)throw Error(name);};
try{
 for(const c of [{device:"desk",theme:"light",lang:"en"},{device:"phone",theme:"dark",lang:"zh-TW"}] as const){
  const {ctx,page}=await fx.page(c,{path:"/settings/hub"}),en=c.lang==="en",tag=`${c.device}-${c.lang}-${c.theme}`;
  await ctx.route("**/*",(route:any)=>new URL(route.request().url()).origin===fx.base?route.continue():route.abort());
  const errors:string[]=[];page.on("pageerror",(error:Error)=>errors.push(error.message));
  await page.locator("#hub-connection").waitFor();
  await page.evaluate(`(async()=>{
   const hub=await import("/ui/js/hub-client.js"),confirm=await import("/ui/js/settings-confirm.js"),view=await import("/ui/js/settings-hub.js"),preact=await import("/assets/preact.module.js");
   const actual=hub.createMemberClient({confirm});
   hub.setHubClient({...actual,subscribe:()=>()=>{},pairing:async()=>({state:"paired",binding:"fixture-binding",hub:{hubId:"33333333-3333-4333-8333-333333333333",name:"Example Hub",memberOrigin:"https://hub.example.test",webOrigin:"https://hub.example.test",fingerprint:{kind:"hub-key",digest:"a".repeat(64)}},link:"online"})});
   const original=document.querySelector("#hub-connection");original.id="fixture-original-connection";original.hidden=true;
   const host=document.createElement("div");host.id="fixture-classic-share";original.parentElement.insertBefore(host,original);preact.render(preact.h(view.HubConnectCard,{}),host);
  })()`);
  const card=page.locator("#fixture-classic-share"),row=card.locator("li.hub-exposure").filter({hasText:"Example room"});await row.locator('input[role="switch"]').waitFor();
  check(`${tag}/room-tickable`,await row.locator('input[role="switch"]').isEnabled());check(`${tag}/room-tag`,await row.getByText(en?"ClassicBot room":"ClassicBot 房間",{exact:true}).count()===1);
  check(`${tag}/one-memory-lead`,(await card.innerText()).includes(en?"one agent with one memory":"同一個 Agent、同一份記憶"));check(`${tag}/default-contact-limit`,await row.locator('input[type="checkbox"]').nth(1).isChecked());
  await card.locator(".hub-exposures h4").scrollIntoViewIfNeeded();const leadFile=`${tag}-lead.png`;await page.screenshot({path:join(out,leadFile)});receipt.pictures.push(leadFile);
  await row.scrollIntoViewIfNeeded();const rowFile=`${tag}-room-row.png`;await row.screenshot({path:join(out,rowFile)});receipt.pictures.push(rowFile);
  const [response]=await Promise.all([page.waitForResponse((r:any)=>r.url().endsWith("/api/hub/member/exposures")&&r.request().method()==="POST"),row.locator('input[role="switch"]').click()]);
  check(`${tag}/confirmed-write-required`,response.status()===202);const pending=await response.json();check(`${tag}/room-memory-summary`,pending.pending_change?.summary?.[0]?.includes("what people said in the room"));
  const confirmation=page.locator(`[data-pending="${pending.pending_change.id}"]`);await confirmation.waitFor();check(`${tag}/disclosure-open`,await confirmation.locator("details.pending-details").getAttribute("open")!==null);
  check(`${tag}/translated-memory`,(await confirmation.innerText()).includes(en?"what people said in the room":"可能用到房間裡的人說過的內容"));check(`${tag}/not-published-before-consent`,api.list().find(r=>r.agent==="classic-example")?.state==="withdrawn");
  await confirmation.scrollIntoViewIfNeeded();const confirmFile=`${tag}-confirmation.png`;await confirmation.screenshot({path:join(out,confirmFile)});receipt.pictures.push(confirmFile);
  check(`${tag}/no-page-errors`,errors.length===0);
  await page.evaluate(async()=>{const {appStore}=await import("/assets/app-store.js");await appStore.get().pendingChanges?.[0]?.withdraw?.();});await ctx.close();
 }
 writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");console.log(JSON.stringify({checks:receipt.checks.length,pictures:receipt.pictures.length,pass:true}));
}finally{fm.attachHubMemberExposures(null);db.close();await fx.close();}
