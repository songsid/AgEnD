import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const REPO=process.env.REPO!, BASE=process.env.BASE_REF!, OUT=process.env.OUT!;
const {bootFixture,matrix,caseName,shotPath}=await import(REPO+'/scripts/manual/smoke-fixture/index.mts');
const fx=await bootFixture({port:Number(process.env.HP),instances:2,classic:false});
fx.fm.refreshSignInIdentities=()=>{};
const hasAccounts=existsSync(join(REPO,'src/ui/accounts-manage.js'));
const rows:any[]=[];const fail:string[]=[];const check=(key:string,ok:boolean,detail?:any)=>{rows.push({key,ok,...(!ok?{detail}:{})});if(!ok)fail.push(key);};
const forbidden=/agend\s+(?:web|reload|update)|run it on the host|在主機上執行|請在主機/;
try{
for(const phase of ['before','after'])for(const c of matrix('full')){
 const tag=phase+'-'+caseName(c);let posts=0,signouts=0;
 const {ctx,page,csp}=await fx.page(c);const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
 await page.route('**/ui/accounts/**',async(route:any)=>{
  if(route.request().method()==='POST'&&route.request().url().endsWith('/signout')){signouts++;return route.fulfill({status:signouts%2?500:200,contentType:'application/json',body:JSON.stringify(signouts%2?{error:'failed'}:{signedOut:'work'})});}
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({clis:[]})});
 });
 await page.route('**/ui/backend-login/**',(route:any)=>route.fulfill({status:200,contentType:'application/json',body:'{"login":null,"targets":[]}'}));
 if(phase==='before')for(const [url,path] of [['**/assets/web-authorize.js*','src/ui/shared/web-authorize.js'],['**/assets/signin.js*','src/ui/shared/signin.js'],['**/ui/js/settings-strings.js*','src/ui/settings-strings.js'],...(hasAccounts?[['**/ui/js/accounts-manage.js*','src/ui/accounts-manage.js']]:[])]){
  const body=execFileSync('git',['-C',REPO,'show',`${BASE}:${path}`],{encoding:'utf8'});
  await page.route(url,(route:any)=>route.fulfill({status:200,contentType:'text/javascript',body}));
 }
 for(const reason of ['no_account','host_sign_in']){
  await page.route('**/ui/authorization',async(route:any)=>{if(route.request().method()!=='GET')posts++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'none',reason})});});
  await page.goto(fx.base+'/ui/chat/'+fx.instances[0].name);
  await page.locator('.dock .webauth-why').waitFor();await page.locator('.dock .webauth-why').click();
  await page.locator('.dock .webauth-tip').waitFor({state:'visible'});
  const text=await page.locator('.dock .webauth-tip').innerText();
  if(phase==='after')check(tag+':'+reason+'-no-detour',!forbidden.test(text),text);
  if(phase==='after'&&reason==='host_sign_in')check(tag+':host-no-owner-or-General',!/General|owner|operator|擁有者/.test(text),text);
  if(phase==='after'&&reason==='no_account')check(tag+':chat-General',text.includes('General'),text);
  const box=await page.locator('.dock .webauth-tip').boundingBox();check(tag+':'+reason+'-fit',!!box&&box.x>=-1&&box.x+box.width<=page.viewportSize().width+1,box);
  await page.screenshot({path:shotPath('d1-batch-b',tag,reason)});
 }
 check(tag+':no-auth-POST',posts===0,posts);
 await page.goto(fx.base+'/settings/advanced');await page.locator('.p-settings').waitFor();
 const effective=page.locator('#advanced-tab-effective');
 if(hasAccounts)await effective.waitFor({state:'visible'});
 if(await effective.count())await effective.first().click();
 else {const byText=page.getByRole('tab',{name:c.lang==='en'?'Effective':'目前生效',exact:true});if(await byText.count())await byText.click();}
 const note=page.locator('.s-effective-footnotes > .note, .s-web-readonly > .note').first();await note.waitFor({state:'visible'});await note.scrollIntoViewIfNeeded();
 const noteText=await note.innerText();if(phase==='after')check(tag+':readonly-no-command',!forbidden.test(noteText)&&/cannot change|無法修改/.test(noteText),noteText);
 await page.screenshot({path:shotPath('d1-batch-b',tag,'readonly')});
 if(hasAccounts){
  await page.evaluate(async()=>{const {showDialog,closeDialog}=await import('/assets/app-shell.js');const {SignOutDialog}=await import('/ui/js/accounts-manage.js');showDialog(SignOutDialog,{cli:{backend:'claude-code'},label:'Claude Code',row:{scope:{kind:'host'},profile:'work',usedBy:{agents:[],classic:[],fleetDefault:false}},onClose:closeDialog,onMove(){},onDone:closeDialog});});
  await page.locator('dialog[open] .btn-danger').click();await page.locator('dialog[open] .err').waitFor({state:'visible'});
  const error=await page.locator('dialog[open] .err').innerText();if(phase==='after')check(tag+':signout-no-detour',!forbidden.test(error),error);
  check(tag+':retry-enabled',await page.locator('dialog[open] .btn-danger').isEnabled());
  await page.screenshot({path:shotPath('d1-batch-b',tag,'signout-error')});
  await page.locator('dialog[open] .btn-danger').click();await page.locator('dialog[open]').waitFor({state:'hidden'});check(tag+':retry-completes-here',signouts===2,signouts);
 }
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);check(tag+':no-page-overflow',overflow<=0,overflow);
 const oldAuth=execFileSync('git',['-C',REPO,'show',`${BASE}:src/auth-api.ts`],{encoding:'utf8'}).match(/export const REVOCATION_NOT_DURABLE_MESSAGE\s*=\s*"([^"]+)"/)![1];
 await page.evaluate((note:string)=>sessionStorage.setItem('agend_signout_note',note),oldAuth);await ctx.clearCookies();
 await page.goto(fx.base+'/signin');await page.locator('#form').waitFor({state:'visible'});
 const savedNote=await page.locator('#msg').innerText();if(phase==='after')check(tag+':signout-warning-localized',!forbidden.test(savedNote)&&/restart may bring|重新啟動後/.test(savedNote),savedNote);
 await page.screenshot({path:shotPath('d1-batch-b',tag,'signout-unsaved')});
 check(tag+':no-browser-errors',errors.length===0,errors);check(tag+':no-CSP',(await csp()).length===0,await csp());await ctx.close();
}
}finally{mkdirSync(OUT,{recursive:true});writeFileSync(join(OUT,'result.json'),JSON.stringify({head:execFileSync('git',['-C',REPO,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),base:BASE,hasAccounts,browser:fx.browser.version(),rows,failed:fail},null,2));await fx.close();}
console.log(JSON.stringify({checks:rows.length,failed:fail}));process.exitCode=fail.length?1:0;
