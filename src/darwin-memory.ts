import { execFile } from "node:child_process";
import { totalmem } from "node:os";
import type { HostMemory } from "./host-memory.js";

export const DARWIN_MEMORY_DEADLINE_MS = 2_000;
export const DARWIN_MEMORY_CACHE_MS = 30_000;
const MAX_OUTPUT = 32 * 1024;

export function unknownDarwinMemory(totalBytes: number): HostMemory {
  return { totalBytes, availableBytes: null, availableKind: "unknown", swapTotalBytes: null, swapFreeBytes: null, darwinPressureLevel: null, darwinPressureRaw: null };
}

/** XNU exposes NOTE_MEMORYSTATUS_PRESSURE_* (1/2/4), not its internal 0/1/2/3 enum. */
export function parseDarwinPressureLevel(text: string): HostMemory["darwinPressureLevel"] {
  const match = /^kern\.memorystatus_vm_pressure_level:[ \t]+([124])[ \t]*\r?\n?$/.exec(text);
  return match && match[0].length === text.length ? Number(match[1]) as 1 | 2 | 4 : null;
}

/** vm_stat's printed free count excludes speculative pages. Purgeable can overlap inactive. */
export function parseDarwinAvailable(text: string, totalBytes: number): number | null {
  const headers = [...text.matchAll(/^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)\s*$/gm)];
  if (headers.length !== 1 || [...text.matchAll(/^Mach Virtual Memory Statistics:/gm)].length !== 1) return null;
  const pageSize = Number(headers[0][1]);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1024 || pageSize > 1024 * 1024 || Math.log2(pageSize) % 1 !== 0) return null;
  const counts: number[] = [];
  for (const name of ["free", "speculative", "inactive", "purgeable"]) {
    const rows = [...text.matchAll(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.\\s*$`, "gm"))];
    if (rows.length !== 1 || [...text.matchAll(new RegExp(`^Pages ${name}:`, "gm"))].length !== 1) return null;
    const count = Number(rows[0][1]);
    if (!Number.isSafeInteger(count) || count < 0) return null;
    counts.push(count);
  }
  const [free, speculative, inactive, purgeable] = counts;
  const bytes = (free + speculative + Math.max(inactive, purgeable)) * pageSize;
  return Number.isSafeInteger(bytes) && Number.isFinite(totalBytes) && totalBytes > 0 && bytes <= totalBytes ? bytes : null;
}

/** sysctl prints binary MiB to two decimals, including the valid unallocated 0/0 pool. */
export function parseDarwinSwap(text: string): Pick<HostMemory, "swapTotalBytes" | "swapFreeBytes"> {
  const unknown = { swapTotalBytes: null, swapFreeBytes: null };
  const rows = [...text.matchAll(/^vm\.swapusage:\s+total = (\d+(?:\.\d+)?)M\s+used = (\d+(?:\.\d+)?)M\s+free = (\d+(?:\.\d+)?)M\s*(?:\(encrypted\))?\s*$/gm)];
  if (rows.length !== 1) return unknown;
  const [total, used, free] = rows[0].slice(1).map(Number);
  if (![total, used, free].every(Number.isFinite) || free > total || used > total || Math.abs(total - used - free) > 0.02) return unknown;
  const totalBytes = Math.round(total * 1024 ** 2), freeBytes = Math.round(free * 1024 ** 2);
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(freeBytes)) return unknown;
  return { swapTotalBytes: totalBytes, swapFreeBytes: freeBytes };
}

export interface MemoryCommand {
  result: Promise<string | null>;
  /** Physical child close, independent of logical timeout/result. */
  stopped: Promise<void>;
  kill(): void;
}
export type MemoryCommandRunner = (file: string, args: string[]) => MemoryCommand;

export const runMemoryCommand: MemoryCommandRunner = (file, args) => {
  let resolveResult!: (value: string | null) => void;
  let resolveStopped!: () => void;
  const result = new Promise<string | null>(resolve => { resolveResult = resolve; });
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve; });
  try {
    const child = execFile(file, args, {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" },
      timeout: 1_500, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT,
    }, (error, stdout) => resolveResult(error ? null : stdout));
    child.once("close", resolveStopped);
    // A spawn error normally also emits close. Keep the physical reservation until then.
    child.once("error", () => resolveResult(null));
    return { result, stopped, kill: () => { try { child.kill("SIGKILL"); } catch { /* wait for close */ } } };
  } catch {
    resolveResult(null); resolveStopped();
    return { result, stopped, kill: () => {} };
  }
};

interface Options {
  run?: MemoryCommandRunner;
  totalmem?: () => number;
  now?: () => number;
  /** Only the periodic fleet sampler requests the kernel alarm. Diagnostics do not fork for it. */
  includePressure?: boolean;
}
interface Flight {
  completed: boolean;
  epoch: number;
  result: Promise<HostMemory>;
  cancel(): void;
}

/** One bounded logical read and at most one physical batch, even across stop/restart. */
export class DarwinMemoryProbe {
  private readonly run: MemoryCommandRunner;
  private readonly total: () => number;
  private readonly now: () => number;
  private readonly includePressure: boolean;
  private flight: Flight | null = null;
  private cache: { at: number; memory: HostMemory } | null = null;
  private epoch = 0;

  constructor(options: Options = {}) {
    this.run = options.run ?? runMemoryCommand;
    this.total = options.totalmem ?? totalmem;
    this.now = options.now ?? (() => performance.now());
    this.includePressure = options.includePressure ?? false;
  }

  read(): Promise<HostMemory> {
    if (this.cache && this.now() - this.cache.at < DARWIN_MEMORY_CACHE_MS) return Promise.resolve({ ...this.cache.memory });
    // A timed-out or cancelled batch still owns its physical reservation.
    if (this.flight) {
      const flight = this.flight;
      if (flight.completed) return Promise.resolve(unknownDarwinMemory(this.total()));
      return flight.result.then(value => flight.epoch === this.epoch ? { ...value } : unknownDarwinMemory(this.total()));
    }
    const epoch = ++this.epoch, totalBytes = this.total(), deadlineAt = this.now() + DARWIN_MEMORY_DEADLINE_MS;
    const unknown = unknownDarwinMemory(totalBytes);
    const commands: MemoryCommand[] = [];
    let settle!: (value: HostMemory) => void;
    let completed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const result = new Promise<HostMemory>(resolve => { settle = resolve; });
    const finish = (value: HostMemory) => {
      if (completed) return;
      completed = true;
      flight.completed = true;
      if (timer) clearTimeout(timer);
      if (epoch === this.epoch) this.cache = { at: this.now(), memory: { ...value } };
      settle(value);
    };
    const cancel = () => {
      finish(unknown);
      for (const command of commands) { try { command.kill(); } catch { /* retain until close */ } }
    };
    const flight: Flight = { completed: false, epoch, result, cancel };
    this.flight = flight;
    // Start the deadline before either constructor; a slow constructor cannot earn extra time.
    timer = setTimeout(cancel, DARWIN_MEMORY_DEADLINE_MS);
    timer.unref?.();
    const requests: Array<[string, string[]]> = [["/usr/bin/vm_stat", []], ["/usr/sbin/sysctl", ["vm.swapusage"]]];
    if (this.includePressure) requests.push(["/usr/sbin/sysctl", ["kern.memorystatus_vm_pressure_level"]]);
    for (const [file, args] of requests) {
      if (this.now() >= deadlineAt) { cancel(); break; }
      try { commands.push(this.run(file, [...args])); }
      catch { commands.push({ result: Promise.resolve(null), stopped: Promise.resolve(), kill: () => {} }); }
    }
    void Promise.all(commands.map(command => command.result.catch(() => null))).then(outputs => {
      if (completed) return;
      if (epoch !== this.epoch || this.now() >= deadlineAt) { cancel(); return; }
      const available = outputs[0] === null || outputs[0] === undefined ? null : parseDarwinAvailable(outputs[0], totalBytes);
      finish({ ...(available === null ? unknown : { totalBytes, availableBytes: available, availableKind: "available" as const,
        ...parseDarwinSwap(outputs[1] ?? "") }), darwinPressureLevel: parseDarwinPressureLevel(outputs[2] ?? ""),
        darwinPressureRaw: outputs[2]?.slice(0, 1024) ?? null });
    });
    // Never release on kill request/result alone. Rejected cleanup remains reserved.
    void Promise.all(commands.map(command => command.stopped.catch(() => new Promise<void>(() => {})))).then(() => {
      if (this.flight === flight) this.flight = null;
    });
    return result.then(value => ({ ...value }));
  }

  stop(): void {
    this.epoch++;
    this.cache = null;
    this.flight?.cancel();
  }
}
