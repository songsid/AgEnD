/** Fleet-owned contact windows survive Hub disconnect/disable and Fleet restart. No question text is retained. */
import { lstatSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
export const HUB_CONTACT_WINDOW_MS = 30 * 60_000;
type Window = { agent: string; correlationId: string; expiresAt: number };
/** A reader that throws cannot lift a window: unknown is not settled. */
function settledSafe(settled: ((agent: string, correlationId: string) => boolean) | undefined, r: Window): boolean {
  try { return settled?.(r.agent, r.correlationId) === true; } catch { return false; }
}
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
  /**
   * M-3660: `settled` says a window's question is no longer being answered (held: withdrawn, revoked, expired, replaced
   * or uncertain; released; a room answer sent). Such a window stops restricting at once, in this and every later turn.
   * Without a reader (the Hub link detached) a window holds until it expires: the question's fate is unknown.
   */
  restricted(agent: string, settled?: (agent: string, correlationId: string) => boolean): boolean {
    try { return this.load().some(r => r.agent === agent && r.expiresAt > this.now() && !settledSafe(settled, r)); }
    catch { return true; } // Unreadable state cannot grant contact permission.
  }
  /**
   * M-3660: the question whose window restricts `agent` now (its correlation id), or null — the same rule as restricted().
   * Unreadable state gives null here while restricted() still refuses: the refusal then gives the general reason.
   */
  restrictingQuestion(agent: string, settled?: (agent: string, correlationId: string) => boolean): string | null {
    try { return this.load().find(r => r.agent === agent && r.expiresAt > this.now() && !settledSafe(settled, r))?.correlationId ?? null; }
    catch { return null; }
  }
  begin(agent: string, correlationId: string): void {
    const rows = this.load().filter(r => r.expiresAt > this.now());
    if (rows.some(r => r.agent === agent && r.correlationId === correlationId)) return; // retries do not extend a window
    if (rows.length >= 4096) throw Error("Too many Hub contact windows");
    rows.push({ agent, correlationId, expiresAt: this.now() + HUB_CONTACT_WINDOW_MS });
    // M-3660: fail closed — the window holds in memory even when it cannot be saved (the caller is told by the throw).
    this.rows = rows; atomicWriteFileSync(this.file, JSON.stringify(rows), { mode: 0o600 });
  }
  /** M-3660: the agent's daemon says no Hub answer turn is running (or a different one): its other windows end. */
  closeAgent(agent: string, except?: string): void {
    const rows = this.load().filter(r => r.expiresAt > this.now() && !(r.agent === agent && r.correlationId !== except));
    this.rows = rows; atomicWriteFileSync(this.file, JSON.stringify(rows), { mode: 0o600 });
  }
  answered(agent: string, correlationId: string): void {
    const rows = this.load().filter(r => r.expiresAt > this.now() && !(r.agent === agent && r.correlationId === correlationId));
    atomicWriteFileSync(this.file, JSON.stringify(rows), { mode: 0o600 }); this.rows = rows;
  }
}
