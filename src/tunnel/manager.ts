/**
 * One managed tunnel at a time, and never one nobody is tracking.
 *
 * The provider knows how to run cloudflared. This knows the two rules that make
 * running it safe: the lease is written before a child can exist and removed
 * only after a death is proven, and a start that fails does not report failure
 * until it has proven the child it created is gone. A "clean" fallback running
 * beside a live tunnel is the failure this exists to prevent.
 */
import { randomBytes } from "node:crypto";
import { probeProcess } from "../web-terminal.js";
import { clearLease, manualCleanupMessage, reapStaleTunnel, writeLease, type ReapOptions, type ReapOutcome } from "./lease.js";
import {
  TunnelStartError,
  type TunnelHandle,
  type TunnelProvider,
  type TunnelStartContext,
  type TunnelStopResult,
} from "./types.js";

export interface ManagedTunnelOptions extends ReapOptions {
  dataDir: string;
  log?: (message: string) => void;
}

export type ManagedStartResult =
  | { readonly ok: true; readonly handle: TunnelHandle }
  | { readonly ok: false; readonly errorKind: string; readonly message: string; readonly leaseHeld: boolean };

/**
 * Owns the fleet-wide managed-tunnel lease.
 *
 * Fleet-wide rather than per-caller: the lease outlives the process that wrote
 * it, so "am I already running one" is a question about the machine, not about
 * this object.
 */
export class ManagedTunnel {
  private inFlight: Promise<ManagedStartResult> | null = null;
  private active: TunnelHandle | null = null;
  /** Set when a stop could not be proven; blocks every later start in this process. */
  private blocked: string | null = null;

  constructor(private readonly opts: ManagedTunnelOptions) {}

  private log(message: string): void { (this.opts.log ?? (() => {}))(message); }

  get handle(): TunnelHandle | null { return this.active; }

  /** Clear whatever a previous run left behind. Safe to call from any process. */
  async reap(): Promise<ReapOutcome> {
    const outcome = await reapStaleTunnel(this.opts.dataDir, this.opts);
    if (outcome.kind === "manual") {
      this.blocked = manualCleanupMessage(outcome);
      this.log(this.blocked);
    }
    return outcome;
  }

  /**
   * Single-flight: two concurrent callers get the same attempt, not two tunnels.
   *
   * The guard is set synchronously before the first await, because "check then
   * await then set" is how two callers both find it free.
   */
  start(provider: TunnelProvider, ctx: TunnelStartContext): Promise<ManagedStartResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.doStart(provider, ctx).finally(() => { this.inFlight = null; });
    this.inFlight = run;
    return run;
  }

  private async doStart(provider: TunnelProvider, ctx: TunnelStartContext): Promise<ManagedStartResult> {
    if (this.blocked) {
      return { ok: false, errorKind: "lease-held", message: this.blocked, leaseHeld: true };
    }
    if (this.active) {
      return { ok: false, errorKind: "lease-held", message: "a managed tunnel is already running", leaseHeld: true };
    }

    const outcome = await this.reap();
    if (outcome.kind === "held") {
      return {
        ok: false, errorKind: "lease-held", leaseHeld: true,
        message: `another process (pid ${outcome.ownerPid}) already owns the managed tunnel`,
      };
    }
    if (outcome.kind === "manual") {
      return { ok: false, errorKind: "lease-held", message: manualCleanupMessage(outcome), leaseHeld: true };
    }

    // Reserved before the spawn, not after: between these two writes a child
    // may come into existence, and a crash in that window must leave evidence
    // rather than silence.
    writeLease(this.opts.dataDir, {
      sid: ctx.sid,
      provider: provider.name,
      originPort: Number(ctx.origin.port),
      providerPid: null,
      strongIdentity: null,
      expiresAt: ctx.expiresAt,
      ownerPid: process.pid,
    });

    let handle: TunnelHandle;
    try {
      handle = await provider.start(ctx);
    } catch (err) {
      const startError = err instanceof TunnelStartError ? err : null;
      if (startError?.unconfirmed) {
        // A child exists and we cannot prove otherwise. The lease stays, and so
        // does the block: this is the one case where doing nothing further is
        // the correct, and only honest, behaviour.
        writeLease(this.opts.dataDir, {
          sid: ctx.sid,
          provider: provider.name,
          originPort: Number(ctx.origin.port),
          providerPid: startError.unconfirmed.pid,
          strongIdentity: startError.unconfirmed.identity,
          expiresAt: ctx.expiresAt,
          ownerPid: process.pid,
        });
        this.blocked = `A tunnel process could not be confirmed stopped after a failed start`
          + `${startError.unconfirmed.pid !== null ? ` (pid ${startError.unconfirmed.pid})` : ""}. `
          + "No new tunnel will be opened until it is resolved.";
        this.log(this.blocked);
        return { ok: false, errorKind: startError.errorKind, message: this.blocked, leaseHeld: true };
      }
      // The provider proved its child is gone (or never made one), so the lease
      // describes nothing and may go.
      clearLease(this.opts.dataDir);
      return {
        ok: false,
        errorKind: startError?.errorKind ?? "spawn-failed",
        message: (err as Error).message,
        leaseHeld: false,
      };
    }

    writeLease(this.opts.dataDir, {
      sid: ctx.sid,
      provider: provider.name,
      originPort: Number(ctx.origin.port),
      providerPid: handle.pid,
      strongIdentity: handle.identity,
      expiresAt: ctx.expiresAt,
      ownerPid: process.pid,
    });
    this.active = handle;
    return { ok: true, handle };
  }

  /**
   * Stop the active tunnel and release the lease — but only on proof.
   *
   * An unconfirmed stop keeps the lease and blocks the next start. The caller
   * gets the result rather than an exception precisely so it cannot forget to
   * say so out loud.
   */
  async stop(reason: string): Promise<TunnelStopResult> {
    const handle = this.active;
    if (!handle) return { confirmed: true };
    const result = await handle.stop(reason);
    this.active = null;
    if (result.confirmed) {
      clearLease(this.opts.dataDir);
      return result;
    }
    this.blocked = `A tunnel could not be confirmed closed`
      + `${result.pid !== null ? ` (pid ${result.pid})` : ""}: ${result.reason}. `
      + "No new tunnel will be opened until it is resolved.";
    this.log(this.blocked);
    return result;
  }
}

/** A tunnel's opaque id. Not a credential — it identifies, it does not authorize. */
export function newTunnelSid(): string {
  return randomBytes(16).toString("hex");
}

export { probeProcess };
