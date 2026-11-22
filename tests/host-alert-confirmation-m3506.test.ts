import {EventEmitter} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {SettingsConfirmationStore} from '../src/settings-confirmation.js';
import {SettingsHttpConfirmation} from '../src/settings-http-confirmation.js';
import {SettingsBaselines} from '../src/settings-baseline.js';
import {handleSettingsRequest} from '../src/settings-api.js';
import {authorizeSession} from '../src/web-auth.js';
import {WebSessionStore,tokenEpoch,csrfTokenFor} from '../src/web-session.js';
import {isSettingsReplay} from '../src/settings-request-capability.js';
import {defaultHostAlertSettings,hostAlertSettingsPath,readHostAlertSettings,writeHostAlertSettings} from '../src/host-monitoring-alert-settings.js';
import {HOST_ALERT_DEFAULTS} from '../src/host-monitoring-alert-policy.js';
const token='c'.repeat(48),origin='http://127.0.0.1:19280',route='/api/settings/fleet/host-alerts';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0))fn();});
function fixture(tier:'admin'|'read'='admin'){
 const root=mkdtempSync(join(tmpdir(),'alert-confirm-')),configPath=join(root,'fleet.yaml');writeFileSync(configPath,'instances: {}\n');
 const config:any={instances:{},defaults:{}},sessions=new WebSessionStore(),session=sessions.create({tier,surface:'local',label:'Fixture admin',tokenEpoch:tokenEpoch(token)});
 const store=new SettingsConfirmationStore({audit:vi.fn()});cleanup.push(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const save=vi.fn((next:any)=>{writeHostAlertSettings(root,next);return readHostAlertSettings(root);});
 const ctx:any={fleetConfig:config,configPath,dataDir:root,webToken:token,webSessions:sessions,logger:{info:vi.fn(),warn:vi.fn()},hostAlertSettings:()=>readHostAlertSettings(root),saveHostAlertSettings:save};
 const baselines=new SettingsBaselines({dataDir:root,configPath:()=>configPath,config:()=>config,current:()=>0});
 const gate=new SettingsHttpConfirmation(store,{principal:req=>{const who=authorizeSession(req as any,token,sessions,{touch:false});if(who.kind!=='ok')return null;const record=who.session;return{id:record.idHash,label:record.label,source:'web_session',current:()=>sessions.isCurrent(record,tokenEpoch(token)),localAdmin:()=>record.tier==='admin'};},baseline:()=>baselines.read(),snapshot:()=>baselines.snapshot()});
 const replays:any[]=[];
 function request(method:string,body?:unknown,direct=false,headers:Record<string,string>={}){return new Promise<{status:number;body:any}>((resolve,reject)=>{
  const req:any=Object.assign(new EventEmitter(),{method,url:route,headers:{host:'127.0.0.1:19280',origin,cookie:'agend_session='+session.sessionId,'x-agend-csrf':csrfTokenFor(session.sessionId),...headers},destroy(){}});
  let status=0;const res:any={headersSent:false,destroyed:false,once(){},setHeader(){},writeHead(n:number){status=n;this.headersSent=true;},end(raw:string){resolve({status,body:JSON.parse(raw)});}};
  const next=(r:any,s:any,u:URL)=>{if(isSettingsReplay(r))replays.push({...r.headers});return handleSettingsRequest(r,s,u,ctx);};
  try{const u=new URL(route,origin);expect((!direct&&gate.handle(req,res,u,next))||next(req,res,u)).toBe(true);queueMicrotask(()=>{if(body!==undefined)req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');});}catch(e){reject(e)}
 });}
 return{root,configPath,session,sessions,store,save,request,replays};
}
const proposed=()=>({...defaultHostAlertSettings(),general:true,rules:{cpu:{...HOST_ALERT_DEFAULTS.cpu,warning:91,urgent:97,clear:85}}});
const confirmer=()=>({label:'Fixture confirmer',current:()=>true});
describe('host-alert settings through the real confirmation replay',()=>{
 it('session PUT -> confirm -> private sidecar -> authenticated GET, without replaying a cookie',async()=>{
  const h=fixture(),next=proposed(),before=readFileSync(h.configPath,'utf8');const pending=await h.request('PUT',next);
  expect(pending.status).toBe(202);expect(pending.body.result).toBe('pending_confirmation');expect(h.save).not.toHaveBeenCalled();expect(existsSync(hostAlertSettingsPath(h.root))).toBe(false);
  const applied=await h.store.decide(pending.body.pending_change.id,'confirm',confirmer());expect(applied.state).toBe('applied');expect(h.replays).toEqual([{}]);expect(h.save).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(hostAlertSettingsPath(h.root),'utf8'))).toEqual(next);expect(statSync(hostAlertSettingsPath(h.root)).mode&0o777).toBe(0o600);expect((await h.request('GET')).body).toEqual(next);expect(readFileSync(h.configPath,'utf8')).toBe(before);
  await expect(h.store.decide(pending.body.pending_change.id,'confirm',confirmer())).rejects.toThrow('confirmation_not_pending');
 });
 it('refuses a read session at the handler and at confirmed apply',async()=>{
  const h=fixture('read');expect((await h.request('PUT',proposed(),true)).status).toBe(403);expect((await h.request('GET')).status).toBe(403);
  const pending=await h.request('PUT',proposed());expect(pending.status).toBe(202);expect((await h.store.decide(pending.body.pending_change.id,'confirm',confirmer())).state).toBe('failed');expect(h.save).not.toHaveBeenCalled();expect(existsSync(hostAlertSettingsPath(h.root))).toBe(false);
 });
 it('does not turn an admin header token into a session continuation',async()=>{
  const h=fixture();expect((await h.request('PUT',proposed(),true,{cookie:'','x-agend-token':token})).status).toBe(403);expect(h.save).not.toHaveBeenCalled();
 });
 it('refuses a principal demoted after proposal even when another admin confirms',async()=>{
  const h=fixture(),pending=await h.request('PUT',proposed());Object.assign(h.session.record,{tier:'read'});
  expect((await h.store.decide(pending.body.pending_change.id,'confirm',confirmer())).state).not.toBe('applied');expect(h.save).not.toHaveBeenCalled();expect(existsSync(hostAlertSettingsPath(h.root))).toBe(false);
 });
 it('keeps sidecar baseline fencing on the confirmed path',async()=>{
  const h=fixture(),pending=await h.request('PUT',proposed());const outside={...defaultHostAlertSettings(),needsYou:false};writeHostAlertSettings(h.root,outside);
  expect((await h.store.decide(pending.body.pending_change.id,'confirm',confirmer())).state).toBe('stale');expect(h.save).not.toHaveBeenCalled();expect(readHostAlertSettings(h.root)).toEqual(outside);
 });
});
