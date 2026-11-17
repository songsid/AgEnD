/** A Classic room's private Hub turn survives report ACK, expiry and restart. Never stores question/answer content. */
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";

interface PrivateTurn { agent: string; correlationId: string; token: string; since: number }

export class HubClassicPrivateTurns {
  private rows: PrivateTurn[] | null = null;
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  private load(): PrivateTurn[] {
    if (this.rows) return this.rows;
    try {
      const st = lstatSync(this.file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) throw Error("Invalid private Hub turns");
      const rows: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(rows) || rows.length > 4096 || !rows.every(r => r && typeof r.agent === "string"
        && typeof r.correlationId === "string" && typeof r.token === "string" && Number.isSafeInteger(r.since) && r.since >= 0)) {
        throw Error("Invalid private Hub turns");
      }
      this.rows = rows;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.rows = [];
    }
    return this.rows;
  }

  blocked(agent: string): boolean {
    try { return this.load().some(r => r.agent === agent); }
    catch { return true; }
  }
  read(agent: string): Readonly<PrivateTurn> | null { return this.load().find(r => r.agent === agent) ?? null; }

  begin(agent: string, correlationId: string): void {
    const rows = this.load();
    if (rows.some(r => r.agent === agent && r.correlationId === correlationId)) return;
    const next = rows.filter(r => r.agent !== agent);
    if (next.length >= 4096) throw Error("Too many private Hub turns");
    next.push({ agent, correlationId, token: randomUUID(), since: this.now() });
    atomicWriteFileSync(this.file, JSON.stringify(next), { mode: 0o600 });
    this.rows = next;
  }

  /** A current room-person input, accepted after fresh idle and completed Hub work, may reopen output. */
  resume(agent: string, token: string): boolean {
    if (this.read(agent)?.token !== token) return false;
    const next = this.load().filter(r => r.agent !== agent);
    atomicWriteFileSync(this.file, JSON.stringify(next), { mode: 0o600 });
    this.rows = next;
    return true;
  }
}
