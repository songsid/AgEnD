/**
 * #2347: the Settings panel's "You" group (Preferences, Web appearance) saves with the bar's Save — one staged "Your
 * preferences" change (app-prefs holds them while Settings is open); Save sends /ui/prefs and no apply job; Discard puts
 * back; this device's own switches are staged too; the fleet's Canvas Worker switch is a staged fleet change; Restore
 * defaults saves at once; leaving Settings asks, and Discard puts back. (app-prefs' hold itself: web-settings-you-2347.)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniEvent } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const prefsAttr = (values: Record<string, unknown>, rev = 1) => JSON.stringify({ rev, values });
/** AgendTheme as theme.js has it: `set` shows the theme and stores it in this browser at once (before savePref). */
const themeStub = (shown: string, record: (v: string) => void) => { let cur = shown; return { get: () => cur, set: (v: string) => {
  cur = v; record(v);
  try { if (v === "system") (globalThis as any).localStorage.removeItem("agend_theme"); else (globalThis as any).localStorage.setItem("agend_theme", v); } catch { /* none */ }
} }; };

describe("the Settings panel: the \"You\" group saves with the bar", () => {
  const schema = buildSettingsImpactSchema();
  let p: AppPage, sent: Array<{ method: string; path: string; body: any }> = [], host: Record<string, unknown> = {}, rev = 1, prefsFail = false;
  const realFetch = (globalThis as any).fetch;
  const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method, path, body });
    const answer = (() => {
      if (path === "/ui/prefs" && method === "POST" && prefsFail) return { __status: 400, error: "nope" };
      if (path === "/ui/prefs") {
        if (method === "POST") { for (const [k, v] of Object.entries(body.set)) { if (v === null) delete host[k]; else host[k] = v; } rev++; }
        return { values: { ...host }, rev };
      }
      if (method === "POST" && path === "/api/settings/apply") return { id: "job-1", status: "done", targets: [] };
      if (method === "GET" && path === "/api/settings/apply/job-1") return { id: "job-1", status: "done", targets: [] };
      if (method !== "GET") return { ok: true };
      if (path === "/api/settings/schema") return schema;
      if (path === "/api/settings/fleet/raw") return { defaults: {}, instances: {}, channels: [], web: {} };
      if (path === "/api/settings/classic") return { channels: {}, defaults: {} };
      if (path === "/api/fleet") return { version: "2.4.0", instances: [] };
      if (path === "/ui/profile") return { name: "", shown: "", id: "", bound: false };
      if (path === "/ui/owner-css/state") return { active: null, pending: null, text: "", versions: [], assets: [], limits: { maxAssets: 16 } };
      if (path.startsWith("/ui/")) return {};
      return [];
    })();
    const status = (answer as any)?.__status ?? 200;
    return { ok: status === 200, status, json: async () => answer };
  };
  const theme = vi.fn();
  beforeAll(() => {
    p = page({ url: "http://127.0.0.1:19282/settings/device", storage: { agend_prefs_synced: "1", agend_tour_done: "1" } });
    p.document.documentElement.setAttribute("data-prefs", prefsAttr({ theme: "light" }, 1));
    host = { theme: "light" };
    (globalThis as any).fetch = fakeFetch;
    (globalThis as any).AgendTheme = themeStub("light", theme);
    (globalThis as any).AgendAuth = { trialSession: async () => ({ localAdmin: true }) };
  });
  afterAll(() => { p.restore(); (globalThis as any).fetch = realFetch; delete (globalThis as any).AgendTheme; delete (globalThis as any).AgendAuth; });
  beforeEach(() => { sent = []; prefsFail = false; theme.mockClear(); (globalThis as any).confirm = () => true; p.window.confirm = () => true; });
  afterEach(async () => {
    await p.unmount(); await settle(4);
    const { resetOperation } = await import("/ui/js/settings-apply.js");
    resetOperation();
  });
  const open = async (section: "device" | "appearance") => {
    const { SettingsPanel } = await import("/ui/js/panel-settings.js");
    await p.mount(h(SettingsPanel, { route: { panel: "settings", section }, navKey: `settings:${section}` }));
    await settle(12);
  };
  const $ = (sel: string) => p.root.querySelector(sel) as any;
  const bar = () => $(".s-pending");
  const button = (label: string, root: any = p.root) => root.querySelectorAll("button").find((b: any) => b.textContent.trim() === label);
  const pick = async (el: any, v: string) => { el.value = v; fire(el, "change"); await settle(6); };
  const check = async (el: any, on: boolean) => { el.checked = on; fire(el, "change"); await settle(6); };
  const prefPosts = () => sent.filter((s) => s.method === "POST" && s.path === "/ui/prefs").map((s) => s.body.set);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("Preferences: the theme is shown at once, staged as one change, and saved by Save (no apply job)", async () => {
    await open("device");
    await pick($("select[aria-label=Theme]"), "dark");
    await wait(450);
    const before = [theme.mock.calls.at(-1), bar()?.textContent.includes("1 unsaved change(s)"), prefPosts()];
    await (button("Save", bar()).click(), settle(12));
    await wait(50); await settle(6);
    expect([before, prefPosts(), !!bar(), sent.some((s) => s.path === "/api/settings/apply")])
      .toEqual([[["dark"], true, []], [{ theme: "dark" }], false, false]);
  });
  it("over the temporary public link the bar still saves this person's own choices (this browser only, as before)", async () => {
    p.document.body.setAttribute("data-public-link", "1");
    try {
      await open("device");
      const was = (globalThis as any).AgendTheme.get();
      await pick($("select[aria-label=Theme]"), was === "dark" ? "light" : "dark");
      const shown = !!bar();
      button("Save", bar()).click(); await settle(12);
      await wait(450);
      expect([shown, !!bar(), prefPosts(), (globalThis as any).AgendTheme.get() !== was]).toEqual([true, false, [], true]);
      // Kept in this browser only: put this browser's copy back for the next test (the host still has `was`).
      (globalThis as any).AgendTheme.set(was); (globalThis as any).localStorage.setItem("agend_theme", was);
    } finally { p.document.body.removeAttribute("data-public-link"); }
  });
  it("Discard puts the theme back and sends nothing", async () => {
    await open("device");
    const was = (globalThis as any).AgendTheme.get();
    await pick($("select[aria-label=Theme]"), was === "dark" ? "light" : "dark");
    button("Discard", bar()).click(); await settle(8);
    await wait(450);
    expect([(globalThis as any).AgendTheme.get(), !!bar(), prefPosts(), $("select[aria-label=Theme]").value]).toEqual([was, false, [], was]);
  });
  it("Web appearance: colours off (synced) and following reduced motion (this device) are two unsaved changes; Discard puts both back", async () => {
    const motion = await import("/assets/fx-motion.js");
    const colors = await import("/assets/identity-color.js");
    await open("appearance");
    await check($(".s-colors-off"), true);
    await check($("#fx-follow-reduced-motion"), true);
    const during = [colors.colorsOff(), motion.followsReducedMotion(), bar()?.textContent.includes("2 unsaved change(s)")];
    button("Discard", bar()).click(); await settle(8);
    await wait(450);
    expect([during, colors.colorsOff(), motion.followsReducedMotion(), !!bar(), prefPosts()]).toEqual([[true, true, true], false, false, false, []]);
  });
  it("the fleet's Canvas Worker switch is a staged fleet change: nothing written until Save, then its PUT and the apply", async () => {
    await open("appearance");
    const box = $(".s-experimental-effects input[type=checkbox]");
    await check(box, !box.checked);
    const before = sent.filter((s) => s.method === "PUT").length;
    const cost = bar()?.textContent.includes("Immediately");          // the impact table's, not a guess
    button("Save", bar()).click(); await settle(20);
    expect([cost, before, sent.filter((s) => s.method === "PUT").map((s) => [s.path, s.body]), sent.some((s) => s.method === "POST" && s.path === "/api/settings/apply")])
      .toEqual([true, 0, [["/api/settings/fleet/web", { experimental: { canvas_worker: box.checked } }]], true]);
  });
  it("Restore defaults (a confirmed action) saves at once, Settings open or not: nothing staged", async () => {
    await open("appearance");
    await check($(".s-colors-off"), true);
    button("Restore defaults").click(); await settle(12);
    await wait(450); await settle(4);
    expect([!!bar(), prefPosts().some((set) => set["color.off"] === null || set["color.off"] === false)]).toEqual([false, true]);
  });
  const pagehide = () => { const e = new MiniEvent("pagehide", {}); (e as any).eventPhase = 2; (e as any).target = p.window; (p.window as any)._fire(e, false); };
  it("#2380 review: a reload or a closed tab (pagehide) puts back what was not saved — a device switch and a held theme", async () => {
    const motion = await import("/assets/fx-motion.js");
    await open("appearance");
    await check($("#fx-follow-reduced-motion"), true);
    await open("device");
    const was = (globalThis as any).AgendTheme.get();
    await pick($("select[aria-label=Theme]"), was === "dark" ? "light" : "dark");
    const during = [motion.followsReducedMotion(), bar()?.textContent.includes("2 unsaved change(s)")];
    pagehide(); await settle(8);
    await wait(450);
    expect([during, motion.followsReducedMotion(), (globalThis as any).AgendTheme.get(), !!bar(), prefPosts()]).toEqual([[true, true], false, was, false, []]);
  });
  it("#2380 review: leaving Settings with a device switch unsaved puts it back (the leave guard)", async () => {
    const motion = await import("/assets/fx-motion.js");
    const nav = await import("/assets/app-nav.js");
    nav.startRouter(p.window);
    nav.navigate("/settings/appearance");
    await open("appearance");
    await check($("#fx-follow-reduced-motion"), true);
    const during = motion.followsReducedMotion();
    nav.navigate("/ui/fleet"); await settle(8);                       // the harness answers the question: Discard
    expect([during, motion.followsReducedMotion()]).toEqual([true, false]);
    nav.navigate("/settings/appearance"); await settle(4);
  });
  it("#2380 review: a refused preferences write is said even when the same Save carries a fleet change (which goes on)", async () => {
    const T = await import("/assets/ui-toast.js");
    const { SettingsPanel } = await import("/ui/js/panel-settings.js");
    await p.mount(h("div", {}, h(SettingsPanel, { route: { panel: "settings", section: "device" }, navKey: "settings:device" }), h(T.Toasts, {})));
    await settle(12);
    const was = (globalThis as any).AgendTheme.get();
    await pick($("select[aria-label=Theme]"), was === "dark" ? "light" : "dark");
    await p.mount(h("div", {}, h(SettingsPanel, { route: { panel: "settings", section: "appearance" }, navKey: "settings:appearance" }), h(T.Toasts, {})));
    await settle(12);
    const box = $(".s-experimental-effects input[type=checkbox]");
    await check(box, !box.checked);
    prefsFail = true;
    button("Save", bar()).click(); await settle(20);
    await wait(50); await settle(8);
    const toasts = p.root.querySelectorAll(".toast").map((x: any) => x.textContent).join("\n");
    expect([toasts.includes("Some of your preferences were not saved"), sent.some((s) => s.method === "PUT" && s.path === "/api/settings/fleet/web"),
      (globalThis as any).AgendTheme.get()]).toEqual([true, true, was]);
  });
  it("leaving Settings with a preference unsaved asks; Discard puts it back", async () => {
    const nav = await import("/assets/app-nav.js");
    nav.startRouter(p.window);
    nav.navigate("/settings/device");
    await open("device");
    const was = (globalThis as any).AgendTheme.get();
    await pick($("select[aria-label=Theme]"), was === "dark" ? "light" : "dark");
    nav.navigate("/ui/fleet"); await settle(8);
    const dialog = p.root.querySelector("button[data-confirm=yes]") ?? null;
    if (dialog) { dialog.click(); await settle(8); }
    await p.unmount(); await wait(5); await settle(4);
    expect([(globalThis as any).AgendTheme.get(), prefPosts()]).toEqual([was, []]);
  });
});
