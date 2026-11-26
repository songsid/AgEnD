/**
 * M-3770 slice 2.5, wiring part 5 (design update-wiring-m3770.md §2, §14): `agend update`'s Phase 2 — the update
 * transaction on a real host, once `selectUpdatePhase` chose it. This updater (the OLD install's):
 *   1. takes the three locks in order — home, prefix, service — and proves the install and its artifact tuple;
 *   2. opens the attempt with that identity and the running fleet as generation `old`;
 *   3. drives it with `runUpdate` and the real hands (update-hands, update-host);
 *   4. committed: refreshes the service definition from the committed install — after the terminal write, before the
 *      locks go (Fable) — a failure being a warning and a notice, never a rollback;
 *   5. releases the state lease and the locks in reverse.
 * Every effect is injected, so the whole sequence runs against a scratch home with stand-in fleets.
 */
import { readFleetLockRecord } from "./fleet-lock.js";
import { plistProgramArguments } from "./plist-args.js";
import { acquireHomeUpdateLock } from "./home-update-lock.js";
import { acquireInstallLock, type InstallLock, type InstallLockDeps } from "./install-lock.js";
import { openingIdentity, type OwnedService } from "./install-ownership.js";
import { acquireServiceLock } from "./service-lock.js";
import type { Lease } from "./state-lease.js";
import { defaultJournalIo, newAttemptId, openAttempt, type JournalIo, type LivenessDeps, type ProcessStartRecord } from "./update-journal.js";
import { runUpdate, type UpdateDeps, type UpdateResult } from "./update-forward.js";
import { barrierHand, commitHands, installHand, proveHand, refreshServiceDefinition, type InstallHandEnv, type RefreshOutcome } from "./update-hands.js";
import { drainHand, kitSources, liveHand, updaterManager, waitTakeover, type HostEnv } from "./update-host.js";
import { handedBack } from "./update-recovery/runner.js";

export interface Phase2Input {
  home: string;
  /** The exact target. */
  target: { name: string; version: string };
  /** The npm global prefix this install lives in (its realpath). */
  prefix: string;
  /** The attempt's service (systemd only in Phase 2), or null for a detached fleet. */
  service: OwnedService | null;
  /** The running (old) install's CLI entry, `<package>/dist/cli.js`: the kit's runner is bundled beside it. */
  cliEntry: string;
}

export interface Phase2Env {
  host: HostEnv;
  liveness: LivenessDeps;
  lockDeps: InstallLockDeps;
  /** This process: its pid and start (the attempt's updater). */
  self: { pid: number; start: ProcessStartRecord };
  hex8(): string;
  date(): Date;
  /** The install hand's process runner (npm exec), and the refresh's. */
  installEnv: Omit<InstallHandEnv, "readFile">;
  /** §4.4's writers proof, with this updater exempt. */
  proveWritersGone(): { ok: true } | { ok: false; reason: string };
  /** Abandon's hand-back wait (bounded) until `done()`. */
  waitHandedBack(done: () => boolean): boolean;
  takeLease?: Parameters<typeof drainHand>[2];
  log(line: string): void;
  io?: JournalIo;
}

export type Phase2Result =
  | { ran: false; reason: string }
  | { ran: true; result: UpdateResult; refresh?: RefreshOutcome };

