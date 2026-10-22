/**
 * #2236 follow-up (the user, 2026-10-20): a usage row whose live read fails keeps its last known numbers, marked,
 * instead of being wiped by the error.
 * - A fresh failure with a good read before: the old numbers, `stale`, `cachedAt`, `staleCause` (expired / transient /
 *   error), and the error as the hint (how to refresh). Recovery clears the mark.
 * - Never made up: a provider never read successfully keeps its error row; numbers older than a week are not used.
 * - A window that has reset since: its number is dropped and it says "reset since"; a future reset and an expiry are
 *   left alone.
 * - Kept across a restart (usage-last-good.json): written atomically, read once; an unreadable, old or mismatched entry
 *   is no entry.
 * - Every surface: the chat (Markdown, HTML), the MCP text and payload (get_usage), the Discord activity line, and the
 *   page (the dialog and the rail are one component).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatDiscordUsageActivity, formatUsageSummary, getUsageSnapshot, setUsageFetcherForTests, setUsageLastGoodFileForTests,
  type UsagePayload,
} from "../src/usage/usage-api.js";
import type { ProviderUsage } from "../src/usage/providers.js";
import { setLocale } from "../src/locale.js";
import { renderUsageHtml, renderUsageMarkdown } from "../src/usage/format-rich.js";
import { usageClock } from "../src/usage/i18n.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const good = (now: number): ProviderUsage => ({
  id: "claude", name: "Claude", status: "ok", plan: "Max (20x)",
  metrics: [
    { type: "percent", label: "Session", labelI18n: { key: "usage.metric.session" }, used: 91, resetsAt: iso(now + 2 * HOUR), windowMs: 5 * HOUR },
    { type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used: 64, resetsAt: iso(now + 90 * HOUR), windowMs: 168 * HOUR },
    { type: "count", label: "Bonus", value: 30, resetsAt: iso(now + HOUR), resetKind: "expiry" },
  ],
});
const expired: ProviderUsage = {
  id: "claude", name: "Claude", status: "error", metrics: [],
  error: "Access token expired — it refreshes the next time any Claude instance runs.",
  errorI18n: { key: "usage.error.claude_token_expired" },
};
const failed = (error: string): ProviderUsage => ({ id: "claude", name: "Claude", status: "error", error, metrics: [] });

/** One fetcher whose answer flips mid-test (re-setting it would clear memory); the 5-minute snapshot TTL is passed by time. */
function scripted(first: ProviderUsage | null) {
  const s = { next: first as ProviderUsage | null, now: () => Date.now() };
  setUsageFetcherForTests(async () => ({ fetchedAt: iso(Date.now()), providers: s.next ? [s.next] : [] }));
  return s;
}
const read = async () => (await getUsageSnapshot()).providers[0]!;
const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);

afterEach(async () => { vi.useRealTimers(); setUsageFetcherForTests(null); await setUsageLastGoodFileForTests(null); setLocale("en"); });

