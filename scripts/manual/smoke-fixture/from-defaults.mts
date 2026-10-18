/**
 * Fleet decision a78ebdc5 (2026-10-18): a "from defaults" smoke for every user-visible feature — a fresh browser profile
 * with NOTHING seeded (no localStorage, no prefs, no consents, no overlay skips), driven only through visible UI, under
 * real conditions: prefers-reduced-motion, a phone viewport, a non-localhost origin, and the temporary public link.
 *
 * - freshPage(): a new context, nothing seeded, signed in through the visible /signin page as a synthetic Discord account
 *   of its own — the code is issued to that account as its DM would carry it (the only step outside the page), so the
 *   session is bound to the account. What that viewer would read must be empty: the host's prefs AND that person's
 *   (readForViewer — host-scope keys such as preview.optIn, fx.show, theme and lang apply to every account, so a new
 *   account does not make a polluted host default). Checked, never cleaned or written: a polluted or unreadable store refuses.
 *   `origin: "lan"` puts the page on http://dashboard.lan.example:<port> — a real non-loopback origin in the browser
 *   (location, secure context, storage), resolved to the fixture by the browser's host-resolver rule, and admitted by
 *   web.allowed_hosts like a LAN or tailnet name. Page errors are collected from before the first navigation.
 * - openPublicLink(): a REAL public link through FleetManager — the real PublicWebLink, the real gateway
 *   (createPublicWebGateway) and its routes. What is not real is listed in the README (the tunnel and its install, the
 *   owner check, the General notice, and the transport: Playwright carries https://<demo>.trycloudflare.com to the
 *   gateway's local port with that Host, instead of Cloudflare).
 * - mounted(): the app actually mounted — a visible navigation (the sidebar, or the phone's tab bar) with a control in it,
 *   not just the empty #app the page ships with.
 */
import type { MatrixCase } from "./index.mts";

/** The non-loopback name a LAN browser uses; the fixture's browser resolves it to 127.0.0.1. */
export const LAN_HOST = "dashboard.lan.example";
const VIEWPORTS = { desk: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } } as const;

/** A synthetic Discord account of its own for each fresh case (demo ids, never a real one). */
export interface DemoAccount { adapterId: string; userId: string; username: string }
let nextAccount = 0;
export function demoAccount(): DemoAccount {
  nextAccount++;
  return { adapterId: "demo", userId: String(900000000000000000n + BigInt(nextAccount)), username: `Demo Person ${nextAccount}` };
}

export interface FreshOptions {
  /** "loopback" (default): http://127.0.0.1:<port>. "lan": http://dashboard.lan.example:<port>. */
  origin?: "loopback" | "lan";
  reducedMotion?: boolean;
  /** Where to land after signing in (visible navigation is the smoke's own business). Default: /ui. */
  path?: string;
  /** Default: a new synthetic account. "operator": an owner-less code, as `agend web` gives (a separate case). */
  account?: DemoAccount | "operator";
  /** Before the first navigation, e.g. to inject a fault (a negative control). */
  beforeNavigate?(ctx: any, page: any): Promise<void> | void;
}

export interface FreshPage {
  ctx: any;
  page: any;
  base: string;
  /** pageerror and console errors, from before the first navigation. */
  errors: string[];
  /** The sign-in page's own /auth/session 401 before signing in (see collectErrors), kept for the record. */
  expected: string[];
  /** The account signed in as (null: the operator), and its person-prefs key. */
  account: DemoAccount | null;
  personKey: string;
}

async function freshContext(browser: any, c: MatrixCase, reducedMotion: boolean) {
  return browser.newContext({ viewport: VIEWPORTS[c.device], deviceScaleFactor: 1, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US",
    isMobile: c.device === "phone", hasTouch: c.device === "phone", reducedMotion: reducedMotion ? "reduce" : "no-preference" });
}

/**
 * Page errors from before the first navigation. One is expected and kept apart, never dropped: the sign-in page asks
 * /auth/session whether it is already signed in, and before signing in the answer is 401 — the browser logs that as a
 * failed resource. Only that request, only before the sign-in completes; everything else is an error.
 */
function collectErrors(page: any): { errors: string[]; expected: string[]; signedIn(): void } {
  const errors: string[] = [], expected: string[] = [];
  let before = true;
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m: any) => {
    if (m.type() !== "error") return;
    const url = m.location?.()?.url ?? "", line = `${m.text().slice(0, 200)} @ ${url || "?"}`;
    if (before && /status of 401/.test(m.text()) && /\/auth\/session$/.test(url)) expected.push(line); else errors.push(line);
  });
  return { errors, expected, signedIn: () => { before = false; } };
}

