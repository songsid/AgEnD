import {createServer,request,type Server} from 'node:http';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {handleWebRequest} from '../src/web-api.js';
import {WebSessionStore,tokenEpoch} from '../src/web-session.js';
import {createPublicWebGateway,isPublicWebRoute,type PublicGateway} from '../src/public-web-gateway.js';
import {disabledHostHealth} from '../src/host-monitoring.js';
const token='h'.repeat(48),exposureId='e'.repeat(32),sessions=new WebSessionStore();
const read=vi.fn(disabledHostHealth);let server:Server,port:number,gatewayPort:number,gateway:PublicGateway;
beforeAll(async()=>{
 const dispatch=(req:any,res:any)=>{if(!handleWebRequest(req,res,new URL(req.url!,'http://localhost'),{webToken:token,webSessions:sessions,hostHealthSnapshot:read}as any)){res.writeHead(404);res.end("{}");}};
 server=createServer(dispatch);
 gateway=createPublicWebGateway({hostname:'fleet.example.test',exposureId,isCurrent:()=>true,isOpen:()=>true,dispatch});
 gateway.setHost('fleet.example.test');gatewayPort=Number((await gateway.listen()).port);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));port=(server.address()as any).port;
});
afterAll(async()=>{const closed=new Promise<void>(r=>gateway.server.once('close',()=>r()));gateway.close();await closed;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
async function get(tier:'admin'|'read'|'guest'|'token'|'anonymous',overGateway=false,path='/ui/host-health',method='GET'){
 const cookie=['token','anonymous'].includes(tier)?'':sessions.create({tier:tier as any,surface:overGateway?'gateway':'local',label:'fixture',tokenEpoch:tokenEpoch(token),...(overGateway?{exposureId}:{}),...(tier==='guest'?{owner:{adapterId:'discord',userId:'fixture-user'}}:{})}).sessionId;
 return new Promise<{status:number;body:any;cache:string}>((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port:overGateway?gatewayPort:port,path,method,headers:{host:overGateway?'fleet.example.test':`127.0.0.1:${port}`,...(cookie?{cookie:`${overGateway?'__Host-':''}agend_session=${cookie}`} : {}),...(tier==='token'?{'x-agend-token':token}:{})}},res=>{
   const parts:Buffer[]=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(parts).toString()),cache:String(res.headers['cache-control'])}));
  });req.on('error',reject);req.end();
 });
}
describe('passive administrator host-health cache',()=>{
 it.each([false,true])('returns the disabled snapshot only to an admin session (gateway=%s)',async gateway=>{
  read.mockClear();const r=await get('admin',gateway);expect(r.status).toBe(200);expect(r.body).toEqual(disabledHostHealth());expect(r.cache).toContain('no-store');expect(read).toHaveBeenCalledTimes(1);
 });
 it.each(['read','guest','token','anonymous']as const)('refuses %s without reading or creating a collector',async tier=>{
  read.mockClear();expect((await get(tier)).status).toBe(403);expect((await get(tier,true)).status).toBe(403);expect(read).not.toHaveBeenCalled();
 });
 it('the public manifest permits only the exact cached GET',()=>{expect(isPublicWebRoute('GET','/ui/host-health')).toBe(true);for(const method of ['POST','PUT','HEAD','DELETE'])expect(isPublicWebRoute(method,'/ui/host-health')).toBe(false);expect(isPublicWebRoute('GET','/ui/host-health/extra')).toBe(false);});
 it('accepts no path/command parameters or mutation method',async()=>{
  read.mockClear();expect((await get('admin',false,'/ui/host-health?path=/')).status).toBe(400);expect((await get('admin',false,'/ui/host-health','POST')).status).toBe(403);expect(read).not.toHaveBeenCalled();
 });
});
