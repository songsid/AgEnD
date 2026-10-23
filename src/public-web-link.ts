import { createHash } from "node:crypto";
import { publicTunnelHostname, PUBLIC_TUNNEL_TOKEN_ENV, PUBLIC_TUNNEL_ORIGIN_PORT, normalizePublicTunnelToken } from "./public-tunnel-config.js";
import { performance } from "node:perf_hooks";
import { newTunnelSid } from "./tunnel/manager.js";
import { CloudflaredProvider } from "./tunnel/cloudflared.js";
import { namedTunnelFailureMessage } from "./tunnel/named-diagnostics.js";
import { CloudflaredInstallError, ensureCloudflared, type CloudflaredInstallProgress } from "./tunnel/cloudflared-install.js";
import { PublicLinkProgressTracker, failureOf, type PublicLinkFailure, type PublicLinkProgress } from "./public-link-progress.js";
import type { TunnelReservation } from "./tunnel/purpose-lane.js";
import type { TunnelStopResult } from "./tunnel/types.js";
import type { PublicGateway } from "./public-web-gateway.js";
import type { LoginCodeOwner } from "./web-login.js";
import type { WebConfig } from "./types.js";
import type { PublicPreview, PublicPreviewStatus } from "./public-preview.js";

export const PUBLIC_LINK_DEFAULT_MINUTES = 120;
/** A quick tunnel's (random trycloudflare.com address) longest lifetime. */
export const PUBLIC_LINK_MAX_MINUTES = 480;
/** With a fixed hostname (named tunnel): up to 7 days, or `0` = no expiry (open until closed or the fleet stops). */
export const PUBLIC_LINK_NAMED_MAX_MINUTES = 10_080;
export const PUBLIC_LINK_NO_EXPIRY = 0;
const PUBLIC_LINK_KEYS = ["allow_public", "ttl_minutes", "protocol", "hostname", "tunnel_token_env", "origin_port", "auto_open"];
/** Named mode: a usable fixed hostname is configured (what the longer lifetime and auto_open hang on). */
export function publicLinkNamedHostname(web: WebConfig | undefined): boolean {
  return publicTunnelHostname(web?.public_link?.hostname) !== null;
}
export function publicLinkSettings(web: WebConfig | undefined): { allowed: boolean; ttlMs: number; protocol: "http2" | "quic" | "auto" } {
  // Raw YAML startup does not go through the Settings validator. Enforce the
  // fixed cap here too, at the boundary every runtime consumer shares: 480 for a
  // quick tunnel, 10080 (or 0 = no expiry, ttlMs Infinity) with a fixed hostname.
  const settings = web?.public_link;
  const named = publicLinkNamedHostname(web);
  const raw = settings?.ttl_minutes;
  const whole = typeof raw === "number" && Number.isInteger(raw);
  const ttlMs = named && whole && raw === PUBLIC_LINK_NO_EXPIRY ? Infinity
    : (whole && raw > 0 ? Math.min(raw, named ? PUBLIC_LINK_NAMED_MAX_MINUTES : PUBLIC_LINK_MAX_MINUTES) : PUBLIC_LINK_DEFAULT_MINUTES) * 60_000;
  const protocol = settings?.protocol;
  return { allowed: settings?.allow_public === undefined || settings.allow_public === true, ttlMs,
    protocol: typeof protocol === "string" && ["http2", "quic", "auto"].includes(protocol) ? protocol : "http2" };
}
/** `web.public_link.auto_open` (#named-link-ttl): only with a fixed hostname, and only while public links are allowed. */
export function publicLinkAutoOpen(web: WebConfig | undefined): boolean {
  return web?.public_link?.auto_open === true && publicLinkNamedHostname(web) && publicLinkSettings(web).allowed;
}
/**
 * The shape of a Settings patch to `web.public_link`, before it is merged: every key known and of its kind, minutes
 * within the widest range (0..10080). Whether the merged result fits its mode is the validator's (validPublicLinkPatch).
 */
