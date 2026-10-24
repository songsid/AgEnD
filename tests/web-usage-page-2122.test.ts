/**
 * #2122 part 2: Fleet → Usage on the web — the page (docs/design/2122-usage-analysis.md §4, §6).
 * - It reads once per opening and per choice of range or grouping, never on a timer (#1374).
 * - Rows ranked by the API-equivalent, each with its marks in words (Codex writes not reported, not priced, source
 *   unknown); the basis line on every view; not-measured and shared agents with their reason, never a $0 row.
 * - Refusals are states the page explains: the public link without the key (403), web.usage_panel: false (404).
 * - The CSV is the same answer's daily rows, with the basis, and never a formula; the trend's top 5 and others; the
 *   heatmap tells a day read with nothing used from a day not collected.
 * - The ◔ dialog links to it from the app (not View's reader, not a guest).
 * The answers are built by the server's own buildUsageReport, so the page is tested against the real shape.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addTurn, emptyLedger, type Ledger } from "../src/cache-ledger.js";
import { emptyDays } from "../src/usage-rollup.js";
import { buildUsageReport, type UsageInstanceInput } from "../src/usage-report.js";
import { shellRoute } from "../src/web-shell-routes.js";
import { guestRouteDecision } from "../src/web-guest-access.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 12);
const at = (daysAgo: number, hour = 9) => Date.UTC(2026, 9, 18 - daysAgo, hour);
type T = Partial<{ uncached: number; read: number; write5m: number; write1h: number; write: number | null; output: number; reasoning: number }>;
function ledger(turns: Array<[number, string, T?]>, reader: "claude" | "codex" | "kiro" = "claude", profile = reader === "codex" ? "unrecorded" : "default"): Ledger {
  const l = emptyLedger(), c = { kind: reader, ino: 1, offset: 0 } as const;
  for (const [t, model, o = {}] of turns) addTurn(l, { ...c }, { t, model, prompt: 1000, uncached: o.uncached ?? 1000, read: o.read ?? 8000, write5m: o.write5m ?? 0, write1h: o.write1h ?? 500, write: o.write ?? null, output: o.output ?? 200, reasoning: o.reasoning }, 0, profile);
  return l;
}
const coverage = (from: number, to: number) => ({ ...emptyDays(), coverage: [[from, to]] as Array<[number, number]> });
const inst = (name: string, backend: string, l?: Ledger, o: Partial<UsageInstanceInput> = {}): UsageInstanceInput =>
  ({ name, backend, team: null, status: "ok", ledger: l ?? emptyLedger(), days: coverage(NOW - 31 * DAY, NOW), ...o });
function report(o: { range?: any; group?: any; instances?: UsageInstanceInput[]; messages?: any[] } = {}) {
  return buildUsageReport({
    now: NOW, zone: "UTC", range: o.range ?? { kind: "7d" }, group: o.group ?? "instance",
    scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 },
    messages: o.messages ?? [{ instance: "billing", hour: at(1), count: 4 }],
    instances: o.instances ?? [
      inst("billing", "claude-code", ledger([[at(1), "claude-opus-4-5"], [at(1, 10), "claude-opus-4-5"], [at(3), "claude-opus-4-5"]])),
      inst("indexer", "codex", ledger([[at(2), "gpt-5.6-sol", { write5m: 0, write1h: 0, write: 0 }]], "codex")),
      inst("lab", "claude-code", ledger([[at(0), "made-up-model-9"]])),
      inst("kiro-helper", "kiro-cli", undefined, { status: "credit_billed" }),
      inst("twin", "claude-code", undefined, { status: "shared", with: ["twin-b"] }),
    ],
  });
}

let p: AppPage, U: any, fleet: any, D: any;
let reqs: string[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: null };
const fetchFake = async (url: string) => {
  reqs.push(url);
  if (url.startsWith("/api/ai-usage")) return { ok: true, status: 200, json: async () => ({ providers: [], fetchedAt: new Date(NOW).toISOString() }) };
  return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
};
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/usage" });
  (globalThis as any).fetch = fetchFake;
  fleet = await import("/ui/js/panel-fleet.js");
  U = await import("/ui/js/fleet-usage.js");
  D = await import("/assets/usage-dialog.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => { vi.useRealTimers(); await p.unmount(); reqs = []; answer = { status: 200, body: report() }; delete p.document.body.dataset.tier; });
const mount = async () => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "usage" }, navKey: "fleet:usage|1|en" })); await settle(6); };
const rows = () => p.root.querySelectorAll(".us-row");
const cell = (row: any, label: string) => row.querySelectorAll("td").find((td: any) => td.getAttribute("data-label") === label)?.textContent;
const name = (row: any) => row.querySelector(".us-name .mono").textContent;
const btn = (text: string) => p.root.querySelectorAll(".us-bar-top .btn").find((b: any) => b.textContent.trim() === text);

describe("the route: a Fleet tab, never a guest's, the public link's shell", () => {
  it("/ui/fleet/usage is the app shell's; a guest is refused it; the public link may load the shell (the report has its own gate)", () => {
    expect(shellRoute("GET", "/ui/fleet/usage")).toEqual({ kind: "shell", route: { panel: "fleet", tab: "usage" } });
    expect(guestRouteDecision("GET", new URL("http://x/ui/fleet/usage"), new Set(["billing"]))).toEqual({ kind: "deny", status: 403, error: "guest_forbidden" });
    expect(isPublicWebRoute("GET", "/ui/fleet/usage")).toBe(true);
    expect(isPublicWebRoute("GET", "/ui/js/fleet-usage.js")).toBe(true);
  });
});

describe("it reads once per opening and per choice; never on a timer", () => {
  it("7 days by agent on opening, nothing in ten minutes; a range, a grouping and custom days each read once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const m = mount(); await vi.advanceTimersByTimeAsync(80); await m;
    expect(reqs).toEqual(["/ui/usage-report?range=7d&group=instance"]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reqs).toHaveLength(1);
    vi.useRealTimers();
    expect(btn("7 days").getAttribute("aria-pressed")).toBe("true");
    btn("This month").click(); await settle(6);
    expect(reqs.at(-1)).toBe("/ui/usage-report?range=month&group=instance");
    const select = p.root.querySelector(".us-group select");
    select.value = "backend"; fire(select, "change"); await settle(6);
    expect(reqs.at(-1)).toBe("/ui/usage-report?range=month&group=backend");
    btn("Custom").click(); await settle(6);
    expect(reqs.at(-1)).toMatch(/^\/ui\/usage-report\?range=custom&group=backend&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
    expect(p.root.querySelectorAll(".us-custom input").map((i: any) => i.getAttribute("type"))).toEqual(["date", "date"]);
  });
});

describe("what it shows", () => {
  it("rows ranked by the API-equivalent, its basis in words, each row's numbers and marks", async () => {
    await mount();
    expect(p.root.querySelector(".us-basis").textContent).toBe(`API-equivalent at list price (checked ${(answer.body as any).pricesChecked}) — not money spent. Subscriptions are not billed per token.`);
    expect(rows().map(name)).toEqual(["billing", "indexer", "lab"]);
    const [billing, indexer, lab] = rows();
    expect(cell(billing, "API-equivalent")).toMatch(/^\$\d+\.\d\d$/);
    expect([cell(billing, "Requests"), cell(billing, "Messages"), cell(billing, "Input")]).toEqual(["3", "4", "3k"]);
    expect(cell(indexer, "Cache write")).toBe("—");                                    // not reported, not 0
    expect(indexer.querySelector(".us-flags").textContent).toBe("cache writes not reported (Codex) — an estimate");
    expect(cell(lab, "API-equivalent")).toBe("not priced");
    expect(lab.querySelector(".us-flags").textContent).toBe("not priced: made-up-model-9");
    expect(p.root.querySelectorAll(".us-totals dt").map((e: any) => e.textContent)).toEqual(["API-equivalent", "Total tokens", "Requests", "Messages"]);
    expect(p.root.querySelectorAll(".us-totals dd")[0].textContent).toMatch(/^\$\d+\.\d\d \(partial\)$/);
  });
  it("each row's bar is drawn at its real width: round caps, never a stretched viewBox (#2136 follow-up)", async () => {
    await mount();
    for (const bar of p.root.querySelectorAll(".us-bar")) {
      expect([bar.getAttribute("viewBox"), bar.getAttribute("preserveAspectRatio")]).toEqual([null, null]);
      expect(bar.querySelector(".us-bar-bg").getAttribute("width")).toBe("100%");
    }
    expect(rows().map((r: any) => r.querySelector(".us-bar-fg").getAttribute("width"))[0]).toBe("100%");   // the top row: full
    expect(rows().every((r: any) => /^\d+%$/.test(r.querySelector(".us-bar-fg").getAttribute("width")) && r.querySelector(".us-bar-fg").getAttribute("rx") === "3")).toBe(true);
  });
  it("not measured and shared agents: below, with their reason — never a $0 row", async () => {
    await mount();
    const rest = p.root.querySelectorAll(".us-rest .row-item").map((li: any) => li.textContent);
    expect(rest).toEqual(["kiro-helperkiro-cli · Kiro is credit-billed and records no tokens", "twinclaude-code · shares its working directory with twin-b; their transcripts can't be told apart"]);
    expect(rows().map(name)).not.toContain("kiro-helper");
  });
  it("grouped by team: the label says teams are as configured now; no team has its own name", async () => {
    answer = { status: 200, body: report({ group: "team" }) };
    await mount();
    expect(p.root.querySelector(".us-fresh").textContent).toContain("Teams as configured now.");
  });
  it("hours from before #2122 say so; a row with only messages shows them", async () => {
    const legacy = emptyLedger();
    legacy.hours[String(at(1))] = { m: { "claude-opus-4-5|0": [2, 100, 800, 0, 50, 0, 20] }, g: [0, 0, 0, 0, 0, 0, 0] };
    answer = { status: 200, body: report({ instances: [inst("old", "claude-code", legacy)], messages: [{ instance: "talker", hour: at(1), count: 2 }] }) };
    await mount();
    const old = rows().find((r: any) => name(r) === "old");
    expect(old.querySelector(".us-flags").textContent).toBe("read before backend and profile were recorded");
    expect(cell(rows().find((r: any) => name(r) === "talker"), "Messages")).toBe("2");
  });
  it("reasoning (#2122 §10.3): a Codex row shows it; a CLI that reports none reads —, never a measured 0", async () => {
    answer = { status: 200, body: report({ messages: [], instances: [
      inst("billing", "claude-code", ledger([[at(1), "claude-opus-4-5"]])),
      inst("indexer", "codex", ledger([[at(1), "gpt-5.6-sol", { output: 900, reasoning: 600, write: 0 }]], "codex")),
    ] }) };
    await mount();
    expect(cell(rows().find((r: any) => name(r) === "billing"), "Reasoning")).toBe("—");
    const codex = rows().find((r: any) => name(r) === "indexer");
    expect([cell(codex, "Output"), cell(codex, "Reasoning")]).toEqual(["300", "600"]);
  });
  it("Kiro (#2122 §10.2): its row says estimated, and the totals give the estimated part of the amount", async () => {
    answer = { status: 200, body: report({ messages: [], instances: [
      inst("billing", "claude-code", ledger([[at(1), "claude-opus-4-5"]])),
      inst("coordinator", "kiro-cli", ledger([[at(1), "claude-sonnet-4.6", { write1h: 0 }]], "kiro")),
    ] }) };
    await mount();
    const kiro = rows().find((r: any) => name(r) === "coordinator");
    expect(kiro.querySelector(".us-flags").textContent).toBe("estimated from text size — Kiro records no token counts");
    expect(rows().find((r: any) => name(r) === "billing").querySelector(".us-flags")).toBeNull();
    const est = (answer.body as any).totals.amountEstimated;
    expect(est).toBeGreaterThan(0);
    expect(p.root.querySelector(".us-totals .us-est").textContent).toBe(`of which estimated: ${U.money ? U.money(est) : (await import("/ui/js/fleet-cache.js")).money(est)}`);
    const csv = U.usageCsv(answer.body).trimEnd().split("\r\n");
    expect(csv.find((l: string) => l.includes(",coordinator,"))!.endsWith(",estimated,yes")).toBe(true);
    expect(csv.find((l: string) => l.includes(",billing,claude-code,"))!.endsWith(",no")).toBe(true);
  });
  it("scanning: says totals may still grow, and Refresh reads again", async () => {
    answer = { status: 200, body: { ...report(), scanning: { active: true, caughtUp: false, pendingBytes: 5e6, pendingFiles: 2 } } };
    await mount();
    expect(p.root.querySelector(".us-scan").textContent).toContain("Scanning — totals may still grow.");
    p.root.querySelector(".us-scan .btn").click(); await settle(6);
    expect(reqs.filter((u) => u.startsWith("/ui/usage-report"))).toHaveLength(2);
  });
});

describe("a refusal read late never covers a newer answer", () => {
  /** Answers in order of asking: each may hold its body until released. */
  function scripted(answers: Array<{ status: number; body: unknown; hold?: boolean }>) {
    const releases: Array<() => void> = [];
    let k = 0;
    (globalThis as any).fetch = async (url: string) => {
      reqs.push(url);
      if (!url.startsWith("/ui/usage-report")) return fetchFake(url);
      const a = answers[Math.min(k++, answers.length - 1)]!;
      const body = a.hold ? new Promise(r => releases.push(() => r(a.body))) : Promise.resolve(a.body);
      return { ok: a.status < 400, status: a.status, json: () => body };
    };
    return releases;
  }
  afterEach(() => { (globalThis as any).fetch = fetchFake; });
  it("a 403 whose body is held, then a newer 200 shown: releasing the old body changes nothing", async () => {
    const releases = scripted([{ status: 200, body: report() }, { status: 403, body: { error: "usage_report_not_over_public_link" }, hold: true }, { status: 200, body: report({ range: { kind: "month" } }) }]);
    await mount();
    expect(rows().length).toBe(3);
    btn("All").click(); await settle(4);                                           // asked: 403, its body held
    btn("This month").click(); await settle(6);                                    // asked again: 200, shown
    expect(p.root.querySelector(".us-row")).not.toBeNull();
    releases[0]!(); await settle(6);
    expect([p.root.querySelector(".empty"), rows().length]).toEqual([null, 3]);    // still the newer answer
  });
  it("control: the same held 403 with nothing newer is shown once released", async () => {
    const releases = scripted([{ status: 403, body: { error: "usage_report_not_over_public_link", settings: "http://localhost:19280/settings/web" }, hold: true }]);
    await mount();
    expect(p.root.querySelector(".empty")).toBeNull();
    releases[0]!(); await settle(6);
    expect(p.root.querySelector(".empty-title").textContent).toBe("Not offered over the public link");
  });
});

