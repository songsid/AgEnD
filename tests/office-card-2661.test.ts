/**
 * #2661 part 2: the Office levels on the page — tiers and their token colours, the badge's text, titles (the page's, a
 * pack's table, a pinned one that may hide the level), the XP bar, what the host's answer is trusted for, a pack's
 * `levels` checked, the card's content by viewer (dashboard with and without the numbers, a share link, levels off),
 * the badge drawn on a name tag, and a share's pack cut to its people.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { OfficeShareView, type OfficeShareSource } from "../src/office-share.js";

let p: AppPage;
let LV: any, C: any, PK: any, K: any, F: any, VW: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  LV = await import("/ui/js/fleet-office-levels.js");
  C = await import("/ui/js/fleet-office-card.js");
  PK = await import("/ui/js/fleet-office-pack.js");
  K = await import("/ui/js/fleet-office-skin.js");
  F = await import("/ui/js/fleet-office.js");
  VW = await import("/ui/js/fleet-office-view.js");
});
afterAll(() => p.restore());

function fakeCtx() {
  const calls: Array<[string, unknown[]]> = [];
  const t: any = { calls, measureText: (s: string) => ({ width: [...String(s)].length * 5 }) };
  const sets: Array<[string, unknown]> = [];
  t.sets = sets;
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return (...a: unknown[]) => { calls.push([String(k), a]); }; }, set(o, k, v) { sets.push([String(k), v]); o[k] = v; return true; } });
}
const PAL = { surface: "S", surface2: "S2", border: "B", text2: "T2", ok: "OK", okBg: "OKBG", accent: "AC", accentDim: "ACD", warn: "W", warnBg: "WBG", danger: "D", dangerBg: "DBG" };
const lvOf = (v: unknown) => LV.levelsOk(v);

describe("tiers, badges, titles, XP", () => {
  it("tiers start at 10, 20, 35, 50 and 100; each takes the status tokens (no palette of its own)", () => {
    expect([0, 9, 10, 19, 20, 34, 35, 49, 50, 99, 100, 5000].map(LV.tierOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect([0, 1, 2, 3, 4, 5].map((t) => LV.tierColours(t, PAL))).toEqual([
      { bg: "S2", fg: "T2", line: "B" }, { bg: "OKBG", fg: "OK", line: "OK" }, { bg: "ACD", fg: "AC", line: "AC" },
      { bg: "AC", fg: "S", line: "AC" }, { bg: "WBG", fg: "W", line: "W" }, { bg: "DBG", fg: "D", line: "D" }]);
  });
  it("the badge writes up to 999 whole, then 1.1k (rounded down), never wider than four characters", () => {
    expect([0, 7, 999, 1000, 1099, 1150, 9999, 12_345, 999_999].map(LV.badgeText)).toEqual(["0", "7", "999", "1k", "1k", "1.1k", "9.9k", "12k", "999k"]);
  });
  it("titles: the page's by tier; a pack's table from each level up; below its first entry, the page's", () => {
    expect([0, 10, 20, 35, 50, 100].map((l) => LV.titleOf(l))).toEqual(["Novice", "Apprentice", "Adept", "Expert", "Master", "Legend"]);
    const table = [{ from: 5, name: "Intern" }, { from: 40, name: "Lead" }];
    expect([3, 5, 39, 40, 900].map((l) => LV.titleOf(l, table))).toEqual(["Novice", "Intern", "Intern", "Lead", "Lead"]);
  });
  it("XP: the work still needed for the next level, and how far along this one is", () => {
    expect(LV.xpOf(50, 250_000_000, 100_000)).toEqual({ next: 51, toNext: 10_100_000, pct: 0 });
    expect(LV.xpOf(1, 250_000, 100_000)).toEqual({ next: 2, toNext: 150_000, pct: 0.5 });
    expect(LV.tokens(950)).toBe("950");
    expect(LV.tokens(12_345)).toBe("12.3K");
    expect(LV.tokens(260_000_000)).toBe("260M");
    expect(LV.tokens(1_234_000_000)).toBe("1.2B");
  });
  it("the host's answer: off or odd is no levels; numbers kept only when it said detail and they are sane", () => {
    expect(lvOf(null).enabled).toBe(false);
    expect(lvOf({ enabled: false, levels: { a: { level: 3 } } }).levels.size).toBe(0);
    const v = lvOf({ enabled: true, unit: 100_000, detail: true, levels: {
      a: { level: 3, workTokens: 1_000_000, estimated: true, today: { workTokens: 5, requests: 1 }, firstSeen: "2026-01-02" },
      b: { level: -1 }, c: { level: 2.5 }, d: { level: 4, workTokens: -1, today: { workTokens: 0, requests: 0 } }, e: { level: 1, workTokens: 9, today: { workTokens: 1, requests: 1 }, firstSeen: "x" } } });
    expect([...v.levels.keys()]).toEqual(["a", "d", "e"]);
    expect(v.levels.get("a")).toEqual({ level: 3, workTokens: 1_000_000, estimated: true, today: { workTokens: 5, requests: 1 }, firstSeen: "2026-01-02" });
    expect(v.levels.get("d")).toEqual({ level: 4 });
    expect(v.levels.get("e").firstSeen).toBeNull();
    expect(lvOf({ enabled: true, detail: false, levels: { a: { level: 3, workTokens: 9, today: { workTokens: 1, requests: 1 } } } }).levels.get("a")).toEqual({ level: 3 });
  });
  it("a name tag's badge: the level and tier; a pinned title that hides it: a mark; off, or nobody: none", () => {
    const lv = lvOf({ enabled: true, levels: { a: { level: 120 }, b: { level: 3 } } });
    const levels = { fixed: { b: { title: "Founder", hideLevel: true }, npc: { title: "Barista", hideLevel: false } } };
    expect(LV.badgeOf("a", lv, null)).toEqual({ text: "120", tier: 5 });
    expect(LV.badgeOf("b", lv, levels)).toEqual({ mark: true, tier: 0 });
    expect(LV.badgeOf("c", lv, levels)).toBeNull();
    expect(LV.badgeOf("a", lvOf({ enabled: false }), levels)).toBeNull();
    expect(LV.badgeOf("b", lvOf({ enabled: false }), levels)).toBeNull();     // off removes the badges, the marks too
    expect(LV.fixedOf("constructor", levels)).toBeNull();
  });
});

describe("a pack's levels", () => {
  const base = () => ({ format: 1, id: "lvpack", characters: { default: { idle: { src: "i.png", frames: 1, w: 8, h: 8 } } } });
  const check = (levels: unknown) => PK.checkSkinPack({ ...base(), levels });
  it("titles rising from 0–100000 and pinned titles are kept; none: no key", () => {
    const r = check({ titles: [{ from: 1, name: " Intern " }, { from: 50, name: "Boss" }], fixed: { atlas: { title: "Founder", hideLevel: true }, npc1: { title: "Barista" } } });
    expect(r.ok).toBe(true);
    expect(r.pack.levels).toEqual({ titles: [{ from: 1, name: "Intern" }, { from: 50, name: "Boss" }], fixed: { atlas: { title: "Founder", hideLevel: true }, npc1: { title: "Barista", hideLevel: false } } });
    expect("levels" in PK.checkSkinPack(base()).pack).toBe(false);
  });
  it("refused with where: an unknown key, a title not rising, too long, an inherited name, hideLevel not a boolean, too many", () => {
    expect(check({ colours: {} }).error).toBe('levels: unknown key "colours"');
    expect(check({ titles: [{ from: 5, name: "A" }, { from: 5, name: "B" }] }).error).toBe("levels.titles[1].from: higher than the title before it");
    expect(check({ titles: [{ from: 1, name: "x".repeat(25) }] }).error).toBe("levels.titles[0].name: 1–24 characters");
    expect(check({ titles: [{ from: 100001, name: "A" }] }).error).toBe("levels.titles[0].from: a whole number from 0 to 100000");
    expect(check({ fixed: { constructor: { title: "A" } } }).error).toBe("levels.fixed.constructor: an instance's name (not an inherited one)");
    expect(check({ fixed: { a: { title: "A", hideLevel: "yes" } } }).error).toBe("levels.fixed.a.hideLevel: true or false");
    expect(check({ fixed: { a: { title: "A\nB" } } }).error).toBe("levels.fixed.a.title: 1–24 characters");
    expect(check({ titles: Array.from({ length: 33 }, (_, i) => ({ from: i, name: "t" })) }).error).toBe("levels.titles: at most 32");
  });
});

describe("the card's content", () => {
  const node = (o: Record<string, unknown> = {}) => ({ name: "quill", state: "working", i: { name: "quill", display_name: "Quill", backend: "claude-code", model: "claude-opus-5-5", ...o } });
  const full = () => lvOf({ enabled: true, unit: 100_000, detail: true, levels: { quill: { level: 50, workTokens: 250_000_000, estimated: false, today: { workTokens: 12_300, requests: 45 }, firstSeen: "2026-01-01" } } });
  const base = { state: "Working", now: "Typing away", where: "Eng · Work" };
  it("the dashboard with the numbers: two XP lines over the bar; model and backend as two rows; today and first seen", () => {
    const m = C.cardModel({ ...base, node: node(), lv: full(), levels: null });
    expect([m.name, m.instance, m.stateLine]).toEqual(["Quill", "quill", "Working · Master"]);
    expect(m.level).toEqual({ line1: "Lv 50 · 250M work tokens", line2: "10.1M to Lv 51", pct: 0, next: 51, estimated: false });
    expect(m.rows.map((r: string[]) => r[0])).toEqual(["Office", "Model", "Backend", "Today", "First seen"]);
    expect(m.rows[1][1]).toBe("claude-opus-5-5");
    expect(m.rows[2][1]).toBe("Claude Code");
    expect(m.rows[3][1]).toBe("12.3K work tokens · 45 requests");
    expect(m.rows[4][1]).toMatch(/^Day \d+$/);
    expect(m.badge).toEqual({ text: "50", tier: 4 });
  });
  it("without the numbers (the usage report not served here): the level alone, no today or first seen", () => {
    const m = C.cardModel({ ...base, node: node(), lv: lvOf({ enabled: true, levels: { quill: { level: 50 } } }), levels: null });
    expect(m.level).toEqual({ line1: "Lv 50", line2: null, pct: null, next: null, estimated: false });
    expect(m.rows.map((r: string[]) => r[0])).toEqual(["Office", "Model", "Backend"]);
  });
  it("a share link: name, title, state and office only — no model, backend or numbers, whatever was read", () => {
    const m = C.cardModel({ ...base, node: node(), lv: full(), levels: null, share: true });
    expect(m.rows).toEqual([["Office", "Eng · Work"]]);
    expect(m.level).toEqual({ line1: "Lv 50", line2: null, pct: null, next: null, estimated: false });
    expect(m.stateLine).toBe("Working · Master");
  });
  it("a pinned title: shown whatever the level; with hideLevel no Lv and no bar, the badge a mark; a pack's table names the rest", () => {
    const pinned = C.cardModel({ ...base, node: node(), lv: full(), levels: { fixed: { quill: { title: "Founder", hideLevel: true } } } });
    expect([pinned.stateLine, pinned.level, pinned.badge]).toEqual(["Working · Founder", null, { mark: true, tier: 0 }]);
    const shown = C.cardModel({ ...base, node: node(), lv: full(), levels: { fixed: { quill: { title: "Founder", hideLevel: false } } } });
    expect([shown.stateLine, shown.level.line1]).toEqual(["Working · Founder", "Lv 50 · 250M work tokens"]);
    expect(C.cardModel({ ...base, node: node(), lv: full(), levels: { titles: [{ from: 40, name: "Lead" }] } }).stateLine).toBe("Working · Lead");
  });
  it("levels off: no title, no level rows, no badge (a pinned title too); estimated work says so", () => {
    const off = C.cardModel({ ...base, node: node(), lv: lvOf({ enabled: false }), levels: { fixed: { quill: { title: "Founder", hideLevel: true } } } });
    expect([off.stateLine, off.level, off.badge]).toEqual(["Working", null, null]);
    const est = lvOf({ enabled: true, unit: 100_000, detail: true, levels: { quill: { level: 2, workTokens: 400_000, estimated: true, today: { workTokens: 0, requests: 0 }, firstSeen: null } } });
    const m = C.cardModel({ ...base, node: node(), lv: est, levels: null });
    expect(m.level.estimated).toBe(true);
    expect(m.rows.map((r: string[]) => r[0])).toEqual(["Office", "Model", "Backend", "Today"]);   // no first seen: none recorded
  });
  it("first seen counts that day as day 1", () => {
    expect(C.dayOf("2026-10-27", new Date(2026, 9, 27, 12).getTime())).toBe(1);
    expect(C.dayOf("2026-10-01", new Date(2026, 9, 27, 12).getTime())).toBe(27);
    expect(C.dayOf("nope")).toBeNull();
  });
});

describe("the badge on a name tag", () => {
  it("drawn at the tag's top-left corner in its tier's colours; a mark is a small diamond with no text; none: nothing", () => {
    const g = fakeCtx();
    K.drawBadge(g, 100, 50, { text: "50", tier: 4 }, PAL);
    expect(g.calls.filter(([k]: any) => k === "fillText").map(([, a]: any) => a[0])).toEqual(["50"]);
    expect(g.sets.filter(([k]: any) => k === "fillStyle").map(([, v]: any) => v)).toEqual(["S", "WBG", "W"]);
    const m = fakeCtx();
    K.drawBadge(m, 100, 50, { mark: true, tier: 0 }, PAL);
    expect(m.calls.some(([k]: any) => k === "fillText")).toBe(false);
    expect(m.calls.some(([k]: any) => k === "rotate")).toBe(true);
    const n = fakeCtx();
    K.drawBadge(n, 0, 0, null, PAL);
    expect(n.calls).toEqual([]);
  });
  it("the zones tag and the desk's name plate carry it; without one, they draw as before", () => {
    const pal = { ...K.DEFAULT_PAL };
    const env: any = { pal, mode: "dark", labels: { lobby: "Lobby", closed: "Closed", areas: {} } };
    const look = (o: Record<string, unknown> = {}) => ({ name: "a", label: "atlas", pose: "idle", light: null, lamp: false, sign: null, coat: "#123456", work: 0, dim: false, match: false, ...o });
    const texts = (g: any) => g.calls.filter(([k]: any) => k === "fillText").map(([, a]: any) => a[0]);
    const tagged = fakeCtx(); K.pixelSkin.drawTag(tagged, 100, 100, look({ badge: { text: "7", tier: 0 } }), env);
    expect(texts(tagged)).toEqual(["atlas", "7"]);
    const plain = fakeCtx(); K.pixelSkin.drawTag(plain, 100, 100, look(), env);
    expect(texts(plain)).toEqual(["atlas"]);
    const desk = { key: "T/a", node: { name: "a" }, x: 0, y: 0, w: 96, h: 104, seat: { x: 48, y: 40 } };
    const plate = fakeCtx(); K.pixelSkin.drawDeskFront(plate, desk, look({ badge: { text: "12", tier: 1 } }), env);
    expect(texts(plate)).toEqual(["atlas", "12"]);
    const hidden = fakeCtx(); K.pixelSkin.drawDeskFront(hidden, desk, look({ badge: { text: "12", tier: 1 }, notag: true }), env);
    expect(texts(hidden)).toEqual([]);
  });
});

describe("a level up on Desks (#2761 review)", () => {
  it("the ring over them; only the people in the same room glance over", () => {
    const desk = (key: string, name: string, x: number) => ({ key, node: { name, state: "idle", i: { name } }, x, y: 0, w: 96, h: 104, seat: { x: x + 48, y: 40 } });
    const L = { mode: "desks", width: 600, height: 200, rooms: [
      { key: "Platform", name: "Platform", desks: [desk("P/pixel", "pixel", 0), desk("P/quill", "quill", 100)] },
      { key: "Web", name: "Web", desks: [desk("W/tide", "tide", 400)] }] };
    const looks = new Map(L.rooms.flatMap((r) => r.desks).map((d) => [d.key, { name: d.node.name, label: d.node.name, state: "idle", pose: "idle", light: null, lamp: false, sign: null, coat: "#123456", work: 0, dim: false, match: false }]));
    const skin = { ...K.pixelSkin, drawCharacter: () => {}, drawDeskFront: () => {}, drawBubble: () => {} };
    const part = { ...F.partOf(L, looks, skin, false, null, { frame: () => [], size: () => 0 }), ups: new Map([["pixel", performance.now()]]), levelsOn: true };
    part.layers = { ls: VW.layerScale(1, L.width, L.height), tagsOff: false, back: null, front: null };
    const g = fakeCtx();
    const moving = F.drawPart(g, part, 1, 0, 0, 500, false, null, { pal: { ...K.DEFAULT_PAL }, mode: "dark", labels: { lobby: "Lobby", closed: "Closed", areas: {} } });
    const marks = g.calls.filter(([k, a]: any) => k === "fillText" && a[0] === "!").map(([, a]: any) => a[1]);
    expect(marks).toEqual([100 + 58]);                                      // quill (Platform) glances; tide (Web) does not
    expect(g.calls.some(([k]: any) => k === "arc")).toBe(true);             // the ring over pixel
    expect(moving).toBe(true);                                               // the loop keeps drawing while it shows
  });
});

describe("a share link's pack", () => {
  it("a title pinned on someone not shown leaves with their name; one on a person shown or an NPC stays", () => {
    const src: OfficeShareSource = {
      status: () => ({ instances: [{ name: "dev-a", state: "working" }, { name: "dev-b", state: "idle" }] }),
      org: () => ({ general: ["dev-a", "dev-b"], teams: [] }),
      offices: () => ({ rev: 1, offices: [{ id: "eng", name: "Eng", skin: "lvpack", members: ["dev-a"] }] }),
      acts: () => [], traffic: () => ({ now: "t", items: [] }), needs: () => [], hidden: () => false,
    };
    const v = new OfficeShareView({ office: "eng", text: false }, src);
    const out = v.pack({ manifest: { furniture: [{ id: "barista" }], levels: { titles: [{ from: 1, name: "T" }], fixed: { "dev-a": { title: "A" }, "dev-b": { title: "B" }, barista: { title: "C" } } } } }) as any;
    expect(out.manifest.levels).toEqual({ titles: [{ from: 1, name: "T" }], fixed: { "dev-a": { title: "A" }, barista: { title: "C" } } });
  });
});
