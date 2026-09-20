/**
 * What a tunnel provider can do, and nothing about how.
 *
 * The contract exists so the thing that owns a listener never learns a
 * provider's command line. It is deliberately narrow: a provider can be asked
 * whether it could run, asked to expose one already-listening loopback origin,
 * and asked to stop — and the answer to "did it stop" is a first-class value,
 * not an exception, because "we could not tell" is a state the caller has to
 * record and act on rather than a failure to handle.
 *
 * See `docs/design/setup-host-tunnel.zh-TW.md` for the envelope these types
 * serve, and `docs/design/web-terminal-tunnel-provider.zh-TW.md` (sol) for the
 * original provider design.
 */

export type TunnelVisibility = "public" | "tailnet" | "loopback" | "manual";

/** Why a provider cannot run, in bounded terms — never a vendor error string. */
export type TunnelErrorKind =
  | "binary-missing"
  | "binary-not-executable"
  | "not-logged-in"
  | "spawn-failed"
  | "no-url"
  | "bad-url"
  | "readiness-failed"
  | "timeout"
  | "cancelled"
  | "lease-held";

export type PreflightResult =
  | { readonly ok: true; readonly binaryPath: string }
  | { readonly ok: false; readonly errorKind: TunnelErrorKind; readonly detail: string };

export interface TunnelStartContext {
  /** Opaque id for logs and the lease; never a credential. */
  readonly sid: string;
  /** The origin to expose. Must be the loopback address the server really bound. */
  readonly origin: URL;
  /** Page path under the origin, trailing slash kept so relative assets resolve. */
  readonly pagePath: string;
  /**
   * A string that must appear in the page fetched back over the public URL.
   *
   * Readiness is not "the process is alive" or "we saw a URL" — it is "the edge
   * reaches the exact listener we meant", and only the caller knows what that
   * listener serves.
   */
  readonly readinessMarker: string;
  /** Wall clock. The tunnel may not outlive what it is fronting. */
  readonly expiresAt: number;
  readonly signal: AbortSignal;
}

export interface TunnelExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * `confirmed: false` is an outcome, not an error.
 *
 * A caller that treats it as one will write "closed safely" in a log next to a
 * process that is still running. It carries what a human needs to finish the
 * job by hand.
 */
export type TunnelStopResult =
  | { readonly confirmed: true }
  | {
      readonly confirmed: false;
      readonly reason: string;
      readonly pid: number | null;
      readonly identity: string | null;
    };

export interface TunnelHandle {
  readonly provider: string;
  readonly visibility: TunnelVisibility;
  /** Validated base, e.g. `https://<label>.trycloudflare.com`. No trailing slash. */
  readonly baseUrl: string;
  /** Where the page actually is, trailing slash intact. */
  readonly pageUrl: string;
  readonly pid: number | null;
  /** The strong fingerprint recorded at spawn, for proving death later. */
  readonly identity: string | null;
  stop(reason: string): Promise<TunnelStopResult>;
  /** Returns an unsubscribe. Fires only for an exit nobody asked for. */
  onUnexpectedExit(listener: (exit: TunnelExit) => void): () => void;
}

export interface TunnelProvider {
  readonly name: string;
  /** Can this run at all? Bounded, read-only: never installs, never logs in. */
  preflight(signal: AbortSignal): Promise<PreflightResult>;
  /** Expose one loopback origin. Rejects with a `TunnelStartError`. */
  start(ctx: TunnelStartContext): Promise<TunnelHandle>;
}

export class TunnelStartError extends Error {
  constructor(
    readonly errorKind: TunnelErrorKind,
    message: string,
    /** Present when a child was created and its death could not be confirmed. */
    readonly unconfirmed?: { readonly pid: number | null; readonly identity: string | null },
  ) {
    super(message);
    this.name = "TunnelStartError";
  }
}

/** One wall-clock budget for spawn, URL and readiness together — not per step. */
export const TUNNEL_STARTUP_DEADLINE_MS = 30_000;
/** Preflight is a stat, not a network call. */
export const TUNNEL_PREFLIGHT_TIMEOUT_MS = 5_000;
/** How long a polite stop is given before escalating, and again before giving up. */
export const TUNNEL_STOP_GRACE_MS = 5_000;
