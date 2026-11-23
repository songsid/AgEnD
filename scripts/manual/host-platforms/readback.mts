/** Real Settings UI -> confirmation -> sidecar -> HTTP GET/reloaded UI; scratch fixture only. */
import assert from 'node:assert/strict';import {mkdirSync,readFileSync,writeFileSync,statSync} from 'node:fs';import {join} from 'node:path';
import {bootFixture,mounted} from '../smoke-fixture/index.mts';
import {disabledHostHealth,type MonitoringPlatform} from '../../../src/host-monitoring.js';
import {defaultHostAlertSettings,hostAlertSettingsPath,hostAlertRuleFor} from '../../../src/host-monitoring-alert-settings.js';
const out=process.env.OUT;if(!out)throw Error('OUT required');mkdirSync(out,{recursive:true});
const fx=await bootFixture({port:0,classic:false,host:true,instances:1});const results:any[]=[];let platform:MonitoringPlatform='darwin',p:any;
fx.fm.hostMonitoringPlatform=()=>platform;fx.fm.hostMonitoringAvailable=()=>true;fx.fm.settingsSelfConfirmation=()=>null;
fx.fm.hostHealthSnapshot=()=>{const s=disabledHostHealth(),at=Date.now();s.platform=platform;s.enabled=true;s.platformSupported=true;s.memory={status:'ok',sampledAt:at,attemptedAt:at,value:{totalBytes:16*1024**3,availableBytes:8*1024**3,availableKind:'available',pressure:'normal',swapTotalBytes:0,swapFreeBytes:0}};return s;};
try{
 for(const name of ['darwin','linux','wsl']as const){platform=name;fx.fm.saveHostAlertSettings(defaultHostAlertSettings());
  p=await fx.page({device:'desk',theme:'light',lang:'en'},{path:'/settings/notifications#host-monitoring'});await mounted(p.page,30000);await p.page.locator('.host-alert-settings details').evaluate((e:any)=>{e.open=true;});
  const choice=p.page.locator('#alert-memory-criticalOnly'),chosen=name!=='darwin';assert.equal(await choice.isChecked(),!chosen);const yaml=readFileSync(fx.fm.configPath,'utf8');await choice.setChecked(chosen);
  const pending=p.page.waitForResponse((r:any)=>new URL(r.url()).pathname==='/api/settings/fleet/host-alerts'&&r.request().method()==='PUT');await p.page.getByRole('button',{name:'Save',exact:true}).click();const response=await pending,body=await response.json();assert.equal(response.status(),202);assert.equal(body.result,'pending_confirmation');
  const applied=await fx.fm.settingsGate().store.decide(body.pending_change.id,'confirm',{label:'Isolated fixture admin',current:()=>true});assert.equal(applied.state,'applied');
  const responseGet=await p.page.request.get(fx.base+'/api/settings/fleet/host-alerts'),saved=await responseGet.json();assert.equal(responseGet.status(),200);assert.equal(saved.rules.memory.criticalOnly,chosen);assert.equal(hostAlertRuleFor(saved,'memory','memory',name).criticalOnly,chosen);
  const path=hostAlertSettingsPath(fx.fm.dataDir);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),saved);assert.equal(statSync(path).mode&0o777,0o600);assert.equal(readFileSync(fx.fm.configPath,'utf8'),yaml);
  await p.page.reload();await p.page.locator('.host-alert-settings details').evaluate((e:any)=>{e.open=true;});assert.equal(await p.page.locator('#alert-memory-criticalOnly').isChecked(),chosen);
  results.push({platform:name,defaultCriticalOnly:!chosen,savedCriticalOnly:chosen,put:202,confirmation:'applied',get:200,sidecarMode:'0600',sidecarMatchesGet:true,yamlUnchanged:true,reloadedUiMatches:true});await p.ctx.close();p=null;
 }
 writeFileSync(join(out,'readback.json'),JSON.stringify({scope:'Isolated actual Settings UI/session/gate/sidecar/API. Platform/cache overridden; no collector, live Fleet/CLI/account/model.',results},null,2)+'\n');console.log('3 platform explicit-choice confirmation/readbacks passed');
}finally{fx.fm.settingsConfirmation?.store?.close();await p?.ctx?.close();await fx.close();}
