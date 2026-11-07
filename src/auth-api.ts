import { sameAccount } from "./web-guest-access.js";
import { withAppIconLinks } from "./web-icons.js";
import { readBoundedWebBody } from "./web-body.js";
import { performance } from "node:perf_hooks";
import { withinBudget } from "./monotonic-budget.js";
import { gatewayRequestContext, isWebRequestCurrent } from "./web-request-context.js";
/**
 * The sign-in surface: the page, the exchange, and session management.
 *
 *   GET    /signin                  static page — no side effects, no secret
 *   GET    /assets/<file>           the two scripts the page and the panels load
 *   POST   /auth/login              {code} → session cookie
 *   GET    /auth/session            who am I (+ the CSRF value this session must send)
 *   POST   /auth/logout             end this session
 *   GET    /auth/sessions           this operator's signed-in devices
 *   DELETE /auth/sessions/<handle>  end one of them
 *   DELETE /auth/sessions           end all of them
 *   POST   /auth/issue-code         X-Agend-Token only — how `agend web --code` asks for a code
 *   GET    /auth/device             is this a returning device (#1570) — a boolean, no side effect
 *   POST   /auth/request-code       a returning device asks for a fresh code, sent privately to its owner (#1570)
 *   POST   /auth/device-login        a new device on a web-only fleet asks for an 8-character code to be approved elsewhere (#3061)
 *   POST   /auth/device-login/poll   …asks where it stands; once approved, signs itself in (the session is made HERE, not at the approval)
 *   POST   /auth/device-login/cancel …leaves
 *
 * Every GET here is free of side effects: a chat client that previews a link
 * cannot spend a code, mint a session, or move a counter. The only thing that
 * consumes a code is a POST from the page's own origin.
 *
 * Nothing here is behind the global gate — this *is* the way through it — so each
 * route does its own checks, with the same primitives the gate uses.
 *
 * See `docs/design/web-unification-secure-login.zh-TW.md` §3.
 */
import { sendPanelHtml } from "./web-host-guard.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "./logger.js";
import {
  authorizeSession,
  buildClearedSessionCookies,
  buildSessionCookie,
  hasValidHeaderToken,
  isSameOriginRequest,
  isSecureRequest,
  readSessionCookies,
  sessionCookieUpgrade,
  parseCookieHeader,
  WEB_SESSION_COOKIE,
  WEB_SESSION_COOKIE_SECURE,
  WEB_CSRF_MESSAGE,
  type WebGateRequest,
} from "./web-auth.js";
import { csrfTokenFor, labelFromUserAgent, sessionIdHash, tokenEpoch, type SessionRecord, type SessionTier, type WebSessionStore } from "./web-session.js";
import { classifyWebPeer, type WebPeer } from "./authority/web-authority.js";
import { isWsl } from "./wsl-detect.js";
import type { GuestLoginCodes, LoginCodeOwner, LoginCodeRecipient, LoginRedeemResult, WebLoginCodes } from "./web-login.js";
import { buildDeviceCookie, readDeviceCookies, DEVICE_COOKIE, DEVICE_COOKIE_SECURE, type ReturningDevice } from "./web-returning-device.js";
import { fleetCookieName } from "./web-cookie-names.js";
import { buildDeviceLoginCookie, clearDeviceLoginCookie, DEVICE_LOGIN_TTL_MS, peerKeyOf, readDeviceLoginCookie, type DeviceLoginRequests } from "./web-device-login.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const LOGIN_REFUSED_MESSAGE =
  "That code did not work — it may be wrong, expired or already used. Ask for a new one with /web.";
export const LOGIN_PAUSED_MESSAGE = "Too many wrong codes — sign-in is paused for a few minutes.";

const MAX_LOGIN_BODY = 1024;

export interface AuthApiContext {
  readonly webToken: string | null;
  readonly webSessions: WebSessionStore | null;
  readonly webLoginCodes: WebLoginCodes | null;
  /** #1920 step 4: guests' codes (local sign-in), one per account — tried before the admins' code, never counted by it. */
  readonly webGuestLoginCodes?: GuestLoginCodes | null;
  /** #1920 step 4b: a guest's public-link sign-in, said in the opener's General before the session is activated. */
  confirmGuestPublicWebLogin?(info: { label: string; handle: string; account: { adapterId: string; userId: string }; exposureId: string }, current: () => boolean): Promise<void>;
  /** #1920 step 4: a guest code's account may still sign in (guests on, something in scope, not an admin). */
  guestSignInAllowed?(account: { adapterId: string; userId: string }): boolean;
  readonly logger: Logger;
  /** Told after every successful sign-in, so the operator can be shown one they did not make. */
  confirmPublicWebLogin?(info: { label: string; handle: string; owner: LoginCodeOwner }, isCurrent: () => boolean): Promise<void>;
  onWebLogin?(info: { label: string; surface: "local" | "gateway"; tier: SessionTier; handle: string; owner?: { adapterId: string; userId: string } }): void;
  /**
   * #2910 D1: a session signed in with the host's own code (`agend web --code`) — on a web-only fleet, from this computer,
   * it is the host operator, authorized for its life (capped as every authorization). Anything else: nothing happens.
   */
  authorizeHostSession?(record: SessionRecord, peer: WebPeer): void;
  /** #2910 D5: no Discord or Telegram connection at all — the sign-in page leads with `agend web --code`. */
  isWebOnlyFleet?(): boolean;
  /**
   * #3008: a code from the authenticator app, typed at the outside link's sign-in (FleetManager.outsideSignIn): "ok"
   * only for the link connections from outside opened (`exposureId`), with a code not used before.
   */
  outsideSignIn?(exposureId: string | undefined, code: string): { kind: "ok" } | { kind: "wrong" } | { kind: "paused"; retryAfterMs: number } | { kind: "closed" } | { kind: "unavailable" };
  /** #3008: this exposure is the link "Allow connections from outside" opened, open now (its sign-in asks for the code). */
  isOutsideLink?(exposureId: string): boolean;
  /** #3008: the session outsideSignIn's "ok" made is this computer's admin (and a Notice says who signed in). */
  authorizeOutsideSession?(record: SessionRecord, peer: WebPeer, label: string): boolean;
  /** #1570: record this browser as a returning device of the code's owner; the cookie value, or null when not kept. */
  rememberReturningDevice?(owner: LoginCodeOwner, input: { surface: "local" | "gateway"; label: string }): string | null;
  /** #1920 step 4b: a guest's sign-in makes this browser a guest's returning device (its own caps). The cookie, or null. */
  rememberGuestDevice?(account: { adapterId: string; userId: string }, input: { surface: "local" | "gateway"; label: string }): string | null;
  /** #1827: a sign-in as this account — its display name then is the web name it starts with. */
  noteWebSignIn?(account: LoginCodeRecipient): void;
  /** #1570: the returning device a cookie value proves, or null. */
  verifyReturningDevice?(value: string | undefined): ReturningDevice | null;
  /** #1570: send a fresh code privately to the device's owner, if they still may have one. */
  requestReturningCode?(device: ReturningDevice, input: { surface: "local" | "gateway"; exposureId?: string; label: string }):
    Promise<{ kind: "sent" } | { kind: "limited"; retryAfterMs: number } | { kind: "refused" }>;
  /**
   * Refs #3061 (P2a): the requests of device-code sign-in (web-device-login.ts). With `isWebOnlyFleet()`, what makes
   * `/auth/device-login*` exist: a fleet with a chat connection, web authorization off, or the public link, answers 404 there.
   */
  readonly webDeviceLogins?: DeviceLoginRequests | null;
  /**
   * Refs #3061: device-code sign-in is open right now — a web-only fleet with web authorization on (with it off no one
   * can approve, so nothing is offered). Asked again after the body is read. Absent: not open.
   */
  deviceLoginAvailable?(): boolean;
  /** Refs #3061 (P2b): `web.login_qr` — the sign-in page may draw the QR code of the approve link beside the code. Absent: no. */
  loginQrEnabled?(): boolean;
  /**
   * Refs #3061 (P2b): may this request's admin session end ANOTHER session (`DELETE /auth/sessions/<handle>` of someone
   * else's, or `DELETE /auth/sessions`)? A web-only fleet answers yes only for its verified owner: a session a one-time
   * code or a device approval made is not one, and could otherwise sign the owner out. Ending one's own is never asked.
   * Absent: yes, as it always was (a fleet with a chat connection, and any caller that does not set it).
   */
  mayEndOtherSessions?(req: IncomingMessage): boolean;
}

