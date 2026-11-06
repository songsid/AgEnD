/**
 * #2631: a third built-in Office style, Cozy — the zones layout on a warm pixel-art office drawn as one picture
 * (src/ui/shared/office/cozy.png, served at /assets/office-cozy.png), the built-in pixel people in it.
 * - Built in: in BUILT_IN_SKINS and SKINS (skinFor), offered in the Style picker after Desks and Studio; an uploaded pack
 *   cannot take its id.
 * - The default: the style of a browser that has not picked one, and of a new office in Edit offices. A saved office
 *   with no style of its own stays Desks (so no saved office changes), and an unknown id is drawn as Desks.
 * - Its pack passes the studio's structural checks: seats inside their areas, every seat reachable from the door through
 *   the graph and near its waypoint, every edge across or up/down, stateZones naming its areas; the notice board's tag
 *   (#2574) is the page's own words, in either language.
 * - Its picture: in the repo (a 1280×720 PNG), shipped with src/ui, served at /assets/ (public static, as the font) and
 *   on a share link's page (#2636).
 * - Until the picture loads it is drawn bare (the studio's floors); loadCozySkin puts the skin drawn from it in SKINS once
 *   (a failed load is tried again).
 * - A pack kept as "cozy" before it was built in: still read back, listed, served and deletable on the host, read by the
 *   page, and it wins the id — the offices and the browsers naming "cozy" keep drawing it; the built-in Cozy is not
 *   offered beside it (one id, one option) and is again once it is deleted. A new upload as "cozy" is still refused.
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniElement } from "./helpers/mini-dom.js";
import { isServedAsset } from "../src/auth-api.js";
import { officeShareStatic } from "../src/office-share-page.js";
import { checkOffices } from "../src/web-office-store.js";
import { OfficeSkinStore } from "../src/web-office-skins.js";

const ROOT = process.cwd();
const PICTURE = join(ROOT, "src", "ui", "shared", "office", "cozy.png");
const FIXTURE = join(ROOT, "tests", "fixtures", "office-skin-clinic");
const INSTANCES = [
  { name: "atlas", status: "running", backend: "claude-code" }, { name: "quill", status: "running", backend: "kiro-cli" },
  { name: "sage", status: "paused", backend: "grok" }, { name: "rook", status: "running", backend: "codex" },
];
const ORG = { general: ["atlas"], teams: [{ name: "Web", members: ["quill", "sage", "rook"] }], instances: {} };
const STORE = { ready: true, instances: INSTANCES, exec: { quill: "working" }, awaiting: { rook: "a prompt" }, needs: [] };

let p: AppPage;
let K: any, M: any, PK: any, Z: any, I: any, app: any, nav: any, fleet: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string) => ({ ok: true, status: 200, json: async () => (url === "/ui/org" ? ORG : url === "/ui/offices" ? { rev: 0, offices: [] } : {}) });
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  I = await import("/assets/app-i18n.js");
  fleet = await import("/ui/js/panel-fleet.js");
  K = await import("/ui/js/fleet-office-skin.js");
  M = await import("/ui/js/fleet-office-model.js");
  PK = await import("/ui/js/fleet-office-pack.js");
  Z = await import("/ui/js/fleet-office-zones.js");
});
afterAll(async () => { await p.unmount(); p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  p.storage.clear();
  nav.navigate("/ui/fleet/org");
  app.appStore.set(STORE);
});

function fakeCtx() {
  const calls: Array<[string, unknown[]]> = [];
  const t: any = { calls, measureText: (s: string) => ({ width: [...String(s)].length * 6 }), createPattern: () => ({ pattern: true }) };
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return (...a: unknown[]) => { calls.push([String(k), a]); }; }, set(o, k, v) { o[k] = v; return true; } });
}

describe("built in", () => {
  it("a third built-in style after Desks and Studio, a zones one with the built-in people; an unknown id is Desks", () => {
    expect(K.BUILT_IN_SKINS).toEqual(["pixel", "studio", "cozy", "guild", "school"]);   // #2947: two more after it
    const sk = K.skinFor("cozy");
    expect([sk.id, sk.pack.id, sk.pack === K.COZY_PACK, !!sk.pack.stateZones]).toEqual(["cozy", "cozy", true, true]);
    expect([K.COZY_PACK.characters, K.COZY_PACK.byInstance]).toEqual([{}, {}]);
    expect(sk.charBox({ name: "a", pose: "idle" }, { x: 100, y: 100 })).toEqual(K.pixelSkin.charBox({ name: "a", pose: "idle" }, { x: 100, y: 100 }));   // the built-in figure
    expect(K.skinFor("nope").id).toBe("pixel");
  });
  it("an uploaded pack cannot take its id", () => {
    const man = JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
    expect(PK.checkSkinPack({ ...man, id: "cozy" })).toEqual({ ok: false, error: "id: a built-in skin's id" });
  });
});

describe("its pack", () => {
  const C = () => K.COZY_PACK;
  const seats = () => Object.values(C().areas).flatMap((a: any) => a.seats.map((q: any) => ({ ...q, area: a.name })));
  it("seats inside their areas; stateZones name its areas (working, idle, asleep and calling as the studio's)", () => {
    for (const a of Object.values(C().areas) as any[]) {
      expect(a.seats.length, a.name).toBeGreaterThan(0);
      for (const q of a.seats) expect(q.x >= a.rect.x && q.x <= a.rect.x + a.rect.w && q.y >= a.rect.y && q.y <= a.rect.y + a.rect.h, `${a.name} ${q.x},${q.y}`).toBe(true);
      expect(a.rect.x >= 0 && a.rect.y >= 0 && a.rect.x + a.rect.w <= 1280 && a.rect.y + a.rect.h <= 720, a.name).toBe(true);
    }
    for (const [st, ar] of Object.entries(C().stateZones)) expect(Object.keys(C().areas), st).toContain(ar);
    expect(C().stateZones).toEqual(K.STUDIO_PACK.stateZones);
    expect(Object.fromEntries(Object.entries(C().areas).map(([k, a]: any) => [k, a.seats.length]))).toEqual({ desks: 6, lounge: 3, alert: 2, nap: 3 });
  });
  it("the graph: edges between its waypoints, across or up/down; every seat reachable from the door, near its waypoint", () => {
    const by = new Map(C().waypoints.map((w: any) => [w.id, w]));
    expect(by.size).toBe(C().waypoints.length);                                          // no two share an id
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
      const way = M.routeVia(C(), C().door, q);
      expect(way.length, `${q.area} ${q.x},${q.y}`).toBeGreaterThan(2);                  // through the graph, not a straight line
    }
    expect(C().straight).toBe(true);                                                      // #2634: every leg an L on the aisles
  });
  it("everyone takes a seat in their state's area; Edit layout's overrides apply to it", () => {
    const n = (name: string, state: string) => ({ name, state, i: { name } });
    const L = Z.zonesLayout(C(), [n("a", "working"), n("b", "idle"), n("c", "paused"), n("d", "needs"), n("e", "stopped"), n("f", "crashed")]);
    expect(Object.fromEntries([...L.seats].map(([k, s]: any) => [k, s.area]))).toEqual({ a: "desks", b: "lounge", c: "nap", d: "alert", e: "nap", f: "alert" });
    expect(L.straight).toBe(true);
    const a = PK.applyOverrides(C(), { pack: "cozy", door: [600, 700], furniture: { notice: [1200, 620] } });
    expect(a.ok).toBe(true);
    expect([a.pack.door, a.pack.furniture[0].x, a.pack.furniture[0].label]).toEqual([{ x: 600, y: 700 }, 1200, "Add your skin"]);
  });
  it("the notice board: one item, no picture of its own (it is in the background), its tag the page's words in either language", () => {
    expect(C().furniture.map((f: any) => f.id)).toEqual(["notice"]);
    const f = C().furniture[0];
    expect([f.x, f.y, f.sprite, f.shape]).toEqual([1211, 628, undefined, undefined]);
    expect(f.label).toBe("Add your skin");
    I.setLang("zh-TW", { store: false });
    try { expect([f.label, I.t("orgo.style_cozy")]).toEqual(["換上你的外觀包", "溫馨"]); } finally { I.setLang("en", { store: false }); }
    expect(I.t("orgo.style_cozy")).toBe("Cozy");
    for (const s of ["Add your skin", "換上你的外觀包"]) expect([...s].length).toBeLessThanOrEqual(40);   // a pack label's limit
  });
});

describe("its picture", () => {
  it("is in the repo: a 1280×720 PNG under src/ui (the build copies src/ui to dist)", () => {
    expect(existsSync(PICTURE)).toBe(true);
    const b = readFileSync(PICTURE);
    expect(b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([1280, 720]);
    expect(b.length).toBeLessThan(512 * 1024);
    expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.postbuild).toContain("cp -r src/ui dist/");
  });
  it("is served at /assets/office-cozy.png: on the dashboard (public static) and on a share link's page", () => {
    expect(K.COZY_BACKGROUND).toBe("/assets/office-cozy.png");
    expect(K.COZY_PACK.background).toBe(K.COZY_BACKGROUND);
    expect(isServedAsset("office-cozy.png")).toBe(true);
    const s = officeShareStatic("/assets/office-cozy.png");
    expect(s?.type).toBe("image/png");
    expect(s?.body.equals(readFileSync(PICTURE))).toBe(true);
  });
});

describe("loading the picture", () => {
  it("bare until it loads (the studio's floors); a failed load keeps it bare and is tried again; loaded once, then drawn from it", async () => {
    const bare = K.skinFor("cozy");
    expect(bare.backdrop).toBeNull();
    const c0 = fakeCtx();
    bare.drawBackground(c0, { areas: K.COZY_PACK.areas }, { pal: K.DEFAULT_PAL, mode: "dark", labels: { areas: {} } });
    expect(c0.calls.some(([k]: any) => k === "drawImage")).toBe(false);
    expect(c0.calls.some(([k]: any) => k === "fillRect")).toBe(true);
    const asked: string[] = [];
    expect(await K.loadCozySkin({ image: async (u: string) => { asked.push(u); return null; } })).toBeNull();
    expect(K.skinFor("cozy")).toBe(bare);
    const pic = { width: 1280, height: 720 };
    const sk = await K.loadCozySkin({ image: async (u: string) => { asked.push(u); return pic; } });
    expect(asked).toEqual(["/assets/office-cozy.png", "/assets/office-cozy.png"]);
    expect([sk.id, sk.backdrop, K.skinFor("cozy")]).toEqual(["cozy", pic, sk]);
    expect(await K.loadCozySkin({ image: async (u: string) => { asked.push(u); return pic; } })).toBe(sk);
    expect(asked.length).toBe(2);                                                         // once
    const c1 = fakeCtx();
    sk.drawBackground(c1, { areas: K.COZY_PACK.areas }, { pal: K.DEFAULT_PAL, mode: "dark", labels: { areas: {} } });
    expect(c1.calls.find(([k]: any) => k === "drawImage")?.[1]).toEqual([pic, 0, 0, 1280, 720]);
  });
});

describe("the Style picker", () => {
  const mount = async () => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6); };
  const office = async () => { await mount(); p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(4); };
  const style = () => p.root.querySelectorAll(".oo-bar select")[1];
  const proto = MiniElement.prototype as any;
  beforeEach(() => { proto.getContext = function () { return (this._ctx ??= fakeCtx()); }; });
  afterEach(() => { delete proto.getContext; });
  it("with nothing saved, the Office opens in Cozy: everyone in it, the notice board drawn; nothing kept until one is picked", async () => {
    expect(localStorage.getItem("agend_org_office_skin")).toBeNull();
    await office();
    expect(style().value).toBe("cozy");                                                    // #2631: the default
    expect(p.root.querySelectorAll(".oo-desk").map((b: any) => b.getAttribute("data-name")).sort()).toEqual(["atlas", "quill", "rook", "sage"]);
    const texts = p.root.querySelector(".oo-canvas")._ctx.calls.filter(([k]: any) => k === "fillText").map(([, a]: any) => a[0]);
    expect(texts).toContain("Add your skin");                                            // the notice board's tag
    expect(localStorage.getItem("agend_org_office_skin")).toBeNull();
  });
  it("offers Cozy after Desks and Studio; picked, each is kept per browser (Desks too) and everyone is in it", async () => {
    await office();
    expect(style().querySelectorAll("option").map((o: any) => [o.value, o.textContent.trim()])).toEqual([["pixel", "Desks"], ["studio", "Studio"], ["cozy", "Cozy"], ["guild", "Guild"], ["school", "School"]]);
    const pick = async (v: string) => { const s = style(); s.value = v; fire(s, "change"); await settle(4); };
    await pick("pixel");
    expect(localStorage.getItem("agend_org_office_skin")).toBe("pixel");
    await p.unmount(); await office();
    expect(style().value).toBe("pixel");                                                   // a choice of Desks is kept over the default
    await pick("cozy");
    expect(localStorage.getItem("agend_org_office_skin")).toBe("cozy");
    expect(p.root.querySelectorAll(".oo-desk").map((b: any) => b.getAttribute("data-name")).sort()).toEqual(["atlas", "quill", "rook", "sage"]);
    await p.unmount(); await office();
    expect(style().value).toBe("cozy");
  });
});

describe("new offices are Cozy; saved ones keep theirs", () => {
  const office = async () => {
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6);
    p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(4);
  };
  const proto = MiniElement.prototype as any;
  let base: any, puts: any[] = [], stored: any = { rev: 0, offices: [] };
  beforeEach(() => {
    puts = []; stored = { rev: 0, offices: [] }; base = (globalThis as any).fetch;
    proto.getContext = function () { return (this._ctx ??= fakeCtx()); };
    (globalThis as any).AgendAuth = { canWrite: async () => true }; (p.window as any).AgendAuth = (globalThis as any).AgendAuth;
    (globalThis as any).fetch = async (url: string, o: any = {}) => {
      if (url === "/ui/offices" && o.method === "PUT") { puts.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ rev: stored.rev + 1, offices: [] }) }; }
      if (url === "/ui/offices") return { ok: true, status: 200, json: async () => stored };
      return base(url, o);
    };
  });
  afterEach(() => { (globalThis as any).fetch = base; delete proto.getContext; delete (globalThis as any).AgendAuth; delete (p.window as any).AgendAuth; });
  it("a new office in Edit offices starts as Cozy and is saved so; the saved one without a style is Desks there", async () => {
    stored = { rev: 4, offices: [{ id: "ops", name: "Ops room", members: [] }] };              // saved before #2631: no skin
    await office();
    p.root.querySelector(".oo-edit").click(); await settle(3);
    p.root.querySelector("#oeAdd").click(); await settle(2);
    const rows = p.root.querySelectorAll(".oe-row");
    expect(rows.map((r: any) => r.querySelector(".oe-style").value)).toEqual(["pixel", "cozy"]);
    const name = rows[1].querySelector(".oe-name"); name.value = "Den"; fire(name, "input"); await settle(1);
    p.root.querySelector("#oeSave").click(); await settle(4);
    expect(puts).toHaveLength(1);
    expect(puts[0].offices.map((o: any) => [o.name, o.skin])).toEqual([["Ops room", "pixel"], ["Den", "cozy"]]);
  });
  it("a stored office record without a style still reads as Desks: on the page and on the host", () => {
    expect(M.officeOk({ id: "ops", name: "Ops" }).skin).toBe("pixel");
    expect(M.officeOk({ id: "ops", name: "Ops", skin: "cozy" }).skin).toBe("cozy");
    const c: any = checkOffices([{ id: "ops", name: "Ops" }]);
    expect([c.ok, c.offices[0].skin]).toEqual([true, "pixel"]);
  });
});

describe("a pack kept as \"cozy\" before it was built in", () => {
  const man = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
  const b64 = (f: string) => readFileSync(join(FIXTURE, f)).toString("base64");
  const upload = (id: string) => ({ manifest: { ...man(), id }, files: { "office_bg.png": b64("office_bg.png"), "fox_idle.png": b64("fox_idle.png") }, name: "Our cozy" });
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  /** A host whose skins directory has a "cozy" pack as an upload before #2631 left it (kept under another id, then moved). */
  const oldHost = () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-cozy-kept-")); dirs.push(dir);
    const s = new OfficeSkinStore(dir, () => 7);
    expect(s.add(upload("was"), "admin").ok).toBe(true);
    const root = join(dir, "web-office-skins");
    renameSync(join(root, "was"), join(root, "cozy"));
    const rec = JSON.parse(readFileSync(join(root, "cozy", "pack.json"), "utf8"));
    writeFileSync(join(root, "cozy", "pack.json"), JSON.stringify({ ...rec, id: "cozy", manifest: { ...rec.manifest, id: "cozy" } }));
    return { dir, rec };
  };
  it("the host still reads it back after a restart: listed, served, its pictures; deletable; a new upload as cozy is refused", () => {
    const { dir, rec } = oldHost();
    const s = new OfficeSkinStore(dir);                                                    // a cold load, as after the update
    expect(s.list().packs.map((pk) => [pk.id, pk.name, pk.sha])).toEqual([["cozy", "Our cozy", rec.sha]]);
    expect(s.get("cozy")?.manifest.id).toBe("cozy");
    expect(s.pack("cozy")?.id).toBe("cozy");
    const fid = Object.values(rec.files as Record<string, { id: string }>)[0]!.id;
    expect(s.picture("cozy", fid)?.length).toBeGreaterThan(0);
    expect(s.add(upload("cozy"), "admin")).toMatchObject({ ok: false, status: 400, error: "skin_manifest_invalid", detail: "id: a built-in skin's id" });
    expect(s.remove("cozy").ok).toBe(true);
    expect(new OfficeSkinStore(dir).list().packs).toEqual([]);
    expect(PK.checkSkinPack({ ...man(), id: "cozy" }, { kept: true }).ok).toBe(true);    // read back, not uploaded
    for (const id of ["pixel", "studio"]) expect(PK.checkSkinPack({ ...man(), id }, { kept: true }), id).toEqual({ ok: false, error: "id: a built-in skin's id" });
  });
  it("the page reads it as the pack it is (loadPackSkin), not refused as a built-in id", async () => {
    const sha = "c".repeat(32);
    const sk = await K.loadPackSkin("cozy", sha, {
      fetch: async () => ({ ok: true, json: async () => ({ manifest: { ...man(), id: "cozy" }, files: { "office_bg.png": "a".repeat(32), "fox_idle.png": "b".repeat(32) } }) }),
      image: async () => ({ width: 1280, height: 720 }),
    });
    expect(sk && [sk.pack.id, sk.pack === K.COZY_PACK]).toEqual(["cozy", false]);
  });

  describe("on the page: it wins the id", () => {
    const proto = MiniElement.prototype as any;
    const KEPT = { id: "cozy", name: "Our cozy", sha: "d".repeat(32), bytes: 1, files: 2, uploaded_at: 1 };
    let base: any, asked: string[] = [], packs: any[] = [];
    const mount = async () => {
      await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6);
      p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(6);
    };
    const drawn = () => p.root.querySelector(".oo-canvas")._ctx.calls.filter(([k]: any) => k === "fillText").map(([, a]: any) => a[0]);
    const options = (sel: any) => sel.querySelectorAll("option").map((o: any) => [o.value, o.textContent.trim()]);
    beforeEach(() => {
      asked = []; packs = [KEPT]; base = (globalThis as any).fetch;
      proto.getContext = function () { return (this._ctx ??= fakeCtx()); };
      (globalThis as any).AgendAuth = { canWrite: async () => true }; (p.window as any).AgendAuth = (globalThis as any).AgendAuth;
      (globalThis as any).fetch = async (url: string, o: any = {}) => {
        asked.push(url);
        if (url === "/ui/office-skins") return { ok: true, status: 200, json: async () => ({ rev: "r", packs, readable: true }) };
        if (url.startsWith("/ui/office-skins/cozy?")) return { ok: true, status: 200, json: async () => ({ id: "cozy", name: "Our cozy", sha: KEPT.sha, manifest: { ...man(), id: "cozy" }, files: { "office_bg.png": "a".repeat(32), "fox_idle.png": "b".repeat(32) } }) };
        if (url === "/ui/offices") return { ok: true, status: 200, json: async () => ({ rev: 3, offices: [{ id: "den", name: "Den", members: [], skin: "cozy" }] }) };
        return base(url, o);
      };
    });
    afterEach(() => { (globalThis as any).fetch = base; delete proto.getContext; delete (globalThis as any).AgendAuth; delete (p.window as any).AgendAuth; });
    it("an office naming cozy is drawn in the kept pack, not the built-in; Edit offices lists it once, by its name", async () => {
      await mount();
      const pick = p.root.querySelector(".oo-office"); pick.value = "den"; fire(pick, "change"); await settle(6);
      expect(asked.some((u) => u.startsWith("/ui/office-skins/cozy?"))).toBe(true);        // the pack is what loads
      expect(drawn()).not.toContain("Add your skin");                                     // the built-in's notice board is not drawn
      p.root.querySelector(".oo-edit").click(); await settle(3);
      const row = p.root.querySelector(".oe-row .oe-style");
      expect(row.value).toBe("cozy");
      expect(options(row)).toEqual([["pixel", "Desks"], ["studio", "Studio"], ["guild", "Guild"], ["school", "School"], ["cozy", "Our cozy"]]);
    });
    it("a browser that picked it keeps it; the Style picker offers it once; deleted, the built-in Cozy is offered again", async () => {
      localStorage.setItem("agend_org_office_skin", "cozy");
      packs = [{ ...KEPT, sha: "e".repeat(32) }];                                         // another sha: loaded afresh, not from the cache
      await mount();
      const style = () => p.root.querySelectorAll(".oo-bar select")[1];
      expect(style().value).toBe("cozy");
      expect(options(style())).toEqual([["pixel", "Desks"], ["studio", "Studio"], ["guild", "Guild"], ["school", "School"], ["cozy", "Our cozy"]]);
      expect(asked.some((u) => u.startsWith("/ui/office-skins/cozy?"))).toBe(true);
      expect(drawn()).not.toContain("Add your skin");
      packs = [];
      await p.unmount(); await mount();
      expect(options(style())).toEqual([["pixel", "Desks"], ["studio", "Studio"], ["cozy", "Cozy"], ["guild", "Guild"], ["school", "School"]]);
      expect(drawn()).toContain("Add your skin");
    });
  });
});
