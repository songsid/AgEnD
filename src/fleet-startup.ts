/** Presentation for one boot, separate from process status and the spawn gate (#2398). */
export class FleetStartup {
  private readonly entries: Map<string, { phase: "queued" | "starting" | "ready" | "failed"; owner?: object }>;

  constructor(names: readonly string[]) {
    this.entries = new Map(names.map(name => [name, { phase: "queued" }]));
  }

  begin(name: string): object | null {
    if (!this.entries.has(name)) return null;
    const owner = {};
    this.entries.set(name, { phase: "starting", owner });
    return owner;
  }

  finish(name: string, owner: object, ready: boolean): boolean {
    if (this.entries.get(name)?.owner !== owner) return false;
    this.entries.set(name, { phase: ready ? "ready" : "failed" });
    return true;
  }

  phase(name: string): "queued" | "starting" | undefined {
    const phase = this.entries.get(name)?.phase;
    return phase === "queued" || phase === "starting" ? phase : undefined;
  }

  snapshot(): { phase: "starting"; ready: number; total: number; failed: number } {
    const entries = [...this.entries.values()];
    return { phase: "starting", ready: entries.filter(e => e.phase === "ready").length,
      total: entries.length, failed: entries.filter(e => e.phase === "failed").length };
  }
}
