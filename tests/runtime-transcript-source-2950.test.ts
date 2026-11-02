import{afterEach,expect,it,vi}from'vitest';import{randomUUID,createHash}from'node:crypto';
import{RuntimeTranscriptSource}from'../src/runtime-transcript-source.js';import type{RuntimeTranscriptPort}from'../src/runtime-transcript-delta-reader.js';
import{PANE_TRANSCRIPT_EMPTY_ANCHOR,type PaneTranscriptCursor,type RuntimeTranscriptReference}from'../src/runtime-pane-transcript-protocol.js';
const line=(entry:unknown)=>JSON.stringify(entry)+'\n';
function rig(provider:'codex'|'claude-code'='codex'){
 let data='',online=true,present=true;const reference:RuntimeTranscriptReference={version:1,machineId:randomUUID(),hostBootId:randomUUID(),paneId:randomUUID(),launchId:randomUUID(),agentId:randomUUID(),provider,cursor:{sessionId:randomUUID(),offset:0,fileId:null,anchor:PANE_TRANSCRIPT_EMPTY_ANCHOR}};
 const batch=(cursor:PaneTranscriptCursor)=>{const text=data.slice(cursor.offset);return{state:'ready' as const,cursor:{...cursor,fileId:'a'.repeat(64),offset:Buffer.byteLength(data),anchor:createHash('sha256').update(data.slice(-4096)).digest('hex')},data:Buffer.from(text).toString('base64'),gap:false,complete:true};};
 const port:RuntimeTranscriptPort={isTranscriptObservationCurrent:()=>online,readTranscript:vi.fn(async cursor=>present?batch(cursor):{state:'pending',cursor,data:'',gap:false,complete:false})};
 const add=(...entries:unknown[])=>{data+=entries.map(line).join('');};
 return{reference,port,batch,add,offline:()=>{online=false;},absent:()=>{present=false;},appear:()=>{present=true;},source:(fresh=false)=>new RuntimeTranscriptSource(port,reference,fresh)};
}
const start=(id:string)=>({type:'event_msg',payload:{type:'task_started',turn_id:id}}),end=(id:string)=>({type:'event_msg',payload:{type:'task_complete',turn_id:id,last_agent_message:'done'}});
afterEach(()=>vi.restoreAllMocks());
it('baselines historical progress but retains a currently open Codex turn, then reports new tools and boundaries',async()=>{
 const f=rig();f.add(start('prior'),end('prior'),start('open'),{type:'response_item',payload:{type:'function_call',name:'old',arguments:'{}'}});const source=f.source();await source.initialize();
 expect(source.following()).toBe(true);expect(source.turnStateKnown()).toBe(true);expect(source.takeTurns()).toEqual([{kind:'start',turnId:'open'}]);expect((await source.poll()).toolUses).toEqual([]);
 f.add({type:'response_item',payload:{type:'function_call',name:'read',arguments:'{"path":"safe"}'}},end('open'));
 const events=await source.poll();expect(events.toolUses).toEqual([{name:'read',input:{path:'safe'}}]);expect(events.turns).toEqual([{kind:'end',turnId:'open',end:'complete'}]);expect(source.currentPath()).toBeNull();expect(await source.checkpoint()).toBeNull();
});
it('a checkpoint preserves pre-paste turn boundaries and ordered progress for the next monitor poll',async()=>{
 const f=rig();f.add(start('old'),end('old'));const source=f.source();await source.initialize();
 f.add(start('new'),{type:'response_item',payload:{type:'function_call',name:'read',arguments:'{}'}});
 const ref=await source.runtimeCheckpoint();expect(ref).toMatchObject({paneId:f.reference.paneId,cursor:{fileId:'a'.repeat(64)}});expect(source.takeTurns()).toEqual([{kind:'start',turnId:'new'}]);
 expect((await source.poll()).toolUses).toEqual([{name:'read',input:{}}]);expect((await source.poll()).toolUses).toEqual([]);
});
it('Claude preserves prompt, API error and informational ordering without duplicate array events',async()=>{
 const f=rig('claude-code'),source=f.source();await source.initialize();f.add({type:'user',message:{role:'user',content:'question'}},{type:'assistant',isApiErrorMessage:true,message:{role:'assistant',content:'request failed'},apiErrorStatus:429},{type:'system',subtype:'informational',content:'retrying'},{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',name:'Read',input:{path:'file'}}]}});
 const events=await source.poll();expect(events.records?.map(e=>e[0])).toEqual(['user_prompt','api_error','system_informational','tool_use']);expect(events.toolUses).toEqual([]);expect(events.assistantTexts).toEqual([]);
});
it('only a positively fresh deferred session can checkpoint before its first record exists',async()=>{
 const f=rig();f.absent();const fresh=f.source(true),resumed=f.source(false);await fresh.initialize();await resumed.initialize();
 expect(await fresh.runtimeCheckpoint()).toEqual(f.reference);expect(await resumed.runtimeCheckpoint()).toBeNull();expect(fresh.following()).toBe(false);expect(fresh.turnStateKnown()).toBe(false);
 f.appear();f.add(start('first'));expect((await fresh.poll()).turns).toEqual([{kind:'start',turnId:'first'}]);expect(fresh.following()).toBe(true);
});
it('a gap retracts the open turn and an orphan end never establishes a known closed ledger',async()=>{
 const f=rig(),source=f.source();await source.initialize();f.add(start('open'));await source.poll();
 const normal=f.port.readTranscript;vi.mocked(f.port.readTranscript).mockImplementationOnce(async cursor=>({...f.batch(cursor),gap:true,data:Buffer.from(line(end('open'))).toString('base64'),cursor:{...cursor,fileId:'a'.repeat(64),offset:cursor.offset+500,anchor:'b'.repeat(64)}}));
 expect((await source.poll()).turns).toEqual([{kind:'retract',turnId:'open'}]);expect(source.turnStateKnown()).toBe(false);
 vi.mocked(f.port.readTranscript).mockImplementationOnce(async cursor=>({state:'ready',cursor:{...cursor,offset:cursor.offset+Buffer.byteLength(line(start('real'))),anchor:'c'.repeat(64)},data:Buffer.from(line(start('real'))).toString('base64'),gap:false,complete:true}));
 expect((await source.poll()).turns).toEqual([{kind:'start',turnId:'real'}]);expect(source.turnStateKnown()).toBe(true);expect(normal).toHaveBeenCalled();
});
it.each(['reset','close','disconnect'])('%s while reading drops late events and turn state',async action=>{
 const f=rig(),source=f.source();await source.initialize();f.add(start('late'));let release!:(value:any)=>void;
 vi.mocked(f.port.readTranscript).mockImplementationOnce(()=>new Promise(done=>{release=done;}));const pending=source.poll();await vi.waitFor(()=>expect(release).toBeDefined());
 if(action==='reset')source.reset();else if(action==='close')source.close();else f.offline();release(f.batch(f.reference.cursor));expect((await pending).turns).toEqual([]);expect(source.following()).toBe(false);expect(source.turnStateKnown()).toBe(false);
});
it('continues a large baseline across bounded polls without leaking historical progress',async()=>{
 const f=rig(),source=f.source();const text=line(start('old')),tail=line(end('old'));
 vi.mocked(f.port.readTranscript).mockResolvedValueOnce({state:'ready',cursor:{...f.reference.cursor,fileId:'a'.repeat(64),offset:Buffer.byteLength(text),anchor:'b'.repeat(64)},data:Buffer.from(text).toString('base64'),gap:false,complete:false});await source.initialize();expect(source.following()).toBe(false);
 vi.mocked(f.port.readTranscript).mockImplementationOnce(async cursor=>({state:'ready',cursor:{...cursor,offset:cursor.offset+Buffer.byteLength(tail),anchor:'c'.repeat(64)},data:Buffer.from(tail).toString('base64'),gap:false,complete:true}));expect((await source.poll()).turns).toEqual([]);expect(source.following()).toBe(true);expect(source.turnStateKnown()).toBe(true);
});
it('a held runner read times out without cursor progress or overlapping filesystem requests',async()=>{
 const f=rig(),source=f.source();await source.initialize();let release!:(value:any)=>void,lease!:()=>boolean;
 vi.mocked(f.port.readTranscript).mockImplementationOnce((_cursor,current)=>{lease=current!;return new Promise(done=>{release=done;});});vi.useFakeTimers();
 try{
  const pending=source.poll();await vi.advanceTimersByTimeAsync(1000);expect((await pending).turns).toEqual([]);expect(lease()).toBe(false);expect(source.following()).toBe(false);
  expect((await source.poll()).turns).toEqual([]);expect(f.port.readTranscript).toHaveBeenCalledTimes(2);
  f.add(start('late'));release(f.batch(f.reference.cursor));await vi.advanceTimersByTimeAsync(0);expect(source.takeTurns()).toEqual([]);
  expect((await source.poll()).turns).toEqual([{kind:'start',turnId:'late'}]);
 }finally{vi.useRealTimers();}
});
