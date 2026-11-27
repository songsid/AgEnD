/** Actual policy proxy + member adapter; no service, browser, account or model. */
import Database from 'better-sqlite3';
import {FleetManager} from '../src/fleet-manager.js';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {HubRoomPostAdapter} from '../src/hub/member/room-post.js';
import {nativeAgentAdmissionContext} from '../src/native-agent-admission.js';
import {captureRequestContextCall} from '../src/request-context-call.js';
import {requestContextDigest} from '../src/request-context-store.js';
import {assertRequestContextOperation} from '../src/request-context-policy.js';
import {ROOM_HISTORY_NOTE} from '../src/hub/room-history-model.js';
import type {RequestContextV1} from '../src/request-context-protocol.js';
const closed:(()=>void)[]=[];
afterEach(()=>{for(const close of closed.splice(0).reverse())close();});
function world(mode:'room'|'direct'|'owner'|'off'|'uncovered'|'capable-off'|'draining'='room',issuer='fixture-hub'){
 const a=randomUUID(),b=randomUUID(),db=new Database(':memory:');closed.push(()=>db.close());
 let live=true;const local={exposureId:randomUUID(),revision:1,consentId:randomUUID(),token:'owned-token'};
 const adapter=new HubRoomPostAdapter({hubId:'fixture-hub',db,binding:'owned',encryptionKey:Buffer.alloc(32,7),current:()=>true,local:agent=>agent==='agent-A'?local:null});closed.push(()=>adapter.close());
 const history=vi.fn(async(_exposure:string,room:string)=>({ok:true as const,roomId:room,note:ROOM_HISTORY_NOTE as typeof ROOM_HISTORY_NOTE,messages:[]}));
 adapter.connected({features:new Set(['welcome-caps-v1','room-ask-v1','room-post-v1','room-history-v1']),current:()=>true,list:async()=>({ok:true,exposureId:local.exposureId,rooms:[]}),post:async()=>({ok:false,code:'unavailable'}),history});
 let installedMode:'active'|'off'|'draining'=mode==='capable-off'?'off':mode==='draining'?'draining':'active';
 const owner=['owner','capable-off','draining'].includes(mode);
 const contextId=randomUUID();
 const context:RequestContextV1={ref:{version:1,contextId,rootContextId:contextId},rootEvidenceRef:'fixture',ingress:owner?'owner':'hub',
  initiatingActor:owner?{kind:'person',platform:'discord',userId:'owner'}:{kind:'person',platform:'hub',hubId:issuer,id:'directory/reader'},
  source:{instance:'agent-A',incarnation:'v1'},sourceAudience:{kind:mode==='direct'?'hub':'room',ref:a},returnAudience:{kind:'room',ref:b}};
 const lease=captureRequestContextCall({token:randomUUID(),inputId:'admitted',context,wireSha256:requestContextDigest('input'),owner:{instance:'agent-A',incarnation:'v1',workGeneration:'work',daemonBootId:'boot',spawnGeneration:1,launchFenceEpoch:0,deliveryEpoch:0}},()=>live);
 const base:any={...(mode==='off'?{}:{requestContextPolicy:{assert:assertRequestContextOperation,installedMode:()=>installedMode}}),hubAgentRooms:adapter,hubRoomHistory:FleetManager.prototype.hubRoomHistory};
 const proxy=nativeAgentAdmissionContext(base,{instance:'agent-A',current:()=>true,taskAllowed:()=>false,...(mode==='uncovered'?{}:{requestContext:lease})});
 return {a,b,history,local,adapter,setMode:(value:typeof installedMode)=>{installedMode=value;},disablePolicy:()=>{delete base.requestContextPolicy;},stop:()=>{live=false;},call:async(room:string)=>proxy.hubRoomHistory!({agent:'agent-A',current:()=>true},room)};
}
it('Hub request A can read A only, even when the return audience is B; direct/uncovered requests cannot read group history',async()=>{
 const w=world();await expect(w.call(w.b)).rejects.toMatchObject({reason:'room'});expect(w.history).not.toHaveBeenCalled();
 expect(await w.call(w.a)).toMatchObject({ok:true,roomId:w.a});expect(w.history).toHaveBeenCalledWith(w.local.exposureId,w.a,{});
 const direct=world('direct');await expect(direct.call(direct.a)).rejects.toMatchObject({reason:'room'});expect(direct.history).not.toHaveBeenCalled();
 const uncovered=world('uncovered');await expect(uncovered.call(uncovered.a)).rejects.toMatchObject({reason:'uncovered'});expect(uncovered.history).not.toHaveBeenCalled();
});
it('owner turns with On remain ordinary; Off refuses history without a reliable active ask lease',async()=>{
 const owner=world('owner');expect(await owner.call(owner.b)).toMatchObject({ok:true});
 const off=world('off');expect(await off.call(off.b)).toMatchObject({ok:false,code:'denied'});expect(off.history).not.toHaveBeenCalled();
});
it('binds the original Hub and retires held history when the captured lease ends',async()=>{
 const wrong=world('room','other-hub');expect(await wrong.call(wrong.a)).toEqual({ok:false,code:'denied'});expect(wrong.history).not.toHaveBeenCalled();
 const w=world();let finish!:(v:Awaited<ReturnType<typeof w.history>>)=>void;
 w.history.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=w.call(w.a);w.stop();finish({ok:true,roomId:w.a,note:ROOM_HISTORY_NOTE,messages:[]});expect(await pending).toEqual({ok:false,code:'stale'});
});

it('discards a held result when request-context is turned Off rather than keeping an old On scope',async()=>{
 const w=world('owner');let finish!:(v:Awaited<ReturnType<typeof w.history>>)=>void;
 w.history.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=w.call(w.b);w.disablePolicy();finish({ok:true,roomId:w.b,note:ROOM_HISTORY_NOTE,messages:[]});
 expect(await pending).toEqual({ok:false,code:'stale'});
});

it.each(['capable-off','draining'] as const)('actual Fleet history refuses %s even with a current captured owner and retained policy',async mode=>{
 const w=world(mode);expect(await w.call(w.b)).toEqual({ok:false,code:'denied'});expect(w.history).not.toHaveBeenCalled();
});
it.each(['off','draining'] as const)('actual Fleet history drops a result when the same policy changes from Active to %s during the read',async mode=>{
 const w=world('owner');let finish!:(v:Awaited<ReturnType<typeof w.history>>)=>void;
 w.history.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const pending=w.call(w.b);w.setMode(mode);finish({ok:true,roomId:w.b,note:ROOM_HISTORY_NOTE,messages:[]});
 expect(await pending).toEqual({ok:false,code:'stale'});
});