export const CODE_REQUEST_REFUSED_MESSAGE = "A new code could not be sent. Ask for one with /web.";

/** The only files `/assets/` will serve. A map, not a directory: nothing else can be named into it. */
const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "loading.css": { file: join("shared", "loading.css"), type: "text/css; charset=utf-8" },
  "agend-auth.js": { file: join("shared", "agend-auth.js"), type: "text/javascript; charset=utf-8" },
  "signin.js": { file: join("shared", "signin.js"), type: "text/javascript; charset=utf-8" },
  "guest-refused.js": { file: join("shared", "guest-refused.js"), type: "text/javascript; charset=utf-8" },
  "theme.js": { file: join("shared", "theme.js"), type: "text/javascript; charset=utf-8" },
  // #1408: the design tokens every panel shares, and the font they name (Inter, SIL OFL 1.1: shared/fonts/OFL.txt).
  "tokens.css": { file: join("shared", "tokens.css"), type: "text/css; charset=utf-8" },
  "inter.woff2": { file: join("shared", "fonts", "inter.woff2"), type: "font/woff2" },
  // #2631: the Office's built-in Cozy style is drawn on this picture (static, no data, like the font).
  "office-cozy.png": { file: join("shared", "office", "cozy.png"), type: "image/png" },
  // #2947: the built-in Guild and School styles' pictures (the same: static, no data).
  "office-guild.png": { file: join("shared", "office", "guild.png"), type: "image/png" },
  "office-school.png": { file: join("shared", "office", "school.png"), type: "image/png" },
  // #1408: the app shell's public closure — the entry module, everything it imports statically, and the vendored
  // Preact + htm (shared/vendor/vendor.json, byte-checked). Static code with no data, like signin.js; the panels that
  // need a session stay behind the gate under /ui/js/ and are reached only by a dynamic import.
  ...Object.fromEntries([
    "app.js", "app-html.js", "app-i18n.js", "app-route.js", "app-nav.js", "app-ctx.js", "app-stream.js", "app-store.js",
    "app-shell.js", "app-session.js", "web-authorize.js", "app-needs.js", "app-swipe.js", "text-undo.js", "ui-confirm.js", "ui-dialog.js", "ui-menu.js", "ui-states.js", "ui-icons.js", "ui-toast.js",
    // #1408 step 2: View is public (an anonymous reader opens it under web.view_access: open), loaded on demand.
    "panel-view.js", "view-strings.js",
    // Claude history in the View: its renderer, loaded by View when a Claude agent's View is scrolled up (static code; the
    // history is read through the pane's own route and gate).
    "view-history.js",
    // alpha.2 (N1): the sidebar's one instance list, and View's roster read it shows to an anonymous reader.
    "instance-nav.js", "view-roster-store.js",
    // #1523 N2: the instance view switch (Chat | View | Details), in Chat's, View's and Details' headers.
    "instance-switch.js",
    // #1523 N3: every page's header tools (text size, usage), the usage dialog they open, and the read stream it shares with View.
    "header-tools.js", "usage-dialog.js", "usage-meter.js", "read-stream.js",
    // #2585: the docked side panel in the usage rail's place (the shell's right-hand column).
    "side-panel.js",
    // #1665: the host-kept preferences and their browser cache.
    "app-prefs.js",
    // #2726: the setup host's words and codes in both languages (static tables, no data), for the Setup wizard and Apply.
    "setup-host-text.js",
    // #1629 r4 §3: links the signed-in person's owner CSS (static code; the stylesheet itself is session-gated).
    "owner-css.js",
    // #1629: agents' themes on their own chat surfaces (static code; the themes are read behind the gate).
    "app-themes.js",
    // #1629 r4 §1: the identity card (Details, the chat header, and View — whose anonymous reader sees cards too).
    "identity-card.js", "card-strings.js",
    // #1629 r4-4: widgets drawn by the page's own components (static code; the widgets are read behind the gate).
    "agent-widget.js",
    // #2117: the per-device "follow the system's reduced-motion setting" switch for ambient effects.
    "fx-motion.js",
    // #1958: identity colours on the page and the Color dialog (static code; the colours come in the status frame).
    "identity-color.js",
    // #2936 / #2978 merge: Settings' content width (this device's), shared by the shell and the lazy Settings panel.
    "settings-width.js",
    // The computer's display name, in a module of its own so a tab opened before an upgrade loads it fresh (Chat imports it).
    "machine-name.js",
    // Hub PR A (#3226): the chat's drawing, shared by the fleet's chat and the Hub's (static code; messages are read
    // behind each listener's own gate): the thread, its Markdown renderer and previews, times, the composer and WorkBar,
    // the right-hand rail's frame and a page head. Their old /ui/js/ paths re-export them for tabs opened before.
    "chat-thread.js", "chat-render.js", "preview.js", "html-attachment.js", "chat-time.js", "chat-composer.js", "side-rail.js", "page-head.js",
    // Hub E (#3226): the HTML side panel (versions, pages, Point at it). The fleet-only Files & changes and Share register
    // with it from the fleet's /ui/js/preview-panel.js; the Hub never loads those.
    "preview-panel.js", "preview-panel-actions.js", "preview-versions.js", "preview-pages.js",
    // …and the chat's words (static tables), so the Hub draws the same thread in the same words.
    "chat-strings.js", "chat-md-strings.js",
    "preact.module.js", "preact-hooks.module.js", "htm.module.js",
    // #3008: the QR code of an authenticator's setup (qrcode-generator 2.0.4, MIT; shared/vendor/vendor.json, byte-checked).
    // Static code, no data — the secret is drawn by Settings behind the gate; loaded only when an app is being set up.
    "qrcode.module.js",
  ].map(name => [name, { file: join("shared", name), type: "text/javascript; charset=utf-8" }])),
  "app.css": { file: join("shared", "app.css"), type: "text/css; charset=utf-8" },
  // AgEnD Hub P1: the Hub pages' own stylesheet (linked by their lazy modules only; static, no data).
  "hub.css": { file: join("shared", "hub.css"), type: "text/css; charset=utf-8" },
  // alpha.6 feedback: the Hub's signed-out page (linked by panel-hub.js's HubSignIn; an older hub.css lacks it).
  "hub-signin.css": { file: join("shared", "hub-signin.css"), type: "text/css; charset=utf-8" },
  // #3226 B: the Hub chat's stylesheet (linked by hub-chat-strings.js; an older hub.css lacks it).
  "hub-chat.css": { file: join("shared", "hub-chat.css"), type: "text/css; charset=utf-8" },
  // #3226 C: the owner and admin pages' stylesheet (linked by hub-owner-strings.js; an older hub-chat.css lacks it).
  "hub-owner.css": { file: join("shared", "hub-owner.css"), type: "text/css; charset=utf-8" },
  "hub-quota.css": { file: join("shared", "hub-quota.css"), type: "text/css; charset=utf-8" },
  // #3298 S-89: the welcome and group permissions pages (linked by hub-group-strings.js; an older hub-chat.css lacks them).
  "hub-groups.css": { file: join("shared", "hub-groups.css"), type: "text/css; charset=utf-8" },
  // #3153 P1: the Files & changes panel's own stylesheet (linked by its lazy module; an older app.css lacks it).
  "workspace.css": { file: join("shared", "workspace.css"), type: "text/css; charset=utf-8" },
  // #3212: the Accounts view's stylesheet (linked by accounts-view.js; an older app.css lacks it).
  "accounts.css": { file: join("shared", "accounts.css"), type: "text/css; charset=utf-8" },
  // #3292: Keep sign-in alive's line on an Accounts row (linked by accounts-keepalive.js; an older accounts.css lacks it).
  "accounts-keepalive.css": { file: join("shared", "accounts-keepalive.css"), type: "text/css; charset=utf-8" },
  // #3160: Follow agent's stylesheet (linked by workspace-panel.js; an older workspace.css or app.css lacks it).
  "workspace-follow.css": { file: join("shared", "workspace-follow.css"), type: "text/css; charset=utf-8" },
  // The task board's list, filters, card menu and Insights (#3169-#3171): linked by fleet-task-view.js (an older app.css lacks it).
  "task-board.css": { file: join("shared", "task-board.css"), type: "text/css; charset=utf-8" },
  // Settings -> Runtime: the install tabs, command cards, reinstall notice and the account list (credential profiles, which account each sign-in is), linked by panel-runtimes.js; an older app.css lacks it.
  "runtime-install.css": { file: join("shared", "runtime-install.css"), type: "text/css; charset=utf-8" },
  // Claude history in the View: the renderer's own stylesheet (linked by it, so an older app.css never lacks its rules).
  "view-history.css": { file: join("shared", "view-history.css"), type: "text/css; charset=utf-8" },
};

