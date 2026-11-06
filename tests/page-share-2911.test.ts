/**
 * #2911 item 8: page share links — one agent page, read-only, for a limited time, on the Office share's tunnel and
 * gateway (`/p/<token>`). Design: #2911 issuecomment-6561078095, approved with conditions:
 *  1. the share gateway stays apart from the /web origin — no dashboard route, cookie or session from /p/ (the viewer
 *     probe below);
 *  2. never on the named /web hostname (the gateway answers only its quick-tunnel host);
 *  3. no real tunnel here (a fake manager; no process, no network);
 *  4. the URL is never in a channel notice or the log.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`page share: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});

const PS = await import("../src/page-share.js");
const { createOfficeShareGateway } = await import("../src/office-share.js");
const { OfficeShareService } = await import("../src/office-share-service.js");
const { FleetManager } = await import("../src/fleet-manager.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { validateFleetConfig } = await import("../src/config-validator.js");

const dirs: string[] = [];
const closers: Array<() => unknown> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const c of closers.splice(0)) await c(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Res { status: number; body: string; headers: Record<string, string | string[] | undefined> }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
const source = { status: () => ({ instances: [] }), org: () => ({}), offices: () => ({ rev: 1, offices: [] }), acts: () => [], traffic: () => ({ now: "", items: [] }), needs: () => [], hidden: () => false };

describe("PageShares (#2911)", () => {
  it("a share: token shown once, hash kept; 15 min … max, 60 by default; too large, empty and the 11th refused", () => {
    let now = 0;
    const p = new PS.PageShares({ now: () => now, wall: () => 1_000, setTimer: () => null });
    const a = p.create({ html: "<p>x</p>", instance: "w", title: "T", owner: "o" });
    if (!a.ok) throw new Error(a.error);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.share).toMatchObject({ instance: "w", title: "T", owner: "o", bytes: 8, createdAt: 1_000, expiresAt: 1_000 + 3_600_000 });
    expect(JSON.stringify(p.list())).not.toContain(a.token);
    expect(p.find(a.token)?.html).toBe("<p>x</p>");
    expect(p.create({ html: "x", instance: "w", title: "", owner: "o", minutes: 14 })).toEqual({ ok: false, error: "duration" });
    expect(p.create({ html: "x", instance: "w", title: "", owner: "o", minutes: 61, maxMinutes: 60 })).toEqual({ ok: false, error: "duration" });
    expect(p.create({ html: "  ", instance: "w", title: "", owner: "o" })).toEqual({ ok: false, error: "empty" });
    expect(p.create({ html: "x".repeat(PS.PAGE_SHARE_LIMITS.maxBytes + 1), instance: "w", title: "", owner: "o" })).toEqual({ ok: false, error: "too_large" });
    for (let i = 1; i < PS.PAGE_SHARE_LIMITS.links; i++) expect(p.create({ html: "x", instance: "w", title: "", owner: "o" }).ok).toBe(true);
    expect(p.create({ html: "x", instance: "w", title: "", owner: "o" })).toEqual({ ok: false, error: "too_many" });
    now = 3_600_000;
    expect(p.find(a.token), "ended at its deadline").toBe(null);
  });

  it("#2917 review P3: a create that prunes a share past its deadline announces its end once (made or refused)", () => {
    let now = 0;
    const heard: string[][] = [];
    const p = new PS.PageShares({ now: () => now, setTimer: () => null, changed: (_l, ended) => { if (ended.length) heard.push(ended.map(s => s.id)); } });
    const a = p.create({ html: "a", instance: "w", title: "", owner: "o", minutes: 15 });
    if (!a.ok) throw new Error(a.error);
    now = 15 * 60_000;                                            // A's deadline; its (held) timer has not run
    expect(p.create({ html: "b", instance: "w", title: "", owner: "o" }).ok).toBe(true);
    expect(heard).toEqual([[a.share.id]]);
    const c = p.create({ html: "c", instance: "w", title: "", owner: "o", minutes: 15 });
    if (!c.ok) throw new Error(c.error);
    now = 2 * 15 * 60_000;
    expect(p.create({ html: "", instance: "w", title: "", owner: "o" })).toEqual({ ok: false, error: "empty" });   // refused: still said
    expect(heard).toEqual([[a.share.id], [c.share.id]]);
  });

  it("revoke and endWhere hand back the ended shares; changed hears them", () => {
    const heard: Array<[number, string[]]> = [];
    const p = new PS.PageShares({ setTimer: () => null, changed: (list, ended) => heard.push([list.length, ended.map(s => s.id)]) });
    const a = p.create({ html: "a", instance: "w", title: "", owner: "o1" }), b = p.create({ html: "b", instance: "w", title: "", owner: "o2" });
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(p.endWhere(s => s.owner === "o2").map(s => s.id)).toEqual([b.share.id]);
    expect(p.revoke("all").map(s => s.id)).toEqual([a.share.id]);
    expect(heard.slice(-2)).toEqual([[1, [b.share.id]], [0, [a.share.id]]]);
  });

  it("a title is one line, format characters removed, at most 80 characters", () => {
    expect(PS.oneLine("Re‮port​\n\tQ3")).toBe("Report Q3");
    expect([...PS.oneLine("x".repeat(200))].length).toBe(80);
  });

  it("htmlFences numbers fences as the page does (chat-render.js)", async () => {
    // @ts-expect-error — a JS module of the app, with no types
    await import("../src/ui/chat-render.js");
    const R = (globalThis as any).AgendChatRender;
    for (const text of ["a\n```html\n<b>1</b>\n```\n```js\nx\n```\n```HTML\n<i>2</i>\n```", "```html\n<b>cut", "```htm\nno\n```\n```html  title\n<p>y</p>\n```", "\r\n```html\r\n<p>\u0000z</p>\r\n```"])
      expect(PS.htmlFences(text), JSON.stringify(text)).toEqual(R.htmlFences(text));
  });
});

/** The share gateway with one page share, on a quick-tunnel host. */
async function gateway(html = "<title>T</title><h1>hi</h1>") {
  const pages = new PS.PageShares({ setTimer: () => null });
  const made = pages.create({ html, instance: "w", title: "T", owner: "o" });
  if (!made.ok) throw new Error(made.error);
  const g = createOfficeShareGateway({ shares: { find: () => null }, source, pages, statics: () => null });
  const url = await g.listen();
  const HOST = "abc-def.trycloudflare.com";
  g.setHost(HOST);
  closers.push(() => g.close());
  const get = (path: string, headers: Record<string, string> = {}, method = "GET") => raw(Number(url.port), method, path, { host: HOST, ...headers }, undefined);
  /** The frame, as a browser asks for it from its wrapper. */
  const frame = (headers: Record<string, string> = {}, method = "GET") => get(`/p/${made.token}/frame`, { "sec-fetch-dest": "iframe", ...headers }, method);
  return { g, pages, token: made.token, HOST, get, frame, port: Number(url.port) };
}

