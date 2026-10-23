/**
 * #2347: the Settings "You" group (Preferences, Web appearance) saves with the bar's Save like every Settings change.
 * - app-prefs.js: while Settings is open (holdPrefs) a "You" preference is shown at once but not sent; savePrefsHeld
 *   sends them (one write), discardHeldPrefs puts back the host's (theme, language … every onPrefsChanged reader); a
 *   choice back to what it was is no change; other keys (the sidebar's) still save at once; Restore defaults
 *   (withoutHold) saves at once; Settings closing with choices held puts them back.
 * (The panel: web-settings-you-panel-2347.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDom, type MiniPage } from "./helpers/mini-dom.js";

const prefsAttr = (values: Record<string, unknown>, rev = 1) => JSON.stringify({ rev, values });
/** AgendTheme as theme.js has it: `set` shows the theme and stores it in this browser at once (before savePref). */
const themeStub = (shown: string, record: (v: string) => void) => { let cur = shown; return { get: () => cur, set: (v: string) => {
  cur = v; record(v);
  try { if (v === "system") (globalThis as any).localStorage.removeItem("agend_theme"); else (globalThis as any).localStorage.setItem("agend_theme", v); } catch { /* none */ }
} }; };

describe("app-prefs: holding the \"You\" preferences while Settings is open", () => {
  let pg: MiniPage, requests: Array<{ method: string; body: any }>, hostValues: Record<string, unknown>, hostRev: number, failPost: boolean;
  const realFetch = globalThis.fetch;
  beforeEach(() => { vi.resetModules(); requests = []; hostValues = {}; hostRev = 1; failPost = false; });
  // A release's put-back runs on a timer: let it run on this test's page, never on the next one's storage.
  afterEach(async () => { await new Promise((r) => setTimeout(r, 5)); pg?.restore(); globalThis.fetch = realFetch; delete (globalThis as any).AgendTheme; });
  async function boot(host: Record<string, unknown>, opts: { publicLink?: boolean } = {}) {
    pg = installDom({ storage: { agend_prefs_synced: "1" } });
    hostValues = { ...host };
    pg.document.documentElement.setAttribute("data-prefs", prefsAttr(hostValues, hostRev));
    if (opts.publicLink) pg.document.body.setAttribute("data-public-link", "1");
    globalThis.fetch = (async (_url: string, init: any = {}) => {
      const method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : null;
      requests.push({ method, body });
      if (method === "POST") {
        if (failPost) return { ok: false, status: 400, json: async () => ({ error: "nope" }) };
        for (const [k, v] of Object.entries(body.set)) { if (v === null) delete hostValues[k]; else hostValues[k] = v; }
        hostRev++;
      }
      return { ok: true, status: 200, json: async () => ({ values: { ...hostValues }, rev: hostRev }) };
    }) as never;
    return await import("/assets/app-prefs.js");
  }
  const posts = () => requests.filter((r) => r.method === "POST").map((r) => r.body.set);
  const ls = (k: string) => pg.storage.get(k) ?? null;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a held choice is shown (cached, in force here) and not sent; Save sends them all in one write", async () => {
    const m = await boot({ theme: "light" });
    const release = m.holdPrefs();
    m.savePref("theme", "dark"); m.savePref("card.size", "l");
    await wait(450);
    const before = [ls("agend_theme"), m.prefInForce("theme"), m.heldPrefsCount(), posts()];
    await m.savePrefsHeld();
    expect([before, posts(), m.heldPrefsCount(), m.hostPref("theme")])
      .toEqual([["dark", { value: "dark" }, 2, []], [{ theme: "dark", "card.size": "l" }], 0, "dark"]);
    release();
  });
  it("Discard puts back the host's value on the page (theme.js too), and sends nothing", async () => {
    const shown = vi.fn();
    (globalThis as any).AgendTheme = themeStub("light", shown);
    const m = await boot({ theme: "light" });
    const release = m.holdPrefs();
    (globalThis as any).AgendTheme.set("dark"); m.savePref("theme", "dark");
    const told = vi.fn(); m.onPrefsChanged(told);
    m.discardHeldPrefs();
    await wait(450);
    expect([ls("agend_theme"), m.prefInForce("theme"), shown.mock.calls.at(-1), [...told.mock.calls[0][0]], posts(), m.heldPrefsCount()])
      .toEqual(["light", { value: "light" }, ["light"], ["theme"], [], 0]);
    release();
  });
  it("a choice back to what it was is no change; the sidebar's own keys still save at once", async () => {
    const m = await boot({ theme: "light" });
    const release = m.holdPrefs();
    m.savePref("theme", "dark"); m.savePref("theme", "light");
    m.savePref("nav.sort", "name");
    await wait(450);
    expect([m.heldPrefsCount(), posts()]).toEqual([0, [{ "nav.sort": "name" }]]);
    release();
  });
  it("another device's change read meanwhile does not undo a held choice on this page", async () => {
    const m = await boot({ theme: "light" });
    const release = m.holdPrefs();
    m.savePref("theme", "dark");
    hostValues = { theme: "light", "card.size": "s" }; hostRev = 5;
    await m.refresh();
    expect([ls("agend_theme"), m.prefInForce("theme"), ls("agend_card_size")]).toEqual(["dark", { value: "dark" }, "s"]);
    release();
  });
  it("a confirmed action (withoutHold) saves at once, and what it set is held no more", async () => {
    const m = await boot({});
    const release = m.holdPrefs();
    m.savePref("card.size", "l");
    m.withoutHold(() => { m.savePref("card.size", "s"); m.savePref("color.off", true); });
    await wait(450);
    expect([m.heldPrefsCount(), posts()]).toEqual([0, [{ "card.size": "s", "color.off": true }]]);
    release();
  });
  it("Settings closing with choices held (neither Save nor Discard) puts them back", async () => {
    const m = await boot({ theme: "light" });
    const release = m.holdPrefs();
    m.savePref("theme", "dark");
    release(); await wait(5);
    expect([ls("agend_theme"), m.heldPrefsCount(), posts()]).toEqual(["light", 0, []]);
  });
  it("…but not when Settings is shown again at once (a language switch remounts it)", async () => {
    const m = await boot({ theme: "light" });
    const release = m.holdPrefs();
    m.savePref("theme", "dark");
    release(); const again = m.holdPrefs(); await wait(5);
    expect([ls("agend_theme"), m.heldPrefsCount()]).toEqual(["dark", 1]);
    again();
  });
  it("a Save the host refuses rejects (the panel says so) and the host's value is shown again", async () => {
    const m = await boot({ theme: "light" });
    const release = m.holdPrefs();
    m.savePref("theme", "dark");
    failPost = true;
    await expect(m.savePrefsHeld()).rejects.toThrow();
    expect(ls("agend_theme")).toBe("light");
    release();
  });
  it("#2380 review: a held choice cached here never outlives a reload — the next load shows the host's value", async () => {
    let m = await boot({ theme: "light" });
    m.holdPrefs();
    m.savePref("theme", "dark");
    const cached = ls("agend_theme");
    const storage = new Map(pg.storage);
    pg.restore(); vi.resetModules();
    pg = installDom({ storage: Object.fromEntries(storage) });
    pg.document.documentElement.setAttribute("data-prefs", prefsAttr({ theme: "light" }, hostRev));
    m = await import("/assets/app-prefs.js");
    expect([cached, ls("agend_theme"), m.prefInForce("theme"), m.heldPrefsCount()]).toEqual(["dark", "light", { value: "light" }, 0]);
  });
  it("over the public link Save keeps the choice in this browser only, as before (no host write)", async () => {
    const m = await boot({ theme: "light" }, { publicLink: true });
    const release = m.holdPrefs();
    m.savePref("theme", "dark");
    await m.savePrefsHeld();
    await wait(450);
    expect([ls("agend_theme"), m.heldPrefsCount(), posts()]).toEqual(["dark", 0, []]);
    release();
  });
});

