import { publicTunnelHostname } from "./public-tunnel-config.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { bindGatewayRequest } from "./web-request-context.js";
import { applyWebSecurityHeaders } from "./web-host-guard.js";
import { isServedAsset } from "./auth-api.js";
import { shellRoute } from "./web-shell-routes.js";
import { isWebIconPath } from "./web-icons.js";
import { UPLOAD_REQUEST_TIMEOUT_MS } from "./web-upload.js";
import { LIBAVOID_PATHS } from "./web-libavoid.js";
import { takeAssetVersion } from "./web-asset-version.js";

/** #1937: how long a public-link request other than an upload may take to arrive whole (the gateway's old requestTimeout). */
export const PUBLIC_GATEWAY_RECEIVE_MS = 10_000;
/**
 * M-3331: the connections the gateway serves at once, and the ones past them that may wait for a slot. Since #4160 a
 * page asks for its ~150 modules at once; a tunnel that opens a connection per request went past the 32, and each one
 * past them was destroyed (a reset: a module that "could not be loaded"). A connection past the 32 now waits, paused
 * (nothing of it is read), for a slot — at most PUBLIC_GATEWAY_WAIT_MS. That stays under the server's headersTimeout
 * (5 s): Node starts a connection's parser, and its headers clock, when the connection is accepted, so one held past
 * headersTimeout would be answered 408 by the timeout sweep — a failed module all the same (Fable on #4176). The
 * gateway's own timer always comes first (a reset, as before the queue); a tunnel's burst clears in milliseconds.
 * The queue's bound keeps the abuse guard: past 32 + PUBLIC_GATEWAY_QUEUE open connections a new one is destroyed as
 * before. 224 waiting covers a page's burst (~150-230 files) with room; a paused socket costs a descriptor and no work.
 */
export const PUBLIC_GATEWAY_MAX_SOCKETS = 32;
export const PUBLIC_GATEWAY_QUEUE = 224;
export const PUBLIC_GATEWAY_WAIT_MS = 4_000;

