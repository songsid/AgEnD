// Semantic regressions must compile and fail an assertion; source is restored even after a failed probe.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const panel='src/ui/panel-fleet.js',css='src/ui/shared/app.css';
const tabTest=['node_modules/vitest/vitest.mjs','run','tests/fleet-tabs-header-2542.test.ts','--maxWorkers=1'];
const browser=['node_modules/tsx/dist/cli.mjs','scripts/manual/smoke/smoke-2556-memory-header.mts'];
const cases=[
 ['warning-visible',panel,'el.querySelector?.(".host-mem") ? w(el) : natural(el)','natural(el)',tabTest],
 ['heading-natural',panel,'? w(el) : natural(el)','? w(el) : w(el)',tabTest],
 ['full-tooltip',panel,'class="host-mem-top" title=${top}','class="host-mem-top"', ['node_modules/vitest/vitest.mjs','run','tests/memory-hogs-2015.test.ts','-t','the Fleet page','--maxWorkers=1']],
 ['clip-process-text',css,'.p-fleet .host-mem-top[title] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }','.p-fleet .host-mem-top[title] { text-overflow: ellipsis; white-space: nowrap; }',browser],
 ['cached-css',panel,'if (rev === undefined || rev.trim() === "1") return;','if (true) return;',browser],
];
const out='.artifacts/fleet-memory-mutations';mkdirSync(out,{recursive:true});const results=[];
const selected=process.argv.length>2?cases.filter(([name])=>process.argv.slice(2).includes(name)):cases;
const previous=process.argv.length>2&&existsSync(`${out}/results.json`)?JSON.parse(readFileSync(`${out}/results.json`,'utf8')):[];
let restore=()=>{};for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{restore();process.exit(143);});
for(const[name,path,before,after,args]of selected){
 const original=readFileSync(path,'utf8');if(original.split(before).length!==2)throw Error(`${name}: expected one target`);
 restore=()=>writeFileSync(path,original);
 try{
  writeFileSync(path,original.replace(before,after));
  const c=spawnSync('npx',['--no-install','tsc','--noEmit','--pretty','false'],{encoding:'utf8',timeout:120000});
  writeFileSync(`${out}/${name}.compile.log`,(c.stdout??'')+(c.stderr??''));let status='INVALID_BUILD';
  if(!c.error&&c.status===0){
   const t=spawnSync(process.execPath,args,{encoding:'utf8',timeout:120000,env:{...process.env,REPO:process.cwd(),MODES:name==='cached-css'?'old-css':'after',WIDTHS:'900',LANGS:'en',OUT:`${out}/${name}`}});
   const log=(t.stdout??'')+(t.stderr??'');writeFileSync(`${out}/${name}.test.log`,log);
   status=!t.error&&t.status!==null&&t.status!==0&&/AssertionError/.test(log)&&!/Transform failed|No test files found/.test(log)?'KILLED':'SURVIVED_OR_INVALID';
  }
  results.push({name,status});console.log(JSON.stringify(results.at(-1)));
 }finally{restore();restore=()=>{};const merged=new Map(previous.map(r=>[r.name,r]));for(const r of results)merged.set(r.name,r);writeFileSync(`${out}/results.json`,JSON.stringify([...merged.values()],null,2)+'\n');}
}
if(results.length!==selected.length||results.some(r=>r.status!=='KILLED'))process.exitCode=1;