export function publicLinkPatchShape(value: unknown): value is NonNullable<WebConfig["public_link"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(k => PUBLIC_LINK_KEYS.includes(k))
    && (v.allow_public === undefined || typeof v.allow_public === "boolean")
    && (v.auto_open === undefined || typeof v.auto_open === "boolean")
    && (v.ttl_minutes === undefined || (Number.isInteger(v.ttl_minutes) && Number(v.ttl_minutes) >= 0 && Number(v.ttl_minutes) <= PUBLIC_LINK_NAMED_MAX_MINUTES))
    && (v.hostname === undefined || v.hostname === "" || publicTunnelHostname(v.hostname) !== null)
    && (v.tunnel_token_env === undefined || v.tunnel_token_env === "" || v.tunnel_token_env === PUBLIC_TUNNEL_TOKEN_ENV)
    && (v.origin_port === undefined || Number.isInteger(v.origin_port) && Number(v.origin_port) >= 1024 && Number(v.origin_port) <= 65535)
    && (v.protocol === undefined || (typeof v.protocol === "string" && ["http2", "quic", "auto"].includes(v.protocol)));
}
/**
 * What is wrong with a whole `web.public_link` for its mode, or null. Quick tunnel (no hostname): 1..480 minutes and no
 * auto_open. Fixed hostname: 1..10080 minutes or 0 (no expiry); auto_open allowed.
 */
