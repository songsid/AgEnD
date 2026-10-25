/**
 * #2636 part 3: Office share links on the dashboard and in General — GET / POST /ui/office-share and DELETE
 * /ui/office-share/<id|all> (an admin session on the dashboard reached directly only; never the public link; refusals
 * say why, a 429 included), the notice in General, and /office_share's words (make, list, revoke; a link goes only
 * privately: no DM, no link). A real FleetManager with a fake share tunnel: no process, no network.
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

  it("never over the public link: not routed there, and refused by the handler too", async () => {
    for (const [m, p] of [["GET", "/ui/office-share"], ["POST", "/ui/office-share"], ["DELETE", "/ui/office-share/all"]] as const) expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(false);
    const f = await fleet();
    try {
      const { sessionId } = f.fm.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "t", tokenEpoch: tokenEpoch(f.fm.webToken) });
      const { bindGatewayRequest } = await import("../src/web-request-context.js");
      const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/office-share", headers: { host: "x.trycloudflare.com", cookie: `__Host-agend_session=${sessionId}` }, destroy() {}, resume() {} });
      bindGatewayRequest(req as never, { surface: "gateway", named: false, exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
      let status = 0, body = "";
      const res = { headersSent: false, setHeader() {}, writeHead(s: number) { status = s; return res; }, end(b?: string) { body = b ?? ""; } };
      expect(handleWebRequest(req as never, res as never, new URL("https://x.trycloudflare.com/ui/office-share"), f.fm)).toBe(true);
      expect([status, JSON.parse(body).error]).toEqual([403, "office_share_not_over_public_link"]);
    } finally { await f.stop(); }
  });
});

describe("/office_share (#2636)", () => {
  const actor = { adapterId: "discord", userId: "42" };
  it("makes a link (office by id or name, a time, text), lists, revokes; an unknown office says how to use it", async () => {
    const f = await fleet();
    try {
      const cmd = (args: string) => f.fm.officeShareCommand(args, actor);
      const a = await cmd("HQ 2h text");
      expect(a.made.share.id).toMatch(/^[0-9a-f]{8}$/);
      expect(f.notices).toEqual([]);                                             // the caller tells General, once delivered
      expect(a.text).toMatch(/https:\/\/s1\.trycloudflare\.com\/o\/[A-Za-z0-9_-]{43}/);
      expect(f.fm.officeShares.list()[0]).toMatchObject({ office: "hq", text: true, owner: "person:discord:42" });
      expect(f.fm.officeShares.list()[0].expiresAt - f.fm.officeShares.list()[0].createdAt).toBe(120 * 60_000);
      const b = await cmd("");
      expect(f.fm.officeShares.list().map((s: { office: string }) => s.office).sort()).toEqual(["all", "hq"]);
      expect((await cmd("list")).text).toContain(a.made.share.id);
      expect((await cmd("nowhere")).text).toContain("/office_share");
      expect((await cmd(`revoke ${b.made.share.id}`)).text).toContain("1");
      expect((await cmd("revoke all")).text).toContain("1");
      expect(f.fm.officeShares.list()).toEqual([]);
      expect((await cmd("revoke x")).text).toContain("/office_share");
      expect(f.notices.filter(n => n.includes("trycloudflare"))).toEqual([]);   // General never sees a URL
    } finally { await f.stop(); }
  });

  it("Telegram: the link only by DM — when the DM fails, no link is left open", async () => {
    const f = await fleet();
    try {
      const said: string[] = [];
      const adapter = { sendText: async (_c: string, text: string) => { said.push(text); return { messageId: "1" }; }, sendDirect: async () => { throw new Error("blocked"); } };
      f.fm.adapters = new Map([["tg", adapter]]);
      vi.spyOn(f.fm, "fleetAdminGate").mockReturnValue("ok");
      await f.fm.runOfficeShareCommand({ source: "telegram", adapterId: "tg", userId: "42", chatId: "-100", threadId: "1" }, "all");
      expect(f.fm.officeShares.list()).toEqual([]);
      expect(said.join("\n")).not.toContain("trycloudflare");
      expect(said.at(-1)).toContain("private");
      expect(f.notices).toEqual([]);                                             // no link, so General hears of none
      adapter.sendDirect = async () => ({ messageId: "2" }) as never;
      await f.fm.runOfficeShareCommand({ source: "telegram", adapterId: "tg", userId: "42", chatId: "-100", threadId: "1" }, "all");
      expect(f.fm.officeShares.list()).toHaveLength(1);
      expect(said.join("\n")).not.toContain("trycloudflare");
      expect(f.notices).toHaveLength(1);                                         // delivered: now General hears it
    } finally { await f.stop(); }
  });
});
