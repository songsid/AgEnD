import {createServer,request,type Server} from 'node:http';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {handleWebRequest} from '../src/web-api.js';
import {WebSessionStore,tokenEpoch} from '../src/web-session.js';
import {bindGatewayRequest} from '../src/web-request-context.js';
import {disabledHostHealth} from '../src/host-monitoring.js';
const token='h'.repeat(48),exposureId='e'.repeat(32),sessions=new WebSessionStore();
const read=vi.fn(disabledHostHealth);let server:Server,port:number;
beforeAll(async()=>{
 server=createServer((req,res)=>{
  if(req.headers['x-rig-gateway'])bindGatewayRequest(req,{surface:'gateway',exposureId,expectedOrigin:'https://fleet.example.test',isCurrent:()=>true});
  if(!handleWebRequest(req,res,new URL(req.url!,'http://localhost'),{webToken:token,webSessions:sessions,hostHealthSnapshot:read}as any)){res.writeHead(404);res.end("{}");}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));port=(server.address()as any).port;
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
async function get(tier:'admin'|'read'|'guest'|'token'|'anonymous',gateway=false,path='/ui/host-health',method='GET'){
 const cookie=['token','anonymous'].includes(tier)?'':sessions.create({tier:tier as any,surface:gateway?'gateway':'local',label:'fixture',tokenEpoch:tokenEpoch(token),...(gateway?{exposureId}:{}),...(tier==='guest'?{owner:{adapterId:'discord',userId:'fixture-user'}}:{})}).sessionId;
 return new Promise<{status:number;body:any;cache:string}>((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port,path,method,headers:{host:gateway?'fleet.example.test':`127.0.0.1:${port}`,...(cookie?{cookie:`${gateway?'__Host-':''}agend_session=${cookie}`} : {}),...(gateway?{'x-rig-gateway':'1'}:{}),...(tier==='token'?{'x-agend-token':token}:{})}},res=>{
   const parts:Buffer[]=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(parts).toString()),cache:String(res.headers['cache-control'])}));
  });req.on('error',reject);req.end();
 });
}
describe('passive administrator host-health cache',()=>{
 it.each([false,true])('returns the disabled snapshot only to an admin session (gateway=%s)',async gateway=>{
  read.mockClear();const r=await get('admin',gateway);expect(r.status).toBe(200);expect(r.body).toEqual(disabledHostHealth());expect(r.cache).toContain('no-store');expect(read).toHaveBeenCalledTimes(1);
 });
 it.each(['read','guest','token','anonymous']as const)('refuses %s without reading or creating a collector',async tier=>{
  read.mockClear();expect((await get(tier)).status).toBe(403);expect(read).not.toHaveBeenCalled();
 });
 it('accepts no path/command parameters or mutation method',async()=>{
  read.mockClear();expect((await get('admin',false,'/ui/host-health?path=/')).status).toBe(400);expect((await get('admin',false,'/ui/host-health','POST')).status).toBe(403);expect(read).not.toHaveBeenCalled();
 });
});
