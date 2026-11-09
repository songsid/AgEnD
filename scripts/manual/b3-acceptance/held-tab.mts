import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {bootFixture,matrix,caseName} from '../smoke-fixture/index.mts';
const out=process.env.OUT!;mkdirSync(out,{recursive:true});const repo=process.env.REPO!;
const base='v2.3.5-beta.2';const files=execFileSync('git',['ls-tree','-r','--name-only',base,'src/ui'],{cwd:repo,encoding:'utf8'}).trim().split('\n');
const old=new Map<string,Buffer>();
for(const f of files){if(!/\.(js|css)$/.test(f))continue;const url=f.startsWith('src/ui/shared/')?'/assets/'+f.slice('src/ui/shared/'.length):'/ui/js/'+f.slice('src/ui/'.length);old.set(url,execFileSync('git',['show',base+':'+f],{cwd:repo}));}
const fx=await bootFixture({port:49852,instances:3,classic:false});const records:any[]=[];
fx.fm.runBackendProbeWorker=async()=>({models:[{id:'sonnet',label:'Sonnet'}],apiModels:[]});
fx.fm.backendAvailabilityRows=()=>[{backend:'claude-code',state:'usable',path:'/fixture/claude',auth:'valid',checkedAt:Date.now()}];
try{for(const c of matrix()){
 const tag=caseName(c);const {ctx,page,csp}=await fx.page(c,{path:'/ui/chat/general'});let older=true;let oldReads=0;const newReads:string[]=[];const errors:string[]=[];
 await page.route('**/*',async(q:any)=>{const url=new URL(q.request().url());const bytes=old.get(url.pathname);if(older&&bytes){oldReads++;return q.fulfill({status:200,body:bytes,contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript'});}if(!older&&url.pathname.endsWith('.js'))newReads.push(url.pathname);return q.continue();});
 page.on('pageerror',(e:any)=>errors.push(String(e)));await page.reload();await page.locator('.composer-box').waitFor();
 await page.evaluate(()=>{(window as any).__b3HeldTab='old-shell-still-mounted';});await page.screenshot({path:join(out,tag+'-old-beta2-tab.png')});older=false;
 let target=page.locator('a[href^="/settings"]');let clicked=false;
 for(let i=0;i<await target.count();i++)if(await target.nth(i).isVisible()){await target.nth(i).click();clicked=true;break;}
 if(!clicked){await page.locator('[aria-controls="sidebar"]').filter({visible:true}).first().click();target=page.locator('a[href^="/settings"]');for(let i=0;i<await target.count();i++)if(await target.nth(i).isVisible()){await target.nth(i).click();clicked=true;break;}}
 if(!clicked)throw Error('no visible Settings navigation');await page.locator('.p-settings').waitFor();
 await page.locator('a[href="/settings/agent-defaults"]').filter({visible:true}).first().click();await page.locator('#g-model').waitFor();
 await page.locator('#g-model').scrollIntoViewIfNeeded();const refresh=page.locator('#g-model').locator('..').locator('.model-refresh > button');await refresh.click();await page.locator('.model-refresh [role="status"]').first().waitFor();
 if(await page.evaluate(()=>(window as any).__b3HeldTab)!=='old-shell-still-mounted')throw Error('tab reloaded instead of retained');
 if(!oldReads||!newReads.some(x=>x.includes('panel-settings')))throw Error('not old shell/new lazy panel');
 if(errors.length||(await csp()).length)throw Error(JSON.stringify({errors,csp:await csp()}));
 await page.screenshot({path:join(out,tag+'-new-model-panel-held-shell.png')});records.push({tag,oldReads,newReads,retainedWindow:true,refreshSucceeded:true,errors});await ctx.close();
}}finally{await fx.close();writeFileSync(join(out,'results.json'),JSON.stringify({oldBase:base,head:process.env.CANDIDATE,records},null,2));}