describe("/p/<token> on the share gateway (#2911)", () => {
  it("#2917 review P1: /p/<token> is our wrapper — no script, frame-src 'self' — framing /p/<token>/frame, the sandboxed snapshot", async () => {
    const t = await gateway();
    const r = await t.get(`/p/${t.token}`);
    expect(r.status).toBe(200);
    expect(r.body).toBe(PS.pageWrapper(t.token, "T"));
    expect(r.body).toContain(`<iframe src="/p/${t.token}/frame" sandbox="allow-scripts" referrerpolicy="no-referrer"`);
    expect(r.body).not.toContain("<h1>hi</h1>");                     // the page itself never at the top
    expect(r.body).not.toMatch(/<script/i);
    const wcsp = String(r.headers["content-security-policy"]);
    for (const d of ["default-src 'none'", "script-src 'none'", "frame-src 'self'", "child-src 'self'", "frame-ancestors 'none'", "form-action 'none'"]) expect(wcsp, d).toContain(d);
    expect([r.headers["x-frame-options"], r.headers["x-dns-prefetch-control"]]).toEqual(["DENY", "off"]);
    const f = await t.frame();
    expect(f.status).toBe(200);
    expect(f.body).toBe("<title>T</title><h1>hi</h1>");
    const csp = String(f.headers["content-security-policy"]);
    for (const d of ["sandbox allow-scripts", "connect-src 'none'", "frame-ancestors 'self'", "form-action 'none'", "default-src 'none'", "webrtc 'block'", "frame-src 'none'"]) expect(csp, d).toContain(d);
    expect(csp).not.toMatch(/allow-same-origin|allow-forms|allow-popups|allow-top-navigation/);
    expect(f.headers["permissions-policy"]).toBe(PS.PAGE_SHARE_PERMISSIONS);
    expect([f.headers["x-frame-options"], f.headers["referrer-policy"], f.headers["x-robots-tag"], f.headers["cache-control"], f.headers["x-content-type-options"]])
      .toEqual(["SAMEORIGIN", "no-referrer", "noindex, nofollow", "no-store", "nosniff"]);
    for (const x of [r, f]) expect(x.headers["set-cookie"]).toBeUndefined();
    expect((await t.frame({}, "HEAD")).body).toBe("");
  });

  it("the frame only as a frame: opened top level (a tab, a link) it is an empty 404", async () => {
    const t = await gateway();
    for (const dest of [undefined, "document", "empty", "script"]) {
      const r = await t.get(`/p/${t.token}/frame`, dest ? { "sec-fetch-dest": dest } : {});
      expect([r.status, r.body], String(dest)).toEqual([404, ""]);
    }
  });

  it("the wrapper's title is the share's, escaped", () => {
    const html = PS.pageWrapper("A".repeat(43), `x"><script>alert(1)</script>`);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("<title>x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>");
  });

  it("an ended or unknown token: the ended page; nothing below /p/<token>; a malformed one 404", async () => {
    const t = await gateway();
    const unknown = await t.get(`/p/${"A".repeat(43)}`);
    expect([unknown.status, unknown.body]).toEqual([404, PS.PAGE_ENDED]);
    expect((await t.get(`/p/${t.token}/x`)).status).toBe(404);
    expect((await t.frame()).status).toBe(200);
    expect((await t.get(`/p/short`)).status).toBe(404);
    t.pages.revoke("all");
    expect((await t.get(`/p/${t.token}`)).body).toBe(PS.PAGE_ENDED);
    expect([(await t.frame()).status, (await t.frame()).body]).toEqual([404, ""]);
  });

  it("condition 1 — the viewer probe: no dashboard route, cookie or session is reachable from the share's origin", async () => {
    const t = await gateway();
    const cookie = { cookie: "agend_session=s; __Host-agend_session=s; agend_csrf=c" };
    for (const path of ["/", "/ui", "/ui/", "/ui/chat/w", "/ui/status", "/ui/history?instance=w", "/ui/file/" + "a".repeat(32), "/ui/page-share", "/ui/office-share",
      "/api/status", "/api/ai-usage", "/auth/session", "/auth/login", "/web", "/login", "/view", "/frame", "/health", "/assets/app.js", `/o/${t.token}`, `/P/${t.token}`]) {
      const r = await t.get(path, cookie);
      expect([404, 400].includes(r.status), `${path} → ${r.status}`).toBe(true);
      expect(r.headers["set-cookie"], path).toBeUndefined();
      expect(r.body.includes("agend_session"), path).toBe(false);
    }
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) expect((await t.get(`/p/${t.token}`, cookie, method)).status, method).toBe(405);
    // The wrapper and the page: no cookie set; the page's origin is opaque (CSP sandbox without allow-same-origin): it can read none.
    const wrapper = await t.get(`/p/${t.token}`, cookie), page = await t.frame(cookie);
    for (const x of [wrapper, page]) expect(x.headers["set-cookie"]).toBeUndefined();
    expect(String(page.headers["content-security-policy"])).toMatch(/sandbox allow-scripts(;|$)/);
  });

  it("condition 2 — never on the named /web host: another Host is refused, and the gateway takes only a quick-tunnel host", async () => {
    const t = await gateway();
    for (const host of ["fleet.example.net", "127.0.0.1", "localhost", "evil.trycloudflare.com"]) expect((await raw(t.port, "GET", `/p/${t.token}`, { host })).status, host).toBe(403);
    expect(() => t.g.setHost("fleet.example.net")).toThrow();
    expect(() => t.g.setHost("agend.mycorp.com")).toThrow();
  });

  it("its own minute: 120 requests, then 429", async () => {
    const t = await gateway();
    for (let i = 0; i < PS.PAGE_SHARE_LIMITS.requestsPerMinute; i++) expect((await t.get(`/p/${t.token}`)).status).toBe(200);
    const r = await t.get(`/p/${t.token}`);
    expect([r.status, r.headers["retry-after"] !== undefined]).toEqual([429, true]);
  }, 30_000);
});

