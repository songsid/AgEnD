import {EventEmitter}from'node:events';
import{mkdtempSync,writeFileSync,readFileSync,rmSync,statSync,existsSync}from'node:fs';
import{join}from'node:path';import{tmpdir}from'node:os';import yaml from'js-yaml';
import{afterEach,describe,expect,it,vi}from'vitest';
import{FleetManager}from'../src/fleet-manager.js';
import{handleSettingsRequest}from'../src/settings-api.js';
import{monitoringConfig as beta16}from'./fixtures/host-monitoring-beta16/host-monitoring-config.js';
const roots:string[]=[];afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(source='instances: {}\nmonitoring:\n  enabled: false\n  agent_footprint: false\n'){
 const root=mkdtempSync(join(tmpdir(),'drive-sidecar-'));roots.push(root);const path=join(root,'fleet.yaml');writeFileSync(path,source);const fm=new FleetManager(root)as any;return{root,path,fm};
}
function save(fm:any,root:string,body:unknown){
 return new Promise<{status:number;body:any}>((resolve,reject)=>{
  const route='/api/settings/fleet/monitoring',req:any=new EventEmitter();req.method='PUT';req.headers={};req.destroy=()=>{};let status=0;
  const ctx:any={dataDir:root,fleetConfig:fm.fleetConfig,logger:{warn:vi.fn()},saveFleetConfig:(patch:any)=>fm.saveFleetConfig(patch),hostMonitoringAvailable:()=>true,
   hostMonitoringSettings:()=>fm.hostMonitoringSettings?.()??fm.fleetConfig.monitoring,saveHostMonitoringSettings:(patch:any)=>fm.saveHostMonitoringSettings(patch)};
  const res:any={headersSent:false,destroyed:false,writeHead(n:number){status=n;this.headersSent=true},setHeader(){},end(text:string){resolve({status,body:JSON.parse(text)})}};
  try{expect(handleSettingsRequest(req,res,new URL(route,'http://localhost'),ctx)).toBe(true);queueMicrotask(()=>{req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end')});}catch(e){reject(e)}
 });
}
const document=(path:string)=>yaml.load(readFileSync(path,'utf8'))as any;
describe('rollback-safe WSL drive Settings',()=>{
 it('a real Settings selection writes rollback-safe YAML and keeps the sidecar choice after reload',async()=>{
  const f=fixture();f.fm.loadConfig(f.path);const r=await save(f.fm,f.root,{enabled:false,wsl_drive:'E'});expect(r.status).toBe(200);
  const raw=document(f.path);expect(()=>beta16(raw.monitoring)).not.toThrow();expect(raw.monitoring).not.toHaveProperty('wsl_drive');
  expect(JSON.parse(readFileSync(join(f.root,'host-monitoring-settings.json'),'utf8'))).toEqual({version:1,wsl_drive:'E'});expect(statSync(join(f.root,'host-monitoring-settings.json')).mode&0o777).toBe(0o600);
  const again=new FleetManager(f.root)as any;again.loadConfig(f.path);expect(again.hostMonitoringSettings().wsl_drive).toBe('E');
 });
 it('startup migrates the existing key through the real lossless writer, preserving unrelated YAML',()=>{
  const f=fixture('# keep this\ninstances: {}\nunknown_extension: keep-me\nmonitoring:\n  enabled: false\n  wsl_drive: E\n');f.fm.loadConfig(f.path,{startup:true});
  expect(()=>beta16(document(f.path).monitoring)).not.toThrow();expect(readFileSync(f.path,'utf8')).toContain('# keep this');expect(document(f.path).unknown_extension).toBe('keep-me');expect(f.fm.hostMonitoringSettings().wsl_drive).toBe('E');
 });
 it('any normal config save migrates a legacy key too',()=>{
  const f=fixture('instances: {}\nmonitoring:\n  enabled: false\n  wsl_drive: D\n');f.fm.loadConfig(f.path);f.fm.saveFleetConfig();expect(()=>beta16(document(f.path).monitoring)).not.toThrow();expect(f.fm.hostMonitoringSettings().wsl_drive).toBe('D');
 });
});

import {mkdirSync,symlinkSync}from'node:fs';
import {readHostMonitoringDrive,writeHostMonitoringDrive,hostMonitoringSettingsPath,parseHostMonitoringDrive}from'../src/host-monitoring-settings-store.js';
import {SettingsBaselines}from'../src/settings-baseline.js';
import {prepareSettingsEffect}from'../src/settings-effect.js';
describe('sidecar safety and committed Settings state',()=>{
 it.each(['invalid','null','[]','{"version":2,"wsl_drive":"E"}','{"version":1,"wsl_drive":"e"}','{"version":1,"wsl_drive":"E","extra":true}',' '.repeat(513)])('invalid sidecar falls back to auto: %s',content=>{
  const f=fixture();f.fm.loadConfig(f.path);expect(readHostMonitoringDrive(f.root)).toBeUndefined();writeFileSync(hostMonitoringSettingsPath(f.root),content);expect(f.fm.hostMonitoringSettings()).not.toHaveProperty('wsl_drive');expect(parseHostMonitoringDrive(content)).toBeUndefined();
 });
 it('does not follow a sidecar symlink and atomically replaces it with a private file',()=>{
  const f=fixture(),other=join(f.root,'other');writeFileSync(other,'{"version":1,"wsl_drive":"D"}');symlinkSync(other,hostMonitoringSettingsPath(f.root));expect(readHostMonitoringDrive(f.root)).toBeUndefined();writeHostMonitoringDrive(f.root,'E');expect(readHostMonitoringDrive(f.root)).toBe('E');expect(readFileSync(other,'utf8')).toContain('D');expect(statSync(hostMonitoringSettingsPath(f.root)).mode&0o777).toBe(0o600);
 });
 it('omitted drive retains the choice, explicit empty resets auto, and both saves pass the shipped reader',async()=>{
  const f=fixture();f.fm.loadConfig(f.path);writeHostMonitoringDrive(f.root,'E');expect((await save(f.fm,f.root,{agent_footprint:true})).status).toBe(200);expect(f.fm.hostMonitoringSettings().wsl_drive).toBe('E');expect(f.fm.fleetConfig.monitoring).not.toHaveProperty('wsl_drive');
  expect((await save(f.fm,f.root,{wsl_drive:''})).status).toBe(200);expect(readHostMonitoringDrive(f.root)).toBeUndefined();expect(()=>beta16(document(f.path).monitoring)).not.toThrow();const bytes=readFileSync(f.path,'utf8');f.fm.saveFleetConfig();expect(readFileSync(f.path,'utf8')).toBe(bytes);
 });
 it('refuses a sidecar write failure without changing YAML or runtime config',async()=>{
  const f=fixture();f.fm.loadConfig(f.path);mkdirSync(hostMonitoringSettingsPath(f.root));const bytes=readFileSync(f.path,'utf8'),before=f.fm.fleetConfig.monitoring;expect((await save(f.fm,f.root,{wsl_drive:'E',enabled:true})).status).toBe(500);expect(readFileSync(f.path,'utf8')).toBe(bytes);expect(f.fm.fleetConfig.monitoring).toBe(before);
 });
 it('compensates the sidecar and config when the real YAML transaction rejects',async()=>{
  const f=fixture();f.fm.loadConfig(f.path);writeHostMonitoringDrive(f.root,'D');const before=f.fm.fleetConfig.monitoring;writeFileSync(f.path,'[invalid YAML');expect((await save(f.fm,f.root,{wsl_drive:'E'})).status).toBe(500);expect(readHostMonitoringDrive(f.root)).toBe('D');expect(f.fm.fleetConfig.monitoring).toBe(before);expect(readFileSync(f.path,'utf8')).toBe('[invalid YAML');
 });
 it('projects the sidecar only in the effective Settings response, never into the persisted object',()=>{
  const f=fixture();f.fm.loadConfig(f.path);writeHostMonitoringDrive(f.root,'E');let value:any;
  const req:any={method:'GET',headers:{}};const res:any={writeHead(){},end(s:string){value=JSON.parse(s)}};
  handleSettingsRequest(req,res,new URL('/api/settings/fleet','http://localhost'),{fleetConfig:f.fm.fleetConfig,hostMonitoringSettings:()=>f.fm.hostMonitoringSettings()}as any);
  expect(value.monitoring.wsl_drive).toBe('E');expect(f.fm.fleetConfig.monitoring).not.toHaveProperty('wsl_drive');expect(document(f.path).monitoring).not.toHaveProperty('wsl_drive');
 });
 it('confirmation fingerprints fence sidecar drift and classify from the same captured bytes',async()=>{
  const f=fixture();f.fm.loadConfig(f.path);writeHostMonitoringDrive(f.root,'D');const baseline=new SettingsBaselines({dataDir:f.root,configPath:()=>f.path,config:()=>f.fm.fleetConfig,current:()=>1,hostMonitoringAvailable:()=>true});
  const read=await baseline.read(),snapshot=JSON.stringify(baseline.snapshot());expect(baseline.captureCommitted()).toBe(read.fingerprint);expect(read.hostMonitoringDrive?.()).toBe('D');
  const effect=prepareSettingsEffect('PUT','/api/settings/fleet/monitoring',{wsl_drive:'E'},read);expect(effect).toBeDefined();
  writeHostMonitoringDrive(f.root,'E');expect(baseline.captureCommitted()).not.toBe(read.fingerprint);expect(JSON.stringify(baseline.snapshot())).not.toBe(snapshot);expect(read.hostMonitoringDrive?.()).toBe('D');expect((await baseline.read()).hostMonitoringDrive?.()).toBe('E');
 });
});
