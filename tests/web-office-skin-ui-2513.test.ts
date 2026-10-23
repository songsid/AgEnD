/**
 * #2513 on the page: uploaded skin packs in the Office view, an office's layout overrides and the layout editor, and
 * crowds in a zones style.
 * - Overrides (fleet-office-pack.js): checked, put on a pack (never changing it), and back again (overridesBetween).
 * - The editor's pure part (fleet-office-layout.js): a seat stays in its area, anything else on the 1280×720 canvas;
 *   waypoints added and removed with their corridors; corridors joined and unjoined.
 * - Crowds (fleet-office-zones.js): an area over capacity packs the rest tighter before "+N"; the "+N" chip is clear of
 *   the area's name; a crowded area's bubbles are thinned (calls, then work; no idle or asleep chatter; a few at most);
 *   no bubble covers a name tag.
 * - The page: the style picker lists the host's packs; an office on a pack is drawn with it once loaded; a pack it cannot
 *   load (unknown, or no manifest) is drawn as Desks and says so; Edit layout for an admin only, saved as overrides with
 *   the rev read, Reset back to the pack's; "Hide paused and stopped" kept per browser.
 * - #2513 review: an editing session keeps the office, style, list and rev it opened on (a stream re-read meanwhile is a
 *   409 on Save, never a silent overwrite; the office picker waits, also while a save is pending; an office removed
 *   underneath leaves Cancel); inherited names ("constructor", "toString", "__proto__") are never pack references; an
 *   uploaded character is hit in the box it is drawn in (its strip, anchor, size and direction).
 * - Format v1 additions: a strip's displayed size (dw/dh) apart from its image size; four-direction walking
 *   (walkDown/walkUp/walkSide, side mirrored for left; missing → walk → idle).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const FILES = { "office_bg.png": "a".repeat(32), "fox_idle.png": "b".repeat(32) };

const INSTANCES = [
  { name: "atlas", display_name: "Atlas", status: "running", backend: "claude-code" },
  { name: "quill", status: "running", backend: "kiro-cli" },
  { name: "sage", status: "paused", backend: "grok" },
  { name: "nova", status: "stopped", backend: "codex" },
];
const ORG = { general: ["atlas"], teams: [{ name: "Web", members: ["quill", "sage", "nova"] }], instances: {} };
const STORE = { ready: true, instances: INSTANCES, exec: { quill: "working" }, awaiting: {}, needs: [] };

let p: AppPage;
let PK: any, Z: any, K: any, LY: any, app: any, nav: any, fleet: any;
let offices: any = { rev: 0, offices: [] }, skins: any = { rev: "", packs: [] }, manifestAnswer: any = null;
const puts: any[] = [];
let holdPut: Promise<void> | null = null;                                                   // a save pending until it settles
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string, o: any = {}) => {
    if (url === "/ui/offices" && o.method === "PUT") {
      const b = JSON.parse(o.body); puts.push(b);
      if (holdPut) await holdPut;
      if (b.rev !== offices.rev) return { ok: false, status: 409, json: async () => ({ error: "offices_changed" }) };   // as the host: the rev read, or 409
      offices = { rev: b.rev + 1, offices: b.offices };
      return { ok: true, status: 200, json: async () => offices };
    }
    if (url.startsWith("/ui/office-skins/")) return manifestAnswer ? { ok: true, status: 200, json: async () => manifestAnswer } : { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (url === "/ui/org" ? ORG : url === "/ui/offices" ? offices : url === "/ui/office-skins" ? skins : {}) };
  };
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  fleet = await import("/ui/js/panel-fleet.js");
  PK = await import("/ui/js/fleet-office-pack.js");
  Z = await import("/ui/js/fleet-office-zones.js");
  K = await import("/ui/js/fleet-office-skin.js");
  LY = await import("/ui/js/fleet-office-layout.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  p.storage.clear();
  offices = { rev: 0, offices: [] }; skins = { rev: "", packs: [] }; manifestAnswer = null; puts.length = 0; holdPut = null;
  nav.navigate("/ui/fleet/org");
  app.appStore.set(STORE);
});

const pack = () => PK.skinPackOk(MANIFEST());

describe("layout overrides: on a pack, never changing it", () => {
  it("applyOverrides moves seats, furniture, the door and replaces the graph; overridesBetween gives them back; another pack's change nothing", () => {
    const base = pack();
    const ov = { pack: "clinic-sample", seats: { desks: [[220, 250], [430, 240], [208, 360], [428, 360]] }, door: [600, 700], waypoints: [{ id: "a", x: 1, y: 2 }], edges: [] };
    expect(PK.checkLayoutOverrides(ov)).toEqual({ ok: true, overrides: ov });
    const r = PK.applyOverrides(base, ov);
    expect(r.ok).toBe(true);
    expect([r.pack.areas.desks.seats[0], r.pack.door, r.pack.waypoints, r.pack.edges]).toEqual([{ x: 220, y: 250 }, { x: 600, y: 700 }, [{ id: "a", x: 1, y: 2 }], []]);
    expect(base.areas.desks.seats[0]).toEqual({ x: 212, y: 240 });                       // the pack as it was
    expect(base.door).toEqual({ x: 640, y: 690 });
    expect(PK.overridesBetween(base, r.pack)).toEqual({ pack: "clinic-sample", seats: { desks: ov.seats.desks }, door: [600, 700], waypoints: ov.waypoints, edges: [] });
    expect(PK.overridesBetween(base, base)).toBeNull();
    expect(PK.applyOverrides(base, { ...ov, pack: "other" })).toEqual({ ok: true, pack: base });
    expect(PK.applyOverrides(base, { pack: "clinic-sample", seats: { desks: [[0, 0], [430, 240], [208, 360], [428, 360]] } })).toEqual({ ok: false, error: "overrides.seats.desks[0]: outside its area's rect" });
    expect(PK.checkLayoutOverrides({ pack: "clinic-sample", seats: { desks: [[1300, 0]] } })).toEqual({ ok: false, error: "overrides.seats.desks[0][0]: a number from 0 to 1280" });
  });
  it("officesOk keeps a stored office's overrides when they check, and drops them when they do not", async () => {
    const M = await import("/ui/js/fleet-office-model.js");
    const ov = { pack: "clinic-sample", door: [10, 10] };
    expect(M.officesOk([{ id: "c", name: "C", skin: "clinic-sample", overrides: ov }])[0].overrides).toEqual(ov);
    expect(M.officesOk([{ id: "c", name: "C", skin: "clinic-sample", overrides: { pack: "x", door: [9999, 0] } }])[0]).not.toHaveProperty("overrides");
  });
});

describe("the layout editor's pure part", () => {
  it("handles for every seat, item, the door and waypoint; a seat stays inside its area, the rest on the canvas, rounded", () => {
    const base = pack();
    const keys = LY.handlesOf(base).map((x: any) => x.key);
    expect(keys.filter((k: string) => k.startsWith("seat:"))).toHaveLength(13);
    expect(keys).toContain("door");
    expect(keys).toContain("wp:hall_c");
    const moved = LY.moveHandle(base, "seat:desks:0", 5, 5.4);
    expect(moved.areas.desks.seats[0]).toEqual({ x: 124, y: 140 });                     // clamped to the desks' rect
    expect(LY.moveHandle(base, "door", -40, 9999).door).toEqual({ x: 0, y: 720 });
    expect(LY.moveHandle(base, "wp:hall_c", 100.6, 200.2).waypoints.find((w: any) => w.id === "hall_c")).toEqual({ id: "hall_c", x: 101, y: 200 });
    expect(LY.moveHandle(base, "seat:nope:0", 1, 1)).toBe(base);
  });
  it("waypoints: added with a free name, removed with their corridors; corridors joined, then unjoined either way round", () => {
    const base = pack();
    const { pack: a, id } = LY.addWaypoint(base, 100, 100);
    expect(id).toBe("wp-8");
    const joined = LY.toggleEdge(a, id, "hall_c");
    expect(joined.edges.at(-1)).toEqual([id, "hall_c"]);
    expect(LY.toggleEdge(joined, "hall_c", id).edges).toEqual(base.edges);
    const gone = LY.removeWaypoint(joined, "hall_c");
    expect(gone.edges.some((e: string[]) => e.includes("hall_c"))).toBe(false);
    const ov = LY.layoutOverrides(base, gone);
    expect(PK.checkLayoutOverrides(ov).ok).toBe(true);
    expect(PK.applyOverrides(base, ov).ok).toBe(true);
  });
});

describe("crowds in a zones style", () => {
  const node = (name: string, state: string) => ({ name, state, i: { name } });
  it("an area over capacity packs the rest into a tighter grid before counting who is left; all inside its rect, clear of its name", () => {
    const lounge = K.STUDIO_PACK.areas.lounge;
    const loose = Z.overflowSpots(lounge), tight = Z.overflowSpots(lounge, 60);
    expect(tight.length).toBeGreaterThan(loose.length);
    const r = lounge.rect;
    expect(tight.every((q: any) => q.x >= r.x && q.x <= r.x + r.w && q.y >= r.y + Z.OVERFLOW.TITLE && q.y <= r.y + r.h)).toBe(true);
    // The maintainer's fleet: 70 instances, 42 idle, 26 asleep, 2 working.
    const nodes = [...Array.from({ length: 42 }, (_, i) => node(`i${i}`, "idle")), ...Array.from({ length: 26 }, (_, i) => node(`z${i}`, "paused")), node("w0", "working"), node("w1", "working")];
    const L = Z.zonesLayout(K.STUDIO_PACK, nodes);
    expect(L.crowd.get("lounge") || 0).toBe(0);                                           // the lounge holds all 42
    expect([...L.over].sort()).toEqual(["lounge", "nap"]);
    const spots = [...L.seats.values()].map((s: any) => `${s.x},${s.y}`);
    expect(new Set(spots).size).toBe(spots.length);                                       // still no two share a spot
    expect(spots.length + [...L.crowd.values()].reduce((a: number, b: number) => a + b, 0)).toBe(70);
  });
  it("the +N chip sits in the area's bottom-right corner: never on the band its name is written in", () => {
    const ctx = { save() {}, restore() {}, measureText: (s: string) => ({ width: s.length * 7 }), font: "" };
    for (const a of Object.values(K.STUDIO_PACK.areas) as any[]) {
      const b = K.crowdChip(ctx, a, 42);
      expect(b.y).toBeGreaterThan(a.rect.y + Z.OVERFLOW.TITLE);
      expect(b.x + b.w).toBeLessThanOrEqual(a.rect.x + a.rect.w);
      expect(b.y + b.h).toBeLessThanOrEqual(a.rect.y + a.rect.h);
    }
  });
  it("bubbles: in a crowded area calls first, then work, at most a few; no idle or asleep chatter; an uncrowded area keeps all", () => {
    const it = (key: string, state: string, area = "lounge", shown = 1) => ({ key, state, area, shown });
    const items = [it("a", "idle"), it("b", "working"), it("c", "paused"), it("d", "crashed"), it("e", "needs"), it("f", "working"), it("g", "stuck"), it("h", "idle", "desks")];
    const out = Z.thinBubbles(items, new Set(["lounge"])).map((x: any) => x.key);
    expect(out).toEqual(["h", "d", "e", "g"]);                                             // three calls fill the budget: no work, no chatter
    expect(Z.thinBubbles([it("a", "idle"), it("b", "working"), it("d", "needs")], new Set(["lounge"])).map((x: any) => x.key)).toEqual(["d", "b"]);
    expect(Z.thinBubbles(items, new Set()).length).toBe(items.length);
    expect(Z.thinBubbles(items, null).length).toBe(items.length);
    expect([Z.bubbleRank("crashed"), Z.bubbleRank("working"), Z.bubbleRank("idle")]).toEqual([0, 1, 2]);
  });
  it("placeBubbles: a rank orders them (work before chatter); a blocked box (a name tag) is never covered", () => {
    const box = (x: number, y: number) => ({ x, y, w: 40, h: 19 });
    const chat = { key: "a", calling: false, rank: 2, shown: 9, box: box(0, 0) }, work = { key: "b", calling: false, rank: 1, shown: 1, box: box(10, 0) };
    expect(Z.placeBubbles([chat, work], 22).map((x: any) => [x.key, x.dy])).toEqual([["b", 0], ["a", -22]]);
    const tag = { x: 0, y: 0, w: 60, h: 14 };
    expect(Z.placeBubbles([{ ...chat, box: box(0, 0) }], 22, [tag]).map((x: any) => x.dy)).toEqual([-22]);
    expect(Z.placeBubbles([{ ...chat, box: box(0, 0) }], 22, [tag, { x: 0, y: -30, w: 60, h: 14 }])).toEqual([]);
  });
});

describe("loadPackSkin: an uploaded pack as a skin", () => {
  it("its manifest checked, its pictures by content id; one that is not a pack is null (and tried again next time)", async () => {
    const asked: string[] = [];
    const get = async (url: string) => { asked.push(url); return { ok: true, json: async () => ({ manifest: MANIFEST(), files: FILES }) }; };
    const images: string[] = [];
    const sk = await K.loadPackSkin("clinic-sample", "1".repeat(32), { fetch: get, image: async (u: string) => { images.push(u); return { width: 1 }; } });
    expect([sk.id, !!sk.pack.stateZones]).toEqual(["clinic-sample", true]);
    expect(asked).toEqual([`/ui/office-skins/clinic-sample?v=${"1".repeat(32)}`]);
    expect(images.sort()).toEqual([`/ui/office-skins/clinic-sample/img/${"a".repeat(32)}.png`, `/ui/office-skins/clinic-sample/img/${"b".repeat(32)}.png`]);
    await K.loadPackSkin("clinic-sample", "1".repeat(32), { fetch: get });
    expect(asked).toHaveLength(1);                                                          // fetched once
    const broken = async () => ({ ok: true, json: async () => ({ manifest: { ...MANIFEST(), format: 3 }, files: FILES }) });
    expect(await K.loadPackSkin("clinic-sample", "2".repeat(32), { fetch: broken })).toBeNull();
    expect(await K.loadPackSkin("other-id", "1".repeat(32), { fetch: get })).toBeNull();     // a manifest for another id
    expect(await K.loadPackSkin("clinic-sample", "2".repeat(32), { fetch: get })).not.toBeNull();
  });
});

describe("the Office view with packs", () => {
  const mount = async () => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6); };
  const office = async () => { await mount(); p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(6); };
  const desks = () => p.root.querySelectorAll(".oo-desk").map((b: any) => b.getAttribute("data-name"));
  const auth = (canWrite: boolean) => { (globalThis as any).AgendAuth = { canWrite: async () => canWrite }; (p.window as any).AgendAuth = (globalThis as any).AgendAuth; };
  afterEach(() => { delete (globalThis as any).AgendAuth; delete (p.window as any).AgendAuth; delete document.body.dataset.tier; delete document.body.dataset.publicLink; });
  let sha = 100;
  const withPack = () => { const s = (sha++).toString(16).padStart(32, "0"); skins = { rev: "r", packs: [{ id: "clinic-sample", name: "Clinic", sha: s }] }; manifestAnswer = { manifest: MANIFEST(), files: FILES }; };

  it("the style picker lists the host's packs; the whole fleet in a pack's style", async () => {
    withPack();
    await office();
    const style = p.root.querySelectorAll(".oo-bar select")[1];
    expect(style.querySelectorAll("option").map((o: any) => o.textContent.trim())).toEqual(["Desks", "Studio", "Clinic"]);
    style.value = "clinic-sample"; fire(style, "change"); await settle(8);
    expect(localStorage.getItem("agend_org_office_skin")).toBe("clinic-sample");
    expect(p.root.querySelector(".oo-note")).toBeNull();
    expect(desks()).toEqual(["atlas", "quill", "sage", "nova"]);
  });
  it("an office on an uploaded pack: drawn with it, no note; a pack the page cannot load or the host no longer has: Desks, said so", async () => {
    withPack();
    offices = { rev: 3, offices: [{ id: "clinic", name: "Clinic", skin: "clinic-sample", members: [] }] };
    localStorage.setItem("agend_org_office", "clinic");
    await office();
    expect(p.root.querySelector(".oo-note")).toBeNull();
    await p.unmount();
    withPack(); manifestAnswer = null;                                                       // its manifest does not load
    await office();
    expect(p.root.querySelector(".oo-note")?.textContent).toBe("Its style “Clinic” is not available here: drawn as Desks.");
    await p.unmount();
    skins = { rev: "", packs: [] };                                                          // deleted on the host
    await office();
    expect(p.root.querySelector(".oo-note")?.textContent).toBe("Its style “clinic-sample” is not available here: drawn as Desks.");
  });
  it("Edit layout: an admin only, a stored office on a zones style; hidden for a read-only session, a guest page and the public link", async () => {
    withPack();
    offices = { rev: 3, offices: [{ id: "clinic", name: "Clinic", skin: "clinic-sample", members: [] }, { id: "desk", name: "Desk", skin: "pixel", members: [] }] };
    localStorage.setItem("agend_org_office", "clinic");
    const btn = () => p.root.querySelector(".oo-layout");
    auth(false); await office(); expect(btn()).toBeNull();
    await p.unmount(); auth(true); document.body.dataset.tier = "guest"; await office(); expect(btn()).toBeNull();
    await p.unmount(); delete document.body.dataset.tier; document.body.dataset.publicLink = "1"; await office(); expect(btn()).toBeNull();
    await p.unmount(); delete document.body.dataset.publicLink; await office();
    expect(btn()?.textContent.trim()).toBe("Edit layout");
    const sw = p.root.querySelector(".oo-bar select");
    sw.value = "desk"; fire(sw, "change"); await settle(4);
    expect(btn()).toBeNull();                                                                // Desks: nothing to place
  });
  it("move a seat with the keyboard, add a waypoint and join it: Save sends the office's overrides with the rev read; Reset sends none", async () => {
    withPack();
    offices = { rev: 3, offices: [{ id: "clinic", name: "Clinic", skin: "clinic-sample", members: ["quill"] }] };
    localStorage.setItem("agend_org_office", "clinic");
    auth(true); await office();
    p.root.querySelector(".oo-layout").click(); await settle(4);
    expect(p.root.querySelectorAll(".ol-grid").length).toBeGreaterThan(10);                // show coordinates: on
    const seat = p.root.querySelector('[data-handle="seat:desks:0"]');
    expect(seat.getAttribute("aria-label")).toBe("Seat 1 in desks at 212, 240");
    fire(seat, "keydown", { key: "ArrowRight", shiftKey: true }); await settle(2);
    fire(p.root.querySelector('[data-handle="seat:desks:0"]'), "keydown", { key: "ArrowDown" }); await settle(2);
    expect(p.root.querySelector('[data-handle="seat:desks:0"]').getAttribute("aria-label")).toBe("Seat 1 in desks at 222, 241");
    p.root.querySelector(".ol-add").click(); await settle(2);
    const to = p.root.querySelector(".ol-join-to"); to.value = "hall_c"; fire(to, "change"); await settle(1);
    p.root.querySelector(".ol-join").click(); await settle(2);
    expect(p.root.querySelectorAll(".ol-unjoin").map((b: any) => b.getAttribute("data-other"))).toEqual(["hall_c"]);
    p.root.querySelector(".ol-save").click(); await settle(6);
    expect(puts).toHaveLength(1);
    expect(puts[0].rev).toBe(3);
    const ov = puts[0].offices[0].overrides;
    expect(ov.pack).toBe("clinic-sample");
    expect(ov.seats).toEqual({ desks: [[222, 241], [430, 240], [208, 360], [428, 360]] });
    expect(ov.waypoints.at(-1).id).toBe("wp-8");
    expect(ov.edges.at(-1)).toEqual(["wp-8", "hall_c"]);
    expect(PK.applyOverrides(PK.skinPackOk(MANIFEST()), ov).ok).toBe(true);
    expect(puts[0].offices[0].members).toEqual(["quill"]);                                  // the rest of the office as it was
    expect(p.root.querySelector(".ol")).toBeNull();                                          // closed once saved
    // Reopened, it starts from the saved layout; Reset → the pack's own; Save sends no overrides.
    p.root.querySelector(".oo-layout").click(); await settle(4);
    expect(p.root.querySelector('[data-handle="seat:desks:0"]').getAttribute("aria-label")).toBe("Seat 1 in desks at 222, 241");
    p.root.querySelector(".ol-reset").click(); await settle(2);
    p.root.querySelector(".ol-save").click(); await settle(6);
    expect(puts).toHaveLength(2);
    expect(puts[1].rev).toBe(4);
    expect(puts[1].offices[0]).not.toHaveProperty("overrides");
  });
  it("the offices' editor keeps an office's overrides, lists the packs as styles, and offers the packs' upload and delete", async () => {
    withPack();
    const ov = { pack: "clinic-sample", door: [600, 700] };
    offices = { rev: 3, offices: [{ id: "clinic", name: "Clinic", skin: "clinic-sample", members: [], overrides: ov }] };
    auth(true); await office();
    p.root.querySelector(".oo-edit").click(); await settle(4);
    const style = p.root.querySelector(".oe-style");
    expect(style.querySelectorAll("option").map((o: any) => o.textContent.trim())).toEqual(["Desks", "Studio", "Clinic"]);
    expect(p.root.querySelectorAll(".oe-pack").map((li: any) => li.getAttribute("data-pack"))).toEqual(["clinic-sample"]);
    expect(p.root.querySelectorAll(".oe-upload input").length).toBe(2);
    p.root.querySelector("#oeSave").click(); await settle(6);
    expect(puts[0].offices[0].overrides).toEqual(ov);
  });
  it("Hide paused and stopped: off by default, kept per browser; the sleepers leave the office", async () => {
    await office();
    expect(desks()).toEqual(["atlas", "quill", "sage", "nova"]);
    const box = p.root.querySelector(".oo-hide-asleep input");
    expect(box.checked).toBe(false);
    fire(box, "change"); await settle(4);
    expect(desks()).toEqual(["atlas", "quill"]);
    expect(localStorage.getItem("agend_org_office_hide_asleep")).toBe("1");
    await p.unmount(); await office();
    expect(desks()).toEqual(["atlas", "quill"]);
  });


  // ── #2513 review: an editing session is bound to its office, style, list and rev ──
  const streamed = () => { const on: Record<string, () => void> = {}; app.appStore.set({ ...STORE, streamOn: (name: string, fn: () => void) => { on[name] = fn; return () => {}; } }); return on; };
  const seatLabel = () => p.root.querySelector('[data-handle="seat:desks:0"]')?.getAttribute("aria-label") ?? null;
  const nudge = async () => { fire(p.root.querySelector('[data-handle="seat:desks:0"]'), "keydown", { key: "ArrowRight", shiftKey: true }); await settle(2); };
  const A = (extra: any = {}) => ({ id: "clinic", name: "Clinic", skin: "clinic-sample", members: ["quill"], ...extra });
  const B = (extra: any = {}) => ({ id: "lab", name: "Lab", skin: "clinic-sample", members: ["atlas"], overrides: { pack: "clinic-sample", door: [600, 700] }, ...extra });
  const MOVED = { pack: "clinic-sample", seats: { desks: [[222, 240], [430, 240], [208, 360], [428, 360]] } };

  it("review: a stream re-read while editing never moves the session's rev — Save is a 409, not an overwrite, and Save again is the person's call; an ordinary save (control) is kept", async () => {
    // Control: nothing changed meanwhile — Save sends the rev read and is kept.
    withPack(); offices = { rev: 3, offices: [A()] }; localStorage.setItem("agend_org_office", "clinic");
    auth(true); streamed(); await office();
    p.root.querySelector(".oo-layout").click(); await settle(4);
    await nudge();
    p.root.querySelector(".ol-save").click(); await settle(8);
    expect([puts.map((b) => b.rev), offices.rev, p.root.querySelector(".ol")]).toEqual([[3], 4, null]);
    expect(offices.offices[0].overrides).toEqual(MOVED);
    // Another person's layout lands (rev 4) while this one edits; the stream re-reads it into the view.
    await p.unmount(); puts.length = 0;
    withPack(); offices = { rev: 3, offices: [A()] };
    const on = streamed(); await office();
    p.root.querySelector(".oo-layout").click(); await settle(4);
    await nudge();
    const theirs = { pack: "clinic-sample", door: [600, 700] };
    offices = { rev: 4, offices: [A({ overrides: theirs })] };
    on.offices(); await settle(6);
    expect(seatLabel()).toBe("Seat 1 in desks at 222, 240");                                // the draft is still what is shown
    p.root.querySelector(".ol-save").click(); await settle(8);
    expect(puts.map((b) => b.rev)).toEqual([3]);                                             // the session's rev, never the re-read's
    expect(offices).toEqual({ rev: 4, offices: [A({ overrides: theirs })] });               // their layout is not overwritten
    expect(p.root.querySelector(".ol-msg")?.textContent).toBe("Someone changed the offices meanwhile. Your layout is kept: Save again puts it on the current list.");
    expect(seatLabel()).toBe("Seat 1 in desks at 222, 240");
    // Save again: deliberately, on the list read after the 409.
    p.root.querySelector(".ol-save").click(); await settle(8);
    expect([puts.map((b) => b.rev), offices.rev, offices.offices[0].overrides, p.root.querySelector(".ol")]).toEqual([[3, 4], 5, MOVED, null]);
  });
  it("review: while editing the office stays — choosing another office or the whole fleet waits (also while a save is pending); Save puts only this office's layout on this office", async () => {
    withPack(); offices = { rev: 3, offices: [A(), B()] }; localStorage.setItem("agend_org_office", "clinic");
    auth(true); await office();
    p.root.querySelector(".oo-layout").click(); await settle(4);
    await nudge();
    const sw = () => p.root.querySelector(".oo-office");
    expect([sw().disabled, p.root.querySelector(".oo-edit").disabled]).toEqual([true, true]);
    for (const to of ["lab", "auto"]) { sw().value = to; fire(sw(), "change"); await settle(4); }
    expect([localStorage.getItem("agend_org_office"), seatLabel(), !!p.root.querySelector(".ol-cancel")]).toEqual(["clinic", "Seat 1 in desks at 222, 240", true]);
    // A save pending: still no switching, and Cancel waits for it too.
    let release: () => void = () => {};
    holdPut = new Promise<void>((r) => { release = r; });
    p.root.querySelector(".ol-save").click(); await settle(4);
    expect(p.root.querySelector(".ol-cancel").disabled).toBe(true);
    for (const to of ["lab", "auto"]) { sw().value = to; fire(sw(), "change"); await settle(2); }
    expect(localStorage.getItem("agend_org_office")).toBe("clinic");
    release(); holdPut = null; await settle(8);
    expect(puts).toHaveLength(1);
    expect(puts[0].offices.map((o: any) => [o.id, o.overrides])).toEqual([["clinic", MOVED], ["lab", { pack: "clinic-sample", door: [600, 700] }]]);   // B as it was
    expect(p.root.querySelector(".ol")).toBeNull();
    // Closed: the picker is back, and B's own layout opens on B.
    expect(sw().disabled).toBe(false);
    sw().value = "lab"; fire(sw(), "change"); await settle(6);
    p.root.querySelector(".oo-layout").click(); await settle(4);
    expect(p.root.querySelector('[data-handle="door"]').getAttribute("aria-label")).toBe("Door at 600, 700");
  });
  it("review: the office's style changed, or the office removed, underneath an open editor: it says so, nothing to save, Cancel closes it and Edit offices is back", async () => {
    withPack(); offices = { rev: 3, offices: [A(), B()] }; localStorage.setItem("agend_org_office", "clinic");
    auth(true); const on = streamed(); await office();
    const STALE = "This office was removed or its style changed meanwhile: this layout can no longer be saved. Cancel closes it.";
    for (const next of [[A({ skin: "studio" }), B()], [B()]]) {
      p.root.querySelector(".oo-layout").click(); await settle(4);
      expect(p.root.querySelector(".oo-edit").disabled).toBe(true);
      offices = { rev: offices.rev + 1, offices: next }; on.offices(); await settle(6);
      expect([p.root.querySelector(".ol-stale")?.textContent, p.root.querySelector(".ol-save"), p.root.querySelector(".ol-svg")]).toEqual([STALE, null, null]);
      p.root.querySelector(".ol-cancel").click(); await settle(4);
      expect([p.root.querySelector(".ol"), p.root.querySelector(".oo-edit").disabled, p.root.querySelector(".oo-office").disabled]).toEqual([null, false, false]);
    }
    expect(puts).toEqual([]);
  });
  it("review: an uploaded character is hovered where it is drawn — the clinic fox's head (above the old fixed box) shows its card, as its body does", async () => {
    const was = (globalThis as any).Image;
    class Img { onload: any = null; onerror: any = null; set src(_u: string) { setTimeout(() => this.onload && this.onload(), 0); } }
    (globalThis as any).Image = Img;
    try {
      withPack(); offices = { rev: 3, offices: [A()] }; localStorage.setItem("agend_org_office", "clinic");
      await office(); await settle(6);
      const V = await import("/ui/js/fleet-office-view.js");
      const cv = p.root.querySelector(".oo-canvas"), v = V.fitScene(1280, 720, { w: 960, h: 600 });   // the scene fitted to the stage (#2540: through the view)
      const hover = async (x: number, y: number) => { fire(cv, "pointermove", { clientX: v.x + x * v.k, clientY: v.y + y * v.k, pointerType: "mouse" }); await settle(3); return p.root.querySelector(".oo-tip strong")?.textContent ?? null; };
      // quill works at desks seat 0 (212, 240): the fox (32×48 at scale 2, anchor 16, 44) is drawn 64×96 from (180, 152).
      expect(await hover(212 - 16, 240 - 72)).toBe("quill");                                // its head: the old 48×66 box began at y 188
      expect(await hover(0, 0)).toBeNull();
      expect(await hover(212, 240 - 20)).toBe("quill");                                     // its body (control)
      expect(await hover(212 - 16, 240 - 100)).toBeNull();                                  // above the picture: no one
    } finally { (globalThis as any).Image = was; }
  });
});

describe("packUpload: what the upload sends from the picked files", () => {
  it("manifest.json parsed, the PNGs as base64 by their name (a folder's path inside it kept); none: said so", async () => {
    const E = await import("/ui/js/fleet-office-editor.js");
    const file = (name: string, bytes: Uint8Array | string, rel = "") => ({ name, webkitRelativePath: rel, text: async () => String(bytes), arrayBuffer: async () => (typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).buffer });
    const r = await E.packUpload([file("manifest.json", JSON.stringify({ id: "x" }), "pack/manifest.json"), file("idle.png", new Uint8Array([1, 2, 3]), "pack/sprites/idle.png"), file("notes.txt", "hi", "pack/notes.txt")]);
    expect(r).toEqual({ body: { manifest: { id: "x" }, files: { "sprites/idle.png": "AQID" } } });
    expect((await E.packUpload([file("idle.png", "x")])).error).toBe("no manifest.json among the files");
    expect((await E.packUpload([file("manifest.json", "{ nope")])).error).toBe("manifest.json is not JSON");
  });
});

describe("review: inherited names are never pack references", () => {
  const withName = (m: any, where: "areas" | "characters", name: string, value: unknown) =>
    JSON.parse(JSON.stringify({ ...m, [where]: { ...m[where], NAME_HERE: value } }).replace('"NAME_HERE"', JSON.stringify(name)));
  it("a state's area, an instance's set, an area or set declared under an inherited name: refused; the declared ones (control) pass", () => {
    const m = MANIFEST();
    expect(PK.checkSkinPack(m).ok).toBe(true);
    expect(PK.checkSkinPack({ ...m, stateZones: { ...m.stateZones, default: "nap" }, byInstance: { atlas: "fox" } }).ok).toBe(true);
    for (const bad of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(PK.checkSkinPack({ ...m, stateZones: { ...m.stateZones, default: bad } }), bad).toEqual({ ok: false, error: "stateZones.default: an area the pack defines" });
      expect(PK.checkSkinPack({ ...m, byInstance: { atlas: bad } }), bad).toEqual({ ok: false, error: "byInstance.atlas: a character set the pack defines" });
      expect(PK.checkSkinPack(withName(m, "areas", bad, { rect: [0, 0, 100, 100], seats: [[10, 10]] })), bad).toEqual({ ok: false, error: `areas.${bad}: a name of letters, digits, _ or - (not an inherited one)` });
      expect(PK.checkSkinPack(withName(m, "characters", bad, { idle: m.characters.default.idle })), bad).toEqual({ ok: false, error: `characters.${bad}: a name of letters, digits, _ or - (not an inherited one)` });
    }
    expect(PK.checkSkinPack(JSON.parse(JSON.stringify({ ...m, byInstance: { NAME_HERE: "fox" } }).replace('"NAME_HERE"', '"__proto__"')))).toEqual({ ok: false, error: "byInstance.__proto__: an instance's name (not an inherited one)" });
  });
  it("lookups are of a pack's own names: a state or language named like Object.prototype's falls back as an unknown one does", () => {
    const base = pack();
    expect([Z.zoneOf(base, "constructor"), Z.zoneOf(base, "toString"), Z.zoneOf(base, "working")]).toEqual(["lounge", "lounge", "desks"]);
    const defaults = { working: ["On it."] };
    expect([Z.linesFor("constructor", "en", base, defaults), Z.linesFor("working", "toString", base, defaults)]).toEqual([[], ["On it."]]);
    const L = Z.zonesLayout(base, [{ name: "x", state: "constructor", i: { name: "x" } }]);
    expect(L.seats.get("x").area).toBe("lounge");
  });
  it("overrides naming an inherited area or item: a refusal, never a TypeError; a declared area (control) is put on", () => {
    const base = pack();
    for (const bad of ["constructor", "toString", "__proto__"]) {
      const seats = JSON.parse(`{"pack":"clinic-sample","seats":{${JSON.stringify(bad)}:[[0,0]]}}`);
      expect(PK.checkLayoutOverrides(seats), bad).toEqual({ ok: false, error: `overrides.seats.${bad}: an area's name` });
      expect(PK.applyOverrides(base, seats), bad).toEqual({ ok: false, error: `overrides.seats.${bad}: an area the pack defines` });   // made by hand, never checked
      const furniture = JSON.parse(`{"pack":"clinic-sample","furniture":{${JSON.stringify(bad)}:[1,1]}}`);
      expect(PK.checkLayoutOverrides(furniture), bad).toEqual({ ok: false, error: `overrides.furniture.${bad}: an item's id` });
      expect(PK.applyOverrides(base, furniture), bad).toEqual({ ok: false, error: `overrides.furniture.${bad}: an item the pack has` });
      expect(LY.moveHandle(base, `seat:${bad}:0`, 1, 1)).toBe(base);
    }
    const nap = PK.applyOverrides(base, { pack: "clinic-sample", seats: { nap: [[936, 572], [1018, 572], [1100, 600]] } });
    expect([nap.ok, nap.pack.areas.nap.seats[2]]).toEqual([true, { x: 1100, y: 600 }]);
  });
});

describe("review: an uploaded character is hit where it is drawn", () => {
  const imgs = (...srcs: string[]) => new Map(srcs.map((s) => [s, { width: 1 }]));
  const desk = (name: string, seat: { x: number; y: number }) => ({ key: `zone/${name}`, node: { name, state: "idle" }, x: seat.x - 24, y: seat.y - 52, w: 48, h: 66, seat });
  const look = (name: string, pose = "idle") => ({ name, pose, state: "idle", dim: false });
  it("the clinic fox: its box is the strip's (64×96 from seat.x − 32, seat.y − 88); its head hits as its body does — the fixed box alone missed it", () => {
    const sk = K.spriteSkin(pack(), imgs("fox_idle.png"));
    const d = desk("quill", { x: 212, y: 240 });
    const box = (dd: any, at: any) => sk.charBox(look(dd.node.name), at);
    expect(sk.charBox(look("quill"), { x: 212, y: 240 })).toEqual({ x: 180, y: 152, w: 64, h: 96 });
    expect(Z.personAt([d], 196, 168, () => null, box)).toBe(d);
    expect(Z.personAt([d], 196, 168, () => null)).toBeNull();                               // the old fixed 48×66 box
    expect(Z.personAt([d], 212, 230, () => null, box)).toBe(d);
  });
  it("a large sprite (64×128 px at scale 2: 128×256), where it walks now, the nearest first; a picture not loaded is the built-in box", () => {
    const m = { ...MANIFEST(), characters: { default: { idle: { src: "big.png", frames: 1, w: 64, h: 128, ax: 32, ay: 124 } } } };
    const sk = K.spriteSkin(PK.skinPackOk(m), imgs("big.png"));
    const a = desk("a", { x: 600, y: 400 }), b = desk("b", { x: 620, y: 420 });
    const box = (dd: any, at: any) => sk.charBox(look(dd.node.name), at);
    expect(sk.charBox(look("a"), { x: 600, y: 400 })).toEqual({ x: 536, y: 152, w: 128, h: 256 });
    expect(Z.personAt([a], 600, 160, () => null, box)).toBe(a);                              // its head, 240 above its feet
    expect(Z.personAt([b, a], 610, 380, () => null, box)).toBe(b);                           // both cover it: b is nearer (drawn last)
    const walking = (dd: any) => (dd === a ? { x: 300, y: 400, walking: true, heading: { dx: -1, dy: 0 } } : null);
    expect(Z.personAt([a], 300, 200, walking, box)).toBe(a);                                 // where it walks, not its seat
    expect(Z.personAt([a], 600, 160, walking, box)).toBeNull();
    expect(K.spriteSkin(PK.skinPackOk(m), new Map()).charBox(look("a"), { x: 600, y: 400 })).toEqual({ x: 576, y: 348, w: 48, h: 66 });
  });
});

describe("format v1: a strip's displayed size, and walking four ways", () => {
  const imgs = (...srcs: string[]) => new Map(srcs.map((s) => [s, { width: 1 }]));
  const look = (name: string, pose = "idle", heading: any = undefined) => ({ name, pose, state: "idle", dim: false, ...(heading ? { heading } : {}) });
  const fakeCtx = () => {
    const calls: any[] = [];
    return { calls, imageSmoothingEnabled: true, globalAlpha: 1, save() {}, restore() {}, translate: (x: number, y: number) => calls.push(["translate", x, y]),
      scale: (x: number, y: number) => calls.push(["scale", x, y]), drawImage: (...a: any[]) => calls.push(["drawImage", ...a.slice(1)]) };
  };
  it("dw/dh: the displayed size in logical units, apart from the image's; one keeps the aspect; none is w·scale × h·scale; checked", () => {
    const st = (x: any, scale = 2) => { const r = PK.checkStrip({ src: "a.png", frames: 1, w: 120, h: 120, ...x }, "s", scale); return [r.dw, r.dh]; };
    expect([st({}), st({}, 1), st({ dw: 96, dh: 96 }), st({ dw: 60 }), st({ dh: 90.5 })]).toEqual([[240, 240], [120, 120], [96, 96], [60, 60], [90.5, 90.5]]);
    expect(PK.checkStrip({ src: "a.png", frames: 1, w: 30, h: 60, dh: 90 }, "s").dw).toBe(45);
    const m = MANIFEST(), idle = m.characters.default.idle;
    const refused = (x: any) => PK.checkSkinPack({ ...m, characters: { default: { idle: { ...idle, ...x } } } });
    expect(refused({ dw: 0 })).toEqual({ ok: false, error: "characters.default.idle.dw: a number from 1 to 1280" });
    expect(refused({ dh: 721 })).toEqual({ ok: false, error: "characters.default.idle.dh: a number from 1 to 720" });
    expect(refused({ dw: "96" })).toEqual({ ok: false, error: "characters.default.idle.dw: a number from 1 to 1280" });
    expect(refused({ size: 1 })).toEqual({ ok: false, error: 'characters.default.idle: unknown key "size"' });
  });
  it("drawn at its displayed size, unsmoothed, the anchor scaled with it: 120×120 art shown 96×96; furniture and its box too", () => {
    const m = { ...MANIFEST(), characters: { default: { idle: { src: "big.png", frames: 2, w: 120, h: 120, ax: 60, ay: 110, dw: 96, dh: 96 } } },
      furniture: [{ id: "lamp", sprite: { src: "lamp.png", frames: 1, w: 20, h: 40, dw: 30 }, x: 100, y: 200 }] };
    const sk = K.spriteSkin(PK.skinPackOk(m), imgs("big.png", "lamp.png"));
    const ctx = fakeCtx();
    sk.drawCharacter(ctx, { seat: { x: 500, y: 400 } }, look("a"), 0, {});
    expect(ctx.calls).toEqual([["drawImage", 0, 0, 120, 120, 452, 312, 96, 96]]);             // 500 − 60·0.8, 400 − 110·0.8
    expect(ctx.imageSmoothingEnabled).toBe(false);
    expect(sk.charBox(look("a"), { x: 500, y: 400 })).toEqual({ x: 452, y: 312, w: 96, h: 96 });
    const fc = fakeCtx();
    sk.drawFurniture(fc, sk.pack.furniture[0], false, 0, {});
    expect(fc.calls).toEqual([["drawImage", 0, 0, 20, 40, 85, 140, 30, 60]]);               // 30 wide keeps 20×40's aspect: 60 high
  });
  it("walking: the step's main axis picks walkDown / walkUp / walkSide, side mirrored moving left; a missing one is walk (never mirrored), then idle", () => {
    const S = (src: string) => ({ src, frames: 1, w: 10, h: 20, ax: 2, ay: 20, dw: 10, dh: 20 });
    const full = { idle: S("i"), walk: S("w"), walkDown: S("d"), walkUp: S("u"), walkSide: S("s") };
    const pick = (set: any, h: any, pose = "walk") => { const r = PK.poseStrip(set, pose, h); return r && [r.strip.src, r.mirror]; };
    expect([pick(full, { dx: 1, dy: 5 }), pick(full, { dx: 1, dy: -5 }), pick(full, { dx: 5, dy: 1 }), pick(full, { dx: -5, dy: 1 }), pick(full, { dx: -3, dy: 3 })])
      .toEqual([["d", false], ["u", false], ["s", false], ["s", true], ["s", true]]);         // a tie is side
    const walkOnly = { idle: S("i"), walk: S("w") };
    expect([pick(walkOnly, { dx: 0, dy: 4 }), pick(walkOnly, { dx: -4, dy: 0 }), pick({ idle: S("i") }, { dx: 4, dy: 0 }), pick(full, null), pick(full, { dx: 0, dy: 0 })])
      .toEqual([["w", false], ["w", false], ["i", false], ["w", false], ["w", false]]);
    expect([pick({ idle: S("i"), walkDown: S("d") }, { dx: 9, dy: 1 }), pick(full, { dx: 0, dy: 9 }, "working"), pick(full, null, "constructor"), PK.poseStrip(null, "idle")])
      .toEqual([["i", false], ["i", false], ["i", false], null]);
    // As the host checks them: the three are poses; any other name is not.
    const m = MANIFEST(), idle = m.characters.default.idle;
    expect(PK.checkSkinPack({ ...m, characters: { default: { idle, walkDown: idle, walkUp: idle, walkSide: idle } } }).ok).toBe(true);
    expect(PK.checkSkinPack({ ...m, characters: { default: { idle, walkLeft: idle } } })).toEqual({ ok: false, error: 'characters.default: unknown key "walkLeft"' });
  });
  it("the walker's heading is its current step; the side strip is drawn mirrored about its anchor moving left, and hit there", () => {
    expect([Z.headingAt([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }], 0.1), Z.headingAt([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }], 0.9), Z.headingAt([{ x: 1, y: 1 }], 0.5)])
      .toEqual([{ dx: 10, dy: 0 }, { dx: 0, dy: 30 }, null]);
    const w = Z.createWalkers(), g = { waypoints: [], edges: [] };
    w.sync(new Map([["x", { x: 100, y: 100 }]]), 0, g);
    w.sync(new Map([["x", { x: 100, y: 500 }]]), 1000, g);
    expect(w.at("x", 1500)).toMatchObject({ walking: true, heading: { dx: 0, dy: 400 } });
    const strip = { src: "s.png", frames: 1, w: 32, h: 48, ax: 10, ay: 44 };
    const m = { ...MANIFEST(), characters: { default: { idle: { ...strip, src: "i.png" }, walkSide: strip } } };
    const sk = K.spriteSkin(PK.skinPackOk(m), imgs("i.png", "s.png"));
    const ctx = fakeCtx();
    sk.drawCharacter(ctx, { seat: { x: 300, y: 300 } }, look("a", "walk", { dx: -2, dy: 1 }), 0, {});
    // Mirrored about the anchor: from 300 − (32 − 10)·2 = 256 to 320.
    expect(ctx.calls).toEqual([["translate", 320, 212], ["scale", -1, 1], ["drawImage", 0, 0, 32, 48, 0, 0, 64, 96]]);
    expect(sk.charBox(look("a"), { x: 300, y: 300, walking: true, heading: { dx: -2, dy: 1 } })).toEqual({ x: 256, y: 212, w: 64, h: 96 });
    expect(sk.charBox(look("a"), { x: 300, y: 300, walking: true, heading: { dx: 2, dy: 1 } })).toEqual({ x: 280, y: 212, w: 64, h: 96 });
    const right = fakeCtx();
    sk.drawCharacter(right, { seat: { x: 300, y: 300 } }, look("a", "walk", { dx: 2, dy: 1 }), 0, {});
    expect(right.calls).toEqual([["drawImage", 0, 0, 32, 48, 280, 212, 64, 96]]);
  });
});
