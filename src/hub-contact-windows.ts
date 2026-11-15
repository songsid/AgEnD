/** Fleet-owned contact windows survive Hub disconnect/disable and Fleet restart. No question text is retained. */
import { lstatSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
export const HUB_CONTACT_WINDOW_MS = 30 * 60_000;
type Window = { agent: string; correlationId: string; expiresAt: number };
export class HubContactWindows {
  private rows: Window[] | null = null;
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}
  private load(): Window[] {
    if (this.rows) return this.rows;
    try {
      const st = lstatSync(this.file);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) throw Error("Invalid Hub contact windows");
      const rows: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(rows) || rows.length > 4096 || !rows.every(r => r && typeof r.agent === "string" && typeof r.correlationId === "string" && Number.isSafeInteger(r.expiresAt))) throw Error("Invalid Hub contact windows");
      this.rows = rows;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; this.rows = []; }
    return this.rows;
  }
  restricted(agent: string): boolean {
    try { return this.load().some(r => r.agent === agent && r.expiresAt > this.now()); }
    catch { return true; } // Unreadable state cannot grant contact permission.
  }
  begin(agent: string, correlationId: string): void {
    const rows = this.load().filter(r => r.expiresAt > this.now());
    if (rows.some(r => r.agent === agent && r.correlationId === correlationId)) return; // retries do not extend a window
    if (rows.length >= 4096) throw Error("Too many Hub contact windows");
    rows.push({ agent, correlationId, expiresAt: this.now() + HUB_CONTACT_WINDOW_MS });
    atomicWriteFileSync(this.file, JSON.stringify(rows), { mode: 0o600 }); this.rows = rows;
  }
  answered(agent: string, correlationId: string): void {
    const rows = this.load().filter(r => r.expiresAt > this.now() && !(r.agent === agent && r.correlationId === correlationId));
    atomicWriteFileSync(this.file, JSON.stringify(rows), { mode: 0o600 }); this.rows = rows;
  }
}
