import { describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import { checkSkinUpload } from "../src/web-office-skins.js";
import {
  SNACK_LIMITS,
  checkSkinPack,
  packImages,
  packStrips,
  snackLabel,
  stripDurationMs,
} from "../src/ui/fleet-office-pack.js";
// @ts-expect-error JS UI modules do not ship .d.ts files
import { SNACK, createSnackDrag, createSnacks, eatDurationMs, racerSpeedMult, scatterWords } from "../src/ui/fleet-office-play.js";
// @ts-expect-error JS UI modules do not ship .d.ts files
import { DEFAULT_PAL, drawBadge, spriteSkin, tagBox, tagFootprint } from "../src/ui/fleet-office-skin.js";
// @ts-expect-error JS UI modules do not ship .d.ts files
import { WALK, createWalkers, routeStaysInArea } from "../src/ui/fleet-office-zones.js";

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const body = Buffer.concat([head.subarray(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, tail]);
}
function makePng(width: number, height: number): string {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

function baseManifest(extra: Record<string, unknown> = {}) {
  return {
    format: 1,
    id: "snack-pack",
    scale: 2,
    background: "bg.png",
    areas: {
      desks: { rect: [40, 80, 560, 440], seats: [[160, 240], [320, 240]] },
      lounge: { rect: [640, 80, 600, 440], seats: [[760, 240], [900, 240], [1040, 240], [1140, 240], [820, 360]] },
    },
    stateZones: { working: "desks", idle: "lounge", default: "lounge" },
    characters: {
      default: {
        idle: { src: "idle.png", frames: 2, w: 16, h: 24, fps: 4 },
        working: { src: "work.png", frames: 2, w: 16, h: 24, fps: 4 },
        eat: { src: "eat.png", frames: 4, w: 16, h: 24, fps: 8, once: true },
      },
    },
    ...extra,
  };
}

function fakeCtx() {
  const calls: Array<[string, unknown[]]> = [];
  const g: any = {
    imageSmoothingEnabled: true,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    globalAlpha: 1,
    save: () => calls.push(["save", []]),
    restore: () => calls.push(["restore", []]),
    translate: (...a: unknown[]) => calls.push(["translate", a]),
    scale: (...a: unknown[]) => calls.push(["scale", a]),
    rotate: (...a: unknown[]) => calls.push(["rotate", a]),
    fillRect: (...a: unknown[]) => calls.push(["fillRect", a]),
    strokeRect: (...a: unknown[]) => calls.push(["strokeRect", a]),
    fillText: (...a: unknown[]) => calls.push(["fillText", a]),
    drawImage: (...a: unknown[]) => calls.push(["drawImage", a]),
    measureText: (s: string) => ({ width: s.length * 6 }),
    calls,
  };
  return g;
}

describe("M-3432 (#4255) pack schema & validation", () => {
  it("accepts optional snacks and characters.<set>.eat while keeping packs without snacks unchanged", () => {
    const plain = checkSkinPack(baseManifest());
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.pack.snacks).toBeUndefined();
    expect(plain.pack.characters.default!.eat).toBeDefined();

    const withSnacks = checkSkinPack(baseManifest({
      snacks: [
        {
          id: "cookie",
          label: { en: "Cookie", "zh-TW": "餅乾" },
          sprite: { src: "snacks/cookie.png", frames: 1, w: 16, h: 16, dw: 28, dh: 28 },
          eat: { src: "snacks/cookie_eat.png", frames: 4, w: 16, h: 16, fps: 6, once: true },
          radius: 300,
        },
        {
          id: "pudding",
          label: "Pudding",
          sprite: { src: ["snacks/p1.png", "snacks/p2.png"], frames: [2, 2], w: 16, h: 16, fps: 4 },
        },
        {
          id: "cake",
          sprite: { src: "snacks/cake.png", frames: 1, w: 16, h: 16 },
        },
      ],
    }));
    expect(withSnacks.ok).toBe(true);
    if (!withSnacks.ok) return;
    expect(withSnacks.pack.snacks).toHaveLength(3);
    expect(withSnacks.pack.snacks![0]!.radius).toBe(300);
    expect(withSnacks.pack.snacks![1]!.radius).toBe(SNACK_LIMITS.defaultRadius);
    expect(snackLabel(withSnacks.pack.snacks![0], "zh-TW")).toBe("餅乾");
    expect(snackLabel(withSnacks.pack.snacks![0], "en")).toBe("Cookie");
    expect(snackLabel(withSnacks.pack.snacks![1], "zh-TW")).toBe("Pudding");
    expect(snackLabel(withSnacks.pack.snacks![2], "en")).toBe("cake");

    const stripPaths = packStrips(withSnacks.pack).map((s) => s.at);
    expect(stripPaths).toContain("characters.default.eat");
    expect(stripPaths).toContain("snacks.cookie.sprite");
    expect(stripPaths).toContain("snacks.cookie.eat");
    expect(stripPaths).toContain("snacks.pudding.sprite");

    const imgs = packImages(withSnacks.pack);
    expect(imgs).toEqual(expect.arrayContaining([
      "eat.png", "snacks/cookie.png", "snacks/cookie_eat.png", "snacks/p1.png", "snacks/p2.png", "snacks/cake.png",
    ]));
  });

  it("refuses invalid snack manifests (empty, >12, duplicate/inherited id, bad radius, bad label)", () => {
    const sprite = { src: "snacks/a.png", frames: 1, w: 16, h: 16 };
    expect(checkSkinPack(baseManifest({ snacks: [] })).ok).toBe(false);
    expect(checkSkinPack(baseManifest({
      snacks: Array.from({ length: SNACK_LIMITS.max + 1 }, (_, i) => ({ id: `s${i}`, sprite })),
    })).ok).toBe(false);
    expect(checkSkinPack(baseManifest({
      snacks: [{ id: "dup", sprite }, { id: "dup", sprite }],
    })).ok).toBe(false);
    expect(checkSkinPack(baseManifest({
      snacks: [{ id: "constructor", sprite }],
    })).ok).toBe(false);
    expect(checkSkinPack(baseManifest({
      snacks: [{ id: "a", sprite, radius: 59 }],
    })).ok).toBe(false);
    expect(checkSkinPack(baseManifest({
      snacks: [{ id: "a", sprite, radius: 1281 }],
    })).ok).toBe(false);
    expect(checkSkinPack(baseManifest({
      snacks: [{ id: "a", sprite, label: "" }],
    })).ok).toBe(false);
    expect(checkSkinPack(baseManifest({
      snacks: [{ id: "a", sprite, label: {} }],
    })).ok).toBe(false);
    expect(checkSkinPack(baseManifest({
      snacks: [{ id: "a", sprite, extra: true }],
    })).ok).toBe(false);
  });

  it("validates snack and eat strip PNG dimensions on server upload", () => {
    const manifest = baseManifest({
      snacks: [{
        id: "cookie",
        sprite: { src: "snacks/cookie.png", frames: 2, w: 16, h: 16 },
        eat: { src: "snacks/cookie_eat.png", frames: 4, w: 16, h: 16, fps: 8, once: true },
      }],
    });
    const okFiles = {
      "bg.png": makePng(64, 36),
      "idle.png": makePng(32, 24),
      "work.png": makePng(32, 24),
      "eat.png": makePng(64, 24),
      "snacks/cookie.png": makePng(32, 16),
      "snacks/cookie_eat.png": makePng(64, 16),
    };
    const ok = checkSkinUpload({ manifest, files: okFiles }, "admin", 1000);
    expect(ok.ok).toBe(true);

    const bad = checkSkinUpload({
      manifest,
      files: { ...okFiles, "snacks/cookie_eat.png": makePng(48, 16) },
    }, "admin", 1000);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("skin_strip_dimensions");
  });

  it("computes stripDurationMs and clamped eatDurationMs", () => {
    expect(stripDurationMs({ src: "a.png", frames: 12, w: 16, h: 16, fps: 6, ax: 8, ay: 16, dw: 16, dh: 16 })).toBe(2000);
    expect(stripDurationMs({ src: "a.png", frames: 3, w: 16, h: 16, fps: 4, durations: [100, 200, 300], ax: 8, ay: 16, dw: 16, dh: 16 })).toBe(600);
    expect(eatDurationMs(null, null)).toBe(SNACK.EAT_DEFAULT_MS);
    expect(eatDurationMs({ frames: 2, fps: 10 }, null)).toBe(SNACK.EAT_MIN_MS); // 200ms clamped to 800ms
    expect(eatDurationMs({ frames: 300, fps: 10 }, null)).toBe(SNACK.EAT_MAX_MS); // 30s clamped to 10s
  });
});

describe("M-3432 (#4255) snack feeding, placing, racing & limits", () => {
  const areas = {
    desks: { name: "desks", rect: { x: 40, y: 80, w: 560, h: 440 }, seats: [] },
    lounge: { name: "lounge", rect: { x: 640, y: 80, w: 600, h: 440 }, seats: [] },
  };
  const mkDesk = (name: string, state: string, area: string, x: number, y: number, night = false) => ({
    key: `zone/${name}`,
    node: { name, state },
    area,
    night,
    seat: { x, y },
  });
  const cookie = { id: "cookie", radius: 260, sprite: { frames: 1, fps: 0 }, eat: { frames: 4, fps: 4 } };

  it("direct feed puts character in eating state and cancels any active race", () => {
    const mgr = createSnacks();
    const desks = [mkDesk("beta", "idle", "lounge", 800, 260)];
    mgr.place(cookie, { x: 840, y: 260 }, 1000, { desks, areas });
    expect(mgr.placedList()[0]!.racers).toEqual(["beta"]);

    const { durationMs } = mgr.feed("beta", cookie, { x: 800, y: 260, t: 1200, charEatStrip: { frames: 16, fps: 8 } });
    expect(durationMs).toBe(2000);
    expect(mgr.eatingOf("beta", 1500)).toMatchObject({ snackId: "cookie", x: 800, y: 260 });
    expect(mgr.eatingOf("beta", 3200)).toBeNull();
    expect(mgr.placedList()[0]!.racers).toEqual([]);
  });

  it("placed snack attracts only eligible idle characters, capped at MAX_RACERS = 4, and ignores asleep/working/hidden/out-of-radius", () => {
    const mgr = createSnacks();
    const desks = [
      mkDesk("work1", "working", "lounge", 810, 260),
      mkDesk("nap1", "paused", "lounge", 815, 260),
      mkDesk("bed1", "idle", "lounge", 820, 260, true),
      mkDesk("hid1", "idle", "lounge", 825, 260),
      mkDesk("far1", "idle", "lounge", 1200, 260),
      mkDesk("i1", "idle", "lounge", 830, 260),
      mkDesk("i2", "idle", "lounge", 840, 260),
      mkDesk("i3", "idle", "lounge", 850, 260),
      mkDesk("i4", "idle", "lounge", 860, 260),
      mkDesk("i5", "idle", "lounge", 920, 260),
    ];
    const item = mgr.place(cookie, { x: 800, y: 260 }, 1000, {
      desks,
      areas,
      hidden: new Map([["hid1", "tent"]]),
    });
    expect(item!.racers).toHaveLength(SNACK.MAX_RACERS);
    expect(item!.racers).not.toContain("work1");
    expect(item!.racers).not.toContain("nap1");
    expect(item!.racers).not.toContain("bed1");
    expect(item!.racers).not.toContain("hid1");
    expect(item!.racers).not.toContain("far1");
    expect(item!.racers).not.toContain("i5");
  });

  it("honors stayInArea (ownArea) when recruiting racers — validates full outbound/return route, not only endpoints", () => {
    const mgr = createSnacks();
    const desks = [
      mkDesk("in-lounge", "idle", "lounge", 680, 260),
      mkDesk("in-desks", "idle", "desks", 560, 260),
    ];
    const item = mgr.place(cookie, { x: 660, y: 260 }, 1000, { desks, areas, ownArea: true });
    expect(item!.racers).toEqual(["in-lounge"]);

    // Dropped in corridor outside every area attracts nobody when ownArea is true.
    const corridor = mgr.place(cookie, { x: 620, y: 260 }, 1100, { desks, areas, ownArea: true });
    expect(corridor!.racers).toEqual([]);

    // Negative control (Prism P2): both endpoints inside lounge, but only waypoint route cuts through foreign area `desks`.
    const foreignGraph = {
      areas,
      waypoints: [
        { id: "l1", x: 660, y: 160 },
        { id: "d1", x: 520, y: 260 }, // inside desks [40..600, 80..520]
        { id: "l2", x: 660, y: 360 },
      ],
      edges: [["l1", "d1"], ["d1", "l2"]],
      straight: false,
    };
    const loungeDesks = [mkDesk("beta", "idle", "lounge", 660, 160)];
    expect(routeStaysInArea({ x: 660, y: 160 }, { x: 660, y: 360 }, foreignGraph, "lounge")).toBe(false);
    expect(routeStaysInArea({ x: 660, y: 160 }, { x: 660, y: 360 }, { ...foreignGraph, straight: true }, "lounge")).toBe(false);
    const blocked = createSnacks().place(cookie, { x: 660, y: 360 }, 1200, { desks: loungeDesks, areas, ownArea: true, graph: foreignGraph });
    expect(blocked!.racers).toEqual([]);

    // Positive control (Prism P2): both endpoints inside lounge, waypoint route uses unassigned corridor [600..640] without entering desks.
    const corridorGraph = {
      areas,
      waypoints: [
        { id: "l1", x: 660, y: 160 },
        { id: "c1", x: 620, y: 260 }, // corridor outside both desks (x<=600) and lounge (x>=640)
        { id: "l2", x: 660, y: 360 },
      ],
      edges: [["l1", "c1"], ["c1", "l2"]],
      straight: true,
    };
    expect(routeStaysInArea({ x: 660, y: 160 }, { x: 660, y: 360 }, corridorGraph, "lounge")).toBe(true);
    const allowed = createSnacks().place(cookie, { x: 660, y: 360 }, 1300, { desks: loungeDesks, areas, ownArea: true, graph: corridorGraph });
    expect(allowed!.racers).toEqual(["beta"]);
  });

  it("createSnackDrag detaches all global listeners and blocks commits when context retires mid-drag (Prism P2)", () => {
    const listeners = new Map<string, Set<(ev: any) => void>>();
    const totalListeners = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
    const fakeWin = {
      addEventListener(type: string, fn: (ev: any) => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener(type: string, fn: (ev: any) => void) {
        listeners.get(type)?.delete(fn);
      },
      dispatch(type: string, ev: any) {
        for (const fn of [...(listeners.get(type) || [])]) fn(ev);
      },
    };
    const ctrl = createSnackDrag(fakeWin);
    const onCommit = vi.fn();
    const onCancel = vi.fn();

    ctrl.start({
      pid: 7, sx: 10, sy: 10, slop: 4,
      onMove: () => ({ kind: "feed", name: "alpha", x: 100, y: 100 }),
      onCommit,
      onCancel,
    });
    expect(totalListeners()).toBe(4);
    fakeWin.dispatch("pointermove", { pointerId: 7, clientX: 50, clientY: 50, preventDefault() {} });

    // Context retires mid-drag (play disabled, office/skin changed, or unmount).
    ctrl.retire();
    expect(totalListeners()).toBe(0);
    expect(ctrl.active()).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Subsequent release must NOT commit a feed/place/Tell.
    fakeWin.dispatch("pointerup", { pointerId: 7 });
    expect(onCommit).not.toHaveBeenCalled();

    // Starting a new drag replaces any active drag without leaking listeners.
    const onCancel1 = vi.fn(), onCommit2 = vi.fn();
    ctrl.start({ pid: 1, sx: 0, sy: 0, slop: 4, onMove: () => ({ kind: "place", x: 10, y: 10 }), onCancel: onCancel1 });
    expect(totalListeners()).toBe(4);
    ctrl.start({ pid: 2, sx: 0, sy: 0, slop: 4, onMove: () => ({ kind: "place", x: 20, y: 20 }), onCommit: onCommit2 });
    expect(totalListeners()).toBe(4);
    expect(onCancel1).toHaveBeenCalledTimes(1);
    fakeWin.dispatch("pointermove", { pointerId: 2, clientX: 30, clientY: 30, preventDefault() {} });
    fakeWin.dispatch("pointerup", { pointerId: 2 });
    expect(totalListeners()).toBe(0);
    expect(onCommit2).toHaveBeenCalledWith({ kind: "place", x: 20, y: 20 });
  });

  it("first racer to reach CLAIM_DIST claims and eats while losers scatter; enforces MAX_PLACED = 6 and TTL_MS = 30s", () => {
    const mgr = createSnacks();
    const desks = [
      mkDesk("beta", "idle", "lounge", 810, 260),
      mkDesk("gamma", "idle", "lounge", 900, 260),
    ];
    const pos = new Map([
      ["beta", { x: 810, y: 260, walking: false }],
      ["gamma", { x: 900, y: 260, walking: false }],
    ]);
    const walkers = { at: (n: string) => pos.get(n) || null };
    const snacksById = new Map([["cookie", cookie]]);
    const onClaim = vi.fn();

    mgr.place(cookie, { x: 850, y: 260 }, 1000, { desks, walkers, areas });
    expect(mgr.targets(1000).get("beta")?.speed).toBeCloseTo(WALK.SPEED * racerSpeedMult("beta", "sn-1"), 5);

    // Move beta within CLAIM_DIST (18) of (850, 260); gamma is still far.
    pos.set("beta", { x: 840, y: 260, walking: true });
    pos.set("gamma", { x: 880, y: 260, walking: true });
    const changed = mgr.step(1400, { desks, walkers, areas, snacksById, onClaim });
    expect(changed).toBe(true);
    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(onClaim.mock.calls[0]![0]).toBe("beta");
    expect(mgr.placedList()).toHaveLength(0);
    expect(mgr.eatingOf("beta", 1500)).not.toBeNull();
    expect(mgr.scatterOf("gamma", 1500)).not.toBeNull();
    expect(scatterWords("en")).toBe("Too slow!");
    expect(scatterWords("zh-TW")).toBe("被搶先了！");

    // Cap at MAX_PLACED = 6 and expire after TTL_MS.
    for (let i = 0; i < SNACK.MAX_PLACED + 2; i++) {
      mgr.place(cookie, { x: 200 + i * 20, y: 200 }, 2000 + i * 100, { desks: [], areas });
    }
    expect(mgr.placedList()).toHaveLength(SNACK.MAX_PLACED);
    expect(mgr.placedList()[0]!.t0).toBe(2200);
    mgr.step(2200 + SNACK.TTL_MS + 1000, { desks: [], areas });
    expect(mgr.placedList()).toHaveLength(0);
  });

  it("createWalkers respects per-target speed for racers", () => {
    const walkers = createWalkers();
    const graph = { waypoints: [], edges: [], straight: false };
    walkers.sync(new Map([["slow", { x: 0, y: 0 }], ["fast", { x: 0, y: 0 }]]), 0, graph, false);
    walkers.sync(new Map([
      ["slow", { x: 200, y: 0 }],
      ["fast", { x: 200, y: 0, speed: WALK.SPEED * 1.25 }],
    ]), 100, graph, false);
    const sAt = walkers.at("slow", 600);
    const fAt = walkers.at("fast", 600);
    expect(fAt.x).toBeGreaterThan(sAt.x);
  });
});

describe("M-3432 (#4255) skin rendering & level badge clearance", () => {
  it("resolves eatStrip fallback chain (set.eat -> default.eat -> basePose) and draws snacks", () => {
    const parsed = checkSkinPack(baseManifest({
      characters: {
        default: {
          idle: { src: "idle.png", frames: 2, w: 16, h: 24, fps: 4 },
          eat: { src: "eat_def.png", frames: 2, w: 16, h: 24, fps: 4, once: true },
        },
        chef: {
          idle: { src: "idle.png", frames: 2, w: 16, h: 24, fps: 4 },
          eat: { src: "eat_chef.png", frames: 2, w: 16, h: 24, fps: 4, once: true },
        },
        plain: {
          idle: { src: "idle.png", frames: 2, w: 16, h: 24, fps: 4 },
        },
      },
      byInstance: { alpha: "chef", beta: "plain" },
      snacks: [{ id: "cookie", sprite: { src: "cookie.png", frames: 1, w: 16, h: 16 } }],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const imgs = new Map<string, any>([
      ["idle.png", { tag: "idle" }],
      ["eat_def.png", { tag: "eat_def" }],
      ["eat_chef.png", { tag: "eat_chef" }],
      ["cookie.png", { tag: "cookie" }],
    ]);
    const sk = spriteSkin(parsed.pack, imgs);
    expect(sk.eatStrip("alpha")?.src).toBe("eat_chef.png");
    expect(sk.eatStrip("beta")?.src).toBe("eat_def.png");

    const g = fakeCtx();
    expect(sk.drawSnack(g, parsed.pack.snacks![0]!.sprite, 0, 100, 100, { pal: DEFAULT_PAL })).toBe(true);
    expect(sk.drawSnackIcon(g, parsed.pack.snacks![0]!.sprite, 28)).toBe(true);
    expect(g.calls.filter(([k]: any) => k === "drawImage")).toHaveLength(2);
  });

  it("keeps level badge clear of the first letter on normal name tags (prevents 'Beta' -> 'deta' overlap)", () => {
    const g = fakeCtx();
    const box = tagBox(g, 100, 200, "Beta", false);
    drawBadge(g, box.x, box.y, { text: "0", tier: 0 }, DEFAULT_PAL, false);
    const rectCall = g.calls.find(([k]: any) => k === "fillRect");
    expect(rectCall).toBeDefined();
    const [bx, , bw] = rectCall![1] as [number, number, number, number];
    // Text starts at box.x + 5 (NORMAL.pad = 10 -> 5 px left padding). Badge right edge must stay left of text!
    expect(bx + bw).toBeLessThan(box.x + 5);
    const foot = tagFootprint(g, box, { text: "0", tier: 0 }, false);
    expect(foot.x).toBeLessThanOrEqual(bx);
  });
});
