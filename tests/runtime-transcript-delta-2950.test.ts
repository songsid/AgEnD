import {afterEach,expect,it,vi}from'vitest';
import{randomUUID,createHash}from'node:crypto';
import{RuntimeTranscriptDeltaReader,decodeRuntimeTranscriptBatch,type RuntimeTranscriptPort}from'../src/runtime-transcript-delta-reader.js';
import{PANE_TRANSCRIPT_EMPTY_ANCHOR,type RuntimeTranscriptReference,type PaneTranscriptCursor}from'../src/runtime-pane-transcript-protocol.js';
afterEach(()=>vi.useRealTimers());
const line=(entry:unknown)=>JSON.stringify(entry)+'\n';
function rig(provider:'codex'|'claude-code'='codex'){
 const reference:RuntimeTranscriptReference={version:1,machineId:randomUUID(),hostBootId:randomUUID(),paneId:randomUUID(),launchId:randomUUID(),agentId:randomUUID(),provider,cursor:{sessionId:randomUUID(),offset:0,fileId:null,anchor:PANE_TRANSCRIPT_EMPTY_ANCHOR}};
 const delivery=randomUUID(),marker=`[agend-delivery-id:${delivery}] payload`;let online=true;
 const port:RuntimeTranscriptPort={isTranscriptObservationCurrent:()=>online,readTranscript:vi.fn()};
 const batch=(text:string,before=reference.cursor,gap=false)=>({state:'ready',cursor:{...before,offset:before.offset+Buffer.byteLength(text),fileId:'a'.repeat(64),anchor:createHash('sha256').update(text).digest('hex')},data:Buffer.from(text).toString('base64'),gap,complete:true});
 return{reference,port,delivery,marker,batch,offline:()=>{online=false;},reader:()=>new RuntimeTranscriptDeltaReader(port,reference,delivery)};
}
it.each(['codex','claude-code']as const)('%s proves its own consumed user marker but never returned or quoted content',async provider=>{
 const f=rig(provider),owned=provider==='codex'?{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:f.marker}]}}:{type:'user',message:{role:'user',content:f.marker}};
 for(const record of [owned,{...owned,...(provider==='codex'?{payload:{...(owned as any).payload,role:'assistant'}}:{type:'assistant',message:{role:'assistant',content:f.marker}})},provider==='codex'?{type:'response_item',payload:{type:'function_call_output',output:f.marker}}:{type:'user',message:{role:'user',content:[{type:'tool_result',content:f.marker}]}}]){
  vi.mocked(f.port.readTranscript).mockResolvedValueOnce(f.batch(line(record))as any);expect(await f.reader().look()).toBe(record===owned?'user':'no-match');
 }
});
it.each(['queued','absorbed']as const)('shares the exact Claude %s proof grammar',async kind=>{
 const f=rig('claude-code'),record=kind==='queued'?{type:'queue-operation',operation:'enqueue',content:f.marker}:{type:'attachment',attachment:{type:'queued_command',prompt:f.marker}};
 vi.mocked(f.port.readTranscript).mockResolvedValue(f.batch(line(record))as any);expect(await f.reader().look()).toBe(kind);
});
it('supports exact raw-text proof without accepting a tool response',async()=>{
 const f=rig(),text='plain message',reader=new RuntimeTranscriptDeltaReader(f.port,f.reference,{rawText:text});
 vi.mocked(f.port.readTranscript).mockResolvedValue(f.batch(line({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}))as any);expect(await reader.look()).toBe('user');
});
it('a timeout drops the late result, starts no overlapping read and never advances its cursor',async()=>{
 const f=rig(),reader=f.reader();let release!:(value:any)=>void,lease!:()=>boolean;
 vi.mocked(f.port.readTranscript).mockImplementation((_cursor,current)=>{lease=current!;return new Promise(done=>{release=done;});});vi.useFakeTimers();
 const first=reader.look();await vi.advanceTimersByTimeAsync(250);expect(await first).toBe('pending');expect(lease()).toBe(false);expect(await reader.look()).toBe('pending');expect(f.port.readTranscript).toHaveBeenCalledOnce();
 release(f.batch(line({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:f.marker}]}})));await vi.advanceTimersByTimeAsync(0);expect(reader.readPosition).toBe(0);
 vi.mocked(f.port.readTranscript).mockResolvedValue({state:'pending',cursor:f.reference.cursor,data:'',gap:false,complete:false});expect(await reader.look()).toBe('pending');expect(reader.readPosition).toBe(0);
});
it.each(['disconnect','close'])('a %s during a read drops its positive result',async kind=>{
 const f=rig(),reader=f.reader();let release!:(value:any)=>void;vi.mocked(f.port.readTranscript).mockImplementation(()=>new Promise(done=>{release=done;}));
 const pending=reader.look();if(kind==='disconnect')f.offline();else reader.close();
 release(f.batch(line({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:f.marker}]}})));expect(await pending).toBe('unavailable');expect(reader.readPosition).toBe(0);
});
it('never turns an explicit record gap into absence, while a later full user marker is positive',async()=>{
 const f=rig(),reader=f.reader();const first=f.batch(line({type:'event_msg',payload:{type:'task_complete',turn_id:'unproven'}}),undefined,true);
 vi.mocked(f.port.readTranscript).mockResolvedValueOnce(first as any);expect(await reader.look()).toBe('unavailable');
 const next=f.batch(line({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:f.marker}]}}),first.cursor);
 vi.mocked(f.port.readTranscript).mockResolvedValueOnce(next as any);expect(await reader.look()).toBe('user');
});
it.each(['foreign-session','changed-file','regression','invented-offset','partial-line','invalid-json','bad-utf8','pending-advance'])('refuses %s without advancing the checkpoint',async kind=>{
 const f=rig(),before:PaneTranscriptCursor={...f.reference.cursor,fileId:'a'.repeat(64),offset:1,anchor:'b'.repeat(64)},reference={...f.reference,cursor:before},reader=new RuntimeTranscriptDeltaReader(f.port,reference,f.delivery),value:any=f.batch(line({safe:true}),before);
 if(kind==='foreign-session')value.cursor.sessionId=randomUUID();if(kind==='changed-file')value.cursor.fileId='c'.repeat(64);if(kind==='regression')value.cursor.offset=0;if(kind==='invented-offset')value.cursor.offset++;
 if(kind==='partial-line'||kind==='invalid-json'||kind==='bad-utf8'){
  const data=kind==='partial-line'?Buffer.from('{}'):kind==='invalid-json'?Buffer.from('private-not-json\n'):Buffer.from([255,10]);value.data=data.toString('base64');value.cursor.offset=before.offset+data.length;
 }
 if(kind==='pending-advance'){value.state='pending';value.data='';value.complete=false;}
 vi.mocked(f.port.readTranscript).mockResolvedValue(value);expect(await reader.look()).toBe('unavailable');expect(reader.readPosition).toBe(1);
});
it('rejects incomplete UTF8 and future-proof non-record JSON on the pure wire decoder',()=>{
 const f=rig();expect(()=>decodeRuntimeTranscriptBatch(f.batch('[]\n'),f.reference.cursor)).toThrow('non-record');
});
