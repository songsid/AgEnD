/**
 * #2861 (design: hxhsandy): the Office's dialogue box. docs/design/office-dialogue-2861.md.
 * - The conversation store and what it takes (fleet-office-dialogue.js): a person's message opens one, the agent's reply
 *   answers it; a replay or catch-up (stamped outside FRESH_MS of the server's clock) and status lines never do; the
 *   queue (newest first, "+N"), an agent drawn asleep waits, expiry; reduced motion (no slide, typing or fade); the
 *   words (clip, wrap for Latin and CJK, typed); portraits by fallback; a share's `talk`.
 * - The pack's `portraits` and `dialogBox` (fleet-office-pack.js, page and host alike), and the host's size limits.
 * - The host's talk record (office-talk.ts) and a share's /state: when, never what or by whom; the share's people only.
 * - On the page: off by default — no stream listener, nothing drawn, the bar's one new checkbox; on: a message and its
 *   reply drawn, a status line read out, a click on the box opens the agent's card; a share shows no words.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as D from "../src/ui/fleet-office-dialogue.js";
import * as PK from "../src/ui/fleet-office-pack.js";
import { checkSkinUpload, PORTRAIT_MAX } from "../src/web-office-skins.js";
import { OfficeTalk, TALK_MAX_AGE_MS } from "../src/office-talk.js";
import { OfficeShareView } from "../src/office-share.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniElement } from "./helpers/mini-dom.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const NOW = Date.parse("2026-11-06T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("what the box takes from the stream (messageOf, talkOf)", () => {
  it("a person's message is heard, the agent's reply answers; a status line, another role or a replay is nothing", () => {
    expect(D.messageOf({ instance: "atlas", role: "user", sender: "Han", from: "discord:42", text: "hello", ts: iso(NOW - 5000) }, NOW))
      .toEqual({ kind: "heard", instance: "atlas", person: { name: "Han", account: "discord:42" }, text: "hello", files: false });
    expect(D.messageOf({ instance: "atlas", role: "agent", sender: "atlas", text: "hi", ts: iso(NOW) }, NOW)).toEqual({ kind: "answered", instance: "atlas", text: "hi", files: false });
    expect(D.messageOf({ instance: "atlas", role: "status", text: "x", ts: iso(NOW) }, NOW)).toBeNull();
    expect(D.messageOf({ instance: "atlas", role: "user", text: "old", ts: iso(NOW - D.DLG.FRESH_MS - 1) }, NOW)).toBeNull();     // a replay
    expect(D.messageOf({ instance: "atlas", role: "user", text: "future", ts: iso(NOW + D.DLG.FRESH_MS + 1) }, NOW)).toBeNull();
    expect(D.messageOf({ instance: "atlas", role: "user", text: "x", ts: "not a time" }, NOW)).toBeNull();
    expect(D.messageOf({ instance: "", role: "user", text: "x", ts: iso(NOW) }, NOW)).toBeNull();
    // A click says its label; a file alone is "a file"; an account that is not adapter:id is no account.
    expect(D.messageOf({ instance: "a", role: "user", text: "internal", click: { label: "Yes" }, ts: iso(NOW) }, NOW)!.text).toBe("Yes");
    expect(D.messageOf({ instance: "a", role: "user", text: "", attachments: [{ id: "f" }], ts: iso(NOW) }, NOW)).toMatchObject({ text: "", files: true });
    expect(D.messageOf({ instance: "a", role: "user", text: "", ts: iso(NOW) }, NOW)).toBeNull();
    expect((D.messageOf({ instance: "a", role: "user", text: "x", from: "no colon", ts: iso(NOW) }, NOW) as any).person.account).toBeNull();
  });
  it("a share's talk: only heard/answered items that are news, oldest first; anything odd dropped", () => {
    const t = { now: NOW, items: [{ instance: "a", kind: "answered", at: NOW - 1000 }, { instance: "a", kind: "heard", at: NOW - 3000 },
      { instance: "b", kind: "heard", at: NOW - D.DLG.FRESH_MS - 1 }, { instance: "c", kind: "said", at: NOW }, { instance: 7, kind: "heard", at: NOW }, null] };
    expect(D.talkOf(t)).toEqual([{ instance: "a", kind: "heard", at: NOW - 3000 }, { instance: "a", kind: "answered", at: NOW - 1000 }]);
    expect([D.talkOf(null), D.talkOf({ items: [] }), D.talkOf({ now: NOW })]).toEqual([[], [], []]);
  });
});

describe("the conversations (createDialogue, pickFront, stageOf)", () => {
  it("heard → answered → gone after the hold and fade; never answered → gone after WAIT_MS; a reply with nothing heard is nothing", () => {
    const d = D.createDialogue();
    expect(d.answered("atlas", "hi", 0)).toBeNull();
    const c = d.heard("atlas", { name: "Han", account: null }, "hello", 1000)!;
    expect(d.answered("atlas", "hi there", 2000)).toBe(c);
    expect(d.answered("atlas", "again", 2500)).toBeNull();                 // answered once
    expect([c.text, c.reply]).toEqual(["hello", "hi there"]);
    expect(d.sweep(2000 + D.DLG.HOLD_MS + D.DLG.FADE_MS - 1)).toBe(false);
    expect(d.sweep(2000 + D.DLG.HOLD_MS + D.DLG.FADE_MS)).toBe(true);
    expect(d.size()).toBe(0);
    d.heard("quill", null, null, 0);
    expect(d.sweep(D.DLG.WAIT_MS - 1)).toBe(false);
    expect(d.sweep(D.DLG.WAIT_MS)).toBe(true);
    // Reduced motion: no fade to wait for.
    d.heard("sage", null, null, 0); d.answered("sage", null, 10);
    expect(d.sweep(10 + D.DLG.HOLD_MS, true)).toBe(true);
  });
  it("newest first; the box shows the newest shown here and awake, +N for the rest shown here; a new message replaces its agent's", () => {
    const d = D.createDialogue();
    d.heard("a", null, "1", 1); d.heard("b", null, "2", 2); d.heard("c", null, "3", 3); d.heard("hidden", null, "4", 4);
    const shown = (n: string) => n !== "hidden", awake = () => false;
    expect(D.pickFront(d.list(), shown, awake)).toMatchObject({ front: { instance: "c" }, more: 2 });
    expect(D.pickFront(d.list(), shown, (n: string) => n === "c")).toMatchObject({ front: { instance: "b" }, more: 2 });   // c asleep: waits
    expect(D.pickFront(d.list(), shown, () => true)).toEqual({ front: null, more: 0 });
    d.heard("a", null, "again", 5);
    expect(d.list().map((c) => [c.instance, c.text])).toEqual([["a", "again"], ["hidden", "4"], ["c", "3"], ["b", "2"]]);
    for (let i = 0; i < D.DLG.MAX + 5; i++) d.heard(`n${i}`, null, "x", 10 + i);
    expect(d.size()).toBe(D.DLG.MAX);
  });
  it("the stage: rises over SLIDE_MS, types from when it was shown, the reply from when it came; fades after the hold; reduced motion: whole and still", () => {
    const d = D.createDialogue(), c = d.heard("a", null, "hello", 0)!;
    const s0 = D.stageOf(c, 100, false, false);
    expect([s0.phase, s0.speaker, s0.typedAt, s0.alpha]).toEqual(["heard", "left", 100, 1]);
    expect(s0.slide).toBe(0);
    expect(D.stageOf(c, 100 + D.DLG.SLIDE_MS, true, false)).toMatchObject({ phase: "working", speaker: "left", slide: 1 });
    d.answered("a", "hi", 5000);
    expect(D.stageOf(c, 6000, true, false)).toMatchObject({ phase: "answered", speaker: "right", typedAt: 6000, alpha: 1 });
    expect(D.stageOf(c, 6000 + D.DLG.HOLD_MS + D.DLG.FADE_MS / 2, true, false).alpha).toBeCloseTo(0.5, 5);
    expect(D.stageOf(c, 6000 + D.DLG.HOLD_MS + D.DLG.FADE_MS, true, false).done).toBe(true);
    const e = d.heard("b", null, "x", 0)!;
    expect(D.stageOf(e, 1, false, true)).toMatchObject({ slide: 1, alpha: 1 });
    d.answered("b", "y", 2);
    expect(D.stageOf(e, 3, false, true)).toMatchObject({ phase: "answered", alpha: 1 });       // the hold counts from when the reply is shown
    expect(D.stageOf(e, 3 + D.DLG.HOLD_MS, false, true)).toMatchObject({ alpha: 0, done: true });
  });
});

describe("the words (clip, wrap, typed)", () => {
  it("clip: one plain line, at most TEXT_MAX characters with …", () => {
    expect(D.clip("# Title\n\n- **bold** item\n> quote `code`")).toBe("Title bold item quote code");
    expect(D.clip("before ```js\nlet x = 1;\n``` after")).toBe("before … after");
    const long = "字".repeat(200);
    expect([...D.clip(long)].length).toBe(D.DLG.TEXT_MAX);
    expect(D.clip(long).endsWith("…")).toBe(true);
    expect(D.clip("a".repeat(D.DLG.TEXT_MAX))).toBe("a".repeat(D.DLG.TEXT_MAX));
  });
  it("wrap: Latin by words, CJK by characters, a long word broken; the last line cut with …", () => {
    const m = (s: string) => [...s].length * 10;                           // 10 px a character
    expect(D.wrap(m, "the quick brown fox jumps", 100, 5)).toEqual(["the quick", "brown fox", "jumps"]);
    expect(D.wrap(m, "今天天氣很好我們去散步吧", 50, 5)).toEqual(["今天天氣很", "好我們去散", "步吧"]);
    expect(D.wrap(m, "abcdefghijklmnop", 50, 5)).toEqual(["abcde", "fghij", "klmno", "p"]);
    expect(D.wrap(m, "one two three four five six", 90, 2)).toEqual(["one two", "three…"]);
    expect(D.wrap(m, "混合 mixed 文字", 60, 3)).toEqual(["混合", "mixed", "文字"]);
    expect(D.typed(["hello", "world"], 7)).toEqual(["hello", "wo"]);
    expect(D.typed(["hello"], 0)).toEqual([]);
  });
  it("the layout: centred at the foot, never wider than 960; narrower on a phone; the text inside the box", () => {
    const L = D.boxLayout(1600, 900);
    expect([L.box.w, L.box.x, L.box.y + L.box.h]).toEqual([960, 320, 900 - 16]);
    const P = D.boxLayout(390, 700);
    expect(P.narrow).toBe(true);
    expect(P.box.x + P.box.w).toBeLessThanOrEqual(390 - 8);
    // As tall as its words need (two lines at least), still on the foot; the agent's line adds its row.
    const F1 = D.fitBox(L, 1, false), F3 = D.fitBox(L, 3, true);
    expect(F1.box.y + F1.box.h).toBe(L.box.y + L.box.h);
    expect(F1.box.h).toBeLessThan(L.box.h);
    expect(F3.box.h).toBeGreaterThan(F1.box.h);
    expect(F1.text.y - F1.box.y).toBe(L.text.y - L.box.y);
    expect(D.fitBox(L, 99, true)).toBe(L);
    for (const x of [L, P]) { expect(x.text.lines).toBeGreaterThanOrEqual(1); expect(x.text.x + x.text.w).toBeLessThanOrEqual(x.box.x + x.box.w); expect(x.portrait.h).toBeGreaterThan(0); }
  });
});

describe("portraits and the box's look in a pack", () => {
  const PACK = () => ({ ...MANIFEST(), furniture: [{ id: "elder", sprite: { src: "fox_idle.png", frames: 4, w: 32, h: 48 }, x: 100, y: 200 }],
    portraits: { default: "p/agent.png", byInstance: { atlas: { idle: "p/atlas.png", working: "p/atlas-w.png" } }, byUser: { "discord:42": "p/han.png" }, npc: { elder: "p/elder.png" } },
    dialogBox: { frame: "ui/box.png", slice: 12, background: "#2B1D14", text: "#f6ead7" } });
  it("accepted and normalised (a file is its idle expression; colours lower-cased; slice default 8)", () => {
    const r = PK.checkSkinPack(PACK());
    expect(r.ok).toBe(true);
    const pk = (r as any).pack;
    expect(pk.portraits).toEqual({ default: { idle: "p/agent.png" }, byInstance: { atlas: { idle: "p/atlas.png", working: "p/atlas-w.png" } }, byUser: { "discord:42": { idle: "p/han.png" } }, npc: { elder: { idle: "p/elder.png" } } });
    expect(pk.dialogBox).toEqual({ frame: "ui/box.png", slice: 12, background: "#2b1d14", text: "#f6ead7" });
    expect((PK.checkSkinPack({ ...PACK(), dialogBox: { frame: "b.png" } }) as any).pack.dialogBox.slice).toBe(8);
    // The scene's pictures and the box's are told apart; an upload must send both.
    expect(PK.packPortraitImages(pk).sort()).toEqual(["p/agent.png", "p/atlas-w.png", "p/atlas.png", "p/elder.png", "p/han.png", "ui/box.png"]);
    expect(PK.packSceneImages(pk).some((s: string) => s.startsWith("p/") || s.startsWith("ui/"))).toBe(false);
    expect(PK.packImages(pk)).toEqual(expect.arrayContaining(["p/agent.png", "ui/box.png", "office_bg.png"]));
    // A pack without them: no keys added (an older page reads it as before).
    const plain = (PK.checkSkinPack(MANIFEST()) as any).pack;
    expect(["portraits" in plain, "dialogBox" in plain]).toEqual([false, false]);
  });
  it.each([
    [{ portraits: { extra: {} } }, 'portraits: unknown key "extra"'],
    [{ portraits: { default: {} } }, "portraits.default: a file, or at least one of idle, working, needs"],
    [{ portraits: { default: { sad: "x.png" } } }, 'portraits.default: unknown key "sad"'],
    [{ portraits: { default: "../x.png" } }, "portraits.default: a file name in the pack"],
    [{ portraits: { byUser: { owner: "x.png" } } }, 'portraits.byUser.owner: an account as "adapter:id"'],
    [{ portraits: { byUser: { constructor: "x.png" } } }, 'portraits.byUser.constructor: an account as "adapter:id"'],
    [{ portraits: { byInstance: { toString: "x.png" } } }, "portraits.byInstance.toString: an instance's name"],
    [{ portraits: { npc: { ghost: "x.png" } } }, "portraits.npc.ghost: a furniture item the pack defines"],
    [{ portraits: { byInstance: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`i${i}`, "x.png"])) } }, "portraits.byInstance: at most 500"],
    [{ dialogBox: { slice: 4 } }, "dialogBox.slice: only with frame"],
    [{ dialogBox: { frame: "b.png", slice: 0 } }, "dialogBox.slice: a whole number from 1 to 128"],
    [{ dialogBox: { text: "red" } }, "dialogBox.text: a colour as #rrggbb"],
    [{ dialogBox: { glow: true } }, 'dialogBox: unknown key "glow"'],
  ])("refused, saying where: %j", (extra, error) => {
    expect(PK.checkSkinPack({ ...MANIFEST(), ...extra })).toEqual({ ok: false, error });
  });
  it("which portrait: an agent's byInstance by state, else the default; a person's byUser; none: null", () => {
    const pk = (PK.checkSkinPack(PACK()) as any).pack;
    expect(D.portraitSrc(pk, { agent: "atlas", state: "working" })).toBe("p/atlas-w.png");
    expect(D.portraitSrc(pk, { agent: "atlas", state: "needs" })).toBe("p/atlas.png");      // no needs: idle
    expect(D.portraitSrc(pk, { agent: "quill", state: "idle" })).toBe("p/agent.png");
    expect(D.portraitSrc(pk, { account: "discord:42" })).toBe("p/han.png");
    expect(D.portraitSrc(pk, { account: "discord:7" })).toBeNull();                         // the default is the agents'
    expect(D.portraitSrc(null, { agent: "atlas", state: "idle" })).toBeNull();
    const onlyWorking = (PK.checkSkinPack({ ...MANIFEST(), portraits: { default: { working: "w.png" } } }) as any).pack;
    expect(D.portraitSrc(onlyWorking, { agent: "x", state: "idle" })).toBe("w.png");        // any it has
  });
});

/** A tiny valid PNG of w×h (as web-office-skins-2513.test.ts's). */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type, "ascii"), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc((w * 4 + 1) * h))), chunk("IEND", Buffer.alloc(0))]);
}
describe("the host's upload check (checkSkinUpload)", () => {
  const b64 = (f: string) => readFileSync(join(FIXTURE, f)).toString("base64");
  const upload = (portrait: Buffer, frame: Buffer, slice = 8) => ({ manifest: { ...MANIFEST(), portraits: { default: "p/agent.png" }, dialogBox: { frame: "ui/box.png", slice } },
    files: { "office_bg.png": b64("office_bg.png"), "fox_idle.png": b64("fox_idle.png"), "p/agent.png": portrait.toString("base64"), "ui/box.png": frame.toString("base64") } });
  it("a portrait up to 1024×1536 and a frame up to 512×512 are kept; bigger ones, or a slice that leaves nothing, are refused", () => {
    expect(checkSkinUpload(upload(png(512, 768), png(48, 48)), "me", 1).ok).toBe(true);
    expect(checkSkinUpload(upload(png(PORTRAIT_MAX.w, PORTRAIT_MAX.h), png(512, 512)), "me", 1).ok).toBe(true);
    const err = (b: unknown) => { const r = checkSkinUpload(b, "me", 1); return r.ok ? null : [r.error, r.detail]; };
    expect(err(upload(png(1025, 100), png(48, 48)))).toEqual(["skin_portrait_dimensions", "portraits: p/agent.png is 1025×100 px; at most 1024×1536"]);
    expect(err(upload(png(100, 100), png(513, 10)))).toEqual(["skin_portrait_dimensions", "dialogBox.frame: ui/box.png is 513×10 px; at most 512×512"]);
    expect(err(upload(png(100, 100), png(20, 20), 10))).toEqual(["skin_portrait_dimensions", "dialogBox.slice: 10 px a side leaves nothing of ui/box.png (20×20)"]);
    // Named but not sent: refused like any other picture.
    const missing = upload(png(10, 10), png(48, 48)); delete (missing.files as any)["p/agent.png"];
    expect(err(missing)![0]).toBe("skin_file_missing");
  });
});

