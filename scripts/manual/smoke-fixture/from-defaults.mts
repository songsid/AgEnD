/**
 * Fleet decision a78ebdc5 (2026-10-18): a "from defaults" smoke for every user-visible feature — a fresh browser profile
 * with NOTHING seeded (no localStorage, no prefs, no consents, no overlay skips), driven only through visible UI, under
 * real conditions: prefers-reduced-motion, a phone viewport, a non-localhost origin, and the temporary public link.
 *
 * - freshPage(): a new context, nothing seeded, signed in through the visible /signin page with a one-time code (the
 *   code itself is what a person receives in Discord or Telegram; issuing it is the only step taken outside the page).
 *   `origin: "lan"` reaches the dashboard through a small reverse proxy that presents it as dashboard.lan.example — a
 *   Host (and Origin) that is not a loopback name, admitted by web.allowed_hosts, what a LAN or tailnet browser or a
 *   reverse proxy sends. The proxy streams (the live event stream works) and adds no forwarding header.
 * - openPublicLink(): a REAL public link through FleetManager — the real PublicWebLink, the real gateway
 *   (createPublicWebGateway) and its real routes — with only the Cloudflare tunnel stubbed. publicPage() then opens
 *   https://<demo>.trycloudflare.com/signin in a fresh context whose requests to that host are carried to the gateway's
 *   local port with that Host (so the gateway's Host pin, the https origin check and the __Host- cookie all hold).
 */
import { createServer, request as httpRequest } from "node:http";
import type { MatrixCase } from "./index.mts";

const VIEWPORTS = { desk: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } } as const;

export interface FreshOptions {
  /** "loopback" (default): http://127.0.0.1:<port>. "lan": through a proxy that presents a non-loopback Host. */
  origin?: "loopback" | "lan";
  reducedMotion?: boolean;
  /** Where to land after signing in (visible navigation is the smoke's own business). Default: /ui. */
  path?: string;
}

async function freshContext(browser: any, c: MatrixCase, reducedMotion: boolean) {
  return browser.newContext({ viewport: VIEWPORTS[c.device], deviceScaleFactor: 1, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US",
    isMobile: c.device === "phone", hasTouch: c.device === "phone", reducedMotion: reducedMotion ? "reduce" : "no-preference" });
}

/** Sign in on the page that is open at /signin with `code`, as a person would: type it, press the button. */
async function signIn(page: any, code: string, home: string) {
  await page.waitForSelector("#code", { timeout: 10000 });
  await page.fill("#code", code);
  await page.click("#go");
  await page.waitForURL(home, { timeout: 15000 });
}

/** A streaming reverse proxy on 127.0.0.1:<random> to the dashboard, presenting `host` as Host and Origin. */
function lanProxy(target: number, host: string): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const headers = { ...req.headers, host, ...(req.headers.origin ? { origin: `http://${host}` } : {}) };
      const up = httpRequest({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res);
      });
      up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(up);
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address() as { port: number };
      resolve({ port: a.port, close: () => { server.closeAllConnections?.(); server.close(); } });
    });
  });
}

export async function freshPage(fx: { fm: any; browser: any; base: string }, c: MatrixCase, opts: FreshOptions = {}) {
  const REPO = process.env.REPO!;
  const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
  const fm = fx.fm;
  const port = new URL(fx.base).port;
  const LAN = "dashboard.lan.example";
  let base = `http://127.0.0.1:${port}`, proxy: { close(): void } | null = null;
  if (opts.origin === "lan") {
    // A name the dashboard answers to, as an operator adds one to web.allowed_hosts for a LAN or tailnet browser.
    const hosts: string[] = fm.fleetConfig.web.allowed_hosts ?? [];
    if (!hosts.includes(LAN)) fm.fleetConfig.web.allowed_hosts = [...hosts, LAN];
    const p = await lanProxy(Number(port), `${LAN}:${port}`);
    base = `http://127.0.0.1:${p.port}`; proxy = p;
  }
  const ctx = await freshContext(fx.browser, c, opts.reducedMotion === true);
  if (proxy) ctx.on("close", () => proxy!.close());
  const page = await ctx.newPage();
  fm.initializeWebSessions();
  const code = fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken) }).display;
  await page.goto(`${base}/signin`);
  await signIn(page, code, `${base}/ui`);
  if (opts.path) await page.goto(base + opts.path);
  return { ctx, page, base };
}

