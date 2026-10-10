import { performance } from "node:perf_hooks";
import { newTunnelSid } from "./tunnel/manager.js";
import { CloudflaredProvider } from "./tunnel/cloudflared.js";
import { CloudflaredInstallError, ensureCloudflared } from "./tunnel/cloudflared-install.js";
import { PublicLinkProgressTracker, failureOf, type PublicLinkFailure, type PublicLinkProgress } from "./public-link-progress.js";
import type { TunnelReservation } from "./tunnel/purpose-lane.js";
import type { TunnelStopResult } from "./tunnel/types.js";
import type { PublicGateway } from "./public-web-gateway.js";
import type { LoginCodeOwner } from "./web-login.js";
import type { WebConfig } from "./types.js";

export const PUBLIC_LINK_DEFAULT_MINUTES = 120;
export const PUBLIC_LINK_MAX_MINUTES = 480;
export function publicLinkSettings(web: WebConfig | undefined): { allowed: boolean; ttlMs: number; protocol: "http2" | "quic" | "auto" } {
  // Raw YAML startup does not go through the Settings validator. Enforce the
  // fixed cap here too, at the boundary every runtime consumer shares.
  const settings = web?.public_link;
  const minutes = typeof settings?.ttl_minutes === "number" && Number.isInteger(settings.ttl_minutes) && settings.ttl_minutes > 0
    ? Math.min(settings.ttl_minutes, PUBLIC_LINK_MAX_MINUTES) : PUBLIC_LINK_DEFAULT_MINUTES;
  const protocol = settings?.protocol;
  return { allowed: settings?.allow_public === undefined || settings.allow_public === true, ttlMs: minutes * 60_000,
    protocol: typeof protocol === "string" && ["http2", "quic", "auto"].includes(protocol) ? protocol : "http2" };
}
export function validPublicLinkPatch(value: unknown): value is NonNullable<WebConfig["public_link"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(k => ["allow_public", "ttl_minutes", "protocol"].includes(k))
    && (v.allow_public === undefined || typeof v.allow_public === "boolean")
    && (v.ttl_minutes === undefined || (Number.isInteger(v.ttl_minutes) && Number(v.ttl_minutes) >= 1 && Number(v.ttl_minutes) <= PUBLIC_LINK_MAX_MINUTES))
    && (v.protocol === undefined || (typeof v.protocol === "string" && ["http2", "quic", "auto"].includes(v.protocol)));
}
interface Exposure {
  id: string;
  owner: LoginCodeOwner;
  abort: AbortController;
  deadline: number;
  expiresAt: number;
  phase: "starting" | "open" | "closing" | "cleanup_unconfirmed";
  reservation: TunnelReservation;
  gateway: PublicGateway | null;
  starting: Promise<void>;
  closing?: Promise<TunnelStopResult>;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
  url?: string;
  requests: number;
  delivered: boolean;
  /** The shared start's steps (①–⑤); each request adds its own ⑥. */
  progress: PublicLinkProgressTracker;
  watchers: Set<() => void>;
}
export interface PublicLinkDelivery {
  readonly exposureId: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly isCurrent: () => boolean;
}
/** A start step that failed for a reason the user is shown. */
class StartFailure extends Error {
  constructor(readonly reason: PublicLinkFailure) { super(reason); }
}
/** Owns access before child cleanup: losing a tunnel cannot leave a public web session alive. */
export class PublicWebLink {
  private entry: Exposure | null = null;
  private readonly now: () => number;
  constructor(private readonly deps: {
    dataDir: string;
    web(): WebConfig | undefined;
    permitted(owner: LoginCodeOwner): boolean;
    reserve(id: string): TunnelReservation | null;
    createGateway(id: string, current: () => boolean, open: () => boolean, failed: () => void): PublicGateway;
    revoke(id: string): void;
    log(event: string, id: string): void;
    onCleanupUnconfirmed?(result: TunnelStopResult, owner: LoginCodeOwner): void;
    now?: () => number;
    wallNow?: () => number;
    ensure?: typeof ensureCloudflared;
    provider?: (binary: string, protocol: "http2" | "quic" | "auto") => CloudflaredProvider;
  }) { this.now = deps.now ?? (() => performance.now()); }

