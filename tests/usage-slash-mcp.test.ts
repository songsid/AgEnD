import { describe, expect, it, vi, afterEach } from "vitest";
import { formatUsageSummary, getUsageSnapshot, setUsageFetcherForTests, type UsagePayload } from "../src/usage/usage-api.js";
import { TOOLS, TOOL_SETS } from "../src/channel/mcp-tools.js";
import { GetUsageArgs } from "../src/outbound-schemas.js";

/**
 * `/usage` (slash, admin-only) and `get_usage` (MCP) expose the same data the
 * /view Usage panel reads — through the same 5-minute cache, because that cache
 * exists to protect vendor rate limits and a second entry point that bypassed it
 * would defeat it.
 */

const PAYLOAD: UsagePayload = {
  fetchedAt: "2026-08-01T12:00:00Z",
  providers: [
    {
      id: "claude", name: "Claude", status: "ok", plan: "Max",
      metrics: [
        { label: "Session", type: "percent", used: 34.4, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
        { label: "Weekly", type: "percent", used: 12 },
        { label: "Extra usage", type: "dollars", used: 3.5, limit: 20 },
      ],
    },
    { id: "codex", name: "Codex", status: "no-credentials", hint: "log in", metrics: [] },
    { id: "grok", name: "Grok", status: "error", error: "Token expired.", metrics: [] },
    {
      id: "kiro", name: "Kiro", status: "ok", plan: null,
      metrics: [{ label: "Credits", type: "count", value: 812, unit: "left" }],
    },
  ],
};

afterEach(() => setUsageFetcherForTests(null));

describe("formatUsageSummary", () => {
  it("renders one compact line per provider", () => {
    const text = formatUsageSummary(PAYLOAD);
    const lines = text.split("\n");

    expect(lines[0]).toContain("AI subscription usage");
    expect(lines).toHaveLength(1 + PAYLOAD.providers.length);
    expect(text).toContain("Claude (Max): Session 34% (resets in 3h) | Weekly 12% | Extra usage $3.50/$20.00");
    expect(text).toContain("Kiro: Credits 812 left");
  });

  it("says so when a provider is not logged in or errored, instead of omitting it", () => {
    // "Codex: not logged in" is information; an absent row is a question.
    const text = formatUsageSummary(PAYLOAD);
    expect(text).toContain("Codex: not logged in");
    expect(text).toContain("Grok: ⚠️ Token expired.");
  });

  it("contains no markup — adapters send it with no parse mode", () => {
    const text = formatUsageSummary(PAYLOAD);
    expect(text).not.toMatch(/\*\*|__|<b>|```/);
  });
});

describe("getUsageSnapshot", () => {
  it("shares the HTTP route's cache instead of re-fetching", async () => {
    const fetcher = vi.fn().mockResolvedValue(PAYLOAD);
    setUsageFetcherForTests(fetcher);

    await getUsageSnapshot();
    await getUsageSnapshot();
    expect(fetcher).toHaveBeenCalledTimes(1); // second call is the cache

    await getUsageSnapshot(true); // force bypasses, like ?force=1
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("get_usage MCP tool", () => {
  it("is defined with the force flag and a description that states the use case", () => {
    const tool = TOOLS.find(t => t.name === "get_usage");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("warn the user");
    expect(GetUsageArgs.safeParse({}).success).toBe(true);
    expect(GetUsageArgs.safeParse({ force: true }).success).toBe(true);
    expect(GetUsageArgs.safeParse({ force: "yes" }).success).toBe(false);
  });

  it("is available in the standard and general tool sets", () => {
    // "agent notices it is near a limit" only works if ordinary instances have
    // the tool without opting into the full profile.
    expect(TOOL_SETS.standard).toContain("get_usage");
    expect(TOOL_SETS.general).toContain("get_usage");
    expect(TOOL_SETS.minimal).not.toContain("get_usage");
  });
});
