/**
 * AGEND-119: three things an account's usage row says.
 *
 *  1. Gemini 4 Argon is a limit of its own only where the account has one. The rule reads the DATA, never a plan's name: the quota summary names an Argon group (a Pro plan: tests/fixtures/agy-quota-2026-10-20,
 *     agy 1.4.3's own answer), or an Argon model's own quota differs from every other bucket's. On an Ultra plan (tests/fixtures/agy-quota-2026-11-09, this account's real answer, redacted to quota metadata)
 *     the summary has no Argon group and every Argon model's quota is exactly the Gemini five-hour pool's (`agy models` lists the Argon models there too, so it cannot tell the two plans apart): a pool made of
 *     them was that pool shown twice, as an Argon line of its own.
 *  2. A row of last-known numbers says why: the usage panel's own cause, when the numbers were read and what the read said (accounts-view.ts `accountUsage`, usage-pool.js `UsageBlock`).
 *  3. A week's reset time is not cut off in 繁體中文: the Accounts meter's reset cell is as wide as its words (accounts.css).
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, h, type AppPage } from "./helpers/app-harness.js";
import { accountUsage } from "../src/accounts-view.js";
import { agyPoolMetrics, agyUsageBuckets } from "../src/usage/providers.js";

const fixture = (dir: string, name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${dir}/${name}`, import.meta.url), "utf8"));
const ultraSummary = fixture("agy-quota-2026-11-09", "summary-ultra.json"), ultraModels = fixture("agy-quota-2026-11-09", "models-ultra.json");
const proSummary = fixture("agy-quota-2026-10-20", "summary-daily-cli-ua.json");
const labels = (summary: unknown, models: unknown) => agyPoolMetrics(agyUsageBuckets(summary as never, models as never)).map(m => m.label);

describe("Gemini 4 Argon: a pool of its own only when the data says it has a limit of its own", () => {
  it("the Ultra account's real answer: the Argon models are listed, and their quota IS the Gemini five-hour pool's", () => {
    const argon = Object.entries<any>(ultraModels.models).filter(([id]) => /argon/i.test(id));
    expect(argon.length, "the fixture has Argon models").toBeGreaterThanOrEqual(2);
    const gemini5h = ultraSummary.groups[0].buckets.find((b: any) => b.bucketId === "gemini-5h");
    for (const [, m] of argon) expect([m.quotaInfo.remainingFraction, m.quotaInfo.resetTime]).toEqual([gemini5h.remainingFraction, gemini5h.resetTime]);
    expect(ultraSummary.groups.map((g: any) => g.displayName).some((n: string) => /argon/i.test(n))).toBe(false);
  });

  it("Ultra: no Argon line — Gemini and Claude & others, each with its five-hour and weekly limit", () => {
    expect(labels(ultraSummary, ultraModels)).toEqual(["Gemini (session)", "Gemini (weekly)", "Claude & others (session)", "Claude & others (weekly)"]);
  });

  it("the summary is a little fresher than the model list for the same pool (measured live: 0.8936 against 0.8911, one reset time): still the pool's quota, still no Argon line", () => {
    const fresher = JSON.parse(JSON.stringify(ultraSummary));
    for (const b of fresher.groups[0].buckets) if (b.bucketId === "gemini-5h") b.remainingFraction -= 0.0025;
    expect(labels(fresher, ultraModels)).toEqual(["Gemini (session)", "Gemini (weekly)", "Claude & others (session)", "Claude & others (weekly)"]);
  });

  it("Argon models that differ from the other Gemini models of the same answer are a limit of their own, even when the summary is silent about them", () => {
    const own = JSON.parse(JSON.stringify(ultraModels));
    for (const [id, m] of Object.entries<any>(own.models)) if (/argon/i.test(id)) m.quotaInfo = { remainingFraction: 0.31, resetTime: "2026-11-09T07:00:00Z" };
    expect(labels(ultraSummary, own).filter(l => l.includes("Argon"))).toEqual(["Gemini 4 Argon"]);
  });

  it("Pro: the summary names an Argon group, so Argon's own weekly line stays (agy 1.4.3's real answer)", () => {
    expect(labels(proSummary, null)).toContain("Gemini 4 Argon (weekly)");
    // …and the models' own Argon quotas (synthetic, equal to Gemini's) are not a second Argon line beside the group.
    const equalToGemini = { models: { "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 1, resetTime: "2026-10-20T13:11:26Z" } } } };
    expect(labels(proSummary, equalToGemini).filter(l => l.includes("Argon"))).toEqual(["Gemini 4 Argon (weekly)"]);
  });

  it("Argon models whose quota differs from every other bucket's are a limit of their own, and stay (the rule is about the data, not the name)", () => {
    const own = { models: { ...ultraModels.models, "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)", modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.4, resetTime: "2026-11-12T00:00:00Z" } } } };
    expect(labels(ultraSummary, own)).toContain("Gemini 4 Argon");
  });

  it("the rule is the quota, not the model's name: the same models with a quota of their own are kept, and with the pool's quota they are dropped", () => {
    const withQuota = (fraction: number, resetTime: string) => ({ models: { "gemini-4-argon-medium": { displayName: "Gemini 4 Argon (Medium)", modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: fraction, resetTime } } } });
    const g5 = ultraSummary.groups[0].buckets.find((b: any) => b.bucketId === "gemini-5h");
    expect(labels(ultraSummary, withQuota(g5.remainingFraction, g5.resetTime)).some(l => l.includes("Argon"))).toBe(false);
    expect(labels(ultraSummary, withQuota(g5.remainingFraction, "2026-11-30T00:00:00Z")).some(l => l.includes("Argon"))).toBe(true);   // same fraction, another reset: a window of its own
    expect(labels(ultraSummary, withQuota(0.123, g5.resetTime)).some(l => l.includes("Argon"))).toBe(true);                          // same reset, another fraction: its own count
  });

  it("a model that is not Argon is never dropped by it (Gemini models listed with the Gemini pool's own quota when the summary has no Gemini group)", () => {
    const noGemini = { groups: ultraSummary.groups.slice(1) };
    expect(labels(noGemini, ultraModels)).toEqual(["Claude & others (session)", "Claude & others (weekly)", "Gemini"]);
  });
});

describe("accountUsage: why the numbers are the last known ones", () => {
  const percent = [{ type: "percent", label: "Session", used: 30, windowMs: 5 * 3_600_000, resetsAt: "2099-01-01T00:00:00Z" }];
  const stale = (extra: Record<string, unknown>) => accountUsage("claude-code", { metrics: percent, stale: true, ...extra } as never);

  it("carries the cause, when the numbers were read and what the read said", () => {
    const hint = "Access token expired. Run `agy` once to refresh it.";
    const info = stale({ staleCause: "expired", cachedAt: "2026-11-09T01:00:00Z", hint, hintI18n: { key: "usage.error.agy_token_expired" } })!.staleInfo;
    expect(info).toEqual({ cause: "expired", cachedAt: "2026-11-09T01:00:00.000Z", hint, hintI18n: { key: "usage.error.agy_token_expired" } });
  });
  it("nothing of it on a row that is current, or from a server that does not say why", () => {
    expect(accountUsage("claude-code", { metrics: percent } as never)!.staleInfo).toBeUndefined();
    expect(stale({})!.staleInfo).toBeUndefined();
    expect(stale({})!.stale).toBe(true);
  });
  it("only the three causes and a real time are passed on", () => {
    expect(stale({ staleCause: "whatever", cachedAt: "2026-11-09T01:00:00Z" })!.staleInfo).toBeUndefined();
    expect(stale({ staleCause: "error", cachedAt: "not a time" })!.staleInfo).toBeUndefined();
    expect(stale({ staleCause: "transient", cachedAt: "2026-11-09T01:00:00Z" })!.staleInfo).toEqual({ cause: "transient", cachedAt: "2026-11-09T01:00:00.000Z" });
  });
  it("what the read said is bounded, and a reference outside the usage panel's words is dropped", () => {
    const info = stale({ staleCause: "error", cachedAt: "2026-11-09T01:00:00Z", hint: ` ${"x".repeat(500)} `, hintI18n: { key: "../../etc/passwd", args: ["a"] } })!.staleInfo!;
    expect(info.hint!.length).toBe(240);
    expect(info.hintI18n).toBeUndefined();
  });
});

describe("the row says why in the person's language", () => {
  let p: AppPage, i18n: any, Pool: any;
  beforeAll(async () => {
    p = page({ url: "http://127.0.0.1:19281/settings/agents", storage: { agend_tour_done: "1" } });
    i18n = await import("/assets/app-i18n.js"); Pool = await import("/ui/js/usage-pool.js");
  });
  afterAll(() => { p.restore(); });
  beforeEach(async () => { await p.unmount(); i18n.setLang("en", { store: false }); });
  const groups = [{ windows: [{ kind: "session", percent: 12, windowMs: 5 * 3_600_000 }] }];
  const mount = (staleInfo: unknown) => p.mount(h(Pool.UsageBlock, { groups, stale: true, staleInfo, tagOf: () => "5h", label: "Usage", staleText: "(stale)" }));
  const text = (n: any) => String((n && n.textContent) || "").replace(/\s+/g, " ").trim();

  it("English: the mark, the cause with the time, and what the read said", async () => {
    await mount({ cause: "expired", cachedAt: "2026-11-09T06:55:00", hint: "Access token expired.", hintI18n: { key: "usage.error.agy_token_expired" } });
    const line = text(p.root.querySelector(".s-usage-stale"));
    expect(line).toMatch(/^\(stale\) expired · cached at (\d{1,2}\/\d{1,2} )?\d{1,2}:\d\d/);
    expect(line).toContain("Access token expired");
  });
  it("繁體中文: the same, in the usage panel's own words", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mount({ cause: "expired", cachedAt: "2026-11-09T06:55:00", hint: "x", hintI18n: { key: "usage.error.agy_token_expired" } });
    const line = text(p.root.querySelector(".s-usage-stale"));
    expect(line).toContain("已過期 · 快取於");
    expect(line).toContain("Access token 已過期");
  });
  it("a transient failure says only that it is not updated and since when", async () => {
    await mount({ cause: "transient", cachedAt: "2026-11-09T06:55:00", hint: "should not show" });
    expect(text(p.root.querySelector(".s-usage-stale"))).toMatch(/not updated · cached at/);
    expect(p.root.querySelector(".s-usage-stale-detail")).toBeNull();
  });
  it("a row with no reason (an older server) keeps the mark alone", async () => {
    await mount(undefined);
    expect(text(p.root.querySelector(".s-usage-stale"))).toBe("(stale)");
  });
});

describe("a week's reset time is as wide as its words", () => {
  const css = readFileSync(new URL("../src/ui/shared/accounts.css", import.meta.url), "utf8");
  it("the Accounts meter's reset column grows to its words (the Usage panel's fixed 3.7em cut \"↻ 47小時\" in 繁體中文)", () => {
    const rule = css.split("\n").find(line => line.startsWith(".s-account-usage .u-cm {"));
    expect(rule, "a rule for the meter inside an account's usage block").toBeTruthy();
    expect(rule).toMatch(/grid-template-columns:[^;]*minmax\(3\.7em, max-content\)/);   // never narrower than before, as wide as its words
    expect(rule).not.toMatch(/overflow/);
  });
});
