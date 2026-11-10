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
// Public link is backed by the production manager/gateway lane, but the cloudflared process/owner admission are inert.
const {PublicWebLink}=await import(R+'/src/public-web-link.ts');const {TunnelPurposeLane}=await import(R+'/src/tunnel/purpose-lane.ts');const {PUBLIC_LINK_OWNER_FILE}=await import(R+'/src/public-link-owner.ts');
fm.fleetConfig.channel={type:'telegram',mode:'topic',bot_token_env:'OWNED_UNUSED',group_id:'-100',access:{mode:'locked',allowed_users:['1']}};fm.fleetConfig.web.verified_authority={enabled:true};
const host='owned-alpha12.trycloudflare.com';fm.tunnelPurposeLane=new TunnelPurposeLane({start:async(_:any,ctx:any)=>{ctx.onCandidateHost(host);return{ok:true,handle:{pageUrl:`https://${host}/signin`,onUnexpectedExit:()=>()=>{}}}},stop:async()=>({confirmed:true})});
fm.publicWebLink=new PublicWebLink({...fm.publicWebLinkDeps(),permitted:()=>true,ensure:async()=>({path:'/owned/stub/cloudflared',source:'agend'}),provider:()=>({})});
for(const c of matrix()){
 const cn=caseName(c);const owner={adapterId:'telegram',userId:'1',chatId:'1'};check(cn+':fixture-link-open',await fm.publicWebLink.openUnattended(owner)==='opened');writeFileSync(join(fx.dir,PUBLIC_LINK_OWNER_FILE),JSON.stringify(owner)+'\n');
 const {page,ctx,csp}=await fx.page(c,{path:'/settings/access'});page.on('pageerror',(e:any)=>errors.push({case:cn,message:String(e)}));page.setDefaultTimeout(12000);page.on('response',async(r:any)=>{if(r.request().method()==='POST'&&/instances|settings.*request|settings.*confirm/.test(r.url()))console.log('WRITE',r.status(),r.url(),(await r.text()).slice(0,1000));});await page.locator('#accessOverview').waitFor();await page.locator('#ovCloseLink').waitFor();
 check(cn+':overview-three-cards',await page.locator('.s-ov-grid > section').count()===3);check(cn+':current-device-no-revoke',await page.locator('.s-ov-dev.current button').count()===0);
 await shot(page,cn+'-access-open');await page.locator('#ovCloseLink').click();await page.locator('#ovCloseGo').waitFor();await shot(page,cn+'-access-confirm');const closeAt=Date.now();await page.locator('#ovCloseGo').click();
 await page.locator('#ovLinkNote').filter({hasText:'公開連結已關閉'}).waitFor();check(cn+':real-route-closed',fm.getPublicWebStatus().state==='closed'&&!existsSync(join(fx.dir,PUBLIC_LINK_OWNER_FILE)));await shot(page,cn+'-access-immediate');await page.locator('#ovCloseLink').waitFor({state:'hidden',timeout:12000});const settledMs=Date.now()-closeAt;console.log('CLOSE_SETTLED',cn,settledMs);check(cn+':closed-display-settles',!(await page.locator('#ovEntry').innerText()).includes('開啟中'),{settledMs});await shot(page,cn+'-access-closed-settled');
 await health(page,cn+':access',csp);await ctx.close();
}
}finally{await fm.stopNeedsYou();await fm.publicWebLink?.close('owned cleanup');await fx.close();writeFileSync(join(O,'result.json'),JSON.stringify({checks},null,2));if(checks.some(x=>!x.ok))process.exitCode=1;}
