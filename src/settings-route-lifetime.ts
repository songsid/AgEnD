/** A single server card's route lifetime, including only its own confirmed stop. */
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
  async followStop(name: string, begin: () => Promise<unknown>): Promise<void> {
    if (name !== this.name) { if (!this.current()) throw Error("Settings route expired"); await begin(); return; }
    if (this.followed || !this.current()) throw Error("Settings route expired before its owned stop");
    this.followed = true; this.stopping = true;
    try {
      const before = this.expected, pending = begin();
      // No await between starting this exact stop and adopting exactly its one invalidation.
      // Another stop/restart advances again and remains stale, including while this stop awaits.
      this.expected = before + 1;
      if (!this.current()) { await pending; throw Error("Settings route stop was superseded"); }
      await pending;
      if (!this.current()) throw Error("Settings route stop was superseded");
    } finally { this.stopping = false; }
  }
}
