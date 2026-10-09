import { parseContextPercent, parseTokenContextRatio, type TokenContextRatio } from "./context-percent.js";

/** Captured pane owner; the producer keeps this operation permanently revoked after replacement/stop. */
export interface PaneContextSource {
  readonly owner: object;
  readonly generation: string;
  isCurrent(): boolean;
  /** Production uses the manager's bounded control-mode read lane (60 lines, 2s including queueing). */
  capture(): Promise<string>;
}

export interface PaneContextValue {
  context: number | null;
  tokenRatio: TokenContextRatio | null;
}

const empty = (): PaneContextValue => ({ context: null, tokenRatio: null });
interface Entry {
  instance: string;
  backend: string;
  source: PaneContextSource;
  at: number;
  value: PaneContextValue;
  inFlight: boolean;
}

/** One refresh per current pane owner; transport fallback belongs to its bounded manager read lane. */
export class PaneContextCache {
  private entries = new Map<string, Entry>();
  constructor(private now: () => number = () => performance.now()) {}

  private key(dataDir: string, instance: string): string { return JSON.stringify([dataDir, instance]); }
  private current(source: PaneContextSource): boolean {
    try { return source.isCurrent(); } catch { return false; }
  }

  resolve(dataDir: string, instance: string, backend: string, source?: PaneContextSource | null): PaneContextValue {
    const key = this.key(dataDir, instance);
    if (!source || !this.current(source)) { this.entries.delete(key); return empty(); }
    let entry = this.entries.get(key);
    if (!entry || entry.backend !== backend || entry.source.owner !== source.owner
        || entry.source.generation !== source.generation || !this.current(entry.source)) {
      entry = { instance, backend, source, at: -Infinity, value: empty(), inFlight: false };
      this.entries.set(key, entry);
    }
    if (!entry.inFlight && this.now() - entry.at >= 8_000) {
      entry.inFlight = true;
      void this.refresh(key, entry);
    }
    return { ...entry.value };
  }

  record(dataDir: string, instance: string, backend: string, value: PaneContextValue, source?: PaneContextSource | null): void {
    if (!source || !this.current(source)) return;
    this.entries.set(this.key(dataDir, instance), { instance, backend, source, at: this.now(), value, inFlight: false });
  }

  forget(instance: string): void {
    for (const [key, entry] of this.entries) if (entry.instance === instance) this.entries.delete(key);
  }

  private async refresh(key: string, entry: Entry): Promise<void> {
    let value = empty();
    try {
      if (!this.current(entry.source)) return;
      const pane = await entry.source.capture();
      if (!this.current(entry.source)) return;
      const tokenRatio = entry.backend === "grok" ? parseTokenContextRatio(pane) : null;
      value = { context: tokenRatio?.percentage ?? parseContextPercent(pane), tokenRatio };
    } catch { /* unavailable remains unknown, as with the prior scrape */ }
    finally {
      // Forget/re-create, cancel, stop, respawn and a new pane cannot accept this old result.
      if (this.entries.get(key) === entry) {
        if (!this.current(entry.source)) this.entries.delete(key);
        else { entry.value = value; entry.at = this.now(); entry.inFlight = false; }
      }
    }
  }
}
