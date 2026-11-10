// Candidate-only browser acceptance. Real HTTP, disk credentials, SSE, routes. CLI/lifecycle and cloudflared boundaries inert.
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const R=process.env.REPO!,O=process.env.OUT!;mkdirSync(O,{recursive:true});
process.env.CLAUDE_CONFIG_DIR=join(process.env.HOME!,'synthetic-claude');
const {bootFixture,matrix,caseName}=await import(R+'/scripts/manual/smoke-fixture/index.mts');
const fx=await bootFixture({port:48294,instances:6,classic:false,host:true}),fm=fx.fm;
const checks:any[]=[];const check=(name:string,ok:boolean,detail?:any)=>{checks.push({name,ok,...(ok?{}:{detail})});console.log(ok?'PASS':'FAIL',name,ok?'':JSON.stringify(detail));};
const creds=(home:string,end:number)=>{mkdirSync(home,{recursive:true});writeFileSync(join(home,'.claude.json'),JSON.stringify({oauthAccount:{accountUuid:'00000000-0000-4000-8000-000000000001'}}));writeFileSync(join(home,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'synthetic-access-token',refreshToken:'synthetic-refresh-token',expiresAt:Date.now()+86400000,refreshTokenExpiresAt:end,scopes:['user:inference'],subscriptionType:'team'}}));};
const home=(p:string)=>join(fx.dir,'credential-profiles','claude-code',p);
const now=Date.now();creds(process.env.CLAUDE_CONFIG_DIR!,now+20*86400000);creds(home('work'),now+20*86400000);creds(home('soon'),now+9*3600000);creds(home('ended'),now-2*3600000);mkdirSync(home('off'),{recursive:true});
let yaml=readFileSync(join(fx.dir,'fleet.yaml'),'utf8');
for(const [i,p]of [[0,'soon'],[1,'ended']]as const){const n=JSON.stringify(fx.instances[i].name);yaml=yaml.replace(`  ${n}:\n`,`  ${n}:\n    backend_options:\n      claude-code:\n        credential_profile: ${p}\n`);}
writeFileSync(join(fx.dir,'fleet.yaml'),yaml);fm.loadConfig(join(fx.dir,'fleet.yaml'));
fm.backendAvailabilityRows=()=>['claude-code','codex','opencode'].map(backend=>({backend,state:'usable',path:'/owned/fixture/'+backend,version:backend==='claude-code'?'2.1.322':'1.0.0',auth:'valid',minVersion:null,checkedAt:performance.now()}));
fm.refreshSignInIdentities=()=>{};fm.runBackendProbeWorker=async()=>{throw Error('Unexpected CLI probe')};fm.modelCatalogFor=()=>[{id:'fixture-model',name:'Fixture model'}];fm.cliModelCatalogFor=async()=>[];
const {setUsageFetcherForTests}=await import(R+'/src/usage/usage-api.ts');setUsageFetcherForTests(async()=>({fetchedAt:new Date().toISOString(),providers:[]}));
const creates:any[]=[];fm.lifecycle.handleCreate=async(args:any,respond:any)=>{creates.push(structuredClone(args));console.log('INERT_CREATE',JSON.stringify(args));respond({success:true,name:'owned-created-agent'});};
const {setLocale}=await import(R+'/src/locale.ts');setLocale('zh-TW');fm.keepAliveService();fm.startNeedsYou();
const errors:any[]=[];
const shot=async(page:any,name:string)=>page.screenshot({path:join(O,name+'.png')});
const health=async(page:any,cn:string,csp:any)=>{check(cn+':no-overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));check(cn+':no-csp',(await csp()).length===0);};
try{
writeFileSync(join(O,'account-view.json'),JSON.stringify(await fm.accountsView(0),null,2));writeFileSync(join(O,'attention.json'),JSON.stringify(fm.keepAliveAttention(),null,2));
for(const c of matrix()){
 const cn=caseName(c);const {page,ctx,csp}=await fx.page(c,{path:'/settings/agents'});page.on('pageerror',(e:any)=>errors.push({case:cn,message:String(e)}));page.setDefaultTimeout(12000);page.on('response',async(r:any)=>{if(r.request().method()==='POST'&&/instances|settings.*request|settings.*confirm/.test(r.url()))console.log('WRITE',r.status(),r.url(),(await r.text()).slice(0,1000));});
 await page.locator('#newAgentBtn').click();await page.locator('.agent-runtime-picker input[value="wsl"]').check();
 const pick=async(text:string)=>{await page.locator('.agent-create-cli .cli-picker-trigger').click();await page.getByRole('menuitemradio').filter({hasText:text}).click();};
 await pick('Claude Code');await page.locator('#create-host-account').waitFor();
 check(cn+':signed-out-disabled',await page.locator('#create-host-account option[value="off"]').isDisabled());
 await page.locator('#create-host-account').selectOption('work');await shot(page,cn+'-create-account');
 await pick('OpenCode');check(cn+':unsupported-hides-account',await page.locator('#create-host-account').count()===0);
 await pick('Claude Code');check(cn+':backend-change-clears',await page.locator('#create-host-account').inputValue()==='');
 await page.locator('#create-host-account').selectOption('work');await page.getByRole('button',{name:'下一步',exact:true}).click();
 await page.locator('.agent-runtime-fields input').nth(1).fill('owned-created-agent');
 await page.getByRole('button',{name:'建立',exact:true}).click();await page.waitForTimeout(600);await shot(page,cn+'-create-after-submit');writeFileSync(join(O,cn+'-create-after-submit.txt'),await page.locator('body').innerText());if(await page.getByRole('button',{name:'立即套用',exact:true}).count())await page.getByRole('button',{name:'立即套用',exact:true}).click();for(let i=0;i<40&&!creates.length;i++)await page.waitForTimeout(50);console.log('AFTER_CREATE',creates.length);writeFileSync(join(O,cn+'-pending.json'),JSON.stringify(fm.settingsConfirmation?.store.listBySource('web_session'),null,2));
 check(cn+':create-server-profile',creates.at(-1)?.backend_options?.['claude-code']?.credential_profile==='work'&&!('credentialProfile'in creates.at(-1)),creates.at(-1));await shot(page,cn+'-create-done');
 await page.goto(fx.base+'/settings/agents');await page.locator('details.s-ai-accounts > summary').click();
 const ended=page.locator('.s-account-card[data-backend="claude-code"] .s-account-row[data-account="ended"]');await ended.waitFor();
 check(cn+':ended-needs-reconnect',(await ended.innerText()).includes('需要重新連接'));
 await ended.scrollIntoViewIfNeeded();await shot(page,cn+'-accounts-ended');
 await page.goto(fx.base+'/ui/needs');await page.waitForFunction(()=>document.body.textContent?.includes('soon')&&document.body.textContent?.includes('ended'));
 const nt=await page.locator('.p-needs').innerText();check(cn+':needs-end-date-lines',nt.includes('soon')&&nt.includes('ended')&&/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(nt),nt);
 await shot(page,cn+'-needs-end-date');await health(page,cn+':accounts-needs',csp);await ctx.close();
}
// Public link is backed by the production manager/gateway lane, but the cloudflared process/owner admission are inert.
const {PublicWebLink}=await import(R+'/src/public-web-link.ts');const {TunnelPurposeLane}=await import(R+'/src/tunnel/purpose-lane.ts');const {PUBLIC_LINK_OWNER_FILE}=await import(R+'/src/public-link-owner.ts');
fm.fleetConfig.channel={type:'telegram',mode:'topic',bot_token_env:'OWNED_UNUSED',group_id:'-100',access:{mode:'locked',allowed_users:['1']}};fm.fleetConfig.web.verified_authority={enabled:true};
const host='owned-alpha12.trycloudflare.com';fm.tunnelPurposeLane=new TunnelPurposeLane({start:async(_:any,ctx:any)=>{ctx.onCandidateHost(host);return{ok:true,handle:{pageUrl:`https://${host}/signin`,onUnexpectedExit:()=>()=>{}}}},stop:async()=>({confirmed:true})});
fm.publicWebLink=new PublicWebLink({...fm.publicWebLinkDeps(),permitted:()=>true,ensure:async()=>({path:'/owned/stub/cloudflared',source:'agend'}),provider:()=>({})});
for(const c of matrix()){
 const cn=caseName(c);const owner={adapterId:'telegram',userId:'1',chatId:'1'};check(cn+':fixture-link-open',await fm.publicWebLink.openUnattended(owner)==='opened');writeFileSync(join(fx.dir,PUBLIC_LINK_OWNER_FILE),JSON.stringify(owner)+'\n');
 const {page,ctx,csp}=await fx.page(c,{path:'/settings/access'});page.on('pageerror',(e:any)=>errors.push({case:cn,message:String(e)}));page.setDefaultTimeout(12000);page.on('response',async(r:any)=>{if(r.request().method()==='POST'&&/instances|settings.*request|settings.*confirm/.test(r.url()))console.log('WRITE',r.status(),r.url(),(await r.text()).slice(0,1000));});await page.locator('#accessOverview').waitFor();await page.locator('#ovCloseLink').waitFor();
 check(cn+':overview-three-cards',await page.locator('.s-ov-grid > section').count()===3);check(cn+':current-device-no-revoke',await page.locator('.s-ov-dev.current button').count()===0);
 await shot(page,cn+'-access-open');await page.locator('#ovCloseLink').click();await page.locator('#ovCloseGo').waitFor();await shot(page,cn+'-access-confirm');await page.locator('#ovCloseGo').click();
 await page.locator('#ovLinkNote').filter({hasText:'公開連結已關閉'}).waitFor();check(cn+':real-route-closed',fm.getPublicWebStatus().state==='closed'&&!existsSync(join(fx.dir,PUBLIC_LINK_OWNER_FILE)));await shot(page,cn+'-access-closed');
 await health(page,cn+':access',csp);await ctx.close();
}
// Production SSE messages + renderer. No model runs and no chat ledger injected into the product tree.
const n=fx.instances[4].name;const texts=['1. 第一項\n\n2. 第二項\n\n3. 第三項','1. 開頭\n\n獨立段落\n\n4. 第四項','1. 外層\n   - 內層\n\n2. 後項'];
for(const text of texts)fm.emitSseEvent('message',{instance:n,sender:n,role:'agent',text,ts:new Date().toISOString()});
for(const c of matrix()){
 const cn=caseName(c);const {page,ctx,csp}=await fx.page(c,{path:'/ui/chat/'+encodeURIComponent(n)});page.on('pageerror',(e:any)=>errors.push({case:cn,message:String(e)}));page.setDefaultTimeout(12000);page.on('response',async(r:any)=>{if(r.request().method()==='POST'&&/instances|settings.*request|settings.*confirm/.test(r.url()))console.log('WRITE',r.status(),r.url(),(await r.text()).slice(0,1000));});await page.locator('.msg .md').filter({hasText:'第三項'}).waitFor();
 const a=page.locator('.msg .md').filter({hasText:'第三項'}),b=page.locator('.msg .md').filter({hasText:'獨立段落'}),d=page.locator('.msg .md').filter({hasText:'內層'});
 check(cn+':loose-one-list',await a.locator('ol').count()===1&&await a.locator('ol > li').count()===3);
 check(cn+':paragraph-splits-start4',await b.locator('ol').count()===2&&await b.locator('ol').nth(1).getAttribute('start')==='4');
 check(cn+':nested-kept',await d.locator('ol > li').count()===2&&await d.locator('ul li').count()===1);
 await d.scrollIntoViewIfNeeded();await shot(page,cn+'-loose-lists');await health(page,cn+':chat',csp);await ctx.close();
}
check('all:no-page-errors',errors.length===0,errors);
}catch(e){console.error(e);checks.push({name:'campaign-exception',ok:false,detail:String(e)});process.exitCode=1;}
finally{await fm.stopNeedsYou();await fm.publicWebLink?.close('owned acceptance cleanup');await fx.close();writeFileSync(join(O,'result.json'),JSON.stringify({candidate:process.env.CANDIDATE,checks,errors,creates,scope:'real browser/server/disk/SSE; synthetic credentials; inert create/probe/cloudflared; no actual CLI/model/tunnel'},null,2));if(checks.some(x=>!x.ok))process.exitCode=1;}
