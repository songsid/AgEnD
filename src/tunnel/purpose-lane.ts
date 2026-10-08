import { ManagedTunnel, type ManagedStartResult } from "./manager.js";
import type { TunnelProvider, TunnelStartContext, TunnelStopResult } from "./types.js";

export interface TunnelReservation {
  start(provider: TunnelProvider, context: TunnelStartContext): Promise<ManagedStartResult>;
  stop(reason: string): Promise<TunnelStopResult>;
  releaseUnused(): void;
}
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
      stop: reason => stopping ??= (async () => {
        await starting?.catch(() => {});
        const result = await this.manager.stop(reason).catch(() => ({ confirmed: false as const, reason: "stop failed", pid: null, identity: null }));
        stopped = result.confirmed;
        release();
        return result;
      })(),
      releaseUnused: release,
    };
    this.owner = { purpose, id, reservation };
    return reservation;
  }
}
