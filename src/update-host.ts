/**
 * M-3770 slice 2.5, wiring part 5 (design update-wiring-m3770.md §2, §14): the updater's hands on a real host — the
 * proofs the transaction checks before each mutation (`live`), the service manager (systemd, or a detached fleet), the
 * takeover wait, the state-lease drain and the recovery kit's sources. Process effects go through an injected
 * `HostEnv`, so each is testable without systemd or a fleet; `realHostEnv()` is the one place they are real.
 *
 * What the install runs on is proven where `agend restart` proves it (restart-guard / service-activation): a systemd
 * service's LOADED ExecStart (D-Bus argv, never `systemctl show`'s joined text) must name its Node explicitly —
 * `<node> <package>/dist/cli.js fleet start`; the older script form leaves the Node to PATH and is not proven here (the
 * update then refuses to open, as `agend restart` refuses it). A detached fleet runs on this updater's own Node.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { spawn } from "./child-process.js";
import { readFleetLockRecord } from "./fleet-lock.js";
import { fsOwnershipDeps, proveOwnership, readArtifactTuple, type OwnedService, type Ownership, type OwnershipDeps, type Proven, type TupleRead } from "./install-ownership.js";
import { parsePlist, readLoadedUnit } from "./service-activation.js";
import { takeExclusiveLease, type Lease } from "./state-lease.js";
import type { KitSources } from "./update-recovery/kit.js";
import type { RollbackDeps } from "./update-rollback.js";
import { serviceManager } from "./update-recovery/service-manager.js";

type Check = { ok: true } | { ok: false; reason: string };

export interface HostEnv {
  run(command: string, args: string[]): { status: number | null; stdout: string; stderr?: string; signal?: NodeJS.Signals | null };
  uid(): number;
  sleep(ms: number): void;
  now(): number;
  realpath(path: string): string | null;
  readFile(path: string): string | null;
  /** Does `pid` exist (false only for a definite "no such process")? */
  exists(pid: number): boolean;
  /** Send `signal` to `pid`; false when it couldn't be sent. */
  kill(pid: number, signal: NodeJS.Signals): boolean;
  /** Start `command args` detached from this process, with `env` added; false when it couldn't be started. */
  spawnDetached(command: string, args: string[], env: Record<string, string>): boolean;
  /** The Node this updater runs on. */
  execPath: string;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function realHostEnv(): HostEnv {
  return {
    run: (command, args) => {
      const r = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
      return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", signal: r.signal };
    },
    uid: () => (typeof process.getuid === "function" ? process.getuid() : 0),
    sleep: sleepSync,
    now: () => performance.now(),
    realpath: path => { try { return realpathSync(path); } catch { return null; } },
    readFile: path => { try { return readFileSync(path, "utf8"); } catch { return null; } },
    exists: pid => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; } },
    kill: (pid, signal) => { try { process.kill(pid, signal); return true; } catch { return false; } },
    spawnDetached: (command, args, env) => {
      try {
        const child = spawn(command, args, { detached: true, stdio: "ignore", env: { ...process.env, ...env } });
        child.unref();
        return true;
      } catch { return false; }
    },
    execPath: process.execPath,
  };
}

const inside = (dir: string, path: string) => { const rel = relative(dir, path); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); };

/**
 * The service's effective start command, argv[0] the program: systemd's LOADED unit over D-Bus; launchd's plist on
 * disk (launchd keeps Phase 1 until S-260 — read for the record only). null when it can't be read.
 */
export function serviceExecStart(service: OwnedService, x: HostEnv): string[] | null {
  if (service.kind === "systemd") {
    const loaded = readLoadedUnit((c, a) => { const r = x.run(c, a); return { status: r.status, signal: r.signal ?? null, stdout: r.stdout, stderr: r.stderr ?? "" }; }, x.uid() !== 0, service.unit);
    return loaded.ok ? [loaded.unit.tuple.program, ...loaded.unit.tuple.argv.slice(1)] : null;
  }
  const xml = x.readFile(service.fragmentPath);
  const tuple = xml === null ? null : parsePlist(xml);
  return tuple ? [tuple.program, ...tuple.argv.slice(1)] : null;
}

/**
 * The Node the install runs on, proven independently of the package's own files (Prism #4502 3): a service names it
 * explicitly — its start command is `<node> <package>/dist/cli.js fleet start`, the program a real `node` and the entry
 * inside the proven package; a detached fleet runs on this updater's own Node. Anything else: null (not proven).
 */
