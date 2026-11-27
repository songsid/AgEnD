/** A single server card's route lifetime, including only its own confirmed stop. */
export type SettingsStopAdvance = (before: number, after: number) => void;
export type SettingsStopOperation = (advance?: SettingsStopAdvance) => Promise<unknown>;
export class SettingsRouteLifetime {
  private expected: number;
  private stopping = false;
  private followed = false;
  constructor(readonly name: string, private readonly route: () => boolean,
    private readonly epoch: () => number, private readonly isStopping: () => boolean) {
    this.expected = epoch();
  }
  current = (): boolean => this.route() && this.epoch() === this.expected && (!this.isStopping() || this.stopping);
  /** The effect must enter the already-owned lifecycle transition synchronously. */
  async followStop(name: string, begin: SettingsStopOperation): Promise<void> {
    if (name !== this.name) { if (!this.current()) throw Error("Settings route expired"); await begin(); return; }
    if (this.followed || !this.current()) throw Error("Settings route expired before its owned stop");
    this.followed = true; this.stopping = true;
    let observed = false, finished = false;
    const advance: SettingsStopAdvance = (before, after) => {
      if (finished || !this.stopping || !this.route() || before !== this.expected || after !== before + 1 || this.epoch() !== after)
        throw Error("Settings route stop was superseded");
      observed = true; this.expected = after;
    };
    try {
      const before = this.expected, pending = begin(advance);
      // No await before accounting for the exact stop's synchronous invalidation.
      // An unrelated advance is never adopted, including while this stop awaits.
      // Legacy single-invalidation callers keep their exact contract. Lifecycle-owned stops
      // report each of their own queue/transition invalidations synchronously, never a latest epoch.
      if (!observed) this.expected = before + 1;
      if (!this.current()) { await pending; throw Error("Settings route stop was superseded"); }
      await pending;
      if (!this.current()) throw Error("Settings route stop was superseded");
    } finally { finished = true; this.stopping = false; }
  }
}
