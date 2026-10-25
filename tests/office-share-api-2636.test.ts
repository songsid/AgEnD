/**
 * #2636 part 3: Office share links on the dashboard and in General — GET / POST /ui/office-share and DELETE
 * /ui/office-share/<id|all> (an admin session, on the dashboard reached directly or — the user's choice, #2636
 * follow-up — over the public link; never a read-only session or a guest; refusals say why, a 429 included) and the
 * notice in General. No chat command (the user, #2636 follow-up): no chat surface knows it. A real FleetManager with a fake share tunnel: no process, no network.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`office share: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { OfficeShareService } = await import("../src/office-share-service.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { handleWebRequest } = await import("../src/web-api.js");

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Res { status: number; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}

/** A share service on a fake tunnel: up at once (or refused with `fail`). */
function fakeService(fm: any, opts: { fail?: string; enabled?: () => boolean } = {}) {
  let n = 0;
  return new OfficeShareService({
    source: { status: () => ({ instances: [] }), org: () => ({}), offices: () => fm.officeStore.list(), acts: () => [], traffic: () => ({ now: "", items: [] }), needs: () => [], hidden: () => false },
    manager: {
      start: async (_p: unknown, ctx: { onCandidateHost?(h: string): void }) => {
        if (opts.fail) return { ok: false, errorKind: opts.fail, message: "429", leaseHeld: false } as never;
        const host = `s${++n}.trycloudflare.com`; ctx.onCandidateHost?.(host);
        return { ok: true, handle: { pageUrl: `https://${host}/ready`, onUnexpectedExit: () => () => {} } } as never;
      },
      stop: async () => ({ confirmed: true }) as never,
    },
    ensure: async () => ({ path: "/bin/cloudflared" }), provider: () => ({}) as never,
    config: () => ({ enabled: opts.enabled ? opts.enabled() : true }),
    officeExists: id => fm.officeStore.list().offices.some((o: { id: string }) => o.id === id),
    ownerCurrent: () => true,
  });
}

