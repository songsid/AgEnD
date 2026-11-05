import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kiroEngineCandidates, kiroEngineStatus } from '../src/kiro-engine-status.js';
import { setLocale } from '../src/locale.js';
const homes:string[]=[];
afterEach(()=>{for(const p of homes.splice(0))rmSync(p,{recursive:true,force:true});setLocale('en')});
function status(fleet:any,classic?:any,name?:string){const agendHome=mkdtempSync(join(tmpdir(),'kiro3-readiness-'));homes.push(agendHome);return kiroEngineStatus(kiroEngineCandidates(fleet,classic),{agendHome,name,snapshot:()=>null}) as any;}
it.each(['en','zh-TW'] as const)('counts the whole fleet and Classic rooms even in a General-only query: %s',locale=>{
 setLocale(locale);const fleet={defaults:{backend:'kiro-cli',kiro_ui:'legacy'},instances:{general:{},moved:{kiro_ui:'tui'},v3:{kiro_ui:'v3'},notKiro:{backend:'claude-code'}}};
 const rooms={getAll:()=>[{instanceName:'classic-room',backend:'kiro-cli'}]};
 const s=status(fleet,rooms,'general');
 expect(s.instances).toHaveLength(1);expect(s.instances[0].kiro3_readiness).toMatchObject({ready:false,message:expect.stringContaining('migrate_kiro_instance')});
 expect(s.kiro3_readiness).toEqual({ready:false,total:4,still_classic:2,message:locale==='en'?'2 Kiro agents still use Classic.':'還有 2 個 Kiro Agent 使用 Classic。'});
 const all=status(fleet,rooms);const room=all.instances.find((i:any)=>i.name==='classic-room');
 expect(room.kiro3_readiness.ready).toBe(false);expect(room.kiro3_readiness.message).not.toContain('migrate_kiro_instance');
 expect(room.kiro3_readiness.message).toContain(locale==='en'?"this Classic room can't be migrated by AgEnD":'這個 Classic 房間無法由 AgEnD 遷移');
 expect(all.instances.find((i:any)=>i.name==='moved').kiro3_readiness).toEqual({ready:true,message:locale==='en'?'No Classic migration required.':'不需要進行 Classic 遷移。'});
});
it('reports non-Classic readiness separately from whether a CLI was probed',()=>{
 const s=status({defaults:{backend:'kiro-cli',kiro_ui:'tui'},instances:{general:{},v3:{kiro_ui:'v3'}}});
 expect(s.kiro3_readiness).toEqual({ready:true,total:2,still_classic:0,message:'All Kiro agents have completed Classic migration.'});
 expect(s.instances[0].next_launch).toHaveProperty('unknown');
});
it('zero Kiro agents does not invent a migrated agent',()=>{
 expect(status({instances:{general:{backend:'claude-code'}}}).kiro3_readiness).toEqual({ready:true,total:0,still_classic:0,message:'No Kiro agents.'});
});
