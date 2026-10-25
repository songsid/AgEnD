/**
 * #2636: Office share links — the live Office view (Fleet → Org chart → Office) for people outside the fleet, read-only,
 * for a limited time, with no sign-in. Design: #2636 (confirmed by the leader for the user, 2026-10-25).
 *
 * A share is its own small surface, never the dashboard's: its own gateway (createOfficeShareGateway, here) behind its
 * own quick tunnel, which starts with the first share and stops with the last. The gateway knows no session, cookie,
 * sign-in or /ui route; the dashboard's gateway never accepts a share's token. A leaked share URL shows the office
 * picture and nothing more.
 *
 * - The URL is `/o/<token>`: 32 random bytes, base64url. Only its SHA-256 is kept; the token is shown once, to whoever
 *   made it. Unlike the dashboard (where a `?token=` is never a credential, web-auth.ts) this token is the capability —
 *   for this picture only, on another origin.
 * - What a viewer gets is built here for the share alone (OfficeShareView): the same shapes as the dashboard's own reads
 *   (/ui/offices, /ui/office-acts, /ui/office-skins, the status frame, /ui/traffic) so the page's Office draws them, but
 *   only the shared office's people, and of each only what the picture needs (names, identity colour, state; no model,
 *   cost, context, description, thread, last reply or what it waits on). An instance whose cross_instance_visibility is
 *   "hidden" is never in it. An agent's `say` (office_set, the only text an agent wrote) only when the share says so.
 * - Limits: OFFICE_SHARE_LIMITS — links, lifetime, and per share requests and bytes a minute (every viewer comes from
 *   127.0.0.1 through the tunnel: the limit is the share's, never an address's).
 * - Kept in memory only: a restart ends every share (the quick tunnel's host changes anyway).
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { officeMembers, type OfficeAct, type OfficeChart } from "./web-office-acts.js";
import type { Office } from "./web-office-store.js";

export const OFFICE_SHARE_LIMITS = {
  /** Shares open at once, fleet-wide. */
  links: 10,
  /** Lifetime: 1 h unless asked, 15 min to `web.office_share.max_hours` (24 at most). */
  defaultMinutes: 60, minMinutes: 15, maxHours: 24,
  /** Per share, a sliding minute: requests, and bytes answered. */
  requestsPerMinute: 120, bytesPerMinute: 16 * 1024 * 1024,
  /** The page's static files (its code, the same for every share), all shares together. */
  staticRequestsPerMinute: 1200, staticBytesPerMinute: 64 * 1024 * 1024,
} as const;
/** "All offices": every stored office (and whoever is in none); otherwise a stored office's id. */
export const ALL_OFFICES = "all";
/**
 * An office's members after the share's cut, when every one it named is out of the share: a team no chart has (a team's
 * name has no control character), so the page finds nobody — never [], which the page reads as everyone.
 */
export const NOBODY = "team:\u0000";

