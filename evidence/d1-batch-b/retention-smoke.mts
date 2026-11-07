import {execFileSync} from 'node:child_process';import {writeFileSync} from 'node:fs';import {join} from 'node:path';
const REPO=process.env.REPO!,BASE=process.env.BASE_REF!,OUT=process.env.OUT!;
const {bootFixture,matrix,caseName,shotPath}=await import(REPO+'/scripts/manual/smoke-fixture/index.mts');
const fx=await bootFixture({port:Number(process.env.HP),instances:2,classic:false});const rows:any[]=[];
try{for(const phase of ['before','after'])for(const c of matrix('full')){
 const {ctx,page,csp}=await fx.page(c);const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
 if(phase==='before'){const body=execFileSync('git',['-C',REPO,'show',`${BASE}:src/ui/settings-strings.js`],{encoding:'utf8'});await page.route('**/ui/js/settings-strings.js*',(r:any)=>r.fulfill({status:200,contentType:'text/javascript',body}));}
 await page.goto(fx.base+'/settings/advanced');const tab=page.locator('#advanced-tab-effective');
 if(REPO.endsWith('alpha')){await tab.waitFor({state:'visible'});await tab.click();}
 const note=page.locator('.s-effective-footnotes > .note, .s-web-readonly > .note').last();await note.waitFor({state:'visible'});await note.scrollIntoViewIfNeeded();
 const text=await note.innerText(),box=await note.boundingBox();const ok=!!box&&box.y>=-1&&box.y+box.height<=page.viewportSize().height+1&&errors.length===0&&(await csp()).length===0&&(phase==='before'||(!text.includes('fleet.yaml')&&/cannot be changed here|無法變更保存期限/.test(text)));
 rows.push({case:phase+'-'+caseName(c),ok,text,box,errors});await page.screenshot({path:shotPath('d1-batch-b',phase+'-'+caseName(c),'retention')});await ctx.close();
}}finally{writeFileSync(join(OUT,'retention-result.json'),JSON.stringify({head:execFileSync('git',['-C',REPO,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),rows},null,2));await fx.close();}
console.log(JSON.stringify({cases:rows.length,failed:rows.filter(x=>!x.ok).map(x=>x.case)}));process.exitCode=rows.every(x=>x.ok)?0:1;
