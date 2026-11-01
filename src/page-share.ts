/**
 * #2911 item 8: page share links — one agent-made HTML page, viewable by someone outside the fleet (a Discord user with
 * no sign-in), for a limited time. Design: #2911 issuecomment-6561078095, approved by the leader 2026-11-02 with four
 * conditions (the share gateway stays apart from /web; never the named /web host; no real tunnel in tests; the dialog
 * says "runs the page's own scripts", and no URL in a notice or the log).
 *
 * It rides the Office share's tunnel and gateway (office-share-service.ts, office-share.ts): one more route, `/p/<token>`.
 * - What is shared is a frozen snapshot of the agent's HTML that the server read itself from the chat history (a
 *   complete ```html fence of an agent message, or its .html attachment) — never HTML from the browser. Memory only: a
 *   restart ends every share.
 * - The token is 32 random bytes (base64url), shown once; only its SHA-256 is kept. The URL holds nothing else.
 * - `/p/<token>` is a trusted wrapper of ours — no script, `frame-src 'self'` — that frames `/p/<token>/frame`, where
 *   the snapshot runs under the preview frame's CSP (web-preview.ts: `sandbox allow-scripts`, an opaque origin, no
 *   network, no forms) with `frame-ancestors 'self'`. The wrapper is what contains a navigation (#2917 review P1): a
 *   top-level sandboxed page could still send itself, its URL and its text away with `location` or a meta refresh;
 *   framed, every navigation of the page is checked against the wrapper's `frame-src 'self'` (and it may not navigate
 *   the top: no allow-top-navigation, no popups). The frame is served only as a frame (`Sec-Fetch-Dest: iframe`).
 */
import { createHash, randomBytes } from "node:crypto";
import { previewFrameCsp } from "./web-preview.js";
// office-share.ts imports this module (its gateway serves /p/), so nothing is imported back from it: the token hash is
// the same SHA-256 as an Office share's (hashShareToken), and the per-minute numbers are the same as its.

export const PAGE_SHARE_LIMITS = {
  /** Page shares open at once, fleet-wide (apart from the Office shares' own 10). */
  links: 10,
  /** The most HTML a share holds (UTF-8 bytes): the preview's "ask first" line. */
  maxBytes: 8 * 1024 * 1024,
  /** Lifetime: 1 h unless asked, 15 min to `web.page_share.max_hours` (24 at most). */
  defaultMinutes: 60, minMinutes: 15, maxHours: 24,
  /** Per share, a sliding minute (as an Office share's). */
  requestsPerMinute: 120, bytesPerMinute: 16 * 1024 * 1024,
} as const;

/** The longest title a share keeps (for lists and notices). */
export const PAGE_TITLE_MAX = 80;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hashShareToken = (token: string): string => createHash("sha256").update(token).digest("hex");
const MINUTE_MS = 60_000;

export interface PageShare {
  /** A short handle for lists and revoking (never the token). */
  id: string;
  /** The instance whose chat the page came from (its channel hears when the share starts and ends). */
  instance: string;
  /** The page's <title>, else its file's name, else "" — one line, at most PAGE_TITLE_MAX characters. */
  title: string;
  /** Who made it. */
  owner: string;
  /**
   * Which block of which message it was made from (the panel's "Shared until … · Stop sharing" finds its page by this):
   * the message's boot and id, and the ```html fence's number or the attachment's file id. Not secret: no token.
   */
  from: { boot: string; id: number; fence?: number; att?: string };
  /** The snapshot's size in bytes. */
  bytes: number;
  /** Wall-clock ms, for display; the expiry itself runs on the monotonic clock. */
  createdAt: number; expiresAt: number;
}
export type PageShareCreate =
  | { ok: true; share: PageShare; token: string }
  | { ok: false; error: "too_many" | "duration" | "too_large" | "empty" };

/** The longest a page share may live, in minutes: `web.page_share.max_hours` (whole hours, 1–24), 24 by default. */
export function pageShareMaxMinutes(maxHours: unknown): number {
  const h = typeof maxHours === "number" && Number.isInteger(maxHours) && maxHours >= 1 && maxHours <= PAGE_SHARE_LIMITS.maxHours ? maxHours : PAGE_SHARE_LIMITS.maxHours;
  return h * 60;
}