export function interpreterOf(ownership: Ownership, x: HostEnv): string | null {
  if (!ownership.service) return x.realpath(x.execPath);
  const argv = serviceExecStart(ownership.service, x);
  if (!argv || argv.length !== 4 || argv[2] !== "fleet" || argv[3] !== "start") return null;
  const node = x.realpath(argv[0]!), entry = x.realpath(argv[1]!), pkg = x.realpath(ownership.packagePath);
  if (!node || basename(node) !== "node" || !entry || !pkg || !inside(pkg, entry)) return null;
  return node;
}

export function hostOwnershipDeps(x: HostEnv): OwnershipDeps {
  return fsOwnershipDeps({ interpreterFor: o => interpreterOf(o, x), execStart: s => serviceExecStart(s, x) });
}

/** `runUpdate`'s `live()`: ownership proven again and the artifact tuple read, from the recorded inputs. */
export function liveHand(input: { home: string; prefix: string; service: OwnedService | null }, x: HostEnv): () => { ownership: Proven<Ownership>; tuple: TupleRead } {
  const deps = hostOwnershipDeps(x);
  return () => {
    const ownership = proveOwnership(input, deps);
    const tuple: TupleRead = ownership.ok ? readArtifactTuple(ownership.value, deps)
      : { state: "partial", reason: ownership.reason, paths: [], interpreter: null, execStart: null, unresolved: [] };
    return { ownership, tuple };
  };
}

/** How long a fleet has to take fleet.lock over, and to stop, before the updater gives up on it. */
export const TAKEOVER_MS = 60_000, STOP_MS = 60_000, POLL_MS = 250;

/**
 * The service manager for the attempt's service: systemd through service-manager.ts (the route's pre-start step hands
 * the nonce on); a detached fleet (no service) by this updater — its fleet.lock holder signalled and awaited, and a new
 * fleet started from the install's own launcher with the handoff in its environment.
 */
export function updaterManager(home: string, service: OwnedService | null, bin: string, x: HostEnv): RollbackDeps["manager"] {
  if (service) return serviceManager(service, { run: (c, a) => { const r = x.run(c, a); return { status: r.status, stdout: r.stdout }; }, uid: x.uid(), sleep: x.sleep, now: x.now });
  const fleetPid = () => { const rec = readFleetLockRecord(home); return rec?.role === "fleet" && x.exists(rec.pid) ? rec.pid : null; };
  return {
    mainPid: fleetPid,
    stop: () => {
      const pid = fleetPid();
      if (pid === null) return true;
      if (!x.kill(pid, "SIGTERM")) return !x.exists(pid);
      const until = x.now() + STOP_MS;
      for (;;) { if (!x.exists(pid)) return true; if (x.now() >= until) return false; x.sleep(POLL_MS); }
    },
    reload: () => true,
    start: handoff => x.spawnDetached(bin, ["fleet", "start"], { AGEND_UPDATE_HANDOFF: handoff.nonce, AGEND_FLEET_START_DIRECT: "1" }),
  };
}

/** Wait (bounded) for fleet.lock to hold a `fleet` record with this nonce: its pid, or null. */
export function waitTakeover(home: string, x: HostEnv, timeoutMs = TAKEOVER_MS): (nonce: string) => number | null {
  return nonce => {
    const until = x.now() + timeoutMs;
    for (;;) {
      const rec = readFleetLockRecord(home);
      if (rec?.role === "fleet" && rec.nonce === nonce) return rec.pid;
      if (x.now() >= until) return null;
      x.sleep(POLL_MS);
    }
  };
}

/** `runUpdate`'s `drain()`: the state lease taken exclusively (60 s), kept by the caller until the terminal write. */
export function drainHand(home: string, keep: (lease: Lease) => void, take: (home: string) => ReturnType<typeof takeExclusiveLease> = h => takeExclusiveLease(h)): () => Check {
  return () => {
    const r = take(home);
    if (!r.ok) return { ok: false, reason: r.reason };
    keep(r.lease);
    return { ok: true };
  };
}

/** The recovery kit's sources: this (old) install's Node and its bundled runner, beside its CLI. */
export function kitSources(cliEntry: string, x: HostEnv): KitSources {
  return { nodePath: x.realpath(x.execPath) ?? x.execPath, bundlePath: join(dirname(cliEntry), "recover.cjs") };
}
