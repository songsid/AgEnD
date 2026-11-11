/**
 * #3681: speech-bubble lines per character set and per instance, not only per pack.
 * - The format: a character set may carry "bubbles" beside its strips (checked as the pack's "bubbles": "en" / "zh-TW",
 *   a state, ≤ 12 lines of 1–40 characters); "bubblesByInstance" maps an instance's name (checked like byInstance's) to
 *   its own lines (≤ 500 names). The checked set stays strips only (packStrips, packImages); the lines are kept as
 *   bubblesBySet / bubblesByInstance, and only when the pack has any — an older pack checks to exactly what it did.
 * - linesFor: a person's own lines, else their set's (byInstance's set, else "default"), else the pack's, else the page's
 *   — by language and state at each step.
 * - The scene: each person's bubble says their own line (fleet-office.js passes the speaker's name).
 * - The host: the upload check (checkSkinUpload, as office_pack_check) accepts them; an Office share link keeps only the
 *   lines of the people it shows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { checkSkinUpload } from "../src/web-office-skins.js";
import { OfficeShareView, type OfficeShareSource } from "../src/office-share.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const b64 = (f: string) => readFileSync(join(FIXTURE, f)).toString("base64");

let p: AppPage;
let PK: any, Z: any, K: any, F: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  PK = await import("/ui/js/fleet-office-pack.js");
  Z = await import("/ui/js/fleet-office-zones.js");
  K = await import("/ui/js/fleet-office-skin.js");
  F = await import("/ui/js/fleet-office.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

/** The clinic fixture with a voice per set and per instance: atlas wears fox; quill has its own lines; sage is plain. */
const voiced = () => {
  const m = MANIFEST();
  m.characters.fox = { ...m.characters.fox, bubbles: { en: { working: ["Fox at work."], needs: ["Fox needs you."] }, "zh-TW": { working: ["狐狸工作中。"] } } };
  m.byInstance = { atlas: "fox" };
  m.bubbles = { en: { working: ["Pack work."], idle: ["Pack idle."], needs: ["Pack needs you."] } };
  m.bubblesByInstance = { quill: { en: { needs: ["Quill needs you."] } } };
  return m;
};
const lines = (n: number, len = 1) => Array.from({ length: n }, (_, i) => `${i}`.padEnd(len, "x"));

