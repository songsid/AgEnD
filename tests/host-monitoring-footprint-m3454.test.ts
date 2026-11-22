import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostFootprint} from '../src/host-monitoring-footprint.js';
const at=Date.UTC(2026,10,21,15),id='a'.repeat(16),root={id,pid:10,owner:'one',observedAt:at-10000,files:[]as string[]};
const row='10 2 12 00:00:01 Sat Nov 21 14:00:00 2026';
const settle=async()=>{for(let n=0;n<30;n++)await Promise.resolve()};
afterEach(()=>vi.useRealTimers());
describe('optional single-flight process sampler',()=>{
 it('does no work while off, samples only once per minute, and page reads are pure',async()=>{
  vi.useFakeTimers();const runner=vi.fn(()=>({result:Promise.resolve(row),stopped:Promise.resolve(),cancel:vi.fn()})),roots=vi.fn(()=>[root]);
  const sampler=new HostFootprint({runner,roots,now:()=>at,logicalCpus:()=>4});
  sampler.configure(false);await vi.advanceTimersByTimeAsync(120000);expect(runner).not.toHaveBeenCalled();expect(roots).not.toHaveBeenCalled();
  sampler.configure(true);await settle();expect(sampler.snapshot()).toMatchObject({enabled:true,status:'ok',reading:{covered:1}});for(let n=0;n<100;n++)sampler.snapshot();expect(runner).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60000);expect(runner).toHaveBeenCalledTimes(2);await sampler.stop();await vi.advanceTimersByTimeAsync(120000);expect(runner).toHaveBeenCalledTimes(2);expect(vi.getTimerCount()).toBe(0);
 });
 it('holds physical ownership across timeout and off/on; old output cannot publish',async()=>{
  vi.useFakeTimers();let finish!:(s:string)=>void,closed!:()=>void;const cancel=vi.fn(),runner=vi.fn(()=>({result:new Promise<string>(r=>finish=r),stopped:new Promise<void>(r=>closed=r),cancel}));
  const sampler=new HostFootprint({roots:()=>[root],runner,now:()=>at,logicalCpus:()=>4});sampler.configure(true);await vi.advanceTimersByTimeAsync(2000);expect(cancel).toHaveBeenCalledOnce();
  sampler.configure(false);sampler.configure(true);await vi.advanceTimersByTimeAsync(180000);expect(runner).toHaveBeenCalledOnce();finish(row);await settle();expect(sampler.snapshot().reading).toBeNull();closed();await settle();expect(runner).toHaveBeenCalledTimes(2);
  sampler.configure(false);finish(row);closed();await settle();await sampler.stop();
 });
 it('holds the flight until pending kernel identity reads drain across off/on',async()=>{
  vi.useFakeTimers();let finish!:(value:Set<number>)=>void;const identities=vi.fn(()=>new Promise<Set<number>>(r=>finish=r)),runner=vi.fn(()=>({result:Promise.resolve(row),stopped:Promise.resolve(),cancel(){}}));
  const sampler=new HostFootprint({roots:()=>[root],runner,identities,now:()=>at,logicalCpus:()=>4});sampler.configure(true);await settle();expect(identities).toHaveBeenCalledOnce();sampler.configure(false);sampler.configure(true);await vi.advanceTimersByTimeAsync(180000);expect(runner).toHaveBeenCalledOnce();finish(new Set());await settle();expect(runner).toHaveBeenCalledTimes(2);sampler.configure(false);finish(new Set());await settle();await sampler.stop();
 });
 it('refuses over-cap inventory, changed root ownership, and malformed output',async()=>{
  vi.useFakeTimers();const runner=vi.fn(()=>({result:Promise.resolve('bad'),stopped:Promise.resolve(),cancel(){}}));let roots=[root];
  const sampler=new HostFootprint({runner,roots:()=>roots,now:()=>at,logicalCpus:()=>4});sampler.configure(true);await settle();expect(sampler.snapshot().status).toBe('unavailable');
  roots=Array.from({length:129},()=>root);await vi.advanceTimersByTimeAsync(60000);expect(runner).toHaveBeenCalledOnce();expect(sampler.snapshot().reason).toBe('root_limit');await sampler.stop();
 });
 it('counts exact known regular files only and refuses symlinks; never scans a workspace',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'footprint-'));try{
   const file=join(dir,'output.log');await writeFile(file,'hello');await symlink(file,join(dir,'link'));
   let changed!:()=>void;const result=new Promise<void>(r=>changed=r);const sampler=new HostFootprint({roots:()=>[{...root,files:[file]}],runner:()=>({result:Promise.resolve(row),stopped:Promise.resolve(),cancel(){}}),now:()=>at,logicalCpus:()=>4,changed});
   sampler.configure(true);await result;expect(sampler.snapshot().reading!.rows[0].managedBytes).toBe(5);await sampler.stop();
   let done!:()=>void;const next=new Promise<void>(r=>done=r);const symlinked=new HostFootprint({roots:()=>[{...root,files:[join(dir,'link')]}],runner:()=>({result:Promise.resolve(row),stopped:Promise.resolve(),cancel(){}}),now:()=>at,logicalCpus:()=>4,changed:done});symlinked.configure(true);await next;expect(symlinked.snapshot().reading!.rows[0].managedBytes).toBeNull();await symlinked.stop();
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