describe("the host's talk record and a share's /state (no words, no one named, the share's people only)", () => {
  it("OfficeTalk: a person's message is heard, a reply answered; status and odd ones nothing; only the scope, only younger than TALK_MAX_AGE_MS", () => {
    let t = NOW;
    const k = new OfficeTalk(() => t);
    k.noteMessage({ instance: "atlas", role: "user", text: "secret words", sender: "Han" });
    t += 1000;
    k.noteMessage({ instance: "atlas", role: "agent", text: "secret reply" });
    k.noteMessage({ instance: "quill", role: "status", text: "x" });
    k.noteMessage({ instance: "", role: "user" }); k.noteMessage(null); k.noteMessage("x");
    k.noteMessage({ instance: "hidden", role: "user" });
    expect(k.recent(new Set(["atlas", "quill"]))).toEqual({ now: NOW + 1000, items: [{ instance: "atlas", kind: "heard", at: NOW }, { instance: "atlas", kind: "answered", at: NOW + 1000 }] });
    expect(JSON.stringify(k.recent(new Set(["atlas", "hidden"])))).not.toMatch(/secret|Han/);
    t = NOW + TALK_MAX_AGE_MS + 1;
    expect(k.recent(new Set(["atlas"])).items).toEqual([{ instance: "atlas", kind: "answered", at: NOW + 1000 }]);
  });
  it("a share's state carries talk cut to its scope and to { instance, kind, at } — whatever the source hands it", () => {
    const status = { instances: [{ name: "atlas", status: "running" }, { name: "quill", status: "running" }] };
    const src: any = {
      status: () => status, org: () => ({ general: ["atlas", "quill"], teams: [] }), offices: () => ({ rev: 1, offices: [{ id: "o1", name: "One", skin: "cozy", members: ["atlas"] }] }),
      acts: () => [], traffic: () => ({ now: iso(NOW), items: [] }), needs: () => [], hidden: () => false,
      talk: () => ({ now: NOW, items: [{ instance: "atlas", kind: "heard", at: NOW, text: "leak", sender: "Han" }, { instance: "quill", kind: "heard", at: NOW }, { instance: "atlas", kind: "said", at: NOW }] }),
    };
    const one = new OfficeShareView({ office: "o1", text: false }, src).state() as any;
    expect(one.talk).toEqual({ now: NOW, items: [{ instance: "atlas", kind: "heard", at: NOW }] });
    expect(JSON.stringify(one)).not.toMatch(/leak|Han/);
    const all = new OfficeShareView({ office: "all", text: false }, src).state() as any;
    expect(all.talk.items.map((i: any) => i.instance)).toEqual(["atlas", "quill"]);
    // A source without talk (an older one): no key at all.
    const { talk: _gone, ...older } = src;
    expect("talk" in (new OfficeShareView({ office: "o1", text: false }, older).state() as any)).toBe(false);
  });
});

