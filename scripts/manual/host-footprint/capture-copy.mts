/** S214: scoped real-app copy evidence. Reads the completed private hour; starts no collector/Fleet/CLI. */
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';import {join} from 'node:path';import {createServer} from 'node:net';
import {bootFixture,matrix,caseName} from '../smoke-fixture/index.mts';
const out=process.env.OUT,phase=process.env.PHASE,input=process.env.MEASUREMENT;
if(!out||!input||!['before','after'].includes(phase??''))throw Error('OUT, MEASUREMENT and PHASE=before|after required');
mkdirSync(out,{recursive:true});const measured=JSON.parse(readFileSync(input,'utf8'));if(measured.durationMs<3600000||measured.snapshot?.footprint?.reading?.covered!==1)throw Error('Completed covered hour required');
const health=structuredClone(measured.snapshot),answer=structuredClone(measured.historyAnswer),aliases=new Map<string,string>();
for(const [i,v]of(health.disks.value?.volumes??[]).entries()){const id=(i+100).toString(16).padStart(16,'0');aliases.set(v.id,id);v.id=id;delete v.sharedGroup;}
for(const records of[health.alerts?.active,health.alerts?.resolved])for(const record of records??[])for(const[old,id]of aliases)if(record.key==='disk:'+old)record.key='disk:'+id;
if(answer.ok)for(const s of answer.value.series)for(const[old,id]of aliases)s.id=s.id.replace(old,id);
for(const row of health.footprint.reading.rows)row.label='Sample helper';Object.assign(health.footprint.reading,{offset:0,hasMore:false});health.platformSupported=true;
const server=createServer();await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)});const port=(server.address()as any).port;await new Promise<void>(r=>server.close(()=>r()));if(port===65535)throw Error('No adjacent port');
const fx=await bootFixture({port,classic:false,host:true,roster:[{name:'sample-helper',displayName:'Sample helper',backend:'claude-code',status:'stopped'}]});
const {HostFootprint}=await import('../../../src/host-monitoring-footprint.js');const retained=new HostFootprint({roots:()=>[]});(retained as any).value=health.footprint;
fx.fm.fleetConfig.monitoring={enabled:true,agent_footprint:true};fx.fm.rawFleetConfig.monitoring={...fx.fm.fleetConfig.monitoring};fx.fm.hostMonitoringAvailable=()=>true;fx.fm.hostHealthSnapshot=()=>({...structuredClone(health),footprint:retained.snapshot()});fx.fm.hostHistoryQuery=async(_r:string,ids:string[])=>answer.ok?{ok:true,value:{...answer.value,series:answer.value.series.filter((s:any)=>ids.includes(s.id))}}:answer;
fx.fm.notifyFleetError=()=>{throw Error('No notification sender in copy fixture');};const checks:any[]=[];
try{for(const c of matrix(process.env.MATRIX??'desk-light-en,phone-dark-zh-TW'))for(const view of(c.device==='phone'?['table','settings']:['settings'])){
 if(process.env.VIEW&&process.env.VIEW!==view)continue;
 const {ctx,page}=await fx.page(c,{path:view==='table'?'/ui/fleet/host-health':'/settings/notifications#host-monitoring'});try{
 const selector=view==='table'?'.host-footprint':'#host-monitoring';await page.locator(selector).waitFor();await page.evaluate(()=>document.fonts.ready);
 if(view==='settings')await page.waitForFunction(()=>[...document.querySelectorAll('#host-monitoring input[role=switch]')].slice(0,2).every((e:any)=>e.checked));
 await page.locator(selector).evaluate((e:any)=>e.scrollIntoView({block:'start'}));
 const geometry=await page.locator(selector).evaluate((e:any)=>{const th=e.querySelector('thead th:last-child'),range=th?document.createRange():null;if(range)range.selectNodeContents(th);return{pageOverflow:document.documentElement.scrollWidth>innerWidth+1,tableOverflow:[...e.querySelectorAll('.table-wrap')].some((n:any)=>n.scrollWidth>n.clientWidth+1),header:th?.textContent,headerLines:range?[...range.getClientRects()].filter(r=>r.width>0&&r.height>0).length:null,small:[...e.querySelectorAll('button,a.btn,input[role=switch],select')].filter((n:any)=>{if(n.disabled||!n.offsetWidth)return false;const r=n.getBoundingClientRect();if(n.type==='checkbox'&&[...(n.labels??[])].some((l:any)=>{const x=l.getBoundingClientRect();return x.width>=44&&x.height>=44}))return false;return r.width<43.5||r.height<43.5}).map((n:any)=>n.id||n.textContent),hint:e.querySelector('#hostMonitoringAgents-hint')?.textContent};});
 if(geometry.pageOverflow||geometry.tableOverflow||(c.device==='phone'&&geometry.small.length))throw Error(JSON.stringify(geometry));
 if(phase==='after'&&view==='table'&&(geometry.header!=='管理檔案'||geometry.headerLines!==1))throw Error(JSON.stringify({reason:'Managed heading must stay on one line',geometry}));
 if(phase==='after'&&view==='settings'&&(!geometry.hint.includes('128')||!geometry.hint.includes('4096')))throw Error('Actual sample caps must be visible');
 const assets:any[]=[];for(const url of await page.evaluate(()=>performance.getEntriesByType('resource').map((r:any)=>r.name).filter((n:string)=>/\.(js|css)(\?|$)/.test(n)))){const response=await ctx.request.get(url);if(!response.ok())throw Error('Asset request failed');assets.push({path:new URL(url).pathname,sha256:createHash('sha256').update(await response.body()).digest('hex')});}
 const name=phase+'-'+view+'-'+caseName(c);await page.screenshot({path:join(out,name+'.png')});checks.push({name,case:c,geometry,assets});
 }finally{await ctx.close();}}
 writeFileSync(join(out,'checks.json'),JSON.stringify({phase,scope:'Same completed real host cache before/after; synthetic helper/volume aliases, original timestamps. No collector, live Fleet/CLI/account/model or new measurement.',views:checks},null,2));
}finally{await fx.close();}
