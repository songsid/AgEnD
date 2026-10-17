/**
 * #2086: the identity-card banner's focus and its safe band (the user's option C, the "YouTube" model).
 * - Focus: a whole number 0 (top) … 100 (bottom), default the centre. The agent sets `card.bannerFocus`; a person sets
 *   theirs in Edit profile (POST /api/profile card_banner_focus); General through set_web_settings. Field by field, the
 *   person's wins; the card's version moves with it.
 * - The page draws the banner at `object-position: 50% <focus>%` and never wider than BANNER_MAX_ASPECT : 1 (app.css caps
 *   its width at that many times the size's tallest height), so the band shown everywhere is (picture aspect ÷ 5) of its
 *   height at the focus — and every narrower box shows that band too.
 * - The agent's SVG preview crops the banner exactly as the page does, at its focus.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTheme, canonicalTheme } from "../src/web-theme.js";
import { bannerFocusOk, cardVersion, HumanCardStore, resolveCard } from "../src/web-card.js";

vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

describe("the focus value", () => {
  it("a whole number from 0 to 100; anything else is not one", () => {
    for (const v of [0, 1, 50, 100]) expect(bannerFocusOk(v), String(v)).toBe(v);
    for (const v of [-1, 101, 1.5, "50", null, undefined, NaN]) expect(bannerFocusOk(v), String(v)).toBeNull();
  });
  it("the agent's card.bannerFocus: checked, and 0 (the top) is kept", () => {
    const ctx = { assets: new Set<string>() };
    expect(checkTheme({ card: { bannerFocus: 0 } }, ctx)).toEqual({ ok: true, theme: { v: 1, card: { bannerFocus: 0 } } });
    expect(checkTheme({ card: { bannerFocus: 100 } }, ctx)).toMatchObject({ ok: true });
    for (const bad of [101, -5, 12.5, "top"]) expect(checkTheme({ card: { bannerFocus: bad } }, ctx), String(bad)).toMatchObject({ ok: false });
    expect(canonicalTheme({ v: 1, card: { bannerFocus: 0 } } as never)).toEqual({ v: 1, card: { bannerFocus: 0 } });
  });
});

describe("the person's side and the resolution", () => {
  const openDb = (dir: string) => { let db: Database.Database | null = null; return () => (db ??= new Database(join(dir, "profiles.db"))); };
  it("set, cleared with null, a bad value refused (nothing written)", () => {
    const dir = tmp("agend-2086-store-"), store = new HumanCardStore(dir, openDb(dir));
    expect(store.setBannerFocus("a", 20)).toEqual({ ok: true });
    expect(store.get("a").banner_focus).toBe(20);
    expect(store.setBannerFocus("a", 101)).toMatchObject({ ok: false, status: 400, error: "card_banner_focus" });
    expect(store.get("a").banner_focus).toBe(20);
    expect(store.setBannerFocus("a", null)).toEqual({ ok: true });
    expect(store.get("a").banner_focus).toBeNull();
  });
  it("a table made before the focus gets its column; a status read of such a table needs none", () => {
    const dir = tmp("agend-2086-old-"), open = openDb(dir);
    open().exec("CREATE TABLE instance_card (instance_name TEXT PRIMARY KEY, tagline TEXT, bio TEXT, portrait TEXT, banner TEXT, updated_at INTEGER)");
    open().prepare("INSERT INTO instance_card (instance_name, tagline, updated_at) VALUES ('a', 'Old', 1)").run();
    expect(HumanCardStore.all(dir, open).get("a")).toMatchObject({ tagline: "Old", banner_focus: null });
    const store = new HumanCardStore(dir, open);
    expect(store.get("a")).toMatchObject({ tagline: "Old", banner_focus: null });
    expect(store.setBannerFocus("a", 10)).toEqual({ ok: true });
    expect(HumanCardStore.all(dir, open).get("a")).toMatchObject({ banner_focus: 10 });
  });
  it("field by field: the person's, else the agent's, else nothing (the centre); the version moves with it", () => {
    const human = (f: number | null) => ({ tagline: null, bio: null, portrait: null, banner: null, updated_at: 1, banner_focus: f });
    expect(resolveCard("a", human(10), { bannerFocus: 80 }).banner_focus).toEqual({ value: 10, by: "human" });
    expect(resolveCard("a", human(null), { bannerFocus: 80 }).banner_focus).toEqual({ value: 80, by: "agent" });
    expect(resolveCard("a", human(0), { bannerFocus: 80 }).banner_focus, "0 is a choice").toEqual({ value: 0, by: "human" });
    expect(resolveCard("a", human(null), {}).banner_focus).toBeUndefined();
    const v = (f: number) => cardVersion(resolveCard("a", undefined, { tagline: "Hi", bannerFocus: f }));
    expect([v(10) !== v(90), cardVersion(resolveCard("a", undefined, { tagline: "Hi" })) !== v(50)]).toEqual([true, true]);
  });
});

describe("through the page's route and General's tool", () => {
  it("POST /api/profile card_banner_focus → GET /api/card; null follows the agent's; set_web_settings writes the same", async () => {
    const dir = tmp("agend-2086-fm-");
    process.env.AGEND_HOME = dir;
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { handleViewRequest } = await import("../src/view-api.js");
    const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
    const fm = new FleetManager(dir) as any;
    const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
    fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
    fm.initializeWebAuthTokens(); fm.initializeWebSessions();
    fm.webAppearance.setTheme("alpha", { set: { card: { tagline: "Agent's", bannerFocus: 70 } } });
    const call = (method: string, path: string, body?: string) => new Promise<{ status: number; body: string }>((resolve) => {
      const { sessionId } = fm.webSessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken) });
      const req: any = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "127.0.0.1:19280", origin: "http://127.0.0.1:19280", cookie: `agend_session=${sessionId}`, "x-agend-csrf": csrfTokenFor(sessionId) }, socket: { remoteAddress: "127.0.0.1" }, destroy() {}, resume() {} });
      let status = 0;
      const res: any = { headersSent: false, setHeader() {}, writeHead(c: number) { status = c; res.headersSent = true; return res; }, end(b?: string) { resolve({ status, body: b ? b.toString() : "" }); } };
      expect(handleViewRequest(req, res, new URL(`http://127.0.0.1:19280${path}`), fm)).toBe(true);
      setImmediate(() => { if (body !== undefined) req.emit("data", Buffer.from(body)); req.emit("end"); });
    });
    const focus = async () => JSON.parse((await call("GET", "/api/card/alpha")).body).banner_focus;
    expect(await focus()).toEqual({ value: 70, by: "agent" });
    expect((await call("POST", "/api/profile/alpha", JSON.stringify({ card_banner_focus: 15 }))).status).toBe(200);
    expect(await focus()).toEqual({ value: 15, by: "human" });
    expect(JSON.parse((await call("GET", "/api/card/alpha")).body).banner_focus_agent, "the agent's own, for Follow").toBe(70);
    expect((await call("POST", "/api/profile/alpha", JSON.stringify({ card_banner_focus: 150, display_name: "Not saved" }))).status).toBe(400);
    expect(await focus(), "a bad value changes nothing").toEqual({ value: 15, by: "human" });
    expect(JSON.parse((await call("GET", "/api/profile/alpha")).body).display_name).toBeNull();
    expect((await call("POST", "/api/profile/alpha", JSON.stringify({ card_banner_focus: null }))).status).toBe(200);
    expect(await focus(), "null: the agent's again").toEqual({ value: 70, by: "agent" });
    expect(fm.webSettings.change(undefined, { what: "banner_focus", instance: "alpha", focus: 0 })).toEqual({ ok: true, instance: "alpha", focus: 0 });
    expect(await focus()).toEqual({ value: 0, by: "human" });
    expect(fm.webSettings.change(undefined, { what: "banner_focus", instance: "alpha", focus: 1.5 })).toMatchObject({ ok: false, error: "card_banner_focus" });
    expect(fm.webSettings.change(undefined, { what: "banner_focus", instance: "ghost", focus: 1 })).toMatchObject({ ok: false, error: "unknown_instance" });
    expect(fm.webSettings.change(undefined, { what: "banner_focus", instance: "alpha" })).toMatchObject({ ok: false, error: "banner_focus" });
  }, 60_000);
});

describe("the page: what it keeps, how wide it draws, where the bands are", () => {
  it("checkCard keeps a valid focus and drops anything else", async () => {
    const { checkCard } = await import("/assets/identity-card.js");
    expect(checkCard("a", { banner_focus: { value: 30, by: "human" } })).toEqual({ banner_focus: { value: 30, by: "human" } });
    for (const f of [{ value: 101, by: "human" }, { value: 2.5, by: "agent" }, { value: 30, by: "someone" }, 30]) expect(checkCard("a", { banner_focus: f }), JSON.stringify(f)).toBeNull();
  });
  it("app.css caps the banner at BANNER_MAX_ASPECT times its size's tallest height, and draws it at --id-focus", async () => {
    const { BANNER_MAX_ASPECT } = await import("/assets/identity-card.js");
    const css = readFileSync(join(process.cwd(), "src/ui/shared/app.css"), "utf8");
    const rule = /\.id-banner \{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toContain(`max-width: calc(var(--id-bmax) * ${BANNER_MAX_ASPECT});`);
    expect(rule).toContain("object-position: 50% var(--id-focus, 50%);");
    expect(BANNER_MAX_ASPECT).toBe(5);
    // #2089 review: never narrower than BANNER_MIN_ASPECT on any layout — the height capped at the box's width ÷ 2.25.
    const { BANNER_MIN_ASPECT } = await import("/assets/identity-card.js");
    expect(BANNER_MIN_ASPECT).toBe(9 / 4);
    expect(rule).toContain(`min-height: min(var(--id-bmin), calc(100cqw / ${BANNER_MIN_ASPECT}));`);
    expect(rule).toContain(`max-height: min(var(--id-bmax), calc(100cqw / ${BANNER_MIN_ASPECT}));`);
    expect(/\.id-banner-box \{[^}]*container: idbanner \/ inline-size;/.test(css), "the box is the container its cqw measure").toBe(true);
  });
  it("the bands: a 1600×600 banner shows 53% of its height at 5:1, 89% at 3:1, placed by the focus", async () => {
    const { bannerShownHeight, bannerBandTop } = await import("/assets/identity-card.js");
    const ar = 1600 / 600;
    expect(+bannerShownHeight(ar, 5).toFixed(3)).toBe(0.533);
    expect(+bannerShownHeight(ar, 3).toFixed(3)).toBe(0.889);
    expect(bannerShownHeight(ar, 2.25), "a narrower box crops the sides, not the height").toBe(1);
    const shown = bannerShownHeight(ar, 5);
    expect([bannerBandTop(shown, 0), +bannerBandTop(shown, 50).toFixed(3), +bannerBandTop(shown, 100).toFixed(3)]).toEqual([0, 0.233, 0.467]);
    // Every narrower box shows the widest box's band at the same focus (the safe band holds everywhere).
    for (const f of [0, 25, 50, 75, 100]) for (const box of [4.5, 4, 3, 2.7]) {
      const wide = bannerShownHeight(ar, 5), narrow = bannerShownHeight(ar, box);
      expect(bannerBandTop(narrow, f) <= bannerBandTop(wide, f) + 1e-9 && bannerBandTop(narrow, f) + narrow >= bannerBandTop(wide, f) + wide - 1e-9, `${f} ${box}`).toBe(true);
    }
  });
});

describe("#2089 review: the safe area holds on both axes, for every card and phone size", () => {
  it("a 1600×600 banner: the middle 84% of the width × 53% of the height, at the focus", async () => {
    const { bannerSafeArea, BANNER_MIN_ASPECT, BANNER_MAX_ASPECT } = await import("/assets/identity-card.js");
    const round = (a: Record<string, number>) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, +v.toFixed(4)]));
    expect([BANNER_MIN_ASPECT, BANNER_MAX_ASPECT]).toEqual([2.25, 5]);
    expect(round(bannerSafeArea(1600 / 600, 0))).toEqual({ left: 0.0781, top: 0, width: 0.8438, height: 0.5333 });
    expect(round(bannerSafeArea(1600 / 600, 100))).toEqual({ left: 0.0781, top: 0.4667, width: 0.8438, height: 0.5333 });
  });
  it("any mark inside it — near a side or an edge — is shown by every box from 9:4 to 5:1 (S/M/L, phone S/M/L); one outside is not promised", async () => {
    const { bannerSafeArea } = await import("/assets/identity-card.js");
    const pic = { w: 1600, h: 600 }, ar = pic.w / pic.h;
    // object-fit: cover, object-position: 50% f% — the part of the picture a box shows, in picture pixels.
    const shown = (box: number, f: number) => {
      const s = Math.max(box / pic.w, 1 / pic.h);       // box of width `box` and height 1, in units
      const vw = box / s, vh = 1 / s;
      return { x0: (pic.w - vw) / 2, x1: (pic.w + vw) / 2, y0: (pic.h - vh) * f / 100, y1: (pic.h - vh) * f / 100 + vh };
    };
    const boxes = [5, 4.5, 4, 3.5, 3, 2.7, 2.25];       // desktop chat/View caps … Details … phone S (4) / M (3) / L (9:4)
    for (const f of [0, 20, 50, 80, 100]) {
      const a = bannerSafeArea(ar, f);
      const marks = [[a.left + 0.001, a.top + 0.001], [a.left + a.width - 0.001, a.top + a.height - 0.001], [a.left + 0.001, a.top + a.height / 2], [0.5, a.top + 0.001]];
      for (const [mx, my] of marks) for (const box of boxes) {
        const v = shown(box, f), x = mx * pic.w, y = my * pic.h;
        expect(x >= v.x0 - 1e-6 && x <= v.x1 + 1e-6 && y >= v.y0 - 1e-6 && y <= v.y1 + 1e-6, `f${f} box ${box} mark ${mx.toFixed(3)},${my.toFixed(3)}`).toBe(true);
      }
    }
    // Prism's example: a face at x=40, y=300 is not inside the safe area (an L card crops it away).
    const a = bannerSafeArea(ar, 50);
    expect(40 / pic.w < a.left).toBe(true);
    expect(40 >= shown(2.25, 50).x0).toBe(false);
  });
});

describe("#2089 review: the focus preview owns the blob URL of a chosen file, never a server URL", () => {
  it("A then B releases A; closing releases B; a server URL is never released", async () => {
    const { page, h, settle } = await import("./helpers/app-harness.js");
    const pg = page({ url: "http://127.0.0.1:19280/view/a" });
    const made: string[] = [], released: string[] = [];
    const g = globalThis as any;
    const real = { create: g.URL.createObjectURL, revoke: g.URL.revokeObjectURL };
    g.URL.createObjectURL = (f: { name: string }) => { const u = `blob:${f.name}`; made.push(u); return u; };
    g.URL.revokeObjectURL = (u: string) => { released.push(u); };
    try {
      const card = await import("/assets/identity-card.js");
      let api: any = null, shown: any = null;
      const Probe = () => { const [p, a] = card.useBannerPreview(); api = a; shown = p; return null; };
      await pg.mount(h(Probe, {}));
      api.fromSrc("/api/card/a/banner?v=" + "f".repeat(32)); await settle(2);
      api.fromFile({ name: "A" }); await settle(2);
      expect([shown.src, released]).toEqual(["blob:A", []]);
      api.fromFile({ name: "B" }); await settle(2);
      expect([shown.src, released]).toEqual(["blob:B", ["blob:A"]]);
      await pg.unmount(); await settle(2);
      expect([made, released]).toEqual([["blob:A", "blob:B"], ["blob:A", "blob:B"]]);
    } finally { g.URL.createObjectURL = real.create; g.URL.revokeObjectURL = real.revoke; await pg.unmount().catch(() => {}); pg.restore(); }
  });
});

describe("the card draws it; Edit profile previews it", () => {
  it("the banner box carries --id-focus (the person's or agent's, else 50%), with the blurred fill behind the banner", async () => {
    const { page, h, settle } = await import("./helpers/app-harness.js");
    const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/agent/a" });
    try {
      const card = await import("/assets/identity-card.js");
      const src = `/api/card/a/banner?v=${"f".repeat(32)}`;
      const prop = (el: any) => (el.style as any)["--id-focus"] ?? el.style.getPropertyValue?.("--id-focus");
      await pg.mount(h(card.IdentityCard, { name: "a", card: { banner: { src, by: "agent" }, banner_focus: { value: 20, by: "human" } } }));
      await settle(2);
      const box = pg.root.querySelector(".id-banner-box") as any;
      expect([prop(box), box.querySelectorAll("img.id-banner-fill").length, box.querySelectorAll("img.id-banner").length]).toEqual(["20%", 1, 1]);
      await pg.unmount();
      await pg.mount(h(card.IdentityCard, { name: "a", card: { banner: { src, by: "agent" } } }));
      await settle(2);
      expect(prop(pg.root.querySelector(".id-banner-box")), "no focus set: the centre").toBe("50%");
    } finally { await pg.unmount().catch(() => {}); pg.restore(); }
  });
  it("the preview's bands: every screen's (5:1) and a phone's (3:1), placed by the focus once the picture's size is known", async () => {
    const { page, h, settle } = await import("./helpers/app-harness.js");
    const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/agent/a" });
    try {
      const card = await import("/assets/identity-card.js");
      await pg.mount(h(card.BannerFocusPreview, { src: "blob:x", focus: 100 }));
      await settle(2);
      const pic = pg.root.querySelector(".bf-pic") as any;
      expect(pg.root.querySelectorAll(".bf-band").length, "nothing to place before the picture's size is known").toBe(0);
      Object.assign(pic, { naturalWidth: 1600, naturalHeight: 600 });
      pic.dispatchEvent(new (globalThis as any).Event("load"));
      await settle(3);
      const band = (cls: string) => { const el = pg.root.querySelector(cls) as any; const g = (k: string) => (el.style as any)[k] ?? el.style.getPropertyValue?.(k); return [g("top"), g("height")]; };
      expect(band(".bf-safe")).toEqual(["46.67%", "53.33%"]);
      expect(band(".bf-phone")).toEqual(["11.11%", "88.89%"]);
    } finally { await pg.unmount().catch(() => {}); pg.restore(); }
  });
});

describe("the agent's SVG preview", () => {
  it("crops the banner at its focus, as the page does (a nested SVG's viewBox)", async () => {
    const { previewSvg } = await import("../src/web-appearance-view.js");
    const input = (focus?: number) => ({ entry: { name: "a" }, theme: { v: 1 }, card: { banner: { id: "f".repeat(32), by: "agent", src: "x" }, ...(focus === undefined ? {} : { banner_focus: { value: focus, by: "agent" } }) },
      locked: false, agentEdit: true, limits: {} }) as never;
    const pics = { avatar: null, portrait: null, banner: "banner.png", background: null };
    const box = (svg: string) => /<svg x="0" y="0" width="720" height="240" viewBox="([\d. ]+)"/.exec(svg)![1]!.split(" ").map(Number);
    // 1600×600 into 720×240: scale 0.45, shown 1600 × 533.33; the top of the shown part moves with the focus.
    expect(box(previewSvg(input(0), "light", pics, { width: 1600, height: 600 }))).toEqual([0, 0, 1600, 533.33]);
    expect(box(previewSvg(input(), "light", pics, { width: 1600, height: 600 }))).toEqual([0, 33.33, 1600, 533.33]);
    expect(box(previewSvg(input(100), "light", pics, { width: 1600, height: 600 }))).toEqual([0, 66.67, 1600, 533.33]);
    expect(previewSvg(input(0), "light", pics, null), "no size: the nearest of top / middle / bottom").toContain('preserveAspectRatio="xMidYMin slice"');
  });
});
