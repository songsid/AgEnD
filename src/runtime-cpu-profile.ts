import { performance } from "node:perf_hooks";
import { stat } from "node:fs/promises";
import { CPU_PROFILE_ENV, cpuProfileSeconds, startCpuProfileFromEnvironment, type CpuProfile } from "./cpu-profile.js";

export interface ProfileResult { path: string; bytes: number | null; }
export interface ProfileTicket { seconds: number; done: Promise<ProfileResult>; }
interface Logger { info(message: string): void; warn(message: string): void; }
type Starter = typeof startCpuProfileFromEnvironment;
interface Recording {
  deadline: number;
  startup: Promise<CpuProfile | null>;
  done: Promise<ProfileResult>;
  resolve(result: ProfileResult): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  finishing?: Promise<void>;
}

export class ProfileBusyError extends Error {
  constructor(readonly remainingSeconds: number) { super(`A CPU profile is already recording or finishing (${remainingSeconds}s remaining).`); }
}

export function profileDuration(value?: string | number): number {
  return cpuProfileSeconds({ [CPU_PROFILE_ENV]: String(value ?? 60) })!;
}

/** One owner for startup-env, local operator and General recordings. No effect until start. */
export class RuntimeCpuProfiler {
  private active: Recording | null = null;
  private closing = false;
  constructor(private readonly options: { dataDir: string; logger: Logger; start?: Starter }) {}

  get closed(): boolean { return this.closing; }

  async start(value?: string | number): Promise<ProfileTicket> {
    const seconds = profileDuration(value);
    if (this.closing) throw new Error("Fleet is stopping; CPU profiling is unavailable.");
    if (this.active) throw new ProfileBusyError(Math.max(0, Math.ceil((this.active.deadline - performance.now()) / 1000)));
    let resolve!: Recording["resolve"], reject!: Recording["reject"];
    const done = new Promise<ProfileResult>((yes, no) => { resolve = yes; reject = no; });
    // Startup can fail before a caller gets a ticket; still let ticket holders observe rejection.
    void done.catch(() => {});
    const recording: Recording = { deadline: performance.now() + seconds * 1000, startup: Promise.resolve(null), done, resolve, reject };
    this.active = recording; // reserve before the first await / native startup
    recording.startup = Promise.resolve().then(() => (this.options.start ?? startCpuProfileFromEnvironment)({
      dataDir: this.options.dataDir, logger: this.options.logger, env: { [CPU_PROFILE_ENV]: String(seconds) },
    }));
    try {
      const handle = await recording.startup;
      if (!handle) throw new Error("CPU profiler could not start; see daemon.log.");
      if (this.closing || this.active !== recording) {
        await this.finish(recording, "startup superseded by shutdown");
        throw new Error("Fleet stopped during CPU profile startup.");
      }
      const expire = (): void => {
        if (this.active !== recording || recording.finishing) return;
        const remaining = recording.deadline - performance.now();
        if (remaining > 0) { recording.timer = setTimeout(expire, Math.ceil(remaining)); recording.timer.unref?.(); }
        else void this.finish(recording, "duration cap");
      };
      recording.timer = setTimeout(expire, Math.max(0, Math.ceil(recording.deadline - performance.now())));
      recording.timer.unref?.();
      return { seconds, done };
    } catch (err) {
      await this.finish(recording, "startup failed");
      throw err;
    }
  }

  async startFromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<CpuProfile | null> {
    try {
      const seconds = cpuProfileSeconds(env);
      if (seconds === null) return null;
      await this.start(seconds);
      return { stop: reason => this.shutdown(reason) };
    } catch (err) { this.options.logger.warn(String(err)); return null; }
  }

  /** Fence new starts synchronously, including requests racing a pending native start. */
  shutdown(reason = "fleet shutdown"): Promise<string | null> {
    this.closing = true;
    const current = this.active;
    if (!current) return Promise.resolve(null);
    void this.finish(current, reason);
    return current.done.then(result => result.path, () => null);
  }

  private finish(recording: Recording, reason: string): Promise<void> {
    recording.finishing ??= (async () => {
      clearTimeout(recording.timer);
      try {
        const handle = await recording.startup;
        const path = await handle?.stop(reason);
        if (!path) throw new Error("CPU profile was not saved; see daemon.log.");
        let bytes: number | null = null;
        const deadline = performance.now() + 2000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const info = await Promise.race([stat(path), new Promise<never>((_yes, no) => {
            timer = setTimeout(() => no(new Error("Profile size lookup timed out")), 2000);
          })]);
          if (performance.now() < deadline && info.isFile()) bytes = info.size;
        } catch { /* a saved path remains useful if its size cannot be read */ }
        finally { clearTimeout(timer); }
        recording.resolve({ path, bytes });
      } catch (err) { recording.reject(err instanceof Error ? err : new Error(String(err))); }
      finally { if (this.active === recording) this.active = null; }
    })();
    return recording.finishing;
  }
}
