import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const source = readFileSync(new URL("../src/ui/shared/theme.js", import.meta.url), "utf8");
const g = globalThis as any;
let pg: AppPage | undefined;
const realFetch = g.fetch;
afterEach(async () => {
  if (pg) { await pg.unmount(); pg.restore(); pg = undefined; }
  delete g.AgendTheme; g.fetch = realFetch;
  (await import("/assets/app-i18n.js")).setLang("en");
});
function boot(storage: Record<string, string> = {}) {
  pg = page({ storage });
  const window: any = {};
  vm.runInNewContext(source, { document: { documentElement: pg.document.documentElement }, window, localStorage: g.localStorage });
  g.AgendTheme = window.AgendTheme;
  g.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  return g.AgendTheme;
}

describe("M3368 built-in colours in the existing theme controller", () => {
  it("serves the shared picker imported by both shipped shells", async () => {
    const { isServedAsset } = await import("../src/auth-api.js");
    expect(isServedAsset("theme-picker.js")).toBe(true);
  });
  it("paints the browser palette before mounting and preserves it when appearance changes", () => {
    const theme = boot({ agend_theme: "light", agend_palette: "mint" });
    expect(pg!.document.documentElement.getAttribute("data-palette")).toBe("mint");
    theme.set("dark");
    expect([theme.get(), theme.getPalette(), g.localStorage.getItem("agend_palette")]).toEqual(["dark", "mint", "mint"]);
  });
  it("previews both choices without persisting; cancel restores and apply keeps them", () => {
    const theme = boot({ agend_theme: "light", agend_palette: "mint" });
    expect(typeof theme.beginPreview).toBe("function");
    const preview = theme.beginPreview(); preview.update("dark", "violet");
    expect([theme.get(), theme.getPalette(), g.localStorage.getItem("agend_palette")]).toEqual(["dark", "violet", "mint"]);
    preview.cancel(); expect([theme.get(), theme.getPalette()]).toEqual(["light", "mint"]);
    const next = theme.beginPreview(); next.update("system", "sky"); next.commit();
    expect([theme.get(), theme.getPalette(), g.localStorage.getItem("agend_palette"), g.localStorage.getItem("agend_theme")]).toEqual(["system", "sky", "sky", null]);
  });
  it("an outside choice retires a preview so its cancel cannot replace that choice", () => {
    const theme = boot({ agend_theme: "light" });
    expect(typeof theme.beginPreview).toBe("function");
    const preview = theme.beginPreview(); preview.update("dark", "sky");
    theme.set("light"); preview.cancel();
    expect([theme.get(), theme.getPalette()]).toEqual(["light", ""]);
  });
  it("keeps both rapid choices before the next render", async () => {
    const theme = boot({ agend_theme: "dark", agend_palette: "mint" });
    const { ThemePicker } = await import("/assets/theme-picker.js");
    await pg!.mount(h(ThemePicker, { onClose() {} }));
    const radios = [...pg!.root.querySelectorAll("input")] as any[];
    const neutral = radios.find(x => x.getAttribute("name") === "builtin-palette" && x.value === "");
    const light = radios.find(x => x.getAttribute("name") === "builtin-appearance" && x.value === "light");
    neutral.checked = true; fire(neutral, "change");
    light.checked = true; fire(light, "change");
    await settle();
    expect([theme.get(), theme.getPalette()]).toEqual(["light", ""]);
  });
  for (const [lang, other, title, names] of [
    ["en", "Other…", "Colours", ["Default", "Clear Sky", "Meadow", "Night Violet", "Mint"]],
    ["zh-TW", "其他…", "配色", ["預設", "晴空", "青草", "夜紫", "薄荷"]],
  ] as const) it(`${lang}: the shared quick selector opens five radio swatches; cancel changes nothing`, async () => {
    const theme = boot();
    const i18n = await import("/assets/app-i18n.js"); i18n.setLang(lang);
    const { DevicePrefs } = await import("/assets/app-shell.js");
    await pg!.mount(h(DevicePrefs, { labels: true, fields: ["theme"] }));
    const select = pg!.root.querySelector("select") as any;
    expect([...select.querySelectorAll("option")].map((x: any) => x.value)).toEqual(["system", "light", "dark", "other"]);
    expect([...select.querySelectorAll("option")].find((x: any) => x.value === "other").textContent).toBe(other);
    select.value = "other"; fire(select, "change"); await settle();
    const dialog = pg!.root.querySelector("dialog") as any;
    expect(dialog?.getAttribute("aria-label")).toBe(title);
    expect([...dialog.querySelectorAll('input[name="builtin-palette"]')].map((x: any) => x.value)).toEqual(["", "sky", "meadow", "violet", "mint"]);
    for (const name of names) expect(dialog.textContent).toContain(name);
    const mint = [...dialog.querySelectorAll("input")].find((x: any) => x.value === "mint") as any;
    mint.checked = true; fire(mint, "change"); await settle();
    expect(theme.getPalette()).toBe("mint");
    fire(dialog.querySelector(".theme-cancel"), "click"); await settle();
    expect([theme.getPalette(), pg!.root.querySelector("dialog")]).toEqual(["", null]);
  });
});
