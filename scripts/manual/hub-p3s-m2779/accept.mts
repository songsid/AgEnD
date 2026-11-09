/** M-2779: actual pending Settings requests, page-local summaries and truthful Stop copy.
 * Owned Fleet HTTP/browser only; dummy Hub is never contacted. No confirmation is approved.
 * Set REPO, OUT, PW_DIR, CHROME, FONTCONFIG_FILE; choose MATRIX and optional BEFORE/SKEW.
 */
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,chmodSync,rmSync,existsSync} from "node:fs";
import {resolve,join,dirname} from "node:path";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
const repo=resolve(process.env.REPO!),out=resolve(process.env.OUT!);mkdirSync(out,{recursive:true});
const home=mkdtempSync(join(out,"owned-")),bin=join(home,"bin");mkdirSync(bin);
process.env.AGEND_HOME=home;process.env.TMUX_TMPDIR=join(home,"tmux");
for(const k of ["OPENAI_API_KEY","ANTHROPIC_API_KEY","DISCORD_BOT_TOKEN","TELEGRAM_BOT_TOKEN"])delete process.env[k];
for(const name of ["tmux","agend","claude","codex","kiro-cli"]){const file=join(bin,name);writeFileSync(file,`#!${process.execPath}\nprocess.exit(97)\n`);chmodSync(file,0o755)}
process.env.PATH=[bin,dirname(process.execPath),"/usr/bin","/bin"].join(":");process.env.AGEND_TMUX_BIN=join(bin,"tmux");
const {bootFixture,matrix,caseName}=await import("../smoke-fixture/index.mts");
const r:any={head:execFileSync("git",["rev-parse","HEAD"],{cwd:repo,encoding:"utf8"}).trim(),checks:[],shots:[],errors:[],foreign:[],cases:[],assetSkew:!!process.env.ASSET_ROOT,scope:"Real Fleet HTTP/browser/pending Settings gate; no response stubs. Stop dialog uses an initialized config projection without starting that Hub; actual Stop/Run session lifecycle is a separate owned HTTPS/LDAPS test. No real account/directory/native/model/pilot. Dummy Hub is never contacted."};
const check=(name:string,ok:boolean,detail?:unknown)=>{r.checks.push({name,ok,detail});if(!ok)throw Error(name)};
let fx:any;
const before=process.env.BEFORE==="1",skew=process.env.SKEW??"",base="95fbbd1adf98ae861972136ae6efc2162aa7ff61";
const digest=(data:Buffer|string)=>createHash("sha256").update(data).digest("hex");
const git=(root:string,...args:string[])=>execFileSync("git",args,{cwd:root,encoding:"utf8"}).trim();
const image=(root:string)=>{
 const status=git(root,"status","--porcelain","--untracked-files=all","--","src","scripts");
 if(status)throw Error("Capture requires committed src/scripts: "+status);
 return {head:git(root,"rev-parse","HEAD"),tree:git(root,"rev-parse","HEAD^{tree}"),sourceStatus:status};
};
const runner=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
const assets=new Map<string,Set<string>>(),responses:Promise<void>[]=[],substitutions=new Map<string,unknown>();
const inputs=["src/ui/shared/app-shell.js","src/ui/shared/app-i18n.js","src/ui/settings-hub-run.js","src/locale.ts","src/ui/app.html"];
const sourceInputs=(root:string)=>Object.fromEntries(inputs.map(path=>[path,digest(readFileSync(join(root,path)))]));
const originalImages={server:image(repo),runner:image(runner),...(process.env.CANDIDATE?{candidate:image(resolve(process.env.CANDIDATE))}:{})};
r.provenance={startedAt:new Date().toISOString(),...originalImages,runnerScript:digest(readFileSync(fileURLToPath(import.meta.url))),sourceInputs:sourceInputs(repo),...(process.env.CANDIDATE?{candidateInputs:sourceInputs(resolve(process.env.CANDIDATE))}:{}),retainedCommit:skew?base:null};
try{
 fx=await bootFixture({port:Number(process.env.HP??55710),instances:1,classic:false});r.browser=fx.browser.version();
 const {setLocale}=await import(repo+"/src/locale.ts");setLocale("en");r.serverLocale="en";r.before=before;r.skew=skew;
 for(const name of ["startInstance","startInstanceUnattended","restartInstance","restartFleet","stopInstance"])fx.fm[name]=async()=>{throw Error("Refused native lifecycle "+name)};
 fx.fm.rawFleetConfig={...fx.fm.rawFleetConfig,hub:{enabled:true,hubId:"4c3b2a19-0e8f-4d7c-9b6a-5f4e3d2c1b0a",name:"Synthetic Hub",webOrigin:"https://hub.example.test:19443",memberOrigin:"https://hub.example.test:19444"}};
 for(const c of matrix()){
  const tag=caseName(c),zh=c.lang==="zh-TW",{ctx,page:p}=await fx.page(c,{path:"/settings/hub"});
  ctx.on("response",(response:any)=>{const u=new URL(response.url());if(u.origin!==fx.base||!/(?:\.js|\.css)$/.test(u.pathname))return;responses.push((async()=>{try{const bytes=await response.body();const hashes=assets.get(u.pathname)??new Set<string>();hashes.add(digest(bytes));assets.set(u.pathname,hashes)}catch(e){r.errors.push("Asset body: "+u.pathname+" "+String(e))}})())});
  const shot=async(page:any,name:string)=>{await page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())))});await page.screenshot({path:join(out,name+".png")});r.shots.push(name+".png")};
  p.on("pageerror",(e:any)=>r.errors.push(e.message));
  await ctx.route("**/*",(route:any)=>{const u=new URL(route.request().url());if(u.origin!==fx.base){r.foreign.push(u.origin);return route.abort()}
   const retained=skew==="old-shell"?"shared/app-shell.js":skew==="old-run"?"settings-hub-run.js":skew==="old-i18n"?"shared/app-i18n.js":null;
   if(retained&&u.pathname.endsWith("/"+retained.split('/').pop())){const body=execFileSync("git",["show",base+":src/ui/"+retained],{cwd:repo});substitutions.set(u.pathname,{commit:base,file:"src/ui/"+retained,digest:digest(body)});return route.fulfill({contentType:"application/javascript",body})}
   if(skew==="old-server"&&["/assets/app-shell.js","/ui/js/settings-hub-run.js"].includes(u.pathname)){const relative="src/ui/"+(u.pathname.startsWith('/assets/')?'shared/'+u.pathname.split('/').pop():u.pathname.split('/').pop()!);const file=join(process.env.CANDIDATE!,relative);substitutions.set(u.pathname,{commit:r.provenance.candidate.head,file:relative,digest:digest(readFileSync(file))});return route.fulfill({path:file,contentType:"application/javascript"})}
   return route.continue()});
  await p.reload();await p.locator('#hubCompanyAddress').waitFor();await p.fill('#hubCompanyAddress','https://synthetic-hub.example.test');await p.fill('#hubCompanyFleetName','QA Fleet');
  const response=p.waitForResponse((q:any)=>new URL(q.url()).pathname.endsWith('/company-join/start')&&q.request().method()==='POST'),popup=ctx.waitForEvent('page');await p.locator('.s-company-join button[type=submit]').click();
  const first=await response,body=await first.json(),id=body.pending_change?.id,wait=await popup;wait.on('pageerror',(e:any)=>r.errors.push(e.message));check(tag+' actual pending gate',first.status()===202&&typeof id==='string');
  const card='.pending-card[data-pending="'+id+'"]';await p.locator(card+' .pending-summary').waitFor();await wait.waitForLoadState('domcontentloaded');await wait.locator('.s-company-join').getByRole('button',{name:zh?'開啟本機確認':'Review local confirmation',exact:true}).click();await wait.locator(card+' .pending-summary').waitFor();
  const english='Connect this Fleet to Hub https://synthetic-hub.example.test using your company account. Agent sharing stays separate.',chinese='以公司帳號將這個 Fleet 連接到 Hub https://synthetic-hub.example.test。分享 Agent 需另外選擇。',expected=zh&&!before&&skew!=='old-shell'?chinese:english;
  for(const[which,page]of [['settings',p],['wait',wait]]as const){const text=await page.locator(card+' .pending-summary').innerText();check(tag+' '+which+' exact summary',text===expected);await page.locator(card).scrollIntoViewIfNeeded();await shot(page,tag+'-'+which+'-summary')}
  const withdrawn=wait.waitForResponse((q:any)=>q.request().method()==='DELETE'&&new URL(q.url()).pathname.endsWith('/'+id));await wait.locator(card).getByRole('button',{name:zh?'撤回':'Withdraw',exact:true}).click();check(tag+' exact withdrawal',(await withdrawn).status()===200);await wait.close();
  await p.goto(fx.base+'/settings/hub');await p.locator('#hubRunOn').waitFor();await p.locator('#hubRunOn').click();await p.locator('dialog[open]').waitFor();
  const text=await p.locator('dialog[open]').innerText(),old=before||skew==='old-run';check(tag+' Stop promise',old?/signed out|登出/.test(text):! /signed out|登出/.test(text)&&(zh?/有效.*登入.*恢復/.test(text):/valid sign-ins.*resume/i.test(text)));await shot(p,tag+'-stop-dialog');
  check(tag+' no overflow',await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  if(c.device==='phone'){const taps=await p.locator('dialog[open] button.btn').evaluateAll((es:any[])=>es.map(e=>{const b=e.getBoundingClientRect();return {label:e.textContent,cls:e.className,w:b.width,h:b.height}}));check(tag+' dialog action taps',taps.every((b:any)=>b.w>=43.5&&b.h>=43.5),taps);}
  await p.locator('dialog[open]').getByRole('button',{name:zh?'取消':'Cancel',exact:true}).click();check(tag+' cancel keeps Run',await p.locator('#hubRunOn').isChecked());r.cases.push(tag);await Promise.all(responses);await ctx.close();
 }
 await Promise.all(responses);
 for(const path of ["/assets/app-shell.js","/ui/js/settings-hub-run.js"]){const relative=path.startsWith('/assets/')?"src/ui/shared/app-shell.js":"src/ui/settings-hub-run.js";const override:any=substitutions.get(path);check(path+' served source digest',assets.get(path)?.size===1&&assets.get(path)?.has(override?.digest??digest(readFileSync(join(repo,relative))))===true)}
 check('source images stayed fixed',JSON.stringify(originalImages)===JSON.stringify({server:image(repo),runner:image(runner),...(process.env.CANDIDATE?{candidate:image(resolve(process.env.CANDIDATE))}:{})}));
 check('no foreign requests or script errors',!r.foreign.length&&!r.errors.length);r.status='PASS';
}catch(e:any){r.status='FAIL';r.error=e.stack;process.exitCode=1}
finally{if(fx)await fx.close();rmSync(home,{recursive:true,force:true});r.cleaned=true;r.provenance.finishedAt=new Date().toISOString();r.provenance.servedAssets=Object.fromEntries([...assets.entries()].sort().map(([path,hashes])=>[path,[...hashes].sort()]));r.provenance.substitutions=Object.fromEntries(substitutions);writeFileSync(join(out,'receipt.json'),JSON.stringify(r,null,2));console.log(JSON.stringify({status:r.status,cases:r.cases.length,checks:r.checks.length,shots:r.shots.length,error:r.error}))}