function rig(over: Record<string, unknown> = {}, opts: { fail?: string } = {}) {
  let exit: (() => void) | null = null, n = 0;
  const manager = {
    start: vi.fn(async (_p: unknown, ctx: { onCandidateHost?(h: string): void }) => {
      if (opts.fail) return { ok: false as const, errorKind: opts.fail, message: "429 Too Many Requests", leaseHeld: false };
      const host = `t${++n}.trycloudflare.com`;
      ctx.onCandidateHost?.(host);
      return { ok: true as const, handle: { pageUrl: `https://${host}/ready`, onUnexpectedExit: (fn: () => void) => { exit = fn; return () => { exit = null; }; } } as never };
    }),
    stop: vi.fn(async () => ({ confirmed: true }) as never),
  };
  let pagesOn = true;
  const owners = new Set(["o"]);
  const ended: string[][] = [];
  const logs: string[] = [];
  const svc = new OfficeShareService({
    source, manager, ensure: async () => ({ path: "/bin/cloudflared" }), provider: () => ({}) as never,
    config: () => ({ enabled: true }), officeExists: () => true, ownerCurrent: (o: string) => owners.has(o),
    pageConfig: () => ({ enabled: pagesOn }), pagesChanged: (_l: unknown, e: Array<{ id: string }>) => ended.push(e.map(s => s.id)),
    log: (event: string, detail?: string) => logs.push(`${event} ${detail ?? ""}`), ...over,
  } as never);
  closers.push(() => svc.close());
  return { svc, manager, exit: () => exit?.(), setPages: (v: boolean) => { pagesOn = v; }, owners, ended, logs };
}