describe("states it explains", () => {
  it("nothing collected yet: the empty state says where usage comes from", async () => {
    answer = { status: 200, body: report({ instances: [inst("fresh", "claude-code", undefined, { days: emptyDays() })], messages: [] }) };
    await mount();
    expect(p.root.querySelector(".empty").textContent).toContain("Nothing recorded yet");
    expect(p.root.querySelector(".empty").textContent).toContain("Usage is read from Claude Code and Codex transcripts");
  });
  it("the public link without the key (403): not offered there, why, and a working link to where it is turned on", async () => {
    answer = { status: 403, body: { error: "usage_report_not_over_public_link", settings: "http://localhost:19280/settings/web" } };
    await mount();
    expect(p.root.querySelector(".empty-title").textContent).toBe("Not offered over the public link");
    expect(p.root.querySelector(".empty-hint").textContent).toBe("Usage is offered over the public link only when \"Usage report over the public link\" is on in Settings → Web dashboard — on the dashboard reached directly, on the computer running AgEnD.");
    const fix = p.root.querySelector(".us-fix");
    expect([fix.textContent, fix.getAttribute("href")]).toEqual(["Open Settings → Web dashboard on that computer", "http://localhost:19280/settings/web"]);
    // Anything else in that field is not followed: no link rather than a wrong one.
    await p.unmount();
    answer = { status: 403, body: { error: "usage_report_not_over_public_link", settings: "https://elsewhere.example/settings/web" } };
    await mount();
    expect(p.root.querySelector(".us-fix")).toBeNull();
  });
  it("web.usage_panel: false (404): turned off", async () => {
    answer = { status: 404, body: { error: "Not available" } };
    await mount();
    expect(p.root.querySelector(".empty").textContent).toBe("Usage is turned offweb.usage_panel: false hides it.");
  });
});

