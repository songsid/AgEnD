import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseMonitorMounts,readMonitorKernelFile,NativeHostMonitoring,type MonitorRunner} from '../src/host-monitoring-platform.js';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const mount=(i:number,path:string,type='ext4',source='/dev/sda',options='rw')=>`${i} 1 8:${i} / ${path} ${options} - ${type} ${source} rw`;
const table=[mount(1,'/'),mount(2,'/mnt/c','9p','C:\\'),mount(3,'/mnt/e','9p','E:\\'),...Array.from({length:150},(_,i)=>mount(i+4,`/fixture/mount-${i}`,'ext4','/dev/sda','rw,option='+'x'.repeat(200)))].join('\n')+'\n';
describe('bounded large kernel mount inventories',()=>{
 it('keeps a valid153-record inventory above32KiB, including root and Windows backing mounts',async()=>{
  expect(Buffer.byteLength(table)).toBeGreaterThan(32768);expect(Buffer.byteLength(table)).toBeLessThan(65536);const rows=parseMonitorMounts(table);expect(rows).toHaveLength(153);expect(rows.filter(m=>m.drive).map(m=>m.drive)).toEqual(['C','E']);
  const calls:string[][]=[];const run:MonitorRunner=(file,args)=>{calls.push([file,...args]);return{result:Promise.resolve(file.endsWith('.exe')?'E\n':'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda 100000 20000 80000 20% /\n'),stopped:Promise.resolve(),kill(){}};};
  const provider=new NativeHostMonitoring({platform:'wsl',statePath:'/state',memory:()=>({level:'unknown',memory:null,sampledAt:null,recovering:false,samples:0,trend:null}),readMounts:async()=>table,run});
  try{const flight=provider.disks();const result=await flight.result;await flight.stopped;expect(result?.backingDrive).toBe('identified');expect(result?.volumes.some(v=>v.roles.includes('state')&&v.availableBytes!==null)).toBe(true);expect(result?.volumes.find(v=>v.roles.includes('wsl-backing'))?.drive).toBe('E');expect(calls).toHaveLength(4);}finally{await provider.stop();}
 });
 it('reads only an explicit bounded kernel budget and refuses overflow',async()=>{
  const root=await mkdtemp(join(tmpdir(),'monitor-kernel-'));roots.push(root);const path=join(root,'mountinfo');await writeFile(path,table);
  const read=readMonitorKernelFile as (path:string,limit?:number)=>Promise<string|null>;
  expect(await read(path)).toBeNull();expect(await read(path,65536)).toBe(table);await writeFile(path,'x'.repeat(65537));expect(await read(path,65536)).toBeNull();expect(await read(path,1024**2)).toBeNull();
 });
 it('never truncates away a later overmount and then treats the root match as safe',()=>{
  const tooMany=[mount(1,'/'),...Array.from({length:512},(_,i)=>mount(i+2,`/p${i}`))].join('\n');expect(Buffer.byteLength(tooMany)).toBeLessThan(65536);expect(parseMonitorMounts(tooMany)).toEqual([]);expect(parseMonitorMounts('x'.repeat(65537))).toEqual([]);
 });
});
