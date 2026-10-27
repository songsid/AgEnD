/**
 * #2716: the whole-fleet office's style is the fleet's, kept on the host for every viewer, device and share link.
 * - The store: `autoSkin` beside the offices in web-offices.json (setAutoSkin: a skin id or null; the rev moves; a save
 *   of the offices keeps it; a bad one on disk is the default's, the offices kept).
 * - The page: an admin sees the host's style and picks it for everyone (PUT /ui/office-style); their own pick from
 *   before goes up once while the host keeps none; a failed save says so and goes back. Anyone else: their own pick
 *   (this browser's), else the host's.
 * - A share: the whole-fleet office may be shared ("auto": everyone, opened on it); every share's offices carry the
 *   style and its pack is served (and counted in the share's minute of pictures).
 * #2715: a share's look — "auto" (the viewer's device), "light" or "dark", on the page's <html> before it paints; the
 * dialog's default is this dashboard's own light or dark.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniElement } from "./helpers/mini-dom.js";
import { OfficeStore } from "../src/web-office-store.js";
import { OfficeShareView, OfficeShares, WHOLE_FLEET, fleetWide, sharePictureRate, type OfficeShareSource } from "../src/office-share.js";
import { OFFICE_SHARE_PAGE, officeSharePage } from "../src/office-share-page.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "agend-look-")); dirs.push(d); return d; };
const LAB = { id: "lab", name: "Lab", skin: "studio", members: ["quill"] };

describe("#2716 the store: the whole-fleet office's style", () => {
  it("kept beside the offices; the rev moves; null is the default again (no key); a new store reads it back", () => {
    const dir = scratch(), s = new OfficeStore(dir);
    expect([s.autoSkin(), s.list()]).toEqual([null, { rev: 0, offices: [], readable: true }]);
    expect(s.setAutoSkin("snug")).toEqual({ ok: true, rev: 1, autoSkin: "snug" });
    const doc = JSON.parse(readFileSync(s.path, "utf8"));
    expect([doc.version, doc.rev, doc.offices, doc.autoSkin]).toEqual([1, 1, [], "snug"]);
    expect(new OfficeStore(dir).list()).toEqual({ rev: 1, offices: [], readable: true, autoSkin: "snug" });
    expect(s.setAutoSkin(null)).toEqual({ ok: true, rev: 2, autoSkin: null });
    expect(JSON.parse(readFileSync(s.path, "utf8"))).not.toHaveProperty("autoSkin");
    expect(new OfficeStore(dir).autoSkin()).toBeNull();
  });
  it("a save of the offices keeps it; the offices are kept by a style change", () => {
    const dir = scratch(), s = new OfficeStore(dir);
    s.setAutoSkin("studio");
    expect(s.replace([LAB], 1)).toMatchObject({ ok: true, rev: 2 });
    expect(s.autoSkin()).toBe("studio");                                                     // in memory too, not only on disk
    expect(new OfficeStore(dir).list()).toEqual({ rev: 2, offices: [LAB], readable: true, autoSkin: "studio" });
    expect(s.setAutoSkin("pixel")).toMatchObject({ ok: true, rev: 3 });
    expect(new OfficeStore(dir).list()).toEqual({ rev: 3, offices: [LAB], readable: true, autoSkin: "pixel" });
  });
  it("refused: not an id (nor null); an unreadable file (503, left as it was); a bad one on disk reads as none, offices kept", () => {
    const dir = scratch(), s = new OfficeStore(dir);
    for (const bad of ["", "a b", "x".repeat(41), 5, undefined, {}]) expect(s.setAutoSkin(bad)).toMatchObject({ ok: false, status: 400, error: "office_style_invalid" });
    expect(s.rev()).toBe(0);
    writeFileSync(join(dir, "web-offices.json"), JSON.stringify({ version: 1, rev: 4, offices: [LAB], autoSkin: "../x" }));
    expect(new OfficeStore(dir).list()).toEqual({ rev: 4, offices: [LAB], readable: true });
    const broken = scratch();
    writeFileSync(join(broken, "web-offices.json"), "{ nope");
    expect(new OfficeStore(broken).setAutoSkin("studio")).toMatchObject({ ok: false, status: 503, error: "offices_unreadable" });
    expect(readFileSync(join(broken, "web-offices.json"), "utf8")).toBe("{ nope");
  });
});

const source = (autoSkin?: string): OfficeShareSource => ({
  status: () => ({ instances: [{ name: "atlas", status: "running" }, { name: "quill", status: "running" }] }),
  org: () => ({ general: ["atlas"], teams: [] }),
  offices: () => ({ rev: 3, offices: [LAB], ...(autoSkin ? { autoSkin } : {}) }),
  acts: () => [], traffic: () => ({ now: "", items: [] }), needs: () => [], hidden: () => false,
});

describe("#2716 a share and the whole-fleet office", () => {
  it("shared as its own: no stored office needed; everyone shown, as All offices; opened on it", () => {
    const shares = new OfficeShares({ setTimer: () => null, clearTimer: () => {} });
    const r = shares.create({ office: WHOLE_FLEET, owner: "o", exists: () => false });
    if (!r.ok) throw new Error(r.error);
    expect([fleetWide("auto"), fleetWide("all"), fleetWide("lab")]).toEqual([true, true, false]);
    const v = new OfficeShareView(r.share, source());
    expect([...v.scope].sort()).toEqual(["atlas", "quill"]);
    expect(v.offices).toEqual([LAB]);
    expect(v.state().office).toBe("auto");
  });
  it("every share's offices carry the style; its pack is served and counted in the share's minute of pictures", () => {
    const one = new OfficeShareView({ office: "lab", text: false }, source("snug"));
    expect(one.officeList()).toMatchObject({ rev: 3, autoSkin: "snug" });
    expect([...one.skinIds()].sort()).toEqual(["snug", "studio"]);
    expect(new OfficeShareView({ office: "lab", text: false }, source()).officeList()).not.toHaveProperty("autoSkin");
    expect([...new OfficeShareView({ office: "lab", text: false }, source()).skinIds()]).toEqual(["studio"]);
    const packs = [{ id: "snug", files: 300, bytes: 40 * 1024 * 1024 }];
    expect(sharePictureRate({ office: "lab" }, [LAB], packs, "snug")).toEqual({ requests: 600, bytes: 80 * 1024 * 1024 });
    expect(sharePictureRate({ office: "lab" }, [LAB], packs)).toEqual({ requests: 240, bytes: 16 * 1024 * 1024 });   // the floors
  });
});

describe("#2715 a share's look", () => {
  it("auto unless asked; light or dark kept; anything else refused", () => {
    const shares = new OfficeShares({ setTimer: () => null, clearTimer: () => {} });
    const made = (theme?: string) => shares.create({ office: "all", owner: "o", ...(theme === undefined ? {} : { theme }) });
    expect([made(), made("light"), made("dark")].map((r) => (r.ok ? r.share.theme : r.error))).toEqual(["auto", "light", "dark"]);
    expect(made("system")).toEqual({ ok: false, error: "theme" });
  });
  it("the page paints in it at once: data-theme on <html> for light or dark; auto as it was", () => {
    expect(officeSharePage("dark")).toContain('<html lang="en" data-theme="dark">');
    expect(officeSharePage("light")).toContain('<html lang="en" data-theme="light">');
    expect(officeSharePage("auto")).toBe(OFFICE_SHARE_PAGE);
    expect(officeSharePage('dark" onload="x')).toBe(OFFICE_SHARE_PAGE);
    expect(OFFICE_SHARE_PAGE).not.toContain("data-theme");
  });
});

// ── The pages ──

let p: AppPage, D: any, fleet: any, app: any, nav: any, I: any;
let offices: any = { rev: 0, offices: [] }, styleAnswer: [number, unknown] = [200, { rev: 1, autoSkin: null }];
const calls: Array<{ method: string; url: string; body?: any }> = [];
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string, o: any = {}) => {
    const method = o.method ?? "GET";
    calls.push({ method, url, ...(o.body ? { body: JSON.parse(o.body) } : {}) });
    if (url === "/ui/office-style" && method === "PUT") return { ok: styleAnswer[0] === 200, status: styleAnswer[0], json: async () => styleAnswer[1] };
    return { ok: true, status: 200, json: async () => (url === "/ui/org" ? { general: ["atlas"], teams: [], instances: {} } : url === "/ui/offices" ? offices : url === "/ui/office-skins" ? { rev: "", packs: [] } : {}) };
  };
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  I = await import("/assets/app-i18n.js");
  nav.startRouter(p.window);
  fleet = await import("/ui/js/panel-fleet.js");
  D = await import("/ui/js/office-share-dialog.js");
});
afterAll(async () => { await p.unmount(); p.restore(); delete (globalThis as any).fetch; });

function fakeCtx() {
  const t: any = { measureText: (s: string) => ({ width: [...String(s)].length * 6 }), createPattern: () => ({}), getImageData: (_x: number, _y: number, w: number, hh: number) => ({ data: new Uint8ClampedArray(w * hh * 4) }) };
  return new Proxy(t, { get(o, k) { return k in o ? o[k] : () => {}; }, set(o, k, v) { o[k] = v; return true; } });
}

describe("#2716 the dashboard's style picker", () => {
  const proto = MiniElement.prototype as any;
  beforeEach(async () => {
    await p.unmount(); p.storage.clear(); calls.length = 0;
    offices = { rev: 0, offices: [] }; styleAnswer = [200, { rev: 1, autoSkin: null }];
    nav.navigate("/ui/fleet/org");
    app.appStore.set({ ready: true, instances: [{ name: "atlas", status: "running", backend: "claude" }], exec: {}, awaiting: {}, needs: [] });
    proto.getContext = function () { return (this._ctx ??= fakeCtx()); };
  });
  afterEach(() => { delete proto.getContext; delete (globalThis as any).AgendAuth; delete (p.window as any).AgendAuth; });
  const as = (admin: boolean) => { (globalThis as any).AgendAuth = (p.window as any).AgendAuth = { canWrite: async () => admin }; };
  const office = async () => {
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6);
    p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(8);
  };
  const picker = () => p.root.querySelectorAll(".oo-bar select").find((s: any) => s.querySelectorAll("option").some((o: any) => o.value === "cozy"));
  const pick = async (v: string) => { const s = picker(); s.value = v; fire(s, "change"); await settle(6); };
  const puts = () => calls.filter((c) => c.url === "/ui/office-style").map((c) => c.body);

  it("an admin: the host's style, over their own; a pick is saved for everyone", async () => {
    as(true);
    localStorage.setItem("agend_org_office_skin", "pixel");
    offices = { rev: 2, offices: [], autoSkin: "studio" };
    await office();
    expect([picker().value, picker().getAttribute("title")]).toEqual(["studio", "The whole fleet's style, for everyone: every device and share link"]);
    expect(puts()).toEqual([]);                                               // the host keeps one: nothing sent up
    styleAnswer = [200, { rev: 3, autoSkin: "pixel" }];
    await pick("pixel");
    expect([puts(), picker().value, localStorage.getItem("agend_org_office_skin")]).toEqual([[{ skin: "pixel" }], "pixel", "pixel"]);
  });
  it("an admin's own pick from before goes up once while the host keeps none", async () => {
    as(true);
    localStorage.setItem("agend_org_office_skin", "studio");
    styleAnswer = [200, { rev: 1, autoSkin: "studio" }];
    await office();
    expect([puts(), picker().value]).toEqual([[{ skin: "studio" }], "studio"]);
    await p.unmount(); calls.length = 0;
    as(true); localStorage.removeItem("agend_org_office_skin");
    await office();
    expect(puts()).toEqual([]);                                               // nothing of their own: nothing sent
  });
  it("a save refused: said in words, the host's style back", async () => {
    as(true);
    offices = { rev: 2, offices: [], autoSkin: "studio" };
    await office();
    styleAnswer = [429, { error: "offices_rate_limited" }];
    await pick("pixel");
    expect([picker().value, p.root.querySelector(".oo-style-err").textContent]).toEqual(["studio", "Too many changes. Try again in a minute."]);
    styleAnswer = [503, { error: "offices_write_failed" }];
    await pick("pixel");
    expect(p.root.querySelector(".oo-style-err").textContent).toBe("The style was not saved for everyone (offices_write_failed).");
  });
  it("anyone else: their own pick (this browser's, never sent), else the host's", async () => {
    as(false);
    offices = { rev: 2, offices: [], autoSkin: "studio" };
    await office();
    expect([picker().value, picker().getAttribute("title")]).toEqual(["studio", "The whole fleet's style in this browser"]);
    await pick("pixel");
    expect([picker().value, puts()]).toEqual(["pixel", []]);
    await p.unmount();
    as(false);
    await office();
    expect(picker().value).toBe("pixel");
  });
  it("its words in both languages", () => {
    I.setLang("zh-TW", { store: false });
    try {
      expect([I.t("orgo.styleForAll"), I.t("orgo.styleHere"), I.t("orgo.styleFailed", "x"), I.t("orgo.styleBusy")])
        .toEqual(["整個 fleet 的風格，所有人共用：每台裝置與分享連結都一樣", "這個瀏覽器裡整個 fleet 的風格", "風格沒有替所有人儲存（x）。", "變更太頻繁，請一分鐘後再試。"]);
    } finally { I.setLang("en", { store: false }); }
  });
});

describe("#2715/#2716 Share…", () => {
  const OFFICES = [{ id: "hq", name: "HQ" }, { id: "lab", name: "Lab" }];
  const host = () => {
    const sent: any[] = [];
    const get = async (_path: string, o: { method?: string; body?: string } = {}) => {
      if (o.method === "POST") sent.push(JSON.parse(o.body!));
      return { ok: o.method !== "POST", status: o.method === "POST" ? 503 : 200, json: async () => (o.method === "POST" ? { error: "tunnel", reason: "x" } : { enabled: true, shares: [] }) };
    };
    return { get, sent };
  };
  afterEach(async () => { await p.unmount(); delete (p.window as any).AgendTheme; delete (globalThis as any).AgendTheme; });
  const create = async () => { p.root.querySelectorAll(".dlg-actions button").at(-1).click(); await settle(4); };
  it("the whole fleet shown: it is the default; the look follows this dashboard's light or dark", async () => {
    (globalThis as any).AgendTheme = { get: () => "dark" };
    const hst = host();
    await p.mount(h(D.ShareDialog, { offices: OFFICES, current: null, get: hst.get, onClose: () => {} })); await settle(3);
    const [office, , look] = p.root.querySelectorAll(".os-form select");
    expect(office.querySelectorAll("option").map((o: any) => [o.value, o.textContent.trim()])).toEqual([["auto", "Whole fleet"], ["all", "All offices"], ["hq", "HQ"], ["lab", "Lab"]]);
    expect([office.value, look.value]).toEqual(["auto", "dark"]);
    expect(look.querySelectorAll("option").map((o: any) => o.textContent.trim())).toEqual(["The viewer's device (light or dark)", "Light", "Dark"]);
    look.value = "auto"; fire(look, "change"); await settle(1);
    await create();
    expect(hst.sent).toEqual([{ office: "auto", minutes: 60, text: false, theme: "auto" }]);
  });
  it("defaultLook: what the dashboard shows now — light or dark as chosen, else the device's; nothing known: the viewer's", () => {
    const dev = (dark: boolean) => () => ({ matches: dark });
    expect([D.defaultLook("light", dev(true)), D.defaultLook("dark", dev(false))]).toEqual(["light", "dark"]);
    expect([D.defaultLook("system", dev(true)), D.defaultLook("system", dev(false)), D.defaultLook(null, dev(true))]).toEqual(["dark", "light", "dark"]);
    expect([D.defaultLook("system", null), D.defaultLook("system", () => { throw new Error("x"); })]).toEqual(["auto", "auto"]);
  });
  it("one office stored: All offices is not offered (the whole fleet is everyone); the open list names a whole-fleet link", async () => {
    const hst = host();
    await p.mount(h(D.ShareDialog, { offices: [OFFICES[0]], current: "hq", get: hst.get, onClose: () => {} })); await settle(3);
    expect(p.root.querySelector(".os-form select").querySelectorAll("option").map((o: any) => o.value)).toEqual(["auto", "hq"]);
    await p.unmount();
    await p.mount(h(D.ShareList, { shares: [{ id: "a1b2c3d4", office: "auto", text: false, expiresAt: Date.now() + 1e6 }] })); await settle(2);
    expect(p.root.querySelector(".os-what strong").textContent).toBe("Whole fleet");
  });
  it("its words in both languages", () => {
    I.setLang("zh-TW", { store: false });
    try {
      expect(["wholeFleet", "look", "lookAuto", "lookLight", "lookDark"].map((k) => I.t(`oshare.${k}`))).toEqual(["整個 fleet", "外觀", "依觀看者的裝置（淺色或深色）", "淺色", "深色"]);
    } finally { I.setLang("en", { store: false }); }
  });
});