describe("the CSV: this answer's daily rows", () => {
  it("columns, the basis on each token row, messages on their own rows; never a formula", () => {
    const r = report({ instances: [inst("billing", "claude-code", ledger([[at(1), "=HYPERLINK(\"x\")"], [at(1), "claude-opus-4-5"]]))] });
    const lines = U.usageCsv(r).trimEnd().split("\r\n");
    expect(lines[0]).toBe("date,zone,instance,backend,model,tier,profile,input,output,reasoning,cache_read,cache_write_5m,cache_write_1h,cache_write,requests,messages,amount,basis,flags,estimated");
    const formula = lines.find((l: string) => l.includes("HYPERLINK"))!;
    expect(formula).toContain(`,"'=HYPERLINK(""x"")",`);
    const priced = lines.find((l: string) => l.includes("claude-opus-4-5"))!;
    expect(priced.split(",").slice(0, 7)).toEqual(["2026-10-17", "UTC", "billing", "claude-code", "claude-opus-4-5", "standard", "default"]);
    expect(priced).toContain(",API-equivalent at list price (checked ");
    expect(lines.at(-1)).toBe(`2026-10-17,UTC,billing,,,,,,,,,,,,,4,,${r.basis},,`);          // every row carries the basis
    expect(U.csvField("-1")).toBe("'-1");
    // #2122 §10.3: reasoning after output, output net of it (tokscale's daily-row units).
    const thinker = U.usageCsv(report({ instances: [inst("indexer", "codex", ledger([[at(1), "gpt-5.6-sol", { output: 900, reasoning: 600, write: 0 }]], "codex"))], messages: [] }))
      .trimEnd().split("\r\n")[1].split(",");
    expect(thinker.slice(7, 10)).toEqual(["1000", "300", "600"]);
    expect(U.csvField("@x")).toBe("'@x");
  });
  it("the button downloads it, named for the range", async () => {
    await mount();
    let blob: any = null, named = "";
    (globalThis as any).URL.createObjectURL = (b: any) => { blob = b; return "blob:x"; };
    (globalThis as any).URL.revokeObjectURL = () => {};
    const append = p.document.body.appendChild.bind(p.document.body);
    p.document.body.appendChild = (el: any) => { if (el.tagName?.toLowerCase() === "a") { named = el.download; el.click = () => {}; } return append(el); };
    try { p.root.querySelector(".us-csv").click(); } finally { p.document.body.appendChild = append; }
    expect(named).toBe("agend-usage-2026-10-12-2026-10-18.csv");
    expect(await blob.text()).toBe(U.usageCsv(answer.body));
  });
});

