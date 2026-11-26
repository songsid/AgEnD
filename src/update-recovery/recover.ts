/**
 * M-3770 slice 2.1c (design update-transaction §6): the recovery kit's program, bundled into one file,
 * `dist/recover.cjs` (scripts/build-recover.mjs), that runs on the kit's own Node with the package being replaced
 * missing or broken. It imports only the journal, the lock modules and node built-ins (a test checks the bundle runs
 * alone).
 *
 *   recover.cjs --home <home> --attempt <id> --pre-start   the service's pre-start step (§6.2): decide, hand on, exit
 *   recover.cjs --home <home> --attempt <id> --run         the independent runner (§6.2, §7; runner.ts)
 *
 * `--attempt` is the attempt the service's route (drop-in or wrapper) was written for; the handoff file is its.
 *
 * Exit codes: 0 the start goes on (--pre-start) or the recovery is done (--run); 1 refused (the reason on stderr);
 * 2 a usage error.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { processStart, startTicks, bootId, exists } from "../../launcher/install-admission.cjs";
import { defaultJournalIo, isAttemptId, ownerState, readCurrent, type JournalIo, type LivenessDeps } from "../update-journal.js";
import { applyHandoffEnv, preStartDecision } from "./pre-start.js";
import { launchRunner, runRecovery, type LaunchDeps, type RunnerDeps } from "./runner.js";

export const RECOVER_VERSION = 1;

export interface RecoverDeps {
  liveness: LivenessDeps;
  io: JournalIo;
  err(line: string): void;
  out(line: string): void;
  /** The runner's own identity and lock probes. */
  runner: Pick<RunnerDeps, "pid" | "lock">;
  /** The pre-start step's launch of the runner. */
  launch: Omit<LaunchDeps, "liveness" | "io">;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const defaultRecoverDeps = (): RecoverDeps => ({
  liveness: { processStart, startTicks, bootId, exists },
  io: defaultJournalIo,
  err: line => process.stderr.write(line + "\n"),
  out: line => process.stdout.write(line + "\n"),
  runner: {
    pid: process.pid,
    lock: { processStart, startTicks, bootId, exists, newToken: () => randomBytes(16).toString("hex"), now: () => new Date(), log: () => {} },
  },
  launch: {
    run: (command, args) => { const r = spawnSync(command, args, { stdio: "ignore", timeout: 15_000 }); return r.error ? null : r.status; },
    sleep: sleepSync,
    now: () => Date.now(),
    uid: () => (typeof process.getuid === "function" ? process.getuid() : 0),
  },
});

export function parseArgs(argv: string[]): { home: string; attempt: string; mode: "pre-start" | "run" } | null {
  let home: string | null = null, attempt: string | null = null, mode: "pre-start" | "run" | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home" && argv[i + 1] && home === null) home = argv[++i]!;
    else if (a === "--attempt" && argv[i + 1] && attempt === null) attempt = argv[++i]!;
    else if (a === "--pre-start" && !mode) mode = "pre-start";
    else if (a === "--run" && !mode) mode = "run";
    else return null;
  }
  return home && attempt && mode && isAbsolute(home) && isAttemptId(attempt) ? { home, attempt, mode } : null;
}

export function main(argv: string[], deps: RecoverDeps = defaultRecoverDeps()): number {
  const args = parseArgs(argv);
  if (!args) { deps.err("usage: recover.cjs --home <absolute home> --attempt <attempt id> (--pre-start | --run)"); return 2; }
  const { home, attempt } = args;
  if (args.mode === "run") return runRecovery(home, attempt, { ...deps.runner, liveness: deps.liveness, io: deps.io, err: deps.err, out: deps.out });
  const read = readCurrent(home, deps.io);
  const owner = read.state === "open" ? ownerState(home, read.attempt, deps.liveness, deps.io) : "gone";
  const decision = preStartDecision(home, read, owner, attempt);
  try { applyHandoffEnv(home, decision, attempt, deps.io); }
  catch (err) {
    deps.err(`AgEnD's update pre-start check couldn't write the handoff (${(err as Error).message}). This start is refused.`);
    return 1;
  }
  switch (decision.kind) {
    case "start": return 0;
    case "handoff": deps.out(`AgEnD update attempt ${decision.attemptId}: this start takes the planned handoff.`); return 0;
    case "refuse": deps.err(decision.reason); return 1;
    case "start-runner": {
      // §6.2: start the independent runner outside this service's cgroup and job, wait for its handshake, and refuse
      // this start either way — the runner owns the service's next transition.
      if (read.state !== "open") return 1;                           // start-runner is only ever an open attempt's row
      const launched = launchRunner(home, read.attempt, { ...deps.launch, liveness: deps.liveness, io: deps.io });
      deps.err(launched.started
        ? `Update attempt ${decision.attemptId} (${decision.stage}) was interrupted: its updater is gone. The recovery runner (pid ${launched.pid}) took over; this start is refused.`
        : `Update attempt ${decision.attemptId} (${decision.stage}) was interrupted: its updater is gone. This start is refused; ${launched.reason}`);
      return 1;
    }
  }
}
