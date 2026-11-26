/**
 * M-3770 slice 2.1c (design update-transaction §6): the recovery kit's program, bundled into one file,
 * `dist/recover.cjs` (scripts/build-recover.mjs), that runs on the kit's own Node with the package being replaced
 * missing or broken. It imports only the journal, the lock modules and node built-ins (a test checks the bundle runs
 * alone).
 *
 *   recover.cjs --home <home> --pre-start   the service's pre-start step (§6.2): decide, hand the nonce on, exit
 *   recover.cjs --home <home> --run         the independent runner (§6.2, §7): slice 2.1c part 2
 *
 * Exit codes: 0 the start goes on; 1 refused (the reason on stderr); 2 a usage error.
 */
import { isAbsolute } from "node:path";
import { processStart, startTicks, bootId, exists } from "../../launcher/install-admission.cjs";
import { defaultJournalIo, ownerState, readCurrent, type JournalIo, type LivenessDeps } from "../update-journal.js";
import { applyHandoffEnv, operatorCommand, preStartDecision } from "./pre-start.js";

export const RECOVER_VERSION = 1;

export interface RecoverDeps { liveness: LivenessDeps; io: JournalIo; err(line: string): void; out(line: string): void }

export const defaultRecoverDeps = (): RecoverDeps => ({
  liveness: { processStart, startTicks, bootId, exists },
  io: defaultJournalIo,
  err: line => process.stderr.write(line + "\n"),
  out: line => process.stdout.write(line + "\n"),
});

export function parseArgs(argv: string[]): { home: string; mode: "pre-start" | "run" } | null {
  let home: string | null = null, mode: "pre-start" | "run" | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home" && argv[i + 1]) home = argv[++i]!;
    else if (a === "--pre-start" && !mode) mode = "pre-start";
    else if (a === "--run" && !mode) mode = "run";
    else return null;
  }
  return home && mode && isAbsolute(home) ? { home, mode } : null;
}

export function main(argv: string[], deps: RecoverDeps = defaultRecoverDeps()): number {
  const args = parseArgs(argv);
  if (!args) { deps.err("usage: recover.cjs --home <absolute home> (--pre-start | --run)"); return 2; }
  const { home } = args;
  const read = readCurrent(home, deps.io);
  if (args.mode === "run") {
    deps.err(`The recovery runner is not in this kit yet (M-3770 2.1c part 2). Journal: ${read.state}.`);
    return 1;
  }
  const owner = read.state === "open" ? ownerState(home, read.attempt, deps.liveness, deps.io) : "gone";
  const decision = preStartDecision(home, read, owner);
  const attemptId = read.state === "none" || read.state === "unknown" ? null : read.attempt.id;
  try { applyHandoffEnv(home, decision, attemptId, deps.io); }
  catch (err) {
    deps.err(`AgEnD's update pre-start check couldn't write the handoff (${(err as Error).message}). This start is refused.`);
    return 1;
  }
  switch (decision.kind) {
    case "start": return 0;
    case "handoff": deps.out(`AgEnD update attempt ${decision.attemptId}: this start takes the planned handoff.`); return 0;
    case "refuse": deps.err(decision.reason); return 1;
    case "start-runner":
      // Part 2 starts the independent runner here (systemd-run / launchctl submit) and waits for its handshake.
      deps.err(`Update attempt ${decision.attemptId} (${decision.stage}) was interrupted: its updater is gone. This start is refused; recover it with ${operatorCommand(home, decision.attemptId)}`);
      return 1;
  }
}
