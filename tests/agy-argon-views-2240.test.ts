/**
 * #2240 (the rest): agy's Gemini 4 Argon quota has its own line in the full view since #2249, but the compact view
 * (#2447) kept only an account's shortest and longest window, and agy's metrics carried no window length: an agy account
 * showed one bar ("Gemini (session)") and Argon and Claude & others vanished from it. Now each agy metric says its window
 * (5 h / 7 d) and its pool, and an account whose windows come from several pools shows a line per pool in compact.
 *
 * Fixture: tests/fixtures/agy-quota-2026-10-20/summary-daily-cli-ua.json, agy 1.4.3's own /quota on the daily base (REAL,
 * redacted; the daily base asked as agy's CLI asks has the "Gemini Models" group and the "Gemini 4 Argon" group). No
 * vendor call here.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
import { agyPoolMetrics, agyUsageBuckets } from "../src/usage/providers.js";

const real = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/agy-quota-2026-10-20/${name}`, import.meta.url), "utf8"));
const H = 3_600_000;
const metrics = () => agyPoolMetrics(agyUsageBuckets(real("summary-daily-cli-ua.json"), null as never));

describe("the provider: each agy line says its window and its pool", () => {
  it("the daily base (asked as agy's CLI asks) has the Gemini group and Argon's own weekly line", () => {
    expect(metrics().map((m) => m.label)).toEqual(["Gemini (session)", "Gemini (weekly)", "Claude & others (session)", "Claude & others (weekly)", "Gemini 4 Argon (weekly)"]);
  });
  it("its window length (session 5 h, weekly 7 d) and its pool (a label and its words), on every line", () => {
    expect(metrics().map((m) => [m.windowMs, m.pool?.label, m.pool?.labelI18n?.key])).toEqual([
      [5 * H, "Gemini", "usage.metric.named"], [168 * H, "Gemini", "usage.metric.named"],
      [5 * H, "Claude & others", "usage.metric.agy_claude_others"], [168 * H, "Claude & others", "usage.metric.agy_claude_others"],
      [168 * H, "Gemini 4 Argon", "usage.metric.named"],
    ]);
  });
});

let usage: any, i18n: any, htm: any, pg: AppPage | null = null;
beforeAll(async () => {
  const p0 = page({ storage: { agend_tour_done: "1" } });
  usage = await import("/assets/usage-dialog.js");
  i18n = await import("/assets/app-i18n.js");
  htm = await import("/assets/app-html.js");
  p0.restore();
});
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } usage?.usageViewStore.set({ compact: false }); i18n?.setLang("en"); });
const AGY = () => ({ id: "antigravity", name: "Antigravity", status: "ok", plan: "Google AI Pro", metrics: JSON.parse(JSON.stringify(metrics())) });
const CLAUDE = { id: "claude", name: "Claude", status: "ok", plan: "Max (20x)", metrics: [
  { type: "percent", label: "Session", labelI18n: { key: "usage.metric.session" }, used: 40, windowMs: 5 * H, resetsAt: new Date(Date.now() + 2 * H).toISOString() },
  { type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used: 70, windowMs: 168 * H, resetsAt: new Date(Date.now() + 90 * H).toISOString() }] };
async function mount(compact: boolean, lang: "en" | "zh-TW" = "en") { await mountWith([AGY(), CLAUDE], compact, lang); }
async function mountWith(providers: unknown[], compact: boolean, lang: "en" | "zh-TW" = "en") {
  pg = page({ storage: { agend_tour_done: "1" } });
  i18n.setLang(lang);
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ fetchedAt: new Date().toISOString(), providers }) });
  usage.usageViewStore.set({ compact });
  await pg.mount(htm.html`<div><${usage.UsageBody} owner="agy-argon-views" /></div>`);
  await settle(3);
}
const text = (el: any) => String(el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("both views show Gemini 4 Argon", () => {
  it("full: Argon is a line of its own on the agy card", async () => {
    await mount(false);
    const card = pg!.root.querySelectorAll(".u-provider")[0];
    expect(card.querySelectorAll(".u-label").map(text)).toEqual(["Gemini (session)", "Gemini (weekly)", "Claude & others (session)", "Claude & others (weekly)", "Gemini 4 Argon (weekly)"]);
  });
  it("compact: an account with several pools shows a line per pool — its tighter window — Argon included; a one-pool account keeps 5h / 7d", async () => {
    await mount(true);
    const [agy, claude] = pg!.root.querySelectorAll(".u-crow");
    const bars = (r: any) => r.querySelectorAll(".u-cm").map((m: any) => `${text(m.querySelector(".u-cm-tag"))} ${text(m.querySelector(".u-cm-pct"))}`);
    expect(bars(agy)).toEqual(["Gemini 21%", "Claude & others 2%", "Gemini 4 Argon 0%"]);   // each pool's tighter window
    expect(agy.querySelectorAll(".u-cm")[0].getAttribute("title")).toBe("Gemini (session): 0% · Gemini (weekly): 21%");
    expect(bars(claude)).toEqual(["5h 40%", "7d 70%"]);
  });
  // #2460 review (Fable): a pooled view only when every percent window has a pool, and more than one pool.
  it("compact: one window without a pool (mixed metrics) falls back to 5h / 7d — never half pooled", async () => {
    const mixed = AGY();
    delete mixed.metrics[2].pool;                                         // Claude & others (session): no pool
    await mountWith([mixed], true);
    const row = pg!.root.querySelector(".u-crow");
    expect([row.getAttribute("class").includes("is-pooled"), row.querySelectorAll(".u-cm-tag").map(text)]).toEqual([false, ["5h", "7d"]]);
  });
  it("compact: an agy account with one pool (Gemini only) keeps 5h / 7d, not a line named after its pool", async () => {
    const gemini = AGY();
    gemini.metrics = gemini.metrics.filter((m: any) => m.pool.label === "Gemini");
    await mountWith([gemini], true);
    const row = pg!.root.querySelector(".u-crow");
    expect([row.getAttribute("class").includes("is-pooled"), row.querySelectorAll(".u-cm-tag").map(text)]).toEqual([false, ["5h", "7d"]]);
  });
  it("compact in zh-TW: the pools' own words", async () => {
    await mount(true, "zh-TW");
    const agy = pg!.root.querySelectorAll(".u-crow")[0];
    expect(agy.querySelectorAll(".u-cm-tag").map(text)).toEqual(["Gemini", "Claude 與其他模型", "Gemini 4 Argon"]);
  });
});
