import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
let p: AppPage, Panel: any, i18n: any;
let dto: any;
const originalFetch = globalThis.fetch;
const alpha = { version: "1.22.0", source: { commit: "a".repeat(40), channel: "alpha", ref: "release/2.3.5-alpha", modified: false } };
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/settings/agents" });
  globalThis.fetch = (async (path: string) => ({ ok: true, status: 200, json: async () => {
    if (path === "/api/fleet") return dto;
    if (path === "/api/settings/fleet/raw") return { defaults: {}, instances: {}, web: {} };
    if (path === "/api/settings/classic") return { defaults: {}, channels: {} };
    return [];
  } })) as any;
  i18n = await import("/assets/app-i18n.js"); Panel = (await import("/ui/js/panel-settings.js")).SettingsPanel;
});
afterEach(async () => { await p.unmount(); i18n.setLang("en"); vi.unstubAllGlobals(); });
afterAll(() => { p.restore(); globalThis.fetch = originalFetch; });
async function show(build: any, version = "1.22.0") {
  dto = { instances: [], version, build };
  await p.mount(h(Panel, { route: { panel: "settings", section: "agents" }, navKey: `build:${Math.random()}` })); await settle(22);
  return p.root.querySelector(".pill.ver") as any;
}
describe("actual Settings version pill", () => {
  it("keeps a seven-character SHA in the phone slot, updates on resize and removes its listener", async () => {
    let changed: (() => void) | undefined;
    const remove = vi.fn(), media = { matches: true, addEventListener: (_event: string, cb: () => void) => { changed = cb; }, removeEventListener: remove };
    vi.stubGlobal("matchMedia", () => media);
    const link = await show(alpha); expect(link.textContent).toBe("α·aaaaaaa");
    expect(link.getAttribute("aria-label")).toContain("2.3.5-alpha");
    media.matches = false; changed!(); await settle(4); expect(link.textContent).toBe("2.3.5-alpha · aaaaaaaaaaaa");
    await p.unmount(); expect(remove).toHaveBeenCalledWith("change", changed);
  });
  it("shows alpha SHA and links to that commit while preserving package SemVer in the detail", async () => {
    const link = await show(alpha);
    expect(link.textContent).toBe("2.3.5-alpha · aaaaaaaaaaaa");
    expect(link.getAttribute("href")).toBe(`https://github.com/songsid/AgEnD/commit/${"a".repeat(40)}`);
    expect(link.getAttribute("title")).toContain("1.22.0"); expect(link.getAttribute("title")).toContain("a".repeat(40));
    expect(link.getAttribute("aria-label")).toBe(link.getAttribute("title"));
  });
  it.each(["en", "zh-TW"])("localizes modified and unknown source state in %s", async locale => {
    i18n.setLang(locale); const link = await show({ ...alpha, source: { ...alpha.source, modified: null } });
    expect(link.textContent).toContain(locale === "en" ? "changes unknown" : "變更狀態不明");
    await p.unmount(); const changed = await show({ ...alpha, source: { ...alpha.source, channel: "source", modified: true } });
    expect(changed.textContent).toContain(locale === "en" ? "Source build" : "原始碼建置");
    expect(changed.textContent).toContain(locale === "en" ? "modified" : "含未提交變更");
  });
  it("preserves release and old-server labels, and falls back for mismatched or malformed source metadata", async () => {
    for (const build of [null, { ...alpha, version: "9.9.9" }, { ...alpha, source: { ...alpha.source, commit: "not-a-sha" } },
      { version: "2.3.5", source: { ...alpha.source, channel: "release", ref: "v2.3.5" } }]) {
      const link = await show(build, "2.3.5"); expect(link.textContent).toBe("v2.3.5");
      expect(link.getAttribute("href")).toBe("https://github.com/songsid/AgEnD/releases/tag/v2.3.5"); await p.unmount();
    }
    const changed = await show({ version: "2.3.5", source: { ...alpha.source, channel: "release", ref: "v2.3.5", modified: true } }, "2.3.5");
    expect(changed.textContent).toBe("v2.3.5 · aaaaaaaaaaaa (modified)");
  });
});
