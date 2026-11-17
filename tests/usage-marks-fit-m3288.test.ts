/**
 * M-3288 (the user): in the grouped usage view's one line per login (M-3241), a login both stale ("cached at 10:47") and
 * used by no agent (M-3248's ⓘ) overflowed: the cached words ran into the window's bar and the name vanished. There the
 * cached mark is a clock — its words its tooltip and read aloud — and the words show only in every-window rows.
 * The layout itself is measured in a real browser: scripts/manual/smoke/smoke-usage-marks-fit-m3288.mts (the UI gate).
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, expect, it } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";

const H = 3_600_000;
const pct = (label: string, used: number) => ({ type: "percent", label, used, windowMs: 168 * H, resetsAt: new Date(Date.now() + 45 * H).toISOString() });
const CACHED = new Date(Date.now() - 40 * 60_000).toISOString();
const PROVIDERS = [
  { id: "codex", name: "Codex", status: "ok", metrics: [pct("Weekly", 91)] },
  { id: "codex:alpha", name: "Codex (alpha)", profile: "alpha", status: "ok", metrics: [pct("Weekly", 22)] },
  { id: "codex:a-rather-long-profile-name", name: "Codex (a-rather-long-profile-name)", profile: "a-rather-long-profile-name", noAgents: true,
    status: "ok", stale: true, staleCause: "expired", cachedAt: CACHED, hint: "Sign in again", metrics: [pct("Weekly", 86)] },
];
const CSS = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8");

let usage: any, i18n: any, htm: any, pg: AppPage | null = null;
beforeAll(async () => {
  const p0 = page({ storage: { agend_tour_done: "1" } });
  p0.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
  usage = await import("/assets/usage-dialog.js");
  i18n = await import("/assets/app-i18n.js");
  htm = await import("/assets/app-html.js");
  p0.restore();
});
afterEach(async () => {
  if (pg) { await pg.unmount(); pg.restore(); pg = null; }
  usage?.setGroupMode("Codex", "expanded");
  usage?.usageViewStore.set({ compact: false });
  i18n?.setLang("en");
});
async function mount(lang: "en" | "zh-TW", mode: "expanded" | "compact") {
  pg = page({ storage: { agend_tour_done: "1" } });
  i18n.setLang(lang);
  usage.usageViewStore.set({ compact: true });
  usage.setGroupMode("Codex", mode);
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ fetchedAt: new Date().toISOString(), providers: PROVIDERS }) });
  await pg.mount(htm.html`<${usage.UsageBody} owner="" />`);
  await settle(20);
  return pg;
}
const staleRow = (p: AppPage) => [...p.root.querySelectorAll(".u-crow")].find((r: any) => r.querySelector(".u-crow-name")?.textContent === "a-rather-long-profile-name") as any;
const clock = (lang: "en" | "zh-TW") => { i18n.setLang(lang); return usage.usageClock ? usage.usageClock(CACHED) : null; };

it.each(["en", "zh-TW"] as const)("one line (%s): the cached mark is a clock beside the ⓘ — its words its tooltip and read aloud", async (lang) => {
  const p = await mount(lang, "compact");
  const row = staleRow(p);
  expect(row.className).toContain("is-one");
  expect(row.querySelector(".u-na")).toBeTruthy();
  const mark = row.querySelector(".u-crow-stale");
  expect(mark.querySelector(".u-crow-stale-icon")?.getAttribute("aria-hidden")).toBe("true");
  expect(mark.querySelector(".u-crow-stale-icon svg")).toBeTruthy();
  const words = lang === "en" ? /expired · cached at \d{2}:\d{2}/ : /已過期 · 快取於 \d{2}:\d{2}/;
  expect(mark.getAttribute("title")).toMatch(words);
  expect(mark.querySelector(".sr-only").textContent).toMatch(words);
  if (clock(lang)) expect(mark.getAttribute("title")).toContain(clock(lang));
});

it("every window: the same parts — the words show there (the icon is hidden by the stylesheet)", async () => {
  const p = await mount("en", "expanded");
  const mark = staleRow(p).querySelector(".u-crow-stale");
  expect(staleRow(p).className).not.toContain("is-one");
  expect(mark.querySelector(".u-crow-stale-text").textContent).toMatch(/^cached at \d{2}:\d{2}$/);
  expect(mark.querySelector(".u-crow-stale-icon")).toBeTruthy();
});

it("the stylesheet: the clock only in one line, the words only in every window", () => {
  const rule = (sel: string) => { const i = CSS.indexOf(`\n${sel} {`); return i < 0 ? null : CSS.slice(i, CSS.indexOf("}", i)); };   // a rule of its own line
  expect(rule(".u-crow-stale-icon")).toMatch(/display: none/);
  expect(rule(".u-crow.is-one .u-crow-stale-icon")).toMatch(/display: inline-grid/);
  expect(rule(".u-crow.is-one .u-crow-stale")).toMatch(/color: var\(--warn\)/);   // the clock alone is coloured (Fable #4113)
  expect(rule(".u-crow-stale")).not.toMatch(/--warn/);                             // every window: the muted words, as before
  expect(rule(".u-crow.is-one .u-crow-stale-text")).toMatch(/display: none/);
});
