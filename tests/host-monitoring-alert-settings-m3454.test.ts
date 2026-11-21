import {mkdtempSync,rmSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {describe,it,expect} from 'vitest';
import {defaultHostAlertSettings,parseHostAlertSettings,readHostAlertSettings,writeHostAlertSettings,hostAlertSettingsPath} from '../src/host-monitoring-alert-settings.js';
import {HOST_ALERT_DEFAULTS} from '../src/host-monitoring-alert-policy.js';
import {SettingsBaselines} from '../src/settings-baseline.js';
describe('rollback-safe bounded alert preferences',()=>{
 it('persists explicit false independently of YAML and the drive sidecar; baseline includes same captured bytes',async()=>{
  const root=mkdtempSync(join(tmpdir(),'host-alert-settings-'));try{
   const config=join(root,'fleet.yaml');writeFileSync(config,'instances: {}\n');expect(readHostAlertSettings(root)).toEqual(defaultHostAlertSettings());const next={...defaultHostAlertSettings(),needsYou:false};writeHostAlertSettings(root,next);
   expect(statSync(hostAlertSettingsPath(root)).mode&0o777).toBe(0o600);expect(readHostAlertSettings(root)).toEqual(next);expect(readFileSync(config,'utf8')).toBe('instances: {}\n');
   const baselines=new SettingsBaselines({dataDir:root,configPath:()=>config,config:()=>({instances:{},defaults:{}}),current:()=>1});
   const before=await baselines.read();expect(before.hostAlertSettings?.()).toEqual(next);writeHostAlertSettings(root,{...next,general:true});const after=await baselines.read();expect(after.fingerprint).not.toBe(before.fingerprint);expect(before.hostAlertSettings?.().general).toBe(false);expect(after.hostAlertSettings?.().general).toBe(true);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it.each([null,{...defaultHostAlertSettings(),general:'yes'},{...defaultHostAlertSettings(),command:'bad'},{...defaultHostAlertSettings(),rules:{cpu:{...HOST_ALERT_DEFAULTS.cpu,urgent:10}}},{...defaultHostAlertSettings(),rules:{cpu:HOST_ALERT_DEFAULTS.filesystem}},{...defaultHostAlertSettings(),rules:{'disk:wrong':HOST_ALERT_DEFAULTS.filesystem}}])('rejects unsupported settings %j',value=>{expect(()=>parseHostAlertSettings(value)).toThrow();});
});
