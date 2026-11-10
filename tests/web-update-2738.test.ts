/**
 * M-2738 (#3332): Update from the web. The routes on a real FleetManager's listener, the offer rules (the notice's), the
 * start through chat /update's own launch (the installed agend, verified, launched independently — spawn stubbed, its
 * argv kept), the progress marker's web target, and the new fleet leaving that target's chat machinery alone.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as Array<{ cmd: string; args: string[]; env?: Record<string, string | undefined>; child: any }>);
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, spawn: ((cmd: string, args: string[], o?: { env?: Record<string, string | undefined> }) => {
    const child = Object.assign(new EventEmitter(), { unref: () => {}, pid: 0 }); spawned.push({ cmd, args, env: o?.env, child }); return child;
  }) as never };
});
const AGEND = "/home/u/.npm-global/bin/agend";
const installed = vi.hoisted(() => ({ ok: true as boolean, gate: null as Promise<void> | null }));
vi.mock("../src/update-dispatch.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/update-dispatch.js")>();
  return { ...real, resolveInstalledAgend: vi.fn(async () => { if (installed.gate) await installed.gate; return installed.ok ? { ok: true, agend: AGEND, version: "2.3.5-beta.2" } : { ok: false, reason: "npm could not say where AgEnD is installed" }; }) };
});
vi.mock("../src/update-launch.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/update-launch.js")>();
  return { ...real, resolveUpdateLaunch: (agend: string, _deps: unknown, npmDir?: string) => real.resolveUpdateLaunch(agend, {
    ...real.defaultUpdateLaunchDeps, platform: "linux", uid: () => 1000, nonce: () => "b".repeat(32), version: async () => "systemd 255 (255.4-1)", cgroup: async () => "0::/\n",
  }, npmDir) };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { handleWebRequest } = await import("../src/web-api.js");
const { bindGatewayRequest } = await import("../src/web-request-context.js");
const { DELAYED_UPDATE_SCRIPT } = await import("../src/update-dispatch.js");
const { readUpdateProgress, beginUpdateProgress, setUpdateProgressStage } = await import("../src/update-marker.js");
const { failureCause, updateOffer, webProgressOf, webUpdateTarget, WEB_UPDATE_ADAPTER, SETTLED_SHOWN_MS } = await import("../src/web-update.js");

const dirs: string[] = [];
afterEach(() => { spawned.length = 0; installed.ok = true; installed.gate = null; vi.useRealTimers(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let b: any = text; try { b = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}

async function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-web-update-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
  vi.spyOn(fm, "runningAgendVersion").mockReturnValue("2.3.5-beta.2");
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (tier: "admin" | "read" | "guest" = "admin") => {
    const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken),
      owner: { adapterId: "discord", userId: tier === "guest" ? "7" : "1" } });
    const cookie = `agend_session=${sessionId}`;
    return { id: sessionId, read: { cookie }, write: (key?: string) => ({ cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }) };
  };
  const offer = async (target: string, fromChannel = true) => {
    fm.lookUpUpdateTarget = vi.fn(async () => ({ target, fromChannel }));
    await fm.checkForUpdates();
  };
  const stop = async () => { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); await new Promise<void>(r => (fm.healthServer as Server).close(() => r())); };
  return { fm, dir, port, session, offer, stop };
}
const START = JSON.stringify({ confirm: "update-agend" });

describe("M-2738: the offer follows the notice's rules", () => {
  it("the install's channel is offered with Update; an alpha's newer stable is shown without; a beta never hears of a stable", () => {
    expect(updateOffer("2.3.5-beta.2", "2.3.5-beta.3", true, true)).toEqual({ version: "2.3.5-beta.3", channel: "beta", installable: true });
    expect(updateOffer("2.3.5", "2.3.6", false, true)).toEqual({ version: "2.3.6", channel: "latest", installable: true });
    expect(updateOffer("2.4.0-alpha.9", "2.4.0-alpha.10", true, true)).toEqual({ version: "2.4.0-alpha.10", channel: "alpha", installable: true });
    expect(updateOffer("2.4.0-alpha.9", "2.5.0", false, true)).toEqual({ version: "2.5.0", channel: "latest", installable: false });
    expect(updateOffer("2.3.5-beta.2", "2.3.5", false, true)).toBeNull();
    expect(updateOffer("2.3.5-beta.2", "2.3.5-beta.2", true, false)).toBeNull();
    expect(updateOffer("2.3.5-beta.2", "", true, true)).toBeNull();
  });
  it("a failure is said at the person's level: network, permission, anything else", () => {
    expect(failureCause("npm error code ENOTFOUND request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND")).toBe("network");
    expect(failureCause("npm ERR! code ETIMEDOUT")).toBe("network");
    expect(failureCause("EACCES: permission denied, mkdir '/usr/lib/node_modules/@songsid'")).toBe("permission");
    expect(failureCause("updater exited 1")).toBe("other");
    expect(failureCause(undefined)).toBe("other");
  });
  it("the page's progress: an update's only (never a /restart full), a settled one for a day, web-started or not", () => {
    const now = 1_000_000_000_000;
    const m = (progress: any, startedAt = now - 1000) => ({ startedAt, pid: 1, progress: { target: webUpdateTarget(startedAt), ...progress } });
    expect(webProgressOf(m({ operation: "update", stage: "downloading", version: "2.3.5-beta.3" }), now))
      .toEqual({ stage: "downloading", started_at: now - 1000, version: "2.3.5-beta.3", web: true });
    expect(webProgressOf(m({ operation: "full-restart", stage: "stopping" }), now)).toBeNull();
    expect(webProgressOf(m({ stage: "failed", failedStage: "downloading", error: "getaddrinfo ENOTFOUND" }), now))
      .toMatchObject({ stage: "failed", failed_stage: "downloading", cause: "network" });
    expect(webProgressOf(m({ stage: "failed", error: "x" }, now - SETTLED_SHOWN_MS - 1), now)).toBeNull();
    expect(webProgressOf({ startedAt: now, pid: 1, progress: { stage: "preparing", target: { adapterId: "discord-main", chatId: "c", messageId: "m" } } }, now)!.web).toBe(false);
  });
});

describe("M-2738: /ui/update on the dashboard", () => {
  it("anonymous 401, a guest 403, a read session only the version, an admin the offer; never a public route", async () => {
    for (const [m, p] of [["GET", "/ui/update"], ["POST", "/ui/update/check"], ["POST", "/ui/update/start"], ["GET", "/ui/update/log"]] as const) expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(false);
    const f = await fleet();
    try {
      await f.offer("2.3.5-beta.3");
      expect((await raw(f.port, "GET", "/ui/update")).status).toBe(401);
      expect((await raw(f.port, "GET", "/ui/update", f.session("guest").read)).status).toBe(401);           // not a guest route
      expect(await raw(f.port, "GET", "/ui/update", f.session("read").read)).toEqual({ status: 200, body: { admin: false, current: "2.3.5-beta.2" } });
      const r = await raw(f.port, "GET", "/ui/update", f.session("admin").read);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ admin: true, current: "2.3.5-beta.2", offer: { version: "2.3.5-beta.3", channel: "beta", installable: true }, check_failed: false, progress: null });
      expect(typeof r.body.checked_at).toBe("number");
      // A read session can neither start nor look.
      const read = f.session("read");
      expect((await raw(f.port, "POST", "/ui/update/start", read.write("k-read-0001"), START)).status).toBe(403);
      expect((await raw(f.port, "GET", "/ui/update/log", read.read)).status).toBe(403);
      expect(spawned).toEqual([]);
    } finally { await f.stop(); }
  });

  it("Update: chat /update's own launch (the installed agend, independently), a web progress target, once per key", async () => {
    const f = await fleet();
    try {
      await f.offer("2.3.5-beta.3");
      const admin = f.session("admin");
      expect((await raw(f.port, "POST", "/ui/update/start", admin.write(), START)).status).toBe(400);                         // no key
      expect((await raw(f.port, "POST", "/ui/update/start", admin.write("k-0000001"), JSON.stringify({ confirm: true }))).status).toBe(400);
      expect(spawned).toEqual([]);
      const r = await raw(f.port, "POST", "/ui/update/start", admin.write("k-0000001"), START);
      expect(r).toEqual({ status: 202, body: { started: true } });
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      expect(spawned[0]).toMatchObject({ cmd: "sh", args: ["-c", DELAYED_UPDATE_SCRIPT, "sh", AGEND] });
      expect(spawned[0]!.env?.AGEND_RESTART_ORIGIN).toBe("web update by person:discord:1");
      const marker = readUpdateProgress(f.dir)!;
      expect(marker.progress).toMatchObject({ operation: "update", stage: "preparing", version: "2.3.5-beta.3", target: { adapterId: WEB_UPDATE_ADAPTER } });
      // The same request again (a lost answer): the same answer, nothing launched twice. Another one: refused while running.
      expect((await raw(f.port, "POST", "/ui/update/start", admin.write("k-0000001"), START)).status).toBe(202);
      expect(await raw(f.port, "POST", "/ui/update/start", admin.write("k-0000002"), START)).toEqual({ status: 409, body: { error: "update_running" } });
      expect(spawned).toHaveLength(1);
      // Every admin tab sees it.
      expect((await raw(f.port, "GET", "/ui/update", f.session("admin").read)).body.progress).toMatchObject({ stage: "preparing", version: "2.3.5-beta.3", web: true });
    } finally { await f.stop(); }
  });

  it("nothing to install (current, an alpha's stable, no check yet) is refused and launches nothing", async () => {
    const f = await fleet();
    try {
      const admin = f.session("admin");
      expect(await raw(f.port, "POST", "/ui/update/start", admin.write("k-none-001"), START)).toEqual({ status: 409, body: { error: "nothing_to_install" } });
      await f.offer("2.3.5-beta.2");
      expect((await raw(f.port, "GET", "/ui/update", admin.read)).body.offer).toBeNull();
      expect((await raw(f.port, "POST", "/ui/update/start", admin.write("k-none-002"), START)).status).toBe(409);
      f.fm.runningAgendVersion.mockReturnValue("2.4.0-alpha.9");
      await f.offer("2.5.0", false);
      expect((await raw(f.port, "GET", "/ui/update", admin.read)).body.offer).toEqual({ version: "2.5.0", channel: "latest", installable: false });
      expect((await raw(f.port, "POST", "/ui/update/start", admin.write("k-none-003"), START)).status).toBe(409);
      expect(spawned).toEqual([]);
      expect(readUpdateProgress(f.dir)).toBeNull();
    } finally { await f.stop(); }
  });

  it("an install that cannot be verified fails in the progress (said as 'other'), and the log view has the updater's words", async () => {
    const f = await fleet();
    try {
      installed.ok = false;
      await f.offer("2.3.5-beta.3");
      const admin = f.session("admin");
      expect((await raw(f.port, "POST", "/ui/update/start", admin.write("k-fail-001"), START)).status).toBe(202);
      await vi.waitFor(async () => expect((await raw(f.port, "GET", "/ui/update", admin.read)).body.progress).toMatchObject({ stage: "failed", failed_stage: "preparing", cause: "other" }));
      expect(spawned).toEqual([]);
      writeFileSync(join(f.dir, "update.log"), "--- /update ---\nnpm ERR! boom\n");
      const log = await raw(f.port, "GET", "/ui/update/log", admin.read);
      expect(log.body.text).toContain("npm ERR! boom");
      expect(log.body.error).toContain("npm could not say where AgEnD is installed");
      // The GET itself never carries the updater's words.
      expect(JSON.stringify((await raw(f.port, "GET", "/ui/update", admin.read)).body)).not.toContain("npm could not say");
    } finally { await f.stop(); }
  });

  it("Check for updates: looks now, no chat notice; once a minute", async () => {
    const f = await fleet();
    try {
      const admin = f.session("admin");
      const notify = vi.spyOn(f.fm, "notifyInstanceTopic").mockImplementation(() => undefined as never);
      f.fm.lookUpUpdateTarget = vi.fn(async () => ({ target: "2.3.5-beta.3", fromChannel: true }));
      const r = await raw(f.port, "POST", "/ui/update/check", admin.write(), "{}");
      expect(r.status).toBe(200);
      expect(r.body.offer).toMatchObject({ version: "2.3.5-beta.3", installable: true });
      expect(notify).not.toHaveBeenCalled();
      expect((await raw(f.port, "POST", "/ui/update/check", admin.write(), "{}"))).toEqual({ status: 429, body: { error: "checked_recently" } });
      f.fm.lookUpUpdateTarget = vi.fn(async () => { throw new Error("offline"); });
      f.fm.updateCheckNow.lastAt = 0;
      expect((await raw(f.port, "POST", "/ui/update/check", admin.write(), "{}")).body).toMatchObject({ check_failed: true, offer: null });
    } finally { await f.stop(); }
  });
});

describe("M-2738 Prism #3505 review: ownership, the asking session, idempotency, idle sessions", () => {
  const held = () => { let open!: () => void; installed.gate = new Promise<void>(r => { open = r; }); return () => { installed.gate = null; open(); }; };
  const settle = () => new Promise(r => setTimeout(r, 30));

  it("P2-2: a progress marker that cannot be written refuses the start, and nothing is launched", async () => {
    const f = await fleet();
    try {
      await f.offer("2.3.5-beta.3");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(f.dir, "update-in-progress.json"));                      // a write the marker cannot make
      const admin = f.session("admin");
      expect(await raw(f.port, "POST", "/ui/update/start", admin.write("k-unwr-001"), START)).toEqual({ status: 503, body: { error: "progress_not_recorded" } });
      expect(await raw(f.port, "POST", "/ui/update/start", admin.write("k-unwr-002"), START)).toEqual({ status: 503, body: { error: "progress_not_recorded" } });
      await settle();
      expect(spawned).toEqual([]);
    } finally { await f.stop(); }
  });

  it("P2-2: the marker's 15-minute expiry never admits a second update while this fleet's first is still being launched; its exit does", async () => {
    const f = await fleet();
    try {
      await f.offer("2.3.5-beta.3");
      const admin = f.session("admin");
      const open = held();
      expect((await raw(f.port, "POST", "/ui/update/start", admin.write("k-ttl-0001"), START)).status).toBe(202);
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 16 * 60_000 });  // past the marker's own expiry
      expect(await raw(f.port, "POST", "/ui/update/start", admin.write("k-ttl-0002"), START)).toEqual({ status: 409, body: { error: "update_running" } });
      vi.useRealTimers();
      open();
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      expect(await raw(f.port, "POST", "/ui/update/start", admin.write("k-ttl-0003"), START)).toEqual({ status: 409, body: { error: "update_running" } });
      // Control: the updater failed and exited — an ordinary retry is admitted and launches once more.
      setUpdateProgressStage(f.dir, "failed", { error: "updater exited 1" });
      spawned[0]!.child.emit("exit", 1, null);
      expect((await raw(f.port, "POST", "/ui/update/start", admin.write("k-ttl-0004"), START)).status).toBe(202);
      await vi.waitFor(() => expect(spawned).toHaveLength(2));
    } finally { await f.stop(); }
  });

  it("P2-3: revoking the asking session before the launch means nothing is launched (the progress says why)", async () => {
    const f = await fleet();
    try {
      await f.offer("2.3.5-beta.3");
      const admin = f.session("admin");
      const open = held();
      expect((await raw(f.port, "POST", "/ui/update/start", admin.write("k-rev-0001"), START)).status).toBe(202);
      expect(f.fm.webSessions.revokeById(admin.id).removed).toBe(true);
      open();
      await vi.waitFor(() => expect(readUpdateProgress(f.dir)!.progress.stage).toBe("failed"));
      await settle();
      expect(spawned).toEqual([]);
      // Control: a session still current launches.
      const again = f.session("admin");
      expect((await raw(f.port, "POST", "/ui/update/start", again.write("k-rev-0002"), START)).status).toBe(202);
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
    } finally { await f.stop(); }
  });

  it("P3: two concurrent starts with the same key share one answer, and the kept receipt is that answer", async () => {
    const f = await fleet();
    try {
      await f.offer("2.3.5-beta.3");
      const host = f.fm.webUpdate;
      const yes = () => true;
      const [a, b] = await Promise.all([host.startWebUpdate("k-same-001", "p", yes), host.startWebUpdate("k-same-001", "p", yes)]);
      expect([a, b]).toEqual([{ ok: true }, { ok: true }]);
      expect(await host.startWebUpdate("k-same-001", "p", yes)).toEqual({ ok: true });
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
    } finally { await f.stop(); }
  });

  it("P2-1: the update line's own read does not extend an idle session; a person's request does", async () => {
    const { isPassiveWebRead } = await import("../src/web-auth.js");
    expect([isPassiveWebRead("GET", "/ui/update"), isPassiveWebRead("POST", "/ui/update/start"), isPassiveWebRead("GET", "/ui/update/log")]).toEqual([true, false, false]);
    const f = await fleet();
    try {
      const admin = f.session("admin");
      const seen = () => f.fm.webSessions.list().find((x: any) => x.handle).lastSeen;
      const before = seen();
      await new Promise(r => setTimeout(r, 15));
      expect((await raw(f.port, "GET", "/ui/update", admin.read)).status).toBe(200);
      expect(seen()).toBe(before);
      await new Promise(r => setTimeout(r, 15));
      expect((await raw(f.port, "GET", "/ui/update/log", admin.read)).status).toBe(200);           // control: the person opened the log
      expect(seen()).toBeGreaterThan(before);
    } finally { await f.stop(); }
  });
});

describe("M-2738 Fable #3504 review: who may reach the routes, asked at the handler itself", () => {
  /** handleWebRequest with a hand-made request: `gateway` binds it to a public link; `body`, when given, arrives on a later tick. */
  function call(f: Awaited<ReturnType<typeof fleet>>, o: { method: string; path: string; headers: Record<string, string>; body?: unknown; gateway?: boolean; beforeBody?: () => void }) {
    return new Promise<{ status: number; body: any }>(resolve => {
      let code = 0;
      const res: any = { headersSent: false, destroyed: false, setHeader() {}, writeHead(c: number) { code = c; res.headersSent = true; return res; }, end(b: string) { resolve({ status: code, body: b ? JSON.parse(String(b)) : null }); } };
      const req = Object.assign(new EventEmitter(), { method: o.method, url: o.path, headers: o.headers, socket: { remoteAddress: "127.0.0.1" }, destroy() {}, resume() {} });
      if (o.gateway) bindGatewayRequest(req as never, { surface: "gateway", named: false, exposureId: "e".repeat(32), expectedOrigin: `https://x.trycloudflare.com`, isCurrent: () => true });
      expect(handleWebRequest(req as never, res, new URL(`http://127.0.0.1:${f.port}${o.path}`), f.fm)).toBe(true);
      if (o.body !== undefined) setImmediate(() => { o.beforeBody?.(); req.emit("data", Buffer.from(JSON.stringify(o.body))); req.emit("end"); });
    });
  }
  const ROUTES = [["GET", "/ui/update"], ["POST", "/ui/update/check"], ["POST", "/ui/update/start"], ["GET", "/ui/update/log"]] as const;

  it("(1) a request bound to a public link is answered 404 on every /ui/update route, even an admin's", async () => {
    const f = await fleet();
    try {
      await f.offer("2.3.5-beta.3");
      const sid = f.fm.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "t", tokenEpoch: tokenEpoch(f.fm.webToken), owner: { adapterId: "discord", userId: "1" } }).sessionId;
      for (const [method, path] of ROUTES) {
        const r = await call(f, { method, path, gateway: true, headers: { host: "x.trycloudflare.com", cookie: `__Host-agend_session=${sid}`, origin: "https://x.trycloudflare.com",
          "x-agend-csrf": csrfTokenFor(sid), "content-type": "application/json", "idempotency-key": "k-gw-00001" }, ...(method === "POST" ? { body: { confirm: "update-agend" } } : {}) });
        expect([path, r.status], path).toEqual([path, 404]);
      }
      await new Promise(r => setTimeout(r, 30));
      expect(spawned).toEqual([]);
    } finally { await f.stop(); }
  });

  it("(2) the CLI's header token and a guest session are refused at the handler: 403 update_needs_a_signed_in_person", async () => {
    const f = await fleet();
    try {
      await f.offer("2.3.5-beta.3");
      const guest = f.fm.webSessions.create({ tier: "guest", surface: "local", label: "t", tokenEpoch: tokenEpoch(f.fm.webToken), owner: { adapterId: "discord", userId: "7" } }).sessionId;
      const origin = `http://127.0.0.1:${f.port}`;
      const asToken = { host: `127.0.0.1:${f.port}`, "x-agend-token": f.fm.webToken, "content-type": "application/json", "idempotency-key": "k-tok-0001" };
      const asGuest = { host: `127.0.0.1:${f.port}`, cookie: `agend_session=${guest}`, origin, "x-agend-csrf": csrfTokenFor(guest), "content-type": "application/json", "idempotency-key": "k-gst-0001" };
      for (const headers of [asToken, asGuest]) {
        expect(await call(f, { method: "GET", path: "/ui/update", headers })).toEqual({ status: 403, body: { error: "update_needs_a_signed_in_person" } });
        expect(await call(f, { method: "POST", path: "/ui/update/start", headers, body: { confirm: "update-agend" } })).toEqual({ status: 403, body: { error: "update_needs_a_signed_in_person" } });
      }
      await new Promise(r => setTimeout(r, 30));
      expect(spawned).toEqual([]);
    } finally { await f.stop(); }
  });

  it("(3) a session no longer an admin's by the time the body has arrived cannot start", async () => {
    const f = await fleet();
    try {
      await f.offer("2.3.5-beta.3");
      const admin = f.session("admin");
      const record = [...(f.fm.webSessions as any).byHash.values()].find((r: any) => r.tier === "admin");
      const r = await call(f, { method: "POST", path: "/ui/update/start", headers: { host: `127.0.0.1:${f.port}`, ...admin.write("k-dem-0001") }, body: { confirm: "update-agend" },
        beforeBody: () => { record.tier = "read"; } });                              // demoted between admission and the body
      expect(r).toEqual({ status: 403, body: { error: "update_needs_an_admin_session" } });
      await new Promise(r => setTimeout(r, 30));
      expect([spawned, readUpdateProgress(f.dir)]).toEqual([[], null]);
    } finally { await f.stop(); }
  });

  it("(5) the claim lasts while the updater runs: a cleared or expired marker does not admit a second start until it exits", async () => {
    const f = await fleet();
    try {
      await f.offer("2.3.5-beta.3");
      const admin = f.session("admin");
      expect((await raw(f.port, "POST", "/ui/update/start", admin.write("k-run-0001"), START)).status).toBe(202);
      await vi.waitFor(() => expect(spawned).toHaveLength(1));
      const { clearUpdateMarker } = await import("../src/update-marker.js");
      clearUpdateMarker(f.dir);                                                    // the marker gone (or expired) …
      expect(await raw(f.port, "POST", "/ui/update/start", admin.write("k-run-0002"), START)).toEqual({ status: 409, body: { error: "update_running" } });
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 16 * 60_000 });
      expect(await raw(f.port, "POST", "/ui/update/start", admin.write("k-run-0003"), START)).toEqual({ status: 409, body: { error: "update_running" } });
      vi.useRealTimers();
      spawned[0]!.child.emit("exit", 1, null);                                     // … the updater ended: now a start is admitted
      expect((await raw(f.port, "POST", "/ui/update/start", admin.write("k-run-0004"), START)).status).toBe(202);
      await vi.waitFor(() => expect(spawned).toHaveLength(2));
    } finally { await f.stop(); }
  });
});

