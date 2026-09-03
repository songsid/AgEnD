/**
 * Fleet-level "is this CLI's backend reachable?" memory.
 *
 * Some failures are a property of the BACKEND, not of one instance: when
 * runtime.us-east-1.kiro.dev stopped answering (2026-09-03, hours), every kiro
 * instance printed the same `dispatch failure (timeout)` line every 10s, every
 * `--resume` launch sat blank past its startup budget, and the daemon's
 * "resume failed → clear the session and start fresh" fallback turned a
 * transient outage into permanent conversation loss across the fleet.
 *
 * One tracker per fleet, keyed by backend name. Sightings come from the
 * lifecycle's pty_error handler (running instances) and from the daemon's
 * startup path (a failed launch whose pane shows the outage text). "Active"
 * means seen within the last BACKEND_OUTAGE_ACTIVE_MS; nothing has to report
 * recovery — the memory simply ages out once the CLI stops printing the error.
 */

/**
 * How long after the last sighting a backend is still considered down.
 *
 * Longer than the longest startup-retry backoff (15 min) plus a startup budget:
 * in an all-down fleet nothing is running to refresh the memory, and a retry
 * that begins after it expired would clear the session it was meant to keep.
 * Recovery is also cleared POSITIVELY — a successful `--resume` launch on the
 * backend proves it reachable (see Daemon.spawnClaudeWindow) — so the long TTL
 * costs nothing once the service is back.
 */
export const BACKEND_OUTAGE_ACTIVE_MS = 20 * 60_000;

export interface BackendOutageSighting {
  firstSeenAt: number;
  lastSeenAt: number;
  /** Last human-readable detail (the formatted error message), if any. */
  detail?: string;
  /** Instances that reported it during this outage. */
  instances: Set<string>;
}

export class BackendOutageTracker {
  private readonly outages = new Map<string, BackendOutageSighting>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Record a sighting. Returns `isNew` when this opens an outage (first
   * sighting, or the previous one had aged out) — the moment to notify.
   */
  record(backend: string, instance?: string, detail?: string): { isNew: boolean; sighting: BackendOutageSighting } {
    const now = this.now();
    const existing = this.outages.get(backend);
    if (existing && now - existing.lastSeenAt < BACKEND_OUTAGE_ACTIVE_MS) {
      existing.lastSeenAt = now;
      if (detail) existing.detail = detail;
      if (instance) existing.instances.add(instance);
      return { isNew: false, sighting: existing };
    }
    const sighting: BackendOutageSighting = {
      firstSeenAt: now,
      lastSeenAt: now,
      detail,
      instances: new Set(instance ? [instance] : []),
    };
    this.outages.set(backend, sighting);
    return { isNew: true, sighting };
  }

  isActive(backend: string): boolean {
    const sighting = this.outages.get(backend);
    return !!sighting && this.now() - sighting.lastSeenAt < BACKEND_OUTAGE_ACTIVE_MS;
  }

  /** The active sighting, or null once it has aged out. */
  active(backend: string): BackendOutageSighting | null {
    return this.isActive(backend) ? this.outages.get(backend)! : null;
  }

  /** Forget a backend (e.g. an operator-confirmed recovery). */
  clear(backend: string): void {
    this.outages.delete(backend);
  }
}

/** The subset a Daemon needs; lets tests pass a plain object. */
export interface BackendOutageView {
  isActive(backend: string): boolean;
  record(backend: string, instance?: string, detail?: string): { isNew: boolean };
  clear(backend: string): void;
}
