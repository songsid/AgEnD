/** S208 serial real-app capture. Cheap actual host cache, plus explicitly labelled synthetic alert states.
 * No Fleet start, CLI, account/model, real notification sender or recursive scan. Private raw snapshot is never published.
 */
import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {createServer} from 'node:net';import {setTimeout as pause} from 'node:timers/promises';
import {bootFixture,matrix,caseName} from '../smoke-fixture/index.mts';
const out=process.env.OUT;if(!out||process.env.REAL!=='1')throw Error('OUT and REAL=1 required');mkdirSync(out,{recursive:true});
const listener=createServer();await new Promise<void>((r,j)=>{listener.once('error',j);listener.listen(0,'127.0.0.1',r)});const port=(listener.address()as any).port;await new Promise<void>(r=>listener.close(()=>r()));if(port===65535)throw Error('No adjacent port');
const fx=await bootFixture({port,roster:[{name:'sample-helper',displayName:'Sample helper',backend:'claude-code',description:'Synthetic capture fixture',status:'stopped'}],classic:false,host:true});
const checks:any[]=[],actual=fx.fm.hostHealthSnapshot.bind(fx.fm);let synthetic:any=null;
fx.fm.hostHealthSnapshot=()=>synthetic??actual();fx.fm.notifyFleetError=()=>{throw Error('No notification sender in capture fixture');};
async function until(fn:()=>boolean,ms=45000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error('Capture condition not met');await pause(25);}}
async function take(name:string,c:any,path:string,selector:string,details=false){
 const {ctx,page}=await fx.page(c,{path});const errors:string[]=[];page.on('pageerror',(e:any)=>errors.push(String(e)));
 try{await page.locator(selector).waitFor();await page.evaluate(()=>document.fonts.ready);if(details)await page.locator('.host-alert-settings summary').click();await pause(150);
 const measured=await page.locator(selector).evaluate((root:any)=>{const controls=[...root.querySelectorAll('button,input,select,summary,a.btn')].filter((e:any)=>e.offsetWidth&&!e.disabled);const coverage=root.querySelector('.host-coverage'),range=coverage?document.createRange():null;if(coverage)range!.selectNodeContents(coverage);return{overflow:document.documentElement.scrollWidth>innerWidth+1,small:controls.filter((e:any)=>{const r=e.getBoundingClientRect();if(e.type==='checkbox'){for(const l of e.labels||[])if(l.getBoundingClientRect().height>=44&&l.getBoundingClientRect().width>=44)return false;}return Math.min(r.width,r.height)<43.5;}).map((e:any)=>e.textContent||e.id),coverageLines:range?.getClientRects().length??0};});
 if(errors.length||measured.overflow||(c.device==='phone'&&measured.small.length)||(selector==='.host-health'&&measured.coverageLines!==1))throw Error(JSON.stringify({name,errors,measured}));
 await page.screenshot({path:join(out,name+'.png'),fullPage:true});checks.push({name,...c,path,source:synthetic?'synthetic-alert-overlay-on-actual-cache':'actual-host-cache',...measured});
 }finally{await ctx.close();}
}
async function stop(){fx.fm.hostMonitor?.stop();fx.fm.memoryPressure?.stop();if(fx.fm.hostMonitor)await until(()=>{const s=actual();return s.state==='off'&&(s.history?.state??'off')==='off';},7000);}
try{
 const {MemoryPressure}=await import('../../../src/memory-pressure.js');fx.fm.memoryPressure=new MemoryPressure();fx.fm.memoryPressure.start();fx.fm.fleetConfig.monitoring={enabled:true,agent_footprint:false};fx.fm.saveFleetConfig([{path:['monitoring','enabled'],value:true},{path:['monitoring','agent_footprint'],value:false}]);fx.fm.startHostMonitoringRuntime();
 await until(()=>{const s=actual();return s.cpu.status==='ok'&&s.disks.status==='ok'&&s.alerts?.state==='ready';});const sample=actual();writeFileSync(join(out,'real-snapshot-private.json'),JSON.stringify(sample,null,2));
 if(process.env.RETAKE!=='affected')for(const c of matrix('desk-light-en,phone-dark-zh-TW'))await take('real-health-'+caseName(c),c,'/ui/fleet/host-health','.host-health');
 for(const c of matrix('desk-light-en,phone-dark-zh-TW'))await take('real-settings-'+caseName(c),c,'/settings/notifications#host-monitoring','#host-monitoring',true);
 const at=Date.now();synthetic={...sample,alerts:{state:'ready',needsYou:true,general:false,pending:0,resolved:[],active:[{key:'cpu',kind:'cpu',level:'urgent',revision:2,openedAt:at-900000,updatedAt:at,value:98.5,threshold:98},{key:'memory',kind:'memory',level:'warning',revision:1,openedAt:at-240000,updatedAt:at,value:1,threshold:1,acknowledgedAt:at-10000,acknowledgedBy:'web:fixture'}]}};
 for(const c of matrix('desk-light-en,phone-dark-zh-TW'))await take('fixture-alerts-'+caseName(c),c,'/ui/fleet/host-health','.host-health');
 fx.fm.needsYouItems=()=>synthetic.alerts.active.map((record:any)=>({id:'host:'+record.key,type:'host',instance:'',reason:'host_health',detail:'',since:record.openedAt,hostAlert:record}));
 for(const c of matrix('desk-light-en,phone-dark-zh-TW'))await take('fixture-needs-'+caseName(c),c,'/ui/needs','.p-needs');
 writeFileSync(join(out,'checks.json'),JSON.stringify({views:checks,scope:'Real health and real Settings captures; synthetic incident overlays and Needs you examples. No native incident, General platform send, footprint or one-hour claim.'},null,2));
}finally{try{await stop();}finally{await fx.close();}}
