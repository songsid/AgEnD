/**
 * #1958 PR B2: identity colours on the page.
 * - The page's resolver (identity-color.js) is the server's (web-identity-palette.ts, web-identity-color.ts): the same
 *   palettes, places, shades and order — pinned here so the two never drift.
 * - The sidebar row: `idc` plus one class per place (#2056: by default all three), both modes' colours as custom properties set
 *   through the CSSOM; nothing when colours are off or shown nowhere; the agent's tier only while themes are shown.
 * - The Color dialog reads the person's choice, saves a colour and places, and Reset clears both.
 * - Settings → Web appearance: the default places and Turn off colours are host prefs (color.show / color.off), and
 *   Restore defaults puts every appearance setting back (and turns this person's custom CSS off).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const S = await import("../src/web-identity-palette.js");
const SC = await import("../src/web-identity-color.js");

let host: Record<string, unknown> = {}, rev = 1;
let posts: Array<{ url: string; body: any }> = [];
let profile: { color: string | null; color_show: string[] | null } = { color: null, color_show: null };
const fetchFake = async (url: string, init: any = {}) => {
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  if (init.method === "POST") posts.push({ url, body });
  if (url === "/ui/prefs" && init.method === "POST") { for (const [k, v] of Object.entries(body.set)) { if (v === null) delete host[k]; else host[k] = v; } rev++; }
  if (url === "/ui/prefs") return { ok: true, status: 200, json: async () => ({ values: { ...host }, rev }) };
  if (url.startsWith("/api/profile/") && init.method !== "POST") return { ok: true, status: 200, json: async () => ({ instance_name: url.slice(13), ...profile }) };
  // The other Appearance cards' reads, in their own shapes (none is under test here).
  if (url === "/ui/owner-css/state") return { ok: true, status: 200, json: async () => ({ active: null, pending: null, text: "", versions: [], assets: [], limits: { maxAssets: 16 } }) };
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
const g = globalThis as any;
let C: any, nav: any, prefs: any, themes: any, store: any;
let pg: AppPage | null = null;
beforeAll(async () => {
  const p0 = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  p0.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
  g.fetch = fetchFake;
  prefs = await import("/assets/app-prefs.js");
  store = await import("/assets/app-store.js");
  themes = await import("/assets/app-themes.js");
  nav = await import("/assets/instance-nav.js");
  C = await import("/assets/identity-color.js");
  p0.restore();
});
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } });
const flush = () => new Promise((r) => setTimeout(r, 450));       // savePref's 400 ms debounce
async function setHost(values: Record<string, unknown>) {
  for (const [k, v] of Object.entries(values)) prefs.savePref(k, v);
  await flush(); await settle();
}

describe("the page's resolver is the server's", () => {
  it("the same palettes, places and default", () => {
    expect(C.IDENTITY_PALETTE).toEqual(S.IDENTITY_PALETTE.map((p) => ({ ...p })));
    expect(C.AUTO_PALETTE).toEqual(S.AUTO_PALETTE.map((p) => ({ ...p })));
    expect([C.PLACEMENTS, C.DEFAULT_PLACEMENTS]).toEqual([[...S.PLACEMENTS], [...S.DEFAULT_PLACEMENTS]]);
  });
  it("the same readable shades, colour values and resolution, on a spread of inputs", () => {
    // #757575 reads on the light page but not on the light sidebar; #808080 on the dark sidebar but not the dark page.
    const hexes = ["#ffff00", "#000080", "#777777", "#0a62c2", "#33aaff", "#aa2244", "#ffffff", "#000000", "#757575", "#808080"];
    for (const hex of hexes) for (const mode of ["light", "dark"] as const) expect(C.readableShade(hex, mode), `${hex} ${mode}`).toBe(SC.readableShade(hex, mode));
    for (const c of ["preset:blue", "auto:sea", "#123456"]) for (const mode of ["light", "dark"] as const) expect(C.colorValue(c, mode)).toBe(S.identityColorValue(c as never, mode));
    const tiers = [{ auto: "auto:moss" }, { person: "preset:pink", agent: "#112233", role: "#445566", auto: "auto:sand" }, { agent: "preset:teal", auto: "auto:dusk" },
      { role: "#abcdef", auto: "auto:sea" }, { agent: "bad", role: "nope", auto: "auto:clay" },
      { agent: "auto:sand", role: "#445566", auto: "auto:sea" }, { agent: "auto:sand", auto: "auto:moss" }];      // an agent never picks an automatic colour
    for (const t of tiers) for (const showThemes of [true, false]) expect(C.resolveColor(t, showThemes), JSON.stringify(t)).toEqual(SC.resolveIdentityColor(t as never, { showThemes }));
    const places = [{}, { person: ["name"] }, { agent: ["ring"] }, { person: [], agent: ["bar"] }, { person: ["glow"] }, { person: ["name", "name"], agent: ["ring"] }];
    for (const t of places) for (const showThemes of [true, false]) for (const hostDefault of [undefined, ["name"], [], "x"]) {
      expect(C.resolvePlaces(t, showThemes, hostDefault), JSON.stringify([t, showThemes, hostDefault])).toEqual(SC.resolvePlacements(t as never, { showThemes, hostDefault }));
    }
  });
  it("colours as the server sends them are accepted, anything else is not; the same place lists", () => {
    // The page checks the wire form (preset:<id>, auto:<id>, lower-case #rrggbb), never a person's typing.
    for (const c of ["preset:blue", "auto:sea", "#0a62c2"]) expect(C.colorOk(c), c).toBe(c);
    for (const c of ["#0A62C2", "#0a62c", "#0a62c2ff", "#gggggg", "0a62c2", "blue", "preset:nope", "auto:nope", "", null, 7]) expect(C.colorOk(c), String(c)).toBeNull();
    for (const typed of ["blue", "preset:teal", "#ABC", "#0A62C2", "#123456"]) expect(C.colorOk(S.canonicalIdentityColor(typed)), typed).toBe(S.canonicalIdentityColor(typed));
    for (const v of [[], ["name"], ["ring", "bar"], ["name", "name"], ["glow"], "name", null, [1], ["name", "bar", "ring", "name"]]) {
      expect(C.placesOk(v), JSON.stringify(v)).toEqual(S.canonicalPlacements(v));
    }
  });
  it("a custom colour is drawn as it is; its name text uses each mode's readable shade", () => {
    const id = C.identityOf({ color: { person: "#202060", auto: "auto:sea" }, color_show: { person: ["name"] } }, { off: false });
    expect([id.light, id.dark]).toEqual(["#202060", "#202060"]);
    expect([id.nameLight, id.nameDark]).toEqual([SC.readableShade("#202060", "light"), SC.readableShade("#202060", "dark")]);
    expect(id.nameDark, "too dark for a dark page: lightened").not.toBe("#202060");
  });
});

const ITEMS = [
  { name: "alpha", status: "running", backend: "claude-code", tags: [], color: { auto: "auto:sea" }, color_show: {} },
  { name: "beta", status: "running", backend: "codex", tags: [], color: { person: "preset:red", auto: "auto:sand" }, color_show: { person: ["name"] } },
  { name: "gamma", status: "running", backend: "codex", tags: [], color: { agent: "preset:violet", role: "#123456", auto: "auto:plum" }, color_show: { agent: ["ring"] } },
  { name: "delta", status: "running", backend: "codex", tags: [], color: { person: "#0a62c2", auto: "auto:moss" }, color_show: { person: [] } },
];
async function mountNav() {
  pg = page({ url: "http://127.0.0.1:19280/ui/chat/alpha", storage: { agend_tour_done: "1" } });
  g.fetch = fetchFake;
  await pg.mount(h(nav.InstanceNav, { route: { panel: "chat", instance: "alpha" }, items: ITEMS, loaded: true }));
  await settle(2);
}
const row = (name: string) => pg!.root.querySelectorAll("#instanceList a.inst").find((a: any) => a.getAttribute("href")?.endsWith(`/${name}`)) as any;
const cls = (name: string) => row(name).className.split(/\s+/).filter((c: string) => c === "idc" || c.startsWith("id-")).sort();
const prop = (name: string, k: string) => (row(name).style as any)[k] ?? row(name).style.getPropertyValue?.(k) ?? undefined;

describe("the sidebar row", () => {
  afterEach(async () => { await setHost({ "color.show": null, "color.off": null, "fx.show": null }); themes.setThemesShown(true); });
  it("default places (#2056: all three); a person's choice; the agent's; nowhere — and both modes' colours set through the CSSOM", async () => {
    await mountNav();
    expect(cls("alpha")).toEqual(["id-bar", "id-name", "id-ring", "idc"]);
    expect([prop("alpha", "--id-light"), prop("alpha", "--id-dark")]).toEqual(["#3f7286", "#92c2d4"]);
    expect(cls("beta")).toEqual(["id-name", "idc"]);
    expect([prop("beta", "--id-light"), prop("beta", "--id-name-light")]).toEqual(["#cf222e", "#cf222e"]);
    expect(cls("gamma")).toEqual(["id-ring", "idc"]);
    expect(prop("gamma", "--id-dark")).toBe("#d2a8ff");                       // the agent's preset, while themes are shown
    expect(cls("delta"), "shown nowhere: nothing painted").toEqual([]);
    expect(prop("delta", "--id-light")).toBeFalsy();
  });
  it("choosing all three as the default unsets it (the built-in default, not a copy of it); another choice, ring + bar included, is kept", async () => {
    await mountNav();
    C.setDefaultPlaces(["name"]);
    expect(prefs.prefInForce("color.show")).toEqual({ value: ["name"] });
    C.setDefaultPlaces(["bar", "ring"]);
    expect(prefs.prefInForce("color.show"), "#2056: the old default is now a choice of its own").toEqual({ value: ["bar", "ring"] });
    C.setDefaultPlaces(["ring", "bar", "name"]);
    expect(prefs.prefInForce("color.show")).toEqual({ value: null });
    await flush(); await settle();
  });
  it("the host's default places, and Turn off colours: nothing painted, the picks kept", async () => {
    await setHost({ "color.show": ["name", "ring"] });
    await mountNav();
    expect(cls("alpha")).toEqual(["id-name", "id-ring", "idc"]);
    expect(cls("beta"), "a person's choice still wins").toEqual(["id-name", "idc"]);
    await setHost({ "color.off": true });
    await settle(2);
    for (const n of ["alpha", "beta", "gamma"]) { expect(cls(n), n).toEqual([]); expect(prop(n, "--id-light"), n).toBeFalsy(); }
    await setHost({ "color.off": null });
    await settle(2);
    expect(cls("beta"), "back again").toEqual(["id-name", "idc"]);
  });
  it("themes hidden: the agent's colour and places are skipped (its bot's colour and the host's places show)", async () => {
    await mountNav();
    themes.setThemesShown(false);
    await settle(2);
    expect(cls("gamma")).toEqual(["id-bar", "id-name", "id-ring", "idc"]);
    expect(prop("gamma", "--id-light")).toBe("#123456");
  });
});

describe("the Color dialog", () => {
  async function open(name = "alpha") {
    pg = page({ url: `http://127.0.0.1:19280/ui/chat/${name}`, storage: { agend_tour_done: "1" } });
    g.fetch = fetchFake;
    posts = [];
    await pg.mount(h(C.ColorDialogHost, {}));
    C.openColorDialog(name, ITEMS.find((i) => i.name === name));
    await settle(3);
    return pg.root.querySelector("dialog");
  }
  const button = (d: any, text: string) => [...d.querySelectorAll("button")].find((b: any) => b.textContent.trim() === text) as any;
  it("pick a preset and the places, then Save: the person's choice is posted", async () => {
    profile = { color: null, color_show: null };
    const d = await open();
    expect(d.textContent).toContain("Shown now: an automatic colour.");
    d.querySelector('.idc-swatch[aria-label="Blue"]').click();
    await settle();
    const ring = [...d.querySelectorAll(".idc-places label")].find((l: any) => l.textContent.includes("Ring")) as any;
    ring.querySelector("input").dispatchEvent(new g.Event("change", { bubbles: true }));
    await settle();
    button(d, "Save").click();
    await settle(3);
    expect(posts).toEqual([{ url: "/api/profile/alpha", body: { color: "preset:blue", color_show: ["name", "bar"] } }]);   // all three by default, Ring unticked
    expect(pg!.root.querySelector("dialog"), "closed after saving").toBeFalsy();
  });
  it("a custom colour, and Reset clears the colour and the places", async () => {
    profile = { color: "#112233", color_show: ["name"] };
    const d = await open();
    expect(d.querySelector(".idc-hex").value).toBe("#112233");
    button(d, "Reset").click();
    await settle(3);
    expect(posts).toEqual([{ url: "/api/profile/alpha", body: { color: null, color_show: null } }]);
  });
  it("with colours off on this host it says so, and still saves", async () => {
    await setHost({ "color.off": true });
    profile = { color: null, color_show: null };
    const d = await open();
    expect(d.textContent).toContain("Colours are turned off on this host");
    await setHost({ "color.off": null });
  });
  it("the ⋯ entry opens it (and is offered on the public link too)", () => {
    const item = C.colorMenuItem("alpha", ITEMS[0]);
    expect([item.key, item.label]).toEqual(["identity-color", "Colour…"]);
  });
});

describe("Settings → Web appearance", () => {
  async function mountSettings() {
    pg = page({ url: "http://127.0.0.1:19280/settings/appearance", storage: { agend_tour_done: "1" } });
    pg.document.body.dataset.mode = "full";
    g.fetch = fetchFake;
    posts = [];
    const { AppearanceSection } = await import("/ui/js/settings-appearance.js");
    await pg.mount(h(AppearanceSection, {}));
    await settle(3);
    return pg.root.querySelector(".s-colors");
  }
  afterEach(async () => { await setHost({ "color.show": null, "color.off": null }); });
  it("the default places and Turn off colours are host prefs", async () => {
    const card = await mountSettings();
    const [name] = [...card.querySelectorAll(".idc-places input")];
    expect([...card.querySelectorAll(".idc-places input")].map((i: any) => i.checked), "#2056: all three by default").toEqual([true, true, true]);
    name.dispatchEvent(new g.Event("change", { bubbles: true }));
    card.querySelector(".s-colors-off").checked = true;
    card.querySelector(".s-colors-off").dispatchEvent(new g.Event("change", { bubbles: true }));
    await flush(); await settle();
    expect(host).toMatchObject({ "color.show": ["bar", "ring"], "color.off": true });
  });
  it("Restore defaults puts the appearance settings back and turns this person's custom CSS off", async () => {
    await setHost({ "color.show": ["name"], "color.off": true, "fx.show": false, "card.size": "l", "card.sizeByInstance": { alpha: "s" },
      "widget.sidebar": { spec: { v: 1, title: "Mine", items: [{ type: "stat", label: "Idle", bind: "fleet.idle" }] }, data: {} } });
    expect(host["widget.sidebar"], "set before the restore").toBeTruthy();
    await mountSettings();
    const { restoreAppearanceDefaults } = await import("/ui/js/settings-appearance.js");
    expect(await restoreAppearanceDefaults()).toEqual({ ok: true });
    await flush(); await settle();
    for (const k of ["color.show", "color.off", "fx.show", "card.size", "card.sizeByInstance", "widget.sidebar"]) expect(host[k], k).toBeUndefined();
    expect(posts.find((p) => p.url === "/ui/owner-css/restore")?.body).toEqual({ sha: null });
  });
  it("its button asks first, saying what it resets; answering no resets nothing, yes resets", async () => {
    await setHost({ "color.off": true });
    await mountSettings();
    const asked: string[] = [];
    let yes = false;
    g.confirm = (m: string) => { asked.push(m); return yes; };          // the harness answers the app's question with this
    try {
      posts = [];
      pg!.root.querySelector(".s-restore button").click();
      await settle(3); await flush(); await settle();
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("The colours people picked for agents, installed mods, uploaded effects and the card limits stay as they are.");
      expect([host["color.off"], posts], "no: nothing reset").toEqual([true, []]);
      yes = true;
      pg!.root.querySelector(".s-restore button").click();
      await settle(3); await flush(); await settle();
      expect(host["color.off"], "yes: reset").toBeUndefined();
      expect(posts.some((p) => p.url === "/ui/owner-css/restore")).toBe(true);
    } finally { delete g.confirm; }
  });
  it("the tab is called Web appearance (網頁外觀)", async () => {
    const i18n = await import("/assets/app-i18n.js");
    await import("/ui/js/settings-strings.js");
    expect(i18n.t("settings.sec_appearance")).toBe("Web appearance");
  });
});