describe("#2924 review: a page share follows web.preview_cdn as it was when the share was made", () => {
  it("made with it off: never the CDN allowlist, even when it is switched on later; made with it on: always, even when switched off", async () => {
    let cdn = false;
    const r = rig({ pageCdn: () => cdn });
    const off = await r.svc.createPage({ html: "<p>off</p>", instance: "w", title: "", owner: "o" });
    cdn = true;
    const on = await r.svc.createPage({ html: "<p>on</p>", instance: "w", title: "", owner: "o" });
    if (!off.ok || !on.ok) throw new Error("refused");
    expect([off.share.cdn, on.share.cdn]).toEqual([false, true]);
    const g = createOfficeShareGateway({ shares: { find: () => null }, source, pages: r.svc.pages, statics: () => null });
    const url = await g.listen(); g.setHost("cdn-check.trycloudflare.com"); closers.push(() => g.close());
    const frameCsp = async (u: string) => String((await raw(Number(url.port), "GET", `/p/${u.split("/p/")[1]}/frame`, { host: "cdn-check.trycloudflare.com", "sec-fetch-dest": "iframe" })).headers["content-security-policy"]);
    for (const setting of [true, false]) {
      cdn = setting;                                              // switched after both were made: neither changes
      const a = await frameCsp(off.url), b = await frameCsp(on.url);
      expect(a, `off-share, setting ${setting}`).toBe(PS.PAGE_SHARE_CSP);
      expect(a).not.toMatch(/cdnjs|jsdelivr/);
      expect(b, `on-share, setting ${setting}`).toBe(PS.PAGE_SHARE_CDN_CSP);
      for (const d of ["script-src 'unsafe-inline' https://cdnjs.cloudflare.com/ajax/libs/ https://cdn.jsdelivr.net/npm/", "connect-src 'none'", "frame-ancestors 'self'", "sandbox allow-scripts"]) expect(b, d).toContain(d);
    }
  });
});

