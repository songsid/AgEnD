// SQLite is synchronous: production imports this only inside the dedicated history worker.
import Database from 'better-sqlite3';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { agentHistorySeries, HISTORY_MAX_POINTS, historyBudget, historyQuery, historySeries, HISTORY_BUCKET_MS, HISTORY_PAGE_BYTES, HISTORY_RAW_MS, HISTORY_ROLLUP_MS, HISTORY_SHM_BUDGET, type HistoryPoint } from './host-monitoring-history-policy.js';

export { historyFiles, cleanupHistory } from './host-monitoring-history-files.js';
import { historyFiles } from './host-monitoring-history-files.js';
export interface HistoryStats {bytes:number;rows:number;maxBytes:number;dbBudget:number;trimmed:boolean}
export interface HistoryBucket {at:number;min:number|null;max:number|null;average:number|null;count:number;sourceAt:number|null}
export interface HistoryAnswer {start:number;end:number;step:number;series:Array<{id:string;buckets:HistoryBucket[]}>;stats:HistoryStats}
interface Options {maxBytes?:number;maxRows?:number}
/** A hard DB quota reserves an entire non-spilling transaction WAL, SHM and incident headroom. */
export class HostHistoryStore {
  private db:Database.Database;
  private readonly budget:ReturnType<typeof historyBudget>;
  private readonly maxRows:number;
  private trimmed=false;
  constructor(private readonly path:string,options:Options={}) {
    this.budget=historyBudget(options.maxBytes);this.maxRows=options.maxRows??100_000;
    if(!Number.isSafeInteger(this.maxRows)||this.maxRows<16||this.maxRows>100_000)throw Error('history_invalid_rows');
    this.files(true);
    this.db=new Database(path,{fileMustExist:true,timeout:0});
    try {
      this.db.pragma(`page_size = ${HISTORY_PAGE_BYTES}`);
      if(this.db.pragma('page_size',{simple:true})!==HISTORY_PAGE_BYTES)throw Error('history_page_size');
      this.db.pragma('busy_timeout = 0');this.db.pragma('temp_store = MEMORY');this.db.pragma('cache_size = -1024');
      // Without dirty-page spill, one transaction emits at most one frame per DB page.
      this.db.pragma('cache_spill = OFF');this.db.pragma('journal_mode = WAL');this.db.pragma('wal_autocheckpoint = 0');this.db.pragma('synchronous = NORMAL');
      if(Number(this.db.pragma(`max_page_count = ${this.budget.maxPages}`,{simple:true}))>this.budget.maxPages)throw Error('history_cap');
      const version=Number(this.db.pragma('user_version',{simple:true}));if(version!==0&&version!==1)throw Error('history_version');
      this.db.exec(`CREATE TABLE IF NOT EXISTS monitoring_points (
        resolution INTEGER NOT NULL, series TEXT NOT NULL, at INTEGER NOT NULL,
        lo REAL NOT NULL, hi REAL NOT NULL, total REAL NOT NULL, n INTEGER NOT NULL, source_at INTEGER NOT NULL,
        PRIMARY KEY (resolution,series,at)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS monitoring_points_time ON monitoring_points(resolution,at);
      PRAGMA user_version = 1;`);
      if(!this.checkpoint())throw Error('history_busy');
    }catch(error){this.db.close();throw error;}
  }
  /** Exact names only; rejects foreign/symlinked/oversized files before opening SQLite. */
  private files(create=false):{bytes:number;wal:number} {
    let bytes=0,wal=0,reserved=0;
    for(const [i,name] of historyFiles(this.path).entries()){
      let info;
      try{info=lstatSync(name);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      if(!info.isFile()||info.nlink!==1||(process.getuid&&(info.uid!==process.getuid()||(info.mode&0o077)!==0)))throw Error('history_private_file_required');
      bytes+=info.size;
      if(i>=4)reserved+=info.size;
      if(i===0&&info.size>this.budget.dbBytes)throw Error('history_cap');
      if(i===1){wal=info.size;if(wal>this.budget.walBytes)throw Error('history_cap');}
      if(i===2&&info.size>HISTORY_SHM_BUDGET)throw Error('history_cap');
      if(i===3&&info.size)throw Error('history_unexpected_journal');
    }
    if(bytes>this.budget.maxBytes||reserved>this.budget.reserveBytes)throw Error('history_cap');
    if(create){try{closeSync(openSync(this.path,'wx',0o600));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
    return {bytes,wal};
  }
  private checkpoint():boolean {
    this.files();
    const result=this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{busy:number}>;
    return result[0]?.busy===0&&this.files().wal===0;
  }
  stats():HistoryStats {
    return {bytes:this.files().bytes,rows:Number((this.db.prepare('SELECT count(*) n FROM monitoring_points').get() as {n:number}).n),maxBytes:this.budget.maxBytes,dbBudget:this.budget.dbBytes,trimmed:this.trimmed};
  }
  private removeOldest(limit:number):number {
    const removed=this.db.prepare(`DELETE FROM monitoring_points WHERE (resolution,series,at) IN
      (SELECT resolution,series,at FROM monitoring_points ORDER BY at,resolution LIMIT ?)`).run(limit).changes;
    if(removed)this.trimmed=true;return removed;
  }
  append(points:HistoryPoint[],now:number):{written:number;paused:boolean;stats:HistoryStats} {
    if(points.length>HISTORY_MAX_POINTS||!Number.isSafeInteger(now)||now<0||points.some(p=>!historySeries(p.series)||!Number.isSafeInteger(p.at)||p.at<0||p.at>now||!Number.isSafeInteger(p.sourceAt)||p.sourceAt<0||!Number.isFinite(p.value)||p.value<0||p.value>Number.MAX_SAFE_INTEGER))throw Error('history_invalid_points');
    // A pinned WAL must close before another write. Never accumulate a second transaction behind it.
    const pressure=this.files().bytes>=this.budget.softBytes;
    if(!this.checkpoint())return {written:0,paused:true,stats:this.stats()};
    const prune=this.db.transaction(()=>{
      // The entire DB and row population are capped; expiry completes in this worker transaction.
      for(const [resolution,cutoff]of[[30_000,now-HISTORY_RAW_MS],[HISTORY_BUCKET_MS,now-HISTORY_ROLLUP_MS]])
        this.db.prepare('DELETE FROM monitoring_points WHERE resolution=? AND at<?').run(resolution,cutoff);
      this.db.prepare("DELETE FROM monitoring_points WHERE series LIKE 'agent.%' AND ((resolution=60000 AND at<?) OR (resolution=300000 AND at<?))").run(now-6*60*60*1000,now-7*HISTORY_RAW_MS);
      // At the soft mark prune oldest history, then release WAL below the low mark.
      // DB+reserve+SHM alone is deliberately smaller than that low mark.
      if(pressure)this.removeOldest(2000);
      const count=this.stats().rows;
      if(count+points.length*2>this.maxRows)this.removeOldest(Math.min(2000,Math.max(points.length*2,count-Math.floor(this.maxRows*.9))));
      const pages=Number(this.db.pragma('page_count',{simple:true})),free=Number(this.db.pragma('freelist_count',{simple:true}));
      const growthPages=Math.min(128,Math.max(8,Math.floor(this.budget.maxPages/8)));
      if(this.budget.maxPages-pages+free<growthPages)this.removeOldest(2000);
    });
    prune();if(!this.checkpoint())return {written:0,paused:true,stats:this.stats()};
    const current=this.stats();if(current.rows+points.length*2>this.maxRows)return {written:0,paused:true,stats:current};
    const put=this.db.prepare(`INSERT INTO monitoring_points VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(resolution,series,at)
      DO UPDATE SET lo=excluded.lo,hi=excluded.hi,total=excluded.total,n=excluded.n,source_at=excluded.source_at`);
    const aggregate=this.db.prepare(`SELECT min(lo) lo,max(hi) hi,sum(total) total,sum(n) n,max(source_at) source_at
      FROM monitoring_points WHERE resolution IN (30000,60000) AND series=? AND at>=? AND at<?`);
    this.db.transaction(()=>{
      const changed=new Map<string,{series:string;at:number}>();
      for(const p of points){const resolution=agentHistorySeries(p.series)?60000:30000;const at=Math.floor(p.at/resolution)*resolution;put.run(resolution,p.series,at,p.value,p.value,p.value,1,p.sourceAt);
        const roll=Math.floor(at/HISTORY_BUCKET_MS)*HISTORY_BUCKET_MS;changed.set(`${p.series}:${roll}`,{series:p.series,at:roll});}
      for(const p of changed.values()){
        const a=aggregate.get(p.series,p.at,p.at+HISTORY_BUCKET_MS) as {lo:number;hi:number;total:number;n:number;source_at:number};
        put.run(HISTORY_BUCKET_MS,p.series,p.at,a.lo,a.hi,a.total,a.n,a.source_at);
      }
    })();
    const truncated=this.checkpoint(),stats=this.stats();
    // Checkpointing releases journal bytes first; history retention/row pruning reuses allocated DB pages.
    if(stats.bytes>this.budget.maxBytes||(pressure&&truncated&&stats.bytes>this.budget.lowBytes))throw Error('history_cap');
    return {written:points.length,paused:!truncated,stats};
  }
  query(range:unknown,series:unknown,now:number):HistoryAnswer {
    const q=historyQuery(range,series,now);
    const select=this.db.prepare(`SELECT CAST((at-?)/? AS INTEGER) bucket,min(lo) lo,max(hi) hi,sum(total) total,sum(n) n,max(source_at) source_at
      FROM monitoring_points WHERE resolution=? AND series=? AND at>=? AND at<? GROUP BY bucket ORDER BY bucket LIMIT 241`);
    return {start:q.start,end:q.end,step:q.step,series:q.series.map(id=>{
      const rows=select.all(q.start,q.step,range==='1h'?(agentHistorySeries(id)?60000:30000):q.resolution,id,q.start,q.end) as Array<{bucket:number;lo:number;hi:number;total:number;n:number;source_at:number}>;
      const byBucket=new Map(rows.map(r=>[r.bucket,r]));
      return {id,buckets:Array.from({length:q.buckets},(_,i)=>{const r=byBucket.get(i);return {at:q.start+i*q.step,min:r?.lo??null,max:r?.hi??null,average:r&&r.n?r.total/r.n:null,count:r?.n??0,sourceAt:r?.source_at??null};})};
    }),stats:this.stats()};
  }
  close():void {this.db.close();}
}