export interface PublicLink {
  host: string;
  url: string;
  exposureId: string;
  /** The sign-in notices that would have been posted in the owner's General (the Discord side, stubbed). */
  notices: Array<{ label: string; handle: string }>;
  /** A fresh context on the public link, nothing seeded, signed in through its own /signin. */
  publicPage(c: MatrixCase, opts?: { reducedMotion?: boolean; path?: string }): Promise<{ ctx: any; page: any; base: string }>;
  close(): Promise<void>;
}

/** A real public link (FleetManager, PublicWebLink, gateway), only the tunnel stubbed; the owner is a demo account. */
export async function openPublicLink(fx: { fm: any; browser: any }, opts: { host?: string } = {}): Promise<PublicLink> {
  const REPO = process.env.REPO!;
  const { PublicWebLink } = await import(REPO + "/src/public-web-link.ts");
  const { TunnelPurposeLane } = await import(REPO + "/src/tunnel/purpose-lane.ts");
  const { createPublicWebGateway } = await import(REPO + "/src/public-web-gateway.ts");
  const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
  const fm = fx.fm;
  const HOST = opts.host ?? "demo-smoke-link.trycloudflare.com";
  let gatewayPort = 0;
  // The tunnel, stubbed: it "publishes" the gateway at https://HOST. Everything else is the product's.
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
    dataDir: fm.dataDir, web: () => fm.fleetConfig?.web, permitted: () => true, reserve: (id: string) => lane.reserve("dashboard", id),
    createGateway: (exposureId: string, current: () => boolean, open: () => boolean, failed: () => void) => createPublicWebGateway({
      exposureId, isCurrent: current, isOpen: open, onError: failed, dispatch: (req: any, res: any) => fm.dispatchWebHttp(req, res, fm.fleetConfig?.health_port ?? 19280) }),
    ensure: async () => ({ path: "/stub/cloudflared", source: "agend" }), provider: () => ({}) as never,
    revoke: (id: string) => { fm.webLoginCodes?.revokeAudience(id); fm.webSessions?.revokeExposure(id); },
    log: () => {},
  });
  // A demo owner: the account the link and its code would be DMed to.
  const owner = { adapterId: "demo", chatId: "demo-chat", threadId: undefined, userId: "101101101101101101", binding: {} };
  let link: { url: string; exposureId: string } | null = null;
  const ok = await fm.publicWebLink.deliver(owner, async (l: any) => { link = { url: l.url, exposureId: l.exposureId }; return true; });
  if (!ok || !link) throw new Error("public link did not open");
  const { url, exposureId } = link as { url: string; exposureId: string };
  // A public sign-in is confirmed by a notice in the opener's General (the Discord side): recorded here, not posted.
  const notices: Array<{ label: string; handle: string }> = [];
  fm.confirmPublicWebLogin = async (info: { label: string; handle: string }) => { notices.push({ label: info.label, handle: info.handle }); };
  return {
    host: HOST, url, exposureId, notices,
    async publicPage(c, popts = {}) {
      const ctx = await freshContext(fx.browser, c, popts.reducedMotion === true);
      // https://HOST/* → the gateway's local port, with that Host (the gateway pins it), as the tunnel would carry it.
      await ctx.route(`https://${HOST}/**`, async (route: any) => {
        const req = route.request(), u = new URL(req.url());
        // The public link has no live stream (the page polls); a stream asked for anyway is refused, never left hanging.
        if (/text\/event-stream/.test(req.headers().accept ?? "")) { await route.abort(); return; }
        const response = await route.fetch({ url: `http://127.0.0.1:${gatewayPort}${u.pathname}${u.search}`, headers: { ...req.headers(), host: HOST } });
        await route.fulfill({ response });
      });
      const page = await ctx.newPage();
      const code = fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken), audience: exposureId, owner }).display;
      await page.goto(`https://${HOST}/signin`);
      await signIn(page, code, `https://${HOST}/ui`);
      if (popts.path) await page.goto(`https://${HOST}${popts.path}`);
      return { ctx, page, base: `https://${HOST}` };
    },
    close: async () => { await fm.publicWebLink.close("smoke done"); },
  };
}
