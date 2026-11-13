/**
 * AGEND-113: the usage block of an account's row on Settings → Accounts draws the SAME pools and windows as the usage panel's full card for that account — never one more, never one less.
 * The card is the panel's own `UsageMetric` for each metric of the payload (usage-dialog.js); the row is `UsageBlock` over what the server makes of the same payload (accounts-view.ts
 * `accountUsage`). Compared as the person sees them: the percents in order, the pools by name, in English and in 繁體中文 — for Antigravity's real shape (two pools with a 5h and a weekly window
 * each, and Argon with one number), and for Claude's, Codex's, Kiro's, Grok's and Muse's. (A model's quota, a count, an amount and a line of text are lines of the card, not meters of the row.)
 * The earlier row picked one window per kind: for Antigravity, Gemini's 5h and Claude & others' week, so Gemini's week and Claude & others' 5h were on the card and not in the row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { accountUsage } from "../src/accounts-view.js";
import { PAYLOADS } from "./helpers/usage-payloads.js";

let p: AppPage, i18n: any, Card: any, Pool: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
  i18n = await import("/assets/app-i18n.js"); Card = await import("/assets/usage-dialog.js"); Pool = await import("/ui/js/usage-pool.js");
});
afterAll(() => { p.restore(); });
beforeEach(async () => { await p.unmount(); i18n.setLang("en", { store: false }); });

const text = (n: any) => String((n && n.textContent) || "").replace(/\s+/g, " ").trim();
type Metric = Record<string, any>;
const isMeter = (m: Metric) => m.type === "percent" && m.scope !== "model";

/** What the full card shows for the payload: each metric's line (label and percent), for the metrics that are meters. */
async function cardLines(metrics: Metric[]): Promise<Array<{ label: string; pct: string }>> {
  await p.mount(h("div", null, metrics.filter(isMeter).map((m, i) => h(Card.UsageMetric, { key: i, m }))));
  return p.root.querySelectorAll(".u-metric").map((n: any) => ({ label: text(n.querySelector(".u-label")), pct: text(n.querySelector(".u-pct")) }));
}
/** What the row shows: each pool's name (or none) with its meters' percents, in the order drawn. */
async function rowBlocks(id: string, metrics: Metric[]): Promise<Array<{ pool: string; pcts: string[] }>> {
  const usage = accountUsage(id, { metrics })!;
  const tagOf = (w: any) => (w.kind === "unwindowed" ? "—" : w.kind === "weekly" ? "7d" : w.kind === "monthly" ? "30d" : "5h");
  await p.mount(h(Pool.UsageBlock, { groups: usage.groups, stale: false, tagOf, label: "Usage", staleText: "(stale)" }));
  const block = p.root.querySelector(".s-account-usage");
  const groups = block.querySelectorAll(".s-usage-group");
  const pcts = (n: any) => n.querySelectorAll(".u-cm .u-cm-pct").map((x: any) => text(x));
  return groups.length ? groups.map((g: any) => ({ pool: text(g.querySelector(".s-usage-pool")), pcts: pcts(g) })) : [{ pool: "", pcts: pcts(block) }];
}

describe("the row shows what the full card shows", () => {
  for (const lang of ["en", "zh-TW"]) for (const id of Object.keys(PAYLOADS)) {
    it(`${id} (${lang}): the same windows, in the same order${id === "antigravity" ? ", under the same pools" : ""}`, async () => {
      i18n.setLang(lang, { store: false });
      const metrics = PAYLOADS[id]!() as Metric[];
      const card = await cardLines(metrics), row = await rowBlocks(id, metrics);
      expect(row.flatMap((b) => b.pcts), "the percents, in the card's order").toEqual(card.map((l) => l.pct));
      if (id === "antigravity") {
        // every card line belongs to the pool the row names for it: the pool's name is the line's own (a window adds its kind: "Gemini (session)")
        let at = 0;
        for (const block of row) for (let i = 0; i < block.pcts.length; i++, at++) expect(card[at]!.label.startsWith(block.pool), `${card[at]!.label} / ${block.pool}`).toBe(true);
        expect(row.map((b) => b.pool)).toEqual(lang === "en" ? ["Gemini", "Claude & others", "Gemini 4 Argon"] : ["Gemini", "Claude 與其他模型", "Gemini 4 Argon"]);
        expect(row.map((b) => b.pcts.length)).toEqual([2, 2, 1]);             // Gemini's week and Claude & others' 5h are in the row
      } else {
        expect(row).toHaveLength(1); expect(row[0]!.pool).toBe("");           // one set of limits: no pool block, no name
      }
    });
  }
  it("the pools of Antigravity's real shape are all there: the four windows the row used to cut down to two, and Argon's number", async () => {
    const row = await rowBlocks("antigravity", PAYLOADS.antigravity!() as Metric[]);
    expect(row.reduce((n, b) => n + b.pcts.length, 0)).toBe(5);
  });
});
