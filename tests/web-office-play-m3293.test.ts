/**
 * M-3293 (#4119, the light version): pick a person up in the Office and drop them anywhere — they walk back to their
 * seat along the usual route — and pat or feed them (hearts over the head, a speech bubble). The viewer's own: no request,
 * no share link, reduced motion off.
 * - createHold: a mouse picks up after SLOP px; a touch only after LONG_MS held still (a finger that moves first pans);
 *   a press that never moves is a click; up() names who was dropped and where.
 * - playAllowed: toggle on, motion allowed, a single zones office of the dashboard itself (no share, no Edit layout).
 * - reactionAt: HEARTS hearts rising and fading over REACT_MS, the words in the page's language; then nothing.
 * - walkers.place + sync: a dropped person walks from the drop point back to their seat along the graph.
 * - the store: "Drag and pat" on by default, per device.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage, P: any, Z: any, S: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  P = await import("/ui/js/fleet-office-play.js");
  Z = await import("/ui/js/fleet-office-zones.js");
  S = await import("/ui/js/fleet-office-store.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

describe("createHold", () => {
  it("mouse: a press that moves SLOP px picks the person up; it carries them; up drops them there", () => {
    const h = P.createHold();
    expect(h.down(1, "mouse", 100, 100, 0, "atlas", 10, 10)).toBe("maybe");
    expect(h.move(1, 101, 100, 5, 12, 10)).toBe("maybe");                 // 2 px: still a click
    expect(h.held()).toBeNull();
    expect(h.move(1, 140, 120, 30, 10 + P.PLAY.SLOP + 1, 10)).toBe("held");
    expect(h.held()).toEqual({ name: "atlas", at: { x: 140, y: 120 } });
    h.move(1, 200, 210, 60, 80, 90);
    expect(h.up(1)).toEqual({ name: "atlas", at: { x: 200, y: 210 } });
    expect(h.state()).toBeNull();
  });
  it("mouse: a press that never moves is a click (up drops nobody)", () => {
    const h = P.createHold();
    h.down(1, "mouse", 100, 100, 0, "atlas");
    expect(h.up(1)).toBeNull();
  });
  it("touch: a finger that moves before LONG_MS pans (never picks up); held still past it picks up", () => {
    const h = P.createHold();
    expect(h.down(7, "touch", 50, 50, 1000, "quill", 0, 0)).toBe("press");
    expect(h.move(7, 50, 60, 1100, 0, P.PLAY.SLOP + 1)).toBe("pan");
    expect(h.move(7, 50, 90, 1600, 0, 40)).toBe("pan");                   // stays a pan past LONG_MS
    expect(h.up(7)).toBeNull();
    expect(h.down(8, "touch", 50, 50, 2000, "quill", 0, 0)).toBe("press");
    expect(h.tick(2000 + P.PLAY.LONG_MS - 1)).toBe("press");
    expect(h.tick(2000 + P.PLAY.LONG_MS)).toBe("held");
    expect(h.move(8, 80, 70, 2600, 30, 20)).toBe("held");
    expect(h.up(8)).toEqual({ name: "quill", at: { x: 80, y: 70 } });
  });
  it("nobody under the pointer: nothing to pick up; another pointer's events are ignored", () => {
    const h = P.createHold();
    expect(h.down(1, "mouse", 0, 0, 0, null)).toBeNull();
    h.down(2, "mouse", 0, 0, 0, "sage", 0, 0);
    expect(h.move(3, 50, 50, 10, 50, 50)).toBeNull();
    expect(h.up(3)).toBeNull();
    expect(h.state()).toBe("maybe");
    h.cancel(); expect(h.state()).toBeNull();
  });
});

describe("playAllowed", () => {
  const ok = { on: true, still: false, zones: true, overview: false, layout: false, shared: false };
  it("on in a single zones office of the dashboard; off for each of the rest", () => {
    expect(P.playAllowed(ok)).toBe(true);
    for (const [k, v] of [["on", false], ["still", true], ["zones", false], ["overview", true], ["layout", true], ["shared", true]] as const)
      expect(P.playAllowed({ ...ok, [k]: v }), k).toBe(false);
  });
});

describe("reactions", () => {
  it("hearts rise and fade over REACT_MS; the words in the page's language; then nothing", () => {
    const r = { kind: "pat", t0: 1000 };
    const a = P.reactionAt(r, 1000 + P.PLAY.REACT_MS * 0.5, "en"), b = P.reactionAt(r, 1000 + P.PLAY.REACT_MS * 0.8, "en");
    expect(a.hearts.length).toBe(P.PLAY.HEARTS);
    expect(a.say).toBe("♪ Thanks!");
    expect(b.hearts[0].dy).toBeLessThan(a.hearts[0].dy);                    // higher (y grows down)
    expect(b.hearts[0].alpha).toBeLessThan(a.hearts[0].alpha);
    expect(P.reactionAt(r, 1000 + P.PLAY.REACT_MS, "en")).toBeNull();
    expect(P.reactionAt(r, 999, "en")).toBeNull();
    expect(P.reactionAt({ kind: "feed", t0: 0 }, 10, "zh-TW").say).toBe("好吃！");
    expect(P.reactionAt({ kind: "pat", t0: 0 }, 10, "fr").say).toBe("♪ Thanks!");
    expect(P.reactionAt({ kind: "poke", t0: 0 }, 10, "en")).toBeNull();
  });
  it("the first heart shows at once, the others follow", () => {
    const early = P.reactionAt({ kind: "feed", t0: 0 }, 1, "en");
    expect(early.hearts.length).toBe(1);
  });
  it("pruneReactions drops the finished ones", () => {
    const m = new Map([["a", { kind: "pat", t0: 0 }], ["b", { kind: "feed", t0: 1500 }]]);
    expect(P.pruneReactions(m, P.PLAY.REACT_MS + 10)).toBe(true);
    expect([...m.keys()]).toEqual(["b"]);
    expect(P.pruneReactions(m, 1500 + P.PLAY.REACT_MS)).toBe(false);
  });
});

describe("a dropped person walks back", () => {
  it("walkers.place sets them down at the drop; the next sync walks them to their seat along the graph", () => {
    const graph = { waypoints: [{ id: "a", x: 300, y: 100 }, { id: "b", x: 300, y: 400 }], edges: [["a", "b"]] };
    const w = Z.createWalkers(), seat = { x: 320, y: 420 };
    w.sync(new Map([["atlas", seat]]), 0, graph);
    w.place("atlas", { x: 290, y: 90 });
    expect(w.at("atlas", 10)).toEqual({ x: 290, y: 90, walking: false });
    w.sync(new Map([["atlas", seat]]), 20, graph);
    const mid = w.at("atlas", 20 + 300);
    expect(mid.walking).toBe(true);
    expect(mid.x).toBeGreaterThanOrEqual(290); expect(mid.y).toBeGreaterThan(90);
    expect(w.at("atlas", 20 + 1e6)).toEqual({ x: 320, y: 420, walking: false });
    // Along the graph: part of the walk is on the a → b corridor (x 300, between them) — the route, not a straight line
    // from the drop to the seat (which never has x 300 below y 100).
    let onCorridor = 0;
    for (let t = 20; t < 20 + 1e5; t += 50) { const q = w.at("atlas", t); if (Math.abs(q.x - 300) < 0.5 && q.y > 150 && q.y < 350) onCorridor++; }
    expect(onCorridor).toBeGreaterThan(3);
  });
});

describe("the store", () => {
  it("Drag and pat: on by default; off is kept per device", () => {
    localStorage.removeItem("agend_org_office_play");
    const s = S.createOfficeStore({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    expect(s.playOn()).toBe(true);
    s.savePlayOn(false);
    expect(localStorage.getItem("agend_org_office_play")).toBe("0");
    expect(s.playOn()).toBe(false);
    s.savePlayOn(true); expect(s.playOn()).toBe(true);
  });
});

describe("never on a share link", () => {
  it("the share page renders the Office with no onOpen and its own talk — the two things the Office reads as a share (no toggle, no Pat/Feed, no drag)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/ui/office-share-page.js", import.meta.url), "utf8");
    const tag = src.slice(src.indexOf("<${Office}"), src.indexOf("/>", src.indexOf("<${Office}")));
    expect(tag).toContain("talk=");
    expect(tag).not.toContain("onOpen=");
    const office = readFileSync(new URL("../src/ui/fleet-office.js", import.meta.url), "utf8");
    expect(office).toContain('const shared = talk !== undefined || typeof onOpen !== "function";');
    expect(office).toMatch(/playAllowed\(\{ on: playOn, still, zones, overview, layout: !!layout, shared \}\)/);
  });
});

describe("a pack's own words for a pat and a feed (bubbles.<lang>.pat / .feed)", () => {
  const STRIP = (src: string) => ({ src, frames: 2, w: 16, h: 16 });
  const M = (extra: any = {}) => ({ format: 1, id: "petpack", background: "bg.png", areas: { lounge: { rect: [0, 0, 600, 360], seats: [[100, 100]] } },
    stateZones: { default: "lounge" }, characters: { default: { idle: STRIP("i.png") } }, ...extra });
  it("taken as any state's lines (≤ 12, 1–40 characters), in the pack's, a set's and an instance's tables; the host checks the same", async () => {
    const PK = await import("/ui/js/fleet-office-pack.js");
    const HPK = await import("../src/ui/fleet-office-pack.js");
    const lines = { en: { pat: ["Hehe~", "That tickles!"], feed: ["Cookie!"] }, "zh-TW": { pat: ["嘿嘿～"] } };
    const c = PK.checkSkinPack(M({ bubbles: lines, bubblesByInstance: { atlas: { en: { feed: ["Mine!"] } } },
      characters: { default: { idle: STRIP("i.png"), bubbles: { en: { pat: ["Set pat"] } } } } }));
    expect(c.ok).toBe(true);
    expect(c.pack.bubbles.en.pat).toEqual(["Hehe~", "That tickles!"]);
    expect(HPK.checkSkinPack(M({ bubbles: lines }))).toEqual(PK.checkSkinPack(M({ bubbles: lines })));
    // Who says what: the instance's own, else their set's, else the pack's (linesFor, as for the states).
    expect(Z.linesFor("feed", "en", c.pack, null, "atlas")).toEqual(["Mine!"]);
    expect(Z.linesFor("pat", "en", c.pack, null, "quill")).toEqual(["Set pat"]);
    expect(Z.linesFor("pat", "zh-TW", c.pack, null, "quill")).toEqual(["嘿嘿～"]);
    expect(Z.linesFor("feed", "zh-TW", c.pack, null, "quill")).toEqual([]);           // none: the page's own words
    expect(PK.checkSkinPack(M({ bubbles: { en: { pat: ["x".repeat(41)] } } }))).toEqual({ ok: false, error: "bubbles.en.pat[0]: 1–40 characters" });
    expect(PK.checkSkinPack(M({ bubbles: { en: { poke: ["x"] } } }))).toEqual({ ok: false, error: "bubbles.en.poke: a state, pat or feed" });
    expect(PK.BUBBLE_KEYS).toEqual([...PK.PACK_STATES, "pat", "feed"]);
  });
});

describe("Tell, per agent on this device", () => {
  it("off by default; on and off per name; a tell posts { instance, kind } to /ui/office-tell", async () => {
    localStorage.removeItem("agend_org_office_tell");
    const posts: any[] = [];
    const s = S.createOfficeStore({ fetch: async (path: string, o: any) => { posts.push({ path, method: o.method, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ queued: true }) }; } });
    expect(s.tellOn("atlas")).toBe(false);
    s.saveTell("atlas", true); s.saveTell("quill", true);
    expect([s.tellOn("atlas"), s.tellOn("quill"), s.tellOn("sage")]).toEqual([true, true, false]);
    s.saveTell("atlas", false);
    expect([s.tellOn("atlas"), s.tellOn("quill")]).toEqual([false, true]);
    expect(await s.tell("quill", "pat")).toEqual({ ok: true, queued: true });
    expect(posts).toEqual([{ path: "/ui/office-tell", method: "POST", body: { instance: "quill", kind: "pat" } }]);
  });
});

describe("a pat's words are never thinned out", () => {
  it("thinBubbles keeps a bubble marked keep in an area over capacity, where an idle person's line is left out", () => {
    const over = new Set(["lounge"]);
    const idle = { key: "a", area: "lounge", state: "idle", shown: 3 }, pat = { key: "b", area: "lounge", state: "idle", shown: 4, keep: true };
    expect(Z.thinBubbles([idle, pat], over).map((x: any) => x.key)).toEqual(["b"]);
    expect(Z.thinBubbles([idle], over)).toEqual([]);
  });
});
