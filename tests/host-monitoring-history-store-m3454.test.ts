import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync,chmodSync,truncateSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Database from 'better-sqlite3';
import {cleanupHistory,historyFiles,HostHistoryStore} from '../src/host-monitoring-history-store.js';
const roots:string[]=[],stores:HostHistoryStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))try{store.close()}catch{};for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(maxRows=1000){const root=mkdtempSync(join(tmpdir(),'monitor-history-'));roots.push(root);const path=join(root,'monitoring.sqlite'),store=new HostHistoryStore(path,{maxBytes:1024**2,maxRows});stores.push(store);return{root,path,store};}
const point=(at:number,value:number)=>({at,sourceAt:at,series:'cpu.used',value});
describe('physically capped monitoring history',()=>{
 it('keeps raw rows idempotent and rollups preserve extrema, average and coverage',()=>{
  const {store}=fixture();store.append([point(30000,10),point(60000,80)],60000);store.append([point(30000,20)],60000);
  const raw=store.query('1h',['cpu.used'],90000).series[0].buckets;expect(raw.filter(r=>r.count).map(r=>r.average)).toEqual([20,80]);
  const rolled=store.query('24h',['cpu.used'],600001).series[0].buckets.find(r=>r.count)!;expect(rolled).toMatchObject({min:20,max:80,average:50,count:2});
  expect(store.stats().bytes).toBeLessThanOrEqual(1024**2);
 });
 it('stresses a small physical quota with changing volume series and keeps accepting bounded frames',()=>{
  const {root,path}=fixture();const capped=new HostHistoryStore(join(root,'small.sqlite'),{maxBytes:1024**2,maxRows:100000});stores.push(capped);
  let peak=0,checked=0;
  for(let frame=0;frame<240;frame++){
   const at=frame*30000,points=Array.from({length:64},(_,i)=>({at,sourceAt:at,value:i,series:`disk.${i.toString(16).padStart(16,'0')}.available`}));
   const result=capped.append(points,at);expect(result.written).toBe(64);expect(result.paused).toBe(false);peak=Math.max(peak,result.stats.bytes);expect(result.stats.bytes).toBeLessThanOrEqual(1024**2);checked++;
  }
  expect(checked).toBe(240);expect(peak).toBeGreaterThan(200000);expect(capped.stats().trimmed).toBe(true);
  const answer=capped.query('24h',['disk.0000000000000001.available'],240*30000);expect(answer.series[0].buckets.length).toBeLessThanOrEqual(240);
 });
 it('prunes oldest history at the soft total and checkpoints back below the low mark',()=>{
  const {path,store}=fixture(100000);
  for(let frame=0;frame<180;frame++)store.append(Array.from({length:64},(_,i)=>({at:frame*30000,sourceAt:frame*30000,value:i,series:`disk.${i.toString(16).padStart(16,'0')}.available`})),frame*30000);
  writeFileSync(path+'.incidents',Buffer.alloc(1024**2/4),{mode:0o600});
  const writer=new Database(path);
  try{
   writer.pragma('wal_autocheckpoint = 0');writer.pragma('max_page_count = 79');writer.pragma('cache_spill = OFF');
   writer.transaction(()=>{writer.exec("UPDATE monitoring_points SET series=replace(series,'.available','.used'); CREATE TABLE pressure_fixture(data BLOB); INSERT INTO pressure_fixture VALUES(zeroblob(232000))");})();
   const before=store.stats();expect(before.bytes).toBeGreaterThanOrEqual(1024**2*7/8);expect(before.bytes).toBeLessThanOrEqual(1024**2);
   const after=store.append([point(180*30000,70)],180*30000);expect(after.paused).toBe(false);expect(after.stats.bytes).toBeLessThanOrEqual(1024**2*3/4);expect(after.stats.rows).toBeLessThan(before.rows);expect(after.stats.trimmed).toBe(true);
  }finally{writer.close();}
 });
 it('the SQLite engine refuses an oversized transaction before the physical budget grows',()=>{
  const {store}=fixture();const db=(store as any).db as Database.Database;
  db.exec('CREATE TABLE quota_fixture(data BLOB)');const before=store.stats().bytes;
  expect(()=>db.prepare('INSERT INTO quota_fixture VALUES(zeroblob(?))').run(store.stats().dbBudget+4096)).toThrowError(expect.objectContaining({code:'SQLITE_FULL'}));
  expect(store.stats().bytes).toBeLessThanOrEqual(1024**2);expect(store.stats().bytes).toBeLessThan(before+40000);
 });
 it('a pinned WAL prevents another transaction rather than accumulating bytes',()=>{
  const {path,store}=fixture();store.append([point(30000,1)],30000);
  const reader=new Database(path,{readonly:true,fileMustExist:true});
  try{
   reader.exec('BEGIN');reader.prepare('SELECT * FROM monitoring_points').all();
   const first=store.append([point(60000,2)],60000);expect(first.paused).toBe(true);expect(first.written).toBe(1);
   const bytes=store.stats().bytes,rows=store.stats().rows;
   const second=store.append([point(90000,3)],90000);expect(second.written).toBe(0);expect(second.paused).toBe(true);expect(store.stats()).toMatchObject({bytes,rows});expect(bytes).toBeLessThanOrEqual(1024**2);
   reader.exec('ROLLBACK');expect(store.append([point(120000,4)],120000).paused).toBe(false);
  }finally{reader.close();}
 });
 it('bounds rows oldest-first and expires raw/rollup retention',()=>{
  const {store}=fixture(32);for(let i=0;i<80;i++)store.append([point(i*30000,i%100)],i*30000);
  expect(store.stats().rows).toBeLessThanOrEqual(32);expect(store.stats().trimmed).toBe(true);
  const now=31*24*3600000;store.append([point(now,20)],now);expect(store.stats().rows).toBe(2);
  expect(store.query('30d',['cpu.used'],now+1).series[0].buckets.filter(b=>b.count)).toHaveLength(1);
 });
 it('never accepts an unbounded point batch, unsafe series or oversized incident reserve',()=>{
  const {store,path}=fixture();expect(()=>store.append(Array.from({length:833},()=>point(1,1)),1)).toThrow('history_invalid_points');
  expect(()=>store.append([{...point(1,1),series:'../outside'}],1)).toThrow('history_invalid_points');
  writeFileSync(path+'.incidents','',{mode:0o600});truncateSync(path+'.incidents',400000);
  expect(()=>store.append([point(1,1)],1)).toThrow('history_cap');
 });
 it('cleanup removes exact owned names only and never follows a symlink',async()=>{
  const {root,path,store}=fixture();store.close();stores.splice(stores.indexOf(store),1);
  const outside=join(root,'keep.txt');writeFileSync(outside,'keep');symlinkSync(outside,path+'.incidents');
  await cleanupHistory(path);expect(historyFiles(path).every(p=>!existsSync(p))).toBe(true);expect(readFileSync(outside,'utf8')).toBe('keep');
 });
 it('cleanup failure is explicit, while other exact paths still receive cleanup',async()=>{
  const seen:string[]=[];await expect(cleanupHistory('/fixture/monitoring.sqlite',async p=>{seen.push(p);if(p.endsWith('-wal'))throw Error('locked')})).rejects.toThrow('history_cleanup_failed');
  expect(seen).toEqual(historyFiles('/fixture/monitoring.sqlite'));
 });
 it('refuses a foreign/symlinked history file instead of replacing it',()=>{
  const root=mkdtempSync(join(tmpdir(),'monitor-private-'));roots.push(root);const outside=join(root,'outside'),path=join(root,'monitoring.sqlite');writeFileSync(outside,'keep');symlinkSync(outside,path);
  expect(()=>new HostHistoryStore(path)).toThrow('history_private_file_required');expect(readFileSync(outside,'utf8')).toBe('keep');
 });
});