describe("page shares on the share tunnel (#2911)", () => {
  it("one tunnel for Office and page shares; it stays while a page share is open and goes with the last", async () => {
    const r = rig();
    const office = await r.svc.create({ office: "all", owner: "o" });
    const page = await r.svc.createPage({ html: "<p>x</p>", instance: "w", title: "T", owner: "o" });
    if (!office.ok || !page.ok) throw new Error("refused");
    expect(r.manager.start).toHaveBeenCalledTimes(1);
    expect(page.url).toMatch(/^https:\/\/t1\.trycloudflare\.com\/p\/[A-Za-z0-9_-]{43}$/);
    r.svc.revoke(office.share.id);
    await new Promise(res => setTimeout(res, 5));
    expect(r.manager.stop, "a page share keeps it").not.toHaveBeenCalled();
    expect(r.svc.revokePage(page.share.id)).toHaveLength(1);
    await new Promise(res => setTimeout(res, 5));
    expect(r.manager.stop).toHaveBeenCalledTimes(1);
    expect(r.ended.at(-1), "its end is announced").toEqual([page.share.id]);
    expect(r.logs.join("\n")).not.toMatch(/\/p\/|trycloudflare\.com\/p/);
  });

  it("a tunnel that cannot start ends the share, never announced; refusals pass through", async () => {
    const r = rig({}, { fail: "rate-limited" });
    expect(await r.svc.createPage({ html: "x", instance: "w", title: "", owner: "o" })).toEqual({ ok: false, error: "tunnel", reason: "rate-limited" });
    expect(r.svc.listPages()).toEqual([]);
    expect(r.ended.flat()).toEqual([]);
    const q = rig();
    expect(await q.svc.createPage({ html: "x", instance: "w", title: "", owner: "o", minutes: 5 })).toEqual({ ok: false, error: "duration" });
    q.setPages(false);
    expect(await q.svc.createPage({ html: "x", instance: "w", title: "", owner: "o" })).toEqual({ ok: false, error: "disabled" });
  });

  it("#2917 review P2: what allowed it is asked again once the tunnel is up — turned off, the maker demoted, the caller's own fence", async () => {
    for (const change of ["off", "demoted", "fence"] as const) {
      let release!: () => void;
      const held = new Promise<void>(r => { release = r; });
      const r = rig({ ensure: async () => { await held; return { path: "/bin/cloudflared" }; } });
      let allowed = true;
      const p = r.svc.createPage({ html: "x", instance: "w", title: "", owner: "o", stillAllowed: () => allowed });
      await new Promise(res => setTimeout(res, 5));
      if (change === "off") r.setPages(false); else if (change === "demoted") r.owners.delete("o"); else allowed = false;
      release();
      const m = await p;
      expect(m, change).toEqual({ ok: false, error: change === "off" ? "disabled" : "not_allowed" });
      expect(r.svc.listPages(), change).toEqual([]);
      expect(r.ended.flat(), `${change}: never handed out, never announced`).toEqual([]);
    }
  });

  it("the sweep ends page shares when the feature is off or their maker is no longer an admin; a tunnel gone ends them all", async () => {
    const r = rig();
    r.owners.add("gone");
    const a = await r.svc.createPage({ html: "a", instance: "w", title: "", owner: "o" });
    const b = await r.svc.createPage({ html: "b", instance: "w", title: "", owner: "gone" });
    if (!a.ok || !b.ok) throw new Error("refused");
    r.owners.delete("gone");
    expect(r.svc.sweep()).toBe(1);
    expect(r.svc.listPages().map(s => s.id)).toEqual([a.share.id]);
    r.setPages(false);
    expect(r.svc.sweep()).toBe(1);
    expect(r.svc.listPages()).toEqual([]);
    r.setPages(true);
    const c = await r.svc.createPage({ html: "c", instance: "w", title: "", owner: "o" });
    if (!c.ok) throw new Error(c.error);
    r.exit();
    expect(r.svc.listPages()).toEqual([]);
  });
});

