import { ManagedTunnel, type ManagedStartResult } from "./manager.js";
import type { TunnelProvider, TunnelStartContext, TunnelStopResult } from "./types.js";

export interface TunnelReservation {
  start(provider: TunnelProvider, context: TunnelStartContext): Promise<ManagedStartResult>;
  /**
   * Stop this reservation's tunnel. `alsoProven` (#1723): another tunnel the holder ran beside it (the public link's
   * preview) — the lane is released only once BOTH are proven stopped, and the first unproven one is the result.
   */
  stop(reason: string, alsoProven?: Promise<TunnelStopResult>): Promise<TunnelStopResult>;
  releaseUnused(): void;
}
const unproven = (): TunnelStopResult => ({ confirmed: false, reason: "stop failed", pid: null, identity: null });
/** One actual manager, claimed before installer/listener awaits. Different origins never join. */
export class TunnelPurposeLane {
  private owner: { purpose: string; id: string; reservation: TunnelReservation } | null = null;
  constructor(private readonly manager: Pick<ManagedTunnel, "start" | "stop">) {}
  reserve(purpose: "login" | "dashboard", id: string): TunnelReservation | null {
    if (this.owner) return this.owner.purpose === purpose && this.owner.id === id ? this.owner.reservation : null;
    let stopped = true;
    let starting: Promise<ManagedStartResult> | undefined;
    let stopping: Promise<TunnelStopResult> | undefined;
    const release = (): void => { if (stopped && this.owner?.reservation === reservation) this.owner = null; };
    const reservation: TunnelReservation = {
      start: (provider, context) => {
        if (this.owner?.reservation !== reservation) return Promise.reject(new Error("lost tunnel reservation"));
        if (starting) return starting;
        stopped = false;
        starting = this.manager.start(provider, context).then(result => {
          if (!result.ok && !result.leaseHeld) stopped = true;
          return result;
        });
        return starting;
      },
      stop: (reason, alsoProven) => {
        // Observed now, before any wait: a companion stop that fails while this one is still running is an unproven
        // result here, never an unhandled rejection.
        const other = alsoProven?.then(r => r, unproven);
        return stopping ??= (async () => {
          await starting?.catch(() => {});
          const own = await this.manager.stop(reason).catch(unproven);
          const result = !own.confirmed ? own : other ? await other : own;
          stopped = result.confirmed;
          release();
          return result;
        })();
      },
      releaseUnused: release,
    };
    this.owner = { purpose, id, reservation };
    return reservation;
  }
}
