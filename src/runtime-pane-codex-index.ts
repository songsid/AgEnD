/** Read-only exact-ID evidence for the audited Codex local store. No vendor process, DB edits or sidecars. */
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Immutable mode cannot see WAL changes: without a WAL path, callers must prove no WAL bytes before AND after this query.
// Real Codex (0.165, M-2423) leaves a non-empty state_5.sqlite-wal after a clean exit, so a WAL is read through a private
// snapshot copy (DB + WAL, never the provider's -shm) that SQLite recovers on open; the provider's files are only read.
const QUERY = `
const {parentPort,workerData}=require('node:worker_threads');
let db;try{const {DatabaseSync}=require('node:sqlite');db=new DatabaseSync(workerData.uri,{readOnly:workerData.readOnly});
db.exec('PRAGMA trusted_schema=OFF');const schema=db.prepare('PRAGMA table_info(threads)').all();
if(schema.length>128||!schema.some(c=>c.name==='id'&&c.type.toUpperCase()==='TEXT'&&c.pk===1))throw Error('Unknown schema');
const row=db.prepare("SELECT 1 AS present FROM threads WHERE typeof(id) <> 'text' OR id=? COLLATE NOCASE LIMIT 1").get(workerData.id);
parentPort.postMessage(row===undefined?'clear':'unknown');}catch{parentPort.postMessage('unknown');}finally{try{db?.close();}catch{}}
`;
export const CODEX_PROOF_DB_MAX = 128 * 1024 * 1024, CODEX_PROOF_WAL_MAX = 64 * 1024 * 1024;
/** Copy one regular file without following a swapped link or blocking on a FIFO; the caller re-checks the source after. */
async function snapshotFile(source: string, target: string, max: number, check?: (bytes: Buffer) => boolean): Promise<void> {
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) throw Error("Unsafe Codex proof snapshot source");
    const bytes = Buffer.alloc(stat.size);
    for (let offset = 0; offset < stat.size;) {
      const { bytesRead } = await handle.read(bytes, offset, stat.size - offset, offset);
      if (!bytesRead) throw Error("Codex proof snapshot source shrank");
      offset += bytesRead;
    }
    if (check && !check(bytes)) throw Error("Unfamiliar Codex proof snapshot");
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  } finally { await handle.close(); }
}
/** SQLite silently ignores a WAL it cannot parse, so only a well-formed one whose frames end on a frame boundary counts:
 * anything else (a torn or foreign file) stays unknown instead of being read as "no rows". */
export function completeSqliteWal(bytes: Buffer): boolean {
  if (bytes.length < 32) return false;
  const magic = bytes.readUInt32BE(0), pageSize = bytes.readUInt32BE(8);
  if ((magic !== 0x377f0682 && magic !== 0x377f0683) || bytes.readUInt32BE(4) !== 3007000) return false;
  const size = pageSize === 1 ? 65536 : pageSize;
  if (size < 512 || size > 65536 || (size & (size - 1))) return false;
  return (bytes.length - 32) % (24 + size) === 0;
}
let active = false;
export async function codexIndexHasNoThread(path: string, id: string, current: () => boolean, walPath?: string): Promise<boolean> {
  const isCurrent=():boolean=>{try{return current()===true;}catch{return false;}};
  if(!isCurrent()||active)return false;
  active=true;
  let snapshot: string | undefined, released = false;
  const release = (): void => { if(!released){released=true;active=false;} };
  try {
    let uri = pathToFileURL(path).href + "?immutable=1", readOnly = true;
    if (walPath !== undefined) {
      snapshot = await mkdtemp(join(tmpdir(), "agend-codex-proof-"));
      const copy = join(snapshot, "state.sqlite");
      await snapshotFile(path, copy, CODEX_PROOF_DB_MAX);
      await snapshotFile(walPath, copy + "-wal", CODEX_PROOF_WAL_MAX, completeSqliteWal);
      if (!isCurrent()) return false;
      // Our own copy: writable so SQLite can rebuild its WAL index; nothing in it is ever written back.
      uri = pathToFileURL(copy).href; readOnly = false;
    }
    return await new Promise<boolean>(resolve => {
      let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined, done = false;
      const finish = (clear: boolean): void => { if(done)return;done=true;clearTimeout(timer);if(worker)void worker.terminate().then(()=>resolve(clear&&isCurrent()),()=>resolve(false));else resolve(false); };
      try {
        worker=new Worker(QUERY,{eval:true,workerData:{uri,readOnly,id},
          resourceLimits:{maxOldGenerationSizeMb:16,maxYoungGenerationSizeMb:4},stderr:true,stdout:true});
        worker.stdout?.resume();worker.stderr?.resume(); // The only result that leaves this worker is an exact-ID presence bit.
        worker.once("message",value=>finish(value==="clear"));worker.once("error",()=>finish(false));worker.once("exit",()=>{release();finish(false);});
        timer=setTimeout(()=>finish(false),750);
      }catch{finish(false);}
    });
  } catch { return false; }
  finally {
    release();
    if (snapshot) await rm(snapshot, { recursive: true, force: true }).catch(() => undefined);
  }
}
