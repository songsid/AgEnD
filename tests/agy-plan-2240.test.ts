/**
 * #2240 follow-up: the Antigravity row names its plan, as agy does ("Google AI Pro"). `loadCodeAssist`, asked as agy
 * asks it, alongside the summary and as optional as the models' read: the paid tier's name wins over the current tier's
 * (a Pro account's current tier is "free-tier", named "Antigravity") — as OpenUsage (MIT) reads it. The fixture is the
 * REAL response (2026-10-20, read-only, user-approved), reduced to its tiers' ids and names.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agyPlan, fetchAntigravityUsage } from "../src/usage/providers.js";

const real = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/agy-quota-2026-10-20/${name}`, import.meta.url), "utf8"));

describe("agyPlan", () => {
  it("the real response: the paid tier's name — Google AI Pro (not the current free tier's \"Antigravity\")", () => {
    expect(agyPlan(real("load-code-assist.json"))).toBe("Google AI Pro");
  });
  it("no paid tier: the current tier's name; a tier with only an id: its id; nothing usable: null", () => {
    expect(agyPlan({ currentTier: { id: "standard-tier", name: "Antigravity" } })).toBe("Antigravity");
    expect(agyPlan({ paidTier: { id: "g1-ultra-tier" } })).toBe("g1-ultra-tier");
    expect(agyPlan({ paidTier: { name: " " }, currentTier: { id: "free-tier" } })).toBe("free-tier");
    expect([agyPlan(null), agyPlan({}), agyPlan({ paidTier: { name: 3 } } as never)]).toEqual([null, null, null]);
  });
});

describe("the row carries it", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function login() {
    const home = mkdtempSync(join(tmpdir(), "agy-plan-2240-")); dirs.push(home);
    mkdirSync(join(home, "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, "antigravity-cli", "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "test-token", expiry: "2999-01-01T00:00:00Z" } }));
    vi.stubEnv("GEMINI_HOME", home);
  }
  it("loadCodeAssist answers: plan \"Google AI Pro\" beside the real quota lines; it is asked with agy's client metadata", async () => {
    login();
    let assistBody: unknown = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      if (url.endsWith(":loadCodeAssist")) { assistBody = JSON.parse(init.body); return new Response(JSON.stringify(real("load-code-assist.json")), { status: 200 }); }
      if (url.endsWith(":retrieveUserQuotaSummary")) return new Response(JSON.stringify(real("summary-daily-client-ua.json")), { status: 200 });
      return new Response("{}", { status: 200 });
    }));
    const row = await fetchAntigravityUsage();
    expect([row.status, row.plan, row.metrics.find(m => m.label === "Gemini (weekly)")?.resetsAt]).toEqual(["ok", "Google AI Pro", "2026-10-24T00:00:26Z"]);
    expect(assistBody).toEqual({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } });
  });
  it("loadCodeAssist fails: the row is the same, with no plan — never an error", async () => {
    login();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith(":retrieveUserQuotaSummary")
      ? new Response(JSON.stringify(real("summary-daily-client-ua.json")), { status: 200 })
      : new Response("nope", { status: url.endsWith(":loadCodeAssist") ? 500 : 200 })));
    const row = await fetchAntigravityUsage();
    expect([row.status, row.plan, row.metrics.length]).toEqual(["ok", null, 4]);
  });
});