describe("what the charts say about a day (Prism R1)", () => {
  it("a day used only by a model not in the price table is used — never \"read, nothing used\" — and says it is not priced", async () => {
    await mount();                                                                 // lab used made-up-model-9 today
    const today = p.root.querySelectorAll(".us-h").find((r: any) => r.querySelector("title").textContent.startsWith("2026-10-18"));
    expect(today.getAttribute("class")).toMatch(/^us-h l\d$/);
    expect(today.querySelector("title").textContent).toBe("2026-10-18: 10k tokens · not priced");
    const mixed = U.dayText("2026-10-17", { tokens: 9700, amount: 0.5, unpriced: true, zones: new Map([["UTC", { tokens: 9700, amount: 0.5 }]]) });
    expect(mixed).toBe("2026-10-17: 10k tokens · $0.50 · part not priced");
    expect(p.root.querySelector(".us-unpriced").textContent).toBe("Not priced, so not in these bars: made-up-model-9. Their tokens are in the rows and the heatmap.");
  });
  it("a daily answer cut to its latest whole days (built by buildUsageReport): said so; the charts and the CSV start there", async () => {
    // 3 agents × 2 models × 30 days of rows over a cap lowered for the test is the same code path as 20,000 real ones.
    const many = Array.from({ length: 10 }, (_, a) => inst(`agent-${a}`, "claude-code", ledger(Array.from({ length: 25 }, (_, k) => [at(k), k % 2 ? "claude-opus-4-5" : "claude-sonnet-4-5"] as [number, string]))));
    const full = buildUsageReport({ now: NOW, zone: "UTC", range: { kind: "month" }, group: "instance", instances: many, messages: [], scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 } });
    expect(full.dailyTruncated).toBe(false);
    const msgs = [{ instance: "agent-0", hour: at(10), count: 2 }, { instance: "agent-0", hour: at(1), count: 3 }];
    const cut = buildUsageReport({ now: NOW, zone: "UTC", range: { kind: "month" }, group: "instance", instances: many, messages: msgs, scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 }, dailyMax: 40 } as never);
    expect([cut.dailyTruncated, cut.dailyFrom]).toEqual([true, "2026-10-15"]);                    // 4 whole days of 10
    expect(cut.daily.every((d: any) => d.date >= "2026-10-15")).toBe(true);
    expect(cut.daily.length).toBe(40);
    expect(cut.totals.requests).toBe(full.totals.requests);                                       // the totals stay whole
    expect(cut.messagesDaily.map((m: any) => m.date)).toEqual(["2026-10-17"]);                    // messages by day: the same window
    expect(cut.totals.messages).toBe(5);                                                          // their total stays whole
    answer = { status: 200, body: cut };
    await mount();
    expect(p.root.querySelector(".us-partial").textContent).toBe("Daily detail from 2026-10-15: the earlier days in this range are too many rows to send. The rows and totals above cover the whole range; the trend, the heatmap and the CSV start at 2026-10-15.");
    expect(p.root.querySelectorAll(".us-h").length).toBe(4);                                      // no day before it drawn as idle
    expect(p.root.querySelector(".us-csv").textContent.trim()).toBe("Download CSV (from 2026-10-15)");
    expect(U.usageCsv(cut).trimEnd().split("\r\n").slice(1).every((l: string) => l >= "2026-10-15")).toBe(true);
  });
  it("the latest day alone over the cap (built by buildUsageReport): no daily detail at all, said so; no chart, no CSV", async () => {
    // One day, 6 source/model rows, a cap of 4: no whole day fits — never 4 of its 6 rows passed off as the day.
    const models = ["claude-opus-4-5", "claude-sonnet-4-5", "made-up-a", "made-up-b", "made-up-c", "made-up-d"];
    const one = [inst("billing", "claude-code", ledger(models.map((m, k) => [at(0, k), m] as [number, string])))];
    const msgs = [{ instance: "billing", hour: at(0, 1), count: 3 }];
    const r = buildUsageReport({ now: NOW, zone: "UTC", range: { kind: "today" }, group: "instance", instances: one, messages: msgs, scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 }, dailyMax: 4 } as never);
    expect([r.dailyTruncated, r.dailyFrom, r.daily.length, r.messagesDaily.length]).toEqual([true, null, 0, 0]);
    expect([r.totals.requests, r.totals.messages]).toEqual([6, 3]);                                // the totals stay whole
    answer = { status: 200, body: r };
    await mount();
    expect(p.root.querySelector(".us-partial").textContent).toBe("No daily detail for this range: even its latest day has more rows than one answer carries, and a part of a day is never shown as the day. The rows and totals above are complete; the trend, the heatmap and the CSV need the daily detail and are not shown.");
    expect([p.root.querySelectorAll(".us-h").length, p.root.querySelector(".us-chart")]).toEqual([0, null]);
    expect(p.root.querySelector(".us-csv").disabled).toBe(true);
    expect(cell(rows()[0], "Requests")).toBe("6");
  });
  it("the timezone changed: a date made in two zones shows each part, and the page says the zone changed", async () => {
    const days = { ...emptyDays(), checkpoint: at(1, 0) - HOUR, coverage: [[NOW - 31 * DAY, NOW]] as Array<[number, number]>,
      rows: [{ date: "2026-10-17", zone: "Asia/Taipei", be: "claude-code", pf: "default", m: { "claude-opus-4-5|0": [2, 2000, 16000, 0, 1000, 0, 400] as [number, number, number, number, number, number, number] } }] };
    const r = report({ instances: [inst("billing", "claude-code", ledger([[at(1, 9), "claude-opus-4-5"]]), { days })], messages: [] });
    expect(new Set(r.daily.filter((d: any) => d.date === "2026-10-17").map((d: any) => d.zone))).toEqual(new Set(["Asia/Taipei", "UTC"]));
    answer = { status: 200, body: r };
    await mount();
    expect(p.root.querySelector(".us-partial").textContent).toBe("The fleet's timezone changed: these days were made in Asia/Taipei, UTC. A day keeps the zone it was made in, so a day made in two shows each part (see the heatmap). Days from now on are in UTC.");
    const d17 = p.root.querySelectorAll(".us-h").find((x: any) => x.querySelector("title").textContent.startsWith("2026-10-17"));
    expect(d17.querySelector("title").textContent).toMatch(/^2026-10-17: \d+k tokens · \$\d+\.\d\d \(Asia\/Taipei: \d+k, UTC: \d+k\)$/);
  });
});