/** An ended (or unknown) share's page: the same words whichever it is. */
export const ENDED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>AgEnD Office</title></head>`
  + `<body><p>This Office link has ended.</p><p lang="zh-TW">這個辦公室連結已結束。</p></body></html>`;
const QUICK_TUNNEL_HOST = /^[a-z0-9-]+\.trycloudflare\.com$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MINUTE_MS = 60_000;

export interface OfficeShare {
  /** A short handle for lists and revoking (never the token). */
  id: string;
  /** ALL_OFFICES, or a stored office's id. */
  office: string;
  /** Agents' own lines (office_set `say`) are shown. */
  text: boolean;
  /** Who made it (for the list and General's announcement). */
  owner: string;
  /** Wall-clock ms, for display; the expiry itself runs on the monotonic clock. */
  createdAt: number; expiresAt: number;
}
export type OfficeShareCreate =
  | { ok: true; share: OfficeShare; token: string }
  | { ok: false; error: "too_many" | "duration" | "office" };

export const hashShareToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The longest a share may live, in minutes: `web.office_share.max_hours` (whole hours, 1–24), 24 by default. */
export function shareMaxMinutes(maxHours: unknown): number {
  const h = typeof maxHours === "number" && Number.isInteger(maxHours) && maxHours >= 1 && maxHours <= OFFICE_SHARE_LIMITS.maxHours ? maxHours : OFFICE_SHARE_LIMITS.maxHours;
  return h * 60;
}

/**
 * The open shares. Each ends at its deadline (monotonic; a timer tells `changed` then, and find() refuses it from that
 * moment whatever the timer did), when revoked, or when its owner is no longer allowed (endWhere). `changed` hears every
 * change with the list as it is now — the tunnel follows it (none left: stop).
 */
export class OfficeShares {
  private readonly byHash = new Map<string, { share: OfficeShare; deadline: number; timer: ReturnType<typeof setTimeout> | null }>();
  private readonly now: () => number;
  private readonly wall: () => number;

  constructor(private readonly deps: {
    /** Monotonic ms (performance.now by default). */
    now?(): number;
    /** Wall-clock ms (Date.now by default): only what is shown. */
    wall?(): number;
    changed?(shares: OfficeShare[]): void;
    random?(n: number): Buffer;
    setTimer?(fn: () => void, ms: number): ReturnType<typeof setTimeout> | null;
    clearTimer?(t: ReturnType<typeof setTimeout>): void;
  } = {}) {
    this.now = deps.now ?? (() => performance.now());
    this.wall = deps.wall ?? (() => Date.now());
  }

  /** A new share: `minutes` from 15 to `maxMinutes`; `office` ALL_OFFICES or an id `exists` knows. */
  create(opts: { office: string; minutes?: number; text?: boolean; owner: string; maxMinutes?: number; exists?(office: string): boolean }): OfficeShareCreate {
    this.prune();
    const max = Math.min(opts.maxMinutes ?? OFFICE_SHARE_LIMITS.maxHours * 60, OFFICE_SHARE_LIMITS.maxHours * 60);
    const minutes = opts.minutes ?? Math.min(OFFICE_SHARE_LIMITS.defaultMinutes, max);
    if (!Number.isInteger(minutes) || minutes < OFFICE_SHARE_LIMITS.minMinutes || minutes > max) return { ok: false, error: "duration" };
    if (opts.office !== ALL_OFFICES && !(opts.exists?.(opts.office) ?? false)) return { ok: false, error: "office" };
    if (this.byHash.size >= OFFICE_SHARE_LIMITS.links) return { ok: false, error: "too_many" };
    const random = this.deps.random ?? randomBytes;
    const token = random(32).toString("base64url");
    let id = random(4).toString("hex");
    while (this.list().some(s => s.id === id)) id = random(4).toString("hex");
    const ms = minutes * MINUTE_MS, wall = this.wall();
    const share: OfficeShare = { id, office: opts.office, text: opts.text === true, owner: opts.owner, createdAt: wall, expiresAt: wall + ms };
    const key = hashShareToken(token);
    const timer = (this.deps.setTimer ?? ((fn, t) => { const h = setTimeout(fn, t); h.unref?.(); return h; }))(() => { if (this.prune()) this.announce(); }, ms + 50);
    this.byHash.set(key, { share, deadline: this.now() + ms, timer });
    this.announce();
    return { ok: true, share: { ...share }, token };
  }

  /** The open share a token names, or null (unknown, malformed, ended). */
  find(token: string): OfficeShare | null {
    if (!TOKEN.test(token)) return null;
    const entry = this.byHash.get(hashShareToken(token));
    if (!entry) return null;
    if (entry.deadline <= this.now()) { if (this.prune()) this.announce(); return null; }
    return { ...entry.share };
  }

  /** The open shares, soonest to end first. */
  list(): OfficeShare[] {
    const now = this.now();
    return [...this.byHash.values()].filter(e => e.deadline > now).sort((a, b) => a.deadline - b.deadline).map(e => ({ ...e.share }));
  }

  /** End one share by id, or every one (ALL_OFFICES is not an id: "all" ends all). Returns how many ended. */
  revoke(id: string): number {
    return this.endWhere(s => id === "all" || s.id === id);
  }

  /** End every share `test` picks (an owner no longer a fleet admin, an office deleted, the feature turned off). */
  endWhere(test: (share: OfficeShare) => boolean): number {
    let n = 0;
    for (const [key, e] of this.byHash) {
      if (!test({ ...e.share })) continue;
      this.drop(key); n++;
    }
    if (n) this.announce();
    return n;
  }

  private drop(key: string): void {
    const e = this.byHash.get(key);
    if (!e) return;
    if (e.timer) (this.deps.clearTimer ?? clearTimeout)(e.timer);
    this.byHash.delete(key);
  }
  private prune(): boolean {
    const now = this.now();
    let n = 0;
    for (const [key, e] of this.byHash) if (e.deadline <= now) { this.drop(key); n++; }
    return n > 0;
  }
  private announce(): void {
    try { this.deps.changed?.(this.list()); } catch { /* a listener's failure never keeps a share open */ }
  }
}

/** Per key (a share's id): requests and bytes in a sliding minute (monotonic, memory only). */
export class OfficeShareLimiter {
  private readonly seen = new Map<string, Array<[number, number]>>();
  constructor(private readonly now: () => number = () => performance.now(),
    private readonly limits: { requests: number; bytes: number } = { requests: OFFICE_SHARE_LIMITS.requestsPerMinute, bytes: OFFICE_SHARE_LIMITS.bytesPerMinute }) {}
  /** A request arrives: false when the key has had its requests or bytes this minute. */
  admit(id: string): boolean {
    const list = this.window(id);
    if (list.length >= this.limits.requests) return false;
    if (list.reduce((sum, [, b]) => sum + b, 0) >= this.limits.bytes) return false;
    list.push([this.now(), 0]);
    return true;
  }
  /** What the admitted request answered, in bytes. */
  sent(id: string, bytes: number): void {
    const list = this.seen.get(id);
    const last = list?.[list.length - 1];
    if (last) last[1] += bytes;
  }
  forget(id: string): void { this.seen.delete(id); }
  private window(id: string): Array<[number, number]> {
    const since = this.now() - MINUTE_MS;
    const list = (this.seen.get(id) ?? []).filter(([t]) => t > since);
    this.seen.set(id, list);
    return list;
  }
}

// ── What a share shows ──────────────────────────────────────────────────────────────────────────────────────────

/** The status frame's fields the Office draws (fleet-org.js orgState, nodeText; fleet-office-model.js coatOf; identity-color.js). */
const PERSON_FIELDS = ["name", "display_name", "color", "color_show", "backend", "status", "startup_phase", "execution_state"] as const;

/** Where a share's picture is read from: the fleet's own reads, as they are now. */
export interface OfficeShareSource {
  /** The status frame (getUiStatus): its `instances`. */
  status(): unknown;
  /** The org chart (orgChart): `general` and `teams`. */
  org(): { general?: unknown; teams?: unknown };
  /** The stored offices (web-office-store.ts list()). */
  offices(): { rev: number; offices: Office[] };
  /** The live acts (OfficeActs live()). */
  acts(): OfficeAct[];
  /** /ui/traffic's snapshot. */
  traffic(): { now: string; items: unknown[]; delegations?: unknown[] };
  /** The instances "Needs you" names now (one entry per item). */
  needs(): string[];
  /** cross_instance_visibility "hidden" now. */
  hidden(name: string): boolean;
  /** The skin packs the host keeps (web-office-skins.ts). */
  skins?: { list(): { packs: Array<{ id: string }> } & Record<string, unknown>; get(id: string): unknown; picture(id: string, sha: string): Buffer | null };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/**
 * One share's picture, read once from `src`: who is in it (`scope`), and each read the page makes, cut to them.
 * `offices`: the shared office, or every stored office; `null` when the shared office is gone (the share then shows
 * nothing and its owner is told it ended).
 */
export class OfficeShareView {
  readonly offices: Office[] | null;
  readonly scope: ReadonlySet<string>;
  private readonly people: Array<Record<string, unknown>>;
  /** fleet.yaml's teams with someone shown, each with only its shown members. */
  private readonly teams: Array<{ name: string; members: string[] }>;

  constructor(private readonly share: Pick<OfficeShare, "office" | "text"> & Partial<Pick<OfficeShare, "expiresAt">>, private readonly src: OfficeShareSource) {
    const status = src.status();
    const listed = isObj(status) && Array.isArray(status.instances) ? status.instances.filter(isObj) : [];
    const known = listed.filter(i => typeof i.name === "string" && !src.hidden(i.name as string));
    const org = src.org();
    const teams = (Array.isArray(org.teams) ? org.teams : []).filter(isObj)
      .map(t => ({ name: typeof t.name === "string" ? t.name : "", members: strings(t.members) })).filter(t => t.name);
    const chart: OfficeChart = { names: known.map(i => i.name as string), teams };
    const stored = src.offices().offices;
    if (share.office === ALL_OFFICES) {
      this.offices = stored;
      this.scope = new Set(chart.names);
    } else {
      const one = stored.find(o => o.id === share.office);
      this.offices = one ? [one] : null;
      this.scope = new Set(one ? officeMembers(one, chart).filter(n => chart.names.includes(n)) : []);
    }
    this.teams = teams.map(t => ({ name: t.name, members: t.members.filter(n => this.scope.has(n)) })).filter(t => t.members.length);
    this.people = known.filter(i => this.scope.has(i.name as string)).map(i => {
      const out: Record<string, unknown> = {};
      for (const k of PERSON_FIELDS) if (Object.prototype.hasOwnProperty.call(i, k) && i[k] !== undefined) out[k] = i[k];
      // What it waits on at its terminal is its own business: only that it waits (the page's "needs you" pose).
      if (i.state === "awaiting_input") out.state = "awaiting_input";
      return out;
    });
  }

  /** The status frame as the page's app store takes it, and the chart's structure (no descriptions, threads or info). */
  state(): Record<string, unknown> {
    const org = this.src.org();
    const teams = this.teams;
    const traffic = this.src.traffic();
    const among = (v: unknown) => isObj(v) && typeof v.from === "string" && typeof v.to === "string" && this.scope.has(v.from) && this.scope.has(v.to);
    return {
      instances: this.people,
      org: { general: strings(org.general).filter(n => this.scope.has(n)), teams, instances: {} },
      needs: this.src.needs().filter(n => this.scope.has(n)).map(instance => ({ instance })),
      traffic: { now: traffic.now, items: traffic.items.filter(among), delegations: (traffic.delegations ?? []).filter(among) },
      text: this.share.text,
      // Which office the page opens on: the shared one, or All offices.
      office: this.share.office,
      // When it ends (wall clock, the host's): the page says until when.
      ...(typeof this.share.expiresAt === "number" ? { ends: this.share.expiresAt } : {}),
    };
  }

  /**
   * /ui/offices's answer, the shared office (or all) only, each cut to the share (#2637 review): its members only those
   * shown (an instance, or a team with someone shown; NOBODY when none is), and a seat kept for someone not shown keeps
   * its place but not the name. The stored offices are never changed.
   */
  officeList(): { rev: number; offices: Office[]; readable: boolean } {
    const teams = new Set(this.teams.map(t => t.name));
    const cut = (o: Office): Office => {
      const members = o.members.filter(m => (m.startsWith("team:") ? teams.has(m.slice(5)) : this.scope.has(m)));
      const out: Office = { ...o, members: o.members.length && !members.length ? [NOBODY] : members };
      if (o.layout) {
        out.layout = { ...o.layout, seats: o.layout.seats.map(({ instance, ...seat }) => (instance !== undefined && this.scope.has(instance) ? { ...seat, instance } : seat)) };
      }
      return out;
    };
    return { rev: this.src.offices().rev, offices: (this.offices ?? []).map(cut), readable: true };
  }

  /** /ui/office-acts's answer: the acts of the people shown, in a shown office, without their line unless shared. */
  acts(): { acts: OfficeAct[]; now: number } {
    const ids = new Set((this.offices ?? []).map(o => o.id));
    const acts = this.src.acts().filter(a => this.scope.has(a.instance) && ids.has(a.office)).map(a => {
      // Walking to someone not shown (#2637 review): the act stays, without whom it walks to.
      const { say, person, ...rest } = a;
      return { ...rest, ...(person !== undefined && this.scope.has(person) ? { person } : {}), ...(this.share.text && say !== undefined ? { say } : {}) };
    });
    return { acts, now: Date.now() };
  }

  /**
   * A pack's answer as this share gets it (#2637 review): its manifest's instance names cut to the share — `byInstance`
   * only for people shown, a furniture item's `activeFor` only them (none left: [], which watches nobody, never the
   * missing key, which watches everyone). A copy: the kept pack is never changed.
   */
  pack(answer: unknown): unknown {
    if (!isObj(answer) || !isObj(answer.manifest)) return answer;
    const manifest: Record<string, unknown> = { ...answer.manifest };
    if (isObj(manifest.byInstance)) manifest.byInstance = Object.fromEntries(Object.entries(manifest.byInstance).filter(([k]) => this.scope.has(k)));
    if (Array.isArray(manifest.furniture)) {
      manifest.furniture = manifest.furniture.map(f => {
        if (!isObj(f) || f.activeFor === undefined) return f;
        const names = (Array.isArray(f.activeFor) ? f.activeFor : [f.activeFor]).filter((n): n is string => typeof n === "string" && this.scope.has(n));
        return { ...f, activeFor: names };
      });
    }
    return { ...answer, manifest };
  }

  /** The packs the shown offices are drawn in (a pack no shown office names is not offered). */
  skinIds(): Set<string> {
    return new Set((this.offices ?? []).map(o => o.skin));
  }
}

// ── The gateway ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface OfficeShareGateway {
  readonly server: Server;
  readonly readinessMarker: string;
  listen(): Promise<URL>;
  setHost(host: string | null): void;
  close(): void;
}

/**
 * The share tunnel's gateway. GET and HEAD only, on this tunnel's own Host; `/ready` for the tunnel's probe; then
 * `/o/<token>` and its reads, for an open share within its limits:
 *
 *   /o/<t>                                  the page (`page`; 404 while there is none)
 *   /o/<t>/state                            OfficeShareView.state()
 *   /o/<t>/offices                          OfficeShareView.officeList()
 *   /o/<t>/office-acts                      OfficeShareView.acts()
 *   /o/<t>/office-skins                     the packs the shown offices use
 *   /o/<t>/office-skins/<id>                one of them, its instance names cut to the share (never cached)
 *   /o/<t>/office-skins/<id>/img/<sha>.png  its picture (immutable)
 *
 * and, with no token, the page's static files at the dashboard's own paths (`statics`: `/assets/<name>`, `/ui/js/<name>`;
 * office-share-page.ts names them), limited together (OFFICE_SHARE_LIMITS.static*).
 *
 * Anything else, an unknown or ended token, an office since deleted: an empty 404 (no word on why: a stranger learns
 * nothing). Over the limit: 429. The share is asked again before each answer is sent. No cookie is read or set and
 * nothing is logged per request.
 */
export function createOfficeShareGateway(opts: {
  shares: Pick<OfficeShares, "find">;
  source: OfficeShareSource;
  limiter?: OfficeShareLimiter;
  /** The page for a share (HTML), or null while there is none. */
  page?(share: OfficeShare, token: string): { body: string; csp: string } | null;
  /** A static file of the page by its path (`/assets/…`, `/ui/js/…`), or null. */
  statics?(path: string): { body: Buffer; type: string } | null;
  staticLimiter?: OfficeShareLimiter;
  create?: typeof createServer;
  marker?: string;
}): OfficeShareGateway {
  let host: string | null = null;
  const marker = opts.marker ?? `agend-office-share-${randomBytes(8).toString("hex")}`;
  const limiter = opts.limiter ?? new OfficeShareLimiter();
  const staticLimiter = opts.staticLimiter
    ?? new OfficeShareLimiter(undefined, { requests: OFFICE_SHARE_LIMITS.staticRequestsPerMinute, bytes: OFFICE_SHARE_LIMITS.staticBytesPerMinute });
  const tooMany = (res: ServerResponse): void => {
    res.writeHead(429, { "Content-Length": "0", "Cache-Control": "no-store", "Retry-After": "60" });
    res.end();
  };
  const sockets = new Set<Socket>();
  const base = (res: ServerResponse): void => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  };
  const empty = (res: ServerResponse, status: number): void => {
    res.writeHead(status, { "Content-Length": "0", "Cache-Control": "no-store" });
    res.end();
  };
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    base(res);
    if (!host || req.headers.host !== host) return empty(res, 403);
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return empty(res, 405);
    const raw = req.url ?? "/";
    if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(raw)) return empty(res, 400);
    const url = new URL(raw, `https://${host}`);
    if (url.pathname === "/ready") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`<html><body>${marker}</body></html>`);
      return;
    }
    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/ui/js/")) {
      const file = opts.statics?.(url.pathname) ?? null;
      if (!file) return empty(res, 404);
      if (!staticLimiter.admit("static")) return tooMany(res);
      staticLimiter.sent("static", file.body.length);
      res.writeHead(200, { "Content-Type": file.type, "Content-Length": String(file.body.length), "Cache-Control": "no-cache" });
      res.end(method === "HEAD" ? undefined : file.body);
      return;
    }
    const m = /^\/o\/([A-Za-z0-9_-]{43})(\/.*)?$/.exec(url.pathname);
    if (!m) return empty(res, 404);
    const token = m[1]!, rest = m[2] ?? "";
    const share = opts.shares.find(token);
    if (!share) {
      // The page's address says so in words (a person opened a link that ended); its reads stay empty.
      if (rest !== "" && rest !== "/") return empty(res, 404);
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" });
      res.end(method === "HEAD" ? undefined : ENDED_PAGE);
      return;
    }
    if (!limiter.admit(share.id)) return tooMany(res);
    // Every read below is synchronous: the share found above is the share answered.
    const send = (status: number, type: string, body: Buffer | string, cache = "no-store", csp = "default-src 'none'; sandbox"): void => {
      const bytes = typeof body === "string" ? Buffer.from(body) : body;
      limiter.sent(share.id, bytes.length);
      res.writeHead(status, { "Content-Type": type, "Content-Length": String(bytes.length), "Cache-Control": cache, "Content-Security-Policy": csp });
      res.end(method === "HEAD" ? undefined : bytes);
    };
    const json = (body: unknown, cache?: string) => send(200, "application/json; charset=utf-8", JSON.stringify(body), cache);
    if (rest === "" || rest === "/") {
      const page = opts.page?.(share, token) ?? null;
      return page ? send(200, "text/html; charset=utf-8", page.body, "no-store", page.csp) : empty(res, 404);
    }
    const view = new OfficeShareView(share, opts.source);
    if (!view.offices) return empty(res, 404);
    if (rest === "/state") return json(view.state());
    if (rest === "/offices") return json(view.officeList());
    if (rest === "/office-acts") return json(view.acts());
    const skins = opts.source.skins;
    if (!skins) return empty(res, 404);
    const used = view.skinIds();
    if (rest === "/office-skins") {
      const all = skins.list();
      return json({ ...all, packs: all.packs.filter(p => used.has(p.id)) });
    }
    const one = /^\/office-skins\/([A-Za-z0-9_-]{1,40})$/.exec(rest);
    if (one) {
      const pack = used.has(one[1]!) ? skins.get(one[1]!) : null;
      if (!pack) return empty(res, 404);
      // Never cached: what it names follows who is shown now (view.pack).
      return json(view.pack(pack));
    }
    const picture = /^\/office-skins\/([A-Za-z0-9_-]{1,40})\/img\/([0-9a-f]{32})\.png$/.exec(rest);
    if (picture) {
      const bytes = used.has(picture[1]!) ? skins.picture(picture[1]!, picture[2]!) : null;
      return bytes ? send(200, "image/png", bytes, "public, max-age=31536000, immutable") : empty(res, 404);
    }
    return empty(res, 404);
  };
  const server = (opts.create ?? createServer)((req, res) => {
    try { handle(req, res); } catch { if (!res.headersSent) empty(res, 400); else res.destroy(); }
  });
  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.setTimeout(15_000, socket => socket.destroy());
  server.on("connection", socket => { if (sockets.size >= 32) { socket.destroy(); return; } sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("clientError", (_err, socket) => socket.destroy());
  server.on("error", () => { host = null; });
  return {
    server, readinessMarker: marker,
    listen: () => new Promise((resolve, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", rejectListen);
        const address = server.address();
        if (!address || typeof address === "string") { rejectListen(new Error("office share gateway not bound")); return; }
        resolve(new URL(`http://127.0.0.1:${address.port}`));
      });
    }),
    setHost: value => {
      if (value !== null && !QUICK_TUNNEL_HOST.test(value)) throw new Error("invalid tunnel host");
      host = value;
    },
    close: () => {
      host = null;
      server.close();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    },
  };
}
