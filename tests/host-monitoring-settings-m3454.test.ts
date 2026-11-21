import { describe, expect, it } from 'vitest';
import { loadFleetConfigSource } from '../src/config.js';
import { validateFleetConfig } from '../src/config-validator.js';

describe('host monitoring opt-in configuration', () => {
  it('normalizes missing settings to two explicit false values in effective configuration', () => {
    for (const source of ['', 'instances: {}', 'monitoring: {}\ninstances: {}']) {
      expect((loadFleetConfigSource(source) as any).monitoring).toEqual({enabled:false,agent_footprint:false});
    }
  });
  it('preserves an explicit off independently of the saved agent preference', () => {
    const cfg=loadFleetConfigSource('instances: {}\nmonitoring:\n  enabled: false\n  agent_footprint: true');
    expect((cfg as any).monitoring).toEqual({enabled:false,agent_footprint:true});
  });
  it.each([null,[],true,{enabled:'true'},{enabled:null},{agent_footprint:1},{enabled:true,unknown:true}])('refuses malformed monitoring settings: %j', monitoring=>{
    expect(validateFleetConfig({instances:{},monitoring}).errors.some(e=>e.path.startsWith('monitoring'))).toBe(true);
  });
});

import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { parseMonitoringSettings, monitoringConfig } from '../src/host-monitoring-config.js';
import { prepareSettingsEffect, isSettingsMutation } from '../src/settings-effect.js';
import { handleSettingsRequest } from '../src/settings-api.js';
import { bindGatewayRequest } from '../src/web-request-context.js';
const route='/api/settings/fleet/monitoring';
function api(fleet:any,body:unknown,{failSave=false,publicLink=false,available=false}={}) {
  const save=vi.fn((_changes:any)=>{if(failSave)throw Error('disk full')});
  const ctx:any={fleetConfig:fleet,saveFleetConfig:save,hostMonitoringAvailable:()=>available,logger:{warn:vi.fn()},dataDir:'/unused'};
  return new Promise<{status:number,body:any,save:typeof save}>((resolve,reject)=>{
    const req:any=new EventEmitter();req.method='PUT';req.url=route;req.headers={};req.destroy=()=>{};
    if(publicLink)bindGatewayRequest(req,{surface:'gateway',exposureId:'e'.repeat(32),expectedOrigin:'https://example.test',isCurrent:()=>true});
    let status=0;const res:any={headersSent:false,destroyed:false,writeHead(n:number){status=n;this.headersSent=true},setHeader(){},end(raw:string){resolve({status,body:JSON.parse(raw),save})}};
    try{expect(handleSettingsRequest(req,res,new URL(route,'http://localhost'),ctx)).toBe(true);queueMicrotask(()=>{req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end')})}catch(e){reject(e)}
  });
}
describe('settings persistence and staged confirmation agreement',()=>{
  it('writes two explicit booleans, never removes off, without creating a collector',async()=>{
    const fleet:any={defaults:{},instances:{}};const r=await api(fleet,{enabled:false});
    expect(r.status).toBe(200);expect(fleet.monitoring).toEqual({enabled:false,agent_footprint:false});
    expect(r.save.mock.calls[0][0]).toEqual([{path:['monitoring','enabled'],value:false},{path:['monitoring','agent_footprint'],value:false}]);
  });
  it('keeps the old in-memory state if persistence fails',async()=>{
    const fleet:any={defaults:{},instances:{},monitoring:{enabled:true,agent_footprint:true}};const before=fleet.monitoring;
    expect((await api(fleet,{enabled:false},{failSave:true})).status).toBe(500);expect(fleet.monitoring).toBe(before);
  });
  it.each([{},null,{enabled:'false'},{enabled:false,other:true},{enabled:null}])('invalid settings never save: %j',async body=>{
    const r=await api({defaults:{},instances:{}},body);expect(r.status).toBe(400);expect(r.save).not.toHaveBeenCalled();
  });
  it('cannot pretend to start a collector before that slice is installed',async()=>{
    const r=await api({defaults:{},instances:{}},{enabled:true});expect(r.status).toBe(409);expect(r.save).not.toHaveBeenCalled();
    expect(()=>prepareSettingsEffect('PUT',route,{enabled:true},{config:{defaults:{},instances:{}},classic:{}})).toThrow('monitoring_unavailable');
  });
  it('enables only with real runtime capability and keeps persisted config beta.16-compatible',async()=>{
    const fleet:any={defaults:{},instances:{},monitoring:{enabled:false,agent_footprint:false}};
    const r=await api(fleet,{enabled:true},{available:true});expect(r.status).toBe(200);expect(fleet.monitoring).not.toHaveProperty('wsl_drive');
    expect(()=>prepareSettingsEffect('PUT',route,{enabled:true},{config:fleet,classic:{},hostMonitoringAvailable:()=>true})).not.toThrow();
    for(const drive of ['/mnt/e','e','EE',null,true])expect(parseMonitoringSettings({wsl_drive:drive})).toEqual({error:'invalid_monitoring_settings'});
    expect(monitoringConfig({wsl_drive:'E'})).toEqual({enabled:false,agent_footprint:false});
  });
  it('classifies only validated boolean changes as an immediate settings operation',()=>{
    expect(isSettingsMutation('PUT',route)).toBe(true);
    const before:any={defaults:{},instances:{},monitoring:{enabled:true,agent_footprint:true}};
    expect(prepareSettingsEffect('PUT',route,{enabled:false},{config:before,classic:{}}).diff).toBeNull();
    expect(parseMonitoringSettings({enabled:false})).toEqual({patch:{enabled:false}});
    expect(monitoringConfig({enabled:false,agent_footprint:true})).toEqual({enabled:false,agent_footprint:true});
  });
  it('refuses the public link without an admin session',async()=>{
    const r=await api({defaults:{},instances:{}},{enabled:false},{publicLink:true});expect(r.status).toBe(403);expect(r.save).not.toHaveBeenCalled();
  });
});

import { mkdtempSync,writeFileSync,readFileSync,rmSync,readdirSync } from 'node:fs';
import {join}from'node:path';import{tmpdir}from'node:os';import yaml from'js-yaml';
import{FleetManager}from'../src/fleet-manager.js';
it('keeps explicit false in the real YAML writer across repeated saves, without a monitoring store',()=>{
  const root=mkdtempSync(join(tmpdir(),'agend-monitor-settings-'));
  try{
    const path=join(root,'fleet.yaml');writeFileSync(path,'instances: {}\nunknown_extension: keep-me\n');
    const fm=new FleetManager(root)as any;fm.loadConfig(path);
    const patch=[{path:['monitoring','enabled'],value:false},{path:['monitoring','agent_footprint'],value:false}];
    fm.saveFleetConfig(patch);fm.saveFleetConfig();
    expect((yaml.load(readFileSync(path,'utf8'))as any)).toMatchObject({monitoring:{enabled:false,agent_footprint:false},unknown_extension:'keep-me'});
    expect(readdirSync(root).filter(n=>/monitor/i.test(n))).toEqual([]);
  }finally{rmSync(root,{recursive:true,force:true})}
});