describe("the server keeps the last known numbers", () => {
  it("a fresh expiry after a good read: the old numbers, marked expired, with the error as the hint; recovery clears it", async () => {
    vi.useFakeTimers({ now: Date.UTC(2030, 0, 1, 6, 0) });
    const t0 = Date.now();
    const s = scripted(good(t0));
    expect((await read()).stale).toBeUndefined();
    await later(10 * 60_000);
    s.next = expired;
    const row = await read();
    expect([row.status, row.stale, row.cachedAt, row.staleCause, row.hint, row.hintI18n?.key, row.plan])
      .toEqual(["ok", true, iso(t0), "expired", expired.error, "usage.error.claude_token_expired", "Max (20x)"]);
    expect(row.metrics.map(m => [m.label, m.used, m.resetPassed])).toEqual([["Session", 91, undefined], ["Weekly", 64, undefined], ["Bonus", undefined, undefined]]);
    await later(10 * 60_000);
    s.next = { ...good(Date.now()), metrics: [{ type: "percent", label: "Session", used: 3, resetsAt: iso(Date.now() + HOUR) }] };
    const back = await read();
    expect([back.stale, back.cachedAt, back.staleCause, back.hint, back.metrics[0]!.used]).toEqual([undefined, undefined, undefined, undefined, 3]);
  });
  it.each([
    ["Could not reach Claude.", "transient", /^cached \d+m ago — live query failed/],
    ["Rate limited by the vendor.", "transient", /^cached \d+m ago — live query is rate limited/],
    ["Invalid response from usage endpoint.", "error", /^Invalid response from usage endpoint\.$/],
    ["Invalid API key (401)", "expired", /^Invalid API key \(401\)$/],
  ] as const)("any failure keeps them: %s → %s", async (error, cause, hint) => {
    vi.useFakeTimers({ now: Date.UTC(2030, 0, 1, 6, 0) });
    const s = scripted(good(Date.now()));
    await read();
    await later(10 * 60_000);
    s.next = failed(error);
    const row = await read();
    expect([row.status, row.stale, row.staleCause, row.metrics[0]!.used]).toEqual(["ok", true, cause, 91]);
    expect(row.hint).toMatch(hint);
  });
  it("the row is as it is now (its name, its profile), with the numbers as they were", async () => {
    vi.useFakeTimers({ now: Date.UTC(2030, 0, 1, 6, 0) });
    const s = scripted(good(Date.now()));
    await read();
    await later(10 * 60_000);
    s.next = { ...expired, name: "Claude (default)", defaultLogin: true };      // the same login, beside profiles since (#2250)
    const row = await read();
    expect([row.id, row.name, row.defaultLogin, row.stale, row.metrics[1]!.used]).toEqual(["claude", "Claude (default)", true, true, 64]);
    await later(10 * 60_000);
    s.next = { ...good(Date.now()), id: "claude:work", name: "Claude (work)", profile: "work", defaultLogin: true } as ProviderUsage;
    await read();
    await later(10 * 60_000);
    s.next = { ...expired, id: "claude:work", name: "Claude (work)", profile: "work" };
    const prof = await read();
    expect([prof.profile, prof.defaultLogin, prof.stale], "nothing of the cached row's own tags").toEqual(["work", undefined, true]);
  });
  it("never made up: a provider never read successfully keeps its error row; a signed-out row is left as it is", async () => {
    vi.useFakeTimers({ now: Date.UTC(2030, 0, 1, 6, 0) });
    const s = scripted(expired);
    const row = await read();
    expect([row.status, row.stale, row.error, row.metrics]).toEqual(["error", undefined, expired.error, []]);
    s.next = good(Date.now());
    await later(10 * 60_000); await read();
    await later(10 * 60_000);
    s.next = { id: "claude", name: "Claude", status: "no-credentials", metrics: [] };
    expect((await read()).status, "signed out is not a failed read").toBe("no-credentials");
  });
  it("numbers older than a week are not used", async () => {
    vi.useFakeTimers({ now: Date.UTC(2030, 0, 1, 6, 0) });
    const s = scripted(good(Date.now()));
    await read();
    await later(7 * 24 * HOUR + 60_000);
    s.next = expired;
    expect([(await read()).status, (await read()).stale]).toEqual(["error", undefined]);
  });
  it("a window that has reset since: no number, marked resetPassed; a later reset and an expiry are left alone", async () => {
    vi.useFakeTimers({ now: Date.UTC(2030, 0, 1, 6, 0) });
    const t0 = Date.now();
    const s = scripted(good(t0));
    await read();
    await later(3 * HOUR);                                                      // past the session reset (2 h), not the weekly
    s.next = expired;
    const [session, weekly, bonus] = (await read()).metrics;
    expect([session!.resetPassed, "used" in session!, session!.resetsAt]).toEqual([true, false, iso(t0 + 2 * HOUR)]);
    expect([weekly!.resetPassed, weekly!.used]).toEqual([undefined, 64]);
    expect([bonus!.resetPassed, bonus!.value], "an expiry is not a reset").toEqual([undefined, 30]);
  });
  it("a reset that passes while the snapshot is reused is marked on the next read, with no new fetch (Prism #2257 P2)", async () => {
    vi.useFakeTimers({ now: Date.UTC(2030, 0, 1, 6, 0) });
    const t0 = Date.now();
    let fetches = 0;
    const row0 = { ...good(t0), metrics: [{ type: "percent" as const, label: "Session", used: 91, resetsAt: iso(t0 + 11 * 60_000) },
      { type: "count" as const, label: "Bonus", value: 30, resetsAt: iso(t0 + 11 * 60_000), resetKind: "expiry" as const }] };
    let next: ProviderUsage = row0;
    setUsageFetcherForTests(async () => { fetches++; return { fetchedAt: iso(Date.now()), providers: [next] }; });
    await read();
    await later(10 * 60_000);
    next = expired;
    const before = await read();
    expect([before.stale, before.metrics[0]!.used, before.metrics[0]!.resetPassed, fetches]).toEqual([true, 91, undefined, 2]);
    await later(60_000 + 1);                                                    // past the reset, inside the snapshot's 5 minutes
    const after = await read();
    expect([after.stale, "used" in after.metrics[0]!, after.metrics[0]!.resetPassed, after.cachedAt, after.staleCause, fetches])
      .toEqual([true, false, true, before.cachedAt, "expired", 2]);
    expect([after.metrics[1]!.value, after.metrics[1]!.resetPassed], "an expiry is not a reset").toEqual([30, undefined]);
  });
});

