/**
 * #2636 part 3: Office share links, running — the shares (office-share.ts OfficeShares), their gateway, and the quick
 * tunnel they share. Design: #2636, confirmed with the leader's two additions (2026-10-25):
 *
 * - The tunnel starts with the first share and stops when the last one ends (expired, revoked, its owner no longer an
 *   admin, the feature turned off). trycloudflare.com limits new quick tunnels: a start it refuses (429) fails that one
 *   share with "try again later" — nothing retries on its own. A share is only handed out once the tunnel is up.
 * - No step beyond the admin check (decision a94a1bab): whoever may make one gets the link at once.
 * - Its own manager and lease (OFFICE_SHARE_TUNNEL_DIR): never the fleet's one tunnel lane (/web, /login) nor the
 *   public link's preview tunnel. A tunnel that goes away unexpectedly ends every share (their address was its host).
 */
import { fleetWide, OfficeShareLimiter, OfficeShares, createOfficeShareGateway, shareMaxMinutes, type OfficeShare, type OfficeShareGateway,
  type OfficeShareSource } from "./office-share.js";
import { OFFICE_SHARE_PAGE_CSP, officeSharePage, officeShareStatic } from "./office-share-page.js";
import { failureOf, type PublicLinkFailure } from "./public-link-progress.js";
import { PAGE_SHARE_LIMITS, PageShares, pageShareMaxMinutes, type PageShare } from "./page-share.js";
import { newTunnelSid, type ManagedTunnel } from "./tunnel/manager.js";
import type { TunnelProvider } from "./tunnel/types.js";

/** Where the share tunnel keeps its own lease (never the fleet's `tunnel.lease`). */
export const OFFICE_SHARE_TUNNEL_DIR = "office-share-tunnel";
const QUICK_TUNNEL_HOST = /^[a-z0-9-]+\.trycloudflare\.com$/;
/** The lease's own end: none — the tunnel ends with its last share, not on a clock. */
const NO_EXPIRY_WALL = Number.MAX_SAFE_INTEGER;
/** How often open shares are checked against who may still have them. */
export const SWEEP_MS = 30_000;

export type OfficeShareRefusal = "disabled" | "office" | "duration" | "too_many" | "theme" | "tunnel";
/** #2911: a page share made, or why not. */
export type PageShareMade =
  | { ok: true; share: PageShare; url: string }
  | { ok: false; error: "disabled" | "duration" | "too_many" | "too_large" | "empty" | "tunnel" | "not_allowed"; reason?: PublicLinkFailure | "exited" };
export type OfficeShareMade =
  | { ok: true; share: OfficeShare; url: string }
  | { ok: false; error: OfficeShareRefusal; reason?: PublicLinkFailure | "exited" };

export interface OfficeShareServiceDeps {
  source: OfficeShareSource;
  manager: Pick<ManagedTunnel, "start" | "stop">;
  /** cloudflared, installed (pinned) if need be. */
  ensure(signal: AbortSignal): Promise<{ path: string }>;
  provider(binary: string): TunnelProvider;
  /** `web.office_share` as it is now. */
  config(): { enabled?: boolean; max_hours?: number } | undefined;
  /** A stored office by id. */
  officeExists(id: string): boolean;
  /** Whether a share's owner may still have it (a fleet admin of this fleet). */
  ownerCurrent(owner: string): boolean;
  /** Every change to the open shares (Settings' card, General's notices are the caller's). */
  changed?(shares: OfficeShare[]): void;
  /** `detail`: fit for daemon.log — never a token or a URL. */
  log?(event: string, detail?: string): void;
  createGateway?: typeof createOfficeShareGateway;
  shares?: OfficeShares;
  /** #2924 review: `web.preview_cdn` as it is now — read once when a page share is made, and kept on it. */
  pageCdn?(): boolean;
  /** #2911: `web.page_share` as it is now. */
  pageConfig?(): { enabled?: boolean; max_hours?: number } | undefined;
  /**
   * #2911: every change to the open page shares, with those that just ended — only shares that were handed out (a
   * share whose tunnel never came up was never announced, so its end is not either).
   */
  pagesChanged?(shares: PageShare[], ended: PageShare[]): void;
  pages?: PageShares;
}

export class OfficeShareService {
  readonly shares: OfficeShares;
  private gateway: OfficeShareGateway | null = null;
  private origin: string | null = null;
  private starting: Promise<{ ok: true; origin: string } | { ok: false; reason: PublicLinkFailure | "exited" }> | null = null;
  private stopping: Promise<unknown> | null = null;
  private abort: AbortController | null = null;
  private unsubscribe: (() => void) | undefined;
  private readonly limiter = new OfficeShareLimiter();
  /** #2662: the shares' pack pictures, each share's own minute — kept here so an ended share's key goes with it. */
  private readonly pictureLimiter = new OfficeShareLimiter();

