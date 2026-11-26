/**
 * M-3770 slice 2.5, wiring part 5 (design update-wiring-m3770.md §2, §3, §10.1): the updater's hands — what `runUpdate`
 * is given on a real host. Built up piece by piece; each hand takes its process effects through an injected runner, so
 * the sequence is testable without npm, a service manager or a fleet.
 *
 * The install hand (D1): the TARGET release's own installer in its install-only mode, under this updater's prefix lock
 * (its token handed over), then the installed package's own `agend.updateTx` read again (§10.1) — a release that
 * doesn't speak the transaction after all is rolled back, never trialled.
 */
import { join, parse } from "node:path";
import { MIN_UPDATE_TX, updateTxOf } from "./update-phase.js";
import { askFleet, commitHandsOverMailbox, nextControlSeq, proveTrial, type CommitAskDeps } from "./update-control.js";
import { defaultJournalIo, readCurrent, type AttemptRecord, type JournalIo } from "./update-journal.js";
import type { CommitHands } from "./update-forward.js";

type Check = { ok: true } | { ok: false; reason: string };

export interface InstallHandInput {
  /** The exact target: `@songsid/agend` and its version (never a tag). */
  name: string;
  version: string;
  /** The proven install's package directory (`<prefix>/lib/node_modules/@songsid/agend`). */
  packagePath: string;
  /** This updater's prefix-lock token: the installer is admitted by it (AGEND_INSTALL_TOKEN). */
  prefixToken: string;
}

export interface InstallHandEnv {
  run(command: string, args: string[], opts: { env: Record<string, string>; cwd: string }): { status: number | null; signal?: string | null };
  readFile(path: string): string | null;
  /** The environment the installer runs in (this process's, by default). */
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/** The install-only installer's exit codes (launcher/agend-install.cjs installOnlyUnderUpdate). */
const NOT_ADMITTED = 75;

export function installHand(i: InstallHandInput, x: InstallHandEnv): Check {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(i.version)) return { ok: false, reason: `the target ${i.version} isn't an exact version` };
  const spec = `${i.name}@${i.version}`;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(x.env ?? process.env)) if (typeof v === "string") env[k] = v;
  env.AGEND_INSTALL_TOKEN = i.prefixToken;
  // M-3812: from the filesystem root, so npm exec never runs a project's own node_modules/.bin first.
  const done = x.run("npm", ["exec", "--yes", "--package", spec, "--", "agend-install", "--install-only", "--target", i.version],
    { env, cwd: parse(x.cwd ?? process.cwd()).root });
  if (done.status === NOT_ADMITTED) return { ok: false, reason: `the installer of ${spec} wasn't admitted under this update's prefix lock` };
  if (done.status !== 0) return { ok: false, reason: `the installer of ${spec} failed (exit ${done.status ?? done.signal ?? "unknown"})` };
  // §10.1: the INSTALLED package.json, read again — its version and its own V_tx, before any trial.
  let pkg: unknown = null;
  try { pkg = JSON.parse(x.readFile(join(i.packagePath, "package.json")) ?? "null"); } catch { pkg = null; }
  const installed = (pkg as { name?: unknown; version?: unknown } | null);
  if (!installed || installed.name !== i.name || installed.version !== i.version) {
    return { ok: false, reason: `after the install, ${i.packagePath} isn't ${spec}` };
  }
  const tx = updateTxOf(pkg);
  if (tx < MIN_UPDATE_TX) return { ok: false, reason: `the installed ${spec} doesn't speak the update transaction (agend.updateTx ${tx})` };
  return { ok: true };
}

// ── The mailbox hands: the old fleet's barrier, the trial's proof, the new fleet's commit steps (parts 2–4) ─────────

export interface MailboxHandEnv {
  /** This updater: its pid and its service-lock token (Fable rule 2). */
  from: { pid: number; token: string };
  sleep(ms: number): void;
  now(): number;
  pollMs?: number;
  log?(line: string): void;
  io?: JournalIo;
}

/** The open attempt's acknowledged, live `trial` generation (its nonce and pid), read from the journal now. */
function trialGeneration(home: string, attemptId: string, io: JournalIo): { nonce: string; pid: number } | null {
  const read = readCurrent(home, io);
  if (read.state !== "open" || read.attempt.id !== attemptId) return null;
  const gen = ((read.attempt.fleets ?? []) as { gen: string; nonce: string; pid?: number; consumed?: boolean; dead?: boolean }[])
    .find(g => g.gen === "trial" && g.consumed && !g.dead && g.pid !== undefined);
  return gen ? { nonce: gen.nonce, pid: gen.pid! } : null;
}

/**
 * `runUpdate`'s `barrier` (§2.3, part 2): ask the old fleet — the generation that held fleet.lock when the attempt
 * opened — to fence and check again, while the attempt is still `opened`. Only `held` from that fleet (its nonce and
 * pid) is ok; busy, refused, stale or no answer abandons (a timeout is never success). No old fleet: nothing to fence.
 */
