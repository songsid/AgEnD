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
const rig = await s3bRig({ webOrigin: origin });
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

const owner=rig.addPerson("owner","Taylor"),asker=rig.addPerson("reader","Morgan"),link=rig.link(randomUUID(),owner);
const exposure={id:randomUUID(),fleetId:link.fleetId,owner,displayName:"Guide",revision:1,state:"published",dataViewId:"agent",allowedTools:[],policyDigest:"b".repeat(64)};
await rig.http.receive(rig.frame("exposure.snapshot",{revision:1,exposures:[exposure]},link) as never,link);
const o=await rig.signIn("owner"),a=await rig.signIn("reader");
const grant=(await rig.call(o,"POST","/hub/v1/grants",{exposureId:exposure.id,exposureRevision:1,login:"reader",days:7})).json.grant;
const room=(await rig.call(a,"POST","/hub/v1/rooms",{exposureId:exposure.id,grantId:grant.id})).json.room;
const cases=[{device:"desk",theme:"light",lang:"en"},{device:"phone",theme:"dark",lang:"zh-TW"}];
async function open(c:any,login:string){
 const ctx=await browser.newContext({viewport:c.device==="phone"?{width:390,height:844}:{width:1366,height:900},isMobile:c.device==="phone",hasTouch:c.device==="phone",locale:c.lang==="en"?"en-US":"zh-TW",colorScheme:c.theme,ignoreHTTPSErrors:true});
 await ctx.addInitScript({content:`window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});`});
 await ctx.route("**/*",(route:any)=>{if(new URL(route.request().url()).origin!==origin){receipt.foreign.push("blocked");return route.abort();}return route.continue();});
 const p=await ctx.newPage();p.setDefaultTimeout(15000);p.on("pageerror",(e:any)=>receipt.pageErrors.push(String(e)));
 await p.goto(origin+"/ui/hub");await p.fill("#hubLogin",login);await p.fill("#hubPassword","pw-"+login);await p.locator(".hub-signin button[type=submit]").click();await p.locator(".hub-session-row").first().waitFor({state:"attached"});return {p,ctx};
}
try{
 for(const c of cases){
  await rig.call(o,"PUT",`/hub/v1/exposures/${exposure.id}/intro`,{revision:1,text:""});
  const tag=`${c.device}-${c.theme}-${c.lang}`,value=c.lang==="en"?"I handle project notes and room questions.":"我負責整理專案筆記與房間提問。",b=await open(c,"owner");
  try{
   await b.p.goto(`${origin}/ui/hub/exposures?agent=${exposure.id}`);await b.p.locator(".hub-agent-intro input").waitFor();await shot(b.p,`${tag}-before`);
   await b.p.locator(".hub-agent-intro input").fill(value);await b.p.locator(".hub-agent-intro button").click();
   await b.p.waitForFunction((text:string)=>document.querySelector(".hub-agent-intro input")?.value===text&&document.querySelector(".hub-agent-intro time"),value);
   await shot(b.p,`${tag}-after`);
   const catalog=(await rig.call(a,"GET","/hub/v1/exposures")).json;check(catalog.askable[0].exposure.intro===value,"public intro differs");
  }finally{await b.ctx.close();}
  const reader=await open(c,"reader");try{await reader.p.goto(`${origin}/ui/hub?room=${room.id}`);await reader.p.locator(".hub-chat-title").getByText(value,{exact:true}).waitFor();await shot(reader.p,`${tag}-reader`);}finally{await reader.ctx.close();}
  receipt.cases.push({tag,status:"PASS",checks:["owner explicitly saves","public catalog matches","direct chat shows introduction"]});
 }
}catch(e:any){receipt.error=String(e?.stack||e);}
finally{
 await browser.close();await new Promise<void>(r=>server.close(()=>r()));await rig.close();rmSync(keys,{recursive:true,force:true});
 receipt.status=receipt.cases.length===2&&!receipt.pageErrors.length&&!receipt.error?"PASS":"FAIL";
 writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}
process.exitCode=receipt.status==="PASS"?0:1;
