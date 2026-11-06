/**
 * M-2457 PR C §7: `agend rollback <2.3.x>`, run by the outgoing version. 2.3.x runs the SYSTEM tmux on the DEFAULT
 * socket and knows nothing of AgEnD's private one, so the private server must be gone, positively, before 2.3.x
 * starts (else an agent could run twice). In order, each step must succeed before the next:
 *  1. stop the fleet (its daemons checkpoint every session id, as an update does) and see its process gone;
 *  2. end the private server with the client server.json names (or, unproven, the recorded pid; §6 rule 2), and confirm:
 *     the server pid gone, the socket refusing, and every pane process it ran exited;
 *  3. write <AGEND_HOME>/rollback.json ({ from, to, closedAt }): the checkpoint 2.3.x resumes from;
 *  4. only then `npm install -g @songsid/agend@<version>`, and start the service on it.
 * A failed or unknown close stops the rollback before npm runs: nothing is installed, this version stays, and the
 * message says what is still running. A failed install leaves this version installed with the fleet stopped.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readServerRecord, reconcileServer, realProbes, sha256File, socketPath, type ServerProbes } from "./tmux-server.js";

export interface RollbackDeps {
  agendHome: string;
  from: string;
  to: string;
  /** The bundled tmux's socket (null: the bundled tmux was never on here — nothing private to close). */
  socket: string | null;
  stopFleet(): Promise<{ ok: boolean; detail: string }>;
  fleetGone(): Promise<boolean>;
  install(version: string): Promise<{ ok: boolean; detail: string }>;
  startService(): Promise<{ ok: boolean; detail: string }>;
  probes?: ServerProbes;
  out(line: string): void;
}

export type RollbackResult =
  | { ok: true }
  | { ok: false; stage: "stop" | "close" | "install" | "start"; message: string };

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export async function rollback(d: RollbackDeps): Promise<RollbackResult> {
  if (!VERSION.test(d.to)) return { ok: false, stage: "stop", message: `"${d.to}" is not a version (e.g. 2.3.4).` };
  const p = d.probes ?? realProbes;

  // 1. Stop, and see it gone (a SIGTERMed foreground fleet checkpoints on its way out).
  const stop = await d.stopFleet();
  if (!stop.ok) return { ok: false, stage: "stop", message: `The fleet did not stop (${stop.detail}). Nothing else was done.` };
  if (!(await d.fleetGone())) return { ok: false, stage: "stop", message: "The fleet process is still running. Nothing else was done; stop it, then run agend rollback again." };
  d.out("  ✓ Fleet stopped (session ids checkpointed)");

  // 2. The private server: ended by its recorded client, positively; its pane processes exited.
  if (d.socket) {
    const path = socketPath(d.socket);
    if (await p.accepts(path)) {
      const rec = readServerRecord(d.agendHome);
      let panes: number[] = [];
      if (rec) {
        try {
          if (sha256File(rec.binary) === rec.sha256) {
            panes = (await p.run(rec.binary, ["-L", d.socket, "list-panes", "-a", "-F", "#{pane_pid}"])).split("\n").map(Number).filter(n => Number.isSafeInteger(n) && n > 1);
          }
        } catch { /* the close below decides */ }
      }
      // Not this version's pin (a sentinel no copy can have), so the recorded server is always ended, never kept.
      const why = await reconcileServer({ agendHome: d.agendHome, socket: d.socket, current: { binary: "(rollback)", sha256: "0".repeat(64) }, probes: p });
      if (why) return { ok: false, stage: "close", message: `Rollback stopped before installing anything: ${why.replace(/ Nothing was stopped and no agent was started\..*$/, "")}. Still on ${d.from}; agend start brings the fleet back.` };
      const living = async () => { const out: number[] = []; for (const pid of panes) if (await p.proc(pid)) out.push(pid); return out; };
      let left = await living();
      for (let i = 0; i < 100 && left.length; i++) { await p.sleep(100); left = await living(); }
      if (left.length) return { ok: false, stage: "close", message: `Rollback stopped before installing anything: agent processes ${left.join(", ")} from AgEnD's tmux are still running. Still on ${d.from}.` };
    }
    d.out("  ✓ AgEnD's own tmux server closed (confirmed)");
  }

  // 3. The checkpoint 2.3.x resumes from.
  writeFileSync(join(d.agendHome, "rollback.json"), JSON.stringify({ from: d.from, to: d.to, closedAt: new Date().toISOString() }, null, 2) + "\n");

  // 4. Only now the older version.
  const inst = await d.install(d.to);
  if (!inst.ok) return { ok: false, stage: "install", message: `npm could not install ${d.to} (${inst.detail}). Still on ${d.from} with the fleet stopped; agend start brings it back.` };
  d.out(`  ✓ Installed ${d.to}`);
  const started = await d.startService();
  if (!started.ok) return { ok: false, stage: "start", message: `${d.to} is installed but did not start (${started.detail}). Run agend start.` };
  d.out(`  ✓ Started on ${d.to}`);
  return { ok: true };
}