/** Reviewed panel routes. No health, agent, issue-code, preview, legacy restart or SSE. */
export function isPublicWebRoute(method: string, path: string): boolean {
  const reads = method === "GET" || method === "HEAD";
  if (method === "POST" && path === "/ui/host-alert-action") return true;
  if (method === "GET" && (path === "/ui/host-health" || path === "/ui/host-history")) return true; // cached only; handler requires a current admin session
  if (reads && isWebIconPath(path)) return true;
  if (method === "GET" && path === "/ui/reply-preview") return true; // handler requires an admin session on every read
  if (reads && ["/", "/signin", "/signin/authenticator", "/ui", "/view", "/auth/session", "/auth/sessions", "/auth/device", "/api/fleet", "/api/profiles", "/api/sort-order", "/api/ai-usage"].includes(path)) return true;
  if (method === "GET" && path.startsWith("/assets/") && isServedAsset(path.slice("/assets/".length))) return true;
  // #1408: the app shell's pages, exactly as the classifier names them (a malformed one is answered 400 behind it).
  if (reads && shellRoute(method, path) !== null) return true;
  if (method === "POST" && ["/auth/login", "/auth/logout", "/auth/request-code"].includes(path)) return true;
  // #3008: a web-only fleet's connections from outside — signing in with the authenticator's code; then, for this
  // computer's admin signed in so (the handlers ask the authority each time), an agent's request in Needs you, the
  // Notices, and the outside status (read-only: enrolling, the switch and removal are refused off this computer).
  if (method === "POST" && path === "/auth/totp") return true;
  if (method === "GET" && (path === "/ui/agent-proposals" || path === "/ui/notices/list" || path === "/ui/outside")) return true;
  // Refs #3061 (P2a): approving a new device's code, for the owner signed in from outside (the handlers ask the authority
  // each time and answer 403 to anyone else). The new device's own `/auth/device-login*` is never here: its sign-in over
  // the link is the authenticator's code.
  if (method === "GET" && path === "/ui/devices") return true;
  if (method === "POST" && /^\/ui\/devices\/(?:lookup|approve|deny|signout)$/.test(path)) return true;
  if (method === "POST" && (/^\/ui\/agent-proposals\/[0-9a-f]{32}$/.test(path) || path === "/ui/notices/seen")) return true;
  // #1939 §0.2 / §0.3: "Authorize this browser" over the link — this browser's state (GET) and the ask for its Confirm
  // card (POST, a session write: CSRF and §3 in the handler). The server answers why not while the link's option is off.
  if ((method === "GET" || method === "POST") && path === "/ui/authorization") return true;
  if (method === "DELETE" && /^\/auth\/sessions(?:\/[0-9a-f]{16})?$/.test(path)) return true;
  if (reads && /^\/api\/(pane|profile|avatar)\/[^/]+$/.test(path)) return true;
  // #1665: the sidebar's order is a host preference now; the old fleet-wide /api/sort-order write, which the page no
  // longer makes, is not offered on the public link either. #4084: a guest saves its own preferences here too (#2855:
  // its stars, sort, filter, theme, language — its own bucket only); the handler refuses every other session's write
  // over the link (prefs_not_over_public_link). Before, this route list refused the guest's write before the handler saw
  // it, and the page put the host's view back: a star vanished moments after it was set.
  if (method === "POST" && path === "/ui/prefs") return true;
  if (method === "POST" && /^\/api\/(profile|avatar)\/[^/]+$/.test(path)) return true;
  if (method === "DELETE" && /^\/api\/avatar\/[^/]+$/.test(path)) return true;   // #1630 follow-up: removing it, as uploading it
  // #1629 r4.1 Q2: the identity card follows the profile and avatar (the person's card, read and edited here); the
  // agent's theme, its reset and lock stay off this list.
  if (reads && /^\/api\/card\/[^/]+(?:\/(?:portrait|banner))?$/.test(path)) return true;
  if ((method === "POST" || method === "DELETE") && /^\/api\/card\/[^/]+\/(?:portrait|banner)$/.test(path)) return true;
  if (method === "DELETE" && /^\/api\/card\/[^/]+$/.test(path)) return true;   // Clear card
  if (method === "POST" && (/^\/stop\/[^/]+$/.test(path) || /^\/api\/instance\/[^/]+\/start$/.test(path))) return true;
  if (method === "GET" && /^\/ui\/js\/[a-z0-9_-]+\.js$/.test(path)) return true;
  // #2182: the org canvas's router, libavoid's two files (the route worker itself is under /ui/js/ above).
  if (method === "GET" && LIBAVOID_PATHS.includes(path)) return true;
  // M-3278 (decision 7933bf90): an admin session's child-agent progress (the handler refuses guests and read sessions).
  if (method === "GET" && path === "/ui/subagents") return true;
  if (method === "GET" && /^\/ui\/(backends|poll|history|history\/older|history\/newer|history\/around|file\/[^/]+|prompts|instance\/[^/]+|instances|tasks(?:\/[^/]+)?|schedules(?:\/[^/]+)?|teams(?:\/[^/]+)?|config|org|offices|office-acts|office-levels|traffic|cache|usage-report|prefs|preview-status|steps)$/.test(path)) return true;
  // #2513: the Office view's skin packs, read-only as the offices are (the list, a manifest, its pictures); never uploaded
  // or deleted here (the handler refuses it too).
  if (method === "GET" && /^\/ui\/office-skins(?:\/[A-Za-z0-9_-]{1,40}(?:\/img\/[0-9a-f]{32}\.png)?)?$/.test(path)) return true;
  // #1629: agents' themes and their pictures, read-only — the public link views themes; reset and lock are not here.
  if (method === "GET" && (path === "/ui/themes" || /^\/ui\/img\/theme\/[^/]+\/[0-9a-f]{32}$/.test(path))) return true;
  // #1630: avatars and server emoji, read-only — nothing a signed-in public user cannot already see in the page.
  if (method === "GET" && /^\/ui\/(?:img\/(?:bot|avatar|emoji)\/[^/]+|emojis|mentions)$/.test(path)) return true;
  if (method === "POST" && /^\/ui\/(send|resend|office-tell|upload|prompt|reply-button|command|needs\/ack|cancel\/[^/]+|stop\/[^/]+|start\/[^/]+|instances\/[^/]+\/delete|restart\/[^/]+|instances|config)$/.test(path)) return true;
  // The task board (scheduler/task-board.ts) is read over the public link — a card too — and changed only on the local
  // page, the old /ui/tasks create and update included: the handlers refuse a write over the public link too
  // (confirming, sending back and assigning are the person's authority, never carried here).
  if (method === "GET" && /^\/ui\/tasks\/cards\/[^/]+$/.test(path)) return true;
  // a file on a card, as a download — read with the card (the handler hides a hidden instance's from the link).
  if (method === "GET" && /^\/ui\/tasks\/files\/[0-9a-f]{32}$/.test(path)) return true;
  // #2636 follow-up (the user's choice): Office share links — list, make, revoke — for an admin session over the link too
  // (the handler refuses read-only sessions and guests; the share itself runs on its own tunnel, never this one).
  if ((method === "GET" || method === "POST") && path === "/ui/office-share") return true;
  if (method === "DELETE" && /^\/ui\/office-share\/(?:[0-9a-f]{8}|all)$/.test(path)) return true;
  // #2911: page share links, the same rule (an admin session; the share runs on the Office share's own tunnel).
  if ((method === "GET" || method === "POST") && path === "/ui/page-share") return true;
  if (method === "DELETE" && /^\/ui\/page-share\/(?:[0-9a-f]{8}|all)$/.test(path)) return true;
  // #2478 (the user's request): global search, an admin's (the handler refuses a guest, and web.search.public_link: false).
  if (method === "GET" && (path === "/ui/search" || path === "/ui/search/context")) return true;
  // M-3278 (decision 7933bf90, part 3): an admin session's writes over the public link as anywhere — the task board,
  // schedules, teams, the Office editor and skin packs, agents' themes, Access's outside switch and closing the link. Each
  // handler still admits an admin session only (a read-only session and a guest are refused there).
  if ((method === "POST" || method === "PATCH" || method === "DELETE") && /^\/ui\/tasks(?:\/.*)?$/.test(path)) return true;
  if (method === "POST" && path === "/ui/schedules") return true;
  if ((method === "PATCH" || method === "DELETE") && /^\/ui\/schedules\/[^/]+$/.test(path)) return true;
  if (method === "POST" && path === "/ui/teams") return true;
  if ((method === "PATCH" || method === "PUT" || method === "DELETE") && /^\/ui\/teams\/[^/]+$/.test(path)) return true;
  if (method === "PUT" && (path === "/ui/offices" || path === "/ui/office-style" || path === "/ui/office-level-titles")) return true;
  if ((method === "POST" && path === "/ui/office-skins") || (method === "DELETE" && /^\/ui\/office-skins\/[A-Za-z0-9_-]{1,40}$/.test(path))) return true;
  if ((method === "GET" || method === "POST") && /^\/ui\/office-pack-changes(?:\/[0-9a-f]{32})?$/.test(path)) return true;
  if (method === "POST" && /^\/ui\/themes\/[^/]+\/(?:reset|lock|widget|ambient)$/.test(path)) return true;
  if (method === "POST" && /^\/ui\/outside\/(?:enroll|enroll\/confirm|remove|switch|strict)$/.test(path)) return true;
  if (method === "POST" && path === "/ui/public-link/close") return true;
  if ((method === "GET" && path === "/ui/pins") || (method === "POST" && /^\/ui\/pins\/[^/]+$/.test(path))) return true;
  // M-3278 (decision 7933bf90): routes the dashboard needs that were simply missing here (no handler refuses the link and
  // none gave a reason): the model and effort pickers, and an agent's export/import (admin only, in their handlers).
  if (method === "GET" && (path === "/ui/models" || path === "/ui/effort-options")) return true;
  if (method === "POST" && (path === "/ui/models/refresh" || path === "/ui/agent-export/build" || path === "/ui/agent-export/parse")) return true;
  // M-3680 (decision 7933bf90): contact permissions and held contact requests — Fleet › 授權, an agent's Permissions tab
  // and Needs you's Approve — were simply missing here, so the link answered 404 and the page said only "Couldn't load
  // permissions". The handler (contact-auth-api.ts) admits a verified admin only, asking the authority on every request.
  if (method === "GET" && /^\/ui\/api\/contact-authorizations(?:\/R[a-f0-9-]{36})?$/.test(path)) return true;
  if (method === "POST" && /^\/ui\/api\/contact-authorizations\/R[a-f0-9-]{36}\/decision$/.test(path)) return true;
  if ((method === "GET" || method === "PUT") && /^\/ui\/api\/instances\/[^/]+\/contact-permissions$/.test(path)) return true;
  if (method === "POST" && /^\/ui\/api\/instances\/[^/]+\/contact-permissions\/origin-clear$/.test(path)) return true;
  // M-3680 (decision 7933bf90; found by the link-parity audit): Needs you's "Try again" on held Hub work (M-3632) was
  // missing here. The handler admits an admin session only over the link.
  if (method === "POST" && path === "/ui/needs/hub-retry") return true;
  // M-3678: same verified target-manager check as the local held-question close.
  if (method === "POST" && path === "/ui/needs/hub-close") return true;
  // #1827: the person's own name (a profile edit, which the public link may make).
  if ((method === "GET" || method === "POST") && path === "/ui/profile") return true;
  if (isPublicPrivilegedRoute(method, path)) return true;
  // M-3278 (decision 7933bf90, part 5): the live stream — the gateway passes it on the fixed (named) link only, and the
  // handler opens it for an admin session only (namedLinkStream); a quick tunnel and every other session poll.
  if (method === "GET" && path === "/ui/events") return true;
  // #1724: schedules are not created, edited or deleted over the public link (the handlers refuse it too).
  // #1689: teams are not created, edited or deleted over the public link (the handlers refuse it too).
  // Settings has an explicit method/subroute manifest (not an arbitrary /api prefix).
  return isPublicSettingsRoute(method, path);
}
/**
 * M-3278 (decision 7933bf90, part 4): the privileged dashboard routes an admin session uses on the local dashboard — the
 * app icon, AgEnD's own update, owner CSS, mods, sign-ins and accounts, installing and updating a CLI, an agent's Files &
 * changes, Runtimes and the Windows CLI. Over the link each admits an admin session only and refuses guests and read
 * sessions itself (owner CSS, update and mods by web-api's linkRestricted check; the header token never works over the
 * link); the public link's admin session is answered as locally. `/ui/events` only on the fixed link (below); Runtime's Windows package and
 * installer pin answer 403 there (runtime-api).
 */
