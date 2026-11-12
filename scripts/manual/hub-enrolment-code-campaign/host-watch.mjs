/** Lightweight host-side /proc sampler. It only writes this attempt's STOP; the container supervisor stops its child. */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireHostBudget } from './guard.mjs';
export function hostSample() {
  const memory = readFileSync('/proc/meminfo', 'utf8');
  return { at: Date.now(), load1: Number(readFileSync('/proc/loadavg','utf8').split(' ')[0]),
    availableMiB: Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]) / 1024,
    swapTotalMiB: Number(/^SwapTotal:\s+(\d+)/m.exec(memory)?.[1]) / 1024 };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const out = process.argv[2], stop = reason => { try { writeFileSync(join(out,'control/STOP'),reason+'\n',{flag:'wx'}); } catch(e) { if(e.code!=='EEXIST')throw e; } };
  process.on('SIGTERM',()=>stop('Host sampler terminated'));process.on('SIGINT',()=>stop('Host sampler interrupted'));
  while (!existsSync(join(out,'control/WATCH_DONE'))) {
    try { const sample=hostSample();appendFileSync(join(out,'evidence/host-resources.jsonl'),JSON.stringify(sample)+'\n');requireHostBudget(sample.load1,sample.availableMiB); }
    catch(e) { stop(String(e)); }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
}
