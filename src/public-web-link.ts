import { performance } from "node:perf_hooks";
import { newTunnelSid } from "./tunnel/manager.js";
import { CloudflaredProvider } from "./tunnel/cloudflared.js";
import { CloudflaredInstallError, ensureCloudflared, type CloudflaredInstallProgress } from "./tunnel/cloudflared-install.js";
import { PublicLinkProgressTracker, failureOf, type PublicLinkFailure, type PublicLinkProgress } from "./public-link-progress.js";
import type { TunnelReservation } from "./tunnel/purpose-lane.js";
import type { TunnelStopResult } from "./tunnel/types.js";
import type { PublicGateway } from "./public-web-gateway.js";
import type { LoginCodeOwner } from "./web-login.js";
import type { WebConfig } from "./types.js";
import type { PublicPreview, PublicPreviewStatus } from "./public-preview.js";

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
  /** #1723: this exposure's preview origin (a second quick tunnel), started beside it and never waited for. */
  preview?: PublicPreview | null;
}
export interface PublicLinkDelivery {
  readonly exposureId: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly isCurrent: () => boolean;
}
/** What the install reports, onto the public link's steps (①–③). */
export function applyInstallProgress(progress: PublicLinkProgressTracker, p: CloudflaredInstallProgress): void {
  if (p.phase === "checked") progress.installChecked(p.download, p.version);
  else if (p.phase === "downloading") progress.downloaded(p.received, p.total, p.fallback?.reason);
  else progress.begin("verify");
}

