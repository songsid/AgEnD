// Real Settings surface, synthetic scratch Fleet; monitoring stays off, no native/account/model run.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,statSync} from 'node:fs';import {join} from 'node:path';
import {bootFixture,mounted,caseName,type MatrixCase} from '../smoke-fixture/index.mts';
import {HOST_ALERT_DEFAULTS} from '../../../src/host-monitoring-alert-policy.js';
import {hostAlertSettingsPath} from '../../../src/host-monitoring-alert-settings.js';
const out=process.env.OUT;if(!out)throw Error('OUT required');mkdirSync(out,{recursive:true});
const fx=await bootFixture({port:0,host:true,classic:false,instances:1});const checks:any[]=[];
try{
 const fm=fx.fm;fm.fleetConfig.monitoring={enabled:false,agent_footprint:false};fm.rawFleetConfig.monitoring={enabled:false,agent_footprint:false};fm.hostMonitoringAvailable=()=>true;fm.settingsSelfConfirmation=()=>null;
 for(const device of ['desk','phone']as const)for(const lang of ['en','zh-TW']as const){
  fm.saveHostAlertSettings({version:1,needsYou:true,general:false,rules:{memory:{...HOST_ALERT_DEFAULTS.memory,criticalOnly:false}}});
  const c:MatrixCase={device,theme:device==='desk'?'light':'dark',lang},name=caseName(c),p=await fx.page(c,{path:'/settings/notifications#host-monitoring'});const errors:string[]=[];p.page.on('pageerror',(error:Error)=>errors.push(error.message));
  try{
   await mounted(p.page,30000);await p.page.locator('.host-alert-settings summary').click();const toggle=p.page.locator('#alert-memory-criticalOnly');await toggle.waitFor();assert.equal(await toggle.isChecked(),false);
   const before=readFileSync(fm.configPath,'utf8');await toggle.check();
   const response=p.page.waitForResponse((r:any)=>new URL(r.url()).pathname==='/api/settings/fleet/host-alerts'&&r.request().method()==='PUT');
   await p.page.getByRole('button',{name:lang==='en'?'Save':'儲存',exact:true}).click();const put=await response,body=await put.json();assert.equal(put.status(),202);assert.equal(body.result,'pending_confirmation');
   const applied=await fm.settingsGate().store.decide(body.pending_change.id,'confirm',{label:'Fixture administrator',current:()=>true});assert.equal(applied.state,'applied');
   const answer=await p.page.request.get(fx.base+'/api/settings/fleet/host-alerts');assert.equal(answer.status(),200);assert.equal((await answer.json()).rules.memory.criticalOnly,true);assert.equal(JSON.parse(readFileSync(hostAlertSettingsPath(fm.dataDir),'utf8')).rules.memory.criticalOnly,true);assert.equal(statSync(hostAlertSettingsPath(fm.dataDir)).mode&0o777,0o600);assert.equal(readFileSync(fm.configPath,'utf8'),before);
   await p.page.reload();await p.page.locator('.host-alert-settings summary').click();assert.equal(await p.page.locator('#alert-memory-criticalOnly').isChecked(),true);await p.page.evaluate(()=>document.fonts.ready);await p.page.locator('#alert-memory-criticalOnly').evaluate((el:any)=>el.closest('fieldset').scrollIntoView({block:'center'}));
   const geometry=await p.page.locator('#alert-memory-criticalOnly').evaluate((el:any)=>{const l=el.labels[0],r=l.getBoundingClientRect(),f=el.closest('fieldset').getBoundingClientRect();return{labelWidth:r.width,labelHeight:r.height,fieldsetLeft:f.left,fieldsetRight:f.right,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth+1};});
   assert.equal(geometry.overflow,false);assert(geometry.fieldsetLeft>=0&&geometry.fieldsetRight<=geometry.viewport+1);if(device==='phone')assert(geometry.labelWidth>=44&&geometry.labelHeight>=43.5);
   assert.deepEqual(errors,[]);await p.page.screenshot({path:join(out,name+'.png')});checks.push({name,put:202,confirmation:'applied',get:200,savedCriticalOnly:true,reloadedChecked:true,sidecarMode:'0600',yamlUnchanged:true,...geometry});
  }finally{await p.ctx.close();}
 }
 writeFileSync(join(out,'checks.json'),JSON.stringify({scope:'Real Settings app and confirmed save/readback in scratch synthetic Fleet. Monitoring off; capability visibility exposed only. No real metric/incident/account/model/CLI claim.',views:checks},null,2)+'\n');console.log(JSON.stringify(checks));
}finally{fx.fm.settingsConfirmation?.store?.close();await fx.close();}
