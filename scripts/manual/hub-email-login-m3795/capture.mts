/** Scratch real Hub listener and synthetic directory; never a live Hub/directory/account. */
import { createRequire } from 'node:module';
import { createServer } from 'node:https';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { s3bRig } from '../../../tests/helpers/hub-s3b-rig.js';
import { provisionHubIdentity } from '../../../src/hub/tls.js';
const OUT=process.env.OUT!, REPO=process.env.REPO!, BASE=process.env.BASE!, PW=process.env.PW_DIR!;
const home=mkdtempSync(join(tmpdir(),'agend-email-capture-'));mkdirSync(OUT,{recursive:true});
const digest=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const inputs=['panel-hub.js','hub-strings.js'];
const baseline=Object.fromEntries(inputs.map(n=>[n,execFileSync('git',['-C',REPO,'show',`${BASE}:src/ui/${n}`],{encoding:'utf8'})]));
const source=Object.fromEntries(inputs.map(n=>[n,{base:digest(baseline[n]!),candidate:digest(readFileSync(join(REPO,'src/ui',n)))}]));
await provisionHubIdentity({home,memberOrigin:'https://127.0.0.1:1'});
let rig:Awaited<ReturnType<typeof s3bRig>>|undefined,browser:any;
const server=createServer({key:readFileSync(join(home,'hub/keys/tls-key.pem')),cert:readFileSync(join(home,'hub/keys/tls-cert.pem'))},(req,res)=>{if(!rig?.http.handle(req,res)){res.writeHead(404);res.end();}});
const stages=process.env.STAGE==='after'?['after']:['before','after'];
const previous=stages.length===1?JSON.parse(readFileSync(join(OUT,'capture-inputs.json'),'utf8')):null;
const views:any[]=previous?.views.filter((v:any)=>v.stage==='before')??[];
try{
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin=`https://127.0.0.1:${(server.address() as any).port}`;
 rig=await s3bRig({webOrigin:origin});rig.httpDeps.config={...rig.config,loginWithEmail:true};await rig.restartHttp();
 const pw=createRequire(PW+'/')('playwright-core');browser=await pw.chromium.launch({executablePath:process.env.CHROME,args:['--no-sandbox']});
 for(const stage of stages)for(const device of ['desk','phone'])for(const lang of ['en','zh-TW'])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:device==='desk'?1366:390,height:device==='desk'?900:844},deviceScaleFactor:1,ignoreHTTPSErrors:true,isMobile:device==='phone',hasTouch:device==='phone',colorScheme:theme});
  await context.addInitScript(({lang,theme}:any)=>{localStorage.setItem('agend_lang',lang);localStorage.setItem('agend_theme',theme);localStorage.setItem('agend_tour_done','1');},{lang,theme});
  const page=await context.newPage(),errors:string[]=[],delivered:any[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
  if(stage==='before')await page.route('**/*',async(route:any)=>{
   const u=new URL(route.request().url()),n=u.pathname.split('/').pop()!;
   if(inputs.includes(n)){const body=baseline[n];delivered.push({file:n,sha256:digest(body)});await route.fulfill({status:200,contentType:'text/javascript',body});}
   else if(u.pathname==='/ui/hub'){const response=await route.fetch();const body=(await response.text()).replace('data-hub-login="email-or-account"','data-hub-login="no-at"');await route.fulfill({response,body});}
   else await route.continue();
  });
  await page.goto(origin+'/ui/hub');await page.waitForSelector('#hubLogin');await page.locator('#hubLogin').fill('alex@example.test');await page.waitForTimeout(150);
  const hint=await page.locator('.hub-signin-form').innerText();
  if(stage==='after'&&!hint.includes(lang==='en'?'Sign in with your company email or AD account name.':'可以用公司 email 或 AD 帳號登入。'))throw Error('missing candidate hint');
  if(stage==='before'&&inputs.some(n=>delivered.filter(x=>x.file===n).length!==1))throw Error('baseline interception count');
  const file=`${stage}-${device}-${theme}-${lang}.png`;await page.screenshot({path:join(OUT,file),fullPage:true});
  views.push({file,stage,device,lang,theme,delivered,errors,autocomplete:await page.locator('#hubLogin').getAttribute('autocomplete'),overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
  if(errors.length||views.at(-1).overflow)throw Error('view error/overflow');await context.close();
 }
 writeFileSync(join(OUT,'capture-inputs.json'),JSON.stringify({base:BASE,source,views},null,2));
}finally{await browser?.close();await rig?.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(home,{recursive:true,force:true});}
