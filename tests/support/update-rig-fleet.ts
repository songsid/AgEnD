// M-3770 part 7 (design update-wiring-m3770.md §10.7): a STAND-IN fleet for the scratch end-to-end rig — never
// `agend fleet start` (a scratch-HOME fleet start has killed live tmux windows on this host). It takes fleet.lock exactly
// as claimFleetSingleton does (fleetStartGate, then acquireFleetLock with the journal's single-use handoff claim), writes
// fleet.pid, and answers the attempt's control mailbox the way a real fleet's pass would: barrier.arm (held, unless
// RIG_BUSY), trial.prove (healthy, unless RIG_UNHEALTHY), the commit steps (done), and an abandon's hand-back walk.
// It records what it did in <home>/rig-events.log and stops cleanly on SIGTERM (fleet.lock and fleet.pid released).
//   node --import tsx tests/support/update-rig-fleet.ts <home> <label>
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { acquireFleetLock, releaseFleetLock } from "../../src/fleet-lock.js";
import { serviceLockSenderLive } from "../../src/service-lock.js";
import { serveControl } from "../../src/update-control.js";
import { claimHandoff, fleetStartGate, readCurrent } from "../../src/update-journal.js";
import { QuiescenceBarrier, handbackDue } from "../../src/update-quiescence.js";

const [home, label] = [process.argv[2]!, process.argv[3] ?? "fleet"];
const say = (line: string) => appendFileSync(join(home, "rig-events.log"), `${label} ${process.pid} ${line}\n`);
const admission = createRequire(import.meta.url)("../../launcher/install-admission.cjs") as { processStart(pid: number): string | null; startTicks(pid: number): string | null; bootId(): string | null; exists(pid: number): boolean };
const liveness = { processStart: admission.processStart, startTicks: admission.startTicks, bootId: admission.bootId, exists: admission.exists };

const gate = fleetStartGate(home, process.env.AGEND_UPDATE_HANDOFF ?? null, liveness);
if (!gate.ok) { say(`refused: ${gate.reason}`); process.exit(3); }
let lock: ReturnType<typeof acquireFleetLock>;
try {
  lock = acquireFleetLock(home, {
    claimHandoff: (attemptId, nonce, pid) => {
      const processStart = admission.processStart(pid);
      if (!processStart) return false;
      const ticks = admission.startTicks(pid), boot = admission.bootId();
      return claimHandoff(home, attemptId, nonce, { pid, start: { processStart, ...(ticks !== null && boot !== null ? { startTicks: ticks, bootId: boot } : {}) } }, liveness);
    },
  });
} catch (err) { say(`no lock: ${(err as Error).message}`); process.exit(4); }
writeFileSync(join(home, "fleet.pid"), `${process.pid}\n`);
const self = { nonce: lock.record.nonce, pid: process.pid };
say(`up nonce=${self.nonce}`);

const done = { status: "ok" as const, value: "done" };
const timer = setInterval(() => {
  try {
    serveControl(home, {
      self, senderLive: sender => serviceLockSenderLive(home, sender, liveness),
      handlers: {
        "status": () => ({ status: "ok", value: self }),
        "barrier.arm": () => { const v = process.env.RIG_BUSY === "1" ? "busy" : "held"; say(`barrier ${v}`); return { status: "ok", value: v }; },
        "trial.prove": () => {
          const healthy = process.env.RIG_UNHEALTHY !== "1";
          say(`prove ${healthy ? "healthy" : "unhealthy"}`);
          return { status: "ok", value: { nonce: self.nonce, pid: self.pid, healthy, problems: healthy ? [] : ["the rig says unhealthy"], adapters: { total: 0, connected: 0 } } };
        },
        "commit.leaveTrial": () => { say("commit leaveTrial"); return done; },
        "commit.startAgents": () => { say("commit startAgents"); return done; },
        "commit.deliverInbox": () => { say("commit deliverInbox"); return done; },
        "commit.runDeferred": () => { say("commit runDeferred"); return done; },
      },
    });
    const read = readCurrent(home);
    if (read.state === "open" && handbackDue(read.attempt, self)) {
      const r = new QuiescenceBarrier(home).runHandback(read.attempt, {
        log: () => {}, lookup: () => null, claim: () => "missing", admitCopy: () => null, runDeferred: () => {}, recordInterrupted: () => {},
      }, self);
      if (r.walked) say(`hand-back walked acked=${r.acked}`);
    }
  } catch (err) { say(`pass failed: ${(err as Error).message}`); }
}, 100);

process.on("SIGTERM", () => {
  clearInterval(timer);
  try { releaseFleetLock(lock); } catch { /* gone */ }
  try { unlinkSync(join(home, "fleet.pid")); } catch { /* gone */ }
  say("stopped");
  process.exit(0);
});
