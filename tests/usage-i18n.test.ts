import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setLocale, t } from "../src/locale.js";
import { renderUsageHtml, renderUsageMarkdown } from "../src/usage/format-rich.js";
import { formatUsageSummary, type UsagePayload } from "../src/usage/usage-api.js";
import { USAGE_I18N_KEYS } from "../src/usage/i18n-keys.js";

afterEach(() => {
  setLocale("en");
  vi.useRealTimers();
});

describe("usage i18n key parity", () => {
  it("defines every semantic key in both server locales and both View locales", () => {
    const view = readFileSync(join(process.cwd(), "src/ui/view.html"), "utf8");
    const enStart = view.indexOf("en: {");
    const zhStart = view.indexOf('"zh-TW": {', enStart);
    const mapsEnd = view.indexOf("\n  };\n  let lang", zhStart);
    expect(enStart).toBeGreaterThanOrEqual(0);
    expect(zhStart).toBeGreaterThan(enStart);
    expect(mapsEnd).toBeGreaterThan(zhStart);
    const enView = view.slice(enStart, zhStart);
    const zhView = view.slice(zhStart, mapsEnd);

    for (const locale of ["en", "zh-TW"] as const) {
      setLocale(locale);
      for (const key of USAGE_I18N_KEYS) expect(t(key), `${locale}: ${key}`).not.toBe(key);
    }
    for (const key of USAGE_I18N_KEYS) {
      const property = `"${key}":`;
      expect(enView, `View en: ${key}`).toContain(property);
      expect(zhView, `View zh-TW: ${key}`).toContain(property);
    }
    expect(view).toContain("usageLocalized(m.label, m.labelI18n)");
    expect(view).toContain("usageLocalized(m.value ?? \"\", m.valueI18n)");
    expect(view).toContain("usageLocalized(p.hint, p.hintI18n)");
    expect(view).toContain("usageLocalized(p.error || T(\"usage.error_fallback\"), p.errorI18n)");
    expect(view).toContain('key: "usage.duration.hours_minutes"');
  });
});

describe("localized usage renderers", () => {
  const at = (days: number, hours: number, minutes: number) =>
    new Date(Date.UTC(2026, 7, 1) + ((days * 24 + hours) * 60 + minutes) * 60_000).toISOString();

  const payload = (): UsagePayload => ({
    fetchedAt: new Date(Date.UTC(2026, 7, 1)).toISOString(),
    providers: [{
      id: "codex", name: "Codex <Pro>", status: "ok", plan: "Vendor & Plan",
      metrics: [
        { label: "Session", labelI18n: { key: "usage.metric.session" }, type: "percent", used: 28, resetsAt: at(0, 2, 20) },
        { label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, type: "percent", used: 41, resetsAt: at(4, 16, 0) },
        { label: "Model <X> (weekly)", labelI18n: { key: "usage.metric.named_weekly", args: ["Model <X>"] }, type: "percent", used: 7 },
        { label: "Rate limit resets", labelI18n: { key: "usage.metric.rate_limit_resets" }, type: "count", value: 1, unit: "available", unitI18n: { key: "usage.unit.available" } },
        { label: "Credits", labelI18n: { key: "usage.metric.credits" }, type: "count", value: 0, unit: "credits", unitI18n: { key: "usage.unit.credits" }, note: "≈ $0.00" },
        { label: "Pay as you go", labelI18n: { key: "usage.metric.pay_as_you_go" }, type: "text", value: "Disabled", valueI18n: { key: "usage.value.disabled" } },
      ],
    }],
  });

  it("renders zh-TW labels and minute-precision reset durations in chat and MCP text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 1)));
    setLocale("zh-TW");

    const markdown = renderUsageMarkdown(payload());
    const plain = formatUsageSummary(payload());
    for (const text of [markdown, plain]) {
      expect(text).toContain("AI 訂閱用量");
      expect(text).toMatch(/(?:28% Session|Session 28%)/);
      expect(text).toContain("2小時20分鐘後重置");
      expect(text).toMatch(/(?:41% 每週|每週 41%)/);
      expect(text).toContain("4天16小時後重置");
      expect(text).toContain("Model <X>（每週）");
      expect(text).toContain("額度重置券");
      expect(text).toContain("1 可用");
      expect(text).toContain("額度");
      expect(text).toContain("0 額度");
      expect(text).toContain("隨用隨付");
      expect(text).toContain("已停用");
    }
  });

  it("keeps English output English and escapes dynamic vendor strings in Telegram HTML", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 1)));
    setLocale("en");
    const html = renderUsageHtml(payload());
    expect(html).toContain("AI Subscription Usage");
    expect(html).toContain("resets in 2h 20m");
    expect(html).toContain("Model &lt;X&gt; (weekly)");
    expect(html).toContain("Codex &lt;Pro&gt;");
    expect(html).toContain("Vendor &amp; Plan");
  });

  it("leaves unkeyed vendor errors untouched while escaping them for HTML", () => {
    setLocale("zh-TW");
    const vendor: UsagePayload = {
      fetchedAt: new Date().toISOString(),
      providers: [{ id: "vendor", name: "Vendor", status: "error", error: "expected <token> & retry", metrics: [] }],
    };
    expect(renderUsageMarkdown(vendor)).toContain("expected <token> & retry");
    expect(renderUsageHtml(vendor)).toContain("expected &lt;token&gt; &amp; retry");
  });
});
