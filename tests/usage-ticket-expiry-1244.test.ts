/**
 * #1244 (correcting #1232): the "Rate limit resets: N available" line (額度重置券) shows when the soonest of those
 * tickets expires — "🎫 Nearest expiry: 10/22 (in 16d 6h)" — and the per-backend "⏳ Next reset" line is gone. An
 * expiry is never a reset. Fixture data only (shaped like the live wham/rate-limit-reset-credits answer): no network,
 * no fleet. Expectations written out by hand; the clock is fixed, and every time is mid-day UTC so the date is the
 * same in any host time zone from UTC-5 to UTC+12.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import Database from "better-sqlite3";
import { codexTicketsNearestExpiry, DEFAULT_PROVIDER_DEADLINE_MS, fetchAllUsage, fetchCodexUsage, fetchKiroUsage, setUsageProvidersForTests } from "../src/usage/providers.js";
import { setLocale } from "../src/locale.js";
import type { ProviderUsage, UsageMetric } from "../src/usage/providers.js";
import * as usageApi from "../src/usage/usage-api.js";
import { formatUsageSummary, getUsageSnapshot, setUsageFetcherForTests } from "../src/usage/usage-api.js";
import { renderUsageHtml, renderUsageMarkdown } from "../src/usage/format-rich.js";

const NOW = Date.parse("2026-10-06T00:00:00Z");
const H = 3_600_000, D = 24 * H;
const iso = (s: string) => new Date(Date.parse(s)).toISOString();

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); setLocale("en"); setUsageFetcherForTests(null); setUsageProvidersForTests(null);
  delete process.env.KIRO_CLI_HOME; delete process.env.CODEX_HOME;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ticket = (status: string, expires_at: string | null | undefined) =>
  ({ id: "t", reset_type: "codex_rate_limits", is_supported_by_plan: true, status, granted_at: "2026-09-22T06:00:00Z", expires_at, redeem_started_at: null, redeemed_at: null });

describe("codexTicketsNearestExpiry: min(expires_at) over the available tickets", () => {
  it("the soonest of the available tickets", () => {
    const body = { credits: [ticket("available", "2026-10-29T06:00:00Z"), ticket("available", "2026-10-22T06:00:00Z")], available_count: 2 };
    expect(codexTicketsNearestExpiry(body, NOW)).toBe(iso("2026-10-22T06:00:00Z"));
  });

  it("skips a ticket with no expiry, one already past, one that is not available, and junk", () => {
    const body = { credits: [
      ticket("available", null), ticket("available", undefined), ticket("available", "not a date"),
      ticket("available", "2026-10-05T06:00:00Z"),                       // past
      ticket("redeemed", "2026-10-07T06:00:00Z"), ticket("expired", "2026-10-08T06:00:00Z"),
      null, "x",
      ticket("available", "2026-10-25T06:00:00Z"),
    ] };
    expect(codexTicketsNearestExpiry(body, NOW)).toBe(iso("2026-10-25T06:00:00Z"));
  });

  it("none with an expiry, no tickets, or no list → null", () => {
    expect(codexTicketsNearestExpiry({ credits: [ticket("available", null)] }, NOW)).toBeNull();
    expect(codexTicketsNearestExpiry({ credits: [] }, NOW)).toBeNull();
    expect(codexTicketsNearestExpiry({}, NOW)).toBeNull();
    expect(codexTicketsNearestExpiry(null, NOW)).toBeNull();
  });
});

describe("through the real Codex mapping", () => {
  const USAGE = "https://chatgpt.com/backend-api/wham/usage";
  const TICKETS = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
  function codex(availableCount: number, tickets: (() => Response) | Response) {
    const home = mkdtempSync(join(tmpdir(), "agend-1244-codex-")); dirs.push(home);
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: ["test", "payload", "value"].join("."), account_id: "acct" } }));
    process.env.CODEX_HOME = home;
    const calls: Array<{ url: string; method: string; auth: string | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET", auth: init.headers?.Authorization });
      if (String(url) === USAGE) {
        return new Response(JSON.stringify({ rate_limit: {}, rate_limit_reset_credits: { available_count: availableCount, applicable_available_count: 0 } }), { status: 200 });
      }
      return typeof tickets === "function" ? tickets() : tickets.clone();
    }));
    return calls;
  }
  const resets = (r: { metrics: UsageMetric[] }) => r.metrics.find(m => m.label === "Rate limit resets");
  const list = (...expiries: string[]) => new Response(JSON.stringify({ credits: expiries.map(e => ticket("available", e)), available_count: expiries.length }), { status: 200 });

  it("tickets available: the count, and the soonest expiry read from the tickets' own list (GET only, same login)", async () => {
    const calls = codex(2, list("2026-10-29T06:00:00Z", "2026-10-22T06:00:00Z"));
    const m = resets(await fetchCodexUsage());
    expect([m?.value, m?.expiresAt, m?.resetsAt, m?.resetKind]).toEqual([2, iso("2026-10-22T06:00:00Z"), undefined, undefined]);
    expect(calls.map(c => [c.url, c.method])).toEqual([[USAGE, "GET"], [TICKETS, "GET"]]);
    expect(calls[1]!.auth).toBe(calls[0]!.auth);
  });

  it("no tickets: the list is not asked for, and there is no expiry", async () => {
    const calls = codex(0, list("2026-10-22T06:00:00Z"));
    const m = resets(await fetchCodexUsage());
    expect([m?.value, m?.expiresAt]).toEqual([0, undefined]);
    expect(calls.map(c => c.url)).toEqual([USAGE]);
  });

  it("the list cannot be read (HTTP error, network error, junk): the count still shows, without an expiry", async () => {
    // A 500 that still carries a ticket list is not believed either.
    const errorWithList = () => new Response(JSON.stringify({ credits: [ticket("available", "2026-10-22T06:00:00Z")] }), { status: 500 });
    for (const bad of [errorWithList, () => { throw new Error("offline"); }, () => new Response("<html>", { status: 200 })]) {
      codex(2, bad);
      const r = await fetchCodexUsage();
      expect(r.status).toBe("ok");
      expect([resets(r)?.value, resets(r)?.expiresAt]).toEqual([2, undefined]);
    }
  });
});

describe("the ticket list never costs the row its numbers (#1246 review: the 16s provider deadline)", () => {
  // The real fetchCodexUsage inside the real fetchAllUsage deadline, on fake timers: the usage answer arrives late,
  // then the ticket list stalls. The row must come back ok with its count, only without an expiry.
  const USAGE = "https://chatgpt.com/backend-api/wham/usage";
  async function run(usageDelayMs: number, ticketList: "stall" | "stall-ignoring-abort" | number) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    const home = mkdtempSync(join(tmpdir(), "agend-1246-codex-")); dirs.push(home);
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: ["test", "payload", "value"].join("."), account_id: "acct" } }));
    const calls: Array<{ url: string; at: number; signal?: AbortSignal }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init: { signal?: AbortSignal } = {}) => {
      calls.push({ url: String(url), at: Date.now() - NOW, signal: init.signal });
      if (String(url) === USAGE) {
        return new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify({
          rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_after_seconds: 3_600 } },
          rate_limit_reset_credits: { available_count: 2 },
        }), { status: 200 })), usageDelayMs));
      }
      if (typeof ticketList === "number") {
        return new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify({ credits: [ticket("available", "2026-10-22T06:00:00Z")] }), { status: 200 })), ticketList));
      }
      return new Promise((_resolve, reject) => {
        if (ticketList === "stall") init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }));
    setUsageProvidersForTests([{ id: "codex", name: "Codex", fetch: () => fetchCodexUsage(home) }]);
    let settledAt: number | null = null;
    const snapshot = fetchAllUsage(null as never).then(r => { settledAt = Date.now() - NOW; return r; });
    while (calls.length === 0) await new Promise(r => setImmediate(r));   // auth.json is read for real first
    await vi.advanceTimersByTimeAsync(DEFAULT_PROVIDER_DEADLINE_MS + 1_000);
    const r = await snapshot;
    const row = r.providers.find(p => p.id === "codex")!;
    return { row, settledAt: settledAt as number | null, calls, resets: row.metrics.find(m => m.label === "Rate limit resets") };
  }

  it("usage at 9s, then a ticket list that never answers: ok with the count and the window, no expiry — before the deadline", async () => {
    const { row, settledAt, calls, resets } = await run(9_000, "stall");
    expect([row.status, resets?.value, resets?.expiresAt]).toEqual(["ok", 2, undefined]);
    expect(row.metrics.map(m => m.label)).toEqual(["Session", "Rate limit resets"]);
    expect(calls.map(c => [c.url.split("/").pop(), c.at])).toEqual([["usage", 0], ["rate-limit-reset-credits", 9_000]]);
    expect(calls[1]!.signal?.aborted, "the stalled request is cancelled").toBe(true);
    expect(settledAt).toBe(12_000);                                       // 9s + the 3s ticket budget
  });

  it("even a request that ignores its abort cannot hold the row", async () => {
    const { row, settledAt, resets } = await run(9_000, "stall-ignoring-abort");
    expect([row.status, resets?.value, resets?.expiresAt, settledAt]).toEqual(["ok", 2, undefined, 12_000]);
  });

  it("usage at 14.5s: the list only gets what is left before the deadline, less the margin", async () => {
    const { row, settledAt, resets } = await run(14_500, "stall");
    expect([row.status, resets?.value, resets?.expiresAt, settledAt]).toEqual(["ok", 2, undefined, 15_000]);
  });

  it("usage at 15.5s: no time left — the list is not asked for at all", async () => {
    const { row, calls, resets } = await run(15_500, "stall");
    expect([row.status, resets?.value, resets?.expiresAt]).toEqual(["ok", 2, undefined]);
    expect(calls.map(c => c.url.split("/").pop())).toEqual(["usage"]);
  });

  it("a list that answers within its budget still gives the expiry", async () => {
    const { row, settledAt, resets } = await run(9_000, 2_000);
    expect([row.status, resets?.expiresAt, settledAt]).toEqual(["ok", iso("2026-10-22T06:00:00Z"), 11_000]);
  });
});

const tickets = (expiresAt: string | null, value = 2): UsageMetric =>
  ({ label: "Rate limit resets", labelI18n: { key: "usage.metric.rate_limit_resets" }, type: "count", value, unit: "available", unitI18n: { key: "usage.unit.available" }, ...(expiresAt ? { expiresAt } : {}) });
const weekly: UsageMetric = { label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, type: "percent", used: 10, resetsAt: new Date(NOW + 2 * D + 3 * H).toISOString() };
const codexWith = (m: UsageMetric): ProviderUsage => ({ id: "codex", name: "Codex", status: "ok", metrics: [weekly, m] });
const payload = (m: UsageMetric) => ({ fetchedAt: new Date(NOW).toISOString(), providers: [codexWith(m)] });

describe("/usage: the expiry sits on the ticket line", () => {
  it("plain (and get_usage's formatted text)", () => {
    expect(formatUsageSummary(payload(tickets("2026-10-22T06:00:00Z")))).toBe([
      "📊 AI subscription usage",
      "· Codex: Weekly 10% (resets in 2d 3h) | Rate limit resets 2 available · 🎫 Nearest expiry: 10/22 (in 16d 6h)",
    ].join("\n"));
  });

  it("Discord Markdown and Telegram HTML", () => {
    for (const render of [renderUsageMarkdown, renderUsageHtml]) {
      const lines = render(payload(tickets("2026-10-22T06:00:00Z"))).split("\n");
      expect(lines, render.name).toContain("Rate limit resets: 2 available · 🎫 Nearest expiry: 10/22 (in 16d 6h)");
    }
  });

  it("zh-TW: 額度重置券: 2 可用 · 🎫 最近過期", () => {
    setLocale("zh-TW");
    expect(renderUsageMarkdown(payload(tickets("2026-10-22T06:00:00Z")))).toContain("額度重置券: 2 可用 · 🎫 最近過期：10/22（16d6h 後）");
    expect(formatUsageSummary(payload(tickets("2026-10-22T06:00:00Z")))).toContain("· 🎫 最近過期：10/22（16d6h 後）");
  });

  it("no expiry, or one that has passed since it was read: just the count, as before", () => {
    for (const m of [tickets(null), tickets("2026-10-05T06:00:00Z"), tickets("junk")]) {
      expect(formatUsageSummary(payload(m))).toContain("Rate limit resets 2 available");
      for (const out of [formatUsageSummary(payload(m)), renderUsageMarkdown(payload(m)), renderUsageHtml(payload(m))]) expect(out).not.toContain("🎫");
    }
  });
});

describe("the per-backend ⏳ Next reset line is gone (#1232 misread)", () => {
  it("no ⏳ line in plain, Markdown or HTML; each window keeps its own 'resets in'", () => {
    const p = payload(tickets(null));
    for (const out of [formatUsageSummary(p), renderUsageMarkdown(p), renderUsageHtml(p)]) {
      expect(out).not.toContain("⏳");
      expect(out).not.toMatch(/next reset/i);
      expect(out).toContain("resets in 2d 3h");
    }
  });

  it("get_usage / getUsageSnapshot carry no nextResetAt, and the helpers that made it are gone", async () => {
    setUsageFetcherForTests(async () => payload(tickets("2026-10-22T06:00:00Z")));
    const snap = await getUsageSnapshot(true);
    expect(snap.providers[0]).not.toHaveProperty("nextResetAt");
    expect(snap.providers[0]!.metrics[1]!.expiresAt).toBe("2026-10-22T06:00:00Z");
    expect(Object.keys(usageApi)).not.toContain("nearestResetAt");
    expect(Object.keys(usageApi)).not.toContain("withNextResets");
  });
});

describe("expiry ≠ reset is kept (#1233): Kiro bonus credits are still marked as an expiry", () => {
  it("through the real Kiro mapping", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1244-kiro-")); dirs.push(dir);
    const db = new Database(join(dir, "data.sqlite3"));
    db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run("kirocli:social:token", JSON.stringify({
      access_token: "test-only", region: "us-east-1", expires_at: new Date(NOW + H).toISOString(),
    }));
    db.close();
    process.env.KIRO_CLI_HOME = dir;
    const sec = (ms: number) => Math.floor((NOW + ms) / 1000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ usageBreakdownList: [{
      displayName: "Credit", displayNamePlural: "Credits", currentUsage: 10, usageLimit: 100, nextDateReset: sec(26 * D),
      bonuses: [{ status: "ACTIVE", currentUsage: 1, usageLimit: 10, expiresAt: sec(D) }],
    }] }), { status: 200 })));
    const r = await fetchKiroUsage();
    expect(r.metrics.map(m => [m.label, m.resetKind])).toEqual([["Credits (monthly)", undefined], ["Bonus credits", "expiry"]]);
  });
});

describe("the View usage panel (its own renderer, run as served)", () => {
  // The panel's usage functions, cut from view.html as they are, run with the page's own en/zh strings.
  function panel(lang: "en" | "zh-TW") {
    const html = readFileSync(join(process.cwd(), "src/ui/view.html"), "utf8");
    const start = html.indexOf("  function usageResetText(iso)");
    const end = html.indexOf("  const USAGE_ICON");
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const enStart = html.indexOf("en: {"), zhStart = html.indexOf('"zh-TW": {', enStart);
    const map = html.slice(lang === "en" ? enStart : zhStart, lang === "en" ? zhStart : html.indexOf("\n  };\n  let lang", zhStart));
    const strings: Record<string, string> = {};
    for (const [, k, v] of map.matchAll(/"([a-z_.]+|usage[A-Za-z]+)":\s*"([^"]*)"/g)) strings[k!] = v!;
    const ctx = vm.createContext({ Date, Math, isNaN, T: (k: string) => strings[k] ?? k, esc: (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;") });
    vm.runInContext(`${html.slice(start, end)}\nthis.usageMetricHtml = usageMetricHtml;`, ctx);
    return (m: UsageMetric) => (ctx.usageMetricHtml as (m: UsageMetric) => string)(m);
  }

  it("the ticket row has the expiry under it, en and zh-TW", () => {
    expect(panel("en")(tickets("2026-10-22T06:00:00Z"))).toContain('<div class="u-sub">🎫 Nearest expiry: 10/22 (in 16d 6h)</div>');
    expect(panel("zh-TW")(tickets("2026-10-22T06:00:00Z"))).toContain('<span class="u-label">額度重置券</span><span class="u-val">2 可用</span></div><div class="u-sub">🎫 最近過期：10/22（16d6h 後）</div>');
  });

  it("no expiry, or a past one: the row as before, no sub-line", () => {
    for (const m of [tickets(null), tickets("2026-10-05T06:00:00Z")]) {
      expect(panel("en")(m)).toBe('<div class="u-metric"><div class="u-row"><span class="u-label">Rate limit resets</span><span class="u-val">2 available</span></div></div>');
    }
  });

  it("a window's own 'resets in' is unchanged, and there is no ⏳ top line any more", () => {
    expect(panel("en")(weekly)).toContain('<div class="u-sub">resets in 2d 3h</div>');
    const html = readFileSync(join(process.cwd(), "src/ui/view.html"), "utf8");
    expect(html).not.toContain("⏳");
    expect(html).not.toContain("nextResetAt");
  });
});