describe("the trend and the heatmap", () => {
  it("the top 5 agents and Others, labelled in text; tokens when nothing is priced", () => {
    // Given least first: the series are ranked by the measure, not taken in the order they come.
    const six = ["a1", "a2", "a3", "a4", "a5", "a6"].map((n, i) => inst(n, "claude-code", ledger(Array.from({ length: 6 - i }, (_, k) => [at(1, k), "claude-opus-4-5"] as [number, string])))).reverse();
    const r = report({ instances: six, messages: [] });
    const dates = U.datesBetween(r.range.from, r.range.to);
    const s = U.trendSeries(r, dates);
    expect([s.priced, s.names]).toEqual([true, ["a1", "a2", "a3", "a4", "a5", "Others"]]);
    expect(s.values[0][dates.indexOf("2026-10-17")]).toBeGreaterThan(s.values[4][dates.indexOf("2026-10-17")]);
    const unpriced = report({ instances: [inst("x", "claude-code", ledger([[at(1), "made-up-model-9"]]))], messages: [] });
    expect(U.trendSeries(unpriced, dates)).toMatchObject({ priced: false, names: ["x"] });
  });
  it("on the page: an svg with a text description and a legend", async () => {
    await mount();
    expect(p.root.querySelector(".us-chart").getAttribute("aria-label")).toBe("Daily API-equivalent for 2 agents, 2026-10-12 to 2026-10-18.");
    expect(p.root.querySelector(".us-scale").textContent).toMatch(/^Tallest day: \$\d+\.\d\d$/);
    expect(p.root.querySelectorAll(".us-legend .mono").map((e: any) => e.textContent)).toEqual(["billing", "indexer"]);   // lab is unpriced: no amount
  });
  it("the heatmap: a day read with nothing used is not a day not collected", async () => {
    // Read from 3 days ago; used 1 day ago; the 4 days before were never read.
    answer = { status: 200, body: report({ instances: [inst("billing", "claude-code", ledger([[at(1), "claude-opus-4-5"]]), { days: coverage(at(3, 0), NOW) })], messages: [] }) };
    await mount();
    const day = (d: string) => p.root.querySelectorAll(".us-h").find((r: any) => r.querySelector("title").textContent.startsWith(d));
    expect(day("2026-10-17").getAttribute("class")).toBe("us-h l1");
    expect(day("2026-10-16").getAttribute("class")).toBe("us-h idle");
    expect(day("2026-10-16").querySelector("title").textContent).toBe("2026-10-16: read, nothing used");
    expect(day("2026-10-13").getAttribute("class")).toBe("us-h gap");
    expect(day("2026-10-13").querySelector("title").textContent).toBe("2026-10-13: not collected");
    expect(p.root.querySelector(".us-heatmap").getAttribute("aria-label")).toBe("7 days; 1 with usage, 3 not collected.");
  });
  it("levels: quartiles of the days with usage; none is 0", () => {
    const level = U.levels([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect([0, 1, 2, 3, 5, 8].map(level)).toEqual([0, 1, 1, 2, 3, 4]);
  });
});

describe("the ◔ dialog links here from the app", () => {
  const link = async () => { await p.mount(h(D.UsageBody, { owner: "t" })); await settle(6); return p.root.querySelector(".u-by-agent"); };
  it("on the app: By agent → /ui/fleet/usage; a guest's page: none", async () => {
    const a = await link();
    expect([a.textContent, a.getAttribute("href")]).toEqual(["By agent →", "/ui/fleet/usage"]);
    await p.unmount();
    p.document.body.dataset.tier = "guest";
    expect(await link()).toBeNull();
  });
});
