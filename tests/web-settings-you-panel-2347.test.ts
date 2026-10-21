/**
 * #2347: the Settings panel's "You" group (Preferences, Web appearance) saves with the bar's Save — one staged "Your
 * preferences" change (app-prefs holds them while Settings is open); Save sends /ui/prefs and no apply job; Discard puts
 * back; this device's own switches are staged too; the fleet's Canvas Worker switch is a staged fleet change; Restore
 * defaults saves at once; leaving Settings asks, and Discard puts back. (app-prefs' hold itself: web-settings-you-2347.)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const prefsAttr = (values: Record<string, unknown>, rev = 1) => JSON.stringify({ rev, values });
const themeStub = (shown: string, record: (v: string) => void) => { let cur = shown; return { get: () => cur, set: (v: string) => { cur = v; record(v); } }; };

describe("the Settings panel: the \"You\" group saves with the bar", () => {
  const schema = buildSettingsImpactSchema();
  let p: AppPage, sent: Array<{ method: string; path: string; body: any }> = [], host: Record<string, unknown> = {}, rev = 1;
  const realFetch = (globalThis as any).fetch;
  const fakeFetch = async (path: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method, path, body });
    const answer = (() => {
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
    return { ok: true, status: 200, json: async () => answer };
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
  beforeEach(() => { sent = []; theme.mockClear(); (globalThis as any).confirm = () => true; p.window.confirm = () => true; });
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
    button("Save", bar()).click(); await settle(20);
    expect([before, sent.filter((s) => s.method === "PUT").map((s) => [s.path, s.body]), sent.some((s) => s.method === "POST" && s.path === "/api/settings/apply")])
      .toEqual([0, [["/api/settings/fleet/web", { experimental: { canvas_worker: box.checked } }]], true]);
  });
  it("Restore defaults (a confirmed action) saves at once, Settings open or not: nothing staged", async () => {
    await open("appearance");
    await check($(".s-colors-off"), true);
    button("Restore defaults").click(); await settle(12);
    await wait(450); await settle(4);
    expect([!!bar(), prefPosts().some((set) => set["color.off"] === null || set["color.off"] === false)]).toEqual([false, true]);
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
