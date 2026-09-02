import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readStatuslineRateLimits,
  STATUSLINE_MAX_AGE_MS,
} from "../src/usage/statusline-usage.js";

/**
 * Every claude-code instance writes its own rate limits to statusline.json each
 * turn. Reading that file costs no token and no API call, so it is what the
 * panel falls back to instead of saying "not logged in" at someone whose CLI is
 * demonstrably working — including `setup-token` users, whose token the fleet
 * daemon never inherits. (An API-key login is the one case the CLI does not
 * write the field for; see the note in statusline-usage.ts.)
 *
 * Field shape confirmed against a live file on 2026-08-02:
 *   "rate_limits":{"five_hour":{"used_percentage":29,"resets_at":1785669000},
 *                  "seven_day":{"used_percentage":22,"resets_at":1786147200}}
 * `resets_at` is epoch seconds — the StatuslineData type in types.ts said
 * `string`, which this branch corrects.
 */

const NOW = 1_785_657_000_000;
const IN_3H = Math.floor((NOW + 3 * 3_600_000) / 1000);
const IN_5D = Math.floor((NOW + 5 * 86_400_000) / 1000);

let home: string;

function writeStatusline(
  instance: string,
  body: unknown,
  writtenAtMs = NOW,
): void {
  const dir = join(home, "instances", instance);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "statusline.json");
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  const secs = writtenAtMs / 1000;
  utimesSync(file, secs, secs);
}

const limits = (fiveHour: number, sevenDay: number, base = NOW) => ({
  rate_limits: {
    five_hour: { used_percentage: fiveHour, resets_at: Math.floor((base + 3 * 3_600_000) / 1000) },
    seven_day: { used_percentage: sevenDay, resets_at: Math.floor((base + 5 * 86_400_000) / 1000) },
  },
});

/**
 * Reset times relative to the wall clock, for the tests that go through
 * fetchClaudeUsage — it reads the statusline with the real Date.now(), so
 * fixtures pinned to the frozen NOW silently age out of their 5-hour window and
 * the test starts failing at a time of day rather than on a code change.
 */
const liveLimits = (fiveHour: number, sevenDay: number) => limits(fiveHour, sevenDay, Date.now());

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agend-statusline-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("readStatuslineRateLimits", () => {
  it("reads both windows, converting epoch seconds to milliseconds", () => {
    writeStatusline("general", limits(29, 22));
    const r = readStatuslineRateLimits(home, NOW)!;
    expect(r.instance).toBe("general");
    expect(r.fiveHour).toEqual({ usedPercent: 29, resetsAtMs: IN_3H * 1000 });
    expect(r.sevenDay).toEqual({ usedPercent: 22, resetsAtMs: IN_5D * 1000 });
  });

  it("also accepts milliseconds and ISO strings, so a format change is not an outage", () => {
    writeStatusline("a", {
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: NOW + 3_600_000 },
        seven_day: { used_percentage: 20, resets_at: new Date(NOW + 86_400_000).toISOString() },
      },
    });
    const r = readStatuslineRateLimits(home, NOW)!;
    expect(r.fiveHour!.resetsAtMs).toBe(NOW + 3_600_000);
    expect(r.sevenDay!.resetsAtMs).toBe(NOW + 86_400_000);
  });

  it("takes the freshest instance, not the highest number", () => {
    // Every instance on the machine shares one account, so they are watching the
    // same counter. An hour-old 95% is not a worse-case reading — it is an
    // out-of-date one, and taking the max would report a limit that has reset.
    writeStatusline("stale", limits(95, 90), NOW - 30 * 60_000);
    writeStatusline("fresh", limits(4, 22), NOW - 60_000);
    const r = readStatuslineRateLimits(home, NOW)!;
    expect(r.instance).toBe("fresh");
    expect(r.fiveHour!.usedPercent).toBe(4);
  });

  it("ignores a window whose reset time has already passed", () => {
    // The percentage describes a window that no longer exists; showing it would
    // put a red 95% against a quota that is actually empty.
    writeStatusline("general", {
      rate_limits: {
        five_hour: { used_percentage: 95, resets_at: Math.floor((NOW - 60_000) / 1000) },
        seven_day: { used_percentage: 22, resets_at: IN_5D },
      },
    });
    const r = readStatuslineRateLimits(home, NOW)!;
    expect(r.fiveHour).toBeNull();
    expect(r.sevenDay!.usedPercent).toBe(22);
  });

  it("returns nothing when every reading is too old to trust", () => {
    writeStatusline("old", limits(50, 50), NOW - STATUSLINE_MAX_AGE_MS - 1);
    expect(readStatuslineRateLimits(home, NOW)).toBeNull();
    writeStatusline("recent", limits(50, 50), NOW - STATUSLINE_MAX_AGE_MS + 60_000);
    expect(readStatuslineRateLimits(home, NOW)).not.toBeNull();
  });

  it("skips instances that are not claude-code, are mid-write, or have no limits yet", () => {
    writeStatusline("codex-instance", { cost: { total_cost_usd: 1 } }); // no rate_limits
    writeStatusline("truncated", '{"rate_limits":{"five_h');            // caught mid-write
    writeStatusline("no-numbers", { rate_limits: { five_hour: {}, seven_day: {} } });
    mkdirSync(join(home, "instances", "never-started"), { recursive: true });
    expect(readStatuslineRateLimits(home, NOW)).toBeNull();

    writeStatusline("general", limits(7, 8));
    expect(readStatuslineRateLimits(home, NOW)!.instance).toBe("general");
  });

  it("returns nothing rather than throwing when there is no instances directory", () => {
    expect(readStatuslineRateLimits(join(home, "nope"), NOW)).toBeNull();
  });
});

