import {EventEmitter} from 'node:events';
import {describe,it,expect,vi} from 'vitest';
import {WebSessionStore,tokenEpoch,csrfTokenFor} from '../src/web-session.js';
import {handleWebRequest,broadcastSseEvent} from '../src/web-api.js';
import {handleSettingsRequest} from '../src/settings-api.js';
import {prepareSettingsEffect,isSettingsMutation} from '../src/settings-effect.js';
import {isPublicWebRoute} from '../src/public-web-gateway.js';
import {defaultHostAlertSettings} from '../src/host-monitoring-alert-settings.js';
const token='c'.repeat(48),origin='http://127.0.0.1:19280';
function fixture(tier:'admin'|'read'|'token'='admin'){
 const sessions=new WebSessionStore(),session=sessions.create({tier:tier==='token'?'admin':tier,surface:'local',label:'fixture',tokenEpoch:tokenEpoch(token)});
 const headers:any=tier==='token'?{'x-agend-token':token}:{cookie:'agend_session='+session.sessionId,'x-agend-csrf':csrfTokenFor(session.sessionId),origin};
 const ctx:any={webToken:token,webSessions:sessions,logger:{warn:vi.fn(),info:vi.fn()},sseClients:new Set(),getUiStatus:()=>({instances:[]}),needsYouItems:()=>[{id:'ordinary',type:'delivery'},{id:'private',type:'host',hostAlert:{key:'cpu'}}],hostAlertAction:vi.fn(async()=>true),fleetConfig:{defaults:{},instances:{}},hostAlertSettings:defaultHostAlertSettings,saveHostAlertSettings:vi.fn((v:any)=>v)};
 function request(path:string,method='GET'){
  let status=0,body='';const writes:string[]=[];
  const req:any=Object.assign(new EventEmitter(),{method,url:path,headers:{host:'127.0.0.1:19280',...headers},socket:{destroy:vi.fn()},destroy:vi.fn()});
  const res:any=Object.assign(new EventEmitter(),{headersSent:false,destroyed:false,setHeader(){},writeHead(n:number){status=n;this.headersSent=true;},end(value=''){body=value;},write(value:string){writes.push(value);return true;}});
  return {req,res,writes,status:()=>status,body:()=>body?JSON.parse(body):null,feed(value:any){req.emit('data',Buffer.from(JSON.stringify(value)));req.emit('end');},run(){return path.startsWith('/api/')?handleSettingsRequest(req,res,new URL(path,origin),ctx):handleWebRequest(req,res,new URL(path,origin),ctx);}};
 }
 return {ctx,request};
}
async function tick(){for(let n=0;n<40;n++)await Promise.resolve();}
describe('host alerts administrator boundary',()=>{
 it.each(['admin','read','token']as const)('filters passive initial/live/poll host items for %s',tier=>{
  const f=fixture(tier),poll=f.request('/ui/poll?after=');poll.run();expect(poll.body().needs.map((i:any)=>i.id)).toEqual(tier==='admin'?['ordinary','private']:['ordinary']);
  const events=f.request('/ui/events');events.run();const initial=events.writes.find(x=>x.startsWith('event: needs\n'))!;expect(initial.includes('private')).toBe(tier==='admin');
  broadcastSseEvent(f.ctx.sseClients,'needs',{items:f.ctx.needsYouItems()});expect(events.writes.at(-1)!.includes('private')).toBe(tier==='admin');events.req.emit('close');
 });
 it.each(['read','token']as const)('refuses %s actions and settings without touching cache/store',async tier=>{
  const f=fixture(tier);for(const [path,method] of [['/ui/host-alert-action','POST'],['/api/settings/fleet/host-alerts','PUT'],['/api/settings/fleet/host-alerts','GET']]){const r=f.request(path,method);r.run();expect(r.status()).toBe(403);}expect(f.ctx.hostAlertAction).not.toHaveBeenCalled();expect(f.ctx.saveHostAlertSettings).not.toHaveBeenCalled();
 });
 it('binds acknowledgment identity to the session and validates before persistence',async()=>{
  const f=fixture(),r=f.request('/ui/host-alert-action','POST');r.run();r.feed({key:'cpu',revision:2,snoozeMs:3600000});await tick();expect(r.status()).toBe(200);expect(f.ctx.hostAlertAction).toHaveBeenCalledWith('cpu',2,expect.stringMatching(/^web:[a-f0-9]+$/),3600000);
  const invalid=f.request('/ui/host-alert-action','POST');invalid.run();invalid.feed({key:'cpu',revision:2,actor:'spoof'});await tick();expect(invalid.status()).toBe(400);expect(f.ctx.hostAlertAction).toHaveBeenCalledTimes(1);
 });
 it('uses the normal staged settings effect and strict sidecar schema, never fleet YAML',async()=>{
  const f=fixture(),next={...defaultHostAlertSettings(),general:true};const r=f.request('/api/settings/fleet/host-alerts','PUT');r.run();r.feed(next);await tick();expect(r.status()).toBe(200);expect(f.ctx.saveHostAlertSettings).toHaveBeenCalledWith(next);expect(f.ctx.fleetConfig).not.toHaveProperty('host_alerts');
  expect(isSettingsMutation('PUT','/api/settings/fleet/host-alerts')).toBe(true);const effect=prepareSettingsEffect('PUT','/api/settings/fleet/host-alerts',next,{config:f.ctx.fleetConfig,classic:{},hostAlertSettings:defaultHostAlertSettings});expect(effect.diff?.summary.join(' ')).toContain('General on');expect(()=>prepareSettingsEffect('PUT','/api/settings/fleet/host-alerts',{...next,command:'bad'},{config:f.ctx.fleetConfig,classic:{},hostAlertSettings:defaultHostAlertSettings})).toThrow('invalid_alert_settings');
 });
 it('allows exact gateway routes only',()=>{
  expect(isPublicWebRoute('POST','/ui/host-alert-action')).toBe(true);expect(isPublicWebRoute('GET','/ui/host-alert-action')).toBe(false);expect(isPublicWebRoute('POST','/ui/host-alert-action/extra')).toBe(false);expect(isPublicWebRoute('PUT','/api/settings/fleet/host-alerts')).toBe(true);
 });
});
