/** Synchronous admission/accounting primitive. Physical work and journal checks remain the caller's obligation. */
export interface RuntimeUpdateFence {
  readonly id: string;
  current(): boolean;
  release(): void;
  /** Irreversible: after the paired handoff commits, no new work is admitted by this process. */
  commit(): void;
}
export class RuntimeUpdateActivity {
  private readonly work = new Set<symbol>();
  private fence: object | undefined;
  private closed = false;
  get pending(): number { return this.work.size; }
  get accepting(): boolean { return !this.closed && this.fence === undefined; }
  enter(): () => void {
    if (!this.accepting) throw Error("Runtime update is holding new work");
    const token = Symbol(); this.work.add(token);
    return () => { this.work.delete(token); };
  }
  /** Registers ownership before invoking even a synchronous/reentrant callback. */
  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    const leave = this.enter();
    try { return await operation(); } finally { leave(); }
  }
  tryFence(id: string, current: () => boolean, physicallyIdle: () => boolean): RuntimeUpdateFence | undefined {
    if (!this.accepting || this.work.size) return undefined;
    const owner = {}; this.fence = owner;
    const valid = () => !this.closed && this.fence === owner && this.work.size === 0 && current() === true;
    const release = () => { if (!this.closed && this.fence === owner) this.fence = undefined; };
    try {
      if (!valid() || physicallyIdle() !== true || !valid()) { release(); return undefined; }
    } catch (error) { release(); throw error; }
    return { id, current: valid, release, commit: () => {
      if (!valid() || physicallyIdle() !== true || !valid()) throw Error("Runtime update idle proof is no longer current");
      this.closed = true;
    } };
  }
  /** Normal shutdown may close admission while previously owned work is still unwinding. */
  close(): void { this.closed = true; }
}