  /** #2911: the page shares, on this same tunnel and gateway (`/p/<token>`). */
  readonly pages: PageShares;
  private readonly pageLimiter = new OfficeShareLimiter(undefined, { requests: PAGE_SHARE_LIMITS.requestsPerMinute, bytes: PAGE_SHARE_LIMITS.bytesPerMinute });
  /** Page shares handed out (their URL given): only their end is announced. */
  private readonly handedOut = new Set<string>();

  constructor(private readonly deps: OfficeShareServiceDeps) {
    this.shares = deps.shares ?? new OfficeShares({ changed: list => this.onChanged(list) });
    this.pages = deps.pages ?? new PageShares({ changed: (list, ended) => this.onPagesChanged(list, ended) });
  }

  enabled(): boolean { return this.deps.config()?.enabled !== false; }
  list(): OfficeShare[] { return this.shares.list(); }
  /** #2911: `web.page_share.enabled` (default on). */
  pagesEnabled(): boolean { return this.deps.pageConfig?.()?.enabled !== false; }
  /** Whether a page share made now may load the preview's CDN libraries (web.preview_cdn). */
  pagesCdn(): boolean { return this.deps.pageCdn?.() === true; }
  listPages(): PageShare[] { return this.pages.list(); }

  /**
   * #2911: a new page share of `html` (a snapshot the caller read from the chat history) and its URL, once the tunnel is
   * up. `minutes` 15–max_hours×60 (60 if not given). A tunnel that cannot start ends the share at once and says why.
   */
  async createPage(opts: { html: string; instance: string; title: string; owner: string; from?: PageShare["from"]; minutes?: number;
    /** The caller's own fence, asked again after the tunnel came up (its session still the same admin's: web-api.ts). */
    stillAllowed?(): boolean; }): Promise<PageShareMade> {
    const { stillAllowed, ...rest } = opts;
    if (!this.pagesEnabled()) return { ok: false, error: "disabled" };
    const made = this.pages.create({ ...rest, cdn: this.deps.pageCdn?.() === true, maxMinutes: pageShareMaxMinutes(this.deps.pageConfig?.()?.max_hours) });
    if (!made.ok) return { ok: false, error: made.error };
    const up = await this.up();
    if (!up.ok) { this.pages.revoke(made.share.id); return { ok: false, error: "tunnel", reason: up.reason }; }
    if (!this.pages.find(made.token)) return { ok: false, error: "tunnel", reason: "closed" };
    // #2917 review P2: what allowed it may have changed while the tunnel came up — the feature turned off, the maker no
    // longer an admin, the caller's session ended. Asked again before the URL is handed out; refused, the snapshot goes
    // unannounced (it was never handed out: no created notice, no ended one).
    const refused = !this.pagesEnabled() ? "disabled" as const : !this.deps.ownerCurrent(rest.owner) || (stillAllowed && !stillAllowed()) ? "not_allowed" as const : null;
    if (refused) { this.pages.revoke(made.share.id); return { ok: false, error: refused }; }
    this.handedOut.add(made.share.id);
    return { ok: true, share: made.share, url: `${up.origin}/p/${made.token}` };
  }

  /** #2911: end one page share by id, or every one ("all"); returns those that ended. */
  revokePage(id: string): PageShare[] { return this.pages.revoke(id); }

  /**
   * A new share and its URL, once the tunnel is up. `minutes` 15–max_hours×60 (60 if not given); `office` ALL_OFFICES,
   * WHOLE_FLEET (#2716) or a stored office's id; `theme` (#2715) "auto", "light" or "dark". A tunnel that cannot start ends the share at once and says why.
   */
  async create(opts: { office: string; minutes?: number; text?: boolean; theme?: string; owner: string }): Promise<OfficeShareMade> {
    if (!this.enabled()) return { ok: false, error: "disabled" };
    const made = this.shares.create({ ...opts, maxMinutes: shareMaxMinutes(this.deps.config()?.max_hours), exists: id => this.deps.officeExists(id) });
    if (!made.ok) return { ok: false, error: made.error };
    const up = await this.up();
    if (!up.ok) { this.shares.revoke(made.share.id); return { ok: false, error: "tunnel", reason: up.reason }; }
    // Ended while the tunnel came up (revoked, or the feature turned off meanwhile): not handed out.
    if (!this.shares.find(made.token)) return { ok: false, error: "tunnel", reason: "closed" };
    return { ok: true, share: made.share, url: `${up.origin}/o/${made.token}` };
  }

  revoke(id: string): number { return this.shares.revoke(id); }

  /** Shares no longer allowed: the feature off (all), an owner no longer an admin, an office deleted. */
  sweep(): number {
    // #2911: page shares too — the feature off ends them all, an owner no longer an admin ends theirs.
    const pages = this.pagesEnabled() ? this.pages.endWhere(s => !this.deps.ownerCurrent(s.owner)).length : this.pages.revoke("all").length;
    if (!this.enabled()) return this.shares.revoke("all") + pages;
    return this.shares.endWhere(s => !this.deps.ownerCurrent(s.owner) || (!fleetWide(s.office) && !this.deps.officeExists(s.office))) + pages;
  }