describe("M-2738: a failure recorded twice keeps where it failed (rig: the CLI's, then the launch watcher's)", () => {
  it("failed → failed again: failedStage stays downloading, and the page says nothing was changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-web-update-f-")); dirs.push(dir);
    const at = Date.now();
    beginUpdateProgress(dir, webUpdateTarget(at), at);
    setUpdateProgressStage(dir, "downloading", { version: "2.3.5-beta.93" });
    setUpdateProgressStage(dir, "failed", { error: "npm error code ECONNREFUSED" });
    setUpdateProgressStage(dir, "failed", { error: "/update could not complete (updater exited 1). Cause: npm error code ECONNREFUSED" });
    expect(readUpdateProgress(dir)!.progress).toMatchObject({ stage: "failed", failedStage: "downloading" });
    expect(webProgressOf(readUpdateProgress(dir))).toMatchObject({ stage: "failed", failed_stage: "downloading", cause: "network" });
  });
});

describe("M-2738: the version the page compares is the running one", () => {
  it("read once as the fleet loads (rig: the file on disk was missing, then the new version, while the old fleet still ran)", async () => {
    const { RUNNING_AGEND_VERSION } = await import("../src/web-update.js");
    expect(RUNNING_AGEND_VERSION).toBe(JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version);
    const dir = mkdtempSync(join(tmpdir(), "agend-web-update-v-")); dirs.push(dir);
    const fm = new FleetManager(dir) as any;
    try { expect(fm.webUpdate.updateState().current).toBe(RUNNING_AGEND_VERSION); } finally { fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); }
  });
});

describe("M-2738: the new fleet and a web-started update", () => {
  it("no retire-warning watch on a web target, and the boot clears its marker even with a cleanup owed", async () => {
    const f = await fleet();
    try {
      const at = Date.now();
      beginUpdateProgress(f.dir, webUpdateTarget(at), at);
      setUpdateProgressStage(f.dir, "starting", { version: "2.3.5-beta.3", cleanup: "pending" });
      const pending = readUpdateProgress(f.dir);
      expect(f.fm.updateCleanupAtCompletion(pending, "update")).toBeNull();
      f.fm.clearSettledUpdateMarker(f.fm.constructor && (await import("../src/update-marker.js")).updateMarkerIdentity(f.dir));
      expect(() => readFileSync(join(f.dir, "update-in-progress.json"))).toThrow();
    } finally { await f.stop(); }
  });
});
