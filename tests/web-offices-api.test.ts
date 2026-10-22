/**
 * Fleet → Org chart → Office: the offices people made, kept on the host (src/web-office-store.ts, web-offices.json).
 * - Storage: beside web-themes.json in the AgEnD home, 0600, written atomically, { version: 1, rev, offices }; read back
 *   by a new store; an unreadable file serves no offices and refuses every write (503) without overwriting it; an
 *   office a rule no longer allows is dropped on load, the rest kept.
 * - Validation: strict — unknown keys, ids, the auto office's id, names, members, seats, coordinates, edges, counts and
 *   the file's size are refused with where it broke.
 * - Routes: GET /ui/offices for a signed-in page (the public link reads it, a passive read); PUT from an admin session
 *   only — a read session 403, the CLI token 403, anonymous 401, the public link refused by its manifest and the
 *   handler; a stale rev is 409; a change is announced on the stream (`offices`).
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`offices: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { checkOffices, OfficeStore, OFFICE_LIMITS } = await import("../src/web-office-store.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { isPassiveWebRead } = await import("../src/web-auth.js");
const { handleWebRequest } = await import("../src/web-api.js");
const { bindGatewayRequest } = await import("../src/web-request-context.js");

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-offices-")); dirs.push(d); return d; };

const OPS = { id: "ops", name: "Ops room", skin: "pixel", members: ["alpha", "team:Web"],
  layout: { seats: [{ id: "s1", x: 100, y: 100, instance: "alpha" }, { id: "s2", x: 220, y: 100 }], waypoints: [{ id: "w1", x: 100, y: 160 }, { id: "w2", x: 220, y: 160 }], edges: [["w1", "w2"]] } };

describe("the office store: web-offices.json", () => {
  it("round trip: 0600, versioned, rev moves; a new store reads the same back", () => {
    const dir = scratch(), s = new OfficeStore(dir);
    expect(s.list()).toEqual({ rev: 0, offices: [], readable: true });
    const w = s.replace([OPS, { id: "lab", name: "Lab" }]);
    expect(w).toMatchObject({ ok: true, rev: 1 });
    expect(s.path).toBe(join(dir, "web-offices.json"));
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(readFileSync(s.path, "utf8"));
    expect([doc.version, doc.rev, doc.offices.map((o: any) => o.id)]).toEqual([1, 1, ["ops", "lab"]]);
    expect(new OfficeStore(dir).list()).toEqual({ rev: 1, offices: [OPS, { id: "lab", name: "Lab", skin: "pixel", members: [] }], readable: true });
    expect(s.replace([], 0)).toMatchObject({ ok: false, status: 409, error: "offices_changed" });
    expect(s.replace([], 1)).toMatchObject({ ok: true, rev: 2, offices: [] });
  });
  it("an unreadable file: no offices, every write refused, the file left as it was", () => {
    const dir = scratch(), path = join(dir, "web-offices.json");
    writeFileSync(path, "{ not json");
    const s = new OfficeStore(dir);
    expect([s.readable(), s.list()]).toEqual([false, { rev: 0, offices: [], readable: false }]);
    expect(s.replace([OPS])).toMatchObject({ ok: false, status: 503, error: "offices_unreadable" });
    expect(readFileSync(path, "utf8")).toBe("{ not json");
    writeFileSync(path, JSON.stringify({ version: 2, rev: 1, offices: [] }));
    expect(new OfficeStore(dir).readable()).toBe(false);
  });
  it("on load, an office no longer allowed is dropped and the rest kept", () => {
    const dir = scratch();
    writeFileSync(join(dir, "web-offices.json"), JSON.stringify({ version: 1, rev: 7, offices: [OPS, { id: "auto", name: "x" }, { id: "x", name: "X", layout: { seats: [] } }, OPS] }));
    expect(new OfficeStore(dir).list()).toEqual({ rev: 7, offices: [OPS], readable: true });
  });
});

describe("checkOffices: strict", () => {
  const refused = (raw: unknown) => { const r = checkOffices(raw); return r.ok ? null : [r.status, r.error, r.detail]; };
  const seat = (o: Record<string, unknown> = {}) => ({ id: "s", x: 1, y: 1, ...o });
  it("a valid list passes, defaults filled", () => {
    expect(checkOffices([OPS, { id: "lab", name: " Lab " }])).toEqual({ ok: true, offices: [OPS, { id: "lab", name: "Lab", skin: "pixel", members: [] }] });
  });
  it.each([
    ["not a list", { offices: [] }, "offices: a list"],
    ["an unknown key", [{ ...OPS, colour: "red" }], 'offices[0]: unknown key "colour"'],
    ["a bad id", [{ id: "has space", name: "x" }], "offices[0].id"],
    ["the auto office's id", [{ id: "auto", name: "x" }], "offices[0].id"],
    ["an id twice", [{ id: "a", name: "x" }, { id: "a", name: "y" }], "offices[1].id: used twice"],
    ["an empty name", [{ id: "a", name: "  " }], "offices[0].name"],
    ["a long name", [{ id: "a", name: "x".repeat(61) }], "offices[0].name"],
    ["a control character", [{ id: "a", name: "a\u0007b" }], "offices[0].name"],
    ["a bad skin", [{ id: "a", name: "x", skin: "../up" }], "offices[0].skin"],
    ["a member twice", [{ id: "a", name: "x", members: ["m", "m"] }], "offices[0].members: a name twice"],
    ["a member not a string", [{ id: "a", name: "x", members: [3] }], "offices[0].members[0]"],
    ["no seats", [{ id: "a", name: "x", layout: { seats: [] } }], "offices[0].layout.seats: at least one seat"],
    ["a seat's unknown key", [{ id: "a", name: "x", layout: { seats: [seat({ z: 1 })] } }], 'offices[0].layout.seats[0]: unknown key "z"'],
    ["a negative coordinate", [{ id: "a", name: "x", layout: { seats: [seat({ x: -1 })] } }], "offices[0].layout.seats[0].x"],
    ["a coordinate too far", [{ id: "a", name: "x", layout: { seats: [seat({ y: OFFICE_LIMITS.coord + 1 })] } }], "offices[0].layout.seats[0].y"],
    ["a coordinate not a number", [{ id: "a", name: "x", layout: { seats: [seat({ x: "1" })] } }], "offices[0].layout.seats[0].x"],
    ["a seat id twice", [{ id: "a", name: "x", layout: { seats: [seat(), seat()] } }], "offices[0].layout.seats[1].id: used twice"],
    ["an edge to nowhere", [{ id: "a", name: "x", layout: { seats: [seat()], waypoints: [{ id: "w", x: 0, y: 0 }], edges: [["w", "v"]] } }], "offices[0].layout.edges[0]"],
    ["an edge to itself", [{ id: "a", name: "x", layout: { seats: [seat()], waypoints: [{ id: "w", x: 0, y: 0 }], edges: [["w", "w"]] } }], "offices[0].layout.edges[0]"],
    ["a layout's unknown key", [{ id: "a", name: "x", layout: { seats: [seat()], rooms: [] } }], 'offices[0].layout: unknown key "rooms"'],
  ])("refuses %s", (_what, raw, where) => {
    const r = refused(raw);
    expect(r?.[0]).toBe(400);
    expect(r?.[1]).toBe("offices_invalid");
    expect(String(r?.[2])).toContain(where);
  });
  it("counts and size: too many offices, seats or waypoints; a list over the file cap is 413", () => {
    expect(refused(Array.from({ length: OFFICE_LIMITS.offices + 1 }, (_, i) => ({ id: `o${i}`, name: "x" })))?.[2]).toContain("offices: at most 20");
    expect(refused([{ id: "a", name: "x", layout: { seats: Array.from({ length: OFFICE_LIMITS.seats + 1 }, (_, i) => seat({ id: `s${i}` })) } }])?.[2]).toContain("at most 500");
    const big = Array.from({ length: 20 }, (_, k) => ({ id: `o${k}`, name: "x", layout: { seats: Array.from({ length: 200 }, (_, i) => ({ id: `seat-number-${i}`, x: 12345.678, y: 12345.678, instance: `instance-name-${i}` })) } }));
    expect(refused(big)).toEqual([413, "offices_too_large", "at most 256 KiB"]);
  });
});

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
async function fleet() {
  const dir = scratch();
  const fm = new FleetManager(dir) as any;
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (tier: "admin" | "read" = "admin") => {
    const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
    const cookie = `agend_session=${sessionId}`;
    return { id: sessionId, read: { cookie }, write: { cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" } };
  };
  const stop = () => new Promise<void>(r => (fm.healthServer as Server).close(() => r()));
  return { fm, dir, port, session, stop };
}

describe("the routes", () => {
  it("GET /ui/offices: the stored list for a signed-in page; anonymous 401; a passive read", async () => {
    const f = await fleet();
    try {
      f.fm.officeStore.replace([OPS]);
      expect((await raw(f.port, "GET", "/ui/offices")).status).toBe(401);
      const r = await raw(f.port, "GET", "/ui/offices", f.session("read").read);
      expect([r.status, JSON.parse(r.body)]).toEqual([200, { rev: 1, offices: [OPS], readable: true }]);
      expect(f.fm.officeStore.path).toBe(join(f.dir, "web-offices.json"));
      expect([isPassiveWebRead("GET", "/ui/offices"), isPassiveWebRead("PUT", "/ui/offices")]).toEqual([true, false]);
    } finally { await f.stop(); }
  }, 30_000);
  it("PUT /ui/offices: an admin session only — read session 403, CLI token 403, anonymous 401; checked; a stale rev 409; announced", async () => {
    const f = await fleet();
    try {
      const sent: Array<[string, unknown]> = [];
      vi.spyOn(f.fm, "emitSseEvent").mockImplementation((...a: unknown[]) => { sent.push([a[0] as string, a[1]]); });
      const put = (headers: Record<string, string>, body: unknown) => raw(f.port, "PUT", "/ui/offices", headers, JSON.stringify(body));
      expect((await put({ origin: `http://127.0.0.1:${f.port}`, "content-type": "application/json" }, { offices: [OPS] })).status).toBe(401);
      const read = await put(f.session("read").write, { offices: [OPS] });
      expect([read.status, JSON.parse(read.body).error]).toEqual([403, "offices_need_an_admin_session"]);
      const token = await put({ "x-agend-token": f.fm.getDashboardAccess().token, "content-type": "application/json" }, { offices: [OPS] });
      expect([token.status, JSON.parse(token.body).error]).toEqual([403, "offices_need_an_admin_session"]);
      expect(f.fm.officeStore.list().offices).toEqual([]);
      const admin = f.session("admin").write;
      const bad = await put(admin, { offices: [{ ...OPS, layout: { seats: [{ id: "s", x: -5, y: 0 }] } }], rev: 0 });
      expect([bad.status, JSON.parse(bad.body)]).toEqual([400, { error: "offices_invalid", detail: "offices[0].layout.seats[0].x: a number from 0 to 20000" }]);
      expect(JSON.parse((await put(admin, { offices: [], extra: 1 })).body)).toEqual({ error: "offices_invalid", detail: 'unknown key "extra"' });
      expect((await put(admin, { offices: [], rev: "1" })).status).toBe(400);
      const ok = await put(admin, { offices: [OPS], rev: 0 });
      expect([ok.status, JSON.parse(ok.body)]).toEqual([200, { rev: 1, offices: [OPS] }]);
      expect(sent).toEqual([["offices", { rev: 1 }]]);
      expect((await put(admin, { offices: [], rev: 0 })).status).toBe(409);
      expect(f.fm.officeStore.list().offices).toEqual([OPS]);
    } finally { await f.stop(); }
  }, 30_000);
  // Office review (#2399 carry, Fable): a save without the rev it read would overwrite another person's unseen.
  it("PUT without rev: 428, nothing written; with the rev read: saved", async () => {
    const f = await fleet();
    try {
      const put = (body: unknown) => raw(f.port, "PUT", "/ui/offices", f.session("admin").write, JSON.stringify(body));
      const missing = await put({ offices: [OPS] });
      expect([missing.status, JSON.parse(missing.body).error, f.fm.officeStore.list().offices]).toEqual([428, "offices_rev_required", []]);
      expect((await put({ offices: [OPS], rev: 0 })).status).toBe(200);
    } finally { await f.stop(); }
  }, 30_000);
  it("PUT is rate limited per person: past 20 accepted saves a minute, 429 with Retry-After; refused or invalid ones cost nothing", async () => {
    const { OfficeWriteLimiter } = await import("../src/web-office-store.js");
    let t = 0;
    const lim = new OfficeWriteLimiter(() => t, { perWindow: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) { expect(lim.check("a")).toEqual({ ok: true }); lim.record("a"); t += 1000; }
    expect(lim.check("a")).toEqual({ ok: false, retry_after_s: 57 });
    expect(lim.check("b")).toEqual({ ok: true });                       // per person
    t = 60_001;                                                          // the first save left the window
    expect(lim.check("a")).toEqual({ ok: true });
    const f = await fleet();
    try {
      (f.fm as any).officeWrites = new OfficeWriteLimiter(() => 0, { perWindow: 2, windowMs: 60_000 });
      const admin = f.session("admin").write;
      const put = (body: unknown) => raw(f.port, "PUT", "/ui/offices", admin, JSON.stringify(body));
      expect((await put({ offices: [{ ...OPS, name: "" }], rev: 0 })).status).toBe(400);   // invalid: not counted
      expect((await put({ offices: [OPS], rev: 0 })).status).toBe(200);
      expect((await put({ offices: [], rev: 0 })).status).toBe(409);                      // stale: not counted
      expect((await put({ offices: [], rev: 1 })).status).toBe(200);
      const third = await new Promise<{ status: number; retry: string | undefined; body: string }>((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port: f.port, method: "PUT", path: "/ui/offices", headers: admin }, (res) => {
          let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, retry: res.headers["retry-after"] as string | undefined, body: b }));
        });
        r.on("error", reject); r.end(JSON.stringify({ offices: [OPS], rev: 2 }));
      });
      expect([third.status, third.retry, JSON.parse(third.body).error, f.fm.officeStore.list().rev]).toEqual([429, "60", "offices_rate_limited", 2]);
    } finally { await f.stop(); }
  }, 30_000);
  it("a guest never reads the offices: no guest route to /ui/offices or /ui/org, and the stream drops `offices` for a guest", async () => {
    const { guestRouteDecision, guestFrameData } = await import("../src/web-guest-access.js");
    const scope = new Set(["alpha"]);                                   // even a guest granted the office's member
    for (const path of ["/ui/offices", "/ui/org"]) for (const method of ["GET", "PUT"]) {
      expect(guestRouteDecision(method, new URL(`http://h${path}`), scope), `${method} ${path}`).toEqual({ kind: "deny", status: 403, error: "guest_forbidden" });
    }
    expect(guestFrameData("offices", { rev: 3 }, new Set(["alpha"]), { owner: { adapterId: "a", userId: "u" } } as never)).toBeUndefined();
  });
  it("a session revoked while the body was on its way changes nothing", async () => {
    const f = await fleet();
    try {
      const s = f.session("admin");
      const body = JSON.stringify({ offices: [OPS] });
      const status = await new Promise<number>((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port: f.port, method: "PUT", path: "/ui/offices", headers: { ...s.write, "content-length": String(Buffer.byteLength(body)) } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
        r.on("error", reject);
        r.flushHeaders();
        setTimeout(() => { f.fm.webSessions.revokeById(s.id); r.end(body); }, 150);
      });
      expect([status, f.fm.officeStore.list().offices]).toEqual([401, []]);
    } finally { await f.stop(); }
  }, 30_000);
  it("the public link: the read on its manifest, the write absent — and refused by the handler on its own", async () => {
    expect([isPublicWebRoute("GET", "/ui/offices"), isPublicWebRoute("PUT", "/ui/offices"), isPublicWebRoute("POST", "/ui/offices")]).toEqual([true, false, false]);
    const f = await fleet();
    try {
      const { sessionId } = f.fm.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "t", tokenEpoch: tokenEpoch(f.fm.webToken) });
      const answer = await new Promise<{ status: number; body: string }>(resolve => {
        let code = 0;
        const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { code = c; res.headersSent = true; return res; }, end(b: string) { resolve({ status: code, body: String(b) }); } };
        const req = Object.assign(new EventEmitter(), { method: "PUT", url: "/ui/offices", headers: { host: "x.trycloudflare.com", cookie: `__Host-agend_session=${sessionId}`, origin: "https://x.trycloudflare.com", "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" }, destroy() {}, resume() {} });
        bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
        expect(handleWebRequest(req as never, res, new URL("https://x.trycloudflare.com/ui/offices"), f.fm)).toBe(true);
      });
      expect([answer.status, JSON.parse(answer.body).error]).toEqual([403, "offices_not_over_public_link"]);
    } finally { await f.stop(); }
  }, 30_000);
});
