/**
 * #3679: the fleet's own Office level titles, set once for every office (a pack's own `levels` still win).
 * - Validation: the very rules of a pack's `levels` (fleet-office-pack.js checkLevels is levelsOf) — the same error, at
 *   the same place, for the same input; a size cap; null or nothing in it is none.
 * - Kept in web-offices.json beside the offices: read back by a new store; kept through the offices' saves and the
 *   style's; titles that no longer check read back as none, the offices kept.
 * - Routes: PUT /ui/office-level-titles from an admin session only (anonymous 401, read session 403, the CLI token 403,
 *   the public link refused), checked, counted with the offices' saves, announced (`offices`); GET /ui/offices carries
 *   them; a share link gets every title, a pinned one only for people shown or a name that is no instance.
 * - The page: mergeLevels (fleet only, pack only, both: the pack's titles win, `fixed` merged with the pack's entry
 *   winning name by name), the badge and the card through it, the store's read checking them again, Settings' card.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => { throw new Error(`fleet levels: no child process may start (${name})`); };
  return { ...real, spawn: refuse("spawn"), spawnSync: refuse("spawnSync"), exec: refuse("exec"), execSync: refuse("execSync"),
    execFile: refuse("execFile"), execFileSync: refuse("execFileSync"), fork: refuse("fork") };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { OfficeStore, OfficeWriteLimiter, checkFleetLevels } = await import("../src/web-office-store.js");
const { checkLevels, checkSkinPack } = await import("../src/ui/fleet-office-pack.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { isPassiveWebRead } = await import("../src/web-auth.js");
const { handleWebRequest } = await import("../src/web-api.js");
const { bindGatewayRequest } = await import("../src/web-request-context.js");
const { OfficeShareView } = await import("../src/office-share.js");

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-3679-")); dirs.push(d); return d; };

const RANKS = { titles: [{ from: 0, name: "Novice" }, { from: 10, name: "Adept" }, { from: 50, name: "Master" }], fixed: { atlas: { title: "Founder", hideLevel: true }, barista: { title: "Coffee master", hideLevel: false } } };
const OPS = { id: "ops", name: "Ops room", skin: "pixel", members: ["atlas"] };

describe("validation: a pack's rules, reused", () => {
  const packError = (levels: unknown) => { const r = checkSkinPack({ format: 1, id: "lvpack", characters: { default: { idle: { src: "i.png", frames: 1, w: 8, h: 8 } } }, levels }); return r.ok ? null : r.error; };
  it.each([
    ["an unknown key", { colours: {} }],
    ["titles not rising", { titles: [{ from: 5, name: "A" }, { from: 5, name: "B" }] }],
    ["a name too long", { titles: [{ from: 1, name: "x".repeat(25) }] }],
    ["from out of range", { titles: [{ from: 100001, name: "A" }] }],
    ["too many titles", { titles: Array.from({ length: 33 }, (_, i) => ({ from: i, name: "t" })) }],
    ["an inherited name", { fixed: { constructor: { title: "A" } } }],
    ["hideLevel not a boolean", { fixed: { a: { title: "A", hideLevel: "yes" } } }],
    ["a title on two lines", { fixed: { a: { title: "A\nB" } } }],
    ["not an object", ["Novice"]],
  ])("%s: the same error as a pack's, at the same place; the store refuses it with it", (_why, levels) => {
    const r = checkLevels(levels);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe(packError(levels));
    expect(checkFleetLevels(levels)).toEqual({ ok: false, status: 400, error: "office_levels_invalid", detail: !r.ok ? r.error : "" });
  });
  it("what passes is what a pack keeps (trimmed, hideLevel filled); nothing in it, or null, is none; over the cap 413", () => {
    const r = checkLevels({ titles: [{ from: 1, name: " Intern " }], fixed: { atlas: { title: "Founder" } } });
    expect(r).toEqual({ ok: true, levels: { titles: [{ from: 1, name: "Intern" }], fixed: { atlas: { title: "Founder", hideLevel: false } } } });
    expect(checkLevels(undefined)).toEqual({ ok: false, error: "levels: an object" });
    for (const none of [null, {}, { titles: [] }, { fixed: {} }, { titles: [], fixed: {} }]) expect(checkFleetLevels(none), JSON.stringify(none)).toEqual({ ok: true, levels: null });
    const fixed = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`instance-with-a-rather-long-name-${"x".repeat(60)}-${i}`, { title: "A title of 24 characters" }]));
    expect(checkFleetLevels({ fixed })).toMatchObject({ ok: false, status: 413, error: "office_levels_too_large" });
  });
});

describe("kept in web-offices.json", () => {
  it("round trip: beside the offices; a new store reads the same back; the offices' saves and the style's keep them", () => {
    const dir = scratch(), s = new OfficeStore(dir);
    expect(s.levels()).toBeNull();
    expect(s.setLevels(RANKS)).toEqual({ ok: true, rev: 1, levels: RANKS });
    const doc = JSON.parse(readFileSync(s.path, "utf8"));
    expect([doc.version, doc.rev, doc.offices, doc.levels]).toEqual([1, 1, [], RANKS]);
    expect(new OfficeStore(dir).list()).toEqual({ rev: 1, offices: [], readable: true, levels: RANKS });
    expect(s.replace([OPS], 1)).toMatchObject({ ok: true, rev: 2 });
    expect(s.setAutoSkin("studio")).toMatchObject({ ok: true, rev: 3 });
    const back = new OfficeStore(dir);
    expect([back.list().offices, back.autoSkin(), back.levels()]).toEqual([[OPS], "studio", RANKS]);
    // A copy: changing what was read changes nothing kept.
    back.levels()!.titles!.push({ from: 99, name: "X" });
    expect(back.levels()).toEqual(RANKS);
    expect(s.setLevels(null)).toEqual({ ok: true, rev: 4, levels: null });
    expect("levels" in JSON.parse(readFileSync(s.path, "utf8"))).toBe(false);
    expect(new OfficeStore(dir).list()).toEqual({ rev: 4, offices: [OPS], readable: true, autoSkin: "studio" });
  });
  it("a refused write changes nothing; an unreadable file refuses (503); titles that no longer check read back as none, the offices kept", () => {
    const dir = scratch(), s = new OfficeStore(dir);
    s.setLevels(RANKS);
    expect(s.setLevels({ titles: [{ from: 1, name: "" }] })).toMatchObject({ ok: false, status: 400, error: "office_levels_invalid", detail: "levels.titles[0].name: 1–24 characters" });
    expect([s.rev(), s.levels()]).toEqual([1, RANKS]);
    writeFileSync(join(dir, "web-offices.json"), JSON.stringify({ version: 1, rev: 7, offices: [OPS], levels: { titles: [{ from: 3, name: "A" }, { from: 2, name: "B" }] } }));
    expect(new OfficeStore(dir).list()).toEqual({ rev: 7, offices: [OPS], readable: true });
    const bad = scratch();
    writeFileSync(join(bad, "web-offices.json"), "{ not json");
    expect(new OfficeStore(bad).setLevels(RANKS)).toMatchObject({ ok: false, status: 503, error: "offices_unreadable" });
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
  fm.fleetConfig = { instances: { atlas: { working_directory: "/tmp" } }, defaults: {} };
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (tier: "admin" | "read" = "admin") => {
    const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
    const cookie = `agend_session=${sessionId}`;
    return { read: { cookie }, write: { cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" } };
  };
  const stop = () => new Promise<void>(r => (fm.healthServer as Server).close(() => r()));
  return { fm, port, session, stop };
}

describe("PUT /ui/office-level-titles", () => {
  it("an admin session only; checked; counted with the offices' saves; announced; GET /ui/offices carries them", async () => {
    const f = await fleet();
    try {
      const sent: Array<[string, unknown]> = [];
      vi.spyOn(f.fm, "emitSseEvent").mockImplementation((...a: unknown[]) => { sent.push([a[0] as string, a[1]]); });
      f.fm.officeWrites = new OfficeWriteLimiter(() => 0, { perWindow: 2, windowMs: 60_000 });
      const put = (headers: Record<string, string>, body: unknown) => raw(f.port, "PUT", "/ui/office-level-titles", headers, JSON.stringify(body));
      expect((await put({ origin: `http://127.0.0.1:${f.port}`, "content-type": "application/json" }, { levels: RANKS })).status).toBe(401);
      const read = await put(f.session("read").write, { levels: RANKS });
      expect([read.status, JSON.parse(read.body).error]).toEqual([403, "offices_need_an_admin_session"]);
      const token = await put({ "x-agend-token": f.fm.getDashboardAccess().token, "content-type": "application/json" }, { levels: RANKS });
      expect([token.status, JSON.parse(token.body).error]).toEqual([403, "offices_need_an_admin_session"]);
      const admin = f.session("admin").write;
      for (const bad of [{}, { levels: RANKS, extra: 1 }, [], { skin: "studio" }]) {
        const r = await put(admin, bad);
        expect([r.status, JSON.parse(r.body).error], JSON.stringify(bad)).toEqual([400, "office_levels_invalid"]);
      }
      const wrong = await put(admin, { levels: { titles: [{ from: 5, name: "A" }, { from: 1, name: "B" }] } });
      expect([wrong.status, JSON.parse(wrong.body)]).toEqual([400, { error: "office_levels_invalid", detail: "levels.titles[1].from: higher than the title before it" }]);
      expect([f.fm.officeStore.rev(), sent]).toEqual([0, []]);
      const ok = await put(admin, { levels: RANKS });
      expect([ok.status, JSON.parse(ok.body)]).toEqual([200, { rev: 1, levels: RANKS }]);
      expect(sent).toEqual([["offices", { rev: 1 }]]);
      const got = await raw(f.port, "GET", "/ui/offices", f.session("read").read);
      expect(JSON.parse(got.body)).toEqual({ rev: 1, offices: [], readable: true, levels: RANKS });
      expect(JSON.parse((await put(admin, { levels: null })).body)).toEqual({ rev: 2, levels: null });
      const third = await put(admin, { levels: RANKS });                                     // the offices' saves' limit
      expect([third.status, JSON.parse(third.body).error, f.fm.officeStore.levels()]).toEqual([429, "offices_rate_limited", null]);
      expect([isPublicWebRoute("PUT", "/ui/office-level-titles"), isPassiveWebRead("PUT", "/ui/office-level-titles")]).toEqual([false, false]);
      const { sessionId } = f.fm.webSessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "t", tokenEpoch: tokenEpoch(f.fm.webToken) });
      const answer = await new Promise<{ status: number; body: string }>(resolve => {
        let code = 0;
        const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { code = c; res.headersSent = true; return res; }, end(b: string) { resolve({ status: code, body: String(b) }); } };
        const req = Object.assign(new EventEmitter(), { method: "PUT", url: "/ui/office-level-titles", headers: { host: "x.trycloudflare.com", cookie: `__Host-agend_session=${sessionId}`, origin: "https://x.trycloudflare.com", "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json" }, destroy() {}, resume() {} });
        bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
        expect(handleWebRequest(req as never, res, new URL("https://x.trycloudflare.com/ui/office-level-titles"), f.fm)).toBe(true);
      });
      expect([answer.status, JSON.parse(answer.body).error]).toEqual([403, "offices_not_over_public_link"]);
    } finally { await f.stop(); }
  }, 30_000);
  it("PUT /ui/office-style still answers as before (the shared handler)", async () => {
    const f = await fleet();
    try {
      const admin = f.session("admin").write;
      const ok = await raw(f.port, "PUT", "/ui/office-style", admin, JSON.stringify({ skin: "studio" }));
      expect([ok.status, JSON.parse(ok.body)]).toEqual([200, { rev: 1, autoSkin: "studio" }]);
      const bad = await raw(f.port, "PUT", "/ui/office-style", admin, JSON.stringify({ levels: RANKS }));
      expect([bad.status, JSON.parse(bad.body)]).toEqual([400, { error: "office_style_invalid", detail: "{ skin: a skin id, or null }" }]);
    } finally { await f.stop(); }
  }, 30_000);
});

describe("a share link", () => {
  it("every title; a pinned one only for people shown, or a name that is no instance (an NPC)", () => {
    const fixed = { "dev-a": { title: "A", hideLevel: false }, "dev-b": { title: "B", hideLevel: false }, barista: { title: "C", hideLevel: false } };
    const v = new OfficeShareView({ office: "eng", text: false }, {
      status: () => ({ instances: [{ name: "dev-a", state: "working" }, { name: "dev-b", state: "idle" }] }),
      org: () => ({ general: ["dev-a", "dev-b"], teams: [] }),
      offices: () => ({ rev: 3, offices: [{ id: "eng", name: "Eng", skin: "pixel", members: ["dev-a"] }], levels: { titles: RANKS.titles, fixed } }),
      acts: () => [], traffic: () => ({ now: "t", items: [] }), needs: () => [], hidden: () => false,
    });
    expect(v.officeList().levels).toEqual({ titles: RANKS.titles, fixed: { "dev-a": fixed["dev-a"], barista: fixed.barista } });
    const none = new OfficeShareView({ office: "eng", text: false }, {
      status: () => ({ instances: [] }), org: () => ({}), offices: () => ({ rev: 1, offices: [] }),
      acts: () => [], traffic: () => ({ now: "t", items: [] }), needs: () => [], hidden: () => false,
    });
    expect("levels" in none.officeList()).toBe(false);
  });
});

describe("the page", () => {
  let p: any, LV: any, C: any, S: any, T: any;
  beforeAll(async () => {
    const { page } = await import("./helpers/app-harness.js");
    p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
    LV = await import("/ui/js/fleet-office-levels.js");
    C = await import("/ui/js/fleet-office-card.js");
    S = await import("/ui/js/fleet-office-store.js");
    T = await import("/ui/js/settings-level-titles.js");
  });
  afterAll(() => p.restore());

  const FLEET = { titles: [{ from: 0, name: "Novice" }, { from: 10, name: "Adept" }], fixed: { atlas: { title: "Founder", hideLevel: true }, quill: { title: "Scribe", hideLevel: false } } };
  const PACK = { titles: [{ from: 0, name: "Intern" }, { from: 20, name: "Engineer" }], fixed: { quill: { title: "Editor", hideLevel: false }, barista: { title: "Coffee master", hideLevel: false } } };
  it("mergeLevels: fleet only, pack only, neither", () => {
    expect(LV.mergeLevels(FLEET, null)).toBe(FLEET);
    expect(LV.mergeLevels(null, PACK)).toBe(PACK);
    expect(LV.mergeLevels(null, undefined)).toBeNull();
  });
  it("mergeLevels, both: the pack's titles win; fixed merged, the pack's entry winning name by name", () => {
    const m = LV.mergeLevels(FLEET, PACK);
    expect(m.titles).toBe(PACK.titles);
    expect({ ...m.fixed }).toEqual({ atlas: FLEET.fixed.atlas, quill: PACK.fixed.quill, barista: PACK.fixed.barista });
    expect(LV.fixedOf("constructor", m)).toBeNull();
    // A pack that pins titles but has no table of its own keeps the fleet's table.
    const pinsOnly = LV.mergeLevels(FLEET, { fixed: { barista: { title: "Coffee master", hideLevel: false } } });
    expect([pinsOnly.titles, Object.keys(pinsOnly.fixed).sort()]).toEqual([FLEET.titles, ["atlas", "barista", "quill"]]);
    expect(LV.mergeLevels(FLEET, { titles: [] }).titles).toBe(FLEET.titles);
    // Titles only on both sides: no fixed table.
    expect(LV.mergeLevels({ titles: FLEET.titles }, { titles: PACK.titles })).toEqual({ titles: PACK.titles });
  });
  it("the badge and the card through them", () => {
    const lv = LV.levelsOk({ enabled: true, levels: { atlas: { level: 12 }, quill: { level: 25 }, dev: { level: 12 } } });
    const node = (name: string) => ({ name, state: "working", i: { name } });
    const card = (name: string, levels: unknown) => C.cardModel({ node: node(name), lv, levels, state: "Working", now: "", where: "Eng" }).stateLine;
    expect(card("dev", LV.mergeLevels(FLEET, null))).toBe("Working · Adept");                 // the fleet's table
    expect(card("dev", LV.mergeLevels(FLEET, PACK))).toBe("Working · Intern");                // the pack's table wins
    expect(card("quill", LV.mergeLevels(FLEET, PACK))).toBe("Working · Editor");              // the pack's pin wins
    expect(card("quill", LV.mergeLevels(FLEET, null))).toBe("Working · Scribe");
    expect(LV.badgeOf("atlas", lv, LV.mergeLevels(FLEET, PACK))).toEqual({ mark: true, tier: 0 });   // the fleet's pin stays
    expect(LV.badgeOf("atlas", lv, PACK)).toEqual({ text: "12", tier: 1 });
  });
  it("the store's read: the host's levels checked again; odd ones are none", async () => {
    const answer = (body: unknown) => S.createOfficeStore({ fetch: async () => ({ ok: true, json: async () => body }), storage: { getItem: () => null, setItem() {} } }).offices();
    expect((await answer({ rev: 2, offices: [], levels: { titles: [{ from: 1, name: " Intern " }] } })).levels).toEqual({ titles: [{ from: 1, name: "Intern" }] });
    expect((await answer({ rev: 2, offices: [], levels: { titles: "Intern" } })).levels).toBeNull();
    expect((await answer({ rev: 2, offices: [] })).levels).toBeNull();
  });
  it("Settings' card: its check is a pack's, and empty is none", () => {
    expect(T.levelTitlesProblem("")).toBe("");
    expect(T.levelTitlesProblem("{ nope")).toBe("Not valid JSON.");
    expect(T.levelTitlesProblem(JSON.stringify({ titles: [{ from: 1, name: "x".repeat(25) }] }))).toBe("levels.titles[0].name: 1–24 characters");
    expect(T.levelTitlesProblem(JSON.stringify(FLEET))).toBe("");
  });
});
