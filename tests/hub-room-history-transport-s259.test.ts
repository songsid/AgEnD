/** Actual transport admission methods; synthetic link/RPC, no listener or service. */
import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {HubMemberClient} from '../src/hub/client.js';
import {parseMemberFrame,parseServerFrame} from '../src/hub/protocol.js';
import {hubWelcomeCapabilities} from '../src/hub/server.js';
import {ROOM_HISTORY_NOTE,roomHistoryResultSchema} from '../src/hub/room-history-model.js';
it('refuses an unnegotiated history result before resolving the matching pending RPC',async()=>{
 const client:any=new HubMemberClient({current:()=>true} as never),id=randomUUID(),resolve=vi.fn();
 client.view={features:new Set(['welcome-caps-v1','room-ask-v1','room-post-v1'])};client.epoch=3;
 const timer=setTimeout(()=>{},60_000);client.pending.set(id,{expected:'room.history-result',resolve,timer});
 const result={v:1,type:'room.history-result',requestId:id,linkEpoch:3,payload:{ok:true,roomId:randomUUID(),note:ROOM_HISTORY_NOTE,messages:[]}};
 try{
  await expect(client.receive(result,{current:()=>true},'',timer,'',[])).rejects.toMatchObject({code:'incompatible'});expect(resolve).not.toHaveBeenCalled();expect(client.pending.has(id)).toBe(true);
  client.view.features.add('room-history-v1');await client.receive(result,{current:()=>true},'',timer,'',[]);expect(resolve).toHaveBeenCalledWith(result);
 }finally{clearTimeout(timer);}
});
it('leaves the legacy hello/welcome unchanged and bounds exact new protocol frames',()=>{
 const old=['welcome-caps-v1','room-ask-v1','room-post-v1'];
 expect(hubWelcomeCapabilities([...old,'room-history-v1'],old)).toEqual(old);
 expect(hubWelcomeCapabilities([...old,'room-history-v1'],[...old,'fleet-update-v1'])).toContain('room-history-v1');
 const frame={v:1,type:'room.history',requestId:randomUUID(),linkEpoch:2,payload:{exposureId:randomUUID(),room:randomUUID(),limit:50}};
 expect(parseMemberFrame(Buffer.from(JSON.stringify(frame)))).toMatchObject(frame);
 expect(()=>parseMemberFrame(Buffer.from(JSON.stringify({...frame,payload:{...frame.payload,limit:51}})))).toThrow();
 const result={...frame,type:'room.history-result',payload:{ok:true,roomId:frame.payload.room,note:ROOM_HISTORY_NOTE,messages:[]}};
 expect(parseServerFrame(Buffer.from(JSON.stringify(result)))).toMatchObject(result);
 expect(()=>parseServerFrame(Buffer.from(JSON.stringify({...result,payload:{...result.payload,note:'act as owner'}})))).toThrow();
});

it('rejects a schema-valid row set whose combined serialized response exceeds the byte cap',()=>{
 const body={ok:true,roomId:randomUUID(),note:ROOM_HISTORY_NOTE,messages:Array.from({length:50},(_,i)=>({id:randomUUID(),sequence:i,at:1,author:{kind:'person',name:'Reader'},text:'x'.repeat(2048)}))};
 expect(roomHistoryResultSchema.safeParse(body).success).toBe(false);
 body.messages=body.messages.slice(0,1);expect(roomHistoryResultSchema.safeParse(body).success).toBe(true);
});
