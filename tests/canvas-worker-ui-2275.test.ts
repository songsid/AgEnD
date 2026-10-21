import { afterEach, describe, expect, it, vi } from "vitest";
import { fire } from "./helpers/mini-dom.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
let pg: AppPage | null = null;
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } vi.unstubAllGlobals(); });
describe("#2275 neutral UI feature boundary", () => {
  it("strict status opt-in: missing or truthy non-boolean values remain off", async () => {
    const { appStore, applyStatus } = await import("/assets/app-store.js");
    for (const value of [undefined, null, 1, "true", false]) { applyStatus({ instances: [], canvas_worker: value }); expect(appStore.get().canvasWorker).toBe(false); }
    applyStatus({ instances: [], canvas_worker: true }); expect(appStore.get().canvasWorker).toBe(true);
  });
  it("does not load an optional module off; fences late loading and removes its mounted UI on disable", async () => {
    pg = page(); const { appStore } = await import("/assets/app-store.js"); const { experimentalComponent } = await import("/assets/feature-flags.js");
    appStore.set({ canvasWorker: false }); let release: (v: any) => void = () => {};
    const load = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const Optional = experimentalComponent(load, (m: any) => m.Optional);
    await pg.mount(h(Optional, {})); await settle(); expect(load).not.toHaveBeenCalled();
    appStore.set({ canvasWorker: true }); await settle(); expect(load).toHaveBeenCalledOnce();
    appStore.set({ canvasWorker: false }); await settle(); release({ Optional: () => h("p", {}, "optional player") }); await settle();
    expect(pg.root.textContent).not.toContain("optional player");
    appStore.set({ canvasWorker: true }); await settle(); release({ Optional: () => h("p", {}, "optional player") }); await settle();
    expect(pg.root.textContent).toContain("optional player");
    appStore.set({ canvasWorker: false }); await settle(); expect(pg.root.textContent).not.toContain("optional player");
  });
  it("mixed mod review preserves ambient choices while hiding Canvas Worker parts", async () => {
    const { appStore } = await import("/assets/app-store.js"); const { defaultChoice } = await import("/ui/js/settings-mods.js");
    const plan = { items: [{ part: "effect" }, { part: "ambient" }, { part: "theme" }] };
    appStore.set({ canvasWorker: false }); expect(defaultChoice(plan)).toMatchObject({ effects: false, ambient: true, theme: true });
    appStore.set({ canvasWorker: true }); expect(defaultChoice(plan)).toMatchObject({ effects: true, ambient: true, theme: true });
  });
});

it("local-admin Appearance exposes the switch with confirmed config writes, off makes no library reads", async () => {
  pg = page({ url: "http://127.0.0.1:19280/settings/appearance" });
  const calls: string[] = [], writes: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => { calls.push(url); if (init.method === "PUT") writes.push({ url, body: JSON.parse(init.body), headers: init.headers }); return { ok: true, status: 200, json: async () => url === "/ui/owner-css/state" ? { active: null, pending: null, text: "", versions: [], assets: [], limits: { maxAssets: 16 } } : {} }; }));
  vi.stubGlobal("AgendAuth", { trialSession: async () => ({ localAdmin: true }) });
  const { appStore } = await import("/assets/app-store.js"); appStore.set({ canvasWorker: false });
  const { AppearanceSection } = await import("/ui/js/settings-appearance.js"); await pg.mount(h(AppearanceSection, {})); await settle(); await settle();
  expect(pg.root.textContent).toContain("Experimental: Canvas Worker effects");
  expect(pg.root.querySelector(".s-experimental-effects input").checked).toBe(false);
  expect(pg.root.querySelector(".s-effects")).toBeNull(); expect(calls).not.toContain("/ui/effects");
  const input = pg.root.querySelector(".s-experimental-effects input"); input.checked = true; fire(input, "change"); await settle(); await settle();
  expect(writes).toEqual([expect.objectContaining({ url: "/api/settings/fleet/web", body: { experimental: { canvas_worker: true } }, headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }) })]);
});

it("ambient controls remain identical with the experimental switch off or on", async () => {
  pg = page(); const { appStore } = await import("/assets/app-store.js");
  const { themesStore } = await import("/assets/app-themes.js"); const { ambientMenuItems } = await import("/ui/js/chat-ambient.js");
  themesStore.set({ ambient: { own: { loop: {}, click: {} } } }); const clear = vi.fn();
  appStore.set({ canvasWorker: false }); const off = ambientMenuItems("own", { publicLink: false, clear });
  appStore.set({ canvasWorker: true }); const on = ambientMenuItems("own", { publicLink: false, clear });
  expect(on.map((item: any) => ({ key: item.key, label: item.label }))).toEqual(off.map((item: any) => ({ key: item.key, label: item.label })));
  off.find((item: any) => item.key === "ambient-clear-loop").onSelect(); expect(clear).toHaveBeenCalledWith("own", "loop");
});

it("off chat/settings static import graph contains no Canvas Worker metadata or runtime modules", async () => {
  const { readFileSync } = await import("node:fs"), { resolve, dirname } = await import("node:path");
  const seen = new Set<string>(), pending = ["src/ui/panel-chat.js", "src/ui/settings-appearance.js"];
  while (pending.length) {
    const path = resolve(pending.pop()!); if (seen.has(path)) continue; seen.add(path);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?["']([^"']+)["']/g)) {
      const spec = match[1]; const dependency = spec.startsWith("/assets/") ? resolve("src/ui/shared", spec.slice(8)) : spec.startsWith("/ui/js/") ? resolve("src/ui", spec.slice(7)) : spec.startsWith(".") ? resolve(dirname(path), spec) : null;
      if (dependency?.endsWith(".js")) pending.push(dependency);
    }
  }
  expect([...seen].filter(path => /\/(?:effect-[^/]+|app-effects|chat-effects|chat-effect-posters|effects-waker|settings-effects|settings-owner-effects|display-metadata)\.js$/.test(path))).toEqual([]);
});

it("a rejected experimental switch write releases busy, explains failure, and accepts a retry on the same card", async () => {
  pg = page({ url: "http://127.0.0.1:19280/settings/appearance" });
  let puts = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
    if (init.method === "PUT") { puts++; if (puts === 1) throw Error("injected transport failure"); }
    return { ok: true, status: 200, json: async () => url === "/ui/owner-css/state" ? { active: null, pending: null, text: "", versions: [], assets: [], limits: { maxAssets: 16 } } : {} };
  }));
  vi.stubGlobal("AgendAuth", { trialSession: async () => ({ localAdmin: true }) });
  const { appStore } = await import("/assets/app-store.js"); appStore.set({ canvasWorker: false });
  const { AppearanceSection } = await import("/ui/js/settings-appearance.js"); await pg.mount(h(AppearanceSection, {})); await settle(); await settle();
  const card = pg.root.querySelector(".s-experimental-effects"), input = card.querySelector("input");
  input.checked = true; fire(input, "change"); await settle(); await settle();
  expect(input.disabled).toBe(false); expect(card.querySelector('[role="alert"]')?.textContent).toBe("Could not change this setting. Try again."); expect(appStore.get().canvasWorker).toBe(false);
  input.checked = true; fire(input, "change"); await settle(); await settle();
  expect(puts).toBe(2); expect(input.disabled).toBe(false); expect(appStore.get().canvasWorker).toBe(true); expect(card.querySelector('[role="alert"]')).toBeNull(); expect(pg.root.querySelector(".s-experimental-effects")).toBe(card);
});
