import { unlink } from 'node:fs/promises';

export const historyFiles = (path:string) => ['', '-wal', '-shm', '-journal', '.incidents', '.incidents.tmp'].map(s=>path+s);
export async function cleanupHistory(path:string,remove:(path:string)=>Promise<void>=unlink):Promise<void> {
  let failed=false;
  for(const name of historyFiles(path)) try {await remove(name);} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')failed=true;}
  if(failed)throw Error('history_cleanup_failed');
}