export function barrierHand(home: string, oldFleet: { nonce: string; pid: number } | null, x: MailboxHandEnv & { timeoutMs?: number }): (attempt: AttemptRecord) => Check {
  return attempt => {
    if (!oldFleet) return { ok: true };
    const asked = askFleet(home, { seq: nextControlSeq(home, attempt.id), op: "barrier.arm", attemptId: attempt.id, stage: attempt.stage, to: { nonce: oldFleet.nonce }, from: x.from },
      { timeoutMs: x.timeoutMs ?? 30_000, pollMs: x.pollMs, sleep: x.sleep, now: x.now });
    if (!asked.ok) return { ok: false, reason: `the running fleet ${asked.reason.replace(/^the fleet /, "")}` };
    const { response } = asked;
    if (response.by.pid !== oldFleet.pid) return { ok: false, reason: `the barrier's answer came from pid ${response.by.pid}, not the running fleet's ${oldFleet.pid}` };
    if (response.result.status !== "ok") return { ok: false, reason: `the running fleet refused the barrier (${response.result.status}): ${response.result.why}` };
    if (response.result.value === "held") return { ok: true };
    return { ok: false, reason: response.result.value === "busy" ? "the fleet isn't idle" : `the fleet can't hold for the update (${String(response.result.value)})` };
  };
}

/** `runUpdate`'s `prove(trialPid)` (§5, part 3): the trial generation the journal acknowledged with that pid. */
export function proveHand(home: string, attemptId: string, x: MailboxHandEnv & { timeoutMs?: number }): (trialPid: number) => Check {
  return trialPid => {
    const io = x.io ?? defaultJournalIo;
    const trial = trialGeneration(home, attemptId, io);
    if (!trial || trial.pid !== trialPid) return { ok: false, reason: `the journal has no acknowledged trial with pid ${trialPid}` };
    const read = readCurrent(home, io);
    if (read.state !== "open") return { ok: false, reason: "the attempt isn't open" };
    return proveTrial(home, read.attempt, trial, { from: x.from, timeoutMs: x.timeoutMs, pollMs: x.pollMs, sleep: x.sleep, now: x.now });
  };
}

/** `runUpdate`'s `commit` (§5, part 4): each step asked of the trial generation the journal names at that moment. */
export function commitHands(home: string, attemptId: string, x: MailboxHandEnv & { boundsMs?: CommitAskDeps["boundsMs"] }): CommitHands {
  const ask = (step: keyof CommitHands) => (): boolean => {
    const trial = trialGeneration(home, attemptId, x.io ?? defaultJournalIo);
    if (!trial) { x.log?.(`commit step ${step}: the journal has no acknowledged trial`); return false; }
    return commitHandsOverMailbox(home, attemptId, trial, { from: x.from, pollMs: x.pollMs, boundsMs: x.boundsMs, sleep: x.sleep, now: x.now, log: x.log })[step]();
  };
  return { leaveTrial: ask("leaveTrial"), startAgents: ask("startAgents"), deliverInbox: ask("deliverInbox"), runDeferred: ask("runDeferred") };
}

// ── After the commit: the service definition refreshed from the committed install (Fable, part 5 D1 follow-up) ──────

export interface RefreshEnv {
  run(command: string, args: string[]): { status: number | null; stdout: string };
  readFile(path: string): string | null;
  uid(): number;
}

export type RefreshOutcome =
  | { kind: "refreshed"; reloaded: boolean; note: string }
  | { kind: "unchanged"; note: string }
  | { kind: "skipped" | "failed"; warning: string; command: string };

/**
 * The install-only installer writes no unit (D1), so a template change in the new release would never reach the service
 * definition. After the attempt is `committed` — the terminal write done, the home and prefix locks still held, so the
 * refresh targets exactly the committed install — the NEW install's `agend install --no-activate` writes it. Its
 * failure is a warning with the command to run, never a rollback: the version is committed. The fleet keeps running;
 * the definition applies at the next restart. systemd only (launchd keeps Phase 1 until S-260): a daemon-reload only
 * when the unit changed and the manager says it needs one.
 */
export function refreshServiceDefinition(i: { bin: string; version: string; service: { kind: "systemd" | "launchd"; unit: string; fragmentPath: string } | null }, x: RefreshEnv): RefreshOutcome {
  const command = `${i.bin} install --no-activate`;
  if (!i.service) return { kind: "unchanged", note: "no service definition to refresh (a hand-started fleet)" };
  if (i.service.kind !== "systemd") return { kind: "skipped", warning: "the launchd job isn't refreshed by this updater", command };
  const running = x.run(i.bin, ["--version"]);
  if (running.status !== 0 || running.stdout.trim() !== i.version) {
    return { kind: "skipped", warning: `${i.bin} reports ${running.stdout.trim() || "nothing"}, not v${i.version}; the service definition wasn't refreshed`, command };
  }
  const before = x.readFile(i.service.fragmentPath);
  const wrote = x.run(i.bin, ["install", "--no-activate"]);
  if (wrote.status !== 0) return { kind: "failed", warning: `the service definition couldn't be refreshed (exit ${wrote.status ?? "unknown"})`, command };
  if (x.readFile(i.service.fragmentPath) === before) return { kind: "unchanged", note: "the service definition is already current" };
  const user = x.uid() !== 0 ? ["--user"] : [];
  const shown = x.run("systemctl", [...user, "show", "-p", "NeedDaemonReload", "--value", i.service.unit]);
  let reloaded = false;
  if (shown.status === 0 && shown.stdout.trim() === "yes") {
    if (x.run("systemctl", [...user, "daemon-reload"]).status !== 0) {
      return { kind: "failed", warning: "the service definition was refreshed, but systemd couldn't reload it", command: `systemctl${user.length ? " --user" : ""} daemon-reload` };
    }
    reloaded = true;
  }
  return { kind: "refreshed", reloaded, note: "the service definition was refreshed; it applies at the next restart" };
}
