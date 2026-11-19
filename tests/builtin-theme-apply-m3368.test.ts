import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { expect } from "vitest";
const g = globalThis as any, realFetch = g.fetch;
let pg: AppPage | undefined;
function boot(storage: Record<string, string>) {
  pg = page({ storage });
  const window: any = {};
  const source = readFileSync(new URL("../src/ui/shared/theme.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { document: { documentElement: pg.document.documentElement }, window, localStorage: g.localStorage });
  g.AgendTheme = window.AgendTheme;
}
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); } delete g.AgendTheme; g.fetch = realFetch; });
  it("Apply in Look saves its appearance without waiting for the Settings Save bar", async () => {
    boot({ agend_theme: "light", agend_prefs_synced: "1" });
    pg!.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: { theme: "light" } }));
    const saved: unknown[] = [];
    g.fetch = async (_path: string, init: any = {}) => {
      if (init.method === "POST") saved.push(JSON.parse(init.body).set);
      return { ok: true, status: 200, json: async () => ({ rev: 2, values: { theme: "dark" } }) };
    };
    const { holdPrefs, heldPrefsCount, discardHeldPrefs } = await import("/assets/app-prefs.js");
    const release = holdPrefs();
    try {
      const { ThemePicker } = await import("/assets/theme-picker.js");
      await pg!.mount(h(ThemePicker, { onClose() {} }));
      const dark = [...pg!.root.querySelectorAll('input[name="builtin-appearance"]')].find((x: any) => x.value === "dark") as any;
      dark.checked = true; fire(dark, "change"); await settle();
      fire(pg!.root.querySelector(".theme-apply"), "click"); await settle();
      await new Promise(resolve => setTimeout(resolve, 450));
      expect(heldPrefsCount()).toBe(0);
      expect(saved).toContainEqual({ theme: "dark" });
    } finally { discardHeldPrefs(); release(); }
  });
