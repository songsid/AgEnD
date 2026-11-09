// Real Settings shell + HTTP model route. The remote RPC boundary is synthetic: no Windows, CLI or real credentials.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {bootFixture,caseName,matrix,mounted} from '../smoke-fixture/index.mts';
process.env.AGEND_REMOTE_RUNTIME='1';process.env.AGEND_WINDOWS_CLI='0';
const repo=process.env.REPO!,out=process.env.OUT!;if(!repo||!out)throw Error('REPO and OUT required');mkdirSync(out,{recursive:true});
const fx=await bootFixture({port:Number(process.env.PORT||49852),instances:3,classic:false}),name=fx.instances[1]!.name;
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const machines=ids.map((id,i)=>({id,name:i?'設計工作站':'開發工作站',status:'online',platform:'win32',generation:1,approvedAt:1,bootId:'owned-fake',runtimeInfo:{capabilities:['exec','remote-signin','credential-profiles','model-catalog-refresh'],protocolVersions:[1]},inventory:{home:'C:\\Fixture',probedAt:1,credentialProfiles:{default:'work',profiles:[{name:'work',loggedIn:true},{name:'personal',loggedIn:true}]},clis:[{id:'claude-code',path:'C:\\claude.exe',version:'2.1.318',authenticated:true,runnable:true,readOnlySupport:true,supports:{execution:true,resume:true,model:true,mcp:false},models:[],modelsSource:'unavailable'}]}}));
const calls:any[]=[];let portable=0,saves=0;
fx.fm.runtimeCoordinator=()=>({handlePublicRequest:()=>false,machine:(id:string)=>machines.find(m=>m.id===id),listMachines:()=>structuredClone(machines),subscribe:()=>()=>{},callAccount:async(id:string,op:string,payload:any)=>{if(op!=='models.refresh')throw Error('Only models discovery is allowed in this fixture');calls.push({id,op,payload});return {cli:payload.cli,profile:payload.profile||'work',source:'account-api',models:[{id:`${payload.profile||'work'}-${id.slice(0,4)}`,name:payload.profile==='personal'?'Personal model':'Work model'}]};}});
fx.fm.agentRuntimeChanges=()=>({describe:()=>({runtime:'wsl',backend:'claude-code',model:'sonnet',directory:fx.dir,sandbox:'read-only',adapter:'exec',revision:'a'.repeat(64)}),change:()=>{throw Error('Never apply a runtime change in this smoke');}});
fx.fm.runBackendProbeWorker=async()=>{portable++;throw Error('A native picker must not discover coordinator models');};fx.fm.saveFleetConfig=()=>{saves++;};
const shots:any[]=[];
try{for(const c of matrix()){
 (await import(repo+'/src/locale.ts')).setLocale(c.lang);const {page,ctx,csp}=await fx.page(c),errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
 if(process.env.SKEW){
  await page.route('**/assets/app.css*',(r:any)=>r.fulfill({contentType:'text/css',body:readFileSync(join(process.env.SKEW!,'app.css'))}));
  await page.route('**/ui/js/settings-catalog.js*',(r:any)=>r.fulfill({contentType:'text/javascript',body:readFileSync(join(process.env.SKEW!,'settings-catalog.js'))}));
 }
 await page.goto(fx.base+'/settings/agents');await mounted(page,'.p-settings');const row=page.locator('.s-row').filter({has:page.locator(`.s-name[title="${name}"]`)});await row.locator('button').filter({hasText:/^(Settings|設定)$/}).click();await page.waitForSelector('#ag-model');
 await page.locator('.agent-runtime-settings > button').click();await page.waitForSelector('.agent-runtime-change-dialog');
 const dialog=page.locator('.agent-runtime-change-dialog');await dialog.locator(`input[value="machine:${ids[0]}"]`).check();await dialog.getByRole('button',{name:/^(Next|下一步)$/}).click();
 await page.waitForSelector('#runtime-change-model');
 const shot=async(label:string)=>{await page.evaluate(()=>document.fonts.ready);await page.locator('#runtime-change-model').scrollIntoViewIfNeeded();
 {
  const account=page.locator('#runtime-change-claude-account');await account.scrollIntoViewIfNeeded();
  const field=await account.boundingBox(),model=await page.locator('#runtime-change-model').boundingBox(),body=await dialog.locator('.dlg-body').boundingBox();
  if(!field||!body||field.y<body.y-1||field.y+field.height>body.y+body.height+1)throw Error('Account selector is clipped');
  if(!model||model.y<body.y-1||model.y+model.height>body.y+body.height+1)throw Error('Model selector is clipped');
 }
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error('page overflow');const file=`${caseName(c)}-${label}.png`;await page.screenshot({path:join(out,file)});shots.push(file);};
 for(const profile of ['work','personal']){
  await page.locator('#runtime-change-claude-account').selectOption(profile);const count=calls.length;await dialog.locator('.model-refresh > button').click();await page.waitForFunction((selected:string)=>document.querySelector('#runtime-change-model option[value^="'+selected+'-"]'),profile,{timeout:10000});
  if(calls.length!==count+1||calls.at(-1).id!==ids[0]||calls.at(-1).payload.profile!==profile)throw Error('wrong model account/computer');await shot(profile);
 }
 await dialog.getByRole('button',{name:/^(Back|上一步)$/}).click();await dialog.locator(`input[value="machine:${ids[1]}"]`).check();await dialog.getByRole('button',{name:/^(Next|下一步)$/}).click();await page.waitForSelector('#runtime-change-model');
 await page.locator('#runtime-change-claude-account').selectOption('work');await dialog.locator('.model-refresh > button').click();await page.waitForFunction(()=>document.querySelector('#runtime-change-model option[value="work-2222"]'));
 if(calls.at(-1).id!==ids[1]||calls.at(-1).payload.profile!=='work')throw Error('second computer not selected');await shot('second-computer');
 if(errors.length||(await csp()).length)throw Error(JSON.stringify({errors,csp:await csp()}));await ctx.close();
}if(portable||saves)throw Error('Native refresh reached coordinator discovery or settings write');writeFileSync(join(out,'results.json'),JSON.stringify({shots,calls,portable,saves},null,2));console.log(JSON.stringify({shots:shots.length,requests:calls.length,portable,saves}));}finally{await fx.close();}
