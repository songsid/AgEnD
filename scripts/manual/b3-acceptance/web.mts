import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {bootFixture,matrix,caseName,seedUsage} from '../smoke-fixture/index.mts';
const out=process.env.OUT!;mkdirSync(out,{recursive:true});
const fx=await bootFixture({port:49842,instances:4,classic:false});
const r:any={head:process.env.CANDIDATE,scope:'real Fleet HTTP/Chromium; mock probe worker and inert delivery sink; no CLI/tmux/model/account',checks:[],cases:[]};
function check(name:string,ok:boolean,detail?:any){r.checks.push({name,ok,detail});if(!ok)throw Error(name+':'+JSON.stringify(detail));}
const fm=fx.fm as any;const name=fx.instances[0]!.name;
fm.fleetConfig.web={...fm.fleetConfig.web,allowed_hosts:['dashboard.lan.example']};
const backend=fm.fleetConfig.instances[name].backend||'claude-code';
const catalog=[{id:'fixture-model',label:'驗收模型'}];let probes=0;
fm.runBackendProbeWorker=async()=>{probes++;return{models:catalog,apiModels:[]};};
fm.backendAvailabilityRows=()=>['claude-code','codex'].map(backend=>({backend,state:'usable',path:'/fixture/'+backend,auth:'valid',checkedAt:Date.now()}));
fm.probeCliEnvs();
const until=async(fn:()=>boolean)=>{for(let i=0;i<100&&!fn();i++)await new Promise(r=>setTimeout(r,20));if(!fn())throw Error('fixture signal not observed');};
try{
 await until(()=>fm.pendingCliEnvProbes.size===0);
 check('web-only automatic worker publishes nonempty catalog',fm.adapter==null&&fm.modelCatalogFor(backend,name).length>0,{backend,probes});
 await seedUsage(fx);
 const kiro=fx.instances.find(i=>i.backend==='kiro-cli')!.name;
 const actualLevel=JSON.parse(readFileSync(process.env.KIRO_RESULT!,'utf8')).level;
 // Display the production worker's separately captured synthetic-store output, not fabricated level arithmetic.
 fm.officeLevels=async()=>({[kiro]:actualLevel});
 const received:any[]=[];
 fm.deliverHumanToInstance=async(n:string,p:any,_origin:any,_typed:any,opts:any)=>{
  if(!opts.stillCurrent())return false;received.push({name:n,content:p.content});
  setTimeout(()=>fm.emitSseEvent('message',{instance:n,sender:n,role:'agent',text:'已收到：'+p.content,ts:new Date().toISOString()}),20);
  return true;
 };
 for(const c of matrix()){
  const tag=caseName(c);const anon=await fx.browser.newContext({viewport:c.device==='desk'?{width:1366,height:900}:{width:390,height:844},locale:'zh-TW',isMobile:c.device==='phone',hasTouch:c.device==='phone'});
  const signin=await anon.newPage();await signin.goto(fx.base+'/signin');await signin.locator('#form:not([hidden])').waitFor();
  const text=await signin.locator('body').innerText();
  check(tag+':fresh signin no disconnected /web',!text.includes('/web')&&text.includes('裝置登入碼')&&text.includes('agend web'),text);
  await signin.screenshot({path:join(out,tag+'-fresh-signin.png')});
  await signin.goto(fx.base.replace('127.0.0.1','dashboard.lan.example')+'/signin');await signin.locator('#form:not([hidden])').waitFor();
  const remoteText=await signin.locator('body').innerText();check(tag+':fresh non-loopback no /web',!remoteText.includes('/web')&&remoteText.includes('agend web --code'),remoteText);
  await signin.screenshot({path:join(out,tag+'-fresh-nonloopback-signin.png')});await anon.close();
  const {ctx,page,csp}=await fx.page(c,{path:'/settings/agents'});const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
  await page.locator('.signin-list').waitFor();await page.locator('.signin-list').scrollIntoViewIfNeeded();
  check(tag+':AI account connect wording',(await page.locator('.signin-list').innerText()).includes('連接 AI 帳號'));
  await page.screenshot({path:join(out,tag+'-AI-accounts.png')});
  await page.goto(fx.base+'/settings/agent-defaults');await page.locator('#g-model').waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('#g-model option')].some(e=>e.textContent?.includes('驗收模型')));
  await page.locator('#g-model').scrollIntoViewIfNeeded();await page.screenshot({path:join(out,tag+'-web-only-models.png')});
  const choices=await page.locator('#g-model option').allTextContents();check(tag+':host model choices nonempty',choices.some((x:string)=>x.includes('驗收模型')),choices);
  for(const section of ['agents','agent-defaults','notifications','chat','web','advanced']){
   await page.goto(fx.base+'/settings/'+section);await page.locator('.p-settings').waitFor();
   await page.waitForFunction(()=>((document.querySelector('.p-settings') as HTMLElement)?.innerText.length??0)>30);
   check(tag+':settings '+section,(await page.locator('.p-settings').innerText()).length>30);
  }
  await page.screenshot({path:join(out,tag+'-settings-advanced.png')});
  await page.goto(fx.base+'/ui/chat/'+encodeURIComponent(name));await page.locator('#msgIn').waitFor();
  const message='beta.3 獨立驗收 '+tag;const prior=received.length;
  const response=page.waitForResponse((q:any)=>q.url().endsWith('/ui/send')&&q.request().method()==='POST');
  await page.locator('#msgIn').fill(message);await page.locator('#sendBtn').click();const sent=await response;
  await page.getByText('已收到：'+message,{exact:true}).waitFor();
  check(tag+':chat send receive',sent.status()===200&&received.length===prior+1&&received.at(-1).content===message,{status:sent.status(),received:received.length-prior});
  await page.screenshot({path:join(out,tag+'-chat-answer.png')});await page.reload();await page.getByText('已收到：'+message,{exact:true}).waitFor();
  check(tag+':chat reload keeps answer',await page.getByText('已收到：'+message,{exact:true}).count()===1);
  // The actual usage endpoint uses only the synthetic usage fetcher configured above.
  const usage=await page.evaluate(async()=>{const q=await fetch('/api/ai-usage');return{status:q.status,body:await q.json()};});
  check(tag+':usage endpoint',usage.status===200,usage.status);
  const usageButton=page.locator('.hd-usage');let opened=false;
  for(let i=0;i<await usageButton.count();i++)if(await usageButton.nth(i).isVisible()){await usageButton.nth(i).click();opened=true;break;}
  check(tag+':usage visible button',opened);await page.getByText('Claude',{exact:true}).first().waitFor();
  await page.screenshot({path:join(out,tag+'-usage.png')});
  await page.goto(fx.base+'/ui/fleet/org');await page.locator('.oc-tools .seg-inline button',{hasText:'辦公室'}).click();
  await page.locator('.oo-canvas').waitFor();const desk=page.locator(`.oo-desk[data-name="${kiro}"]`);await desk.focus();await page.keyboard.press('Enter');await page.locator('.oo-card').waitFor();
  const card=await page.locator('.oo-card').innerText();check(tag+':Kiro Office level estimated',card.includes('Lv 10')&&card.includes('估算'),card);
  await page.screenshot({path:join(out,tag+'-Kiro-office-level.png')});
  check(tag+':no overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  check(tag+':no errors',errors.length===0&&!(await csp()).length,{errors,csp:await csp()});
  r.cases.push(tag);await ctx.close();
 }
}catch(e){r.failure=String(e);throw e;}finally{await fx.close();writeFileSync(join(out,'results.json'),JSON.stringify(r,null,2));}