describe("kept across a restart", () => {
  it("written atomically after a good read, read once by a fresh process; old, malformed or mismatched entries are none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-2236-lg-")), file = join(dir, "usage-last-good.json");
    try {
      vi.useFakeTimers({ now: Date.UTC(2030, 0, 1, 6, 0) });
      const t0 = Date.now();
      scripted(good(t0));
      await setUsageLastGoodFileForTests(file);
      await read();
      await vi.waitFor(async () => { await setUsageLastGoodFileForTests(file); expect(existsSync(file)).toBe(true); });
      expect([JSON.parse(readFileSync(file, "utf8")).v, statSync(file).mode & 0o777]).toEqual([1, 0o600]);
      // A restart: memory gone, the file stays.
      scripted(expired); await setUsageLastGoodFileForTests(file);
      const row = await read();
      expect([row.stale, row.cachedAt, row.staleCause, row.metrics[1]!.used]).toEqual([true, iso(t0), "expired", 64]);
      // One bad entry is skipped, the valid one beside it still loads, and a read never breaks (Prism #2257 P2).
      const valid = { at: t0, provider: good(t0) };
      for (const [why, bad] of [
        ["a null metric", { at: t0, provider: { ...good(t0), id: "codex", metrics: [null] } }],
        ["a metric of the wrong shape", { at: t0, provider: { ...good(t0), id: "codex", metrics: [{ type: "percent", label: "S", used: "91" }] } }],
        ["an unparsable reset", { at: t0, provider: { ...good(t0), id: "codex", metrics: [{ type: "percent", label: "S", used: 1, resetsAt: "soon" }] } }],
        ["a time no Date can hold", { at: Number.MAX_VALUE, provider: { ...good(t0), id: "codex" } }],
        ["a time in the future", { at: t0 + 8 * 24 * HOUR, provider: { ...good(t0), id: "codex" } }],
        ["a plan of the wrong type", { at: t0, provider: { ...good(t0), id: "codex", plan: 5 } }],
        ["a pool of the wrong shape (#2240)", { at: t0, provider: { ...good(t0), id: "codex", metrics: [{ type: "percent", label: "S", used: 1, pool: { label: 5 } }] } }],
        ["a pool whose words are junk (#2460 review)", { at: t0, provider: { ...good(t0), id: "codex", metrics: [{ type: "percent", label: "S", used: 1, pool: { label: "Gemini", labelI18n: { key: 5 } } }] } }],
      ] as const) {
        writeFileSync(file, JSON.stringify({ v: 1, rows: { claude: valid, codex: bad } }));
        setUsageFetcherForTests(async () => ({ fetchedAt: iso(Date.now()), providers: [expired, { ...expired, id: "codex", name: "Codex" }] }));
        await setUsageLastGoodFileForTests(file);
        const [c, x] = (await getUsageSnapshot()).providers;
        expect([c!.stale, c!.metrics[1]!.used, x!.status, x!.stale], why).toEqual([true, 64, "error", undefined]);
      }
      // #2240: a metric's pool (agy's Gemini 4 Argon…) is kept across a restart.
      const pooled = { ...good(t0), id: "codex", metrics: [{ type: "percent", label: "Gemini 4 Argon (weekly)", used: 12, windowMs: 6048e5, pool: { label: "Gemini 4 Argon", labelI18n: { key: "usage.metric.named", args: ["Gemini 4 Argon"] } } }] };
      writeFileSync(file, JSON.stringify({ v: 1, rows: { claude: valid, codex: { at: t0, provider: pooled } } }));
      setUsageFetcherForTests(async () => ({ fetchedAt: iso(Date.now()), providers: [expired, { ...expired, id: "codex", name: "Codex" }] }));
      await setUsageLastGoodFileForTests(file);
      const kept = (await getUsageSnapshot()).providers[1]!;
      expect([kept.stale, kept.metrics[0]!.pool]).toEqual([true, pooled.metrics[0]!.pool]);
      // An unreadable file, an entry older than a week, or one whose id is not its key: nothing.
      for (const body of ["{not json", JSON.stringify({ v: 1, rows: { claude: { at: t0 - 8 * 24 * HOUR, provider: good(t0) } } }),
        JSON.stringify({ v: 1, rows: { claude: { at: t0, provider: { ...good(t0), id: "codex" } } } }), JSON.stringify({ v: 2, rows: {} })]) {
        writeFileSync(file, body);
        scripted(expired); await setUsageLastGoodFileForTests(file);
        expect([(await read()).status], body.slice(0, 40)).toEqual(["error"]);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the chat, MCP and Discord text", () => {
  const now = Date.now();
  const payload = (): UsagePayload => ({ fetchedAt: iso(now), providers: [{
    id: "claude", name: "Claude", status: "ok", plan: "Max (20x)", stale: true, cachedAt: iso(now - 20 * 60_000), staleCause: "expired",
    hint: expired.error, hintI18n: expired.errorI18n,
    metrics: [
      { type: "percent", label: "Session", labelI18n: { key: "usage.metric.session" }, resetsAt: iso(now - 10 * 60_000), resetPassed: true },
      { type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used: 64, resetsAt: iso(now + 90 * HOUR) },
    ],
  }] });
  it("say expired · cached at <time> with how to refresh; a reset since says so, with no number", () => {
    setLocale("zh-TW");
    const cached = usageClock(iso(now - 20 * 60_000)), reset = usageClock(iso(now - 10 * 60_000));
    for (const text of [renderUsageMarkdown(payload()), renderUsageHtml(payload()), formatUsageSummary(payload())]) {
      expect(text).toContain(`已過期 · 快取於 ${cached} — Access token 已過期`);
      expect(text).toContain(`已於 ${reset} 重置`);
      expect(text).toContain("64%");
      expect(text).not.toMatch(/\b0%/);                                          // never the reset window as 0% or its old number
    }
    setLocale("en");
    expect(formatUsageSummary(payload())).toContain(`expired · cached at ${cached} — Access token expired`);
  });
  it("a transient one says only when; the Discord line says stale, never an old number as live", () => {
    const p = payload(); p.providers[0] = { ...p.providers[0]!, staleCause: "transient", hint: "cached 20m ago — live query is rate limited", hintI18n: undefined };
    expect(formatUsageSummary(p)).toContain(`(not updated · cached at ${usageClock(p.providers[0]!.cachedAt)})`);
    expect(formatDiscordUsageActivity(payload())).toBe("⚡ Claude: stale");
  });
});

let usage: any, i18n: any, pg: AppPage | null = null;
beforeAll(async () => {
  const p0 = page({ storage: { agend_tour_done: "1" } });
  usage = await import("/assets/usage-dialog.js");
  i18n = await import("/assets/app-i18n.js");
  p0.restore();
});
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } i18n?.setLang("en"); });