// ── how the provider chooses between the two sources ─────────────────────────

describe("statuslineUsage rendering", () => {
  it("produces the same metric shape as the API path, with its source named", async () => {
    const { statuslineUsage } = await import("../src/usage/providers.js");
    writeStatusline("general", limits(29, 22));
    const out = statuslineUsage(readStatuslineRateLimits(home, NOW)!, null, NOW + 120_000);

    expect(out.status).toBe("ok");
    expect(out.metrics.map(m => [m.label, m.used])).toEqual([["Session", 29], ["Weekly", 22]]);
    expect(out.metrics[0].resetsAt).toBe(new Date(IN_3H * 1000).toISOString());
    // Provenance and what is missing — a number with neither invites "is this live?".
    expect(out.hint).toContain("general's statusline");
    expect(out.hint).toContain("2m ago");
    expect(out.hint).toContain("per-model limits");
  });
});

describe("fetchClaudeUsage source preference", () => {
  const realHome = process.env.HOME;
  const realAgend = process.env.AGEND_HOME;
  const realClaude = process.env.CLAUDE_HOME;
  const realToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  beforeEach(() => {
    // HOME too: resolveClaudeAuth's shell-rc fallback would otherwise read the
    // developer's own ~/.bashrc and take the API path on some machines.
    process.env.HOME = home;
    process.env.AGEND_HOME = home;
    process.env.CLAUDE_HOME = join(home, "no-credentials-here");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });
  afterEach(() => {
    process.env.HOME = realHome;
    if (realAgend === undefined) delete process.env.AGEND_HOME; else process.env.AGEND_HOME = realAgend;
    if (realClaude === undefined) delete process.env.CLAUDE_HOME; else process.env.CLAUDE_HOME = realClaude;
    if (realToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = realToken;
    vi.unstubAllGlobals();
  });

  it("reports usage with no token at all — the case this exists for", async () => {
    const { fetchClaudeUsage } = await import("../src/usage/providers.js");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    writeStatusline("general", liveLimits(29, 22), Date.now());

    const out = await fetchClaudeUsage();
    expect(out.status).toBe("ok");            // not "not logged in"
    expect(out.metrics).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();  // and it cost no API call
  });

  it("prefers the API when it answers, because it knows things the file cannot", async () => {
    // Live cross-check on 2026-08-02: statusline said Session 30 / Weekly 22,
    // while the API also reported "Fable (weekly) 37% (binding)" — the number
    // that will actually throttle the account is one the file never carries.
    const { fetchClaudeUsage } = await import("../src/usage/providers.js");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    writeStatusline("general", liveLimits(29, 22), Date.now());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        five_hour: { utilization: 31, resets_at: IN_3H },
        seven_day: { utilization: 22, resets_at: IN_5D },
        limits: [{ kind: "weekly_scoped", percent: 37, is_active: true, resets_at: IN_5D, scope: { model: { display_name: "Fable" } } }],
      }),
    }));

    const out = await fetchClaudeUsage();
    expect(out.metrics.map(m => m.label)).toContain("Fable (weekly)");
    expect(out.metrics.find(m => m.label === "Fable (weekly)")?.scope).toBe("model");
    expect(out.metrics.find(m => m.label === "Session")!.used).toBe(31); // API's number, not the file's 29
    expect(out.hint).toBeUndefined();
  });

  it("falls back to the file when the API rejects the token", async () => {
    const { fetchClaudeUsage } = await import("../src/usage/providers.js");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-stale";
    writeStatusline("general", liveLimits(29, 22), Date.now());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    const out = await fetchClaudeUsage();
    expect(out.status).toBe("ok");
    expect(out.metrics.map(m => m.used)).toEqual([29, 22]);
  });

  it("falls back to the file when Anthropic rate-limits the usage endpoint", async () => {
    const { fetchClaudeUsage } = await import("../src/usage/providers.js");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    writeStatusline("general", liveLimits(29, 22), Date.now());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));

    const out = await fetchClaudeUsage();
    expect(out.status).toBe("ok");
    expect(out.hint).toContain("statusline");
  });

  it("still says 'not logged in' when there is no token and no statusline either", async () => {
    // Without a file to fall back to, the honest answer is still the old one.
    const { fetchClaudeUsage } = await import("../src/usage/providers.js");
    vi.stubGlobal("fetch", vi.fn());
    const out = await fetchClaudeUsage();
    expect(out.status).toBe("no-credentials");
  });

  it("keeps the network error when the statusline is unusable", async () => {
    const { fetchClaudeUsage } = await import("../src/usage/providers.js");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
    writeStatusline("general", liveLimits(29, 22), Date.now() - STATUSLINE_MAX_AGE_MS - 1);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));

    const out = await fetchClaudeUsage();
    expect(out.status).toBe("error");
    expect(out.error).toContain("api.anthropic.com");
  });
});
