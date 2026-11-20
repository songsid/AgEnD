/**
 * M-3445 (#4266 / #4267): Office drag an Agent to another seat + "being dragged" state.
 * - #4266: seatDropTargets / findSeatDropTarget restrict drops to legal seats in the character's current area,
 *   respect #2691 seat reservations (`for`, `lend`, owner priority), applySeatDrop swaps cleanly and clears stale
 *   prefs, store.seats/saveSeats persist per office+style with validation & LRU cap, assignSeats/zonesLayout honor
 *   saved seatPrefs across reloads, state round-trips, and night mode, and clampDropForArea honors stayInArea
 *   across normal and straight graphs.
 * - #4267: checkSkinPack accepts optional `characters.<set>.dragged` (single-sheet, multi-sheet, frame-list),
 *   packSceneImages/packStrips collect it, packSkin.drawCharacter plays custom `dragged` strip or built-in lifted
 *   dangle when omitted, built-in vector drawCharacter renders `dragged` pose, reduced motion (ms <= 0 and
 *   playAllowed still: true) produces zero sway and disables drag play, and drawPart renders lifted dragged pose
 *   on top and returns to prior pose on release.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage, Pack: any, Play: any, Zones: any, Store: any, Skin: any, Office: any;

function makePack(extra: Record<string, unknown> = {}) {
  const res = Pack.checkSkinPack({
    format: 1,
    id: "drag-test",
    scale: 2,
    background: "bg.png",
    areas: {
      desks: {
        rect: [40, 80, 560, 320],
        seats: [[120, 200], [260, 200], [400, 200], [120, 320], [260, 320]],
      },
      lounge: {
        rect: [660, 80, 560, 320],
        seats: [[740, 200], [880, 200], [1020, 200]],
      },
      nap: {
        rect: [660, 440, 560, 240],
        seats: [[760, 540], [920, 540]],
      },
    },
    stateZones: { working: "desks", idle: "lounge", paused: "nap", default: "lounge" },
    door: [620, 680],
    waypoints: [
      { id: "d1", x: 120, y: 240 },
      { id: "d2", x: 260, y: 240 },
      { id: "d3", x: 400, y: 240 },
      { id: "h", x: 620, y: 240 },
      { id: "l1", x: 740, y: 240 },
      { id: "l2", x: 880, y: 240 },
    ],
    edges: [["d1", "d2"], ["d2", "d3"], ["d3", "h"], ["h", "l1"], ["l1", "l2"]],
    characters: {
      default: {
        idle: { src: "idle.png", frames: 2, w: 16, h: 24, fps: 4 },
        working: { src: "work.png", frames: 2, w: 16, h: 24, fps: 4 },
        walk: { src: "walk.png", frames: 2, w: 16, h: 24, fps: 6 },
      },
    },
    ...extra,
  });
  if (!res.ok) throw new Error(`makePack failed: ${res.at} ${res.why}`);
  return res.pack;
}

function mockCtx() {
  const ops: Array<{ op: string; args: unknown[] }> = [];
  const ctx: Record<string, any> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    imageSmoothingEnabled: true,
    save: () => ops.push({ op: "save", args: [] }),
    restore: () => ops.push({ op: "restore", args: [] }),
    translate: (...args: unknown[]) => ops.push({ op: "translate", args }),
    rotate: (...args: unknown[]) => ops.push({ op: "rotate", args }),
    scale: (...args: unknown[]) => ops.push({ op: "scale", args }),
    setTransform: (...args: unknown[]) => ops.push({ op: "setTransform", args }),
    setLineDash: (...args: unknown[]) => ops.push({ op: "setLineDash", args }),
    beginPath: () => ops.push({ op: "beginPath", args: [] }),
    ellipse: (...args: unknown[]) => ops.push({ op: "ellipse", args }),
    arc: (...args: unknown[]) => ops.push({ op: "arc", args }),
    moveTo: (...args: unknown[]) => ops.push({ op: "moveTo", args }),
    lineTo: (...args: unknown[]) => ops.push({ op: "lineTo", args }),
    closePath: () => {},
    fill: () => ops.push({ op: "fill", args: [] }),
    stroke: () => ops.push({ op: "stroke", args: [] }),
    fillRect: (...args: unknown[]) => ops.push({ op: "fillRect", args }),
    strokeRect: (...args: unknown[]) => ops.push({ op: "strokeRect", args }),
    fillText: (...args: unknown[]) => ops.push({ op: "fillText", args }),
    measureText: (s: string) => ({ width: String(s).length * 6 }),
    drawImage: (...args: unknown[]) => ops.push({ op: "drawImage", args }),
  };
  return { ctx, ops };
}

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  Pack = await import("/ui/js/fleet-office-pack.js");
  Play = await import("/ui/js/fleet-office-play.js");
  Zones = await import("/ui/js/fleet-office-zones.js");
  Store = await import("/ui/js/fleet-office-store.js");
  Skin = await import("/ui/js/fleet-office-skin.js");
  Office = await import("/ui/js/fleet-office.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

describe("#4266 seat drag targets & #2691 reservations", () => {
  it("lists only legal seats in the character's current area and ignores other areas", () => {
    const pack = makePack();
    const nodes = [
      { name: "alpha", state: "working", label: "Alpha" },
      { name: "beta", state: "working", label: "Beta" },
      { name: "gamma", state: "idle", label: "Gamma" },
    ];
    const L = Zones.zonesLayout(pack, nodes);
    const desks = L.rooms[0].desks;
    const targets = Play.seatDropTargets(pack, desks, "alpha");
    expect(targets.every((t: any) => t.area === "desks")).toBe(true);
    expect(targets.map((t: any) => t.slot)).toEqual([0, 1, 2, 3, 4]);
    expect(targets[0].current).toBe(true);
    expect(targets[1].occupant).toBe("beta");
    expect(targets[2].occupant).toBeNull();
    // Point near lounge seat (740, 200) must NOT match for alpha (who is in desks).
    expect(Play.findSeatDropTarget(pack, desks, "alpha", { x: 740, y: 200 })).toBeNull();
    // Point near desks slot 2 (400, 200) matches cleanly.
    const hit = Play.findSeatDropTarget(pack, desks, "alpha", { x: 408, y: 205 });
    expect(hit).toMatchObject({ area: "desks", slot: 2, current: false, occupant: null });
  });

  it("respects #2691 seat reservations: non-owners cannot drop on private seats or evict owners on lent seats", () => {
    const pack = makePack({
      areas: {
        desks: {
          rect: [40, 80, 560, 320],
          seats: [
            { x: 120, y: 200, for: ["boss"], lend: false },
            { x: 260, y: 200, for: ["lead"], lend: true },
            { x: 400, y: 200, for: ["awayOwner"], lend: true },
            [120, 320],
            [260, 320],
          ],
        },
        lounge: { rect: [660, 80, 560, 320], seats: [[740, 200]] },
        nap: { rect: [660, 440, 560, 240], seats: [[760, 540]] },
      },
    });
    const nodes = [
      { name: "boss", state: "working", label: "Boss" },
      { name: "lead", state: "working", label: "Lead" },
      { name: "alpha", state: "working", label: "Alpha" },
      { name: "beta", state: "working", label: "Beta" },
    ];
    const L = Zones.zonesLayout(pack, nodes);
    const desks = L.rooms[0].desks;
    // Alpha cannot drop on slot 0 (private boss seat) or slot 1 (lent seat currently held by owner `lead`),
    // CAN drop on slot 2 (lent seat whose owner is away), slot 3 (own plain), slot 4 (beta's plain).
    const alphaSlots = Play.seatDropTargets(pack, desks, "alpha").map((t: any) => t.slot);
    expect(alphaSlots).toEqual([2, 3, 4]);
    // Boss owns only slot 0 (which is theirs): cannot drop onto plain seats that assignSeats would immediately bounce back.
    const bossSlots = Play.seatDropTargets(pack, desks, "boss").map((t: any) => t.slot);
    expect(bossSlots).toEqual([0]);
  });

  it("allows an owner with multiple reserved seats to switch between them and persists the choice", () => {
    const pack = makePack({
      areas: {
        desks: {
          rect: [40, 80, 560, 320],
          seats: [
            { x: 120, y: 200, for: ["boss"], lend: false },
            { x: 260, y: 200, for: ["boss"], lend: false },
            [400, 200],
          ],
        },
        lounge: { rect: [660, 80, 560, 320], seats: [[740, 200]] },
        nap: { rect: [660, 440, 560, 240], seats: [[760, 540]] },
      },
    });
    const nodes = [{ name: "boss", state: "working", label: "Boss" }];
    const L1 = Zones.zonesLayout(pack, nodes);
    const targets = Play.seatDropTargets(pack, L1.rooms[0].desks, "boss");
    expect(targets.map((t: any) => t.slot)).toEqual([0, 1]);
    const res = Play.applySeatDrop({ pack, desks: L1.rooms[0].desks, seats: L1.seats, prefs: {}, name: "boss", target: targets[1] });
    // Simulated reload: empty prev map, only persisted seatPrefs.
    const L2 = Zones.zonesLayout(pack, nodes, new Map(), { seatPrefs: res.prefs });
    expect(L2.seats.get("boss").slot).toBe(1);
  });
});

describe("#4266 applySeatDrop, persistence across reload/state/night, and stayInArea", () => {
  it("moves to an empty seat, swaps cleanly on an occupied seat, and persists across reload and state round-trip", () => {
    const pack = makePack();
    const nodes = [
      { name: "alpha", state: "working", label: "Alpha" },
      { name: "beta", state: "working", label: "Beta" },
    ];
    const L1 = Zones.zonesLayout(pack, nodes);
    expect(L1.seats.get("alpha").slot).toBe(0);
    expect(L1.seats.get("beta").slot).toBe(1);

    // Move alpha from slot 0 to empty slot 4.
    const target4 = Play.findSeatDropTarget(pack, L1.rooms[0].desks, "alpha", { x: 260, y: 320 });
    expect(target4).toMatchObject({ slot: 4, occupant: null });
    const moved = Play.applySeatDrop({ pack, desks: L1.rooms[0].desks, seats: L1.seats, prefs: {}, name: "alpha", target: target4 });
    expect(moved.swapped).toBeNull();
    expect(moved.prefs).toEqual({ alpha: { desks: 4 } });

    // Simulated reload with empty live seats map: alpha stays at slot 4 and keeps working.
    const L2 = Zones.zonesLayout(pack, nodes, new Map(), { seatPrefs: moved.prefs });
    expect(L2.seats.get("alpha").slot).toBe(4);
    expect(L2.seats.get("beta").slot).toBe(0);

    // State round-trip: alpha goes idle (lounge), then returns to working (desks) -> remembers slot 4!
    const Lidle = Zones.zonesLayout(pack, [{ name: "alpha", state: "idle", label: "Alpha" }, nodes[1]], L2.seats, { seatPrefs: moved.prefs });
    expect(Lidle.seats.get("alpha").area).toBe("lounge");
    const Lback = Zones.zonesLayout(pack, nodes, Lidle.seats, { seatPrefs: moved.prefs });
    expect(Lback.seats.get("alpha")).toMatchObject({ area: "desks", slot: 4 });

    // Swap alpha (slot 4) onto beta (slot 0).
    const targetBeta = Play.findSeatDropTarget(pack, Lback.rooms[0].desks, "alpha", { x: 120, y: 200 });
    expect(targetBeta).toMatchObject({ slot: 0, occupant: "beta" });
    const swapped = Play.applySeatDrop({ pack, desks: Lback.rooms[0].desks, seats: Lback.seats, prefs: moved.prefs, name: "alpha", target: targetBeta });
    expect(swapped.swapped).toMatchObject({ name: "beta", slot: 4 });
    const L3 = Zones.zonesLayout(pack, nodes, new Map(), { seatPrefs: swapped.prefs });
    expect(L3.seats.get("alpha").slot).toBe(0);
    expect(L3.seats.get("beta").slot).toBe(4);
  });

  it("persists night-mode bed choices independently of daytime lounge seats", () => {
    const pack = makePack();
    const nodes = [{ name: "gamma", state: "idle", label: "Gamma" }];
    const Lnight = Zones.zonesLayout(pack, nodes, new Map(), { night: true });
    expect(Lnight.seats.get("gamma")).toMatchObject({ area: "nap", slot: 0 });
    const bed1 = Play.findSeatDropTarget(pack, Lnight.rooms[0].desks, "gamma", { x: 920, y: 540 });
    const moved = Play.applySeatDrop({ pack, desks: Lnight.rooms[0].desks, seats: Lnight.seats, prefs: { gamma: { lounge: 2 } }, name: "gamma", target: bed1 });
    expect(moved.prefs).toEqual({ gamma: { lounge: 2, nap: 1 } });
    const Lnight2 = Zones.zonesLayout(pack, nodes, new Map(), { night: true, seatPrefs: moved.prefs });
    expect(Lnight2.seats.get("gamma")).toMatchObject({ area: "nap", slot: 1 });
    const Lday = Zones.zonesLayout(pack, nodes, new Map(), { night: false, seatPrefs: moved.prefs });
    expect(Lday.seats.get("gamma")).toMatchObject({ area: "lounge", slot: 2 });
  });

  it("store.seats / saveSeats persist in localStorage, sanitize bad data, and enforce office LRU cap", () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    };
    const st = Store.createOfficeStore({ storage });
    expect(st.seats("auto@cozy")).toEqual({});
    st.saveSeats("auto@cozy", { alpha: { desks: 3, bad: -1, huge: 999 }, __proto__: { desks: 1 } });
    expect(st.seats("auto@cozy")).toEqual({ alpha: { desks: 3 } });
    // Empty save cleans the entry cleanly.
    st.saveSeats("auto@cozy", {});
    expect(st.seats("auto@cozy")).toEqual({});
    // LRU cap: saving 35 keys retains the 32 most recent.
    for (let i = 0; i < 35; i++) st.saveSeats(`office-${i}@cozy`, { alpha: { desks: i % 5 } });
    expect(st.seats("office-0@cozy")).toEqual({});
    expect(st.seats("office-34@cozy")).toEqual({ alpha: { desks: 4 } });
  });

  it("clampDropForArea keeps empty-floor drops inside the agent's own area when stayInArea is enabled (normal & straight)", () => {
    for (const straight of [false, true]) {
      const pack = makePack({ straight });
      const seat = { x: 120, y: 200 };
      const graph = { areas: pack.areas, waypoints: pack.waypoints, edges: pack.edges, straight };
      // Drop inside another area (lounge): clamped back into desks rect with an in-area route.
      const landed = Play.clampDropForArea({ x: 880, y: 220 }, seat, graph, "desks");
      const r = pack.areas.desks.rect;
      expect(landed.x).toBeGreaterThanOrEqual(r.x);
      expect(landed.x).toBeLessThanOrEqual(r.x + r.w);
      expect(landed.y).toBeGreaterThanOrEqual(r.y);
      expect(landed.y).toBeLessThanOrEqual(r.y + r.h);
      expect(Zones.routeStaysInArea(landed, seat, graph, "desks", null)).toBe(true);
      // Drop inside own area with valid in-area walk: kept as-is.
      const inside = Play.clampDropForArea({ x: 200, y: 260 }, seat, graph, "desks");
      expect(inside).toEqual({ x: 200, y: 260 });
    }
  });
});

describe("#4267 being-dragged state, optional pack strip, default motion, and reduced motion", () => {
  it("checkSkinPack accepts optional characters.<set>.dragged (single, multi-sheet, frame-list) and collects its images", () => {
    const single = makePack({
      characters: {
        default: {
          idle: { src: "idle.png", frames: 2, w: 16, h: 24, fps: 4 },
          dragged: { src: "dragged.png", frames: 4, w: 16, h: 24, fps: 8 },
        },
        fox: {
          idle: { src: "fox_idle.png", frames: 2, w: 16, h: 24, fps: 4 },
          dragged: { src: ["fox_drag_a.png", "fox_drag_b.png"], frames: 4, w: 16, h: 24, fps: 8 },
        },
        cat: {
          idle: { src: "cat_idle.png", frames: 2, w: 16, h: 24, fps: 4 },
          dragged: { frames: [{ src: "cat_d0.png", ms: 120 }, { src: "cat_d1.png", ms: 180 }], w: 16, h: 24 },
        },
      },
    });
    expect(single.characters.default.dragged.frames).toBe(4);
    expect(single.characters.fox.dragged.sheets).toHaveLength(2);
    expect(single.characters.cat.dragged.durations).toEqual([120, 180]);
    const imgs = Pack.packSceneImages(single);
    expect(imgs).toContain("dragged.png");
    expect(imgs).toContain("fox_drag_a.png");
    expect(imgs).toContain("fox_drag_b.png");
    expect(imgs).toContain("cat_d0.png");
    expect(imgs).toContain("cat_d1.png");
    // Packs without `dragged` remain valid and unchanged.
    const plain = makePack();
    expect(plain.characters.default.dragged).toBeUndefined();
  });

  it("packSkin uses custom dragged strip when present, built-in lifted dangle when omitted, and zero sway at ms = 0", () => {
    const fakeImg = (name: string) => ({ complete: true, naturalWidth: 64, naturalHeight: 24, __name: name });
    const withCustom = makePack({
      characters: {
        default: {
          idle: { src: "idle.png", frames: 2, w: 16, h: 24, fps: 4 },
          dragged: { src: "dragged.png", frames: 4, w: 16, h: 24, fps: 8 },
        },
      },
    });
    const imgsCustom = new Map([["bg.png", fakeImg("bg")], ["idle.png", fakeImg("idle")], ["dragged.png", fakeImg("dragged")]]);
    const skCustom = Skin.spriteSkin(withCustom, imgsCustom);
    expect(skCustom.draggedStrip("alpha")).toBeTruthy();

    const m1 = mockCtx();
    const desk = { x: 100, y: 150, w: 88, h: 53, seat: { x: 144, y: 203 } };
    const look = { name: "alpha", pose: "dragged", basePose: "working", coat: "#4cc38a", free: true };
    skCustom.drawCharacter(m1.ctx, desk, look, 250, { pal: Skin.DEFAULT_PAL, mode: "dark", labels: {} });
    // Custom dragged strip draws `dragged.png` directly with a floor shadow and no forced procedural rotate.
    expect(m1.ops.some((o) => o.op === "drawImage" && (o.args[0] as any)?.__name === "dragged")).toBe(true);
    expect(m1.ops.some((o) => o.op === "ellipse")).toBe(true);
    expect(m1.ops.some((o) => o.op === "rotate")).toBe(false);

    // Without custom `dragged`: plays built-in lifted dangle (rotates when ms > 0, zero rotate when ms = 0).
    const plain = makePack();
    const imgsPlain = new Map([["bg.png", fakeImg("bg")], ["idle.png", fakeImg("idle")], ["work.png", fakeImg("work")]]);
    const skPlain = Skin.spriteSkin(plain, imgsPlain);
    expect(skPlain.draggedStrip("alpha")).toBeNull();

    const mLive = mockCtx();
    skPlain.drawCharacter(mLive.ctx, desk, look, 175, { pal: Skin.DEFAULT_PAL, mode: "dark", labels: {} });
    expect(mLive.ops.some((o) => o.op === "drawImage" && (o.args[0] as any)?.__name === "work")).toBe(true);
    expect(mLive.ops.some((o) => o.op === "rotate")).toBe(true);
    expect(mLive.ops.some((o) => o.op === "ellipse")).toBe(true);

    const mStill = mockCtx();
    skPlain.drawCharacter(mStill.ctx, desk, look, 0, { pal: Skin.DEFAULT_PAL, mode: "dark", labels: {} });
    expect(mStill.ops.some((o) => o.op === "drawImage" && (o.args[0] as any)?.__name === "work")).toBe(true);
    expect(mStill.ops.some((o) => o.op === "rotate")).toBe(false);

    // Built-in vector drawCharacter (`pixelSkin`/`studioSkin`) also supports `dragged` with reduced-motion respect.
    const vLive = mockCtx();
    Skin.pixelSkin.drawCharacter(vLive.ctx, desk, look, 175, { pal: Skin.DEFAULT_PAL, mode: "dark", labels: {} });
    expect(vLive.ops.some((o) => o.op === "rotate")).toBe(true);
    expect(vLive.ops.some((o) => o.op === "ellipse")).toBe(true);

    const vStill = mockCtx();
    Skin.pixelSkin.drawCharacter(vStill.ctx, desk, look, 0, { pal: Skin.DEFAULT_PAL, mode: "dark", labels: {} });
    expect(vStill.ops.some((o) => o.op === "rotate")).toBe(false);

    // draggedMotion helper invariants & playAllowed reduced-motion guard.
    expect(Skin.draggedMotion(0)).toEqual({ lift: 10, tilt: 0 });
    expect(Math.abs(Skin.draggedMotion(175).tilt)).toBeGreaterThan(0.05);
    expect(Play.playAllowed({ on: true, still: true, zones: true, overview: false, layout: false, shared: false })).toBe(false);
  });

  it("drawPart renders held character in dragged pose, draws floor rings, and returns to prior pose on release", () => {
    const pack = makePack();
    const nodes = [
      { name: "alpha", state: "working", label: "Alpha" },
      { name: "beta", state: "working", label: "Beta" },
    ];
    const L = Zones.zonesLayout(pack, nodes);
    const walkers = Zones.createWalkers();
    walkers.sync(new Map(L.rooms[0].desks.map((d: any) => [d.node.name, d.seat])), 0, L, true);
    const hold = Play.createHold();
    const drawnPoses: Array<{ name: string; pose: string }> = [];
    const spySkin = {
      ...Skin.skinFor("studio"),
      pack,
      drawCharacter(ctx: any, d: any, look: any, ms: number, env: any) {
        drawnPoses.push({ name: look.name, pose: look.pose });
        Skin.pixelSkin.drawCharacter(ctx, d, look, ms, env);
      },
    };
    const looks = new Map(L.rooms[0].desks.map((d: any) => [d.key, { name: d.node.name, label: d.node.label, state: d.node.state, pose: d.node.state, coat: "#4cc38a", free: true }]));
    const seatDropRef = { current: null as any };
    const part = {
      L, zones: true, skin: spySkin, looks, walkers,
      flights: { frame: () => [], size: () => 0 },
      desks: L.rooms[0].desks,
      layers: { ls: 1, tagsOff: false, back: null, front: null },
      hold, seatDrop: seatDropRef, lang: "en",
    };
    const env = { pal: Skin.DEFAULT_PAL, mode: "dark", labels: { areas: {} } };

    // Pick up alpha and hold over slot 2.
    hold.down(1, "mouse", 120, 200, 100, "alpha", 0, 0);
    hold.move(1, 400, 200, 150, 50, 0);
    walkers.place("alpha", { x: 400, y: 200 });
    seatDropRef.current = {
      name: "alpha",
      targets: Play.seatDropTargets(pack, L.rooms[0].desks, "alpha"),
      hover: Play.findSeatDropTarget(pack, L.rooms[0].desks, "alpha", { x: 400, y: 200 }),
    };

    const mHeld = mockCtx();
    const moving = Office.drawPart(mHeld.ctx, part, 1, 0, 0, 200, false, null, env);
    expect(moving).toBe(true);
    expect(drawnPoses.find((x) => x.name === "alpha")?.pose).toBe("dragged");
    expect(drawnPoses.find((x) => x.name === "beta")?.pose).toBe("working");
    // Held character is drawn AFTER other characters so it lifts cleanly on top.
    expect(drawnPoses[drawnPoses.length - 1].name).toBe("alpha");

    // Release -> returns immediately to prior `working` pose.
    hold.up(1);
    seatDropRef.current = null;
    drawnPoses.length = 0;
    const mAfter = mockCtx();
    Office.drawPart(mAfter.ctx, part, 1, 0, 0, 250, false, null, env);
    expect(drawnPoses.find((x) => x.name === "alpha")?.pose).toBe("working");
  });

  it("clears stale target-slot prefs for absent agents and cancels active snack races on pickup", () => {
    const pack = makePack();
    const nodes = [
      { name: "beta", state: "idle", label: "Beta" },
      { name: "alpha", state: "working", label: "Alpha" },
    ];
    // Beta previously preferred desks slot 3 while idle.
    const initPrefs = { beta: { desks: 3 } };
    const L1 = Zones.zonesLayout(pack, nodes, new Map(), { seatPrefs: initPrefs });
    const target3 = Play.findSeatDropTarget(pack, L1.rooms[0].desks, "alpha", { x: 120, y: 320 });
    expect(target3).toMatchObject({ slot: 3, occupant: null });
    const res = Play.applySeatDrop({ pack, desks: L1.rooms[0].desks, seats: L1.seats, prefs: initPrefs, name: "alpha", target: target3 });
    // Stale beta desks:3 preference was cleared so beta returning to working (even ahead of alpha in nodes) does not steal slot 3.
    expect(res.prefs.beta).toBeUndefined();
    const L2 = Zones.zonesLayout(pack, [
      { name: "beta", state: "working", label: "Beta" },
      { name: "alpha", state: "working", label: "Alpha" },
    ], new Map(), { seatPrefs: res.prefs });
    expect(L2.seats.get("alpha").slot).toBe(3);
    expect(L2.seats.get("beta").slot).toBe(0);

    // Overflow character dragging onto an occupied seat displaces occupant cleanly without crashing.
    const crowdedPack = makePack({
      areas: {
        desks: { rect: [40, 80, 560, 320], seats: [[120, 200]] },
        lounge: { rect: [660, 80, 560, 320], seats: [[740, 200]] },
        nap: { rect: [660, 440, 560, 240], seats: [[760, 540]] },
      },
    });
    const Lc = Zones.zonesLayout(crowdedPack, [
      { name: "alpha", state: "working", label: "Alpha" },
      { name: "gamma", state: "working", label: "Gamma" },
    ]);
    expect(Lc.seats.get("gamma").slot).toBeLessThan(0);
    const t0 = Play.findSeatDropTarget(crowdedPack, Lc.rooms[0].desks, "gamma", { x: 120, y: 200 });
    expect(t0).toMatchObject({ slot: 0, occupant: "alpha" });
    const displaced = Play.applySeatDrop({ pack: crowdedPack, desks: Lc.rooms[0].desks, seats: Lc.seats, prefs: {}, name: "gamma", target: t0 });
    expect(displaced.swapped).toBeNull();
    const Lc2 = Zones.zonesLayout(crowdedPack, [
      { name: "alpha", state: "working", label: "Alpha" },
      { name: "gamma", state: "working", label: "Gamma" },
    ], displaced.seats, { seatPrefs: displaced.prefs });
    expect(Lc2.seats.get("gamma").slot).toBe(0);
    expect(Lc2.seats.get("alpha").slot).toBeLessThan(0);

    // snacks.cancel stops active eating & placed-snack race for picked-up character.
    const snacks = Play.createSnacks();
    snacks.feed("alpha", { id: "cookie" }, { x: 120, y: 200, t: 100 });
    expect(snacks.eatingOf("alpha", 200)).toBeTruthy();
    snacks.cancel("alpha");
    expect(snacks.eatingOf("alpha", 200)).toBeNull();
  });
});
