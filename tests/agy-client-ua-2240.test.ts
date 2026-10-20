/**
 * #2240: the plan's Gemini quota comes from the daily Cloud Code base only when it is asked as a current Antigravity
 * client. Checked live 2026-10-20 (a user's Google AI Pro account, read-only) against agy's own /quota ("Gemini Models
 * Weekly Limit Remaining 78% 2026-10-24 08:00 CST"): the daily summary as `antigravity/2.24.0 (aidev_client; …)` had
 * gemini-weekly 0.78095853 resetting 2026-10-24T00:00:26Z — agy's numbers exactly; as plain "antigravity" or
 * `antigravity/1.4.2` it had no Gemini group; the production base had a free-tier bucket (0.9725, resetting 10-21)
 * whatever the client said. Fixtures are those REAL responses, redacted (tests/fixtures/agy-quota-2026-10-20/).
 *
 * Then agy 1.4.3's own /quota, captured the same day (summary-daily-cli-ua.json): it asks as
 * `antigravity/cli/1.4.3 (aidev_client; …)`, and the `cli/` segment is what brings the "Gemini 4 Argon" group (asked
 * without it, never; as cli/1.2.0 or older, never). So AgEnD now asks exactly as agy does.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGY_CLIENT_VERSION, agyPlan, agyPoolMetrics, agyUsageBuckets, agyUserAgent, fetchAntigravityUsage } from "../src/usage/providers.js";

const real = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/agy-quota-2026-10-20/${name}`, import.meta.url), "utf8"));
const lines = (summary: unknown, models: unknown = null) => agyPoolMetrics(agyUsageBuckets(summary as never, models as never))
  .map(m => [m.label, Number((m.used as number).toFixed(1)), m.resetsAt]);

describe("#2240: asked as a current Antigravity client, the daily base gives the plan's Gemini quota", () => {
  it("the real versioned daily summary: Gemini weekly 21.9% used, resetting 2026-10-24T00:00:26Z — agy's own 78% remaining", () => {
    expect(lines(real("summary-daily-client-ua.json"))).toEqual([
      ["Gemini (session)", 0, "2026-10-20T10:00:42Z"], ["Gemini (weekly)", 21.9, "2026-10-24T00:00:26Z"],
      ["Claude & others (session)", 0, "2026-10-20T10:36:37Z"], ["Claude & others (weekly)", 2.4, "2026-10-23T08:04:22Z"],
    ]);
  });
  it("the real daily summary asked the old way (no Gemini group): Claude's lines and a Gemini line from the busiest model — still visible", () => {
    expect(lines(real("summary-daily.json"), real("models-daily.json")).map(l => l[0])).toEqual(["Claude & others (session)", "Claude & others (weekly)", "Gemini"]);
    expect(lines(real("summary-daily.json")).map(l => l[0]), "without models: Claude's lines, never a made-up Gemini").toEqual(["Claude & others (session)", "Claude & others (weekly)"]);
  });
  it("agy 1.4.3's real daily summary (asked as agy's CLI): Gemini, Claude & others, and Gemini 4 Argon as a line of its own", () => {
    expect(lines(real("summary-daily-cli-ua.json"))).toEqual([
      ["Gemini (session)", 0, "2026-10-20T13:11:26Z"], ["Gemini (weekly)", 21, "2026-10-24T00:00:26Z"],
      ["Claude & others (session)", 0, "2026-10-20T13:11:26Z"], ["Claude & others (weekly)", 2.4, "2026-10-23T08:04:22Z"],
      ["Gemini 4 Argon (weekly)", 0, "2026-10-27T08:11:26Z"],
    ]);
  });
  it("the User-Agent: agy's CLI's own shape (`antigravity/cli/<version>`), with the named version, this host's OS and CPU", () => {
    expect(AGY_CLIENT_VERSION).toBe("1.4.3");
    expect([agyUserAgent("linux", "x64"), agyUserAgent("darwin", "arm64"), agyUserAgent("win32", "x64")]).toEqual([
      "antigravity/cli/1.4.3 (aidev_client; os_type=linux; arch=amd64)",
      "antigravity/cli/1.4.3 (aidev_client; os_type=darwin; arch=arm64)",
      "antigravity/cli/1.4.3 (aidev_client; os_type=windows; arch=amd64)",
    ]);
  });
  it("the plan name is one badge: at most 64 characters, a longer one cut with an ellipsis", () => {
    expect(agyPlan({ paidTier: { name: "Google AI Pro" } })).toBe("Google AI Pro");
    expect(agyPlan({ paidTier: { name: "x".repeat(64) } })).toBe("x".repeat(64));
    expect(agyPlan({ paidTier: { name: "x".repeat(65) } })).toBe(`${"x".repeat(63)}…`);
    expect(agyPlan({ currentTier: { id: "🙂".repeat(70) } }), "counted in code points, never a split surrogate").toBe(`${"🙂".repeat(63)}…`);
  });
});

describe("#2240: what the provider sends", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  it("both calls go to the daily base first, as the current client; the row is agy's Gemini", async () => {
    const home = mkdtempSync(join(tmpdir(), "agy-ua-2240-")); dirs.push(home);
    mkdirSync(join(home, "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, "antigravity-cli", "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "test-token", expiry: "2999-01-01T00:00:00Z" } }));
    vi.stubEnv("GEMINI_HOME", home);
    const sent: Array<[string, string]> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      sent.push([url.replace(/^https:\/\/([a-z-]+)\.googleapis\.com\/v1internal:/, "$1 "), init.headers["User-Agent"]]);
      const body = url.endsWith(":retrieveUserQuotaSummary") ? real("summary-daily-client-ua.json") : { models: {} };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const row = await fetchAntigravityUsage();
    expect(sent).toEqual([["daily-cloudcode-pa fetchAvailableModels", agyUserAgent()], ["daily-cloudcode-pa loadCodeAssist", agyUserAgent()], ["daily-cloudcode-pa retrieveUserQuotaSummary", agyUserAgent()]]);
    expect(row.metrics.find(m => m.label === "Gemini (weekly)")?.resetsAt).toBe("2026-10-24T00:00:26Z");
  });
});
