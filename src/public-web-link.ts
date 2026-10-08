import { performance } from "node:perf_hooks";
import { newTunnelSid } from "./tunnel/manager.js";
import { CloudflaredProvider } from "./tunnel/cloudflared.js";
import { ensureCloudflared } from "./tunnel/cloudflared-install.js";
import type { TunnelReservation } from "./tunnel/purpose-lane.js";
import type { TunnelStopResult } from "./tunnel/types.js";
import type { PublicGateway } from "./public-web-gateway.js";
import type { LoginCodeOwner } from "./web-login.js";
import type { WebConfig } from "./types.js";

export const PUBLIC_LINK_DEFAULT_MINUTES = 120;
export const PUBLIC_LINK_MAX_MINUTES = 480;
export function publicLinkSettings(web: WebConfig | undefined): { allowed: boolean; ttlMs: number; protocol: "http2" | "quic" | "auto" } {
  return { allowed: web?.public_link?.allow_public !== false, ttlMs: (web?.public_link?.ttl_minutes ?? PUBLIC_LINK_DEFAULT_MINUTES) * 60_000, protocol: web?.public_link?.protocol ?? "http2" };
}
export function validPublicLinkPatch(value: unknown): value is NonNullable<WebConfig["public_link"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(k => ["allow_public", "ttl_minutes", "protocol"].includes(k))
    && (v.allow_public === undefined || typeof v.allow_public === "boolean")
    && (v.ttl_minutes === undefined || (Number.isInteger(v.ttl_minutes) && Number(v.ttl_minutes) >= 1 && Number(v.ttl_minutes) <= PUBLIC_LINK_MAX_MINUTES))
    && (v.protocol === undefined || ["http2", "quic", "auto"].includes(String(v.protocol)));
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
}
export interface PublicLinkDelivery {
  readonly exposureId: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly isCurrent: () => boolean;
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
  async deliver(owner: LoginCodeOwner, send: (link: PublicLinkDelivery) => Promise<boolean>): Promise<boolean> {
    if (!this.deps.permitted(owner) || !publicLinkSettings(this.deps.web()).allowed) return false;
    let e = this.entry;
    if (e && (e.owner.adapterId !== owner.adapterId || e.owner.chatId !== owner.chatId || e.owner.threadId !== owner.threadId || !this.current(e))) return false;
    if (!e) {
      const settings = publicLinkSettings(this.deps.web());
      const id = newTunnelSid();
      const reservation = this.deps.reserve(id); // Before installer, listener, or any await.
      if (!reservation) return false;
      e = { id, owner: { ...owner }, reservation, abort: new AbortController(), deadline: this.now() + settings.ttlMs,
        expiresAt: (this.deps.wallNow ?? Date.now)() + settings.ttlMs, phase: "starting", gateway: null, starting: Promise.resolve(), requests: 0, delivered: false };
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
    try {
      await e.starting;
      if (!this.current(e) || !this.deps.permitted(owner) || !e.url) return false;
      const delivered = await send({ exposureId: e.id, url: e.url, expiresAt: e.expiresAt, isCurrent: () => this.current(e!) && this.deps.permitted(owner) });
      if (!delivered || !this.current(e) || !this.deps.permitted(owner)) return false;
      e.delivered = true;
      this.deps.log("privately delivered", e.id);
      return true;
    } catch { return false; }
    finally {
      e.requests--;
      if (!e.delivered && e.requests === 0 && this.entry === e) await this.close("no confirmed private recipient");
    }
  }
  private async start(e: Exposure, protocol: "http2" | "quic" | "auto"): Promise<void> {
    try {
      const binary = await (this.deps.ensure ?? ensureCloudflared)({ dataDir: this.deps.dataDir, pinnedOnly: true, signal: e.abort.signal });
      if (!this.current(e)) throw new Error("closed");
      const gateway = this.deps.createGateway(e.id, () => this.current(e), () => e.phase === "open", () => { void this.close("gateway failed", e.id); });
      e.gateway = gateway;
      const origin = await gateway.listen();
      if (!this.current(e)) throw new Error("closed");
      const provider = (this.deps.provider ?? ((path, p) => new CloudflaredProvider({ binaryName: path, protocol: p })))(binary.path, protocol);
      const result = await e.reservation.start(provider, {
        sid: e.id, origin, pagePath: "/signin", readinessMarker: gateway.readinessMarker, expiresAt: e.expiresAt,
        signal: e.abort.signal, onCandidateHost: host => { if (this.current(e)) gateway.setHost(host); },
      });
      if (!result.ok || !this.current(e)) throw new Error("tunnel unavailable");
      const published = new URL(result.handle.pageUrl);
      if (published.protocol !== "https:" || published.pathname !== "/signin" || published.search || published.hash) throw new Error("invalid public page");
      gateway.setHost(published.host);
      e.url = published.href;
      e.unsubscribe = result.handle.onUnexpectedExit(() => { void this.close("tunnel exited", e.id); });
      if (!this.current(e)) throw new Error("closed");
      e.phase = "open";
      this.deps.log("opened", e.id);
    } catch {
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