// ── On the page ──

const INSTANCES = [
  { name: "atlas", display_name: "Atlas", status: "running", backend: "claude-code" },
  { name: "quill", status: "running", backend: "kiro-cli" },
];
const ORG = { general: ["atlas"], teams: [{ name: "Web", members: ["quill"] }], instances: {} };
function fakeCtx() {
  const calls: Array<[string, any[]]> = [];
  const t: any = { calls, measureText: (s: string) => ({ width: [...String(s)].length * 6 }), createPattern: () => ({ pattern: true }),
    getImageData: (_x: number, _y: number, w: number, hh: number) => ({ data: new Uint8ClampedArray(w * hh * 4) }) };
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return (...a: unknown[]) => { calls.push([String(k), a]); }; }, set(o, k, v) { o[k] = v; return true; } });
}
describe("the box on the page", () => {
  let p: AppPage, app: any, nav: any, fleet: any;
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const streamOn = (name: string, fn: (d: unknown) => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); return () => listeners.get(name)!.delete(fn); };
  const emit = (name: string, d: unknown) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(d); };
  const proto = MiniElement.prototype as any;
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
    (globalThis as any).fetch = async (url: string) => ({ ok: true, status: 200, json: async () => (url === "/ui/org" ? ORG : url === "/ui/offices" ? { rev: 0, offices: [] } : url === "/ui/office-skins" ? { rev: "", packs: [] } : {}) });
    app = await import("/assets/app-store.js");
    nav = await import("/assets/app-nav.js");
    nav.startRouter(p.window);
    fleet = await import("/ui/js/panel-fleet.js");
  });
  afterAll(async () => { await p.unmount(); p.restore(); delete (globalThis as any).fetch; });
  beforeEach(async () => {
    await p.unmount(); p.storage.clear(); listeners.clear();
    proto.getContext = function () { return (this._ctx ??= fakeCtx()); };
    localStorage.setItem("agend_org_office_skin", "studio");
    nav.navigate("/ui/fleet/org");
    app.appStore.set({ ready: true, instances: INSTANCES, exec: { quill: "working" }, awaiting: {}, needs: [], streamOn });
  });
  afterEach(() => { delete proto.getContext; });
  const office = async () => {
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6);
    p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(6);
  };
  const texts = () => p.root.querySelector(".oo-canvas")._ctx.calls.filter(([k]: any) => k === "fillText").map(([, a]: any) => String(a[0]));
  const tick = async (n = 8) => { for (let i = 0; i < n; i++) await settle(2); };
  const toggle = () => p.root.querySelector(".oo-dialogue input");

  it("off by default: an unticked checkbox, no stream listener, and a message draws nothing", async () => {
    await office();
    expect(toggle().checked).toBe(false);
    expect(p.root.querySelector(".oo-dialogue").textContent).toBe("Dialogue");
    expect(listeners.get("message")?.size ?? 0).toBe(0);
    emit("message", { instance: "atlas", role: "user", sender: "Han", text: "secret hello", ts: new Date().toISOString() });
    await tick();
    expect(texts().some((s: string) => s.includes("secret"))).toBe(false);
    expect(p.root.querySelector(".oo-dialogue-live")).toBeNull();
  });
  it("on (kept per browser): a message is drawn with its sender, the reply with the agent's name, and read out", async () => {
    await office();
    fire(toggle(), "change"); await settle(4);
    expect(localStorage.getItem("agend_org_office_dialogue")).toBe("1");
    expect(listeners.get("message")?.size).toBe(1);
    emit("message", { instance: "atlas", role: "user", sender: "Han", text: "deploy the docs please", ts: new Date().toISOString() });
    await tick(20);
    expect(texts()).toEqual(expect.arrayContaining(["Han"]));
    expect(texts().some((s: string) => "deploy the docs please".startsWith(s) && s.length > 0)).toBe(true);
    expect(p.root.querySelector(".oo-dialogue-live").textContent).toBe("Han: deploy the docs please");
    emit("message", { instance: "atlas", role: "agent", sender: "atlas", text: "Done.", ts: new Date().toISOString() });
    await tick(20);
    expect(texts()).toEqual(expect.arrayContaining(["Atlas"]));
    expect(p.root.querySelector(".oo-dialogue-live").textContent).toBe("Atlas: Done.");
    // A replay of an old one is not news.
    emit("message", { instance: "quill", role: "user", sender: "Han", text: "old news", ts: new Date(Date.now() - 10 * 60_000).toISOString() });
    await tick();
    expect(texts().some((s: string) => s.includes("old news"))).toBe(false);
    // Off again: the listener goes, the box with it.
    fire(toggle(), "change"); await settle(4);
    expect(listeners.get("message")?.size ?? 0).toBe(0);
  });
  it("a share's talk: no words and no one named — 'Someone', 'Sent Atlas a message.', then 'Replied.'; no stream listener", async () => {
    localStorage.setItem("agend_org_office_dialogue", "1");
    const { Office } = await import("/ui/js/fleet-office.js");
    const { buildOrgView } = await import("/ui/js/fleet-org.js");
    const view = buildOrgView(ORG, app.appStore.get());
    const t0 = Date.now();
    await p.mount(h(Office, { view, traffic: [], talk: { now: t0, items: [{ instance: "atlas", kind: "heard", at: t0 - 1000 }] } })); await tick(20);
    expect(listeners.get("message")?.size ?? 0).toBe(0);
    expect(texts()).toEqual(expect.arrayContaining(["Someone"]));
    expect(texts().some((s: string) => s.length > 0 && "Sent Atlas a message.".startsWith(s))).toBe(true);
    expect(p.root.querySelector(".oo-dialogue-live").textContent).toBe("Someone: Sent Atlas a message.");
    await p.mount(h(Office, { view, traffic: [], talk: { now: t0 + 2000, items: [{ instance: "atlas", kind: "heard", at: t0 - 1000 }, { instance: "atlas", kind: "answered", at: t0 + 1500 }] } })); await tick(20);
    expect(p.root.querySelector(".oo-dialogue-live").textContent).toBe("Atlas: Replied.");
  });
  it("reduced motion: the box is drawn whole at once (no typing)", async () => {
    const real = (globalThis as any).matchMedia;
    (globalThis as any).matchMedia = (q: string) => ({ matches: /reduce/.test(q), addEventListener() {}, removeEventListener() {} });
    try {
      localStorage.setItem("agend_org_office_dialogue", "1");
      await office();
      emit("message", { instance: "atlas", role: "user", sender: "Han", text: "whole at once", ts: new Date().toISOString() });
      await settle(2);
      expect(texts()).toEqual(expect.arrayContaining(["Han", "whole at once"]));
    } finally { (globalThis as any).matchMedia = real; }
  });
  it("an agent drawn asleep: its conversation waits (nothing drawn) — hide paused and stopped: not shown at all", async () => {
    app.appStore.set({ ready: true, instances: [{ ...INSTANCES[0], status: "paused" }, INSTANCES[1]], exec: {}, awaiting: {}, needs: [], streamOn });
    localStorage.setItem("agend_org_office_dialogue", "1");
    await office();
    emit("message", { instance: "atlas", role: "user", sender: "Han", text: "are you there", ts: new Date().toISOString() });
    await tick(20);
    expect(texts().some((s: string) => s.startsWith("are"))).toBe(false);
    emit("message", { instance: "quill", role: "user", sender: "Han", text: "quill please", ts: new Date().toISOString() });
    await tick(20);
    expect(texts().some((s: string) => s.length > 2 && "quill please".startsWith(s))).toBe(true);
  });
  it("a click on the box opens its agent's card", async () => {
    await office();
    fire(toggle(), "change"); await settle(4);
    emit("message", { instance: "atlas", role: "user", sender: "Han", text: "hi", ts: new Date().toISOString() });
    await tick(20);
    const cv = p.root.querySelector(".oo-canvas");
    cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 960, height: 600, right: 960, bottom: 600 });
    const L = D.fitBox(D.boxLayout(960, 600), 1, false);
    fire(cv, "click", { clientX: L.box.x + 40, clientY: L.box.y + L.box.h - 6 }); await settle(4);
    expect(p.root.querySelector(".oo-card")?.textContent ?? "").toContain("Atlas");
  });
});