/**
 * What this viewer would read must be untouched before a defaults case: the host's prefs and, for a signed-in person,
 * theirs — exactly the product's projection (WebPrefsStore.readForViewer; `null`: the public link's viewer, host only).
 * Host-scope keys reach every account, so another account's consent (preview.optIn …) or a seeded fx.page() run counts.
 * Never cleaned or written here: a polluted store refuses, and so does one that cannot be read ({} proves nothing).
 */
function untouched(fm: any, viewer: string | null): void {
  const view = fm.webPrefs?.readForViewer(viewer);
  if (!view || view.unreadable) throw new Error(`from-defaults: the prefs store cannot be read: not a proven default state`);
  const keys = Object.keys(view.values ?? {});
  if (keys.length) throw new Error(`from-defaults: ${viewer ?? "the public-link viewer"} would read prefs already set (${keys.join(", ")}): not a default state`);
}

/** Sign in on the page that is open at /signin with `code`, as a person would: type it, press the button. */
async function signIn(page: any, code: string, home: string) {
  await page.waitForSelector("#code", { timeout: 10000 });
  await page.fill("#code", code);
  await page.click("#go");
  await page.waitForURL(home, { timeout: 15000 });
}

/** The app mounted: a visible navigation (sidebar or phone tab bar) holding at least one control. */
export async function mounted(page: any, timeoutMs = 10000): Promise<boolean> {
  try {
    await page.waitForFunction(`(() => [...document.querySelectorAll("#app .sidebar, #app .tabs")].some((n) => {
      const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !!n.querySelector("a, button");
    }))()`, null, { timeout: timeoutMs });
    return true;
  } catch { return false; }
}

export async function freshPage(fx: { fm: any; browser: any; base: string }, c: MatrixCase, opts: FreshOptions = {}): Promise<FreshPage> {
  const REPO = process.env.REPO!;
  const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
  const fm = fx.fm;
  const port = new URL(fx.base).port;
  if (opts.origin === "lan") {
    // A name the dashboard answers to, as an operator adds one to web.allowed_hosts for a LAN or tailnet browser.
    const hosts: string[] = fm.fleetConfig.web.allowed_hosts ?? [];
    if (!hosts.includes(LAN_HOST)) fm.fleetConfig.web.allowed_hosts = [...hosts, LAN_HOST];
  }
  const base = opts.origin === "lan" ? `http://${LAN_HOST}:${port}` : `http://127.0.0.1:${port}`;
  const account = opts.account === "operator" ? null : opts.account ?? demoAccount();
  const personKey = account ? `person:${account.adapterId}:${account.userId}` : "operator";
  untouched(fm, personKey);                                                              // the operator case too
  fm.initializeWebSessions();
  const code = fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken), ...(account ? { recipient: account } : {}) }).display;
  const ctx = await freshContext(fx.browser, c, opts.reducedMotion === true);
  const page = await ctx.newPage();
  const seen = collectErrors(page);
  await opts.beforeNavigate?.(ctx, page);
  await page.goto(`${base}/signin`);
  await signIn(page, code, `${base}/ui`);
  seen.signedIn();
  if (opts.path) await page.goto(base + opts.path);
  return { ctx, page, base, errors: seen.errors, expected: seen.expected, account, personKey };
}

export interface PublicLink {
  host: string;
  url: string;
  exposureId: string;
  /** The account the link was opened by (and its codes go to). */
  owner: DemoAccount;
  /** The sign-in notices that would have been posted in the owner's General (the Discord side, stubbed). */
  notices: Array<{ label: string; handle: string }>;
  /** A fresh context on the public link, nothing seeded, signed in through its own /signin as the link's owner. */
  publicPage(c: MatrixCase, opts?: { reducedMotion?: boolean; path?: string; beforeNavigate?(ctx: any, page: any): Promise<void> | void }): Promise<FreshPage>;
  close(): Promise<void>;
}