export function runTransactionUpdate(i: Phase2Input, x: Phase2Env): Phase2Result {
  const io = x.io ?? defaultJournalIo;
  const spec = `${i.target.name}@${i.target.version}`;
  const held: InstallLock[] = [];
  let lease: Lease | null = null;
  const releaseAll = () => { lease?.release(); lease = null; for (const l of held.splice(0).reverse()) if (l.ok) l.release(); };
  try {
    // 1. home → prefix → service (§3.4), each proven free or its holder proven gone.
    const home = acquireHomeUpdateLock(i.home, { spec, installPrefix: i.prefix }, x.lockDeps);
    if (!home.ok) return { ran: false, reason: home.reason };
    held.push(home);
    const prefix = acquireInstallLock(i.prefix, { spec, agendHome: i.home }, x.lockDeps);
    if (!prefix.ok) return { ran: false, reason: prefix.reason };
    held.push(prefix);
    const id = newAttemptId(x.date(), x.hex8());
    const service = acquireServiceLock(i.home, id, x.lockDeps);
    if (!service.ok) return { ran: false, reason: service.reason };
    held.push(service);
    const live = liveHand({ home: i.home, prefix: i.prefix, service: i.service }, x.host);
    const now = live();
    if (!now.ownership.ok) return { ran: false, reason: `the install can't be proven: ${now.ownership.reason}` };
    if (now.tuple.state !== "complete") return { ran: false, reason: `the installed AgEnD can't be read whole: ${now.tuple.reason}` };
    const ownership = now.ownership.value, old = now.tuple.tuple;
    // 2. The attempt, with the running fleet (its fleet.lock record, alive) as generation `old`.
    const rec = readFleetLockRecord(i.home);
    const oldFleet = rec?.role === "fleet" && x.host.exists(rec.pid) ? { pid: rec.pid, nonce: rec.nonce } : null;
    const opened = openAttempt(i.home, { id, kind: "update", updater: x.self, from: { name: i.target.name, version: old.version, integrity: old.integrity },
      to: { name: i.target.name, version: i.target.version, integrity: null }, extra: openingIdentity(ownership, old, oldFleet, x.date()) }, io);
    if (!opened.ok) return { ran: false, reason: opened.reason };
    x.log(`  Updating AgEnD v${old.version} → v${i.target.version} (update ${id})`);
    // 3. The hands.
    const bin = ownership.binLinks.agend;
    const mailbox = { from: { pid: x.self.pid, token: service.token }, sleep: x.host.sleep, now: x.host.now, log: x.log, io };
    const deps: UpdateDeps = {
      self: x.self, liveness: x.liveness, isProcessAlive: pid => x.host.exists(pid),
      proveWritersGone: () => x.proveWritersGone(),
      plistArgs: plistProgramArguments,
      manager: updaterManager(i.home, i.service, bin, x.host),
      waitTakeover: waitTakeover(i.home, x.host),
      barrier: barrierHand(i.home, oldFleet, mailbox),
      drain: drainHand(i.home, l => { lease = l; }, x.takeLease),
      kit: kitSources(i.cliEntry, x.host),
      install: () => installHand({ name: i.target.name, version: i.target.version, packagePath: ownership.packagePath, prefixToken: prefix.token },
        { ...x.installEnv, readFile: p => x.host.readFile(p) }),
      live,
      prove: proveHand(i.home, id, mailbox),
      commit: commitHands(i.home, id, mailbox),
      handBack: a => x.waitHandedBack(() => handedBack(i.home, a.id, io)),
      io,
    };
    const result = runUpdate(i.home, opened.attempt, { target: { name: i.target.name, version: i.target.version, integrity: null }, command: [] }, deps);
    // 4. Committed: the service definition from the committed install, under the locks still held.
    if (result.ok) {
      const refresh = refreshServiceDefinition({ bin, version: i.target.version, service: i.service }, { run: x.host.run, readFile: x.host.readFile, uid: x.host.uid });
      return { ran: true, result, refresh };
    }
    return { ran: true, result };
  } finally {
    releaseAll();
  }
}

/** What `agend update` prints for a Phase 2 result, and the one-time notice a refresh warning leaves (Fable). */
export function phase2Words(r: Phase2Result, version: string): { lines: string[]; exitCode: number; notice: string | null; command?: string } {
  if (!r.ran) return { lines: [`  ✗ Not updated: ${r.reason}. Nothing was changed.`], exitCode: 1, notice: null };
  const res = r.result;
  if (!res.ok) {
    const how = res.outcome === "rolled-back" ? "the previous version runs again" : res.outcome === "abandoned" ? "nothing was changed"
      : res.outcome === "manual" ? "it needs a person: run `agend update --resolve`" : "it resumes on the next fleet start";
    return { lines: [`  ✗ Not updated to v${version}: ${res.reason} — ${how}.`], exitCode: 1, notice: null };
  }
  const lines = [`  ✓ Updated to v${version}.`];
  const f = r.refresh;
  let notice: string | null = null;
  if (f?.kind === "refreshed" || f?.kind === "unchanged") lines.push(`  ${f.note}`);
  else if (f) { notice = `${f.warning}. Run \`${f.command}\` to refresh it.`; lines.push(`  ⚠ ${notice}`); return { lines, exitCode: 0, notice, command: f.command }; }
  return { lines, exitCode: 0, notice };
}