/** One line of plain text, whitespace and control characters collapsed, cut at `max` characters. */
export function oneLine(value: unknown, max = PAGE_TITLE_MAX): string {
  // \p{Cf} (bidi controls, zero-widths) first: a title in a notice reads as its bytes say (#2914 review).
  const s = String(value ?? "").replace(/\p{Cf}+/gu, "").replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}

/** The text of a page's <title> (as the panel reads it: preview-panel.js htmlTitle), or "". */
export function htmlTitle(code: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(code);
  return m ? m[1]!.replace(/\s+/g, " ").trim() : "";
}

// As the page numbers them (chat-render.js htmlFences): every ```lang fence in order, `html` exactly (any case) kept.
const FENCE_RE = /```([A-Za-z0-9_+.-]{0,32})[^\n]*\n([\s\S]*?)(?:```|$)/g;
/** The ```html fences of a message, in the page's numbering: each one's code, and whether it was closed. */
export function htmlFences(text: string): Array<{ code: string; terminated: boolean }> {
  const src = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
  const re = new RegExp(FENCE_RE.source, "g");
  const out: Array<{ code: string; terminated: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if ((m[1] ?? "").toLowerCase() === "html") out.push({ code: m[2]!.replace(/\n$/, ""), terminated: m[0].slice(-3) === "```" });
    if (m[0].length === 0) break;
  }
  return out;
}

/** /p/<token>/frame's CSP: the preview frame's (sandbox allow-scripts, no network, no forms), framed only by its wrapper. */
export const PAGE_SHARE_CSP = previewFrameCsp(["'self'"]);
/**
 * The wrapper's CSP: no script of its own, its one style block, and a frame only from its own origin — which every
 * navigation of the framed page is checked against (a page sending itself to another host is blocked by the browser).
 */
export const PAGE_WRAPPER_CSP = ["default-src 'none'", "script-src 'none'", "style-src 'unsafe-inline'", "img-src 'none'", "frame-src 'self'", "child-src 'self'",
  "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'"].join("; ");

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]!);
/** The wrapper for a share: its title (escaped) and the one sandboxed frame of /p/<token>/frame. */
export function pageWrapper(token: string, title: string): string {
  const name = escapeHtml(oneLine(title) || "Shared page");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">`
    + `<meta name="referrer" content="no-referrer"><title>${name}</title><style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head>`
    + `<body><iframe src="/p/${token}/frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${name}"></iframe></body></html>`;
}
/** As the preview listener's /frame (web-preview.ts). */
export const PAGE_SHARE_PERMISSIONS = "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), display-capture=(), fullscreen=()";

