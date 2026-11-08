/** S-90: sealed Hub HTTPS/WSS + production AD driver on recorded loopback LDAPS + real fleet Settings web server.
 * No daemon, CLI, account, model, live fleet or tmux. The fleet fixture attaches the production pairing API and a
 * pinned member client with empty exposure inventory. Browser performs both fingerprint confirmations and local Apply.
 * REPO=$PWD OUT=<PNG dir> PW_DIR=<playwright-core directory> CHROME=<audited Chromium> npx tsx <this file>
 * MODE=before retains the pre-S90 UI modules; SKEW=1 retains old CSS/client on the current server.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import yaml from "js-yaml";
import { bootFixture, matrix, caseName } from "../smoke-fixture/index.mts";
import { directoryCertificates } from "../../../tests/support/hub-directory-ca-fixture.js";
import { groupWirePeer, GROUP_A, GROUP_DN } from "../../../tests/support/hub-group-directory-wire.js";
import { createHubDirectory } from "../../../src/hub/directory/directory.js";
import { createHubInitializer } from "../../../src/hub/init/initializer.js";
import { hubIdentityProvider } from "../../../src/hub/init/identity.js";
import { createBrowserCertificate } from "../../../src/hub/init/browser-certificate.js";
import { createHubServerFactory } from "../../../src/hub/compose/server.js";
import { createHubMemberFactory } from "../../../src/hub/compose/member.js";
import { S3B_HTTP_ENTRY, MEMBER_COMPONENTS } from "../../../src/hub/runtime.js";
import { freeHubPort } from "../../../tests/helpers/hub-rig.js";
import { createHubMemberPairingApi } from "../../../src/hub/member/pairing-api.js";
import { HubMemberClient } from "../../../src/hub/client.js";
import { HubMemberProfileStore } from "../../../src/hub/profile.js";
import { createHubPairingNoticeInbox, HUB_PAIRING_INBOX_MIGRATION } from "../../../src/hub/member/pairing-notices.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../../../src/hub/audit/index.js";

const repo = process.env.REPO!, out = process.env.OUT!, mode = process.env.MODE ?? "current", skew = process.env.SKEW === "1";
if (!repo || !out) throw Error("REPO and OUT required");
if(process.env.CI_GREEN_VERIFIED!=="1")throw Error("Exact-head green CI must be verified before execution");
if(execFileSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).trim()!=="7c025c93980738e4f9ffa2a7f5891a8b63c978c5")throw Error("wrong acceptance SHA");
mkdirSync(out, { recursive: true }); const art = process.env.ART!; mkdirSync(art, { recursive: true });
const scratch = mkdtempSync(join(art, "browser-")); chmodSync(scratch, 0o700);
const scratchHome = join(scratch, "home"), bin = join(scratch, "bin");
for (const dir of [scratchHome, bin, join(scratchHome, ".codex"), join(scratchHome, ".claude"), join(scratchHome, "tmux")]) mkdirSync(dir, { mode: 0o700 });
Object.assign(process.env, { HOME: scratchHome, CODEX_HOME: join(scratchHome, ".codex"), CLAUDE_CONFIG_DIR: join(scratchHome, ".claude"), TMUX_TMPDIR: join(scratchHome, "tmux") });
for (const key of ["TMUX", "DISCORD_BOT_TOKEN", "TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROK_API_KEY"]) delete process.env[key];
for (const name of ["tmux", "agend", "claude", "codex", "kiro-cli"]) { const path = join(bin, name); writeFileSync(path, `#!${process.execPath}\nprocess.exit(97)\n`); chmodSync(path, 0o700); }
process.env.AGEND_TMUX_BIN = join(bin, "tmux"); process.env.PATH = bin + ":" + process.env.PATH;
const home = join(scratch, "hub"); mkdirSync(home, { mode: 0o700 });
const cases = matrix(process.env.MATRIX ?? "full");
const GROUP_C="cccccccc-cccc-4ccc-8ccc-cccccccccccc", DEPT_DN="CN=Department A,DC=example,DC=test";
const users = ["admin","owner","asker","ungranted","outsider","manual","expiry","negative"].map(login=>({id:randomUUID(),login,dn:`CN=${login},DC=example,DC=test`,password:`Dummy-${login}-only`,groups:[login==="asker"||login==="ungranted"?"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb":login==="outsider"||login==="manual"?GROUP_C:GROUP_A],eligible:true}));
const person=(login:string)=>users.find(u=>u.login===login)!;

const certs = directoryCertificates(), peer = await groupWirePeer(certs.leaf, users);
// Same connector-only seam as hub-group-directory-wire.test.ts: policy still requests DC636, TLS/BER use our owned
// ephemeral peer. Never touch/bind/contact a possibly occupied host636, and never change the TLS verification options.
peer.state.labels.set("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",DEPT_DN); peer.state.labels.set(GROUP_C,"CN=Department B,DC=example,DC=test");
const originalConnect = tls.connect, requestedPorts: number[] = [];
tls.connect = ((options: any, ...args: any[]) => {
  if (options?.host === "127.0.0.1" && options.port === 636) { requestedPorts.push(options.port); return originalConnect({ ...options, port: peer.port }, ...args); }
  return originalConnect(options, ...args);
}) as typeof tls.connect; syncBuiltinESMExports();
const directoryConfig = { realm: "example", url: "ldaps://127.0.0.1:636", profile: "ad", caPem: certs.ca,
  baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", timeoutMs: 1000 };
const directory = createHubDirectory(directoryConfig, { bindPassword: "Dummy-service-only" });
const webPort = await freeHubPort(); let memberPort = await freeHubPort(); while (memberPort === webPort) memberPort = await freeHubPort();
const origin = `https://127.0.0.1:${webPort}`, memberOrigin = `https://127.0.0.1:${memberPort}`;
const material = await createBrowserCertificate(home, origin);
const plan = { name: "Example Team Hub", webOrigin: origin, memberOrigin, webListen: { host: "127.0.0.1", port: webPort }, memberListen: { host: "127.0.0.1", port: memberPort },
  webTls: { certFile: material.certFile, keyFile: material.keyFile }, directory: directoryConfig, bindPasswordRef: "file:hub/secrets/directory-bind",
  administrator: { realm: "example", objectId: users[0].id }, retention: { contentDays: 7, eventDays: 30 }, coexistence: "dedicated" as const };
const init = createHubInitializer({ home, identity: hubIdentityProvider(), probe: { pidAlive: () => false } });
const confirmation = await init.prepareConfirmation(plan, { bindPassword: "Dummy-service-only" }); await init.commit(plan, confirmation.reference);
const cfg = (yaml.load(readFileSync(join(home, "fleet.yaml"), "utf8")) as any).hub;
const service = await createHubServerFactory({ home, components: { http: S3B_HTTP_ENTRY }, createDirectory: () => directory, report: () => {}, log: () => {} })(cfg, () => true);
await service.start();
const fmPort = await freeHubPort(); const fx = await bootFixture({ port: fmPort, instances: 1, classic: false });
fx.fm.hubEffectsReady = true; // production switch observer enabled, like fleet startup; initial membership remains off
const receipt: any = { mode, skew, source: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  browser: fx.browser.version(), boundary: "Exact frozen alpha sealed Hub+full member factories, production AD driver over synthetic TLS/BER LDAPS and actual browser sessions/Settings confirmations. Representative input handoff and model answer are simulated at explicit callbacks; actual consent, admission, journal, lease/release and WSS. No daemon IPC, real model, native CLI/account/live fleet or tmux.", ciGate:{run:42444268795,verifiedAt:process.env.CI_VERIFIED_AT},stories:[],network:[],clicks:[],deliveries:[],holds:[],checks: [], shots: [], errors: [], csp: [], foreign: [], api: [] };
const check = (name: string, ok: unknown) => { receipt.checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); };
const oldRef = process.env.OLD_REF ?? "7ab23b6c6", old = (file: string) => execFileSync("git", ["-C", repo, "show", `${oldRef}:src/ui/${file}`], { encoding: "utf8", maxBuffer: 16 << 20 });
let api: ReturnType<typeof createHubMemberPairingApi> | undefined, member: any, inboxDb: Database.Database | undefined, online = false, memberLive = true;
const extraPairings: ReturnType<typeof createHubMemberPairingApi>[] = [];
const contexts: any[] = [];
const shot = async (p: any, name: string) => { await p.evaluate(() => document.fonts.ready); await p.screenshot({ path: join(out, name + ".png"), fullPage: true }); receipt.shots.push(name + ".png"); };
async function context(c: any, oldClient = false) {
  const ctx = await fx.browser.newContext({ viewport: c.device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 },
    isMobile: c.device === "phone", hasTouch: c.device === "phone", locale: c.lang === "en" ? "en-US" : "zh-TW", colorScheme: c.theme, ignoreHTTPSErrors: true }); contexts.push(ctx);
  await ctx.addInitScript({ content: `window.__name=fn=>fn;try{localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1')}catch{};window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));` });
  await ctx.route("**/*", (r: any) => {
    const u = new URL(r.request().url()); if (![origin, fx.base].includes(u.origin)) { receipt.foreign.push(u.origin); return r.abort(); }
    let retained: string | null = null;
    if (mode === "before" && ["/ui/js/panel-hub.js", "/ui/js/hub-welcome.js", "/ui/js/hub-client.js"].includes(u.pathname)) retained = u.pathname.slice(7);
    if (oldClient && u.pathname === "/ui/js/hub-client.js") retained = "hub-client.js";
    if (skew && ["/assets/app.css", "/assets/hub.css", "/assets/hub-owner.css", "/assets/hub-groups.css", "/assets/app-shell.js"].includes(u.pathname)) retained = "shared/" + u.pathname.slice(8);
    if (retained) { receipt.skewHits = (receipt.skewHits ?? 0) + 1; return r.fulfill({ contentType: retained.endsWith(".css") ? "text/css" : "text/javascript", body: old(retained) }); }
    return r.continue();
  });
  const p = await ctx.newPage(); p.setDefaultTimeout(12000); p.on("pageerror", (e: Error) => receipt.errors.push(String(e))); p.on("response", async (r: any) => {
    if(new URL(r.url()).pathname.startsWith("/hub/v1/")){const row:any={at:Date.now(),path:new URL(r.url()).pathname,method:r.request().method(),status:r.status(),retryAfter:r.headers()["retry-after"]};if(r.status()>=400)row.body=await r.json().catch(()=>null);receipt.network.push(row);}
    if(new URL(r.url()).pathname==="/hub/v1/exposures"&&r.request().method()==="GET"){try{receipt.catalogs??=[];receipt.catalogs.push({status:r.status(),body:await r.json()});}catch{}}
    if (/group-policy|grants|rooms|exposures|quick-pairing|\/revoke$|\/pairing\/(connect|confirm)|\/notices/.test(r.url())) receipt.api.push({ path: new URL(r.url()).pathname, status: r.status(), method: r.request().method() });
  }); return { ctx, p };
}
async function signIn(p: any, login: string, path = "/ui/hub") { await p.goto(origin + path); await p.fill("#hubLogin", login); await p.fill("#hubPassword", `Dummy-${login}-only`); await p.locator(".hub-signin button[type=submit]").click(); }
async function geometry(p: any, name: string) { check(name + " no horizontal overflow", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); receipt.csp.push(...await p.evaluate("window.__csp")); }
async function apply(p: any, next: string) {
  await p.waitForFunction((selector: string) => document.querySelector(".pending-self .btn-primary") || document.querySelector(selector), next);
  if (await p.locator(".pending-self .btn-primary").count()) { await p.locator(".pending-self .btn-primary").last().click(); receipt.localApplyClicks = (receipt.localApplyClicks ?? 0) + 1; }
  await p.locator(next).first().waitFor();
}
const deliveries:any[]=[];let reportHook:any,memberStart:Promise<void>|undefined;
const mounts:any[]=[];let activeMount:any;
function activateMount(m:any){activeMount=m;api=m.api;member=m.member;online=!!m.online;memberStart=m.start;reportHook=m.reportHook;fx.fm.attachHubMemberPairing(m.api);fx.fm.attachHubMemberExposures(m.exposures??null);fx.fm.hubPairingNotices=m.notices??null;}
async function attachMember(index:number){
 const mh=join(scratch,`member-${index}`);mkdirSync(mh,{mode:0o700});const m:any={home:mh,live:true,online:false};mounts.push(m);
 const start=()=>{if(m.api.view().state!=="paired"||m.start)return;
  const create=createHubMemberFactory({home:mh,components:MEMBER_COMPONENTS,boundHub:()=>m.api.boundHub()?.hubId??null,agents:()=>[{name:"general",display:"Acceptance agent · 驗收助手"}],
   representative:{agentToken:a=>a==="general"?"t".repeat(64):null,deliver:async input=>{if(!input.stillCurrent()||!await input.beforeInput())return false;deliveries.push(input);receipt.deliveries.push({agent:input.agent,correlationId:input.correlationId,mount:index});return true;},attachReports:handler=>{m.reportHook=handler;if(activeMount===m)reportHook=handler;}},
   attachExposures:a=>{m.exposures=a;if(activeMount===m)fx.fm.attachHubMemberExposures(a);},attachAttention:r=>{if(activeMount===m)fx.fm.attachHubExecutionAttention(r);},attachPairingNotices:r=>{m.notices=r;if(activeMount===m)fx.fm.hubPairingNotices=r;},pokeAttention:()=>{},linkState:state=>{m.online=state==="online";if(activeMount===m)online=m.online;},report:(code,detail)=>receipt.holds.push({mount:index,code,detail}),log:()=>{}});
  m.start=(async()=>{m.member=await create({enabled:true},()=>m.live);await m.member.start();if(activeMount===m)member=m.member;})();if(activeMount===m)memberStart=m.start;
 };
 m.api=createHubMemberPairingApi({home:mh,enabled:()=>m.live,link:()=>m.online?"online":"offline",notices:()=>m.notices?.()??[],bindingChanged:start});activateMount(m);start();return mh;
}
async function click(p:any,selector:string,label:string){receipt.clicks.push(label);await p.locator(selector).click();}
async function story(id:string,fn:()=>Promise<void>){const start=receipt.checks.length;try{await fn();receipt.stories.push({id,status:"PASS",checks:receipt.checks.length-start});console.log(id,"PASS");}catch(e:any){receipt.stories.push({id,status:"FAIL",error:e.message,checks:receipt.checks.length-start});for(const ctx of contexts)for(const p of ctx.pages())await shot(p,`${id}-FAIL-${receipt.shots.length}`).catch(()=>{});console.log(id,"FAIL",e.message);}}
async function waitFor(fn:()=>boolean,name:string,ms=12000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error(name);await new Promise(r=>setTimeout(r,50));}}
async function welcome(login:string,c:any,tag:string){const o=await context(c);await signIn(o.p,login);await o.p.locator(".hub-welcome-card").first().waitFor();await shot(o.p,tag);await geometry(o.p,tag);return o;}
let admin:any,owner:any,local:any,memberHome:string|undefined,ownerOther:any,asker:any,roomUrl="",grantUrl="",exposureId="";

