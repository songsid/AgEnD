/** Admission replay for the measured floor-birth inputs against the final conservative age ceiling.
 * This is not a second resource measurement. It invokes the production binder and policy with captured numeric input.
 */
import {readFileSync,writeFileSync} from 'node:fs';import assert from 'node:assert/strict';
import {bindLinuxRootIdentities} from '../../../src/host-monitoring-process-identity.js';
import {FootprintAttribution,type FootprintProcess} from '../../../src/host-monitoring-footprint-policy.js';
const file=process.argv[2],hz=Number(process.argv[3]),out=process.argv[4];assert(file&&Number.isSafeInteger(hz)&&hz>0&&hz<=10000);
const frames=readFileSync(file,'utf8').split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(frame=>frame?.stage==='root-evidence');assert(frames.length>=59,'Full measured window required');
const aux=Buffer.alloc(32);aux.writeBigUInt64LE(17n);aux.writeBigUInt64LE(BigInt(hz),8);
const policy=new FootprintAttribution(),checks:any[]=[];
for(const [index,frame]of frames.entries()){
 assert.equal(frame.covered,1);assert.equal(frame.evidence.length,1);const input=frame.evidence[0];assert(Number.isSafeInteger(input.identity)&&Number.isSafeInteger(input.birth)&&input.birth%1000===0,'Captured floor-birth input required');
 const boot=input.birth/1000-Math.floor(input.identity/hz);assert(Number.isSafeInteger(boot)&&boot>=0);
 const root={id:'a'.repeat(16),pid:10,owner:'owned-measurement-helper',observedAt:input.observedAt};
 const process:FootprintProcess={pid:10,ppid:2,start:input.start,cpuMs:0,rssBytes:1024};
 const rejected=await bindLinuxRootIdentities([process],[root],()=>true,async path=>path==='/proc/self/auxv'?aux:path==='/proc/stat'?Buffer.from(`btime ${boot}\n`):path==='/proc/10/stat'?Buffer.from('10 (fixture) S 2 '+Array(17).fill('0').join(' ')+` ${input.identity} 0 0\n`):null);
 assert.equal(rejected.size,0);const actual=policy.sample([process],[root],99,input.wall,index*60000,6);assert.equal(actual.covered,1,'Final age/identity admission differs');checks.push({sample:index,admitted:true,birthMarginMs:root.observedAt-1000-process.birth!});
}
const result={scope:'Final production birth/identity admission replay over the recorded one-root numeric window; CPU/RSS/storage are the original real measurement, not remeasured here.',frames:frames.length,hz,allAdmitted:true,minimumMarginMs:Math.min(...checks.map(c=>c.birthMarginMs)),checks};if(out)writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify({frames:result.frames,hz,allAdmitted:true,minimumMarginMs:result.minimumMarginMs}));