  get exposureId(): string | undefined { return this.entry?.id; }
  status(): { state: string; expiresAt?: number; remainingSeconds?: number } {
    const e = this.entry;
    if (e && this.now() >= e.deadline && !e.closing) void this.close("expired");
    return e ? { state: e.phase, expiresAt: e.expiresAt, remainingSeconds: Math.max(0, Math.ceil((e.deadline - this.now()) / 1000)) } : { state: "closed" };
  }
  private current(e: Exposure): boolean {
    return this.entry === e && !e.closing && !e.abort.signal.aborted && this.now() < e.deadline
      && publicLinkSettings(this.deps.web()).allowed && this.deps.permitted(e.owner);
  }
  refresh(): void {
    const e = this.entry;
    if (e && !this.current(e)) void this.close("policy or binding changed");
  }
  /** Multiple same-start requests share delivery proof: failed A may never close confirmed B. */
  /**
   * `onProgress` hears every step of this request (see public-link-progress.ts): the shared start's, then its own
   * delivery. Its last call is the final state — every step ended, or one failed.
   */
  async deliver(owner: LoginCodeOwner, send: (link: PublicLinkDelivery) => Promise<boolean>, onProgress?: (p: PublicLinkProgress) => void): Promise<boolean> {
    if (!this.deps.permitted(owner) || !publicLinkSettings(this.deps.web()).allowed) return false;
    let e = this.entry;
    if (e && (e.owner.adapterId !== owner.adapterId || e.owner.chatId !== owner.chatId || e.owner.threadId !== owner.threadId || !this.current(e))) return false;
    if (!e) {
      const settings = publicLinkSettings(this.deps.web());
      const id = newTunnelSid();
      const reservation = this.deps.reserve(id); // Before installer, listener, or any await.
      if (!reservation) {
        // The one tunnel is someone else's (a /login link, or one whose cleanup is unconfirmed): say so.
        const refused = new PublicLinkProgressTracker(this.now, () => {});
        refused.fail("lease-held");
        onProgress?.(refused.snapshot);
        return false;
      }
      e = { id, owner: { ...owner }, reservation, abort: new AbortController(), deadline: this.now() + settings.ttlMs,
        expiresAt: (this.deps.wallNow ?? Date.now)() + settings.ttlMs, phase: "starting", gateway: null, starting: Promise.resolve(), requests: 0, delivered: false,
        progress: undefined as unknown as PublicLinkProgressTracker, watchers: new Set() };
      const watched = e;
      e.progress = new PublicLinkProgressTracker(this.now, () => { for (const w of watched.watchers) w(); });
      this.entry = e;
      const captured = e;
      const expire = (): void => {
        if (this.entry !== captured || captured.closing) return;
        const remaining = captured.deadline - this.now();
        if (remaining <= 0) void this.close("expired");
        else { captured.timer = setTimeout(expire, Math.ceil(remaining)); captured.timer.unref?.(); }
      };
      expire();
      e.starting = this.start(e, settings.protocol);
      this.deps.log("requested", id);
    }
    e.requests++;
    // This request's view: the shared steps, then its own ⑥.
    const shared = e;
    let own: { startedAt: number; endedAt?: number } | undefined;
    let ownFailure: PublicLinkFailure | undefined;
    const view = (): PublicLinkProgress => {
      const base = shared.progress.snapshot;
      if (!own && !ownFailure) return base;
      const steps = own ? [...base.steps, { step: "deliver" as const, ...own }] : base.steps;
      const failedStep = own ? "deliver" as const : base.steps.at(-1)!.step;
      return { ...base, steps, ...(ownFailure && !base.failed ? { failed: { step: failedStep, reason: ownFailure } } : {}) };
    };
    const watcher = onProgress ? () => onProgress(view()) : null;
    if (watcher) { e.watchers.add(watcher); watcher(); }
    const finish = (outcome: boolean, failure?: PublicLinkFailure): boolean => {
      if (own && own.endedAt === undefined) own.endedAt = this.now();
      if (!outcome && !shared.progress.snapshot.failed) ownFailure = failure ?? "closed";
      if (watcher) { shared.watchers.delete(watcher); watcher(); }
      return outcome;
    };
    try {
      await e.starting;
      if (!this.current(e) || !this.deps.permitted(owner) || !e.url) return finish(false);
      own = { startedAt: this.now() };
      watcher?.();
      const delivered = await send({ exposureId: e.id, url: e.url, expiresAt: e.expiresAt, isCurrent: () => this.current(e!) && this.deps.permitted(owner) });
      if (!delivered) return finish(false, "delivery-failed");
      if (!this.current(e) || !this.deps.permitted(owner)) return finish(false);
      e.delivered = true;
      this.deps.log("privately delivered", e.id);
      return finish(true);
    } catch { return finish(false); }
    finally {
      if (watcher) shared.watchers.delete(watcher);
      e.requests--;
      if (!e.delivered && e.requests === 0 && this.entry === e) await this.close("no confirmed private recipient");
    }
  }
  private async start(e: Exposure, protocol: "http2" | "quic" | "auto"): Promise<void> {
    try {
      const binary = await (this.deps.ensure ?? ensureCloudflared)({ dataDir: this.deps.dataDir, pinnedOnly: true, signal: e.abort.signal,
        onProgress: p => {
          if (p.phase === "checked") e.progress.installChecked(p.download, p.version);
          else if (p.phase === "downloading") e.progress.downloaded(p.received, p.total, p.fallback?.reason);
          else e.progress.begin("verify");
        } });
      if (!this.current(e)) throw new Error("closed");
      e.progress.begin("tunnel");
      const gateway = this.deps.createGateway(e.id, () => this.current(e), () => e.phase === "open", () => { void this.close("gateway failed", e.id); });
      e.gateway = gateway;
      const origin = await gateway.listen().catch(() => { throw new StartFailure("gateway-failed"); });
      if (!this.current(e)) throw new Error("closed");
      const provider = (this.deps.provider ?? ((path, p) => new CloudflaredProvider({ binaryName: path, protocol: p })))(binary.path, protocol);
      const result = await e.reservation.start(provider, {
        sid: e.id, origin, pagePath: "/signin", readinessMarker: gateway.readinessMarker, expiresAt: e.expiresAt,
        signal: e.abort.signal, onCandidateHost: host => { if (this.current(e)) { gateway.setHost(host); e.progress.begin("address"); } },
      });
      if (!result.ok) throw new StartFailure(failureOf(result.errorKind));
      if (!this.current(e)) throw new Error("tunnel unavailable");
      const published = new URL(result.handle.pageUrl);
      if (published.protocol !== "https:" || published.pathname !== "/signin" || published.username || published.password || published.search || published.hash) throw new Error("invalid public page");
      gateway.setHost(published.host);
      e.url = published.href;
      e.unsubscribe = result.handle.onUnexpectedExit(() => { void this.close("tunnel exited", e.id); });
      if (!this.current(e)) throw new Error("closed");
      e.phase = "open";
      e.progress.complete();
      this.deps.log("opened", e.id);
    } catch (err) {
      e.progress.fail(err instanceof StartFailure ? err.reason : err instanceof CloudflaredInstallError ? failureOf(err.kind)
        : this.current(e) ? "unknown" : "closed");
      // deliver's finally joins close after this promise settles; no self-await.
      e.abort.abort(); e.gateway?.setHost(null); e.gateway?.close();
      this.deps.log("startup failed", e.id);
      throw new Error("public link unavailable");
    }
  }
  close(reason: string, expectedId?: string): Promise<TunnelStopResult> {
    const e = this.entry;
    if (!e || (expectedId && expectedId !== e.id)) return Promise.resolve({ confirmed: true });
    if (e.closing) return e.closing;
    // Every access fence is synchronous, before the first await and before child cleanup.
    e.phase = "closing";
    e.abort.abort();
    if (e.timer) clearTimeout(e.timer);
    e.unsubscribe?.();
    this.deps.revoke(e.id);
    e.gateway?.setHost(null); e.gateway?.close();
    e.closing = (async () => {
      await e.starting.catch(() => {});
      e.gateway?.close(); // listen may have finished after the first close.
      const result = await e.reservation.stop(reason);
      if (this.entry === e) {
        if (result.confirmed) this.entry = null;
        else { e.phase = "cleanup_unconfirmed"; this.deps.onCleanupUnconfirmed?.(result, e.owner); }
      }
      this.deps.log(result.confirmed ? "closed" : "cleanup unconfirmed", e.id);
      return result;
    })();
    return e.closing;
  }
}