/** True for a name `/assets/` serves. The public link's manifest asks this too: one list, not two. */
export function isServedAsset(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ASSETS, name);
}

export function isAuthPath(path: string): boolean {
  return path === "/" || path === "/signin" || path.startsWith("/auth/") || path.startsWith("/assets/");
}

/**
 * Whether a request skips the global gate. Everything not named here goes
 * through `decideWebGate`.
 *
 * - `/health` (GET) is the monitor's probe; `/agent` (POST) authenticates itself
 *   with an instance token.
 * - The sign-in page and its endpoints are the way *through* the gate; each route
 *   in this file does its own checks.
 * - `/view`'s reads and `/api/ai-usage` are open by default, and only reads: a
 *   write to any of them is gated like everything else, so it needs a session
 *   (with the cookie-write checks) or the header token, never a `?token=`.
 *   `web.view_access: session` closes the reads too.
 */
export function bypassesWebGate(
  req: { method?: string | undefined; url?: string | undefined },
  path: string,
  config: { web?: { view_access?: string } | undefined } | null | undefined,
  isViewRead: (path: string) => boolean,
): boolean {
  const method = req.method ?? "GET";
  if (method === "GET" && req.url === "/health") return true;
  if (method === "POST" && req.url === "/agent") return true;
  if (isAuthPath(path)) return true;
  return (method === "GET" || method === "HEAD") && config?.web?.view_access !== "session" && isViewRead(path);
}

/**
 * AgEnD Hub P1: one public, inert asset by its /assets/ name — what a Hub's own listener serves of the app's static
 * closure. It reads no cookie, session or request header. Returns false when there is no such asset.
 */
export function servePublicAsset(res: ServerResponse, name: string): boolean {
  const asset = Object.prototype.hasOwnProperty.call(ASSETS, name) ? ASSETS[name] : undefined;
  if (!asset) return false;
  try {
    const body = readFileSync(join(__dirname, "ui", asset.file));
    res.writeHead(200, { "Content-Type": asset.type, "X-Content-Type-Options": "nosniff" });
    res.end(body);
    return true;
  } catch { return false; }
}