async function fleet(opts: { fail?: string; enabled?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-office-share-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  const notices: string[] = [];
  vi.spyOn(fm, "notifyFleetError").mockImplementation(((text: string) => { notices.push(text); return true; }) as never);
  fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
  fm.officeStore.replace([{ id: "hq", name: "HQ" }]);
  fm.officeSharesInstance = fakeService(fm, opts);
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (tier: "admin" | "read" = "admin") => {
    const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
    const cookie = `agend_session=${sessionId}`;
    return { id: sessionId, read: { cookie }, write: { cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" } };
  };
  const stop = async () => { await fm.officeSharesInstance.close(); await new Promise<void>(r => (fm.healthServer as Server).close(() => r())); };
  return { fm, port, session, stop, notices };
}

describe("/ui/office-share (#2636)", () => {
  it("an admin session lists, makes (its URL once up; said in General, never the URL) and revokes; anonymous 401, a read session 403", async () => {
    const f = await fleet();
    try {
      expect((await raw(f.port, "GET", "/ui/office-share")).status).toBe(401);
      expect((await raw(f.port, "GET", "/ui/office-share", f.session("read").read)).status).toBe(403);
      const admin = f.session("admin");
      expect(JSON.parse((await raw(f.port, "GET", "/ui/office-share", admin.read)).body)).toEqual({ enabled: true, shares: [] });
      const made = await raw(f.port, "POST", "/ui/office-share", admin.write, JSON.stringify({ office: "hq", minutes: 120, text: true }));
      expect(made.status).toBe(200);
      const d = JSON.parse(made.body);
      expect(d.url).toMatch(/^https:\/\/s1\.trycloudflare\.com\/o\/[A-Za-z0-9_-]{43}$/);
      expect(d.share).toMatchObject({ office: "hq", text: true });
      expect(f.notices).toHaveLength(1);
      expect(f.notices[0]).toContain("HQ");
      expect(f.notices[0]).toContain("2 h");
      expect(f.notices[0]).not.toContain("trycloudflare");
      const list = JSON.parse((await raw(f.port, "GET", "/ui/office-share", admin.read)).body);
      expect(list.shares.map((s: { id: string }) => s.id)).toEqual([d.share.id]);
      expect(list.shares[0].office_name).toBe("HQ");                               // Settings' card names it
      expect(JSON.stringify(list)).not.toContain(d.url.split("/o/")[1]);           // the token is shown once, at making
      expect((await raw(f.port, "DELETE", `/ui/office-share/${d.share.id}`, admin.write)).status).toBe(200);
      expect(f.notices[1]).toContain("revoked");
      expect((await raw(f.port, "DELETE", `/ui/office-share/${d.share.id}`, admin.write)).status).toBe(404);
      expect((await raw(f.port, "DELETE", "/ui/office-share/nope", admin.write)).status).toBe(404);
    } finally { await f.stop(); }
  });

  it("refusals: a bad body 400, an unknown office 400, too long 400, turned off 404, Cloudflare's 429 a 503 that says so", async () => {
    let on = true;
    const f = await fleet({ enabled: () => on });
    try {
      const admin = f.session("admin").write;
      const post = async (body: unknown) => { const r = await raw(f.port, "POST", "/ui/office-share", admin, JSON.stringify(body)); return [r.status, JSON.parse(r.body)]; };
      expect((await post({ office: 3 }))[0]).toBe(400);
      expect((await post({ office: "hq", text: "yes" }))[0]).toBe(400);
      expect(await post({ office: "nope" })).toEqual([400, { error: "office" }]);
      expect(await post({ office: "hq", minutes: 24 * 60 + 1 })).toEqual([400, { error: "duration" }]);
      on = false;
      expect(await post({ office: "hq" })).toEqual([404, { error: "disabled" }]);
      expect(f.notices).toEqual([]);
    } finally { await f.stop(); }
    const g = await fleet({ fail: "rate-limited" });
    try {
      const r = await raw(g.port, "POST", "/ui/office-share", g.session("admin").write, JSON.stringify({ office: "all" }));
      expect([r.status, JSON.parse(r.body)]).toEqual([503, { error: "tunnel", reason: "rate-limited" }]);
      expect(g.fm.officeShares.list()).toEqual([]);
      expect(g.notices).toEqual([]);
    } finally { await g.stop(); }
  });

  it("over the public link (the user's choice): a fleet admin's session lists, makes and revokes; read-only and guest sessions never", async () => {
    for (const [m, p] of [["GET", "/ui/office-share"], ["POST", "/ui/office-share"], ["DELETE", "/ui/office-share/all"], ["DELETE", "/ui/office-share/a1b2c3d4"]] as const) expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(true);
    for (const [m, p] of [["PUT", "/ui/office-share"], ["DELETE", "/ui/office-share/x"], ["GET", "/ui/office-share/a1b2c3d4"]] as const) expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(false);
    const f = await fleet();
    try {
      const { bindGatewayRequest } = await import("../src/web-request-context.js");
      const HOST = "x.trycloudflare.com", EXPOSURE = "e".repeat(32);
      const session = (tier: "admin" | "read" | "guest") => f.fm.webSessions.create({ tier, surface: "gateway", exposureId: EXPOSURE, label: "t", tokenEpoch: tokenEpoch(f.fm.webToken),
        ...(tier === "guest" ? { owner: { adapterId: "discord", userId: "7" } } : { owner: { adapterId: "discord", userId: "1" } }) }).sessionId;
      const call = (sid: string, method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>(resolve => {
        let code = 0;
        const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { code = c; res.headersSent = true; return res; }, end(b: string) { resolve({ status: code, body: b ? JSON.parse(String(b)) : null }); } };
        const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: HOST, cookie: `__Host-agend_session=${sid}`, origin: `https://${HOST}`, "x-agend-csrf": csrfTokenFor(sid), "content-type": "application/json" }, destroy() {}, resume() {} });
        bindGatewayRequest(req as never, { surface: "gateway", named: false, exposureId: EXPOSURE, expectedOrigin: `https://${HOST}`, isCurrent: () => true });
        expect(handleWebRequest(req as never, res, new URL(`https://${HOST}${path}`), f.fm)).toBe(true);
        if (body !== undefined) setImmediate(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
      });
      const admin = session("admin");
      const made = await call(admin, "POST", "/ui/office-share", { office: "hq" });
      expect(made.status).toBe(200);
      expect(made.body.url).toMatch(/^https:\/\/s1\.trycloudflare\.com\/o\/[A-Za-z0-9_-]{43}$/);   // its own tunnel, not this link's host
      expect(made.body.share.owner).toBe("person:discord:1");
      expect(f.notices.join("\n")).not.toContain("trycloudflare");
      expect((await call(admin, "GET", "/ui/office-share")).body.shares).toHaveLength(1);
      for (const tier of ["read", "guest"] as const) {
        const sid = session(tier);
        expect((await call(sid, "GET", "/ui/office-share")).status, tier).toBe(403);
        expect((await call(sid, "POST", "/ui/office-share", { office: "hq" })).status, tier).toBe(403);
        expect((await call(sid, "DELETE", "/ui/office-share/all")).status, tier).toBe(403);
      }
      expect(f.fm.officeShares.list()).toHaveLength(1);
      expect((await call(admin, "DELETE", `/ui/office-share/${made.body.share.id}`)).status).toBe(200);
      expect(f.fm.officeShares.list()).toEqual([]);
    } finally { await f.stop(); }
  }, 30_000);
});

describe("no chat command (#2636 follow-up: the button only)", () => {
  it("no /office_share in the command table, the Discord menu, Telegram's menus or General's typed forms", async () => {
    const { COMMANDS, TELEGRAM_MENUS } = await import("../src/command-table.js");
    expect(COMMANDS.some(c => /office/i.test(c.name))).toBe(false);
    expect(Object.values(TELEGRAM_MENUS).flatMap((m: any) => m.names).some((n: string) => /office/i.test(n))).toBe(false);
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/channel/adapters/discord.ts", "src/topic-commands.ts", "src/fleet-manager.ts", "src/fleet-context.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toMatch(/office[_-]share"|OfficeShareSlash|runOfficeShareCommand|officeShareCommand/);
    }
  });
});
