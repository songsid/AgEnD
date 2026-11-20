import {createServer,request,type Server} from 'node:http';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {handleWebRequest} from '../src/web-api.js';
import {WebSessionStore,tokenEpoch} from '../src/web-session.js';
import {createPublicWebGateway,isPublicWebRoute,type PublicGateway} from '../src/public-web-gateway.js';
import {disabledHostHealth} from '../src/host-monitoring.js';
const token='h'.repeat(48),exposureId='e'.repeat(32),sessions=new WebSessionStore();
const read=vi.fn(disabledHostHealth);const history=vi.fn(async(_range:any,_series:any)=>({ok:true,value:{fixture:true}}));let lastCookie='';let server:Server,port:number,gatewayPort:number,gateway:PublicGateway;
beforeAll(async()=>{
 const dispatch=(req:any,res:any)=>{if(!handleWebRequest(req,res,new URL(req.url!,'http://localhost'),{webToken:token,webSessions:sessions,hostHealthSnapshot:read,hostHistoryQuery:history}as any)){res.writeHead(404);res.end("{}");}};
 server=createServer(dispatch);
 gateway=createPublicWebGateway({hostname:'fleet.example.test',exposureId,isCurrent:()=>true,isOpen:()=>true,dispatch});
 gateway.setHost('fleet.example.test');gatewayPort=Number((await gateway.listen()).port);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));port=(server.address()as any).port;
});
afterAll(async()=>{const closed=new Promise<void>(r=>gateway.server.once('close',()=>r()));gateway.close();await closed;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
async function get(tier:'admin'|'read'|'guest'|'token'|'anonymous',overGateway=false,path='/ui/host-history?range=1h&series=cpu.used',method='GET'){
 const cookie=['token','anonymous'].includes(tier)?'':sessions.create({tier:tier as any,surface:overGateway?'gateway':'local',label:'fixture',tokenEpoch:tokenEpoch(token),...(overGateway?{exposureId}:{}),...(tier==='guest'?{owner:{adapterId:'discord',userId:'fixture-user'}}:{})}).sessionId;
 lastCookie=cookie;
 return new Promise<{status:number;body:any;cache:string}>((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port:overGateway?gatewayPort:port,path,method,headers:{host:overGateway?'fleet.example.test':`127.0.0.1:${port}`,...(cookie?{cookie:`${overGateway?'__Host-':''}agend_session=${cookie}`} : {}),...(tier==='token'?{'x-agend-token':token}:{})}},res=>{
   const parts:Buffer[]=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(parts).toString()),cache:String(res.headers['cache-control'])}));
  });req.on('error',reject);req.end();
 });
}
describe('bounded asynchronous host history boundary',()=>{
 it.each([false,true])('admin history query crosses the real listener/gateway (gateway=%s)',async gw=>{
  history.mockClear();const r=await get('admin',gw);expect(r.status).toBe(200);expect(r.body).toEqual({ok:true,value:{fixture:true}});expect(r.cache).toContain('no-store');expect(history).toHaveBeenCalledExactlyOnceWith('1h',['cpu.used']);
 });
 it.each(['read','guest','token','anonymous']as const)('refuses %s before invoking history',async tier=>{
  history.mockClear();expect((await get(tier)).status).toBe(403);expect((await get(tier,true)).status).toBe(403);expect(history).not.toHaveBeenCalled();
 });
 it('rejects unknown paths/SQL, extra keys, duplicate range and more than24 series',async()=>{
  history.mockClear();for(const query of ['path=/','range=all&series=cpu.used','range=1h&series=../file','range=1h&range=1h&series=cpu.used','range=1h&series=cpu.used&sql=SELECT','range=1h&'+Array.from({length:25},(_,i)=>`series=disk.${i.toString(16).padStart(16,'0')}.used`).join('&')])expect((await get('admin',false,'/ui/host-history?'+query)).status).toBe(400);
  expect(history).not.toHaveBeenCalled();expect(isPublicWebRoute('GET','/ui/host-history')).toBe(true);expect(isPublicWebRoute('POST','/ui/host-history')).toBe(false);expect(isPublicWebRoute('GET','/ui/host-history/extra')).toBe(false);
 });
 it('rechecks the current session before returning an asynchronous history answer',async()=>{
  history.mockImplementationOnce(async()=>{sessions.revokeById(lastCookie);return {ok:true,value:{fixture:true}};});expect((await get('admin')).status).toBe(403);
 });
 it('turns persistence errors into a bounded unavailable response without private details',async()=>{
  history.mockImplementationOnce(async()=>{throw Error('/private/fixture')});const r=await get('admin');expect(r.status).toBe(503);expect(r.body).toEqual({error:'history_unavailable'});
 });
});
