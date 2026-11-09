import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {WebSessionStore,csrfTokenFor,tokenEpoch} from '../src/web-session.js';
import {handleWebRequest} from '../src/web-api.js';
const servers:Server[]=[];const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
beforeEach(()=>{vi.stubEnv('AGEND_REMOTE_RUNTIME','1');vi.stubEnv('AGEND_WINDOWS_CLI','0');});
afterEach(async()=>{vi.unstubAllEnvs();for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}});
async function rig(){
 const token='a'.repeat(48),sessions=new WebSessionStore();const admin=sessions.create({tier:'admin',surface:'local',label:'admin',tokenEpoch:tokenEpoch(token)});
 const machines=new Map([a,b].map(id=>[id,{id,platform:'win32',status:'online',generation:1,approvedAt:1,bootId:'first',runtimeInfo:{capabilities:['model-catalog-refresh']},inventory:{clis:[],credentialProfiles:{default:'work',profiles:[{name:'work',loggedIn:true}]}}}]));
 const call=vi.fn(async (id:string,_op:string,p:any):Promise<any>=>({cli:p.cli,profile:p.profile||'work',source:'account-api',models:[{id:`model-${id}`,name:'Chosen account'}]}));
 const local=vi.fn(),ctx:any={webToken:token,webSessions:sessions,fleetConfig:{instances:{w:{working_directory:'C:\\work',runtime:'windows',backend:'claude-code',machine_id:a,backend_options:{'claude-code':{credential_profile:'work'}}}}},runtimeCoordinator:()=>({machine:(id:string)=>machines.get(id),callAccount:call}),refreshModelCatalogFor:local,logger:{error(){},info(){},warn(){},debug(){}}};
 const s=createServer((req,res)=>{handleWebRequest(req,res,new URL(req.url!,`http://${req.headers.host}`),ctx);});servers.push(s);s.listen(0,'127.0.0.1');await once(s,'listening');const base=`http://127.0.0.1:${(s.address() as any).port}`;
 const post=(body:any,headers:any={})=>fetch(base+'/ui/models/refresh',{method:'POST',headers:{'content-type':'application/json',cookie:`agend_session=${admin.sessionId}`,origin:base,'x-agend-csrf':csrfTokenFor(admin.sessionId),...headers},body:JSON.stringify(body)});
 return {ctx,local,call,machines,post,base,sessions,admin};
}
it('rediscovery goes only to the chosen computer/profile; passive GET does not dispatch and never borrows default models',async()=>{
 const r=await rig();let response=await r.post({backend:'claude-code',instance:'w'});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({refreshed:true,models:[{id:`model-${a}`}]});
 expect(r.call).toHaveBeenCalledWith(a,'models.refresh',{cli:'claude-code',profile:'work',actor:expect.stringMatching(/^admin:/)},25000);expect(r.local).not.toHaveBeenCalled();
 const get=await fetch(r.base+'/ui/models?backend=claude-code&instance=w',{headers:{cookie:`agend_session=${r.admin.sessionId}`}});expect((await get.json()).models).toEqual([{id:`model-${a}`,label:'Chosen account'}]);expect(r.call).toHaveBeenCalledOnce();
 response=await r.post({backend:'claude-code',runtime:'windows',machineId:b,profile:'other'});expect(response.status).toBe(200);expect(r.call.mock.calls[1][0]).toBe(b);expect(r.call.mock.calls[1][2].profile).toBe('other');
 expect(r.local).not.toHaveBeenCalled();
});
it('old/offline peers, crossed machine/backend/runtime and native custom providers never fall back to this host',async()=>{
 const r=await rig();for(const body of [{backend:'codex',instance:'w'},{backend:'claude-code',instance:'w',machineId:b},{backend:'claude-code',instance:'w',runtime:'wsl'},{backend:'claude-code',runtime:'wsl',machineId:b}])expect((await r.post(body)).status).toBeGreaterThanOrEqual(400);
 r.machines.get(a)!.runtimeInfo.capabilities=[];expect((await r.post({backend:'claude-code',instance:'w'})).status).toBe(503);
 r.machines.get(a)!.status='offline';expect((await r.post({backend:'claude-code',instance:'w'})).status).toBe(503);
 expect(r.call).not.toHaveBeenCalled();expect(r.local).not.toHaveBeenCalled();
});
it.each(['revoked-session','generation','profile','instance'])('no result after %s changes during the remote await',async change=>{
 const r=await rig();let finish!:(v:any)=>void;const entered=new Promise<void>(resolve=>r.call.mockImplementation(async()=>{resolve();return new Promise(done=>{finish=done;});}));
 const pending=r.post({backend:'claude-code',instance:'w'});await entered;
 if(change==='revoked-session')r.sessions.revokeById(r.admin.sessionId);else if(change==='generation')r.machines.get(a)!.generation++;else if(change==='profile')r.ctx.fleetConfig.instances.w.backend_options['claude-code'].credential_profile='new';else r.ctx.fleetConfig.instances.w=structuredClone(r.ctx.fleetConfig.instances.w);
 finish({cli:'claude-code',profile:'work',source:'account-api',models:[{id:'private-stale'}]});const res=await pending;expect(res.status).toBeGreaterThanOrEqual(400);expect(await res.text()).not.toContain('private-stale');expect(r.local).not.toHaveBeenCalled();
});
it('remote refresh requires the local admin session, CSRF, exact returned account and bounded metadata',async()=>{
 const r=await rig();expect((await r.post({backend:'claude-code',instance:'w'},{cookie:'','x-agend-token':'a'.repeat(48)})).status).toBe(503);expect(r.call).not.toHaveBeenCalled();
 expect((await r.post({backend:'claude-code',instance:'w'},{origin:'https://evil.example'})).status).toBeGreaterThanOrEqual(400);expect(r.call).not.toHaveBeenCalled();
 r.call.mockResolvedValue({cli:'claude-code',profile:'another',source:'account-api',models:[{id:'foreign'}]});const res=await r.post({backend:'claude-code',instance:'w'});expect(res.status).toBe(503);expect(await res.text()).not.toContain('foreign');
});

it("rejects oversized or malformed remote model rows before projecting them",async()=>{
 const r=await rig();for(const models of [Array.from({length:201},(_,i)=>({id:`m${i}`})),[{id:"../bad\nname"}],[{id:"ok",description:{secret:"no"}}]]){
  r.call.mockResolvedValue({cli:"claude-code",profile:"work",source:"account-api",models});const res=await r.post({backend:"claude-code",instance:"w"});expect(res.status).toBe(503);expect(await res.text()).not.toContain('"models"');
 }
});