/** A real FleetManager on a fake share tunnel. */
async function fleet(opts: { pagesOn?: () => boolean; ensure?: () => Promise<{ path: string }> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-page-share-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  const logs: string[] = [];
  const log = (...a: unknown[]) => { logs.push(JSON.stringify(a)); };
  fm.logger = { info: log, warn: log, error: log, debug: log, trace: log, fatal: log, child: () => fm.logger };
  const channel: Array<[string, string]> = [];
  vi.spyOn(fm, "notifyInstanceTopic").mockImplementation(((name: string, text: string) => { channel.push([name, text]); return true; }) as never);
  vi.spyOn(fm, "notifyFleetError").mockImplementation((() => true) as never);
  fm.fleetConfig = { instances: { w: { working_directory: "/tmp" } }, defaults: {} };
  let n = 0;
  fm.officeSharesInstance = new OfficeShareService({
    source,
    manager: {
      start: async (_p: unknown, ctx: { onCandidateHost?(h: string): void }) => { const host = `s${++n}.trycloudflare.com`; ctx.onCandidateHost?.(host); return { ok: true, handle: { pageUrl: `https://${host}/ready`, onUnexpectedExit: () => () => {} } } as never; },
      stop: async () => ({ confirmed: true }) as never,
    },
    ensure: opts.ensure ?? (async () => ({ path: "/bin/cloudflared" })), provider: () => ({}) as never,
    config: () => ({ enabled: true }), officeExists: () => true, ownerCurrent: () => true,
    pageConfig: () => ({ enabled: opts.pagesOn ? opts.pagesOn() : true }),
    pagesChanged: (l: unknown, e: unknown) => fm.pageSharesChanged(l, e),
    log: (event: string, detail?: string) => fm.logger.info({ event, ...(detail ? { detail } : {}) }, "Office share link"),
  } as never);
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (tier: "admin" | "read" = "admin") => {
    const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
    const cookie = `agend_session=${sessionId}`;
    return { id: sessionId, read: { cookie }, write: { cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" } };
  };
  closers.push(async () => { await fm.officeSharesInstance.close(); await new Promise<void>(r => (fm.healthServer as Server).close(() => r())); });
  return { fm, port, session, channel, logs, dir };
}

describe("/ui/page-share (#2911)", () => {
  it("an admin makes one from an agent's ```html block (the server reads it), lists it, stops it; the channel hears start and end, never the URL", async () => {
    const f = await fleet();
    const m = f.fm.webChatHistory.record({ instance: "w", sender: "w", role: "agent", ts: new Date().toISOString(),
      text: "Two pages\n```html\n<title>First</title>\n```\n```html\n<title>Sales ‮dash</title><p>v2</p>\n```" });
    const admin = f.session("admin");
    expect((await raw(f.port, "GET", "/ui/page-share")).status).toBe(401);
    expect((await raw(f.port, "GET", "/ui/page-share", f.session("read").read)).status).toBe(403);
    expect((await raw(f.port, "POST", "/ui/page-share", f.session("read").write, JSON.stringify({ instance: "w", boot: m.boot, id: m.id, fence: 1 }))).status).toBe(403);
    const made = await raw(f.port, "POST", "/ui/page-share", admin.write, JSON.stringify({ instance: "w", boot: m.boot, id: m.id, fence: 1, minutes: 120 }));
    expect(made.status).toBe(200);
    const d = JSON.parse(made.body);
    expect(d.url).toMatch(/^https:\/\/s1\.trycloudflare\.com\/p\/[A-Za-z0-9_-]{43}$/);
    expect(d.share).toMatchObject({ instance: "w", title: "Sales dash", from: { boot: m.boot, id: m.id, fence: 1 } });
    const token = d.url.split("/p/")[1];
    expect(f.fm.officeShares.pages.find(token).html).toBe("<title>Sales ‮dash</title><p>v2</p>");   // the snapshot is the agent's bytes
    expect(f.channel).toHaveLength(1);
    expect(f.channel[0]![0]).toBe("w");
    expect(f.channel[0]![1]).toContain("Sales dash");
    expect(f.channel[0]![1]).toContain("2 h");
    expect(f.channel[0]![1]).toContain("runs the page's own scripts");
    expect(f.channel[0]![1]).not.toMatch(/safe/i);
    const list = JSON.parse((await raw(f.port, "GET", "/ui/page-share", admin.read)).body);
    expect(list.cdn, "the dialog is told whether a share made now may load CDN libraries").toBe(false);
    expect(list.shares.map((s: { id: string }) => s.id)).toEqual([d.share.id]);
    expect(JSON.stringify(list)).not.toContain(token);
    expect((await raw(f.port, "DELETE", `/ui/page-share/${d.share.id}`, admin.write)).status).toBe(200);
    expect(f.channel).toHaveLength(2);
    expect(f.channel[1]![1]).toContain("no longer shared");
    expect((await raw(f.port, "DELETE", `/ui/page-share/${d.share.id}`, admin.write)).status).toBe(404);
    // Condition 4: neither the channel nor the log ever had the URL or token.
    const said = JSON.stringify(f.channel) + "\n" + f.logs.join("\n");
    expect(said).not.toContain(token);
    expect(said).not.toContain("trycloudflare.com/p");
  });

  it("an agent's .html attachment; refusals: a person's message, a cut block, a gone message, a bad body, too large, turned off", async () => {
    let on = true;
    const f = await fleet({ pagesOn: () => on });
    const admin = f.session("admin").write;
    const post = async (body: unknown) => { const r = await raw(f.port, "POST", "/ui/page-share", admin, JSON.stringify(body)); return [r.status, JSON.parse(r.body)]; };
    const path = join(f.dir, "report.html"); writeFileSync(path, "<title>Report</title><p>r</p>");
    const served = f.fm.webFiles.registerServed({ path, instance: "w", name: "report.html", mime: "text/html", kind: "document" });
    const big = join(f.dir, "big.html"); writeFileSync(big, "x".repeat(PS.PAGE_SHARE_LIMITS.maxBytes + 1));
    const bigServed = f.fm.webFiles.registerServed({ path: big, instance: "w", name: "big.html", mime: "text/html", kind: "document" });
    const att = (s: any) => ({ id: s.id, kind: "document", name: s.name, size: s.size, mime: "text/html" });
    const m = f.fm.webChatHistory.record({ instance: "w", sender: "w", role: "agent", ts: new Date().toISOString(), text: "files\n```html\n<b>cut", attachments: [att(served), att(bigServed)] });
    const human = f.fm.webChatHistory.record({ instance: "w", sender: "web-user", role: "user", ts: new Date().toISOString(), text: "```html\n<p>mine</p>\n```" });
    const [s1, d1] = await post({ instance: "w", boot: m.boot, id: m.id, att: served.id });
    expect([s1, d1.share.title, d1.share.from]).toEqual([200, "Report", { boot: m.boot, id: m.id, att: served.id }]);
    const read = vi.spyOn(f.fm.webFiles, "read");
    expect(await post({ instance: "w", boot: m.boot, id: m.id, att: bigServed.id })).toEqual([413, { error: "too_large" }]);
    expect(read, "a file over the limit is refused by its listed size, never read into memory").not.toHaveBeenCalled();
    read.mockRestore();
    expect(await post({ instance: "w", boot: m.boot, id: m.id, fence: 0 })).toEqual([404, { error: "page_gone" }]);
    expect(await post({ instance: "w", boot: human.boot, id: human.id, fence: 0 })).toEqual([400, { error: "not_an_agent_page" }]);
    expect(await post({ instance: "w", boot: m.boot, id: 99999, fence: 0 })).toEqual([404, { error: "message_gone" }]);
    expect(await post({ instance: "x", boot: m.boot, id: m.id, fence: 0 })).toEqual([404, { error: "message_gone" }]);
    for (const bad of [{ instance: "w", boot: m.boot, id: m.id }, { instance: "w", boot: m.boot, id: m.id, fence: 0, att: served.id }, { instance: "w", boot: "zz", id: m.id, fence: 0 },
      { instance: "w", boot: m.boot, id: m.id, att: "nope" }, { instance: "w", boot: m.boot, id: m.id, fence: -1 }, { instance: "w", boot: m.boot, id: m.id, fence: 0, minutes: "5" }, { html: "<p>from the browser</p>" }])
      expect((await post(bad))[0], JSON.stringify(bad)).toBe(400);
    on = false;
    expect(await post({ instance: "w", boot: m.boot, id: m.id, att: served.id })).toEqual([404, { error: "disabled" }]);
  });

  it("#2917 review P2: the requesting session revoked while the tunnel starts → 403, no URL, no notice", async () => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const f = await fleet({ ensure: async () => { await held; return { path: "/bin/cloudflared" }; } });
    const m = f.fm.webChatHistory.record({ instance: "w", sender: "w", role: "agent", ts: new Date().toISOString(), text: "```html\n<title>P</title>\n```" });
    const admin = f.session("admin");
    const pending = raw(f.port, "POST", "/ui/page-share", admin.write, JSON.stringify({ instance: "w", boot: m.boot, id: m.id, fence: 0 }));
    await new Promise(res => setTimeout(res, 50));
    f.fm.webSessions.revokeById(admin.id);
    release();
    const r = await pending;
    expect(r.status).toBe(403);
    expect(r.body).not.toContain("trycloudflare");
    expect(f.fm.officeShares.listPages()).toEqual([]);
    expect(f.channel).toEqual([]);
  });

  it("over the public link: the same routes as Office share (an admin session; the handler refuses the rest)", () => {
    for (const [m, p] of [["GET", "/ui/page-share"], ["POST", "/ui/page-share"], ["DELETE", "/ui/page-share/all"], ["DELETE", "/ui/page-share/a1b2c3d4"]] as const) expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of [["PUT", "/ui/page-share"], ["DELETE", "/ui/page-share/x"], ["GET", "/ui/page-share/a1b2c3d4"]] as const) expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(false);
  });
});

describe("web.page_share config (#2911)", () => {
  it("enabled boolean, max_hours 1–24, unknown keys warned", () => {
    const issues = (page_share: unknown) => {
      const r = validateFleetConfig({ instances: {}, defaults: {}, web: { page_share } } as never);
      return [...r.errors, ...r.warnings].filter(i => i.path.startsWith("web.page_share")).map(i => i.path);
    };
    expect(issues({ enabled: false, max_hours: 8 })).toEqual([]);
    expect(issues({ enabled: "no" })).toEqual(["web.page_share.enabled"]);
    expect(issues({ max_hours: 0 })).toEqual(["web.page_share.max_hours"]);
    expect(issues({ max_hours: 25 })).toEqual(["web.page_share.max_hours"]);
    expect(issues({ colour: 1 })).toEqual(["web.page_share.colour"]);
    expect(issues(3)).toEqual(["web.page_share"]);
  });
});
