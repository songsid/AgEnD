/**
 * #2240: Gemini 4 Argon has a quota of its own on paid Pro plans; agy shows it as a group of its own ("GEMINI 4 ARGON … For
 * paid Pro plans, Argon quota is separate … Gemini 4 Argon Weekly Limit"). AgEnD's pools folded anything matching
 * /gemini/i into "Gemini", so an Argon group or Argon models would vanish into Gemini's worst-of. Now Argon is its own
 * pool and line.
 *
 * Fixtures: tests/fixtures/agy-quota-2026-10-20/ are REAL response shapes from a user's agy login (2026-10-20,
 * read-only, user-approved), redacted to quota metadata: the daily and production bases' quota summaries and the daily
 * base's per-model quotas. That account's responses had NO Argon in them (not from any endpoint AgEnD can call); the
 * Argon group and models below are SYNTHETIC, written in the summary's own shape from what agy shows. A captured real
 * Argon response will replace them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agyPoolMetrics, agyUsageBuckets } from "../src/usage/providers.js";

const real = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/agy-quota-2026-10-20/${name}`, import.meta.url), "utf8"));
const summaryProd = real("summary-prod.json"), summaryDaily = real("summary-daily.json"), modelsDaily = real("models-daily.json");
/** SYNTHETIC: an Argon group in the summary's real shape (agy's screen: "Gemini 4 Argon Weekly Limit", 100% available). */
const ARGON_GROUP = { displayName: "Gemini 4 Argon", description: "For paid Pro plans, Argon quota is separate.",
  buckets: [{ bucketId: "argon-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-10-24T10:00:00Z", remainingFraction: 0.6 }] };
/** SYNTHETIC: Argon models in fetchAvailableModels' real shape (agy 1.4.2 names gemini-4-argon-{low,medium,high}). */
const ARGON_MODELS = {
  "gemini-4-argon-low": { displayName: "Gemini 4 Argon (Low)", modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.7, resetTime: "2026-10-24T10:00:00Z" } },
  "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.25, resetTime: "2026-10-24T10:00:00Z" } },
};
const lines = (summary: unknown, models: unknown) => agyPoolMetrics(agyUsageBuckets(summary as never, models as never))
  .map(m => [m.label, Math.round(m.used as number), m.resetsAt]);

describe("the real 2026-10-20 shapes (no Argon in them)", () => {
  it("production base: Gemini and Claude & others, each with its session and weekly limit", () => {
    expect(lines(summaryProd, modelsDaily).map(l => l[0])).toEqual(["Gemini (session)", "Gemini (weekly)", "Claude & others (session)", "Claude & others (weekly)"]);
  });
  it("daily base: no Gemini group — the Gemini line falls back to the busiest model (why the production base is read first)", () => {
    expect(lines(summaryDaily, modelsDaily).map(l => l[0])).toEqual(["Claude & others (session)", "Claude & others (weekly)", "Gemini"]);
  });
});

describe("Gemini 4 Argon is its own line (synthetic Argon on the real shapes)", () => {
  it("an Argon summary group: \"Gemini 4 Argon (weekly)\" with its own percentage and reset — Gemini's lines unchanged", () => {
    const withArgon = { ...summaryProd, groups: [...summaryProd.groups, ARGON_GROUP] };
    const out = lines(withArgon, modelsDaily);
    expect(out.find(l => l[0] === "Gemini 4 Argon (weekly)")).toEqual(["Gemini 4 Argon (weekly)", 40, "2026-10-24T10:00:00Z"]);
    expect(out.filter(l => String(l[0]).startsWith("Gemini (")), "Gemini is not Argon's worst-of").toEqual(lines(summaryProd, modelsDaily).filter(l => String(l[0]).startsWith("Gemini (")));
  });
  it("the group's name in capitals, as agy prints its heading: the same pool", () => {
    const out = lines({ ...summaryProd, groups: [...summaryProd.groups, { ...ARGON_GROUP, displayName: "GEMINI 4 ARGON" }] }, modelsDaily);
    expect(out.map(l => l[0])).toContain("Gemini 4 Argon (weekly)");
  });
  it("Argon only as models (no group): its own line, the busiest Argon model — never folded into Gemini", () => {
    const models = { models: { ...modelsDaily.models, ...ARGON_MODELS } };
    const out = lines(summaryProd, models);
    expect(out.find(l => l[0] === "Gemini 4 Argon")).toEqual(["Gemini 4 Argon", 75, "2026-10-24T10:00:00Z"]);
    expect(out.filter(l => String(l[0]).startsWith("Gemini (")), "Gemini's lines unchanged").toEqual(lines(summaryProd, modelsDaily).filter(l => String(l[0]).startsWith("Gemini (")));
  });
  it("an Argon group and Argon models: the group wins (its weekly limit), the models are not a second line", () => {
    const out = lines({ ...summaryProd, groups: [...summaryProd.groups, ARGON_GROUP] }, { models: { ...modelsDaily.models, ...ARGON_MODELS } });
    expect(out.filter(l => String(l[0]).includes("Argon")).map(l => l[0])).toEqual(["Gemini 4 Argon (weekly)"]);
  });
  it("on the daily base too (no Gemini group): Gemini from its busiest model, Argon on its own", () => {
    const out = lines(summaryDaily, { models: { ...modelsDaily.models, ...ARGON_MODELS } }).map(l => l[0]);
    expect(out).toEqual(["Claude & others (session)", "Claude & others (weekly)", "Gemini", "Gemini 4 Argon"]);
  });
});