/** A start step that failed for a reason the user is shown. */
class StartFailure extends Error {
  /** `detail`: what the step itself said (e.g. cloudflared's error), for the log only — never shown in a chat. */
  constructor(readonly reason: PublicLinkFailure, readonly detail?: string) { super(reason); }
}
/** A failure detail fit for daemon.log: no URLs, no control characters, bounded (#1767). */
export function logDetail(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.replace(/https?:\/\/\S+/g, "<url>").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
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
    /** `detail` (#1767): why, in words fit for daemon.log (logDetail) — never a URL. */
    log(event: string, id: string, detail?: string): void;
    onCleanupUnconfirmed?(result: TunnelStopResult, owner: LoginCodeOwner): void;
    now?: () => number;
    wallNow?: () => number;
    ensure?: typeof ensureCloudflared;
    provider?: (binary: string, protocol: "http2" | "quic" | "auto") => CloudflaredProvider;
    /**
     * #1723: this exposure's preview, or null when it gets none (web.preview off, web.preview_on_public_link off, or a
     * configured web.preview_origin used instead). Called once the binary is verified; its start is never awaited.
     */
    createPreview?(exposure: { id: string; expiresAt: number; binary: string; protocol: "http2" | "quic" | "auto";
      dashboardOrigin(): string | null; isCurrent(): boolean }): PublicPreview | null;
  }) { this.now = deps.now ?? (() => performance.now()); }

  get exposureId(): string | undefined { return this.entry?.id; }
  /**
   * #1920 step 4b: the open, current exposure — its id, sign-in page and the admin who opened it (whose General hears
   * of a guest signing in through it) — else null. A guest code then also works through it.
   */
  openSignin(): { exposureId: string; url: string; owner: LoginCodeOwner } | null {
    const e = this.entry;
    return e && e.phase === "open" && e.url && this.current(e) ? { exposureId: e.id, url: e.url, owner: e.owner } : null;
  }
  /** #1723: the open exposure's dashboard origin (`https://<host>`), for a configured preview origin to accept; else null. */
  openDashboardOrigin(): string | null {
    const e = this.entry;
    return e && e.phase === "open" && e.url && this.current(e) ? new URL(e.url).origin : null;
  }
  /**
   * #1723: the preview of exposure `exposureId`, as a page of it may use it — null when that exposure is not the open
   * one, or has no preview.
   */
  previewStatus(exposureId: string): PublicPreviewStatus | null {
    const e = this.entry;
    if (!e || e.id !== exposureId || e.phase !== "open" || !this.current(e) || !e.preview) return null;
    return e.preview.status();
  }
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
        // #1525: drawn on ④, not ① — the refusal short-circuits before any
        // install work, so ① renders ✅·0s while the lease-held sentence on ④
        // carries the truth.
        const refused = new PublicLinkProgressTracker(this.now, () => {});
        refused.begin("tunnel");
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
    // #1525: a request that fails before ⑥ begins still draws its failure on
    // ⑥ (a 0 s entry stamped at finish time) — never on the last shared step,
    // which may have succeeded.
    let unbegunFailedAt: number | undefined;
    const view = (): PublicLinkProgress => {
      const base = shared.progress.snapshot;
      if (!own && !ownFailure) return base;
      const steps = own ? [...base.steps, { step: "deliver" as const, ...own }]
        : unbegunFailedAt !== undefined ? [...base.steps, { step: "deliver" as const, startedAt: unbegunFailedAt, endedAt: unbegunFailedAt }] : base.steps;
      const failedStep = own || unbegunFailedAt !== undefined ? "deliver" as const : base.steps.at(-1)!.step;
      return { ...base, steps, ...(ownFailure && !base.failed ? { failed: { step: failedStep, reason: ownFailure } } : {}) };
    };
    const watcher = onProgress ? () => onProgress(view()) : null;
    if (watcher) { e.watchers.add(watcher); watcher(); }
    const finish = (outcome: boolean, failure?: PublicLinkFailure): boolean => {
      if (own && own.endedAt === undefined) own.endedAt = this.now();
      if (!outcome && !shared.progress.snapshot.failed) { ownFailure = failure ?? "closed"; if (!own) unbegunFailedAt = this.now(); }
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
        onProgress: p => applyInstallProgress(e.progress, p) });
      if (!this.current(e)) throw new Error("closed");
      // #1723/#1767: the preview's quick tunnel is asked for only once the link's own tunnel has its address — the link
      // always asks Cloudflare first (under a rate limit the preview can never take the request the link needed), a
      // link that fails never spends one on a preview, and nothing below waits on the preview or reads it.
      const startPreview = (): void => {
        if (e.preview !== undefined || !this.current(e)) return;
        e.preview = this.deps.createPreview?.({ id: e.id, expiresAt: e.expiresAt, binary: binary.path, protocol,
          dashboardOrigin: () => (e.url ? new URL(e.url).origin : null), isCurrent: () => this.current(e) }) ?? null;
        e.preview?.start();
      };
      e.progress.begin("tunnel");
      const gateway = this.deps.createGateway(e.id, () => this.current(e), () => e.phase === "open", () => { void this.close("gateway failed", e.id); });
      e.gateway = gateway;
      const origin = await gateway.listen().catch(() => { throw new StartFailure("gateway-failed"); });
      if (!this.current(e)) throw new Error("closed");
      const provider = (this.deps.provider ?? ((path, p) => new CloudflaredProvider({ binaryName: path, protocol: p })))(binary.path, protocol);
      const result = await e.reservation.start(provider, {
        sid: e.id, origin, pagePath: "/signin", readinessMarker: gateway.readinessMarker, expiresAt: e.expiresAt,
        signal: e.abort.signal, onCandidateHost: host => { if (this.current(e)) { gateway.setHost(host); e.progress.begin("address"); startPreview(); } },
      });
      if (!result.ok) throw new StartFailure(failureOf(result.errorKind), result.message);
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
      const reason: PublicLinkFailure = err instanceof StartFailure ? err.reason : err instanceof CloudflaredInstallError ? failureOf(err.kind)
        : this.current(e) ? "unknown" : "closed";
      e.progress.fail(reason);
      // deliver's finally joins close after this promise settles; no self-await.
      e.abort.abort(); e.gateway?.setHost(null); e.gateway?.close();
      // #1767: the reason and what the step said, so the next one is diagnosable from daemon.log.
      this.deps.log(`startup failed: ${reason}`, e.id, logDetail(err instanceof StartFailure ? err.detail : (err as Error)?.message));
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
    // #1723: the preview is fenced now too (its own stop fences synchronously), and its tunnel ends with this one.
    // Its failure is observed at once (an unproven stop, not an unhandled rejection while the link's own start ends).
    const previewStopped = e.preview?.stop(reason).catch((): TunnelStopResult => ({ confirmed: false, reason: "preview stop failed", pid: null, identity: null }));
    e.closing = (async () => {
      await e.starting.catch(() => {});
      e.gateway?.close(); // listen may have finished after the first close.
      // The reservation holds the one tunnel lane until BOTH tunnels are proven stopped: an unproven preview keeps it
      // from the next /dashboard or /login as an unproven link tunnel does.
      const result = await e.reservation.stop(reason, previewStopped);
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