describe("the format", () => {
  it("accepted: a set's bubbles and bubblesByInstance, trimmed; the set stays strips only", () => {
    const m = voiced();
    m.bubblesByInstance.quill.en.idle = ["  Ink's dry.  "];
    const c = PK.checkSkinPack(m);
    expect(c.ok).toBe(true);
    expect(c.pack.bubblesBySet).toEqual({ fox: { en: { working: ["Fox at work."], needs: ["Fox needs you."] }, "zh-TW": { working: ["狐狸工作中。"] } } });
    expect(c.pack.bubblesByInstance).toEqual({ quill: { en: { needs: ["Quill needs you."], idle: ["Ink's dry."] } } });
    expect(Object.keys(c.pack.characters.fox)).toEqual(["idle"]);
    expect(PK.packStrips(c.pack).map((s: any) => s.at)).not.toContain("characters.fox.bubbles");
    expect(PK.packImages(c.pack).sort()).toEqual(["fox_idle.png", "office_bg.png"]);
  });

  it("the same limits as the pack's bubbles: ≤ 12 lines a state, 1–40 characters, a state, en or zh-TW", () => {
    const set = (b: unknown) => { const m = MANIFEST(); m.characters.fox = { ...m.characters.fox, bubbles: b }; return PK.checkSkinPack(m); };
    const inst = (b: unknown) => PK.checkSkinPack({ ...MANIFEST(), bubblesByInstance: { atlas: b } });
    expect(set({ en: { working: lines(12, 40) } }).ok).toBe(true);
    expect(set({ en: { working: lines(13) } })).toEqual({ ok: false, error: "characters.fox.bubbles.en.working: at most 12" });
    expect(set({ en: { working: ["x".repeat(41)] } })).toEqual({ ok: false, error: "characters.fox.bubbles.en.working[0]: 1–40 characters" });
    expect(set({ en: { working: ["   "] } })).toEqual({ ok: false, error: "characters.fox.bubbles.en.working[0]: 1–40 characters" });
    expect(set({ en: { working: ["two\nlines"] } })).toEqual({ ok: false, error: "characters.fox.bubbles.en.working[0]: 1–40 characters" });
    expect(set({ en: { dancing: ["x"] } })).toEqual({ ok: false, error: "characters.fox.bubbles.en.dancing: a state" });
    expect(set({ fr: { working: ["x"] } })).toEqual({ ok: false, error: 'characters.fox.bubbles.fr: "en" or "zh-TW"' });
    expect(set(["x"])).toEqual({ ok: false, error: "characters.fox.bubbles: an object" });
    expect(inst({ "zh-TW": { idle: lines(12, 40) } }).ok).toBe(true);
    expect(inst({ en: { idle: lines(13) } })).toEqual({ ok: false, error: "bubblesByInstance.atlas.en.idle: at most 12" });
    expect(inst({ en: { idle: [42] } })).toEqual({ ok: false, error: "bubblesByInstance.atlas.en.idle[0]: 1–40 characters" });
    expect(PK.checkSkinPack({ ...MANIFEST(), bubblesByInstance: [] })).toEqual({ ok: false, error: "bubblesByInstance: an object" });
  });

  it("names: a set's bubbles only on a set the pack defines; an instance's name checked like byInstance's; ≤ 500", () => {
    // A set's lines live inside the set, so they can never name one the pack lacks; a set that is only lines is refused.
    const m = MANIFEST(); m.characters.ghost = { bubbles: { en: { idle: ["Boo."] } } };
    expect(PK.checkSkinPack(m)).toEqual({ ok: false, error: "characters.ghost.idle: required" });
    for (const bad of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(PK.checkSkinPack({ ...MANIFEST(), bubblesByInstance: { [bad]: { en: { idle: ["x"] } } } }), bad)
        .toEqual({ ok: false, error: `bubblesByInstance.${bad}: an instance's name (not an inherited one)` });
    }
    expect(PK.checkSkinPack(JSON.parse(JSON.stringify({ ...MANIFEST(), bubblesByInstance: { NAME_HERE: {} } }).replace('"NAME_HERE"', '"__proto__"'))))
      .toEqual({ ok: false, error: "bubblesByInstance.__proto__: an instance's name (not an inherited one)" });
    expect(PK.checkSkinPack({ ...MANIFEST(), bubblesByInstance: { "": {} } })).toEqual({ ok: false, error: "bubblesByInstance.: an instance's name" });
    expect(PK.checkSkinPack({ ...MANIFEST(), bubblesByInstance: { "a\u0007b": {} } }).ok).toBe(false);
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`agent-${i}`, {}]));
    expect(PK.checkSkinPack({ ...MANIFEST(), bubblesByInstance: many(500) }).ok).toBe(true);
    expect(PK.checkSkinPack({ ...MANIFEST(), bubblesByInstance: many(501) })).toEqual({ ok: false, error: "bubblesByInstance: at most 500" });
    // Unknown keys inside a set are still refused, as before.
    const other = MANIFEST(); other.characters.fox.voice = { en: {} };
    expect(PK.checkSkinPack(other)).toEqual({ ok: false, error: 'characters.fox: unknown key "voice"' });
  });

  it("an older pack checks to exactly what it did: no bubblesBySet / bubblesByInstance keys", () => {
    const m = { ...MANIFEST(), bubbles: { en: { working: ["On it."] } } };
    const c = PK.checkSkinPack(m);
    expect(c.ok).toBe(true);
    expect("bubblesBySet" in c.pack || "bubblesByInstance" in c.pack).toBe(false);
    expect(c.pack.bubbles).toEqual({ en: { working: ["On it."] } });
    expect(Z.linesFor("working", "en", c.pack, { working: ["Page."] }, "atlas")).toEqual(["On it."]);
    expect(Z.linesFor("idle", "en", c.pack, { idle: ["Page idle."] }, "atlas")).toEqual(["Page idle."]);
  });
});

describe("linesFor: theirs → their set's → the pack's → the page's", () => {
  const defaults = { working: ["Page work."], idle: ["Page idle."], needs: ["Page needs."], paused: ["Page zzz."] };
  it("by person, language and state", () => {
    const c = PK.checkSkinPack(voiced()).pack;
    const say = (state: string, name?: string, lang = "en") => Z.linesFor(state, lang, c, defaults, name);
    expect(say("needs", "quill")).toEqual(["Quill needs you."]);        // their own
    expect(say("working", "quill")).toEqual(["Pack work."]);            // quill wears default (no lines): the pack's
    expect(say("needs", "atlas")).toEqual(["Fox needs you."]);          // their set's
    expect(say("idle", "atlas")).toEqual(["Pack idle."]);               // the set has none for idle: the pack's
    expect(say("paused", "atlas")).toEqual(["Page zzz."]);              // nobody has any: the page's
    expect(say("working", "atlas", "zh-TW")).toEqual(["狐狸工作中。"]);   // by language
    expect(say("needs", "atlas", "zh-TW")).toEqual(["Page needs."]);    // no zh-TW lines anywhere for needs
    expect(say("working", "sage")).toEqual(["Pack work."]);
    expect(say("working")).toEqual(["Pack work."]);                     // no name: the pack's, as before
  });
  it("\"default\"'s lines are everyone's not in byInstance; a byInstance set naming nothing is never looked up", () => {
    const m = voiced(); m.characters.default = { ...m.characters.default, bubbles: { en: { idle: ["Default idle."] } } };
    const c = PK.checkSkinPack(m).pack;
    expect([Z.linesFor("idle", "en", c, defaults, "sage"), Z.linesFor("idle", "en", c, defaults, "atlas")]).toEqual([["Default idle."], ["Pack idle."]]);
    // A share cuts characters to the sets worn; a hand-made pack object with a dangling byInstance falls back to default.
    const dangling = { ...c, byInstance: { atlas: "gone" } };
    expect(Z.linesFor("idle", "en", dangling, defaults, "atlas")).toEqual(["Default idle."]);
  });
  it("names like Object.prototype's look up nothing", () => {
    const c = PK.checkSkinPack(voiced()).pack;
    expect([Z.linesFor("working", "en", c, defaults, "constructor"), Z.linesFor("working", "en", c, defaults, "__proto__")]).toEqual([["Pack work."], ["Pack work."]]);
  });
});