function json(res: ServerResponse, code: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * The sign-in page. Also what a browser navigation gets from a gated page it has no cookie for. #2910 D5: on a web-only
 * fleet (`webOnly`) its <body> says so, and the page's words lead with `agend web --code` (there is no /web to send).
 */
export function serveSigninPage(res: ServerResponse, status = 200, opts: { webOnly?: boolean; outside?: boolean; deviceLogin?: boolean; loginQr?: boolean } = {}): void {
  try {
    const page = readFileSync(join(__dirname, "ui", "signin.html"), "utf-8");
    // #3008: through the link "Allow connections from outside" opened, the page asks for the authenticator's code.
    // #3061: on this computer's own listener of a web-only fleet (never a public link), it also offers "Sign in with another device".
    const marks = `${opts.webOnly ? ' data-web-only="1"' : ""}${opts.webOnly && opts.outside ? ' data-outside="1"' : ""}${opts.webOnly && opts.deviceLogin && !opts.outside ? ' data-device-login="1"' : ""}${opts.webOnly && opts.deviceLogin && !opts.outside && opts.loginQr ? ' data-login-qr="1"' : ""}`;
    const html = marks ? page.replace("<body>", `<body${marks}>`) : page;
    sendPanelHtml(res, withAppIconLinks(html), status, { "Cache-Control": "no-store" });
  } catch {
    json(res, 500, { error: "signin.html not found" });
  }
}

/**
 * What a guest's browser gets for a page it cannot open (#2399 smoke: the gate's bare JSON before): "members" for a page
 * that is not a guest's, "ended" when no chat is shared with it any more. Its words are the browser's language.
 */
export function serveGuestRefusedPage(res: ServerResponse, status: number, why: "members" | "ended"): void {
  try {
    let html = readFileSync(join(__dirname, "ui", "guest-refused.html"), "utf-8").replace("__WHY__", why);
    // A browser without scripts reads the HTML's own English: the case's words, and no way back that leads here again
    // (#2449 review). The script puts the browser's language over it.
    if (why === "ended") {
      html = html.replace(/<h1 id="title">[^<]*<\/h1>/, '<h1 id="title">No chats are shared with you</h1>')
        .replace(/<p id="lead">[^<]*<\/p>/, "<p id=\"lead\">Your guest access on this fleet has no chat now — you may have left the room it came from. Ask whoever invited you to share a chat with you again.</p>")
        .replace(/\s*<a id="go"[^>]*>[^<]*<\/a>/, "");
    }
    sendPanelHtml(res, withAppIconLinks(html), status, { "Cache-Control": "no-store" });
  } catch {
    json(res, status, { error: why === "ended" ? "guest_scope_empty" : "guest_forbidden" });
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse((await readBoundedWebBody(req, MAX_LOGIN_BODY)).toString("utf8") || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function isJsonRequest(req: IncomingMessage): boolean {
  return String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json");
}

export function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: AuthApiContext,
): boolean {
  const path = url.pathname;
  if (!isAuthPath(path)) return false;
  const method = req.method ?? "GET";
  const gateReq = req as unknown as WebGateRequest;

  // ── `/` is a door, not a page: everything about who may enter is decided at /ui ──
  if (path === "/") {
    if (method !== "GET" && method !== "HEAD") { json(res, 405, { error: "method not allowed" }); return true; }
    res.writeHead(302, { Location: "/ui", "Cache-Control": "no-store" });
    res.end();
    return true;
  }

  // ── The page and its scripts: public, inert ──
  if (path === "/signin") {
    if (method !== "GET" && method !== "HEAD") { json(res, 405, { error: "method not allowed" }); return true; }
    const link = gatewayRequestContext(req);
    serveSigninPage(res, 200, { webOnly: ctx.isWebOnlyFleet?.() === true, outside: !!link && ctx.isOutsideLink?.(link.exposureId) === true,
      deviceLogin: !link && ctx.deviceLoginAvailable?.() === true, loginQr: ctx.loginQrEnabled?.() === true });
    return true;
  }

  if (path.startsWith("/assets/")) {
    const asset = method === "GET" ? ASSETS[path.slice("/assets/".length)] : undefined;
    if (!asset) { json(res, 404, { error: "not found" }); return true; }
    try {
      const body = readFileSync(join(__dirname, "ui", asset.file));
      res.writeHead(200, { "Content-Type": asset.type });
      res.end(body);
    } catch {
      json(res, 404, { error: "not found" });
    }
    return true;
  }

  // ── #3008: POST /auth/totp — signing in from outside, with the authenticator app's code ──
  // Only through the link "Allow connections from outside" opened (the gateway's own provenance names it, never a
  // header); anything else is refused as a wrong code would be, without counting. An admin session with no account,
  // marked `remote`, ended by the switch's Off, a new app, or the link closing.
  if (path === "/auth/totp") {
    if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
    if (!req.headers.origin || !isSameOriginRequest(gateReq)) { json(res, 403, { error: "Cross-site request rejected" }); return true; }
    if (!isJsonRequest(req)) { json(res, 415, { error: "expected application/json" }); return true; }
    const token = ctx.webToken, gateway = gatewayRequestContext(req);
    if (!token || !ctx.webSessions || !gateway || !ctx.outsideSignIn) { json(res, 404, { error: "not_found" }); return true; }
    const sessions = ctx.webSessions, signIn = ctx.outsideSignIn.bind(ctx);
    void readJsonBody(req).then(body => {
      if (!body || typeof body.code !== "string" || body.code.length > 32) { json(res, 400, { error: "expected {\"code\": \"123456\"}" }); return; }
      if (!isWebRequestCurrent(req) || ctx.webToken !== token) { json(res, 401, { error: "wrong_code" }); return; }
      const result = signIn(gateway.exposureId, body.code);
      if (result.kind === "paused") {
        json(res, 429, { error: "paused", retryAfterMs: result.retryAfterMs }, { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) });
        return;
      }
      if (result.kind === "closed") { json(res, 404, { error: "not_found" }); return; }
      if (result.kind === "unavailable") { json(res, 503, { error: "unavailable" }); return; }
      if (result.kind === "wrong") { ctx.logger.debug("outside sign-in refused"); json(res, 401, { error: "wrong_code" }); return; }
      for (const previous of readSessionCookies(gateReq, token)) {
        if (sessions.authenticate(previous, tokenEpoch(token), { touch: false, surface: gateway.surface, exposureId: gateway.exposureId })) sessions.revokeById(previous);
      }
      const label = labelFromUserAgent(typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined);
      const { sessionId, record } = sessions.create({ tier: "admin", surface: gateway.surface, label, tokenEpoch: tokenEpoch(token), exposureId: gateway.exposureId, remote: "totp" });
      if (record.remote !== "totp") { sessions.revokeById(sessionId); json(res, 404, { error: "not_found" }); return; }
      ctx.logger.info({ handle: record.handle, label, surface: record.surface }, "Web sign-in from outside");
      // #3015 review r3: admitted (its handle saved) and authorized, or no session at all.
      let admitted = false;
      try { admitted = ctx.authorizeOutsideSession?.(record, gateway.named === true ? "named_link" : "quick_link", label) === true; } catch (err) { ctx.logger.debug({ err }, "outside session not authorized"); }
      if (!admitted) { sessions.revokeById(sessionId); json(res, 503, { error: "unavailable" }); return; }
      const session = buildSessionCookie(sessionId, isSecureRequest(gateReq), (record.absoluteExpiry - record.created) / 1000, token);
      json(res, 200, { ok: true, csrf: csrfTokenFor(sessionId), tier: record.tier, expiresAt: record.absoluteExpiry }, { "Set-Cookie": session });
    }).catch(() => { if (!res.destroyed && !res.headersSent) json(res, 500, { error: "sign-in failed" }); });
    return true;
  }

  // ── Refs #3061 (P2a): device-code sign-in — a new device on a web-only fleet shows a code, a signed-in owner-verified device approves it ──
  // Three POSTs, none of them a GET: asking for a code and learning where it stands both change state (the poll that finds
  // it approved is what makes the session), and a link preview must never be able to do either. Never over the public
  // link (the gateway's own provenance, never a header): there a person signs in with the authenticator's code. On a fleet
  // with a chat connection the route does not exist either (its codes come from the chat). Nothing here is an input to
  // authority: the session it makes is an ordinary admin session, owner authority not verified (SessionRecord.via).
  if (path === "/auth/device-login" || path === "/auth/device-login/poll" || path === "/auth/device-login/cancel") {
    // Whether the route exists comes first, whatever the method: where it is absent (a chat connection, web authorization off, the
    // public link) a GET or HEAD must read 404 as the public gateway's own refusal does, not 405 — a 405 would say "this path is
    // here, with another method". The 405 is for a feature that is available.
    const token = ctx.webToken, logins = ctx.webDeviceLogins, sessions = ctx.webSessions;
    if (gatewayRequestContext(req) || !token || !logins || !sessions || ctx.deviceLoginAvailable?.() !== true) { json(res, 404, { error: "not_found" }); return true; }
    if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
    // As the one-time code's own exchange: Origin required, from this very site, JSON.
    if (!req.headers.origin || !isSameOriginRequest(gateReq)) { json(res, 403, { error: "Cross-site request rejected" }); return true; }
    if (!isJsonRequest(req)) { json(res, 415, { error: "expected application/json" }); return true; }
    const secure = isSecureRequest(gateReq), epoch = tokenEpoch(token);
    const held = readDeviceLoginCookie(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined, token);
    const gone = clearDeviceLoginCookie(secure, token);
    const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined;
    void readJsonBody(req).then(body => {
      if (!body) { json(res, 400, { error: "expected a JSON object" }); return; }
      // …and again now the body is in: the switch may have gone off, or the fleet changed, while it arrived.
      if (!isWebRequestCurrent(req) || ctx.webToken !== token || ctx.deviceLoginAvailable?.() !== true) { json(res, 404, { error: "not_found" }); return; }
      if (path === "/auth/device-login/cancel") { logins.cancel(held); json(res, 200, { ok: true }, { "Set-Cookie": gone }); return; }

      if (path === "/auth/device-login") {
        // The server's own reading of who is asking — never anything the body says: a label for the person approving
        // (a coarse User-Agent hint, display only), whether the request came from this computer or the network, and
        // the peer's address. The approver is shown the whole of it; the rate limits count an IPv6 one by its /64
        // (peerKeyOf) and an IPv4 one as it is — from the socket, never a header, so behind a reverse proxy on this
        // machine every device is one address and shares one allowance.
        const address = (req.socket?.remoteAddress ?? "unknown").replace(/^::ffff:/i, "").slice(0, 64);
        const peer = classifyWebPeer(req) === "loopback" ? "host" as const : "network" as const;
        const made = logins.create({ epoch, peerKey: peerKeyOf(req.socket?.remoteAddress ?? "unknown"), label: labelFromUserAgent(userAgent), peer, address, ...(held ? { replaces: held } : {}) });
        if (made.kind === "limited") {
          ctx.logger.warn({ address }, "Device sign-in code requests limited");
          json(res, 429, { error: "limited", retryAfterMs: made.retryAfterMs }, { "Retry-After": String(Math.ceil(made.retryAfterMs / 1000)), ...(held ? { "Set-Cookie": gone } : {}) });
          return;
        }
        if (made.kind === "full") { json(res, 503, { error: "busy" }, held ? { "Set-Cookie": gone } : {}); return; }
        ctx.logger.info({ address, peer }, "Device sign-in code asked for");
        json(res, 200, { code: made.code, expiresAt: made.expiresAt, ttlMs: DEVICE_LOGIN_TTL_MS },
          { "Set-Cookie": buildDeviceLoginCookie(made.requestId, secure, token, DEVICE_LOGIN_TTL_MS / 1000), "Cache-Control": "no-store" });
        return;
      }

      // …/poll: where does it stand? An approved request is spent by this call, and the session made here.
      const polled = logins.poll(held, epoch);
      if (polled.kind === "pending") { json(res, 200, { state: "pending", expiresAt: polled.expiresAt }, { "Cache-Control": "no-store" }); return; }
      if (polled.kind !== "claimed") { json(res, 200, { state: polled.kind }, { "Set-Cookie": gone, "Cache-Control": "no-store" }); return; }
      // A new id every time, whatever the request carried (as /auth/login): a cookie it already had is retired.
      for (const previous of readSessionCookies(gateReq, token)) {
        if (sessions.authenticate(previous, epoch, { touch: false, surface: "local" })) sessions.revokeById(previous);
      }
      const { sessionId, record } = sessions.create({ tier: "admin", surface: "local", label: polled.label, tokenEpoch: epoch, via: "device" });
      ctx.logger.info({ handle: record.handle, label: record.label, approvedBy: polled.approvedBy.slice(0, 8), surface: record.surface }, "Web sign-in with a device code");
      try { ctx.onWebLogin?.({ label: record.label, surface: record.surface, tier: record.tier, handle: record.handle }); } catch (err) { ctx.logger.debug({ err }, "web sign-in notice failed"); }
      const session = buildSessionCookie(sessionId, secure, (record.absoluteExpiry - record.created) / 1000, token);
      json(res, 200, { state: "approved", ok: true, csrf: csrfTokenFor(sessionId), tier: record.tier, expiresAt: record.absoluteExpiry },
        { "Set-Cookie": [session, gone], "Cache-Control": "no-store" });
    }).catch(() => { if (!res.destroyed && !res.headersSent) json(res, 500, { error: "sign-in failed" }); });
    return true;
  }

  // ── POST /auth/login ──
  if (path === "/auth/login") {
    if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
    // Origin is required, not merely checked: the sign-in page is always same-origin,
    // and a login POST with no Origin is nobody's legitimate request.
    if (!req.headers.origin || !isSameOriginRequest(gateReq)) { json(res, 403, { error: "Cross-site request rejected" }); return true; }
    if (!isJsonRequest(req)) { json(res, 415, { error: "expected application/json" }); return true; }
    const token = ctx.webToken;
    if (!token || !ctx.webSessions || !ctx.webLoginCodes) { json(res, 401, { error: LOGIN_REFUSED_MESSAGE }); return true; }
    const sessions = ctx.webSessions;
    const codes = ctx.webLoginCodes;
    // A notice ACK cannot create an orphan credential after the browser has
    // disconnected. Normal completed request-body close is not an abort.
    const publicRequest = !!gatewayRequestContext(req);
    let disconnected = false;
    let candidateId: string | undefined;
    const disconnect = (): void => {
      disconnected = true;
      if (candidateId) sessions.revokeById(candidateId);
    };
    if (publicRequest) { req.once("aborted", disconnect); res.once?.("close", disconnect); }
    void readJsonBody(req).then(async body => {
      if (!body || typeof body.code !== "string") { json(res, 400, { error: "expected {\"code\": \"XXXX-XXXX\"}" }); return; }
      const gateway = gatewayRequestContext(req);
      const current = (): boolean => isWebRequestCurrent(req) && ctx.webToken === token
        && (!publicRequest || (!disconnected && !req.aborted && !(req.destroyed && !req.complete) && !res.destroyed && !res.writableEnded));
      if (!current()) { json(res, 401, { error: LOGIN_REFUSED_MESSAGE }); return; }
      // #1920 step 4: a guest's code first (matching counts nothing), then the admins' as before; a code neither knows is
      // one wrong try against the guests' codes too. Either breaker open pauses both: guessing is guessing.
      const guestCodes = ctx.webGuestLoginCodes ?? null;
      const audience = gateway?.exposureId ?? "local";
      const guestPausedMs = guestCodes?.pausedForMs() ?? 0;
      // #3270: what a long-lived first-install code additionally needs — this computer's own loopback peer, and no host session ever authorized.
      const redeemContext = { loopbackPeer: !gateway && classifyWebPeer(req) === "loopback", hostEverAuthorized: sessions.hostEverAuthorized };
      const result: LoginRedeemResult = guestPausedMs > 0 ? { kind: "paused", retryAfterMs: Math.max(guestPausedMs, codes.pausedForMs(audience)) }
        : codes.pausedForMs(audience) > 0 ? codes.redeem(body.code, tokenEpoch(token), audience, redeemContext)
        : guestCodes?.match(body.code, tokenEpoch(token), audience) ?? codes.redeem(body.code, tokenEpoch(token), audience, redeemContext);
      if (result.kind === "invalid") guestCodes?.recordWrong(body.code);
      if (result.kind === "paused") {
        json(res, 429, { error: LOGIN_PAUSED_MESSAGE }, { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) });
        return;
      }
      if (result.kind === "invalid") {
        ctx.logger.debug("web sign-in refused");
        json(res, 401, { error: LOGIN_REFUSED_MESSAGE });
        return;
      }
      // A guest code signs in only its account, and only while that account is still a guest with something to see
      // (guest sign-in turned off, the account made an admin or out of scope since the code went out: refused).
      if (result.tier === "guest" && (!result.recipient || !ctx.guestSignInAllowed?.(result.recipient))) {
        ctx.logger.info("Guest web sign-in refused: the account is no longer admitted");
        json(res, 401, { error: LOGIN_REFUSED_MESSAGE });
        return;
      }
      // A new id every time, whatever the request carried: the browser never
      // gets to choose the value it will be authenticated by, and a cookie it
      // already had is retired rather than upgraded.
      for (const previous of readSessionCookies(gateReq, token)) {
        if (sessions.authenticate(previous, tokenEpoch(token), { touch: false, surface: gateway?.surface, exposureId: gateway?.exposureId })) sessions.revokeById(previous);
      }
      const label = labelFromUserAgent(typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined);
      // #1827: the session is bound to the account the code was sent to privately (agents recognise them by its id on
      // the web) — recognition only; no recipient (an `agend web` code): the operator, as before.
      const account = result.recipient;
      const { sessionId, record } = sessions.create({ tier: result.tier, surface: gateway?.surface ?? "local", label, tokenEpoch: tokenEpoch(token), exposureId: gateway?.exposureId, pending: !!gateway,
        ...(account ? { owner: { adapterId: account.adapterId, userId: account.userId } } : {}),
        // #2910 D1: only a code the host's shell asked for — never one sent to an account, never over the public link.
        ...(result.host && !account && !gateway ? { host: true as const } : {}) });
      // …and that account's display name then is the name the person starts with (on every device of theirs). A code
      // re-sent to a returning device (#1570) carries no name: the one from their last sign-in stays.
      if (account?.username) {
        try { ctx.noteWebSignIn?.(account); } catch (err) { ctx.logger.debug({ err }, "web sign-in name not recorded"); }
      }
      if (gateway) candidateId = sessionId;
      if (gateway) {
        try {
          if (result.tier === "guest") {
            // #1920 §5.5: a guest through the public link — its own notice (who, how many agents), in the opener's General.
            if (!account || !ctx.confirmGuestPublicWebLogin) throw new Error("public notice unavailable");
            await withinBudget(ctx.confirmGuestPublicWebLogin({ label, handle: record.handle, account, exposureId: gateway.exposureId }, current), performance.now() + 5_000);
          } else {
            if (!result.owner || !ctx.confirmPublicWebLogin) throw new Error("public notice unavailable");
            await withinBudget(ctx.confirmPublicWebLogin({ label, handle: record.handle, owner: result.owner }, current), performance.now() + 5_000);
          }
          if (!current() || !sessions.activate(sessionId)) throw new Error("public login closed");
        } catch {
          sessions.revokeById(sessionId);
          ctx.logger.debug("Public sign-in could not be confirmed");
          if (!res.destroyed) json(res, 503, { error: "Sign-in could not be confirmed. Ask for a new code and try again." });
          return;
        }
      }
      ctx.logger.info({ handle: record.handle, label, tier: record.tier, surface: record.surface }, "Web sign-in");
      if (record.host) {
        try { ctx.authorizeHostSession?.(record, classifyWebPeer(req)); } catch (err) { ctx.logger.debug({ err }, "host session not authorized"); }
      }
      try { if (!gateway) ctx.onWebLogin?.({ label, surface: record.surface, tier: record.tier, handle: record.handle, ...(record.owner ? { owner: record.owner } : {}) }); } catch (err) { ctx.logger.debug({ err }, "web sign-in notice failed"); }
      // #1570: a code delivered privately to its owner makes this browser a returning device (a separate cookie; the
      // session id above is unrelated to it). A code with no owner (`agend web --code`) does not.
      let device: string | null = null;
      try {
        device = result.tier === "guest" && account ? ctx.rememberGuestDevice?.(account, { surface: record.surface, label }) ?? null
          : result.owner ? ctx.rememberReturningDevice?.(result.owner, { surface: record.surface, label }) ?? null : null;
      } catch (err) { ctx.logger.debug({ err }, "returning device not recorded"); }
      const secure = isSecureRequest(gateReq);
      const session = buildSessionCookie(sessionId, secure, (record.absoluteExpiry - record.created) / 1000, token);
      json(res, 200, { ok: true, csrf: csrfTokenFor(sessionId), tier: record.tier, expiresAt: record.absoluteExpiry }, {
        "Set-Cookie": device ? [session, buildDeviceCookie(device, secure, token)] : session,
      });
    }).catch(() => { if (!res.destroyed && !res.headersSent) json(res, 500, { error: "sign-in failed" }); })
      .finally(() => { req.removeListener("aborted", disconnect); res.removeListener?.("close", disconnect); });
    return true;
  }

  // ── #1570: a returning device — GET is a boolean and nothing else; POST asks for a code for its owner ──
  if (path === "/auth/device" || path === "/auth/request-code") {
    const cookie = typeof req.headers.cookie === "string" ? req.headers.cookie : undefined;
    const token = ctx.webToken;
    let device: ReturningDevice | null = null, deviceValue: string | undefined;
    for (const value of token ? readDeviceCookies(cookie, !!gatewayRequestContext(req), token) : []) {
      const candidate = ctx.verifyReturningDevice?.(value);
      if (candidate) { device = candidate; deviceValue = value; break; }
    }
    if (path === "/auth/device") {
      if (method !== "GET") { json(res, 405, { error: "method not allowed" }); return true; }
      const secure = isSecureRequest(gateReq);
      const name = fleetCookieName(secure ? DEVICE_COOKIE_SECURE : DEVICE_COOKIE, token);
      const upgrade = device && deviceValue && parseCookieHeader(cookie).get(name) !== deviceValue
        ? buildDeviceCookie(deviceValue, secure, token, (device.expires - Date.now()) / 1000) : null;
      json(res, 200, { returning: device !== null }, { "Cache-Control": "no-store", ...(upgrade ? { "Set-Cookie": upgrade } : {}) });
      return true;
    }
    if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
    if (!req.headers.origin || !isSameOriginRequest(gateReq)) { json(res, 403, { error: "Cross-site request rejected" }); return true; }
    if (!isJsonRequest(req)) { json(res, 415, { error: "expected application/json" }); return true; }
    if (!device || !ctx.requestReturningCode) { json(res, 401, { error: CODE_REQUEST_REFUSED_MESSAGE }); return true; }
    const gateway = gatewayRequestContext(req);
    const label = labelFromUserAgent(typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined);
    void readJsonBody(req).then(async () => {
      if (!isWebRequestCurrent(req)) { json(res, 503, { error: CODE_REQUEST_REFUSED_MESSAGE }); return; }
      const outcome = await ctx.requestReturningCode!(device, { surface: gateway?.surface ?? "local", exposureId: gateway?.exposureId, label });
      if (outcome.kind === "sent") { json(res, 202, { ok: true }); return; }
      if (outcome.kind === "limited") {
        json(res, 429, { error: "Too many requests — wait a little and try again." }, { "Retry-After": String(Math.ceil(outcome.retryAfterMs / 1000)) });
        return;
      }
      json(res, 503, { error: CODE_REQUEST_REFUSED_MESSAGE });
    }).catch(() => { if (!res.destroyed && !res.headersSent) json(res, 503, { error: CODE_REQUEST_REFUSED_MESSAGE }); });
    return true;
  }

  // ── POST /auth/issue-code — a local script's way to ask for a code ──
  if (path === "/auth/issue-code") {
    if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
    const token = ctx.webToken;
    if (gatewayRequestContext(req) || !token || !ctx.webLoginCodes || !isSameOriginRequest(gateReq) || !hasValidHeaderToken(gateReq, token)) {
      json(res, 401, { error: "X-Agend-Token required" });
      return true;
    }
    // #3327 (#3345 review): the host's own code is asked for on this computer only — a direct loopback peer, a loopback
    // Host and no forwarding header (classifyWebPeer). Its one caller is `agend web` here; the web token alone, from a
    // remote peer or through a proxy, must not mint an admin session (threat model 64a289a0: remote parties are not the
    // owner). Redeeming the code it prints still works from wherever the owner types it.
    if (classifyWebPeer(req) !== "loopback") {
      ctx.logger.info({ source: "cli" }, "Web login code refused: not asked from this computer");
      json(res, 403, { error: "A sign-in code can only be asked for on the AgEnD computer itself." });
      return true;
    }
    // #2910 D1: the shell's own code — the host operator's on a web-only fleet (fleet-manager authorizeHostSession).
    // #3270: the first host code on a fresh install (no host session EVER authorized — not "none right now") may live for an
    // hour instead of five minutes, redeemable from this computer only and only until the first host session exists. Every
    // one of these must hold, and a missing header is the ordinary 5 minutes:
    //   - the caller says the code is going to an interactive terminal (`X-Agend-Code-Delivery: tty`; `agend web --code` with a
    //     TTY on stdout). A code for a URL (`url`: browser history), for a pipe or a redirect (`non-tty`: an install log, a
    //     service's journal) or from a caller that does not say, is never the long one;
    //   - this is not WSL: Windows processes reach the fleet as loopback there and can read the distro's files;
    //   - no host session was ever authorized here (the persisted marker).
    // Nothing logged below carries the code itself — only that a first-install one was issued.
    const delivery = String(req.headers["x-agend-code-delivery"] ?? "").trim().toLowerCase();
    const bootstrap = delivery === "tty" && !isWsl() && !!ctx.webSessions && !ctx.webSessions.hostEverAuthorized;
    const issued = ctx.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(token), host: true, ...(bootstrap ? { bootstrap: true as const } : {}) });
    ctx.logger.info({ source: "cli", ...(issued.bootstrap ? { bootstrap: true } : {}) }, "Web login code issued");
    json(res, 200, { code: issued.display, expiresAt: issued.expiresAt, ...(issued.bootstrap ? { bootstrap: true } : {}) });
    return true;
  }

  // ── The session's own endpoints: a session, and nothing else, is the credential ──
  if (path === "/auth/session" || path === "/auth/logout" || path === "/auth/sessions" || path.startsWith("/auth/sessions/")) {
    const token = ctx.webToken;
    const auth = authorizeSession(gateReq, token, ctx.webSessions, { touch: path === "/auth/session" });
    if (auth.kind === "reject") {
      json(res, auth.status, auth.message === WEB_CSRF_MESSAGE ? { error: auth.message } : { ok: false, error: auth.message });
      return true;
    }
    const sessions = ctx.webSessions!;
    const { session, sessionId } = auth;
    // A legacy name is shared with other ports. Clear our old credentials (or an absent slot),
    // but never erase another fleet's still-unmigrated value. Check BEFORE revoking our records.
    const jar = parseCookieHeader(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
    const cookiesToClear = buildClearedSessionCookies(token).filter(header => {
      const name = header.slice(0, header.indexOf("="));
      if (name !== WEB_SESSION_COOKIE && name !== WEB_SESSION_COOKIE_SECURE) return true;
      const value = jar.get(name);
      return !value || !!sessions.authenticate(value, tokenEpoch(token!), { touch: false, surface: session.surface, exposureId: session.exposureId });
    });
    // #1920: a session that is not an admin's sees and ends only its own: itself, and its account's other sessions.
    const own = session.tier === "admin" ? undefined
      : (r: { idHash: string; owner?: { adapterId: string; userId: string } }) => r.idHash === session.idHash || sameAccount(r.owner, session.owner);

    if (path === "/auth/session" && method === "GET") {
      const upgrade = token ? sessionCookieUpgrade(gateReq, token, session) : null;
      json(res, 200, {
        ok: true,
        csrf: csrfTokenFor(sessionId),
        handle: session.handle,
        tier: session.tier,
        surface: session.surface,
        label: session.label,
        created: session.created,
        expiresAt: session.absoluteExpiry,
        idleExpiresAt: session.idleExpiry,
        idleMs: sessions.idleWindowMs(session.surface, session.tier),
      }, upgrade ? { "Set-Cookie": upgrade } : {});
      return true;
    }

    if (path === "/auth/logout" && method === "POST") {
      const { durable } = sessions.revokeById(sessionId);
      if (!durable) return notDurable(res, ctx, { handle: session.handle }, "Web sign-out not saved", cookiesToClear);
      ctx.logger.info({ handle: session.handle }, "Web sign-out");
      json(res, 200, { ok: true }, { "Set-Cookie": cookiesToClear });
      return true;
    }

    // Refs #3061 (P2b): an admin session's right to end the others — told with the list so the menu can hide its buttons, and
    // asked again by each write below (the page's idea of it is never the check). A non-admin only ever ends its own.
    const mayEndOthers = (): boolean => own !== undefined || ctx.mayEndOtherSessions?.(req) !== false;

    if (path === "/auth/sessions" && method === "GET") {
      json(res, 200, { sessions: sessions.list(sessionIdHash(sessionId), own), ...(own === undefined && !mayEndOthers() ? { canEndOthers: false } : {}) });
      return true;
    }

    if (path === "/auth/sessions" && method === "DELETE") {
      if (!mayEndOthers()) { json(res, 403, { error: "owner_required" }); return true; }
      const { count, durable } = sessions.revokeAll(own);
      if (!durable) return notDurable(res, ctx, { count }, "Web sessions revoked in memory only", cookiesToClear);
      ctx.logger.info({ count, ...(own ? { own: true } : {}) }, own ? "Web sessions revoked (the caller's own)" : "Web sessions revoked (all)");
      json(res, 200, { ok: true, revoked: count }, { "Set-Cookie": cookiesToClear });
      return true;
    }

    if (path.startsWith("/auth/sessions/") && method === "DELETE") {
      const handle = path.slice("/auth/sessions/".length);
      const wasCurrent = handle === session.handle;
      // Someone else's session: the owner's to end on a web-only fleet (checked before the handle is looked up, so a
      // non-owner learns nothing about which handles exist). One's own is a sign-out, as ever.
      if (!wasCurrent && !mayEndOthers()) { json(res, 403, { error: "owner_required" }); return true; }
      const { found, durable } = sessions.revokeByHandle(handle, own);
      if (!found) { json(res, 404, { error: "no such session" }); return true; }
      if (!durable) return notDurable(res, ctx, { handle }, "Web session revoked in memory only", wasCurrent ? cookiesToClear : false);
      ctx.logger.info({ handle }, "Web session revoked");
      json(res, 200, { ok: true, current: wasCurrent }, wasCurrent ? { "Set-Cookie": cookiesToClear } : {});
      return true;
    }

    json(res, 405, { error: "method not allowed" });
    return true;
  }

  json(res, 404, { error: "not found" });
  return true;
}

export const REVOCATION_NOT_DURABLE_MESSAGE =
  "Signed out for now, but the change could not be saved: the session file could not be updated or removed, so a fleet restart may bring the session back. This page cannot repair session storage.";

/**
 * A revocation that holds only in memory is reported as a failure (500), never as "ok": the browser is
 * still told to drop its cookie (it is signed out here), but whoever asked must not believe a session is
 * dead that the next start revives.
 */
function notDurable(res: ServerResponse, ctx: { logger: Logger }, detail: Record<string, unknown>, msg: string, clearCookies: string[] | false): true {
  ctx.logger.warn({ ...detail, durable: false }, msg);
  json(res, 500, { ok: false, durable: false, error: REVOCATION_NOT_DURABLE_MESSAGE }, clearCookies ? { "Set-Cookie": clearCookies } : {});
  return true;
}
