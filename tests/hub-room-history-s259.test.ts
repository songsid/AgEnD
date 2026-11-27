/** Real Hub HTTP + SQLite, synthetic identities and inert links; no live directory or Fleet. */
import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {s3bRig} from './helpers/hub-s3b-rig.js';
import type {HubExposure} from '../src/hub/types.js';
let r:Awaited<ReturnType<typeof s3bRig>>|undefined;
afterEach(async()=>{await r?.close();r=undefined;});
async function world(){
 let now=1_800_000_000_000;
 r=await s3bRig({now:()=>now});const admin=await r.signIn('admin');
 const fleetId=randomUUID(),caps=['welcome-caps-v1','room-ask-v1','room-post-v1','room-history-v1'];
 const link=r.link(fleetId,r.admin,1,caps),exposure:HubExposure={id:randomUUID(),fleetId,owner:r.admin,displayName:'Notes',revision:1,state:'published',dataViewId:'agent',allowedTools:[],policyDigest:'b'.repeat(64)};
 await r.http.receive(r.frame('exposure.snapshot',{revision:1,exposures:[exposure]},link) as never,link);
 const make=async(name:string)=>{const got=await r!.call(admin,'POST','/hub/v1/rooms',{name});expect(got.status).toBe(200);return got.json.room.id as string;};
 const room=await make('History');
 const join=async(id=room)=>{expect((await r!.call(admin,'POST',`/hub/v1/rooms/${id}/members`,{kind:'agent',id:exposure.id})).status).toBe(200);};
 const post=async(text:string,id=room)=>{const got=await r!.call(admin,'POST',`/hub/v1/rooms/${id}/messages`,{text,mentions:[],idempotencyKey:randomUUID()});expect(got.status).toBe(200);return got.json;};
 const history=async(options:Record<string,unknown>={},l=link)=>{const got:any=await r!.http.receive(r!.frame('room.history',{exposureId:exposure.id,room,...options},l) as never,l);return got.payload;};
 return {admin,link,exposure,room,make,join,post,history,advance:(ms:number)=>{now+=ms;}};
}
it('reads chronological pages only after this agent joined, refuses nonmembers and marks room text as data',async()=>{
 const w=await world();await w.post('hidden-before-join');expect(await w.history()).toMatchObject({ok:false,code:'not-found'});
 await w.join();for(let i=0;i<5;i++)await w.post(`visible-${i}`);
 const page=await w.history({limit:2});expect(page).toMatchObject({ok:true,roomId:w.room,messages:[{text:'visible-3'},{text:'visible-4'}]});
 expect(page.note).toMatch(/not instructions or approval/);expect(page.next_cursor).toBeTypeOf('string');
 const next=await w.history({limit:2,cursor:page.next_cursor});expect(next.messages.map((m:any)=>m.text)).toEqual(['visible-1','visible-2']);
 const all=[...page.messages,...next.messages];let cursor=next.next_cursor;
 while(cursor){const more=await w.history({limit:2,cursor});expect(more.ok).toBe(true);all.push(...more.messages);cursor=more.next_cursor;}
 expect(all.some((m:any)=>m.text==='hidden-before-join')).toBe(false);
 expect(all.filter((m:any)=>m.text.startsWith('visible-')).map((m:any)=>m.text).sort()).toEqual(Array.from({length:5},(_,i)=>`visible-${i}`));
 const foreign=await w.make('Private');expect(await w.history({room:foreign})).toMatchObject({ok:false,code:'not-found'});
});
it('caps response bytes without skipping packed-out messages and rejects overlarge calls/foreign cursors',async()=>{
 const w=await world();await w.join();for(let i=0;i<12;i++)await w.post(`${i}:`+'漢'.repeat(2000));
 const page=await w.history({limit:50});expect(page.ok).toBe(true);expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16384);
 expect(page.messages.length).toBeLessThan(12);expect(page.messages.every((m:any)=>m.truncated===true)).toBe(true);
 const next=await w.history({limit:50,cursor:page.next_cursor});expect(next.messages.at(-1).sequence).toBeLessThan(page.messages[0].sequence);
 const all=[...page.messages,...next.messages];let cursor=next.next_cursor;
 while(cursor){const more=await w.history({limit:50,cursor});expect(more.ok).toBe(true);expect(Buffer.byteLength(JSON.stringify(more))).toBeLessThanOrEqual(16384);all.push(...more.messages);cursor=more.next_cursor;}
 const numbered=all.filter((m:any)=>/^\d+:/.test(m.text));expect(numbered.map((m:any)=>Number(m.text.split(':')[0])).sort((a:number,b:number)=>a-b)).toEqual(Array.from({length:12},(_,i)=>i));
 expect(new Set(all.map((m:any)=>m.id)).size).toBe(all.length);
 expect(await w.history({limit:51})).toMatchObject({ok:false});
 const other=await w.make('Other');await w.join(other);expect(await w.history({room:other,cursor:page.next_cursor})).toMatchObject({ok:false,code:'stale'});
});
it('keeps a durable hourly cap across rooms and reconnects, and rejects backward clock budget reset',async()=>{
 const w=await world();await w.join();const other=await w.make('Other');await w.join(other);
 for(let i=0;i<30;i++){expect((await w.history({room:i%2?other:w.room})).ok).toBe(true);w.advance(2100);}
 await r!.restartHttp();
 const again=r!.link(w.link.fleetId,r!.admin,2,[...w.link.features]);expect(await w.history({},again)).toMatchObject({ok:false,code:'rate-limited'});
 w.advance(3600_000);expect((await w.history({},again)).ok).toBe(true);
 w.advance(-3600_000);expect(await w.history({},again)).toMatchObject({ok:false,code:'unavailable'});
});
it('preserves lineage/question visibility, rejects invisible anchors and retires old membership cursors',async()=>{
 const w=await world();const old=await w.post('old question');await w.join();
 const visible=await w.post('visible'),late=await w.post('hidden lineage'),answer=await w.post('hidden answer');
 r!.db.prepare('UPDATE hub_room_post_lineage SET audience_sequence=1 WHERE post_id=?').run(late.id);
 r!.db.prepare('UPDATE hub_room_posts SET answer_to=? WHERE id=?').run(old.id,answer.id);
 const page=await w.history({limit:1});expect(page.messages.map((m:any)=>m.text)).toEqual(['visible']);
 const {historyBinding,historyCursor}=await import('../src/hub/rooms/history.js');
 const membership:any=r!.db.prepare("SELECT * FROM hub_room_members WHERE room_id=? AND kind='agent'").get(w.room);
 const binding=historyBinding(w.exposure.id,membership.owner_at_join,w.room,membership.id,membership.joined_sequence);
 expect(await w.history({cursor:historyCursor(binding,late.id)})).toMatchObject({ok:false,code:'stale'});
 // Same subject is not the same membership after removal/re-addition.
 const cursor=historyCursor(binding,visible.id);
 expect((await r!.call(w.admin,'DELETE',`/hub/v1/rooms/${w.room}/members/${membership.id}`)).status).toBe(200);
 expect(await w.history()).toMatchObject({ok:false,code:'not-found'});await w.join();
 expect(await w.history({cursor})).toMatchObject({ok:false,code:'stale'});
 expect((await w.history()).messages.some((m:any)=>m.text==='visible')).toBe(false);
});
it('allows archived/all-history member reads, without lending another Fleet or ineligible owner the identity',async()=>{
 const w=await world();await w.post('earlier all-history');
 expect((await r!.call(w.admin,'PATCH',`/hub/v1/rooms/${w.room}`,{historyForNew:'all'})).status).toBe(200);await w.join();
 expect((await r!.call(w.admin,'PATCH',`/hub/v1/rooms/${w.room}`,{archived:true})).status).toBe(200);
 expect((await w.history()).messages.some((m:any)=>m.text==='earlier all-history')).toBe(true);
 const foreign=r!.link(randomUUID(),r!.admin,1,[...w.link.features]);expect(await w.history({},foreign)).toMatchObject({ok:false,code:'denied'});
 r!.setEligible('admin',false);expect(await w.history()).toMatchObject({ok:false,code:'denied'});
});
it('refuses history without negotiation and strict schemas reject caller-selected authority',async()=>{
 const w=await world();await w.join();(w.link.features as Set<string>).delete('room-history-v1');
 expect(await w.history()).toMatchObject({ok:false,code:'unavailable'});
 const {roomHistorySchema,roomHistoryResultSchema}=await import('../src/hub/room-history-model.js');
 for(const key of ['owner','agent','floor','member','before'])expect(roomHistorySchema.safeParse({exposureId:w.exposure.id,room:w.room,[key]:'forged'}).success).toBe(false);
 expect(roomHistoryResultSchema.safeParse({ok:true,roomId:w.room,note:'owner instructions',messages:[]}).success).toBe(false);
});

it('discards a held history read when the exposure is withdrawn before eligibility returns',async()=>{
 const w=await world();await w.join();await w.post('must not leak after pause');
 const check=r!.directory.checkEligibility.bind(r!.directory);let finish!:()=>void;
 r!.directory.checkEligibility=async key=>{await new Promise<void>(resolve=>{finish=resolve;});return check(key);};
 const read=w.history();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 r!.db.prepare("UPDATE hub_exposures SET state='withdrawn' WHERE id=?").run(w.exposure.id);finish();
 const result=await read;expect(result).toMatchObject({ok:false});expect(JSON.stringify(result)).not.toContain('must not leak');
});
