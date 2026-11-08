/** #3402 author startup campaign, derived from Sentinel's public be86b713 handoff (input SHA256 c2aed1456d7a9353455aa0bff02475080589795232a89dac50a6fb59cb0a3c85).
 * Keeps the production verified-LDAPS peer and transparent concurrency diagnostics. Uses direct private Chromium;
 * explicit Hub home only, no HOME/CODEX_HOME changes or fleet/member/CLI activation. MODE=before retains f61 UI bytes.
 * REPO, ART, OUT, PW_DIR, CHROME, FONTCONFIG_FILE, short TMPDIR. MATRIX=full REPEATS=3 REQUIRE_NO_429=1.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import yaml from "js-yaml";
import { directoryCertificates } from "../../../tests/support/hub-directory-ca-fixture.js";
import { groupWirePeer, GROUP_A, GROUP_DN } from "../../../tests/support/hub-group-directory-wire.js";
import { createHubDirectory } from "../../../src/hub/directory/directory.js";
import { createHubInitializer } from "../../../src/hub/init/initializer.js";
import { hubIdentityProvider } from "../../../src/hub/init/identity.js";
import { createBrowserCertificate } from "../../../src/hub/init/browser-certificate.js";
import { createHubServerFactory } from "../../../src/hub/compose/server.js";
import { S3B_HTTP_ENTRY } from "../../../src/hub/runtime.js";
import { freeHubPort } from "../../../tests/helpers/hub-rig.js";

const repo = process.env.REPO!, out = process.env.OUT!, mode = process.env.MODE ?? "current", skew = process.env.SKEW === "1";
if (!repo || !out) throw Error("REPO and OUT required");
mkdirSync(out, { recursive: true }); const art = process.env.ART!; mkdirSync(art, { recursive: true });
const scratch = mkdtempSync(join(art, "browser-")); chmodSync(scratch, 0o700);
const probeHubHome = join(scratch, "hub"); mkdirSync(probeHubHome, { mode: 0o700 });
const matrix = (spec: string) => { const all: Array<{device:string;theme:string;lang:string}> = [];
  for (const device of ["desk","phone"]) for (const theme of ["light","dark"]) for (const lang of ["en","zh-TW"]) all.push({device,theme,lang});
  return spec === "quick" ? [all[0]!,all[7]!] : all; };
const caseName = (c: any) => `${c.device}-${c.theme}-${c.lang}`;
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
const material = await createBrowserCertificate(probeHubHome, origin);
const plan = { name: "Example Team Hub", webOrigin: origin, memberOrigin, webListen: { host: "127.0.0.1", port: webPort }, memberListen: { host: "127.0.0.1", port: memberPort },
  webTls: { certFile: material.certFile, keyFile: material.keyFile }, directory: directoryConfig, bindPasswordRef: "file:hub/secrets/directory-bind",
  administrator: { realm: "example", objectId: users[0].id }, retention: { contentDays: 7, eventDays: 30 }, coexistence: "dedicated" as const };
const init = createHubInitializer({ home: probeHubHome, identity: hubIdentityProvider(), probe: { pidAlive: () => false } });
const confirmation = await init.prepareConfirmation(plan, { bindPassword: "Dummy-service-only" }); await init.commit(plan, confirmation.reference);
const cfg = (yaml.load(readFileSync(join(probeHubHome, "fleet.yaml"), "utf8")) as any).hub;
const service = await createHubServerFactory({ home: probeHubHome, components: { http: S3B_HTTP_ENTRY }, createDirectory: () => directory, report: () => {}, log: () => {} })(cfg, () => true);
await service.start();
const requireBrowser = createRequire(join(process.env.PW_DIR!, "package.json"));
const pw = requireBrowser("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
const fx = { browser, base: origin, close: () => browser.close() };
const receipt: any = { mode, skew, source: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  browser: fx.browser.version(), boundary: "Startup-only: sealed Hub HTTPS, production AD driver over owned synthetic verified TLS/BER peer, real browser. Direct owned Chromium only; no fleet fixture, member, agent, model, daemon, native CLI or account runs.", stories:[],clicks:[],deliveries:[],holds:[],checks: [], shots: [], errors: [], csp: [], foreign: [], api: [] };
const check = (name: string, ok: unknown) => { receipt.checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); };
const oldRef = process.env.OLD_REF ?? "f61e3608cdf888396474a99d1c76f766c8bf314f", old = (file: string) => execFileSync("git", ["-C", repo, "show", `${oldRef}:src/ui/${file}`], { encoding: "utf8", maxBuffer: 16 << 20 });
const contexts: any[] = [];
const shot = async (p: any, name: string) => { await p.evaluate(() => document.fonts.ready); await p.screenshot({ path: join(out, name + ".png"), fullPage: true }); receipt.shots.push(name + ".png"); };
async function context(c: any, oldClient: boolean | string = false) {
  const ctx = await fx.browser.newContext({ viewport: c.device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 },
    isMobile: c.device === "phone", hasTouch: c.device === "phone", locale: c.lang === "en" ? "en-US" : "zh-TW", colorScheme: c.theme, ignoreHTTPSErrors: true }); contexts.push(ctx);
  await ctx.addInitScript({ content: `window.__name=fn=>fn;try{localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});localStorage.setItem('agend_tour_done','1');localStorage.setItem('agend_firstrun_dismissed','1')}catch{};window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));` });
  await ctx.route("**/*", (r: any) => {
    const u = new URL(r.request().url()); if (![origin, fx.base].includes(u.origin)) { receipt.foreign.push(u.origin); return r.abort(); }
    let retained: string | null = null;
    if (mode === "before" && ["/ui/js/panel-hub.js", "/ui/js/hub-welcome.js", "/ui/js/hub-client.js", "/ui/js/hub-quick-pairing.js", "/ui/js/hub-group-policy.js"].includes(u.pathname)) retained = u.pathname.slice(7);
    if (oldClient && u.pathname === `/ui/js/${oldClient === true ? "hub-client.js" : oldClient}`) retained = oldClient === true ? "hub-client.js" : oldClient;
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
async function story(id:string,fn:()=>Promise<void>){const start=receipt.checks.length;await fn();receipt.stories.push({id,status:"PASS",checks:receipt.checks.length-start});}
async function click(p:any,selector:string,label:string){receipt.clicks.push(label);await p.locator(selector).click();}
async function waitFor(fn:()=>boolean,name:string,ms=12000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error(name);await new Promise(r=>setTimeout(r,25));}}
let admin:any;