describe("the page (the dialog and the rail)", () => {
  it("greyed numbers, '已過期 · 快取於 <time>' with how to refresh under it; a reset since has no bar; a fresh row is as before", async () => {
    const now = Date.now();
    const snap = { fetchedAt: iso(now), providers: [
      { id: "claude", name: "Claude", status: "ok", plan: "Max (20x)", stale: true, cachedAt: iso(now - 20 * 60_000), staleCause: "expired",
        hint: expired.error, hintI18n: expired.errorI18n,
        metrics: [{ type: "percent", label: "Session", labelI18n: { key: "usage.metric.session" }, resetsAt: iso(now - 10 * 60_000), resetPassed: true },
          { type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used: 64, resetsAt: iso(now + 90 * HOUR) }] },
      { id: "codex", name: "Codex", status: "ok", stale: true, cachedAt: iso(now - 5 * 60_000), staleCause: "transient", hint: "cached 5m ago — live query is rate limited",
        metrics: [{ type: "percent", label: "Weekly", used: 30, resetsAt: iso(now + HOUR) }] },
      { id: "kiro", name: "Kiro", status: "ok", metrics: [{ type: "percent", label: "Monthly", used: 10, resetsAt: iso(now + HOUR) }] },
    ] };
    pg = page({ storage: { agend_tour_done: "1" } });
    i18n.setLang("zh-TW");
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => snap });
    await pg.mount(h(usage.UsageBody, { owner: "t2236-stale" }));
    await settle(3);
    const [claude, codex, kiro] = pg.root.querySelectorAll(".u-provider") as any[];
    const mark = claude.querySelector(".u-stale"), detail = claude.querySelector(".u-stale-detail");
    expect([claude.className, mark.textContent, detail.textContent, mark.getAttribute("title")])
      .toEqual(["u-provider is-stale", `已過期 · 快取於 ${usage.usageClock(iso(now - 20 * 60_000))}`, "Access token 已過期；下次啟動任一 Claude instance 時會重新整理。", "Access token 已過期；下次啟動任一 Claude instance 時會重新整理。"]);
    const [session, weekly] = claude.querySelectorAll(".u-metric");
    expect([session.className, session.querySelector(".u-meter"), session.querySelector(".u-val").textContent])
      .toEqual(["u-metric u-reset-since", null, `已於 ${usage.usageClock(iso(now - 10 * 60_000))} 重置`]);
    expect(weekly.querySelector(".u-pct").textContent).toBe("64%");
    expect([codex.querySelector(".u-stale").textContent, codex.querySelector(".u-stale-detail")], "a transient one: when, nothing more")
      .toEqual([`暫時無法更新 · 快取於 ${usage.usageClock(iso(now - 5 * 60_000))}`, null]);
    expect([kiro.className, kiro.querySelector(".u-stale")]).toEqual(["u-provider", null]);
  });
  it("a stale row from an older server (no cachedAt) shows its hint, as before", () => {
    expect(usage.staleNote({ stale: true, hint: "cached 3m ago — live query is rate limited" })).toEqual({ mark: "cached 3m ago — live query is rate limited", detail: "" });
    expect(usage.staleNote({ status: "ok" })).toBeNull();
  });
});
