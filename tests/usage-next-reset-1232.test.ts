/**
 * #1232 — each backend's soonest quota reset, on a line of its own in /usage (plain and rich) and the View usage
 * panel, and as `nextResetAt` in the get_usage payload. Fixture usage data only: no network, no fleet.
 * Expectations written out by hand; the clock is fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setLocale } from "../src/locale.js";
import type { ProviderUsage, UsageMetric } from "../src/usage/providers.js";
import { formatUsageSummary, getUsageSnapshot, nearestResetAt, setUsageFetcherForTests, withNextResets } from "../src/usage/usage-api.js";
import { renderUsageHtml, renderUsageMarkdown } from "../src/usage/format-rich.js";

const NOW = Date.parse("2026-10-06T00:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const H = 3_600_000, M = 60_000, D = 24 * H;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); setLocale("en"); setUsageFetcherForTests(null); });

const pct = (label: string, used: number, resetsAt: string | null, extra: Partial<UsageMetric> = {}): UsageMetric =>
  ({ label, type: "percent", used, resetsAt, ...extra });
const provider = (id: string, metrics: UsageMetric[], extra: Partial<ProviderUsage> = {}): ProviderUsage =>
  ({ id, name: id[0]!.toUpperCase() + id.slice(1), status: "ok", metrics, ...extra });

const claude = provider("claude", [pct("Session (5h)", 40, at(5 * H + 12 * M)), pct("Weekly", 22, at(3 * D + 5 * H))]);
const codex = provider("codex", [pct("Weekly", 10, at(2 * D + 3 * H)), pct("5h", 0, at(-10 * M))]);  // one window already past
// Grok outside a weekly period: only the pay-as-you-go text — nothing says when it resets.
const grokNoPeriod = provider("grok", [{ label: "Pay as you go", type: "text", value: "Disabled" }]);
// Grok in a weekly period: the period end is its reset.
const grokWeekly = provider("grok", [pct("Weekly limit", 30, at(4 * D)), { label: "Pay as you go", type: "text", value: "Disabled" }]);

describe("nearestResetAt: min(resetsAt) over a provider's windows", () => {
  it("the soonest window still ahead", () => {
    expect(nearestResetAt(claude, NOW)).toBe(at(5 * H + 12 * M));
  });

  it("a window already past is skipped, not reported as 'now'", () => {
    expect(nearestResetAt(codex, NOW)).toBe(at(2 * D + 3 * H));
  });

  it("nothing that says when it resets → null (Grok outside a weekly period); Grok's weekly period end counts", () => {
    expect(nearestResetAt(grokNoPeriod, NOW)).toBeNull();
    expect(nearestResetAt(grokWeekly, NOW)).toBe(at(4 * D));
  });

  it("junk and missing times are ignored; an idle per-model window (hidden noise) is not the account's reset", () => {
    const p = provider("agy", [
      pct("Model A", 0, at(10 * M), { scope: "model" }),     // hidden: unused per-model window
      pct("Model B", 35, at(6 * H), { scope: "model" }),     // shown: in use
      pct("Daily", 5, "not a date"),
      pct("Monthly", 5, null),
      { label: "Credits", type: "dollars", used: 3, limit: 10, resetsAt: at(9 * D) },
    ]);
    expect(nearestResetAt(p, NOW)).toBe(at(6 * H));
  });

  it("withNextResets stamps ok providers only, as of the moment it runs", () => {
    const payload = { fetchedAt: at(-4 * M), providers: [claude, grokNoPeriod, provider("kiro", [pct("x", 1, at(H))], { status: "error", error: "boom" })] };
    const out = withNextResets(payload, NOW);
    expect(out.providers.map(p => p.nextResetAt)).toEqual([at(5 * H + 12 * M), null, undefined]);
    expect(withNextResets(payload, NOW + 6 * H).providers[0]!.nextResetAt, "a later call skips the window that has passed").toBe(at(3 * D + 5 * H));
    expect(payload.providers[0]).not.toHaveProperty("nextResetAt");
  });
});

describe("get_usage / getUsageSnapshot carry nextResetAt", () => {
  it("on every ok provider of the snapshot", async () => {
    setUsageFetcherForTests(async () => ({ fetchedAt: at(0), providers: [claude, codex, grokNoPeriod] }));
    const snap = await getUsageSnapshot(true);
    expect(snap.providers.map(p => [p.id, p.nextResetAt])).toEqual([
      ["claude", at(5 * H + 12 * M)], ["codex", at(2 * D + 3 * H)], ["grok", null],
    ]);
  });
});

describe("/usage shows it on a line of its own", () => {
  const payload = () => withNextResets({ fetchedAt: at(0), providers: [claude, codex, grokNoPeriod, provider("kiro", [], { status: "no-credentials" })] }, NOW);

  it("plain (and the MCP formatted text): under each provider that has one; none for Grok without a period", () => {
    const lines = formatUsageSummary(payload()).split("\n");
    const after = (prefix: string) => lines[lines.findIndex(l => l.startsWith(prefix)) + 1];
    expect(after("· Claude:")).toBe("  ⏳ Next reset: 5h 12m");
    expect(after("· Codex:")).toBe("  ⏳ Next reset: 2d 3h");
    expect(after("· Grok:")?.startsWith("  ⏳")).toBe(false);
    expect(lines.filter(l => l.includes("⏳"))).toHaveLength(2);
  });

  it("zh-TW", () => {
    setLocale("zh-TW");
    expect(formatUsageSummary(payload())).toContain("  ⏳ 下次重置：5h12m");
  });

  it("Discord Markdown and Telegram HTML: right under the provider's name", () => {
    for (const render of [renderUsageMarkdown, renderUsageHtml]) {
      const lines = render(payload()).split("\n");
      const under = (name: string) => lines[lines.findIndex(l => l.includes(name)) + 1];
      expect(under("Claude"), render.name).toBe("⏳ Next reset: 5h 12m");
      expect(under("Codex"), render.name).toBe("⏳ Next reset: 2d 3h");
      expect(lines.filter(l => l.startsWith("⏳")), render.name).toHaveLength(2);
    }
  });

  it("a reset that has passed since it was worked out shows nothing — never 'next reset' in the past", () => {
    const p = { fetchedAt: at(0), providers: [provider("claude", [pct("Weekly", 22, at(-M))], { nextResetAt: at(-M) })] };
    expect(formatUsageSummary(p)).not.toContain("⏳");
    expect(renderUsageMarkdown(p)).not.toContain("⏳");
    expect(renderUsageHtml(p)).not.toContain("⏳");
  });

  it("a provider that is not ok shows its note, never a reset", () => {
    const p = { fetchedAt: at(0), providers: [provider("kiro", [pct("x", 1, at(H))], { status: "error", error: "boom", nextResetAt: at(H) })] };
    expect(renderUsageMarkdown(p)).not.toContain("⏳");
    expect(formatUsageSummary(p)).not.toContain("⏳");
  });
});

describe("the View usage panel", () => {
  it("a top line with each backend's soonest reset, names escaped", () => {
    const html = readFileSync(join(process.cwd(), "src/ui/view.html"), "utf8");
    expect(html).toContain('"usage.next_resets": "⏳ Next reset"');
    expect(html).toContain('"usage.next_resets": "⏳ 下次重置"');
    expect(html).toMatch(/\.filter\(p => p\.status === "ok" && p\.nextResetAt && new Date\(p\.nextResetAt\)\.getTime\(\) > Date\.now\(\)\)/);
    expect(html).toContain('.map(p => `${esc(p.name)} ${esc(usageResetText(p.nextResetAt))}`)');
  });
});