const { HubCore } = await import(repo + '/src/hub/http/core.ts');
const { personKeyString } = await import(repo + '/src/hub/identity.ts');
const originalCurrent = HubCore.prototype.current, originalEligibility = directory.checkEligibility;
let driverActive = 0, driverPeak = 0, probe = '', logical = new Map<string, number>();
let blocked: { id: string; entered: number; promise: Promise<void> } | null = null;
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
   try { const gate = blocked; if (gate && args[0]?.objectId === gate.id) { gate.entered++; await gate.promise; }
     return await originalEligibility.apply(directory, args as any); }
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
 if (process.env.BUSY_CONTROL === "1" && mode !== "before") {
   receipt.busyControls = [];
   for (const [c,adminMode] of [[cases[0],false],[cases[cases.length-1],false],[cases[0],true]] as const) {
     const login = adminMode ? "admin" : "ungranted", u = person(login), previous = [...u.groups];
     if (!adminMode) u.groups = []; // Current UI offers Retry on a genuine unknown-membership projection.
     probe = `${caseName(c)}-busy-${login}`; const o = await context(c, adminMode ? false : "hub-group-strings.js");
     let release = () => {}; let occupied: Promise<number>[] = [];
     const responses: any[] = [], path = adminMode ? "/hub/v1/admin/group-policy" : "/hub/v1/me/welcome";
     o.p.on("response", (r:any) => { if (new URL(r.url()).pathname === path && r.request().method() === "GET") responses.push({status:r.status(),at:Date.now(),retryAfter:r.headers()["retry-after"]}); });
     try {
       await signIn(o.p,login,adminMode ? "/ui/hub/admin" : "/ui/hub");
       await o.p.locator(adminMode ? '[data-entry="group-permissions"] .btn' : '[data-welcome="unknown"] .btn').waitFor();
       await waitFor(()=>driverActive===0&&[...logical.values()].every(n=>n===0),"busy setup settled");
       const promise = new Promise<void>(r => { release = r; }); blocked = { id:u.id, entered:0, promise };
       occupied = Array.from({length:4},()=>o.ctx.request.get(origin+"/hub/v1/rooms",{timeout:20000}).then((r:any)=>r.status()).catch(()=>0));
       await waitFor(()=>blocked?.entered===4,"four owned authorized requests occupied eligibility");
       responses.length = 0;
       await o.p.locator(adminMode ? '[data-entry="group-permissions"] .btn' : '[data-welcome="unknown"] .btn').click();
       await o.p.locator(adminMode ? '[data-groups="busy"]' : '[data-welcome="busy"]').waitFor();
       check(probe+" busy wording",(await o.p.locator('[role="status"]').allTextContents()).join(" ").includes(c.lang==="en"?"The Hub is busy":"Hub 忙碌中"));
       await shot(o.p,probe); await geometry(o.p,probe);
       const refusal=responses.find(r=>r.status===429);check(probe+" real429withRetryAfter10",refusal?.retryAfter==="10");
       await o.p.waitForTimeout(1200);check(probe+" no early retry",responses.length===1);
       u.groups = previous; blocked = null; release(); const occupiedStatuses=await Promise.all(occupied);
       await o.p.locator(adminMode ? '.hub-groups-list' : '[data-welcome="nothing-shared"]').waitFor({timeout:15000});
       const recovered=responses.find(r=>r.status===200);check(probe+" fresh automatic recovery after header",recovered&&recovered.at-refusal.at>=9900);
       await shot(o.p,probe+"-recovered");await geometry(o.p,probe+"-recovered");
       receipt.busyControls.push({probe,path,responses,occupiedStatuses,retainedStrings:!adminMode});
     } finally { blocked=null;release();await Promise.allSettled(occupied);u.groups=previous;await o.ctx.close();
       await waitFor(()=>driverActive===0&&[...logical.values()].every(n=>n===0),"busy reads physically settled",5000); }
   }
 }
 if (process.env.SKEW_CASES === "1" && mode !== "before") {
   receipt.skewControls=[];
   for (const file of ["hub-client.js","hub-group-strings.js"]) {
     probe = `skew-${file}`;const c=cases[cases.length-1],o=await context(c,file);
     try {
       await signIn(o.p,"ungranted");await o.p.locator('[data-welcome="nothing-shared"]').waitFor();
       const peak=Math.max(0,...receipt.core.filter((e:any)=>e.probe===probe).map((e:any)=>e.attemptedConcurrent));
       check(probe+" current empty guidance and bounded reads",peak<=4);await shot(o.p,probe);await geometry(o.p,probe);
       receipt.skewControls.push({file,attemptedPeak:peak,emptyHint:true});
     } finally {await o.ctx.close();await waitFor(()=>driverActive===0&&[...logical.values()].every(n=>n===0),"skew reads settled",5000);}
   }
 }
 check("no browser errors",receipt.errors.length===0);check("no CSP violations",receipt.csp.length===0);check("no foreign requests",receipt.foreign.length===0);
 receipt.driverPeak=driverPeak; receipt.status=receipt.startup.every((e:any)=>e.emptyHint&&!e.busy.length&&e.attemptedPeak<=4&&e.driverPeak<=4)?'PASS':'OBSERVED_STARTUP_FAILURE';
 if(process.env.REQUIRE_NO_429==='1'&&receipt.status!=='PASS')process.exitCode=1;
} catch(error:any) {receipt.error=error.stack;process.exitCode=1;}
finally {
 HubCore.prototype.current=originalCurrent; directory.checkEligibility=originalEligibility;
 writeFileSync(join(art,'startup-receipt.json'),JSON.stringify(receipt,null,2));
 for(const c of contexts)await c.close();
 await fx.close();await service.close();await directory.close();await peer.close();certs.cleanup();rmSync(scratch,{recursive:true,force:true});tls.connect=originalConnect;syncBuiltinESMExports();
 writeFileSync(join(art,'startup-cleanup.json'),JSON.stringify({allCloseCallsCompleted:true,source:receipt.source,driverActive,at:new Date().toISOString()},null,2));
}