export const PAGE_ENDED = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>AgEnD shared page</title></head>`
  + `<body><p>This shared page has ended.</p><p lang="zh-TW">這個分享的頁面已結束。</p></body></html>`;

/**
 * The open page shares and their snapshots. Each ends at its deadline (monotonic; a timer tells `changed` then, and
 * find() refuses it from that moment whatever the timer did), when revoked, or when endWhere picks it. `changed` hears
 * every change with the list as it is now and the shares that just ended.
 */
export class PageShares {
  private readonly byHash = new Map<string, { share: PageShare; html: string; deadline: number; timer: ReturnType<typeof setTimeout> | null }>();
  private readonly now: () => number;
  private readonly wall: () => number;

  constructor(private readonly deps: {
    now?(): number;
    wall?(): number;
    changed?(shares: PageShare[], ended: PageShare[]): void;
    random?(n: number): Buffer;
    setTimer?(fn: () => void, ms: number): ReturnType<typeof setTimeout> | null;
    clearTimer?(t: ReturnType<typeof setTimeout>): void;
  } = {}) {
    this.now = deps.now ?? (() => performance.now());
    this.wall = deps.wall ?? (() => Date.now());
  }

  /** A new share of `html` (a snapshot): `minutes` from 15 to `maxMinutes` (60 unless asked). */
  create(opts: { html: string; instance: string; title: string; owner: string; from?: PageShare["from"]; minutes?: number; maxMinutes?: number }): PageShareCreate {
    // Shares past their deadline go now — and are announced now, once, whether this one is made or refused (#2917 review
    // P3: dropped silently, their end was never said and their bookkeeping never cleared).
    const ended = this.prune();
    if (ended.length) this.announce(ended);
    const max = Math.min(opts.maxMinutes ?? PAGE_SHARE_LIMITS.maxHours * 60, PAGE_SHARE_LIMITS.maxHours * 60);
    const minutes = opts.minutes ?? Math.min(PAGE_SHARE_LIMITS.defaultMinutes, max);
    if (!Number.isInteger(minutes) || minutes < PAGE_SHARE_LIMITS.minMinutes || minutes > max) return { ok: false, error: "duration" };
    if (typeof opts.html !== "string" || !opts.html.trim()) return { ok: false, error: "empty" };
    const bytes = Buffer.byteLength(opts.html, "utf8");
    if (bytes > PAGE_SHARE_LIMITS.maxBytes) return { ok: false, error: "too_large" };
    if (this.byHash.size >= PAGE_SHARE_LIMITS.links) return { ok: false, error: "too_many" };
    const random = this.deps.random ?? randomBytes;
    const token = random(32).toString("base64url");
    let id = random(4).toString("hex");
    while (this.list().some(s => s.id === id)) id = random(4).toString("hex");
    const ms = minutes * MINUTE_MS, wall = this.wall();
    const share: PageShare = { id, instance: opts.instance, title: oneLine(opts.title), owner: opts.owner, from: { ...(opts.from ?? { boot: "", id: 0 }) }, bytes, createdAt: wall, expiresAt: wall + ms };
    const timer = (this.deps.setTimer ?? ((fn, t) => { const h = setTimeout(fn, t); h.unref?.(); return h; }))(() => { const ended = this.prune(); if (ended.length) this.announce(ended); }, ms + 50);
    this.byHash.set(hashShareToken(token), { share, html: opts.html, deadline: this.now() + ms, timer });
    this.announce([]);
    return { ok: true, share: { ...share }, token };
  }

  /** The open share a token names and its snapshot, or null (unknown, malformed, ended). */
  find(token: string): { share: PageShare; html: string } | null {
    if (!TOKEN.test(token)) return null;
    const entry = this.byHash.get(hashShareToken(token));
    if (!entry) return null;
    if (entry.deadline <= this.now()) { const ended = this.prune(); if (ended.length) this.announce(ended); return null; }
    return { share: { ...entry.share }, html: entry.html };
  }

  /** The open shares, soonest to end first. */
  list(): PageShare[] {
    const now = this.now();
    return [...this.byHash.values()].filter(e => e.deadline > now).sort((a, b) => a.deadline - b.deadline).map(e => ({ ...e.share, from: { ...e.share.from } }));
  }

  /** End one share by id, or every one ("all"). Returns those that ended. */
  revoke(id: string): PageShare[] { return this.endWhere(s => id === "all" || s.id === id); }

  /** End every share `test` picks; returns those that ended. */
  endWhere(test: (share: PageShare) => boolean): PageShare[] {
    const ended: PageShare[] = [];
    for (const [key, e] of this.byHash) {
      if (!test({ ...e.share })) continue;
      ended.push({ ...e.share });
      this.drop(key);
    }
    if (ended.length) this.announce(ended);
    return ended;
  }

  private drop(key: string): void {
    const e = this.byHash.get(key);
    if (!e) return;
    if (e.timer) (this.deps.clearTimer ?? clearTimeout)(e.timer);
    this.byHash.delete(key);
  }
  private prune(): PageShare[] {
    const now = this.now();
    const ended: PageShare[] = [];
    for (const [key, e] of this.byHash) if (e.deadline <= now) { ended.push({ ...e.share }); this.drop(key); }
    return ended;
  }
  private announce(ended: PageShare[]): void {
    try { this.deps.changed?.(this.list(), ended); } catch { /* a listener's failure never keeps a share open */ }
  }
}
