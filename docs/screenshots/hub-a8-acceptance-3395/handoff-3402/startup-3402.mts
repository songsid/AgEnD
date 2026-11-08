/** #3402 startup-only copyable diagnostic, extracted from #3395. No browser API reply stubs or delays.
 * Copy under scripts/manual/hub-quick-pairing/ in YOUR checkout, not into the evidence directory.
 * REPO/ART/OUT/PW_DIR/CHROME/FONTCONFIG_FILE + SHORT owned TMPDIR; MATRIX=full REPEATS=3.
 * Default collects known-base failures and exits normally; REQUIRE_NO_429=1 makes missing empty hint/429 fail.
 * Does not induce a synthetic busy period or exercise Retry; that remains the fix author's separate control.
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
fx.fm.saveFleetConfig([{ path: ["hub_member", "enabled"], value: true }]);
const receipt: any = { mode, skew, source: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  browser: fx.browser.version(), boundary: "Startup-only: sealed Hub HTTPS, production AD driver over owned synthetic verified TLS/BER peer, real browser. Fleet fixture supplies browser engine only; no member, agent, model, daemon, native CLI or account runs.", stories:[],clicks:[],deliveries:[],holds:[],checks: [], shots: [], errors: [], csp: [], foreign: [], api: [] };
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
async function attachMember(index:number){
 memberLive=false;await member?.close();member=undefined;online=false;memberLive=true;memberStart=undefined;
 const mh=join(scratch,`member-${index}`);mkdirSync(mh,{mode:0o700});
 const ownApi=createHubMemberPairingApi({home:mh,enabled:()=>memberLive,link:()=>online?"online":"offline",pollMs:250,bindingChanged:()=>{
  if(ownApi.view().state!=="paired"||memberStart)return;
  const create=createHubMemberFactory({home:mh,components:MEMBER_COMPONENTS,boundHub:()=>ownApi.boundHub()?.hubId??null,agents:()=>[{name:"general",display:"Acceptance agent · 驗收助手"}],
   representative:{agentToken:a=>a==="general"?"t".repeat(64):null,deliver:async input=>{if(!input.stillCurrent()||!await input.beforeInput())return false;deliveries.push(input);receipt.deliveries.push({agent:input.agent,correlationId:input.correlationId});return true;},attachReports:(handler)=>{reportHook=handler;}},
   attachExposures:a=>fx.fm.attachHubMemberExposures(a),attachAttention:r=>fx.fm.attachHubExecutionAttention(r),attachPairingNotices:r=>{fx.fm.hubPairingNotices=r;},pokeAttention:()=>{},linkState:s=>{online=s==="online";},report:(code,detail)=>receipt.holds.push({code,detail}),log:()=>{}});
  memberStart=(async()=>{member=await create({enabled:true},()=>memberLive);await member.start();})().catch(e=>{receipt.errors.push(String(e));throw e;});
 }});api=ownApi;fx.fm.attachHubMemberPairing(ownApi);return mh;
}
async function click(p:any,selector:string,label:string){receipt.clicks.push(label);await p.locator(selector).click();}
async function story(id:string,fn:()=>Promise<void>){const start=receipt.checks.length;try{await fn();receipt.stories.push({id,status:"PASS",checks:receipt.checks.length-start});console.log(id,"PASS");}catch(e:any){receipt.stories.push({id,status:"FAIL",error:e.message,checks:receipt.checks.length-start});for(const ctx of contexts)for(const p of ctx.pages())await shot(p,`${id}-FAIL-${receipt.shots.length}`).catch(()=>{});console.log(id,"FAIL",e.message);}}
async function waitFor(fn:()=>boolean,name:string,ms=12000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error(name);await new Promise(r=>setTimeout(r,50));}}
async function welcome(login:string,c:any,tag:string){const o=await context(c);await signIn(o.p,login);await o.p.locator(".hub-welcome-card").first().waitFor();await o.p.locator("[data-quick-pairing] form, [data-welcome=no-actions], [data-entry=connect][aria-disabled=true]").first().waitFor();await shot(o.p,tag);await geometry(o.p,tag);return o;}
let admin:any,owner:any,local:any,memberHome:string|undefined,ownerOther:any,asker:any,roomUrl="",grantUrl="",exposureId="";

const { HubCore } = await import(repo + '/src/hub/http/core.ts');
const { personKeyString } = await import(repo + '/src/hub/identity.ts');
const originalCurrent = HubCore.prototype.current, originalEligibility = directory.checkEligibility;
let driverActive = 0, driverPeak = 0, probe = '', logical = new Map<string, number>();
receipt.startup = []; receipt.core = []; receipt.driver = []; receipt.responses = [];
try {
 admin=await context(cases[0]);
 await story("A8-01",async()=>{await signIn(admin.p,"admin","/ui/hub/admin");await click(admin.p,'[data-entry="group-permissions"] .btn',"Administration → Group permissions");
  await admin.p.locator(".hub-step-form input").fill(GROUP_DN);await click(admin.p,".hub-step-form button","Resolve owner group");await admin.p.locator(".hub-group-row").waitFor();
  for(const n of[1,2])await admin.p.locator('.hub-group-row input[type=checkbox]').nth(n).check();await admin.p.locator('.hub-group-row input[type=number]').fill("1");
  await admin.p.locator(".hub-step-form input").fill(DEPT_DN);await click(admin.p,".hub-step-form button","Resolve Department A");await admin.p.locator(".hub-group-row").nth(1).waitFor();
  await click(admin.p,".hub-groups-state button","Turn on draft");await admin.p.locator(".hub-groups-preview .btn-primary").waitFor();check("unsaved policy stays Off",/Off|關閉/.test(await admin.p.locator(".hub-groups-state h3").innerText()));await shot(admin.p,"A8-01-impact-before-save");
  await click(admin.p,".hub-groups-preview .btn-primary","Save shown impact");await admin.p.locator(".hub-groups-preview").waitFor({state:"detached"});await admin.p.reload();await admin.p.locator(".hub-group-row").nth(1).waitFor();check("two saved groups",await admin.p.locator(".hub-group-row").count()===2);await shot(admin.p,"A8-01-saved");
 });
 if(!receipt.stories.find((x:any)=>x.id==="A8-01"&&x.status==="PASS"))throw Error("policy setup failed; dependent stories cannot execute");

 await admin.ctx.close(); // No administrator tab, notices stream or previous failed page remains.
 directory.checkEligibility = async function(...args: any[]) {
   const e: any = { probe, at: Date.now(), active: ++driverActive }; driverPeak = Math.max(driverPeak, driverActive); receipt.driver.push(e);
   try { return await originalEligibility.apply(directory, args as any); }
   finally { driverActive--; e.elapsed = Date.now() - e.at; }
 };
 HubCore.prototype.current = async function(person: any) {
   const id = personKeyString(person), n = (logical.get(id) ?? 0) + 1; logical.set(id,n);
   const e: any = { probe, at: Date.now(), attemptedConcurrent: n, admittedBefore: (this as any).inflight.get(id) ?? 0, totalBefore: (this as any).total };
   receipt.core.push(e);
   try { return await originalCurrent.call(this,person); }
   catch (error: any) { e.error = error.code ?? error.message; throw error; }
   finally { logical.set(id,(logical.get(id) ?? 1)-1); e.elapsed = Date.now()-e.at; }
 };
 for (const c of cases) for (let i=1;i<=Number(process.env.REPEATS ?? '3');i++) {
   probe = `${caseName(c)}-${i}`; const tag = probe; const o = await context(c);
   try {
     o.p.on('response',async (r: any) => {
       const u = new URL(r.url()); if(u.origin!==origin || !u.pathname.startsWith('/hub/v1/'))return;
       const e: any = {probe:tag,at:Date.now(),path:u.pathname,method:r.request().method(),status:r.status(),retryAfter:r.headers()['retry-after']};
       if(r.status()>=400)e.body=await r.json().catch(()=>null); receipt.responses.push(e);
     });
     await signIn(o.p,'ungranted');
     await o.p.locator('.hub-welcome-card, .hub-welcome-page .empty, .hub-welcome-page [role=alert]').first().waitFor({timeout:5000}).catch(()=>{});
     await o.p.locator('[data-welcome=nothing-shared]').waitFor({timeout:1500}).catch(()=>{});
     await shot(o.p,tag); await geometry(o.p,tag);
     const result={probe:tag,emptyHint:await o.p.locator('[data-welcome=nothing-shared]').count()===1,busy:receipt.responses.filter((e:any)=>e.probe===tag&&e.status===429),attemptedPeak:Math.max(0,...receipt.core.filter((e:any)=>e.probe===tag).map((e:any)=>e.attemptedConcurrent)),driverPeak:Math.max(0,...receipt.driver.filter((e:any)=>e.probe===tag).map((e:any)=>e.active))};
     receipt.startup.push(result); console.log('STARTUP',JSON.stringify(result));
   } finally {
     await o.ctx.close(); // Includes EventSource and rooms poll; never carry a failed page forward.
     await waitFor(()=>driverActive===0&&[...logical.values()].every(n=>n===0),'startup reads physically settled',5000);
   }
 }
 receipt.driverPeak=driverPeak; receipt.status=receipt.startup.every((e:any)=>e.emptyHint&&!e.busy.length)?'PASS':'OBSERVED_STARTUP_FAILURE';
 if(process.env.REQUIRE_NO_429==='1'&&receipt.status!=='PASS')process.exitCode=1;
} catch(error:any) {receipt.error=error.stack;process.exitCode=1;}
finally {
 HubCore.prototype.current=originalCurrent; directory.checkEligibility=originalEligibility;
 writeFileSync(join(art,'startup-receipt.json'),JSON.stringify(receipt,null,2));
 for(const c of contexts)await c.close();
 await fx.close();await service.close();await directory.close();await peer.close();certs.cleanup();rmSync(scratch,{recursive:true,force:true});tls.connect=originalConnect;syncBuiltinESMExports();
 writeFileSync(join(art,'startup-cleanup.json'),JSON.stringify({allCloseCallsCompleted:true,source:receipt.source,driverActive,at:new Date().toISOString()},null,2));
}