/** A real public link (FleetManager, PublicWebLink, gateway and routes); only what is outside the product is stubbed. */
export async function openPublicLink(fx: { fm: any; browser: any }, opts: { host?: string } = {}): Promise<PublicLink> {
  const REPO = process.env.REPO!;
  const { PublicWebLink } = await import(REPO + "/src/public-web-link.ts");
  const { TunnelPurposeLane } = await import(REPO + "/src/tunnel/purpose-lane.ts");
  const { createPublicWebGateway } = await import(REPO + "/src/public-web-gateway.ts");
  const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
  const fm = fx.fm;
  const HOST = opts.host ?? "demo-smoke-link.trycloudflare.com";
  let gatewayPort = 0;
  // The tunnel, stubbed: it "publishes" the gateway at https://HOST.
  const manager = {
    start: async (_provider: unknown, ctx: any) => {
      gatewayPort = Number(new URL(ctx.origin).port);
      ctx.onCandidateHost(HOST);
      return { ok: true as const, handle: { pageUrl: `https://${HOST}/signin`, onUnexpectedExit: () => () => {} } };
    },
    stop: async () => ({ confirmed: true as const }),
  };
  const lane = new TunnelPurposeLane(manager as never);
  fm.initializeWebSessions();
  fm.publicWebLink = new PublicWebLink({
    dataDir: fm.dataDir, web: () => fm.fleetConfig?.web,
    permitted: () => true,                                                               // stubbed: the Discord-side owner check
    reserve: (id: string) => lane.reserve("dashboard", id),
    createGateway: (exposureId: string, current: () => boolean, open: () => boolean, failed: () => void) => createPublicWebGateway({
      exposureId, isCurrent: current, isOpen: open, onError: failed, dispatch: (req: any, res: any) => fm.dispatchWebHttp(req, res, fm.fleetConfig?.health_port ?? 19280) }),
    ensure: async () => ({ path: "/stub/cloudflared", source: "agend" }),               // stubbed: no cloudflared install
    provider: () => ({}) as never,                                                       // stubbed: no cloudflared process
    revoke: (id: string) => { fm.webLoginCodes?.revokeAudience(id); fm.webSessions?.revokeExposure(id); },
    log: () => {},
  });
  const owner = demoAccount();
  const ownerRef = { adapterId: owner.adapterId, chatId: `dm-${owner.userId}`, threadId: undefined, userId: owner.userId, username: owner.username, binding: {} };
  let link: { url: string; exposureId: string } | null = null;
  const ok = await fm.publicWebLink.deliver(ownerRef, async (l: any) => { link = { url: l.url, exposureId: l.exposureId }; return true; });
  if (!ok || !link) throw new Error("public link did not open");
  const { url, exposureId } = link as { url: string; exposureId: string };
  // Stubbed, the whole method: a public sign-in's notice in the opener's General is recorded here, not posted.
  const notices: Array<{ label: string; handle: string }> = [];
  fm.confirmPublicWebLogin = async (info: { label: string; handle: string }) => { notices.push({ label: info.label, handle: info.handle }); };
  const personKey = `person:${owner.adapterId}:${owner.userId}`;
  return {
    host: HOST, url, exposureId, owner, notices,
    async publicPage(c, popts = {}) {
      untouched(fm, null);                                                                 // the public link reads the host's prefs only
      const ctx = await freshContext(fx.browser, c, popts.reducedMotion === true);
      // Stubbed transport: https://HOST/* → the gateway's local port, with that Host (the gateway pins it), as the tunnel
      // would carry it. The public link has no live stream (the page polls); one asked for anyway is refused.
      await ctx.route(`https://${HOST}/**`, async (route: any) => {
        const req = route.request(), u = new URL(req.url());
        try {
          if (/text\/event-stream/.test(req.headers().accept ?? "")) { await route.abort(); return; }
          const response = await route.fetch({ url: `http://127.0.0.1:${gatewayPort}${u.pathname}${u.search}`, headers: { ...req.headers(), host: HOST } });
          await route.fulfill({ response });
        } catch { /* the page or its context closed while a poll was in flight: nothing is waiting for it */ }
      });
      const page = await ctx.newPage();
      const seen = collectErrors(page);
      await popts.beforeNavigate?.(ctx, page);
      const code = fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken), audience: exposureId, owner: ownerRef }).display;
      await page.goto(`https://${HOST}/signin`);
      await signIn(page, code, `https://${HOST}/ui`);
      seen.signedIn();
      if (popts.path) await page.goto(`https://${HOST}${popts.path}`);
      return { ctx, page, base: `https://${HOST}`, errors: seen.errors, expected: seen.expected, account: owner, personKey };
    },
    close: async () => { await fm.publicWebLink.close("smoke done"); },
  };
}
