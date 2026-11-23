import {open} from 'node:fs/promises';
import {execFile} from '../child-process.js';
import type {cpus,loadavg} from 'node:os';
import type {MemoryPressureSnapshot} from '../memory-pressure.js';
import type {DiskReading,MonitoringPlatform,MonitoringProbe} from '../host-monitoring.js';
export const MONITOR_OUTPUT_BYTES = 32 * 1024;
/** Kernel mount metadata can exceed helper stdout; keep its read separately bounded. */
export const MONITOR_MOUNT_BYTES = 64 * 1024;
export const MONITOR_DEADLINE_MS = 2_000;
export const DISCOVERY_MS = 60 * 60 * 1000;
export interface MonitorCommand { result: Promise<string | null>; stopped: Promise<void>; kill(): void }
export type MonitorRunner = (file: string, args: string[], env?: Record<string, string>, cwd?: string) => MonitorCommand;
/** Native readers receive no account credentials, shell, project startup file or user PATH. */
export const runMonitorCommand: MonitorRunner = (file, args, extra = {}, cwd) => {
  let result!: (value: string | null) => void, stopped!: () => void;
  const output = new Promise<string | null>(r => { result = r; });
  const closed = new Promise<void>(r => { stopped = r; });
  try {
    const child = execFile(file, args, { encoding:'utf8', ...(cwd ? {cwd} : {}), env:{ PATH:'/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL:'C', LANG:'C', ...extra },
      timeout:1_500, killSignal:'SIGKILL', maxBuffer:MONITOR_OUTPUT_BYTES }, (error, stdout) => result(error ? null : stdout));
    child.once('close', stopped);
    child.once('error', () => result(null));
    return { result:output, stopped:closed, kill() { try { child.kill('SIGKILL'); } catch { /* retain until close */ } } };
  } catch { result(null); stopped(); return { result:output, stopped:closed, kill() {} }; }
};

/** Kernel inventories only; never reads a directory tree or an unbounded file. */
export async function readMonitorKernelFile(path: string, limit = MONITOR_OUTPUT_BYTES): Promise<string | null> {
  let fh;
  try {
    if(!Number.isSafeInteger(limit)||limit<1||limit>MONITOR_MOUNT_BYTES)return null;
    fh = await open(path, 'r');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await fh.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) return bytes.subarray(0, size).toString('utf8');
      size += read.bytesRead;
    }
    return null;
  } catch { return null; } finally { await fh?.close(); }
}

export interface NativeMonitorOptions {
  statePath: string;
  memory: () => MemoryPressureSnapshot;
  platform?: MonitoringPlatform;
  run?: MonitorRunner;
  readMounts?: () => Promise<string | null>;
  now?: () => number;
  monotonic?: () => number;
  cpus?: typeof cpus;
  load?: typeof loadavg;
  /** Explicit mounted drive selection takes precedence over registration discovery. */
  wslDrive?: string;
}

export type MonitorCall=(file:string,args:string[],env?:Record<string,string>,cwd?:string)=>Promise<string|null>;
export class MonitorProbeOwner {
  private commands=new Set<MonitorCommand>();
  private flight:MonitoringProbe<DiskReading>|null=null;
  closed=false;
  constructor(private readonly run:MonitorRunner=runMonitorCommand,private readonly monotonic=()=>performance.now()){}
  probe(task: (call: MonitorCall, cancelled: () => boolean) => Promise<DiskReading | null>): MonitoringProbe<DiskReading> {
    if (this.flight) return this.flight;
    if (this.closed) return {result:Promise.resolve(null),stopped:Promise.resolve(),cancel() {}};
    let cancelled = false, settled = false, resolve!: (value:DiskReading|null) => void;
    const result = new Promise<DiskReading|null>(r => {resolve=r;});
    const finish = (value:DiskReading|null) => { if (!settled) {settled=true;resolve(value);} };
    const cancel = () => {cancelled=true;finish(null); for (const command of this.commands) command.kill();};
    const deadline = this.monotonic() + MONITOR_DEADLINE_MS;
    const timer = setTimeout(cancel,MONITOR_DEADLINE_MS); timer.unref?.();
    const call = async (file:string,args:string[],env?:Record<string,string>,cwd?:string) => {
      if (cancelled || this.closed || this.monotonic() >= deadline) return null;
      const command = this.run(file,args,env,cwd); this.commands.add(command);
      void command.stopped.then(() => this.commands.delete(command), () => { /* keep ownership on an unconfirmed close */ });
      const text = await command.result;
      await command.stopped;
      return cancelled || this.closed || (text !== null && Buffer.byteLength(text) > MONITOR_OUTPUT_BYTES) ? null : text;
    };
    const work = task(call, () => cancelled || this.closed);
    const stopped = work.then(finish, () => finish(null)).then(async () => {
      clearTimeout(timer);
      await Promise.all([...this.commands].map(c => c.stopped));
    });
    const flight = this.flight = {result,stopped,cancel};
    void stopped.then(() => {if (this.flight === flight) this.flight=null;}, () => { /* fail closed */ });
    return flight;
  }
  stop():Promise<void>{this.closed=true;this.flight?.cancel();return this.flight?.stopped??Promise.resolve();}
}
