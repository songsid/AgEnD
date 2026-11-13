/**
 * AGEND-113: what each CLI's registry entry says about its limits (`host.usage.pools`, `host.usage.windows`) holds for the payload its reader really gives, and what the Accounts row
 * makes of that payload shows it whole. The registry is the one place that says what shape to expect; this is the test that fails when a reader starts to report something it does not say:
 *  - every window of every real payload is of a kind the entry lists (a new kind of window is a line in the registry, reviewed, not a quiet change);
 *  - an entry that says `single` has one group and names no pool; `several`, a group per pool the payload names;
 *  - the entry does not list a kind its reader never reports (a stale line is as wrong as a missing one);
 *  - nothing a payload reports as a window is dropped: the row has exactly the windows the usage panel's full card draws as meters (percent metrics that are not a model's quota).
 * Real Antigravity shapes from agy's own responses (tests/helpers/usage-payloads.ts); the other readers' shapes written out as they build them.
 */
import { describe, expect, it } from "vitest";
import { hostFacts, hostIds } from "../src/cli-registry.js";
import { accountUsage } from "../src/accounts-view.js";
import { PAYLOADS } from "./helpers/usage-payloads.js";

const provider = (id: string) => ({ metrics: PAYLOADS[id]!() as Array<Record<string, unknown>> });
const windowsOf = (id: string) => accountUsage(id, provider(id))!.groups.flatMap((g) => g.windows);

describe("host.usage says what the CLI's reader reports", () => {
  it("there is a real payload for every CLI that has a usage row, and for no other", () => {
    expect(Object.keys(PAYLOADS).sort()).toEqual([...hostIds("usage")].sort());
  });
  for (const id of Object.keys(PAYLOADS)) {
    const facts = () => hostFacts(id, "usage")!;
    it(`${id}: every window it reports is of a kind its entry lists, and every kind the entry lists is one it reports`, () => {
      const seen = new Set(windowsOf(id).map((w) => w.kind));
      expect([...seen].filter((k) => !facts().windows.includes(k)), "reported but not listed").toEqual([]);
      expect(facts().windows.filter((k) => !seen.has(k)), "listed but never reported").toEqual([]);
    });
    it(`${id}: ${facts().pools === "several" ? "a group per pool it names" : "one group and no pool name"}`, () => {
      const groups = accountUsage(id, provider(id))!.groups;
      if (facts().pools === "single") { expect(groups).toHaveLength(1); expect(groups[0]).not.toHaveProperty("pool"); }
      else { expect(groups.length).toBeGreaterThan(1); expect(groups.every((g) => g.pool && g.pool.label)).toBe(true); expect(new Set(groups.map((g) => g.pool!.label)).size).toBe(groups.length); }
    });
    it(`${id}: the row has exactly the windows the full card draws as meters, in the card's order`, () => {
      const card = provider(id).metrics.filter((m) => m.type === "percent" && m.scope !== "model").map((m) => Math.round(m.used as number));
      expect(windowsOf(id).map((w) => w.percent)).toEqual(card);
    });
  }
  it("Antigravity's real shape: two pools with a 5h and a weekly window each, and Argon with one number of its own", () => {
    const groups = accountUsage("antigravity", provider("antigravity"))!.groups;
    expect(groups.map((g) => [g.pool!.label, g.windows.map((w) => w.kind)])).toEqual([
      ["Gemini", ["session", "weekly"]], ["Claude & others", ["session", "weekly"]], ["Gemini 4 Argon", ["unwindowed"]]]);
  });
  it("Claude's per-model quota and Codex's counts are lines of the full card, not meters of the row", () => {
    expect(windowsOf("claude-code")).toHaveLength(2); expect(windowsOf("codex")).toHaveLength(3);
  });
});
