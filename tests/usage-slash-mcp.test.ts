import { describe, expect, it, vi, afterEach } from "vitest";
import { formatDiscordUsageActivity, formatUsageSummary, getUsageSnapshot, setUsageFetcherForTests, type UsagePayload } from "../src/usage/usage-api.js";
import { TOOLS } from "../src/channel/mcp-tools.js";
import { TOOL_PROFILES as TOOL_SETS } from "../src/tool-permissions.js";
import { GetUsageArgs } from "../src/outbound-schemas.js";
import { TopicCommands } from "../src/topic-commands.js";

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
    expect(text).toContain("Claude (Max): Session 34% (resets in 3h 0m) | Weekly 12% | Extra usage $3.50/$20.00");
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

  it("explains when no active backend has usage tracking", () => {
    expect(formatUsageSummary({ ...PAYLOAD, providers: [] }))
      .toContain("No active backends with usage tracking");
  });
});

describe("formatDiscordUsageActivity", () => {
  it("shows percentages while omitting unavailable provider noise", () => {
    const text = formatDiscordUsageActivity(PAYLOAD);
    expect(text).toBe("⚡ Claude 12%");
    expect(text).not.toContain("Codex");
    expect(text).not.toContain("Grok");
    expect(text).not.toContain("Kiro");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("includes a reset countdown when one backend owns the adapter", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-24T00:00:00.000Z"));
      expect(formatDiscordUsageActivity({
        fetchedAt: PAYLOAD.fetchedAt,
        providers: [{
          id: "muse", name: "Muse", status: "ok",
          metrics: [{ label: "Weekly", type: "percent", used: 6, resetsAt: "2026-09-28T00:00:00.000Z" }],
        }],
      })).toBe("⚡ Muse 6% (4d0h)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps multi-backend activity compact without reset countdowns", () => {
    expect(formatDiscordUsageActivity({
      fetchedAt: PAYLOAD.fetchedAt,
      providers: [
        { id: "muse", name: "Muse", status: "ok", metrics: [{ label: "Weekly", type: "percent", used: 6, resetsAt: "2099-09-28T00:00:00.000Z" }] },
        { id: "codex", name: "Codex", status: "ok", metrics: [{ label: "Weekly", type: "percent", used: 12, resetsAt: "2099-09-28T00:00:00.000Z" }] },
      ],
    })).toBe("⚡ Muse 6% | Codex 12%");
  });

  it("renders a single backend as `<Backend> <pct>% (<XdYh>)` with no window or reset words", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-24T00:00:00.000Z"));
      const text = formatDiscordUsageActivity({
        fetchedAt: PAYLOAD.fetchedAt,
        providers: [{
          id: "grok", name: "Grok", status: "ok",
          metrics: [{ label: "Weekly", type: "percent", used: 76, resetsAt: "2026-09-29T00:00:00.000Z" }],
        }],
      });
      expect(text).toBe("⚡ Grok 76% (5d0h)");
      expect(text).not.toMatch(/weekly|reset|重置/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders several backends as `<B> <p>%` joined by ` | ` with no countdowns", () => {
    const text = formatDiscordUsageActivity({
      fetchedAt: PAYLOAD.fetchedAt,
      providers: [
        { id: "claude", name: "Claude", status: "ok", metrics: [{ label: "Weekly", type: "percent", used: 95, resetsAt: "2099-09-28T00:00:00.000Z" }] },
        { id: "codex", name: "Codex", status: "ok", metrics: [{ label: "Session", type: "percent", used: 65, resetsAt: "2099-09-28T00:00:00.000Z" }] },
        { id: "grok", name: "Grok", status: "ok", metrics: [{ label: "Weekly", type: "percent", used: 76, resetsAt: "2099-09-28T00:00:00.000Z" }] },
      ],
    });
    expect(text).toBe("⚡ Claude 95% | Codex 65% | Grok 76%");
    expect(text).not.toMatch(/weekly|reset|重置|\(.*d.*h.*\)/i);
  });

  it("renders Q Developer Pro as an explicit unlimited entitlement", () => {
    const payload: UsagePayload = {
      fetchedAt: PAYLOAD.fetchedAt,
      providers: [{
        id: "kiro", name: "Kiro", plan: "Q Developer Pro", status: "ok",
        unlimited: true, hint: "♾️ Unlimited", metrics: [],
      }],
    };
    expect(formatUsageSummary(payload)).toContain("Kiro (Q Developer Pro): ♾️ Unlimited");
    expect(formatUsageSummary(payload)).not.toContain("no credit usage");
    expect(formatDiscordUsageActivity(payload)).toBe("⚡ Kiro ♾️ Unlimited");
  });

  it("keeps each configured Codex source as its own activity entry", () => {
    const text = formatDiscordUsageActivity({
      fetchedAt: PAYLOAD.fetchedAt,
      providers: [
        { id: "codex:personal", name: "Codex (personal)", status: "ok", metrics: [{ label: "Weekly", type: "percent", used: 15 }] },
        { id: "codex:work", name: "Codex (work)", status: "ok", metrics: [{ label: "Weekly", type: "percent", used: 32 }] },
      ],
    });
    expect(text).toBe("⚡ Codex (personal) 15% | Codex (work) 32%");
  });

  it("does not expose stale cached percentages as live presence", () => {
    const text = formatDiscordUsageActivity({
      fetchedAt: PAYLOAD.fetchedAt,
      providers: [{
        id: "claude", name: "Claude", status: "ok",
        hint: "cached 3m ago — live query is rate limited",
        metrics: [{ label: "Weekly", type: "percent", used: 92 }],
      }],
    });
    expect(text).toBe("⚡ Claude: stale");
    expect(text).not.toContain("92%");
  });

  it("keeps the Discord activity within its 128-code-point limit", () => {
    const text = formatDiscordUsageActivity({
      fetchedAt: PAYLOAD.fetchedAt,
      providers: Array.from({ length: 20 }, (_, i) => ({
        id: `provider-${i}`, name: `Provider-${i}-${"x".repeat(20)}`, status: "ok" as const,
        metrics: [{ label: "Weekly", type: "percent" as const, used: i + 1 }],
      })),
    });
    expect(Array.from(text).length).toBeLessThanOrEqual(128);
    expect(text.endsWith("…")).toBe(true);
  });

  it("uses a non-empty generic fallback when every provider is unavailable", () => {
    expect(formatDiscordUsageActivity({
      fetchedAt: PAYLOAD.fetchedAt,
      providers: [
        { id: "kiro", name: "Kiro", status: "error", error: "temporary outage", metrics: [] },
        { id: "codex", name: "Codex", status: "no-credentials", metrics: [] },
      ],
    })).toBe("⚡ Usage unavailable");
  });
});

describe("getUsageSnapshot", () => {
  it("shares the HTTP route's cache instead of re-fetching", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValue(PAYLOAD);
      setUsageFetcherForTests(fetcher);

      await getUsageSnapshot();
      await getUsageSnapshot();
      expect(fetcher).toHaveBeenCalledTimes(1); // second call is the cache

      // The first force bypasses an automatic cached fetch immediately.
      await getUsageSnapshot(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      // Repeated force requests remain floored to prevent refresh spam.
      await getUsageSnapshot(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(31_000);
      await getUsageSnapshot(true);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("/usage active backend filter", () => {
  it("renders only providers used by running or paused instances", async () => {
    setUsageFetcherForTests(async () => PAYLOAD);
    const sendText = vi.fn().mockResolvedValue({ messageId: "usage" });
    const commands = new TopicCommands({
      adapter: { type: "discord", sendText },
      fleetConfig: { defaults: {}, instances: {} },
      getActiveUsageProviderIds: () => new Set(["codex"]),
    } as any);

    expect(await commands.handleGeneralCommand({
      text: "/usage",
      chatId: "guild",
      threadId: "topic",
      userId: "user",
    } as any)).toBe(true);

    expect(sendText).toHaveBeenCalledTimes(1);
    const rendered = sendText.mock.calls[0][1] as string;
    expect(rendered).toContain("Codex");
    expect(rendered).not.toContain("Claude");
    expect(rendered).not.toContain("Grok");
    expect(rendered).not.toContain("Kiro");
  });
});

describe("rich rendering", () => {
  it("draws proportional bars, clamped to the ends", async () => {
    const { usageBar } = await import("../src/usage/format-rich.js");
    expect(usageBar(0)).toBe("░░░░░░░░░░");
    expect(usageBar(34)).toBe("███░░░░░░░");
    expect(usageBar(100)).toBe("██████████");
    // A vendor reporting "105% used" must not overflow the bar.
    expect(usageBar(105)).toBe("██████████");
    expect(usageBar(-3)).toBe("░░░░░░░░░░");
  });

  it("renders Discord Markdown with bars, plans, and inline failures", async () => {
    const { renderUsageMarkdown } = await import("../src/usage/format-rich.js");
    const text = renderUsageMarkdown(PAYLOAD);

    expect(text).toContain("📊 **AI Subscription Usage**");
    expect(text).toContain("**Claude** (Max)");
    expect(text).toContain("`███░░░░░░░` 34% Session · resets in 3h 0m");
    expect(text).toContain("`██░░░░░░░░` $3.50/$20.00 Extra usage"); // dollars w/ limit gets a bar too
    expect(text).toContain("⚪ **Codex**");
    expect(text).toContain("> not logged in");
    expect(text).toContain("🔴 **Grok**");
    expect(text).toContain("Credits: 812 left");
  });

  it("shows an ok hint instead of generic no data when metrics are temporarily empty", async () => {
    const { renderUsageHtml, renderUsageMarkdown } = await import("../src/usage/format-rich.js");
    const rollover: UsagePayload = {
      fetchedAt: PAYLOAD.fetchedAt,
      providers: [{
        id: "kiro", name: "Kiro", status: "ok", plan: "Kiro",
        hint: "Token refreshing — try again in a moment.", metrics: [],
      }],
    };

    expect(renderUsageMarkdown(rollover)).toContain("> Token refreshing — try again in a moment.");
    expect(renderUsageMarkdown(rollover)).not.toContain("no data");
    expect(renderUsageHtml(rollover)).toContain("Token refreshing — try again in a moment.");
    expect(renderUsageHtml(rollover)).not.toContain("no data");
  });

  it("renders Telegram HTML with every payload string entity-escaped", async () => {
    const { renderUsageHtml } = await import("../src/usage/format-rich.js");
    const hostile: typeof PAYLOAD = {
      fetchedAt: PAYLOAD.fetchedAt,
      providers: [{
        id: "x", name: "Weird & Co", status: "error" as const,
        error: "expected <token> & got </nothing>", metrics: [],
      }],
    };
    const text = renderUsageHtml(hostile);

    // One stray `<` makes Telegram reject the whole message.
    expect(text).toContain("Weird &amp; Co");
    expect(text).toContain("expected &lt;token&gt; &amp; got &lt;/nothing&gt;");
    expect(text).not.toMatch(/<(?!\/?(b|code)>)/); // only <b> and <code> tags survive

    const ok = renderUsageHtml(PAYLOAD);
    expect(ok).toContain("<b>Claude</b> (Max)");
    expect(ok).toContain("<code>███░░░░░░░</code> 34% Session");
  });

  it("colours the provider dot by its hottest metric", async () => {
    const { renderUsageMarkdown } = await import("../src/usage/format-rich.js");
    const hot: typeof PAYLOAD = {
      fetchedAt: PAYLOAD.fetchedAt,
      providers: [{
        id: "c", name: "Claude", status: "ok" as const, plan: null,
        metrics: [
          { label: "Session", type: "percent" as const, used: 12 },
          { label: "Weekly", type: "percent" as const, used: 95 },
        ],
      }],
    };
    // The reader scans for "which one is hot" — a 95% weekly must not hide
    // behind a green dot because the session happens to be fresh.
    expect(renderUsageMarkdown(hot)).toContain("🔴 **Claude**");
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