function isPublicPrivilegedRoute(method: string, path: string): boolean {
  const reads = method === "GET" || method === "HEAD";
  if (method === "POST" && path === "/ui/host-alert-action") return true;
  if (method === "GET" && (path === "/ui/host-health" || path === "/ui/host-history")) return true; // cached only; handler requires a current admin session
  if ((reads || method === "PUT" || method === "DELETE") && path === "/ui/app-icon") return true;
  if (method === "GET" && (path === "/ui/update" || path === "/ui/update/log")) return true;
  if (method === "POST" && (path === "/ui/update/check" || path === "/ui/update/start")) return true;
  if (method === "GET" && (path === "/ui/owner-css.css" || path === "/ui/owner-css/state" || /^\/ui\/owner-css\/asset\/[0-9a-f]{32}$/.test(path))) return true;
  if (method === "POST" && /^\/ui\/owner-css(?:\/(?:shown|keep|revert|restore|asset))?$/.test(path)) return true;
  if (method === "GET" && /^\/ui\/mods(?:\/(?:staged|file)\/[0-9a-f]{32})?$/.test(path)) return true;
  if (method === "POST" && /^\/ui\/mods\/(?:stage|abort|commit|uninstall|export|proposal\/stage|proposal\/dismiss)$/.test(path)) return true;
  if ((method === "GET" || method === "POST") && path === "/ui/browser-backend-signins") return true;
  if (method === "GET" && path === "/ui/backend-login") return true;
  if (method === "POST" && /^\/ui\/backend-login\/(?:check|start|cancel)$/.test(path)) return true;
  if ((method === "GET" || method === "POST") && (path === "/ui/host-install" || path === "/ui/host-install/cancel" || path === "/ui/host-update"
    || path === "/ui/host-native-switch" || path === "/ui/host-npm-remove")) return true;
  if (method === "GET" && (path === "/ui/accounts" || path === "/ui/workspace")) return true;
  if (method === "POST" && (path === "/ui/accounts/keep-alive" || /^\/ui\/accounts\/[a-z][a-z0-9-]{0,31}(?:\/signout)?$/.test(path))) return true;
  if (method === "DELETE" && /^\/ui\/accounts\/[a-z][a-z0-9-]{0,31}\/[^/]{1,200}$/.test(path)) return true;
  // Runtimes, the Windows CLI and a Windows agent (nativeCliAuthorization: an admin, the header token, or the confirmed
  // replay). The paired computers' own `/runtime/v1/*` protocol and the installer files stay off the link.
  if (["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method) && /^\/ui\/(?:runtimes|windows-cli)(?:\/[A-Za-z0-9_-]+)*$/.test(path)) return true;
  if (reads && /^\/ui\/windows-agents\/[a-f0-9-]{36}$/i.test(path)) return true;
  if ((method === "GET" || method === "POST") && /^\/ui\/instances\/[^/]+\/runtime$/.test(path)) return true;
  if ((method === "GET" || method === "PATCH") && /^\/ui\/instances\/[^/]+$/.test(path)) return true;
  if (method === "POST" && /^\/ui\/instances\/[^/]+\/(?:messages|cancel|recover|recover-pane|new-conversation)$/.test(path)) return true;
  return false;
}
function isPublicSettingsRoute(method: string, path: string): boolean {
  // M-3278 (decision 7933bf90, part 4): secrets and the fixed link's token, the Hub's settings and membership, Runtime's
  // switches and General's location, for the link's admin session (each handler refuses anyone else over the link).
  if (isPublicPrivilegedSettingsRoute(method, path)) return true;
  if (method === "GET" && /^\/api\/settings\/pending(?:\/[0-9a-f]{32})?$/.test(path)) return true;
  if (method === "DELETE" && /^\/api\/settings\/pending\/[0-9a-f]{32}$/.test(path)) return true;
  // M-3278 (decision 7933bf90, part 3): Access & security's Guests and Web authority, Look's limits, "Retry now" and the
  // fixed address's test — an admin session's over the link as anywhere (the handlers admit an admin only).
  if (method === "GET" && /^\/api\/settings\/(?:guests|guests\/people|web-authority|fleet\/appearance|chat-archive)$/.test(path)) return true;   // M-3281: chat-archive
  if (method === "POST" && /^\/api\/settings\/(?:guests\/send-code|guests\/revoke|web-authority\/revoke|public-link\/test|connections\/[^/]+\/retry)$/.test(path)) return true;
  if (method === "PUT" && path === "/api/settings/fleet/appearance") return true;
  // M-3278 (decision 7933bf90): "Apply now" and the authenticator's confirmation of one's own pending change. The fleet
  // decides who may (settingsSelfConfirmation / settingsCodeSession, by web authority); before, this list refused them
  // before the handler — which says "over a link too" (AGEND-122).
  if (method === "POST" && /^\/api\/settings\/pending\/[0-9a-f]{32}\/(confirm|confirm-totp)$/.test(path)) return true;
  if (method === "GET") return /^\/api\/settings\/(schema|restart-pending|fleet|fleet\/raw|classic|status-emojis|status-emojis\/guild-emojis|connections|connector|provider-secrets|secrets|apply\/[^/]+|quickstart\/environment)$/.test(path)
    || /^\/api\/settings\/(provider-secrets|secrets)\/[^/]+\/apply\/[^/]+$/.test(path)
    || /^\/api\/settings\/connections\/[^/]+\/(secret|binding)\/apply\/[^/]+$/.test(path);
  if (method === "POST") return /^\/api\/settings\/(status-emojis\/preview|apply|restart-fleet|reload|fleet\/instances|quickstart\/(probe|plan|commit))$/.test(path)
    || /^\/api\/settings\/(provider-secrets|secrets)\/[^/]+\/(verify|apply)$/.test(path)
    || /^\/api\/settings\/connections\/[^/]+\/(secret|binding)\/(verify|apply)$/.test(path)
    || /^\/api\/settings\/instances\/[^/]+\/(pause|wake)$/.test(path);
  if (method === "PUT") return /^\/api\/settings\/(fleet\/(web|defaults|channels)|classic\/defaults)$/.test(path);
  if (method === "PATCH" && /^\/api\/settings\/classic\/channels\/[^/]+$/.test(path)) return true;
  return ["POST", "PATCH", "DELETE"].includes(method) && /^\/api\/settings\/fleet\/instances\/[^/]+$/.test(path);
}

function isPublicPrivilegedSettingsRoute(method: string, path: string): boolean {
  if ((method === "GET" || method === "PUT") && /^\/api\/settings\/hub\/(?:update-consent|membership|pilot-trust|share-from-hub|retention|run|preview)$/.test(path)) return true;
  if ((method === "GET" || method === "POST") && /^\/api\/settings\/hub\/sharing-notices\/[a-f0-9]{64}(?:\/undo)?$/.test(path)) return true;
  if (method === "GET" && /^\/api\/settings\/hub\/fleet-updates\/[0-9a-f-]{36}$/.test(path)) return true;
  if (method === "POST" && /^\/api\/settings\/hub\/fleet-updates\/[0-9a-f-]{36}\/cancel$/.test(path)) return true;
  if (method === "GET" && path === "/api/settings/hub/browser-certificate") return true;
  if (method === "POST" && /^\/api\/settings\/hub\/browser-certificate\/(?:prepare|apply)$/.test(path)) return true;
  if (method === "GET" && /^\/api\/hub\/member\/(?:exposures|pairing|company-join(?:\/bridge)?)$/.test(path)) return true;
  if (method === "POST" && /^\/api\/hub\/member\/(?:contact-limit-notice|exposures|exposures\/[0-9a-f-]{36}\/withdraw|pairing\/(?:connect|confirm|disconnect|cancel)|company-join\/(?:start|resume|cancel|repair-trust|probe|reconnect|remove))$/.test(path)) return true;
  if ((method === "GET" || method === "POST") && path === "/api/settings/general-location") return true;
  if (method === "GET" && path === "/api/settings/runtimes") return true;
  if (method === "PUT" && path === "/api/settings/fleet/runtimes") return true;
  if ((method === "GET" || method === "PUT") && path === "/api/settings/fleet/host-alerts") return true;
  if (method === "PUT" && path === "/api/settings/fleet/monitoring") return true;
  if (method === "GET" && /^\/api\/settings\/public-tunnel-token(?:\/apply\/[A-Za-z0-9_-]+)?$/.test(path)) return true;
  if (method === "POST" && /^\/api\/settings\/public-tunnel-token\/(?:verify|apply)$/.test(path)) return true;
  return false;
}

export interface PublicGateway {
  readonly server: Server;
  readonly readinessMarker: string;
  listen(): Promise<URL>;
  setHost(host: string | null): void;
  close(): void;
}
export function createPublicWebGateway(opts: {
  hostname?: string;
  port?: number;
  exposureId: string;
  isCurrent(): boolean;
  isOpen(): boolean;
  dispatch(req: IncomingMessage, res: ServerResponse): void;
  onError?(): void;
  create?: typeof createServer;
  /** Tests: the connection limits (PUBLIC_GATEWAY_MAX_SOCKETS, _QUEUE, _WAIT_MS). */
  limits?: { max?: number; queue?: number; waitMs?: number };
}): PublicGateway {
  let host: string | null = null;
  const marker = `agend-public-${opts.exposureId}`;
  const sockets = new Set<Socket>();
  const MAX = opts.limits?.max ?? PUBLIC_GATEWAY_MAX_SOCKETS, QUEUE = opts.limits?.queue ?? PUBLIC_GATEWAY_QUEUE, WAIT_MS = opts.limits?.waitMs ?? PUBLIC_GATEWAY_WAIT_MS;
  /** Connections past MAX, oldest first, each with the timer that gives up on it. */
  const waiting: Array<{ socket: Socket; timer: ReturnType<typeof setTimeout> }> = [];
  const admit = (socket: Socket): void => {
    sockets.add(socket);
    socket.resume?.();                                                // reading starts now (pauseOnConnect, below)
    socket.once("close", () => {
      sockets.delete(socket);
      // A slot is free: the longest-waiting connection that is still open takes it.
      for (let next = waiting.shift(); next; next = waiting.shift()) {
        clearTimeout(next.timer);
        if (next.socket.destroyed) continue;
        admit(next.socket);
        break;
      }
    });
  };
  const reject = (res: ServerResponse, status: number): void => { res.writeHead(status); res.end(JSON.stringify({ error: "public web request refused" })); };
  const server = (opts.create ?? createServer)((req, res) => {
    // M-3331: while connections wait for a slot, a served one closes after its response, so the next one gets it now
    // rather than after the keep-alive timeout. Under the cap nothing waits: connections stay kept alive.
    if (waiting.length) res.shouldKeepAlive = false;
    applyWebSecurityHeaders(res);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Vary", "Cookie");
    // M-3314: /assets/v-<V>/… and /ui/js/v-<V>/… are checked (and served) as their plain paths.
    takeAssetVersion(req);
    const raw = req.url ?? "/";
    try {
      if (!opts.isCurrent() || !host || req.headers.host !== host) return reject(res, 403);
      if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(raw)) return reject(res, 400);
      const url = new URL(raw, `https://${host}`);
      // Decode once now; reject malformed encodings before any shared route can throw.
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes("\\") || decoded.includes("\0") || /%2f|%5c/i.test(url.pathname)) return reject(res, 400);
      if (!isPublicWebRoute(req.method ?? "GET", url.pathname)) return reject(res, 404);
      if (!opts.isOpen()) {
        if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/signin") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<html><body>${marker}</body></html>`); return;
        }
        return reject(res, 503);
      }
      // #2453: named only on the exact configured hostname (setHost also takes a trycloudflare name: never named).
      const named = !!opts.hostname && publicTunnelHostname(opts.hostname) === host;
      // M-3278 (part 5): the live stream only on the fixed link (a quick tunnel buffers it); the handler admits an admin only.
      if (url.pathname === "/ui/events" && !named) return reject(res, 404);
      bindGatewayRequest(req, { surface: "gateway", named, exposureId: opts.exposureId, expectedOrigin: `https://${host}`, isCurrent: () => opts.isCurrent() && opts.isOpen() });
      opts.dispatch(req, res);
    } catch {
      if (!res.headersSent) reject(res, 400); else res.destroy();
    }
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 5_000;
  // M-3331: a waiting connection's headers clock already runs (above): it never waits as long as headersTimeout allows.
  const waitMs = Math.max(0, Math.min(WAIT_MS, server.headersTimeout - 1_000));
  // #1937: an upload may take long on a slow link (its own clocks bound it); every other request is still dropped if it
  // has not arrived whole in PUBLIC_GATEWAY_RECEIVE_MS (limitRequestReceive, where the request is dispatched).
  server.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = 5_000;
  server.setTimeout(15_000, socket => socket.destroy());
  // Every connection arrives unread (net.Server's pauseOnConnect: the HTTP parser reads the socket's handle itself, so a
  // pause() after it attached would not hold it); an admitted one is resumed, a waiting one stays unread until its slot.
  (server as Server & { pauseOnConnect: boolean }).pauseOnConnect = true;
  server.on("connection", socket => {
    if (sockets.size < MAX) { admit(socket); return; }
    if (waiting.length >= QUEUE) { socket.destroy(); return; }       // the abuse guard: past the queue, refused as before
    const entry = { socket, timer: setTimeout(() => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); socket.destroy(); }, waitMs) };
    entry.timer.unref?.();
    socket.once("close", () => { clearTimeout(entry.timer); const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); });
    waiting.push(entry);
  });
  // Upgrades are never accepted, but they still leave HTTP's ordinary connection accounting.
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("clientError", (_err, socket) => socket.destroy());
  server.on("error", () => { host = null; opts.onError?.(); });
  return {
    server, readinessMarker: marker,
    listen: () => new Promise((resolve, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(opts.port ?? 0, "127.0.0.1", () => {
        server.off("error", rejectListen);
        const address = server.address();
        if (!address || typeof address === "string") { rejectListen(new Error("gateway not bound")); return; }
        resolve(new URL(`http://127.0.0.1:${address.port}`));
      });
    }),
    setHost: value => {
      // Provider-validated only, pinned again at this boundary.
      if (value !== null && !/^[a-z0-9-]+\.trycloudflare\.com$/.test(value) && (!opts.hostname || publicTunnelHostname(opts.hostname) !== value)) throw new Error("invalid tunnel host");
      host = value;
    },
    close: () => {
      host = null;
      server.close();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      for (const w of waiting.splice(0)) { clearTimeout(w.timer); w.socket.destroy(); }
    },
  };
}
