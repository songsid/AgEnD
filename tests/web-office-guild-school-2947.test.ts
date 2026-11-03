/**
 * #2947: two more built-in Office styles drawn like Cozy (#2631) — one picture shipped with the page, the zones layout on
 * it, the built-in pixel people — Guild (an adventurers' guild hall, src/ui/shared/office/guild.png) and School (a
 * classroom, src/ui/shared/office/school.png), both on the Cozy's arrangement.
 * - Built in: in BUILT_IN_SKINS after Cozy, in SKINS (skinFor), in the host's BUILT_IN_STYLES; an uploaded pack cannot
 *   take their ids, a pack kept under one before is still read back (RESERVED, as "cozy").
 * - Their packs pass the Cozy's structural checks: seats inside their areas, every seat reachable from the door through
 *   the graph and near its waypoint, every edge across or up/down, the studio's stateZones naming their areas.
 * - Their pictures: in the repo (1280×720 PNGs), served at /assets/ and on a share link's page (#2636).
 * - Until a picture loads the style is drawn bare (the studio's floors); loadBuiltInSkin loads each once (a failed load
 *   is tried again); loadCozySkin is loadBuiltInSkin("cozy").
 * - Their names in the Style picker, in either language.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { isServedAsset } from "../src/auth-api.js";
import { officeShareStatic } from "../src/office-share-page.js";
import { BUILT_IN_STYLES } from "../src/web-office-pack-tools.js";

const ROOT = process.cwd();
const FIXTURE = join(ROOT, "tests", "fixtures", "office-skin-clinic");
const STYLES = [
  { id: "guild", en: "Guild", zh: "冒險者公會", file: "guild.png", url: "/assets/office-guild.png", seats: { desks: 6, lounge: 6, alert: 3, nap: 3 } },
  { id: "school", en: "School", zh: "學校", file: "school.png", url: "/assets/office-school.png", seats: { desks: 6, lounge: 6, alert: 3, nap: 3 } },
] as const;

let p: AppPage;
let K: any, M: any, PK: any, Z: any, I: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  I = await import("/assets/app-i18n.js");
  await import("/ui/js/fleet-office.js");                                                 // registers the Office's words
  K = await import("/ui/js/fleet-office-skin.js");
  M = await import("/ui/js/fleet-office-model.js");
  PK = await import("/ui/js/fleet-office-pack.js");
  Z = await import("/ui/js/fleet-office-zones.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

function fakeCtx() {
  const calls: Array<[string, unknown[]]> = [];
  const t: any = { calls, measureText: (s: string) => ({ width: [...String(s)].length * 6 }), createPattern: () => ({ pattern: true }) };
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return (...a: unknown[]) => { calls.push([String(k), a]); }; }, set(o, k, v) { o[k] = v; return true; } });
}
const packOf = (id: string) => (id === "guild" ? K.GUILD_PACK : K.SCHOOL_PACK);

describe("built in", () => {
  it("after Desks, Studio and Cozy, on the page and on the host; zones styles with the built-in people", () => {
    expect(K.BUILT_IN_SKINS).toEqual(["pixel", "studio", "cozy", "guild", "school"]);
    expect(K.PICTURE_SKINS).toEqual(["cozy", "guild", "school"]);
    expect([...BUILT_IN_STYLES]).toEqual(K.BUILT_IN_SKINS);
    for (const s of STYLES) {
      const sk = K.skinFor(s.id);
      expect([sk.id, sk.pack.id, sk.pack === packOf(s.id), !!sk.pack.stateZones], s.id).toEqual([s.id, s.id, true, true]);
      expect([sk.pack.characters, sk.pack.byInstance, sk.pack.furniture], s.id).toEqual([{}, {}, []]);
      expect(sk.charBox({ name: "a", pose: "idle" }, { x: 100, y: 100 })).toEqual(K.pixelSkin.charBox({ name: "a", pose: "idle" }, { x: 100, y: 100 }));
    }
  });
  it("an uploaded pack cannot take their ids; one kept under them before is still read back", () => {
    const man = JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
    for (const s of STYLES) {
      expect(PK.checkSkinPack({ ...man, id: s.id }), s.id).toEqual({ ok: false, error: "id: a built-in skin's id" });
      expect(PK.checkSkinPack({ ...man, id: s.id }, { kept: true }).ok, s.id).toBe(true);
    }
  });
});

describe.each(STYLES)("$id's pack", (s) => {
  const C = () => packOf(s.id);
  const seats = () => Object.values(C().areas).flatMap((a: any) => a.seats.map((q: any) => ({ ...q, area: a.name })));
  it("seats inside their areas; the studio's stateZones naming its areas", () => {
    for (const a of Object.values(C().areas) as any[]) {
      for (const q of a.seats) expect(q.x >= a.rect.x && q.x <= a.rect.x + a.rect.w && q.y >= a.rect.y && q.y <= a.rect.y + a.rect.h, `${a.name} ${q.x},${q.y}`).toBe(true);
      expect(a.rect.x >= 0 && a.rect.y >= 0 && a.rect.x + a.rect.w <= 1280 && a.rect.y + a.rect.h <= 720, a.name).toBe(true);
    }
    for (const [st, ar] of Object.entries(C().stateZones)) expect(Object.keys(C().areas), st).toContain(ar);
    expect(C().stateZones).toEqual(K.STUDIO_PACK.stateZones);
    expect(Object.fromEntries(Object.entries(C().areas).map(([k, a]: any) => [k, a.seats.length]))).toEqual(s.seats);
    expect([C().background, C().door.x >= 0 && C().door.x <= 1280 && C().door.y <= 720]).toEqual([s.url, true]);
  });
  it("the graph: edges between its waypoints, across or up/down; every seat reachable from the door, near its waypoint", () => {
    const by = new Map(C().waypoints.map((w: any) => [w.id, w]));
    expect(by.size).toBe(C().waypoints.length);
    for (const [a, b] of C().edges) {
      const p1: any = by.get(a), p2: any = by.get(b);
      expect(!!p1 && !!p2, `${a}–${b}`).toBe(true);
      expect(p1.x === p2.x || p1.y === p2.y, `${a}–${b}`).toBe(true);
    }
    const door = M.nearestWaypoint(C().waypoints, C().door);
    for (const w of C().waypoints) expect(M.bfsPath(C().edges, door.id, w.id), w.id).not.toBeNull();
    for (const q of seats()) {
      const w = M.nearestWaypoint(C().waypoints, q);
      expect(Math.hypot(w.x - q.x, w.y - q.y), `${q.area} ${q.x},${q.y}`).toBeLessThanOrEqual(110);
      expect(M.routeVia(C(), C().door, q).length, `${q.area} ${q.x},${q.y}`).toBeGreaterThan(2);
    }
    expect(C().straight).toBe(true);
  });
  it("everyone takes a seat in their state's area; Edit layout's overrides apply to it", () => {
    const n = (name: string, state: string) => ({ name, state, i: { name } });
    const L = Z.zonesLayout(C(), [n("a", "working"), n("b", "idle"), n("c", "paused"), n("d", "needs"), n("e", "stopped"), n("f", "crashed")]);
    expect(Object.fromEntries([...L.seats].map(([k, q]: any) => [k, q.area]))).toEqual({ a: "desks", b: "lounge", c: "nap", d: "alert", e: "nap", f: "alert" });
    const a = PK.applyOverrides(C(), { pack: s.id, door: [600, 700] });
    expect([a.ok, a.pack.door]).toEqual([true, { x: 600, y: 700 }]);
  });
  it("its name in the Style picker, in either language", () => {
    expect(I.t(`orgo.style_${s.id}`)).toBe(s.en);
    I.setLang("zh-TW", { store: false });
    try { expect(I.t(`orgo.style_${s.id}`)).toBe(s.zh); } finally { I.setLang("en", { store: false }); }
  });
});

describe.each(STYLES)("$id's picture", (s) => {
  const PICTURE = join(ROOT, "src", "ui", "shared", "office", s.file);
  it("is in the repo: a 1280×720 PNG under src/ui", () => {
    expect(existsSync(PICTURE)).toBe(true);
    const b = readFileSync(PICTURE);
    expect(b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([1280, 720]);
    expect(b.length).toBeLessThan(512 * 1024);
  });
  it("is served on the dashboard (public static) and on a share link's page", () => {
    const name = s.url.slice("/assets/".length);
    expect(isServedAsset(name)).toBe(true);
    const r = officeShareStatic(s.url);
    expect(r?.type).toBe("image/png");
    expect(r?.body.equals(readFileSync(PICTURE))).toBe(true);
  });
  it("bare until it loads; a failed load is tried again; loaded once, then drawn from it", async () => {
    const bare = K.skinFor(s.id);
    expect(bare.backdrop).toBeNull();
    const asked: string[] = [];
    expect(await K.loadBuiltInSkin(s.id, { image: async (u: string) => { asked.push(u); return null; } })).toBeNull();
    expect(K.skinFor(s.id)).toBe(bare);
    const pic = { width: 1280, height: 720 };
    const sk = await K.loadBuiltInSkin(s.id, { image: async (u: string) => { asked.push(u); return pic; } });
    expect(asked).toEqual([s.url, s.url]);
    expect([sk.id, sk.backdrop, K.skinFor(s.id)]).toEqual([s.id, pic, sk]);
    expect(await K.loadBuiltInSkin(s.id, { image: async () => pic })).toBe(sk);
    const c = fakeCtx();
    sk.drawBackground(c, { areas: packOf(s.id).areas }, { pal: K.DEFAULT_PAL, mode: "dark", labels: { areas: {} } });
    expect(c.calls.find(([k]: any) => k === "drawImage")?.[1]).toEqual([pic, 0, 0, 1280, 720]);
  });
});

describe("loadBuiltInSkin", () => {
  it("only for the picture-backed built-ins", async () => {
    expect(await K.loadBuiltInSkin("pixel", { image: async () => ({}) })).toBeNull();
    expect(await K.loadBuiltInSkin("nope", { image: async () => ({}) })).toBeNull();
  });
});
