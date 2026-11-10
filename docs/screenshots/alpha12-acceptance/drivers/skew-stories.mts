import {mkdirSync,writeFileSync}from'node:fs';import{join}from'node:path';import{execFileSync}from'node:child_process';
const R=process.env.REPO!,O=process.env.OUT!;mkdirSync(O,{recursive:true});const{bootFixture,matrix,caseName}=await import(R+'/scripts/manual/smoke-fixture/index.mts');
const fx=await bootFixture({port:48314,instances:6,classic:false,host:true}),fm=fx.fm;fm.refreshSignInIdentities=()=>{};fm.runBackendProbeWorker=async()=>{throw Error('unexpected probe')};fm.backendAvailabilityRows=()=>[{backend:'claude-code',state:'usable',path:'/owned/fixture',version:'2.1.322',auth:'valid',checkedAt:performance.now()}];fm.modelCatalogFor=()=>[];fm.cliModelCatalogFor=async()=>[];
const{setUsageFetcherForTests}=await import(R+'/src/usage/usage-api.ts');setUsageFetcherForTests(async()=>({fetchedAt:new Date().toISOString(),providers:[]}));
const checks:any[]=[];const check=(name:string,ok:boolean,detail?:any)=>{checks.push({name,ok,...ok?{}:{detail}});console.log(ok?'PASS':'FAIL',name);};
const old=(p:string)=>execFileSync('git',['-C',R,'show','636328df:'+p],{encoding:'utf8',maxBuffer:16<<20});
const name=fx.instances[4].name;fm.emitSseEvent('message',{instance:name,sender:name,role:'agent',text:'1. 舊分頁第一項\n\n2. 舊分頁第二項',ts:new Date().toISOString()});
try{
for(const c of matrix())for(const leg of [
 {id:'old-settings-new-modules',asset:'panel-settings.js',source:'src/ui/panel-settings.js',path:'/settings/access',selector:'#accessOverview',expected:false},
 {id:'new-access-old-store',asset:'app-store.js',source:'src/ui/shared/app-store.js',path:'/settings/access',selector:'#accessOverview',expected:true},
 {id:'new-create-old-strings',asset:'settings-strings.js',source:'src/ui/settings-strings.js',path:'/settings/agents',selector:'#newAgentBtn',expected:true},
 {id:'old-chat-new-thread',asset:'panel-chat.js',source:'src/ui/panel-chat.js',path:'/ui/chat/'+encodeURIComponent(name),selector:'.msg .md',expected:true}
]){
 const cn=caseName(c)+'-'+leg.id,{ctx,page,csp}=await fx.page(c);page.setDefaultTimeout(10000);const errs:string[]=[];page.on('pageerror',(e:any)=>errs.push(String(e)));await page.route('**/assets/'+leg.asset,async(route:any)=>route.fulfill({status:200,contentType:'application/javascript',body:old(leg.source)}));await page.goto(fx.base+leg.path);
 if(leg.expected)await page.locator(leg.selector).first().waitFor();else await page.locator('.p-settings').waitFor();
 if(leg.id==='new-create-old-strings'){await page.locator('#newAgentBtn').click();await page.locator('.agent-runtime-picker input[value="wsl"]').check();await page.locator('#create-host-account').waitFor();}
 if(leg.id==='old-chat-new-thread')check(cn+':new-renderer',await page.locator('.msg .md ol > li').count()===2);
 await page.screenshot({path:join(O,cn+'.png')});check(cn+':rendered',await page.locator('body').innerText().then((t:string)=>t.length>100));check(cn+':no-page-errors',errs.length===0,errs);check(cn+':no-csp',(await csp()).length===0);check(cn+':no-overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await ctx.close();
}
}catch(e){console.error(e);checks.push({name:'exception',ok:false,detail:String(e)});process.exitCode=1;}finally{await fx.close();writeFileSync(join(O,'result.json'),JSON.stringify({candidate:process.env.CANDIDATE,baseline:'636328df',checks},null,2));if(checks.some(x=>!x.ok))process.exitCode=1;}
