// Isolated real Settings app, real session/gate/FleetManager sidecar; no live fleet or collector.
import assert from 'node:assert/strict';
import {readFileSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {bootFixture,mounted} from '../smoke-fixture/index.mts';
import {hostAlertSettingsPath} from '../../../src/host-monitoring-alert-settings.js';
const fx=await bootFixture({port:Number(process.env.HP??49160),host:true,classic:false,instances:1});
let p:any;
try{
 const fm=fx.fm;fm.fleetConfig.monitoring={enabled:false,agent_footprint:false};fm.rawFleetConfig.monitoring={enabled:false,agent_footprint:false};
 fm.hostMonitoringAvailable=()=>true; // Expose the card without starting a collector.
 fm.settingsSelfConfirmation=()=>null; // Exercise the held confirmation, not host self-confirm.
 p=await fx.page({device:'desk',theme:'light',lang:'en'},{path:'/settings/notifications#host-monitoring'});
 await mounted(p.page,30000);await p.page.waitForSelector('#hostAlert-general');
 const before=readFileSync(fm.configPath,'utf8');
 await p.page.locator('#hostAlert-general').check();
 await p.page.locator('.host-alert-settings summary').click();
 await p.page.locator('#alert-cpu-warning').fill('91');
 const response=p.page.waitForResponse((r:any)=>new URL(r.url()).pathname==='/api/settings/fleet/host-alerts'&&r.request().method()==='PUT');
 await p.page.getByRole('button',{name:'Save',exact:true}).click();
 const put=await response,body=await put.json();assert.equal(put.status(),202);assert.equal(body.result,'pending_confirmation');
 const gate=fm.settingsGate(),applied=await gate.store.decide(body.pending_change.id,'confirm',{label:'Isolated fixture admin',current:()=>true});assert.equal(applied.state,'applied');
 const got=await p.page.request.get(fx.base+'/api/settings/fleet/host-alerts');assert.equal(got.status(),200);const alerts=await got.json();assert.equal(alerts.general,true);assert.equal(alerts.rules.cpu.warning,91);
 const path=hostAlertSettingsPath(fm.dataDir),saved=JSON.parse(readFileSync(path,'utf8'));assert.deepEqual(saved,alerts);assert.equal(statSync(path).mode&0o777,0o600);assert.equal(readFileSync(fm.configPath,'utf8'),before);
 await p.page.reload();await p.page.waitForSelector('#hostAlert-general');assert.equal(await p.page.locator('#hostAlert-general').isChecked(),true);await p.page.locator('.host-alert-settings summary').click();assert.equal(await p.page.locator('#alert-cpu-warning').inputValue(),'91');
 const result={ok:true,scope:'Isolated real Settings app; synthetic roster; monitoring off; no collector/account/model',put:202,confirmation:'applied',get:200,general:true,cpuWarning:91,sidecarMode:'0600',sidecarMatchesGet:true,yamlUnchanged:true,reloadedUiMatches:true};
 mkdirSync(process.env.OUT!,{recursive:true});writeFileSync(join(process.env.OUT!,'readback.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{fx.fm.settingsConfirmation?.store?.close();await p?.ctx?.close();await fx.close();}