async function hostPage(c:any){fx.fm.webPrefs.write("operator",new Map([["lang",c.lang],["theme",c.theme]]));const o=await context(c);const issued=await(await fetch(fx.base+"/auth/issue-code",{method:"POST",headers:{"X-Agend-Token":fx.fm.webToken}})).json() as any;await o.p.goto(fx.base+"/signin");await o.p.fill("#code",issued.code);await o.p.click("#go");await o.p.waitForURL(fx.base+"/ui");await o.p.goto(fx.base+"/settings/hub");return o;}
async function pauseMs(ms:number){await new Promise(r=>setTimeout(r,ms));}
try{
 admin=await context(cases[0]);
 await story("A8-01",async()=>{await signIn(admin.p,"admin","/ui/hub/admin");await click(admin.p,'[data-entry="group-permissions"] .btn',"Administration → Group permissions");
  await admin.p.locator(".hub-step-form input").fill(GROUP_DN);await click(admin.p,".hub-step-form button","Resolve owner group");await admin.p.locator(".hub-group-row").waitFor();
  for(const n of[1,2])await admin.p.locator('.hub-group-row input[type=checkbox]').nth(n).check();await admin.p.locator('.hub-group-row input[type=number]').fill("1");
  await admin.p.locator(".hub-step-form input").fill(DEPT_DN);await click(admin.p,".hub-step-form button","Resolve Department A");await admin.p.locator(".hub-group-row").nth(1).waitFor();
  await click(admin.p,".hub-groups-state button","Turn on draft");await admin.p.locator(".hub-groups-preview .btn-primary").waitFor();check("unsaved policy stays Off",/Off|關閉/.test(await admin.p.locator(".hub-groups-state h3").innerText()));await shot(admin.p,"A8-01-impact-before-save");
  await click(admin.p,".hub-groups-preview .btn-primary","Save shown impact");await admin.p.locator(".hub-groups-preview").waitFor({state:"detached"});await admin.p.reload();await admin.p.locator(".hub-group-row").nth(1).waitFor();check("two saved groups",await admin.p.locator(".hub-group-row").count()===2);await shot(admin.p,"A8-01-saved");
 });
 if(!receipt.stories.find((x:any)=>x.id==="A8-01"&&x.status==="PASS"))throw Error("policy setup failed; dependent stories cannot execute");
await admin.ctx.close();
await story("P2-membership-no-reload",async()=>{for(const c of matrix("quick")){const o=await hostPage(c);await o.p.locator("#hubMemberEnabled").waitFor();if(await o.p.locator("#hubMemberEnabled").isChecked()){await o.p.locator("#hubMemberEnabled").click();await o.p.locator("#hubAddress").waitFor({state:"detached"});}await o.p.evaluate(()=>{window.__pass2Marker="same-document";});check("off starts without Connect fields",await o.p.locator("#hubAddress").count()===0);await o.p.locator("#hubMemberEnabled").click();await o.p.locator("#hubAddress").waitFor({timeout:20000});const state=await o.p.evaluate(()=>({marker:window.__pass2Marker,member:document.body.dataset.hub,text:document.body.innerText}));check("membership fields appear without navigation",state.marker==="same-document"&&String(state.member).split(/\s+/).includes("member")&&!/Reload page|重新整理頁面/.test(state.text));check("membership saved and actual API mounted",fx.fm.getRawFleetConfig().hub_member.enabled===true&&!!fx.fm.hubMemberPairing());await o.p.locator("#hub-connect").scrollIntoViewIfNeeded();await shot(o.p,"P2-membership-on-"+caseName(c));await o.ctx.close();}});
if(!receipt.stories.some((r:any)=>r.id==="P2-membership-no-reload"&&r.status==="PASS"))throw Error("membership transition failed; do not manufacture Connect");
console.log("PASS2_INITIAL_READY");
while(!existsSync(join(art,"stop"))){const cmd=join(art,"command.mjs");if(existsSync(cmd)){const code=readFileSync(cmd,"utf8");renameSync(cmd,join(art,`command-${Date.now()}.mjs`));try{await eval("(async()=>{"+code+"})()");}catch(e){receipt.controlError=String(e);console.error("CONTROL_ERROR",e);}writeFileSync(join(art,"receipt-live.json"),JSON.stringify(receipt,null,2));console.log("CONTROL_DONE");}await pauseMs(200);}
}catch(e:any){receipt.error=e.stack;console.error(e);}
finally{receipt.finished=new Date().toISOString();receipt.status=receipt.error||receipt.stories.some((r:any)=>r.status!=="PASS")?"REVIEW_REQUIRED":"PASS";receipt.resources={pid:process.pid,ports:[webPort,memberPort,fmPort,fmPort+1,peer.port],roots:[scratch,fx.dir]};writeFileSync(join(art,"receipt.json"),JSON.stringify(receipt,null,2));memberLive=false;for(const m of mounts){m.live=false;m.api.cancel();await m.start?.catch(()=>{});await m.member?.close();}extraPairings.forEach(p=>p.cancel());fx.fm.hubEffectsReady=false;await fx.fm.hubRuntimeInit?.catch(()=>{});await fx.fm.hubRuntime?.close();await fx.close();await service.close();await directory.close();await peer.close();certs.cleanup();rmSync(scratch,{recursive:true,force:true});tls.connect=originalConnect;syncBuiltinESMExports();writeFileSync(join(art,"cleanup.json"),JSON.stringify({allCloseCallsCompleted:true,source:receipt.source,at:new Date().toISOString()},null,2));}
