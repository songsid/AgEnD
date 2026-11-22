import {open} from 'node:fs/promises';
import {endianness} from 'node:os';
import type {FootprintProcess,FootprintRoot} from './host-monitoring-footprint-policy.js';
export type IdentityRead=(path:string,limit:number)=>Promise<Buffer|null>;
/** Exact kernel files only. Outstanding reads and descriptor closes remain owned until settled. */
export const readIdentityFile:IdentityRead=async(path,limit)=>{
 let file;
 try{file=await open(path,'r');const buffer=Buffer.alloc(limit+1);let size=0;while(size<buffer.length){const next=await file.read(buffer,size,buffer.length-size,null);if(!next.bytesRead)return buffer.subarray(0,size);size+=next.bytesRead;}return null;}
 catch{return null;}finally{await file?.close();}
};
export function linuxClockTicks(auxv:Buffer|null,width=process.arch==='ia32'||process.arch==='arm'?4:8,big=endianness()==='BE'):number|null{
 if(!auxv||auxv.length>8192||![4,8].includes(width)||auxv.length%(width*2)!==0)return null;
 const word=(at:number)=>width===8?Number(big?auxv.readBigUInt64BE(at):auxv.readBigUInt64LE(at)):big?auxv.readUInt32BE(at):auxv.readUInt32LE(at);
 for(let at=0;at<auxv.length;at+=width*2){const type=word(at),value=word(at+width);if(type===0)return null;if(type===17)return Number.isSafeInteger(value)&&value>0&&value<=10000?value:null;}
 return null;
}
export function linuxStartTicks(buffer:Buffer|null,pid:number,ppid:number):number|null{
 if(!buffer||buffer.length>4096)return null;const text=buffer.toString('utf8'),header=/^(\d+) \(/.exec(text),close=text.lastIndexOf(') ');if(!header||Number(header[1])!==pid||close<0)return null;
 const fields=text.slice(close+2).trim().split(/\s+/),ticks=Number(fields[19]);
 return fields.length>=20&&Number(fields[1])===ppid&&/^\d+$/.test(fields[19])&&Number.isSafeInteger(ticks)&&ticks>0?ticks:null;
}
/** ps lstart is an epoch presentation, not a stable Linux identity across boot-epoch adjustments. */
export async function bindLinuxRootIdentities(processes:FootprintProcess[],roots:FootprintRoot[],active=()=>true,read:IdentityRead=readIdentityFile):Promise<Set<number>>{
 const pids=[...new Set(roots.map(r=>r.pid).filter(pid=>Number.isSafeInteger(pid)&&pid>1))];
 if(pids.length>128)throw Error('root_limit');const rejected=new Set(pids);if(!active()||!pids.length)return rejected;
 const [auxv,stat]=await Promise.all([read('/proc/self/auxv',8192),read('/proc/stat',65536)]);
 const hz=linuxClockTicks(auxv),match=stat&&/^btime (\d+)$/m.exec(stat.toString('utf8')),boot=match?Number(match[1])*1000:NaN;
 if(!hz||!Number.isSafeInteger(boot)||boot<0||!active())return rejected;
 const rows=new Map(processes.map(row=>[row.pid,row]));let cursor=0;
 await Promise.all(Array.from({length:Math.min(8,pids.length)},async()=>{
  while(active()&&cursor<pids.length){const pid=pids[cursor++],row=rows.get(pid);if(!row)continue;
   const ticks=linuxStartTicks(await read(`/proc/${pid}/stat`,4096),pid,row.ppid);if(ticks===null)continue;
   // btime has whole-second precision and start ticks lose at most one tick.
   // Use a ceiling for the age fence; never make a newer process look older.
   const birth=Math.ceil(boot+(ticks+1)/hz*1000+1000);if(!Number.isSafeInteger(birth))continue;
   row.identity=ticks;row.birth=birth;rejected.delete(pid);
  }
 }));return rejected;
}
