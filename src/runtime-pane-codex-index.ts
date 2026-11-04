/** Read-only exact-ID evidence for the audited Codex local store. No vendor process, DB edits or sidecars. */
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
// Immutable mode cannot see WAL changes: callers must prove no WAL bytes before AND after this bounded query.
const QUERY = `
const {parentPort,workerData}=require('node:worker_threads');
let db;try{const {DatabaseSync}=require('node:sqlite');db=new DatabaseSync(workerData.uri,{readOnly:true});
db.exec('PRAGMA trusted_schema=OFF');const schema=db.prepare('PRAGMA table_info(threads)').all();
if(schema.length>128||!schema.some(c=>c.name==='id'&&c.type.toUpperCase()==='TEXT'&&c.pk===1))throw Error('Unknown schema');
const row=db.prepare("SELECT 1 AS present FROM threads WHERE typeof(id) <> 'text' OR id=? COLLATE NOCASE LIMIT 1").get(workerData.id);
parentPort.postMessage(row===undefined?'clear':'unknown');}catch{parentPort.postMessage('unknown');}finally{try{db?.close();}catch{}}
`;
let active = false;
export function codexIndexHasNoThread(path: string, id: string, current: () => boolean): Promise<boolean> {
  const isCurrent=():boolean=>{try{return current()===true;}catch{return false;}};
  return new Promise(resolve => {
    let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined, done = false;
    const finish = (clear: boolean): void => { if(done)return;done=true;clearTimeout(timer);if(worker)void worker.terminate().then(()=>resolve(clear&&isCurrent()),()=>resolve(false));else resolve(false); };
    if(!isCurrent()||active)return finish(false);
    active=true;
    try {
      worker=new Worker(QUERY,{eval:true,workerData:{uri:pathToFileURL(path).href+"?immutable=1",id},
        resourceLimits:{maxOldGenerationSizeMb:16,maxYoungGenerationSizeMb:4},stderr:true,stdout:true});
      worker.stdout?.resume();worker.stderr?.resume(); // The only result that leaves this worker is an exact-ID presence bit.
      worker.once("message",value=>finish(value==="clear"));worker.once("error",()=>finish(false));worker.once("exit",()=>{active=false;finish(false);});
      timer=setTimeout(()=>finish(false),750);
    }catch{active=false;finish(false);}
  });
}
