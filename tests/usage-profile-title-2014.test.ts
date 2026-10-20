/**
 * #2014: a credential profile's usage card no longer squeezes the profile into its title ("Claude (team…)" beside the
 * plan badge). The row carries `profile` beside its unchanged API `name`; the page shows the provider name on the
 * title line and the profile on its own muted line, with the full name as the tooltip. Rows without a profile are as
 * they were.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fetchAllUsage, providersForConfig, setUsageProviderDeadlineForTests, setUsageProvidersForTests } from "../src/usage/providers.js";

function configWith(profiles: Array<string | null>) {
  const instances: Record<string, unknown> = {};
  profiles.forEach((profile, index) => {
    instances[`agent-${index}`] = {
      working_directory: "/tmp/w", backend: "claude-code",
      ...(profile ? { backend_options: { "claude-code": { credential_profile: profile } } } : {}),
    };
  });
  return { defaults: {}, instances } as never;
}
const BASE = [{ id: "claude", name: "Claude", fetch: async () => ({ status: "ok" as const, plan: "Team Premium (6.25x)", metrics: [] }) }];

afterEach(() => { setUsageProvidersForTests(null); setUsageProviderDeadlineForTests(null); });

describe("the rows", () => {
  it("a profile row carries its profile; the API name is unchanged; the shared row has none (and is \"Claude (default)\" beside profiles, #2236)", () => {
    const rows = providersForConfig(configWith(["team-alpha", null]), BASE);
    expect(rows.map(r => [r.id, r.name, r.profile])).toEqual([["claude", "Claude (default)", undefined], ["claude:team-alpha", "Claude (team-alpha)", "team-alpha"]]);
  });
  it("the snapshot keeps it, on a good read and on a failed one", async () => {
    setUsageProvidersForTests([{ id: "claude", name: "Claude", fetch: async (home?: string) => { if (home?.includes("team-beta")) throw new Error("boom"); return { status: "ok" as const, metrics: [] }; } }]);
    const { providers } = await fetchAllUsage(configWith(["team-alpha", "team-beta", null]));
    expect(providers.map(p => [p.id, p.name, p.profile, p.status])).toEqual([["claude", "Claude (default)", undefined, "ok"],
      ["claude:team-alpha", "Claude (team-alpha)", "team-alpha", "ok"], ["claude:team-beta", "Claude (team-beta)", "team-beta", "error"]]);
    expect(Object.hasOwn(providers[0]!, "profile"), "no profile key on a shared row").toBe(false);
  });
  it("a profile row that misses the deadline keeps its profile too (Fable #2016 P3)", async () => {
    setUsageProviderDeadlineForTests(20);
    setUsageProvidersForTests([{ id: "claude", name: "Claude", fetch: (home?: string) => home ? new Promise(() => {}) : Promise.resolve({ status: "ok" as const, metrics: [] }) }]);
    const { providers } = await fetchAllUsage(configWith(["team-alpha", null]));
    expect(providers.map(p => [p.id, p.profile, p.status, p.error])).toEqual([["claude", undefined, "ok", undefined], ["claude:team-alpha", "team-alpha", "error", "Could not reach Claude (team-alpha)."]]);
  });
});

let usage: any;
let pg: AppPage | null = null;
const SNAPSHOT = { fetchedAt: Date.now(), providers: [
  { id: "claude", name: "Claude", status: "ok", plan: "Max (20x)", metrics: [] },
  { id: "claude:team-alpha-with-a-long-name", name: "Claude (team-alpha-with-a-long-name)", profile: "team-alpha-with-a-long-name", status: "ok", plan: "Team Premium (1.25x)", metrics: [] },
  { id: "kiro", name: "Kiro (odd)", profile: "other", status: "ok", metrics: [] },
] };
beforeAll(async () => {
  const p0 = page({ storage: { agend_tour_done: "1" } });
  usage = await import("/assets/usage-dialog.js");
  p0.restore();
});
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } });

describe("the card's title", () => {
  it("providerTitle: the base name and the profile; a name not ending in the profile is left whole", () => {
    expect(usage.providerTitle({ name: "Claude (team)", profile: "team" })).toEqual({ base: "Claude", profile: "team" });
    expect(usage.providerTitle({ name: "Claude" })).toEqual({ base: "Claude", profile: "" });
    expect(usage.providerTitle({ name: "Kiro (odd)", profile: "other" })).toEqual({ base: "Kiro (odd)", profile: "other" });
    expect(usage.providerTitle({ name: "Codex (default)" }), "the shared Codex row has no profile").toEqual({ base: "Codex (default)", profile: "" });
    // Fable #2016 P3: a profile that is not a non-empty string is no profile.
    for (const profile of [5, ["x"], { a: 1 }, ""]) expect(usage.providerTitle({ name: "Claude (5)", profile }), JSON.stringify(profile)).toEqual({ base: "Claude (5)", profile: "" });
  });
  it("rendered: the provider name on the title line, the profile on its own line, the full name as the tooltip; the plan badge beside it", async () => {
    pg = page({ storage: { agend_tour_done: "1" } });
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => SNAPSHOT });
    await pg.mount(h(usage.UsageBody, { owner: "t2014" }));
    await settle(3);
    const cards = pg.root.querySelectorAll(".u-provider") as any[];
    expect(cards.length).toBe(3);
    const [plain, prof, odd] = cards;
    expect([plain.querySelector(".u-head strong").textContent, plain.querySelector(".u-profile")]).toEqual(["Claude", null]);
    const strong = prof.querySelector(".u-head strong"), line = prof.querySelector(".u-profile");
    expect([strong.textContent, strong.getAttribute("title"), line.textContent, line.getAttribute("title")])
      .toEqual(["Claude", "Claude (team-alpha-with-a-long-name)", "team-alpha-with-a-long-name", "Claude (team-alpha-with-a-long-name)"]);
    expect(line.parentNode, "its own line under the head, not beside the badge").toBe(prof);
    expect(prof.querySelector(".u-head .u-plan").textContent).toContain("Team ×1.25");
    expect(prof.querySelector(".u-head").textContent, "never the profile in parentheses on the title line").not.toContain("(team");
    expect([odd.querySelector(".u-head strong").textContent, odd.querySelector(".u-profile").textContent]).toEqual(["Kiro (odd)", "other"]);
  });
});
