/**
 * #2736: a pack's `mailDrop` — where a letter from another office (#2564) lands.
 * - The manifest's `mailDrop: [x, y]` (optional, on the canvas, like `door`); checked as { x, y }, else null.
 * - An office's `overrides.mailDrop` (Edit layout), checked and applied like `door`; overridesBetween keeps it when
 *   placed on a pack without one, or moved from the pack's.
 * - dropPoint: the layout's mailDrop, n GAPs right of it, on past any seat (never beyond the right edge), else today's
 *   rule; without one, today's rule. zonesLayout carries it; a letter flies door → there.
 * - Edit layout: an envelope handle — dashed ("auto") where letters land today on a pack without one; dragged, saved.
 * - On the host: kept beside the offices (`mailDrop` by office id), so a 2.3.2 beta before it (a closed overrides key
 *   list) still reads every office with the rest of its layout.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { OfficeStore } from "../src/web-office-store.js";
import * as HPK from "../src/ui/fleet-office-pack.js";

let p: AppPage;
let PK: any, LY: any, Z: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  PK = await import("/ui/js/fleet-office-pack.js");
  LY = await import("/ui/js/fleet-office-layout.js");
  Z = await import("/ui/js/fleet-office-zones.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const STRIP = (src: string) => ({ src, frames: 2, w: 16, h: 16 });
const MANIFEST = (extra: any = {}) => ({ format: 1, id: "mailpack", background: "bg.png",
  areas: { lounge: { rect: [0, 0, 1280, 720], seats: [[100, 100], [700, 420]] } }, stateZones: { idle: "lounge" },
  waypoints: [{ id: "hall", x: 640, y: 600 }, { id: "mid", x: 600, y: 400 }], edges: [["hall", "mid"]],
  characters: { default: { idle: STRIP("i.png") } }, ...extra });
const packOf = (mod: any, extra: any = {}) => { const c = mod.checkSkinPack(MANIFEST(extra)); if (!c.ok) throw new Error(c.error); return c.pack; };

describe("the manifest's mailDrop", () => {
  it("optional: a point on the canvas, checked as { x, y }; absent: null", () => {
    expect(packOf(PK, { mailDrop: [660, 420] }).mailDrop).toEqual({ x: 660, y: 420 });
    expect(packOf(PK).mailDrop).toBeNull();
  });
  it("refused off the canvas or not [x, y], with where", () => {
    expect(PK.checkSkinPack(MANIFEST({ mailDrop: [1281, 0] }))).toEqual({ ok: false, error: "mailDrop[0]: a number from 0 to 1280" });
    expect(PK.checkSkinPack(MANIFEST({ mailDrop: [0, 721] }))).toEqual({ ok: false, error: "mailDrop[1]: a number from 0 to 720" });
    expect(PK.checkSkinPack(MANIFEST({ mailDrop: { x: 1, y: 2 } }))).toEqual({ ok: false, error: "mailDrop: [x, y]" });
  });
});

describe("an office's overrides.mailDrop", () => {
  it("checked like the door; applied over the pack's (or none); the pack untouched", () => {
    expect(PK.checkLayoutOverrides({ pack: "mailpack", mailDrop: [10, 20] })).toEqual({ ok: true, overrides: { pack: "mailpack", mailDrop: [10, 20] } });
    expect(PK.checkLayoutOverrides({ pack: "mailpack", mailDrop: [10, 900] })).toEqual({ ok: false, error: "overrides.mailDrop[1]: a number from 0 to 720" });
    const bare = packOf(PK), own = packOf(PK, { mailDrop: [660, 420] });
    expect(PK.applyOverrides(bare, { pack: "mailpack", mailDrop: [10, 20] }).pack.mailDrop).toEqual({ x: 10, y: 20 });
    expect(PK.applyOverrides(own, { pack: "mailpack", mailDrop: [10, 20] }).pack.mailDrop).toEqual({ x: 10, y: 20 });
    expect(PK.applyOverrides(own, { pack: "mailpack", door: [1, 1] }).pack.mailDrop).toEqual({ x: 660, y: 420 });
    expect(PK.applyOverrides(bare, { pack: "mailpack", door: [1, 1] }).pack.mailDrop).toBeNull();
    const { mailDrop: _none, ...older } = bare;                                                // a pack object without the key (a built-in's)
    expect(PK.applyOverrides(older, { pack: "mailpack", door: [1, 1] }).pack.mailDrop).toBeNull();
    expect(own.mailDrop).toEqual({ x: 660, y: 420 });
  });
  it("overridesBetween: placed on a pack without one, or moved from the pack's; the pack's own is no entry", () => {
    const bare = packOf(PK), own = packOf(PK, { mailDrop: [660, 420] });
    expect(PK.overridesBetween(bare, { ...bare, mailDrop: { x: 5, y: 6 } })).toEqual({ pack: "mailpack", mailDrop: [5, 6] });
    expect(PK.overridesBetween(own, { ...own, mailDrop: { x: 661, y: 420 } })).toEqual({ pack: "mailpack", mailDrop: [661, 420] });
    expect(PK.overridesBetween(own, { ...own, mailDrop: { x: 660, y: 421 } })).toEqual({ pack: "mailpack", mailDrop: [660, 421] });
    expect(PK.overridesBetween(own, { ...own })).toBeNull();
    expect(PK.overridesBetween(bare, { ...bare })).toBeNull();
  });
});

describe("where letters land", () => {
  const L = (mailDrop: any, seats: any[] = []) => ({ mode: "zones", width: 1280, height: 720, door: { x: 640, y: 700 }, rooms: [{ desks: [] }],
    areas: { lounge: { seats } }, waypoints: [{ id: "mid", x: 600, y: 400 }], edges: [], mailDrop });
  it("at the mailDrop, later letters GAP px right of it; none: the waypoint nearest the middle, as before", () => {
    expect(Z.dropPoint(L({ x: 300, y: 200 }))).toEqual({ x: 300, y: 200 });
    expect(Z.dropPoint(L({ x: 300, y: 200 }), 2)).toEqual({ x: 300 + 2 * Z.MAIL.GAP, y: 200 });
    expect(Z.dropPoint(L({ x: 300.4, y: 199.6 }))).toEqual({ x: 300, y: 200 });                 // rounded
    expect(Z.dropPoint(L(null))).toEqual({ x: 600, y: 400 });
  });
  it("never on a seat: on past it by GAP; nothing off the seats up to the right edge: today's rule", () => {
    expect(Z.dropPoint(L({ x: 300, y: 200 }, [{ x: 300, y: 200 }]))).toEqual({ x: 300 + Z.MAIL.GAP, y: 200 });
    expect(Z.dropPoint(L({ x: 300, y: 200 }, [{ x: 300 + Z.MAIL.GAP, y: 200 }]), 1)).toEqual({ x: 300 + 2 * Z.MAIL.GAP, y: 200 });
    // #2751 review: the nth off-seat slot — a seat on the anchor never sends two letters to one spot.
    const anchored = L({ x: 300, y: 200 }, [{ x: 300, y: 200 }]);
    expect([0, 1, 2].map((n) => Z.dropPoint(anchored, n))).toEqual([{ x: 316, y: 200 }, { x: 332, y: 200 }, { x: 348, y: 200 }]);
    expect(Z.dropPoint(L({ x: 1264, y: 200 }, [{ x: 1264, y: 200 }]), 1)).toEqual({ x: 600 + Z.MAIL.GAP, y: 400 });   // one slot left: the second, today's
    expect(Z.dropPoint(L({ x: 1280, y: 200 }), 1)).toEqual({ x: 600 + Z.MAIL.GAP, y: 400 });   // past the right edge: today's, n along
    expect(Z.dropPoint(L({ x: 1280, y: 200 }))).toEqual({ x: 1280, y: 200 });                  // on it is fine
    expect(Z.dropPoint(L({ x: 1280, y: 200 }, [{ x: 1280, y: 200 }]))).toEqual({ x: 600, y: 400 });
  });
  it("zonesLayout carries the pack's (null without); a letter flies from the door to it", () => {
    const nodes = [{ name: "ran", state: "idle" }];
    expect(Z.zonesLayout(packOf(PK), nodes).mailDrop).toBeNull();
    const lay = Z.zonesLayout(packOf(PK, { mailDrop: [300, 200] }), nodes);
    expect(lay.mailDrop).toEqual({ x: 300, y: 200 });
    const m = Z.createMail();
    expect(m.sync([{ id: "a", from: "far", to: "ran", kind: "send" }], 0, lay)).toBe(1);
    const [flying] = m.frame(1, lay, null);
    expect(flying.t).toBeLessThan(0.1);
    expect(Math.hypot(flying.x - lay.door.x, flying.y - lay.door.y)).toBeLessThan(10);   // from the door
    expect(m.targets(lay, 1e5)).toEqual(new Map([["ran", { x: 300, y: 200 }]]));
  });
  it("#2751 review: two people's letters at once, a seat on the mailDrop — each its own spot", () => {
    const nodes = [{ name: "alice", state: "idle" }, { name: "bob", state: "idle" }];
    const lay = Z.zonesLayout(packOf(PK, { mailDrop: [100, 100] }), nodes);                  // the lounge's first seat is (100, 100)
    const m = Z.createMail();
    expect(m.sync([{ id: "a", from: "far", to: "alice", kind: "send" }, { id: "b", from: "far", to: "bob", kind: "send" }], 0, lay)).toBe(2);
    const t = m.targets(lay, 1e5);
    expect([t.get("alice"), t.get("bob")]).toEqual([{ x: 116, y: 100 }, { x: 132, y: 100 }]);
  });
});

describe("Edit layout's mail drop handle", () => {
  it("the pack's: labelled Mail drop, on it; none: dashed (auto) where letters land today, following the waypoints", () => {
    expect(LY.handlesOf(packOf(PK, { mailDrop: [660, 420] })).find((x: any) => x.kind === "mail")).toEqual({ key: "mail", kind: "mail", label: "Mail drop", x: 660, y: 420 });
    const bare = packOf(PK), auto = LY.handlesOf(bare).find((x: any) => x.kind === "mail");
    expect(auto).toEqual({ key: "mail", kind: "mail", label: "Mail drop (where letters land now; drag to place it)", x: 600, y: 400, auto: true });
    const moved = LY.moveHandle(bare, "wp:mid", 620, 380);
    expect(LY.handlesOf(moved).find((x: any) => x.kind === "mail")).toMatchObject({ x: 620, y: 380, auto: true });
  });
  it("moved: rounded and on the canvas, its own (no longer auto); saved as overrides.mailDrop; Reset to the pack: none", () => {
    const bare = packOf(PK);
    const placed = LY.moveHandle(bare, "mail", 2000.4, 300.6);
    expect(placed.mailDrop).toEqual({ x: 1280, y: 301 });
    expect(LY.handlesOf(placed).find((x: any) => x.kind === "mail")).toEqual({ key: "mail", kind: "mail", label: "Mail drop", x: 1280, y: 301 });
    expect(LY.layoutOverrides(bare, placed)).toEqual({ pack: "mailpack", mailDrop: [1280, 301] });
  });
  describe("on the page", () => {
    afterEach(async () => { await p.unmount(); });
    it("an envelope, dashed while auto; dragged and saved; both languages", async () => {
      const base = packOf(PK), saved: any[] = [];
      await p.mount(h(LY.LayoutEditor, { base, start: base, dock: false, onChange() {}, onSave: async (ov: any) => { saved.push(ov); return { ok: true }; }, onClose() {} }));
      await settle(4);
      const handle = () => p.root.querySelector('[data-handle="mail"]');
      expect(handle().className).toContain("ol-mail auto");
      expect(handle().querySelectorAll(".ol-flap").length).toBe(1);
      const svg = p.root.querySelector(".ol-svg");
      svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 });
      fire(handle(), "pointerdown", { pointerId: 1, clientX: 600, clientY: 400 }); await settle(1);
      fire(svg, "pointermove", { pointerId: 1, clientX: 900, clientY: 500 }); await settle(1);
      fire(svg, "pointerup", { pointerId: 1 }); await settle(2);
      expect(handle().getAttribute("aria-label")).toBe("Mail drop at 900, 500");
      expect(handle().className).not.toContain("auto");
      p.root.querySelector(".ol-save").click(); await settle(4);
      expect(saved).toEqual([{ pack: "mailpack", mailDrop: [900, 500] }]);
    });
  });
  it("its words in both languages", async () => {
    const { t, setLang } = await import("/assets/app-i18n.js") as any;
    try {
      setLang("zh-TW", { store: false });
      expect([t("orgl.mail"), t("orgl.mailAuto"), t("orgl.none")]).toEqual(["信件落點", "信件落點（目前信件落下的位置；拖曳即可指定）", "尚未選取：請選座位、家具、門、信件落點或路徑點。"]);
      setLang("en", { store: false });
      expect(t("orgl.none")).toBe("Nothing selected: pick a seat, an item, the door, the mail drop or a waypoint.");
    } finally { setLang("en", { store: false }); }
  });
});

describe("on the host, rollback-safe", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const store = () => { const d = mkdtempSync(join(tmpdir(), "agend-mail-")); dirs.push(d); return { d, s: new OfficeStore(d, (id) => (id === "mailpack" ? packOf(HPK) : null)) }; };
  const OFFICE = (ov: any) => ({ id: "room", name: "Room", skin: "mailpack", members: [], overrides: ov });
  /** A 2.3.2 beta before #2736: its overrides keys are a closed list without mailDrop (an unknown key: no layout). */
  const beforeReads = (ov: any) => Object.keys(ov).every((k) => ["pack", "seats", "furniture", "furnitureNight", "seatFor", "door", "waypoints", "edges"].includes(k));

  it("written beside the offices; the overrides there pass the older check; read back whole", () => {
    const { d, s } = store();
    const ov = { pack: "mailpack", door: [5, 5], mailDrop: [300, 200] };
    expect(s.replace([OFFICE(ov)], 0).ok).toBe(true);
    const doc = JSON.parse(readFileSync(join(d, "web-offices.json"), "utf8"));
    expect(doc.overrides).toEqual({ room: { pack: "mailpack", door: [5, 5] } });
    expect(doc.mailDrop).toEqual({ room: [300, 200] });
    expect(beforeReads(doc.overrides.room)).toBe(true);
    expect(beforeReads(ov)).toBe(false);                                                       // control: inside, it would not
    expect(new OfficeStore(d).list().offices[0].overrides).toEqual(ov);
  });
  it("none: no key beside; one that no longer checks is left out on read, the office and the rest kept", () => {
    const { d, s } = store();
    expect(s.replace([OFFICE({ pack: "mailpack", door: [5, 5] })], 0).ok).toBe(true);
    const doc = JSON.parse(readFileSync(join(d, "web-offices.json"), "utf8"));
    expect(doc).not.toHaveProperty("mailDrop");
    writeFileSync(join(d, "web-offices.json"), JSON.stringify({ ...doc, mailDrop: { room: [9999, 0] } }));
    expect(new OfficeStore(d).list().offices).toEqual([OFFICE({ pack: "mailpack", door: [5, 5] })]);
  });
});
