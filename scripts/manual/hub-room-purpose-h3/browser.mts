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


const cases=[{device:"desk",theme:"light",lang:"en"},{device:"phone",theme:"dark",lang:"zh-TW"}];
try {
 for(const [index,c] of cases.entries()) {
  const login="admin";
  const ctx=await browser.newContext({viewport:c.device==="phone"?{width:390,height:844}:{width:1366,height:900},isMobile:c.device==="phone",hasTouch:c.device==="phone",locale:c.lang==="en"?"en-US":"zh-TW",colorScheme:c.theme,ignoreHTTPSErrors:true});
  await ctx.addInitScript({content:`window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});localStorage.setItem('agend_tour_done','1');`});
  await ctx.route("**/*",(route:any)=>{if(new URL(route.request().url()).origin!==origin){receipt.foreign.push("blocked");return route.abort();}return route.continue();});
  const p=await ctx.newPage();p.setDefaultTimeout(15000);p.on("pageerror",(e:any)=>receipt.pageErrors.push(String(e)));const tag=`${c.device}-${c.theme}-${c.lang}`;
  try {
   await p.goto(origin+"/ui/hub");await p.fill("#hubLogin",login);await p.fill("#hubPassword","pw-"+login);await p.locator(".hub-signin button[type=submit]").click();
   if(c.device==="phone"){await p.locator(".hub-back:visible").first().click();await p.locator(".hub-new-room:visible").first().click();}else await p.getByRole("button",{name:"New room",exact:true}).first().click();await p.locator("#hubRoomName").fill(c.lang==="en"?"Release questions":"版本提問");
   const purpose=c.lang==="en"?"Release planning and questions for the web team. ".repeat(4).trim():"討論版本規劃、上線時程與文件問題，讓每位成員都能找到最新進度。".repeat(4);
   await p.locator("#hubRoomPurpose").fill(purpose);await shot(p,`${tag}-create`);
   await p.getByRole("button",{name:c.lang==="en"?"Create":"建立",exact:true}).click();await p.locator(".hub-room-purpose-trigger").waitFor();
   check((await p.locator(".hub-room-purpose-trigger").innerText())===purpose,"header purpose mismatch");await shot(p,`${tag}-room`);
   await p.locator(".hub-room-purpose-trigger").click();await p.locator(".hub-room-purpose-full").waitFor();check(await p.locator(".hub-room-purpose-full").innerText()===purpose,"full purpose mismatch");await shot(p,`${tag}-full`);await p.keyboard.press("Escape");
   if(!await p.locator(".hub-room-settings-link").isVisible())await p.locator(".hub-room-rail-toggle").click();
   check((await p.locator(".hub-room-purpose-panel").innerText()).includes(purpose),"members purpose missing");await p.locator(".hub-room-settings-link").click();
   const edited=c.lang==="en"?"Questions and decisions for the next release.":"下一版的問題與決議。";
   await p.locator("#hubRoomSettingsPurpose").fill(edited);await shot(p,`${tag}-settings`);await p.locator(".hub-room-purpose-form button[type=submit]").click();
   await p.waitForFunction((value:string)=>document.querySelector(".hub-room-purpose-trigger")?.textContent===value,edited);
   check(await p.locator("form form").count()===0,"nested forms");check(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"horizontal overflow");
   receipt.cases.push({tag,status:"PASS",checks:["create with optional purpose","header shows purpose","tap shows full text","members show purpose","manager edit saves","no nested forms or horizontal overflow"]});
  } finally {await ctx.close();}
 }
} catch(e:any){receipt.error=String(e?.stack||e);}
finally {await browser.close();await new Promise<void>(r=>server.close(()=>r()));await rig.close();rmSync(keys,{recursive:true,force:true});receipt.status=receipt.cases.length===2&&!receipt.pageErrors.length&&!receipt.error?"PASS":"FAIL";writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));}
process.exitCode=receipt.status==="PASS"?0:1;
