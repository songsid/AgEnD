import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { cpus, loadavg, platform, release } from 'node:os';
import { isAbsolute } from 'node:path';
import { execFile } from './child-process.js';
import type { MemoryPressureSnapshot } from './memory-pressure.js';
import type { CpuReading, DiskReading, DiskVolume, HostMonitoringProvider, MonitoringPlatform, MonitoringProbe } from './host-monitoring.js';

export const MONITOR_OUTPUT_BYTES = 32 * 1024;
export const MONITOR_DEADLINE_MS = 2_000;
const DISCOVERY_MS = 60 * 60 * 1000;
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
export async function readMonitorKernelFile(path: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, 'r');
    const bytes = Buffer.alloc(MONITOR_OUTPUT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await fh.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) return bytes.subarray(0, size).toString('utf8');
      size += read.bytesRead;
    }
    return null;
  } catch { return null; } finally { await fh?.close(); }
}

export interface MonitorMount { id: string; path: string; type: string; local: boolean; drive?: string }
const unescapeMount = (s: string) => s.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
const NETWORK = new Set(['nfs','nfs4','cifs','smbfs','sshfs','fuse.sshfs','afs','9p']);
export function parseMonitorMounts(text: string | null): MonitorMount[] {
  if (!text || Buffer.byteLength(text) > MONITOR_OUTPUT_BYTES) return [];
  const mounts: MonitorMount[] = [];
  for (const row of text.trim().split('\n')) {
    const halves = row.split(' - '), left = halves[0]?.split(' '), right = halves[1]?.split(' ');
    if (halves.length !== 2 || left.length < 6 || !right || right.length < 3) continue;
    const path = unescapeMount(left[4]), source = unescapeMount(right[1]), type = right[0];
    if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) continue;
    const drive = /^(?:([A-Za-z]):\\?|([A-Za-z]):)$/.exec(source)?.slice(1).find(Boolean)?.toUpperCase();
    const local = drive ? ['9p','drvfs'].includes(type) : !NETWORK.has(type) && !type.startsWith('fuse.');
    mounts.push({ id:left[2], path, type, local, ...(drive ? {drive} : {}) });
  }
  return mounts.slice(0, 512);
}
export function monitorMountFor(mounts: MonitorMount[], path: string): MonitorMount | null {
  return mounts.filter(m => path === m.path || path.startsWith(m.path === '/' ? '/' : m.path + '/')).sort((a,b) => b.path.length - a.path.length)[0] ?? null;
}
export function parseMonitorDf(text: string | null): { totalBytes: number; availableBytes: number; usedPercent: number } | null {
  if (!text || Buffer.byteLength(text) > MONITOR_OUTPUT_BYTES) return null;
  const rows = text.trim().split(/\r?\n/);
  if (rows.length !== 2 || !/^Filesystem\s/.test(rows[0])) return null;
  const match = /^.+?\s+(\d+)\s+(\d+)\s+(-?\d+)\s+\d+%\s+.+$/.exec(rows[1]);
  if (!match) return null;
  const [total, used, free] = match.slice(1).map(Number);
  if (![total,used,Math.abs(free)].every(Number.isSafeInteger) || total <= 0 || used < 0 || free > total || used > total) return null;
  const totalBytes = total * 1024, availableBytes = Math.max(0, free) * 1024;
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes)) return null;
  return { totalBytes, availableBytes, usedPercent:used + Math.max(0,free) ? used / (used + Math.max(0, free)) * 100 : 100 };
}
/** Read only one known plist string key; duplicate/malformed identities are not evidence of a shared container. */
export function parseApfsContainer(text: string | null): string | null {
  if (!text || Buffer.byteLength(text) > MONITOR_OUTPUT_BYTES) return null;
  const rows = [...text.matchAll(/<key>APFSContainerReference<\/key>\s*<string>(disk\d+)<\/string>/g)];
  return rows.length === 1 ? rows[0][1] : null;
}
export class MonitorCpu {
  private previous: Array<{ idle:number; total:number }> | null = null;
  sample(rows: ReturnType<typeof cpus>, load: number[]): CpuReading {
    const result: CpuReading = { usedPercent:null, logicalCpus:Math.min(rows.length,1024), loadAverage:load.length === 3 && load.every(n => Number.isFinite(n) && n >= 0) ? [...load] : null };
    const current = rows.slice(0,1024).map(c => ({idle:c.times.idle,total:Object.values(c.times).reduce((a,b) => a+b,0)}));
    if (rows.length > 1024 || !current.length || current.some(c => !Number.isSafeInteger(c.total) || !Number.isSafeInteger(c.idle) || c.idle < 0 || c.total < c.idle)) { this.previous = null; return result; }
    const before = this.previous; this.previous = current;
    if (!before || before.length !== current.length) return result;
    let idle = 0, total = 0;
    for (let i=0;i<current.length;i++) {
      const dt = current[i].total-before[i].total, di = current[i].idle-before[i].idle;
      if (dt <= 0 || di < 0 || di > dt) return result;
      total += dt; idle += di;
    }
    result.usedPercent = (total-idle)/total*100;
    return result;
  }
}

