/** Actual owned work, including legacy calls. Caller timeout/disconnect is not completion evidence. */
export class RequestContextPendingWork {
  private readonly counts = new Map<string, number>();
  private version = 0;
  get revision(): number { return this.version; }
  count(instance: string): number { return this.counts.get(instance) ?? 0; }
  begin(instance: string): () => void {
    if (!instance) throw Error("Pending work requires an owned instance");
    this.counts.set(instance, this.count(instance) + 1); this.version++;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const remaining = this.count(instance) - 1;
      if (remaining) this.counts.set(instance, remaining); else this.counts.delete(instance);
      this.version++;
    };
  }
  /** Preserve synchronous handlers and throws; promises remain registered until their actual settlement. */
  run<T>(instance: string, work: () => T): T {
    const finish = this.begin(instance);
    try {
      const result = work();
      if (result && typeof (result as { then?: unknown }).then === "function") {
        return Promise.resolve(result).finally(finish) as T;
      }
      finish(); return result;
    } catch (error) { finish(); throw error; }
  }
}
