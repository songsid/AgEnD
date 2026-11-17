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
try{
 for(const [index,c] of cases.entries()){
  const admin=await rig.signIn("admin"),fleetId=randomUUID(),exposureId=randomUUID(),link=rig.link(fleetId,rig.admin,1,["welcome-caps-v1","room-ask-v1","room-answer-status-v1"]);
  await rig.http.receive(rig.frame("exposure.snapshot",{revision:1,exposures:[{id:exposureId,fleetId,owner:rig.admin,displayName:"Notes",revision:1,state:"published",dataViewId:"notes",allowedTools:[],policyDigest:"a".repeat(64)}]},link),link);
  const made=await rig.call(admin,"POST","/hub/v1/rooms",{name:c.lang==="en"?"Release questions":"版本提問",agents:[exposureId]});check(made.status===200,"create failed");const roomId=made.json.room.id,question=c.lang==="en"?"Are the release notes ready?":"版本說明準備好了嗎？";
  const posted=await rig.call(admin,"POST",`/hub/v1/rooms/${roomId}/messages`,{text:question,mentions:[exposureId],idempotencyKey:randomUUID()});check(posted.status===200,"post failed");
  const deadline=Date.now()+10000;while(!rig.sent.some(s=>s.frame.type==="room.ask"&&s.frame.payload.roomId===roomId)){if(Date.now()>deadline)throw Error("ask timeout");await new Promise(r=>setTimeout(r,10));}
  const ask=rig.sent.find(s=>s.frame.type==="room.ask"&&s.frame.payload.roomId===roomId)!.frame.payload as any;
  const ctx=await browser.newContext({viewport:c.device==="phone"?{width:390,height:844}:{width:1366,height:900},isMobile:c.device==="phone",hasTouch:c.device==="phone",locale:c.lang==="en"?"en-US":"zh-TW",colorScheme:c.theme,ignoreHTTPSErrors:true});
  await ctx.addInitScript({content:`window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});localStorage.setItem('agend_tour_done','1');`});
  await ctx.route("**/*",(route:any)=>{if(new URL(route.request().url()).origin!==origin){receipt.foreign.push("blocked");return route.abort();}return route.continue();});
  const p=await ctx.newPage();p.setDefaultTimeout(15000);p.on("pageerror",(e:any)=>receipt.pageErrors.push(String(e)));const tag=`${c.device}-${c.theme}-${c.lang}`;
  try{
   await p.goto(origin+"/ui/hub?room="+roomId);await p.fill("#hubLogin","admin");await p.fill("#hubPassword","pw-admin");await p.locator(".hub-signin button[type=submit]").click();
   await p.waitForFunction((text:string)=>document.querySelector(".thread")?.textContent?.includes(text),question);await shot(p,`${tag}-working`);
   const base={messageId:ask.messageId,roomId,exposureId};await rig.http.receive(rig.frame("room.answer",{...base,answerId:randomUUID(),text:"",notAnswered:"finished-without-answer"},link),link);
   const reason=c.lang==="en"?"The agent finished without answering here":"Agent 已結束處理，但沒有在這裡回答";
   await p.waitForFunction((text:string)=>document.querySelector(".thread")?.textContent?.includes(text),reason);await shot(p,`${tag}-no-answer`);
   const answer=c.lang==="en"?"The release notes are ready. This is the late answer.":"版本說明已準備好。這是稍後補上的回答。";await rig.http.receive(rig.frame("room.answer",{...base,answerId:randomUUID(),text:answer},link),link);
   await p.waitForFunction((text:string)=>document.querySelector(".thread")?.textContent?.includes(text),answer);check(!(await p.locator(".thread").innerText()).includes(reason),"old missing-answer notice remained");check(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"overflow");await shot(p,`${tag}-answered`);
   receipt.cases.push({tag,status:"PASS",checks:["working before marker","localized No answer reason","late answer replaces notice","no horizontal overflow"]});
  }finally{await ctx.close();}
 }
}catch(e:any){receipt.error=String(e?.stack||e);}
finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));await rig.close();rmSync(keys,{recursive:true,force:true});receipt.status=receipt.cases.length===2&&!receipt.pageErrors.length&&!receipt.error?"PASS":"FAIL";writeFileSync(join(out,"receipt.json"),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));}
process.exitCode=receipt.status==="PASS"?0:1;