// Constant read-only registry script; output contains a drive letter only, never the registered private path.
export const WSL_BACKING_DRIVE_SCRIPT = String.raw`$ErrorActionPreference='Stop'; $p=$PWD.ProviderPath; $m=[regex]::Match($p,'^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(?:\\|$)',[System.Text.RegularExpressions.RegexOptions]::IgnoreCase); if (!$m.Success) {exit 2}; $n=$m.Groups[1].Value; if (!$n -or $n.Length -gt 128) {exit 2}; $ks=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'); if ($ks.Count -gt 64) {exit 2}; $ms=@($ks | Where-Object {$_.GetValue('DistributionName') -ceq $n}); if ($ms.Count -ne 1) {exit 2}; $b=$ms[0].GetValue('BasePath'); if ($b -match '^(?:\\\\\?\\)?([A-Za-z]):\\') {[Console]::WriteLine($Matches[1].ToUpperInvariant())} else {exit 2}`;
interface Options {
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
/** Constructed only by the enabled runtime. No extra memory sampler or history is owned here. */
export class NativeHostMonitoring implements HostMonitoringProvider {
  readonly platform: MonitoringPlatform;
  private readonly run: MonitorRunner;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly cpu = new MonitorCpu();
  private commands = new Set<MonitorCommand>();
  private flight: MonitoringProbe<DiskReading> | null = null;
  private closed = false;
  private discoveryAt = -Infinity;
  private mounts: MonitorMount[] = [];
  private backing: string | null = null;
  private apfs = new Map<string,string | null>();
  private macMounts: string | null = null;
  constructor(private readonly options: Options) {
    this.platform = options.platform ?? (platform() === 'darwin' ? 'darwin' : /microsoft/i.test(release()) || !!process.env.WSL_DISTRO_NAME ? 'wsl' : 'linux');
    this.run = options.run ?? runMonitorCommand; this.now = options.now ?? Date.now; this.monotonic = options.monotonic ?? (() => performance.now());
  }
  host(): ReturnType<HostMonitoringProvider['host']> {
    if (this.closed) return {cpu:{value:null},memory:{value:null}};
    const cpu = this.cpu.sample((this.options.cpus ?? cpus)(), (this.options.load ?? loadavg)());
    const memory = this.options.memory(), m = memory.memory;
    const valid = m && Number.isSafeInteger(m.totalBytes) && m.totalBytes > 0;
    return { cpu:{value:cpu, ...(cpu.usedPercent === null ? {reason:'cpu_baseline_or_reset'} : {})},
      memory:valid ? {value:{totalBytes:m.totalBytes,availableBytes:m.availableBytes,availableKind:m.availableKind,pressure:memory.level,swapTotalBytes:m.swapTotalBytes,swapFreeBytes:m.swapFreeBytes},...(memory.sampledAt !== null ? {sampledAt:memory.sampledAt} : {})} : {value:null,reason:'memory_unavailable'} };
  }
  disks(): MonitoringProbe<DiskReading> {
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
    const work = (async () => {
      if (this.monotonic() - this.discoveryAt >= DISCOVERY_MS) {
        this.discoveryAt = this.monotonic(); this.apfs.clear(); this.backing = null;
        if (this.platform === 'darwin') this.macMounts = await call('/sbin/mount', []);
        if (this.platform !== 'darwin') {
          this.mounts = parseMonitorMounts(await (this.options.readMounts ?? (() => readMonitorKernelFile('/proc/self/mountinfo')))());
          if (this.platform === 'wsl') {
            if (this.options.wslDrive && /^[A-Z]$/.test(this.options.wslDrive)) this.backing = this.options.wslDrive;
            else {
              // Only one known local Windows system executable; never an arbitrary PATH helper or shell.
              const system = this.mounts.find(m => m.drive === 'C' && m.local);
              if (system) {
                const answer = await call(system.path.replace(/\/$/,'') + '/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',WSL_BACKING_DRIVE_SCRIPT], undefined, '/');
                if (answer && /^[A-Z]\r?\n?$/.test(answer.trim())) this.backing = answer.trim();
              }
            }
          }
        }
      }
      const targets: Array<{path:string;role:string;mount?:MonitorMount;drive?:string}> = [{path:'/',role:'root'},{path:this.options.statePath,role:'state'}];
      if (this.platform === 'wsl') {
        const matches = this.mounts.filter(m => m.drive === this.backing && m.local);
        if (matches.length === 1) targets.push({path:matches[0].path,role:'wsl-backing',mount:matches[0],drive:this.backing!});
      }
      const volumes: DiskVolume[] = [];
      for (const target of targets.slice(0,8)) {
        const mount = target.mount ?? monitorMountFor(this.mounts,target.path);
        let identity = mount?.id ?? target.role;
        let reason: string | undefined;
        if (!isAbsolute(target.path) || (this.platform !== 'darwin' && !mount?.local)) reason = mount ? 'network_filesystem_not_sampled' : 'filesystem_not_identified';
        if (this.platform === 'darwin') {
          // mount -p is not portable on macOS: query only known local paths, refusing network state paths via mount inventory.
          const inventory = this.macMounts;
          const lines = inventory?.trim().split('\n') ?? [];
          const known = lines.map(row => /^(.+) on (.+) \(([^)]+)\)$/.exec(row)).filter((m):m is RegExpExecArray => !!m)
            .filter(m => target.path === m[2] || target.path.startsWith(m[2] === '/' ? '/' : m[2] + '/')).sort((a,b) => b[2].length-a[2].length)[0];
          if (!known || !known[3].split(/,\s*/).includes('local')) reason = 'filesystem_not_identified';
          else {
            identity = known[1];
            if (!this.apfs.has(target.role)) {
              const container = parseApfsContainer(await call('/usr/sbin/diskutil',['info','-plist',target.path]));
              this.apfs.set(target.role,container);
            }
            identity = this.apfs.get(target.role) ?? identity;
          }
        }
        const reading = reason ? null : parseMonitorDf(await call('/bin/df',['-Pk',target.path]));
        if (cancelled || this.closed) return null;
        const container = this.platform === 'darwin' ? this.apfs.get(target.role) : null;
        const volume:DiskVolume = {...(container ? {shared:true,sharedGroup:createHash('sha256').update(container).digest('hex').slice(0,16)} : {}),id:createHash('sha256').update(this.platform === 'darwin' ? `${identity}:${reading?.totalBytes ?? 'unknown'}` : identity).digest('hex').slice(0,16),roles:[target.role],totalBytes:reading?.totalBytes ?? null,availableBytes:reading?.availableBytes ?? null,usedPercent:reading?.usedPercent ?? null,sampledAt:reading ? this.now() : null,...(!reading ? {reason:reason ?? 'filesystem_read_failed'} : {}),...(target.drive ? {drive:target.drive} : {})};
        const same = volumes.find(v => v.id === volume.id && v.totalBytes === volume.totalBytes);
        if (same && reading) {same.roles.push(target.role);same.availableBytes=Math.min(same.availableBytes!,reading.availableBytes);same.usedPercent=Math.max(same.usedPercent!,reading.usedPercent);same.shared=true;}
        else volumes.push(volume);
      }
      return {volumes,backingDrive:this.platform === 'wsl' ? volumes.some(v => v.roles.includes('wsl-backing')) ? 'identified' as const : 'unknown' as const : 'not-applicable' as const,
        ...(this.platform === 'wsl' ? {availableDrives:[...new Set(this.mounts.filter(m => m.drive && m.local).map(m => m.drive!))].sort()} : {})};
    })();
    const stopped = work.then(finish, () => finish(null)).then(async () => {
      clearTimeout(timer);
      await Promise.all([...this.commands].map(c => c.stopped));
    });
    const flight = this.flight = {result,stopped,cancel};
    void stopped.then(() => {if (this.flight === flight) this.flight=null;}, () => { /* fail closed */ });
    return flight;
  }
  stop(): Promise<void> { this.closed=true;this.flight?.cancel();return this.flight?.stopped ?? Promise.resolve(); }
}
