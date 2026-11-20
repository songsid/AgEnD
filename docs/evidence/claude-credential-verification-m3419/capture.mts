import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {bootFixture,caseName,matrix} from '../../../scripts/manual/smoke-fixture/index.mts';
import {ClaudeCredentialVault} from '../../../src/claude-credential-vault.ts';
const out=process.env.OUT!;mkdirSync(out,{recursive:true});
const fx=await bootFixture({port:48924,host:true,classic:false,roster:[{name:'helper',displayName:'Assistant',backend:'claude-code',general:true,status:'paused'}]});
fx.fm.usageAfterSignIn=()=>{};fx.fm.refreshSignInIdentities=()=>{};fx.fm.addAccountProfile('claude-code','sample','Fixture operator');
const vault=new ClaudeCredentialVault(fx.dir),actor={adapterId:'host',userId:'operator'},screens:any[]=[],cases:any[]=[];
const view=()=>({clis:[{backend:'claude-code',profiles:true,installed:true,agents:[],rooms:[],rows:[{scope:{kind:'host'},backend:'claude-code',profile:'sample',state:'not_signed_in',signIn:true,usedBy:{agents:[],classic:[],fleetDefault:false},credential:fx.fm.claudeCredentialMetadata('sample')}]}]});
try{for(const c of matrix()){
 const tag=caseName(c),{ctx,page,csp}=await fx.page(c,{path:'/settings/accounts',host:true}),errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
 const json=(body:any)=>({status:200,contentType:'application/json',body:JSON.stringify(body)});
 await page.route(/\/ui\/accounts(\?.*)?$/,(r:any)=>r.fulfill(json(view())));await page.route(/\/api\/ai-usage(\?.*)?$/,(r:any)=>r.fulfill(json({providers:[]})));await page.route(/\/ui\/backend-login(\?.*)?$/,(r:any)=>r.fulfill(json({login:null,targets:[]})));
 for(const state of ['saved','verified','auth-error','unknown']){
 const old=vault.metadata('sample');const m=vault.write('sample',old?.revision??0,{kind:'api-key',value:'synthetic-'+'x'.repeat(48)},actor);
 if(state!=='saved')vault.observeRequest('sample',m.id,m.revision,'api-key',{at:Date.parse('2026-11-20T12:00:00Z'),outcome:state==='verified'?'success':state==='auth-error'?'auth-error':'unknown'});
 await page.goto(fx.base+'/settings/accounts');await page.waitForSelector('.s-account-row[data-account="sample"]');
 const row=page.locator('.s-account-row[data-account="sample"]');await row.scrollIntoViewIfNeeded();
 if(state==='verified')await page.waitForSelector('[data-credential-verified-at]');if(state==='auth-error'||state==='unknown')await page.waitForSelector('[data-credential-request-hint]');
 const measure=await row.evaluate((scope:any)=>({overflow:document.documentElement.scrollWidth>innerWidth,small:[...scope.querySelectorAll('button,a[href]')].flatMap((el:any)=>{const r=el.getBoundingClientRect();return innerWidth<900&&!el.disabled&&r.width&&r.height&&(r.width<43.5||r.height<43.5)?[{text:el.textContent,w:r.width,h:r.height}]:[];}),visibleSecret:document.body.innerText.includes('synthetic-'),height:scope.getBoundingClientRect().height}));
 screens.push({tag,state,...measure});await page.screenshot({path:join(out,tag+'-'+state+'.png')});
 }
 cases.push({tag,errors,csp:await csp()});await ctx.close();
}}finally{writeFileSync(join(out,'results.json'),JSON.stringify({synthetic:true,headless:true,noModelCalls:true,screens,cases},null,2));vault.close();await fx.close();}
if(cases.some(c=>c.errors.length||c.csp.length)||screens.some(s=>s.overflow||s.small.length||s.visibleSecret))process.exitCode=1;