describe("the scene: each speaks their own line", () => {
  it("atlas (fox) says the set's, quill their own, sage the pack's", () => {
    const c = PK.checkSkinPack(voiced()).pack;
    const said: [number, number, string][] = [];
    const base = K.spriteSkin(c, new Map(["office_bg.png", "fox_idle.png"].map((s) => [s, { src: s, width: 1 }])));
    const skin = { ...base, drawCharacter: () => {}, drawFurniture: () => {}, drawTag: () => {},
      drawBubble: (ctx: any, x: number, y: number, text: string) => { said.push([x, y, text]); } };
    const names = ["atlas", "quill", "sage"];
    const L = Z.zonesLayout(c, names.map((name) => ({ name, state: "needs", i: { name } })));
    const looks = new Map(L.rooms[0].desks.map((d: any) => [d.key, { name: d.node.name, label: d.node.name, state: "needs", pose: "needs", free: true }]));
    const part = F.partOf(L, looks, skin, true, Z.createWalkers(), { frame: () => [], size: () => 0 });
    const ctx = new Proxy({ measureText: (t: string) => ({ width: t.length * 6 }) } as any, { get(o, k) { if (k in o) return o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
    const env = { pal: { bg: "#000", surface: "#111", border: "#222", text: "#fff", focus: "#0ff" }, mode: "dark", labels: { areas: {} } };
    F.drawPart(ctx, part, 1, 0, 0, 0, true, null, env);                // still: whole lines at once; "needs" always speaks
    const seat = (n: string) => L.seats.get(n);
    // Each bubble over its speaker (a little right of their seat): whose is the seat nearest along x.
    const whose = (x: number) => names.reduce((a, b) => (Math.abs(seat(b).x - x) < Math.abs(seat(a).x - x) ? b : a));
    expect(Object.fromEntries(said.map(([x, , text]) => [whose(x), text]))).toEqual({ atlas: "Fox needs you.", quill: "Quill needs you.", sage: "Pack needs you." });
  });
});

describe("the host", () => {
  it("the upload check (office_pack_check's) accepts per-set and per-instance lines, and refuses a bad one", () => {
    const files = { "office_bg.png": b64("office_bg.png"), "fox_idle.png": b64("fox_idle.png") };
    expect(checkSkinUpload({ manifest: voiced(), files }, "me", 1).ok).toBe(true);
    const bad = voiced(); bad.characters.fox.bubbles.en.working = lines(13);
    expect(checkSkinUpload({ manifest: bad, files }, "me", 1)).toMatchObject({ ok: false, error: "skin_manifest_invalid", detail: "characters.fox.bubbles.en.working: at most 12" });
  });

  it("an Office share link keeps only the lines of the people it shows (a set's go with its set); the kept pack is unchanged", () => {
    const person = (name: string) => ({ name, display_name: name, status: "running", state: "working" });
    const src = {
      status: () => ({ instances: ["dev-a", "dev-b", "ops-bot"].map(person), uptime: 1 }),
      org: () => ({ general: ["ops-bot"], teams: [{ name: "dev", members: ["dev-a", "dev-b"] }] }),
      offices: () => ({ rev: 1, offices: [{ id: "eng", name: "Eng", skin: "pack1", members: ["team:dev"] }] }),
      acts: () => [], traffic: () => ({ now: "t", items: [], delegations: [] }), needs: () => [], hidden: () => false,
      skins: { list: () => ({ packs: [] }), get: () => null, picture: () => null },
    } as unknown as OfficeShareSource;
    const kept = { id: "pack1", sha: "s", manifest: { id: "pack1", byInstance: { "dev-a": "fox", "ops-bot": "owl" },
      characters: { default: {}, fox: { bubbles: { en: { idle: ["Fox."] } } }, owl: { bubbles: { en: { idle: ["Owl."] } } } },
      bubblesByInstance: { "dev-b": { en: { idle: ["B."] } }, "ops-bot": { en: { idle: ["Ops."] } } } }, files: {} };
    const before = JSON.stringify(kept);
    const out = new OfficeShareView({ office: "eng", text: false }, src).pack(kept) as { manifest: any };
    expect(out.manifest.bubblesByInstance).toEqual({ "dev-b": { en: { idle: ["B."] } } });
    expect(Object.keys(out.manifest.characters)).toEqual(["default", "fox"]);
    expect(JSON.stringify(out)).not.toContain("ops-bot");
    expect(JSON.stringify(kept)).toBe(before);
  });
});
