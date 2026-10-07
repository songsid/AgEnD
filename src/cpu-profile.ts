import { Session } from "node:inspector";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export const CPU_PROFILE_ENV = "AGEND_CPU_PROFILE_SECONDS";
export const CPU_PROFILE_MAX_SECONDS = 30 * 60;
export const CPU_PROFILE_MAX_BYTES = 20 * 1024 * 1024;
export const CPU_PROFILE_KEEP = 5;
const POST_TIMEOUT_MS = 2_000;
const SAVE_TIMEOUT_MS = 5_000;
const PROFILE_NAME = /^fleet-cpu-[a-zA-Z0-9-]+\.cpuprofile$/;

interface ProfileLogger { info(message: string): void; warn(message: string): void; }
export interface ProfileSession {
  connect(): void;
  disconnect(): void;
  post(method: string, params: object, callback: (err: Error | null, result?: { profile?: unknown }) => void): void;
}
export interface CpuProfile { stop(reason?: string): Promise<string | null>; }

/** No implicit/default capture. Only the OS operator's startup environment enables it. */
export function cpuProfileSeconds(env: NodeJS.ProcessEnv): number | null {
  const value = env[CPU_PROFILE_ENV];
  if (value === undefined || value === "") return null;
  if (env.AGEND_INSTANCE_NAME?.trim()) throw new Error("CPU profiling is restricted to the local fleet operator, not an agent session");
  if (!/^\d+$/.test(value)) throw new Error(`${CPU_PROFILE_ENV} must be an integer from 1 to ${CPU_PROFILE_MAX_SECONDS}`);
  const seconds = Number(value);
  if (seconds < 1 || seconds > CPU_PROFILE_MAX_SECONDS) throw new Error(`${CPU_PROFILE_ENV} must be from 1 to ${CPU_PROFILE_MAX_SECONDS}`);
  return seconds;
}

/** Bounded artifacts, not a bound on V8's native recording memory or JSON allocation. */
export async function saveCpuProfile(dataDir: string, profile: unknown, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const json = JSON.stringify(profile);
  if (json === undefined || Buffer.byteLength(json) > CPU_PROFILE_MAX_BYTES) throw new Error("CPU profile exceeds the 20 MiB artifact cap; discarded");
  const directory = join(dataDir, "profiles");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  signal?.throwIfAborted();
  const directoryStat = await lstat(directory);
  signal?.throwIfAborted();
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (process.getuid && directoryStat.uid !== process.getuid())) throw new Error("CPU profile directory must be an operator-owned real directory");
  await chmod(directory, 0o700);
  signal?.throwIfAborted();
  const previous: { path: string; mtime: number; oversized: boolean }[] = [];
  for (const name of await readdir(directory)) {
    signal?.throwIfAborted();
    if (!PROFILE_NAME.test(name)) continue; // never delete unrelated files
    const path = join(directory, name);
    const stat = await lstat(path);
    signal?.throwIfAborted();
    if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("CPU profile rotation found a non-owned or non-regular artifact");
    }
    previous.push({ path, mtime: stat.mtimeMs, oversized: stat.size > CPU_PROFILE_MAX_BYTES });
  }
  previous.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  let kept = 0;
  for (const entry of previous) {
    signal?.throwIfAborted();
    if (entry.oversized || kept >= CPU_PROFILE_KEEP - 1) await unlink(entry.path);
    else kept++;
  }
  const path = join(directory, `fleet-cpu-${process.pid}-${Math.floor(performance.now())}-${randomUUID()}.cpuprofile`);
  signal?.throwIfAborted();
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { signal?.throwIfAborted(); await file.writeFile(json, { encoding: "utf8", signal }); signal?.throwIfAborted(); }
  catch (err) { await unlink(path).catch(() => {}); throw err; }
  finally { await file.close(); }
  return path;
}

