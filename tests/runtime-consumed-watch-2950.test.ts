import{afterEach,expect,it,vi}from'vitest';import{performance}from'node:perf_hooks';import*as fs from'node:fs/promises';
vi.mock('node:fs/promises',()=>({stat:vi.fn(async()=>{throw Error('No local provider store');}),open:vi.fn(async()=>{throw Error('No local provider store');})}));
import{ConsumedWatch,ConsumedWatchRegistry,CONSUMED_WATCH}from'../src/delivery-consumed-watch.js';import type{TranscriptLook}from'../src/transcript-delta-reader.js';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function rig(){let position=0,current=true;const reader={look:vi.fn(async():Promise<TranscriptLook>=>'no-match'),get readPosition(){return position;},close:vi.fn()},consumed=vi.fn(),end=vi.fn();const target={deliveryId:'owned-delivery',attemptNo:1,backend:'codex',reader,current:()=>current,consumed};const watch=new ConsumedWatch(target,end);return{watch,target,reader,consumed,end,move:()=>position+=32,fence:()=>{current=false;}};}
it.each(['user','absorbed']as const)('records native %s proof without opening any local file',async kind=>{
 const f=rig();const read=vi.mocked(fs.stat);read.mockClear();f.reader.look.mockResolvedValueOnce(kind);await f.watch.look();expect(f.consumed).toHaveBeenCalledExactlyOnceWith(kind==='user'?'turn':'mid_turn',kind==='user'?'transcript-consumed:user-entry':'transcript-consumed:absorbed-mid-turn');expect(read).not.toHaveBeenCalled();expect(f.end).toHaveBeenCalledWith('consumed');expect(f.reader.close).toHaveBeenCalledOnce();
});
it('queue acceptance stays unconsumed until a later real user record',async()=>{
 const f=rig();vi.useFakeTimers();f.reader.look.mockImplementationOnce(async()=>{f.move();return'queued';});f.reader.look.mockResolvedValueOnce('user');await f.watch.look();expect(f.consumed).not.toHaveBeenCalled();expect(f.watch.position).toBe(32);await vi.advanceTimersByTimeAsync(CONSUMED_WATCH.catchUpMs);expect(f.consumed).toHaveBeenCalledOnce();
});
it.each(['fence','stop','expired']as const)('a native result after %s cannot settle the row',async kind=>{
 const f=rig();let release!:(value:TranscriptLook)=>void;f.reader.look.mockImplementationOnce(()=>new Promise(done=>{release=done;}));const pending=f.watch.look();
 if(kind==='fence')f.fence();else if(kind==='stop')f.watch.stop();else vi.spyOn(performance,'now').mockReturnValue(performance.now()+CONSUMED_WATCH.lifetimeMs+100);
 release('user');await pending;expect(f.consumed).not.toHaveBeenCalled();expect(f.end).toHaveBeenCalledWith(kind==='fence'?'fenced':kind==='stop'?'stopped':'expired');expect(f.reader.close).toHaveBeenCalledOnce();
});
it('unavailable evidence ends quietly and repeated no-growth backs off within the existing fleet-wide cap',async()=>{
 const f=rig();f.reader.look.mockResolvedValueOnce('unavailable');await f.watch.look();expect(f.end).toHaveBeenCalledWith('unavailable');expect(f.consumed).not.toHaveBeenCalled();vi.useFakeTimers();
 const idle=rig();for(let n=0;n<CONSUMED_WATCH.idleLooksBeforeBackoff;n++)await idle.watch.look();expect(idle.watch.currentInterval).toBe(CONSUMED_WATCH.tickMs*2);idle.watch.stop();
 const registry=new ConsumedWatchRegistry();for(let n=0;n<CONSUMED_WATCH.maxWatchers;n++)expect(registry.start({...rig().target,deliveryId:`delivery-${n}`})).toBe(true);expect(registry.start({...rig().target,deliveryId:'overflow'})).toBe(false);registry.stopAll();expect(registry.size).toBe(0);
});