  /** The fleet is stopping: every share ends and the tunnel goes. */
  async close(): Promise<void> {
    this.shares.revoke("all");
    this.pages.revoke("all");
    await this.down("fleet stopping");
  }

  private onChanged(list: OfficeShare[]): void {
    const open = new Set(list.map(s => s.id));
    for (const id of this.known) if (!open.has(id)) { this.limiter.forget(id); this.pictureLimiter.forget(id); }
    this.known = open;
    this.settle();
    try { this.deps.changed?.(list); } catch { /* a listener never keeps a share or the tunnel */ }
  }
  /** #2911: a page share made or ended — the same tunnel, kept while either kind is open. */
  private onPagesChanged(list: PageShare[], ended: PageShare[]): void {
    for (const s of ended) this.pageLimiter.forget(s.id);
    const told = ended.filter(s => this.handedOut.delete(s.id));
    this.settle();
    try { this.deps.pagesChanged?.(list, told); } catch { /* a listener never keeps a share or the tunnel */ }
  }
  /**
   * While any share (Office or page) is open, who may still have it is asked again every SWEEP_MS (an admin removed, the
   * feature turned off, an office deleted end theirs without anyone looking); none left, the tunnel goes.
   */
  private settle(): void {
    const any = this.shares.list().length + this.pages.list().length > 0;
    if (any && !this.sweeper) { this.sweeper = setInterval(() => this.sweep(), SWEEP_MS); this.sweeper.unref?.(); }
    if (!any && this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
    if (!any) void this.down("no shares");
  }
  private known = new Set<string>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  /** The tunnel, up or coming up (one start at a time; never retried here). */
  private up(): Promise<{ ok: true; origin: string } | { ok: false; reason: PublicLinkFailure | "exited" }> {
    if (this.origin) return Promise.resolve({ ok: true, origin: this.origin });
    return this.starting ??= this.start().finally(() => { this.starting = null; });
  }

  private async start(): Promise<{ ok: true; origin: string } | { ok: false; reason: PublicLinkFailure | "exited" }> {
    await this.stopping?.catch(() => {});
    const abort = this.abort = new AbortController();
    const gateway = (this.deps.createGateway ?? createOfficeShareGateway)({
      shares: this.shares, source: this.deps.source, limiter: this.limiter, pictureLimiter: this.pictureLimiter, statics: officeShareStatic,
      pages: this.pages, pageLimiter: this.pageLimiter,
      page: share => ({ body: officeSharePage(share.theme), csp: OFFICE_SHARE_PAGE_CSP }),
    });
    this.gateway = gateway;
    const fail = (reason: PublicLinkFailure, detail?: string) => {
      this.deps.log?.(`tunnel ${reason}`, detail);
      if (this.gateway === gateway) { gateway.close(); this.gateway = null; }
      void this.deps.manager.stop(`start failed: ${reason}`).catch(() => {});
      return { ok: false as const, reason };
    };
    try {
      const binary = await this.deps.ensure(abort.signal);
      if (abort.signal.aborted) return fail("closed");
      const origin = await gateway.listen();
      if (abort.signal.aborted) return fail("closed");
      const result = await this.deps.manager.start(this.deps.provider(binary.path), {
        sid: newTunnelSid(), origin, pagePath: "/ready", readinessMarker: gateway.readinessMarker, expiresAt: NO_EXPIRY_WALL,
        signal: abort.signal, onCandidateHost: host => { if (!abort.signal.aborted) gateway.setHost(host); },
      });
      if (!result.ok) return fail(failureOf(result.errorKind), result.message);
      if (abort.signal.aborted) return fail("closed");
      const published = new URL(result.handle.pageUrl);
      if (published.protocol !== "https:" || published.pathname !== "/ready" || !QUICK_TUNNEL_HOST.test(published.host)) return fail("bad-address");
      gateway.setHost(published.host);
      this.origin = published.origin;
      // Gone by itself: every share's address was this host — they end, and the next share starts a new tunnel.
      this.unsubscribe = result.handle.onUnexpectedExit(() => {
        this.deps.log?.("tunnel exited");
        this.origin = null;
        this.shares.revoke("all");
        this.pages.revoke("all");
      });
      this.deps.log?.("tunnel ready");
      return { ok: true, origin: published.origin };
    } catch (err) {
      return fail(abort.signal.aborted ? "closed" : "unknown", (err as Error)?.message);
    }
  }

  private down(reason: string): Promise<unknown> {
    if (!this.origin && !this.starting && !this.gateway) return this.stopping ?? Promise.resolve();
    this.origin = null;
    this.abort?.abort(); this.abort = null;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.gateway?.setHost(null); this.gateway?.close(); this.gateway = null;
    const stopping = this.stopping = (async () => {
      await this.starting?.catch(() => {});
      return this.deps.manager.stop(reason);
    })().catch(() => {}).finally(() => { if (this.stopping === stopping) this.stopping = null; });
    return stopping;
  }
}