/** In-process inspector only: Session.connect does not expose a listening socket. */
export async function startCpuProfileFromEnvironment(opts: {
  dataDir: string;
  logger: ProfileLogger;
  env?: NodeJS.ProcessEnv;
  /** Test seam. No inspector/network/CLI is used by tests. */
  session?: () => ProfileSession;
  save?: (dataDir: string, profile: unknown, signal?: AbortSignal) => Promise<string>;
}): Promise<CpuProfile | null> {
  let seconds: number | null;
  try { seconds = cpuProfileSeconds(opts.env ?? process.env); }
  catch (err) { opts.logger.warn(String(err)); return null; }
  if (seconds === null) return null;

  const deadline = performance.now() + seconds * 1_000;
  let session: ProfileSession;
  try { session = opts.session?.() ?? new Session(); }
  catch (err) { opts.logger.warn(`CPU profile unavailable: ${String(err)}`); return null; }
  let stopped = false;
  let started = false;
  let stopPromise: Promise<string | null> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const post = (method: string, params: object = {}): Promise<{ profile?: unknown }> => new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let settled = false;
    const finish = (err: Error | null, result?: { profile?: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else if (performance.now() - startedAt >= POST_TIMEOUT_MS) reject(new Error(`${method} deadline exceeded`));
      else resolve(result ?? {});
    };
    const timeout = setTimeout(() => finish(new Error(`${method} timed out`)), POST_TIMEOUT_MS);
    // The awaited startup/stop must get its fallback even before fleet handles exist.
    try { session.post(method, params, finish); } catch (err) { finish(err as Error); }
  });
  const stop = (reason = "operator/shutdown"): Promise<string | null> => {
    if (stopPromise) return stopPromise;
    stopped = true; // first, before any await or late startup ACK
    clearTimeout(timer);
    stopPromise = (async () => {
      let profile: unknown;
      try {
        if (started) profile = (await post("Profiler.stop")).profile;
      } catch (err) { opts.logger.warn(`CPU profile stop failed: ${String(err)}`); }
      finally { try { session.disconnect(); } catch { /* best effort */ } }
      if (profile === undefined) return null;
      const controller = new AbortController();
      const saveDeadline = performance.now() + SAVE_TIMEOUT_MS;
      let saveTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const path = await Promise.race([
          (opts.save ?? saveCpuProfile)(opts.dataDir, profile, controller.signal),
          new Promise<never>((_resolve, reject) => {
            saveTimer = setTimeout(() => { controller.abort(); reject(new Error("CPU profile save timed out")); }, SAVE_TIMEOUT_MS);
            // Keep this finite awaited save alive through shutdown until it settles.
          }),
        ]);
        if (performance.now() >= saveDeadline) { controller.abort(); throw new Error("CPU profile save deadline exceeded"); }
        opts.logger.info(`CPU profile saved (${reason}): ${path}`);
        return path;
      } catch (err) { opts.logger.warn(`CPU profile discarded: ${String(err)}`); return null; }
      finally { clearTimeout(saveTimer); }
    })();
    return stopPromise;
  };
  const isCurrent = (): boolean => !stopped && performance.now() < deadline;
  const expire = (): void => {
    const remaining = deadline - performance.now();
    if (remaining > 0 && !stopped) { timer = setTimeout(expire, Math.ceil(remaining)); timer.unref?.(); return; }
    void stop("duration cap");
  };
  timer = setTimeout(expire, seconds * 1_000);
  timer.unref?.();
  try {
    session.connect();
    await post("Profiler.enable");
    if (!isCurrent()) { await stop("startup expired"); return null; }
    await post("Profiler.setSamplingInterval", { interval: 10_000 }); // 100 Hz
    if (!isCurrent()) { await stop("startup expired"); return null; }
    started = true; // a pending start ACK cannot outlive cancellation unnoticed
    await post("Profiler.start");
    if (!isCurrent()) { await stop("startup expired"); return null; }
    opts.logger.info(`CPU profile started for at most ${seconds}s (100 Hz, 20 MiB/file, ${CPU_PROFILE_KEEP} files); no inspector listener`);
    return { stop };
  } catch (err) {
    opts.logger.warn(`CPU profile unavailable: ${String(err)}`);
    await stop("startup failed");
    return null;
  }
}
