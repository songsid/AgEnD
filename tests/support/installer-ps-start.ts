/** A test-run-scoped cold-start reservation; ready workers release it before cases. */
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Leave one core for the test runner and two per .NET/bootstrap compiler.
export const installerPsStartSlots = (cores: number) => Math.max(1, Math.floor((cores - 1) / 2));
export interface InstallerPsStartTicket { release(): void; }

export class InstallerPsStartGate {
  constructor(private root: string, readonly slots: number) {
    if (!Number.isInteger(slots) || slots < 1) throw Error("Invalid pwsh START capacity");
  }
  tryAcquire(): InstallerPsStartTicket | undefined {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (let slot = 0; slot < this.slots; slot++) {
      const file = join(this.root, `slot-${slot}`);
      let fd: number;
      try { fd = openSync(file, "wx", 0o600); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; throw e; }
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
      finally { closeSync(fd); }
      let released = false;
      return { release() { if (released) return; released = true; unlinkSync(file); } };
    }
    return undefined;
  }
  async acquire(): Promise<InstallerPsStartTicket> {
    const deadline = performance.now() + 30_000;
    do {
      const ticket = this.tryAcquire(); if (ticket) return ticket;
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    // A dead worker's reservation is deliberately not guessed away. The run's
    // temporary root is cleaned by Vitest; this invocation fails closed.
    throw Error("pwsh START queue exceeded 30 s (reservation still owned or abandoned)");
  }
}