export function publicLinkModeProblem(value: NonNullable<WebConfig["public_link"]>): { key: "ttl_minutes" | "auto_open"; message: string } | null {
  const named = publicTunnelHostname(value.hostname) !== null;
  const ttl = value.ttl_minutes;
  if (!named && ttl !== undefined && (ttl < 1 || ttl > PUBLIC_LINK_MAX_MINUTES)) {
    return { key: "ttl_minutes", message: `must be 1..${PUBLIC_LINK_MAX_MINUTES} minutes for a quick tunnel; 0 (no expiry) or up to ${PUBLIC_LINK_NAMED_MAX_MINUTES} needs web.public_link.hostname` };
  }
  if (!named && value.auto_open === true) return { key: "auto_open", message: "needs web.public_link.hostname (a named tunnel); a quick tunnel is never opened automatically" };
  return null;
}
/** A whole `web.public_link` (the validator's view): its shape, then its mode's ranges. */
export function validPublicLinkPatch(value: unknown): value is NonNullable<WebConfig["public_link"]> {
  return publicLinkPatchShape(value) && publicLinkModeProblem(value) === null;
}
export function namedPublicLinkSettings(web: WebConfig | undefined): { hostname: string; token: string; port: number } | undefined {
  const settings = web?.public_link;
  if (!settings?.hostname && !settings?.tunnel_token_env) return undefined;
  const hostname = publicTunnelHostname(settings.hostname);
  const token = normalizePublicTunnelToken(process.env[PUBLIC_TUNNEL_TOKEN_ENV]);
  const port = settings?.origin_port ?? PUBLIC_TUNNEL_ORIGIN_PORT;
  if (!hostname || settings?.tunnel_token_env && settings.tunnel_token_env !== PUBLIC_TUNNEL_TOKEN_ENV
    || !token || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("named tunnel configuration is incomplete");
  return { hostname, token, port };
}
function configurationKey(web: WebConfig | undefined): string {
  const settings = web?.public_link;
  if (!settings?.hostname && !settings?.tunnel_token_env) return "quick";
  return createHash("sha256").update(JSON.stringify([settings?.hostname, settings?.tunnel_token_env, settings?.origin_port, settings?.protocol,
    settings?.hostname ? process.env[PUBLIC_TUNNEL_TOKEN_ENV] : null])).digest("hex");
}
interface Exposure {
  configuration: string;
  id: string;
  owner: LoginCodeOwner;
  abort: AbortController;
  /** Monotonic; Infinity when the link has no expiry (a named tunnel's `ttl_minutes: 0`). */
  deadline: number;
  /** Wall clock; null = no expiry: open until closed or the fleet stops. */
  expiresAt: number | null;
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
  /** null: no expiry (a named tunnel's `ttl_minutes: 0`) — open until closed or the fleet stops. */
  readonly expiresAt: number | null;
  readonly isCurrent: () => boolean;
}
/** What a tunnel child and its lease are given for a link without expiry: a finite "far future" (JSON-safe). */
const NO_EXPIRY_WALL = Number.MAX_SAFE_INTEGER;
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
/**
 * The refusal when the one tunnel is someone else's. #1525: drawn on ④, not ① — the refusal short-circuits before any
 * install work, so ① renders ✅·0s while the lease-held sentence on ④ carries the truth.
 */
function leaseHeldProgress(now: () => number): PublicLinkProgress {
  const refused = new PublicLinkProgressTracker(now, () => {});
  refused.begin("tunnel");
  refused.fail("lease-held");
  return refused.snapshot;
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
    createGateway(id: string, current: () => boolean, open: () => boolean, failed: () => void, named?: { hostname: string; port: number }): PublicGateway;
    revoke(id: string): void;
    /** `detail` (#1767): why, in words fit for daemon.log (logDetail) — never a URL. */
    log(event: string, id: string, detail?: string): void;
    onCleanupUnconfirmed?(result: TunnelStopResult, owner: LoginCodeOwner): void;
    now?: () => number;
    wallNow?: () => number;
    ensure?: typeof ensureCloudflared;
    provider?: (binary: string, protocol: "http2" | "quic" | "auto", named?: { hostname: string; token: string }) => CloudflaredProvider;
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
  /** `noExpiry`: an open link without an expiry (no expiresAt / remainingSeconds then). */
  status(): { state: string; expiresAt?: number; remainingSeconds?: number; noExpiry?: true } {
    const e = this.entry;
    if (e && this.now() >= e.deadline && !e.closing) void this.close("expired");
    if (!e) return { state: "closed" };
    return e.expiresAt === null ? { state: e.phase, noExpiry: true }
      : { state: e.phase, expiresAt: e.expiresAt, remainingSeconds: Math.max(0, Math.ceil((e.deadline - this.now()) / 1000)) };
  }
  private current(e: Exposure): boolean {
    return this.entry === e && e.configuration === configurationKey(this.deps.web()) && !e.closing && !e.abort.signal.aborted && this.now() < e.deadline
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
      const created = this.create(owner);
      if (!created) {
        // The one tunnel is someone else's (a /login link, or one whose cleanup is unconfirmed): say so.
        onProgress?.(leaseHeldProgress(this.now));
        return false;
      }
      e = created;
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
  /** A new exposure for `owner` (its lifetime counted from now, its start begun), or null when the tunnel lane is held. */
  private create(owner: LoginCodeOwner, how = "requested"): Exposure | null {
    const settings = publicLinkSettings(this.deps.web());
    const id = newTunnelSid();
    const reservation = this.deps.reserve(id); // Before installer, listener, or any await.
    if (!reservation) return null;
    const lasting = Number.isFinite(settings.ttlMs);
    const e: Exposure = { configuration: configurationKey(this.deps.web()), id, owner: { ...owner }, reservation, abort: new AbortController(),
      deadline: lasting ? this.now() + settings.ttlMs : Infinity, expiresAt: lasting ? (this.deps.wallNow ?? Date.now)() + settings.ttlMs : null,
      phase: "starting", gateway: null, starting: Promise.resolve(), requests: 0, delivered: false,
      progress: undefined as unknown as PublicLinkProgressTracker, watchers: new Set() };
    e.progress = new PublicLinkProgressTracker(this.now, () => { for (const w of e.watchers) w(); });
    this.entry = e;
    // No expiry: no timer at all (a setTimeout of Infinity would fire at once). Close, policy changes and shutdown end it.
    const expire = (): void => {
      if (this.entry !== e || e.closing) return;
      const remaining = e.deadline - this.now();
      if (remaining <= 0) void this.close("expired");
      else { e.timer = setTimeout(expire, Math.ceil(remaining)); e.timer.unref?.(); }
    };
    if (lasting) expire();
    e.starting = this.start(e, settings.protocol);
    this.deps.log(how, id);
    return e;
  }
  /**
   * #named-link-ttl: open the link with nobody waiting for it — `web.public_link.auto_open` after the fleet starts. The
   * same start and readiness probe as a requested link, owned by `owner` (the admin who last opened it; still checked by
   * `permitted`), but no sign-in URL or code is sent anywhere: the sign-in page still asks for a code, which only a
   * private /web or a returning device's request delivers. "busy": a link (or its cleanup) already exists — nothing done.
   */
  async openUnattended(owner: LoginCodeOwner, onProgress?: (p: PublicLinkProgress) => void): Promise<"opened" | "busy" | "failed"> {
    if (this.entry) return "busy";
    if (!this.deps.permitted(owner) || !publicLinkSettings(this.deps.web()).allowed) return "failed";
    const e = this.create(owner, "requested unattended");
    if (!e) { onProgress?.(leaseHeldProgress(this.now)); return "failed"; }
    // Nobody is owed a delivery: a request joining it later and failing its own delivery never closes it.
    e.delivered = true;
    const watcher = onProgress ? () => onProgress(e.progress.snapshot) : null;
    if (watcher) e.watchers.add(watcher);
    try {
      await e.starting;
      if (!this.current(e)) throw new Error("closed");
      this.deps.log("opened unattended", e.id);
      return "opened";
    } catch {
      await this.close("unattended start failed", e.id); // its own exposure only (a later one is left alone)
      return "failed";
    } finally {
      if (watcher) { e.watchers.delete(watcher); watcher(); }
    }
  }
  private async start(e: Exposure, protocol: "http2" | "quic" | "auto"): Promise<void> {
    const namedMode = !!(this.deps.web()?.public_link?.hostname || this.deps.web()?.public_link?.tunnel_token_env);
    try {
      const named = namedPublicLinkSettings(this.deps.web());
      const binary = await (this.deps.ensure ?? ensureCloudflared)({ dataDir: this.deps.dataDir, pinnedOnly: true, signal: e.abort.signal,
        onProgress: p => applyInstallProgress(e.progress, p) });
      if (!this.current(e)) throw new Error("closed");
      // #1723/#1767: preview starts only after the dashboard candidate is known. A quick dashboard tunnel requests
      // its address first; named mode already knows its configured address. Either can still fail readiness after
      // preview starts, in which case both close. Nothing below waits on the preview or reads it.
      const startPreview = (): void => {
        if (e.preview !== undefined || !this.current(e)) return;
        e.preview = this.deps.createPreview?.({ id: e.id, expiresAt: e.expiresAt ?? NO_EXPIRY_WALL, binary: binary.path, protocol,
          dashboardOrigin: () => (e.url ? new URL(e.url).origin : null), isCurrent: () => this.current(e) }) ?? null;
        e.preview?.start();
      };
      e.progress.begin("tunnel");
      const gateway = this.deps.createGateway(e.id, () => this.current(e), () => e.phase === "open", () => { void this.close("gateway failed", e.id); }, named ? { hostname: named.hostname, port: named.port } : undefined);
      e.gateway = gateway;
      const origin = await gateway.listen().catch((err: unknown) => { throw new StartFailure(named && (err as NodeJS.ErrnoException)?.code === "EADDRINUSE" ? "origin-port-in-use" : "gateway-failed"); });
      if (!this.current(e)) throw new Error("closed");
      const provider = (this.deps.provider ?? ((path, p, n) => new CloudflaredProvider({ binaryName: path, protocol: p, named: n })))(binary.path, protocol, named);
      const result = await e.reservation.start(provider, {
        sid: e.id, origin, pagePath: "/signin", readinessMarker: gateway.readinessMarker, expiresAt: e.expiresAt ?? NO_EXPIRY_WALL,
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
      this.deps.log(`startup failed: ${reason}`, e.id, namedMode ? namedTunnelFailureMessage(reason) ?? "Named tunnel failed; check the connector token, hostname, published application route and network." : logDetail(err instanceof StartFailure ? err.detail : (err as Error)?.message));
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
