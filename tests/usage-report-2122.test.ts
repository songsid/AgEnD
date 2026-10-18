/**
 * #2122: the usage report's data contracts (docs/design/2122-usage-analysis.md §5) and its honest marks.
 * - §5.1: each ledger hour is tagged with the profile it was read from; hours from before read as unknown.
 * - §5.2: fold, then prune — an hour is counted once, whichever step a crash interrupts; the ledger never prunes past
 *   the rollup's durable checkpoint, and an unwritable rollup keeps every hour in the ledger.
 * - §5.3: days at hour granularity, each day row with its zone.
 * - §5.4: delivered messages, counted once on the first move to delivered (from queued or from uncertain).
 * - §5.5: coverage is what the scanner read; an idle hour inside it is a real zero.
 * - The report: the API-equivalent basis on every amount, Codex's unreported cache writes, unpriced models, backends
 *   AgEnD cannot measure, the agent tool's scope, and the route's gates (usage_panel, the public link).
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addTurn, emptyLedger, pruneLedger, type FileCursor, type Ledger } from "../src/cache-ledger.js";
import { addCoverage, covered, emptyDays, foldHours, localDate, readDays, COVERAGE_MAX } from "../src/usage-rollup.js";
import { buildUsageReport, rangeDates, usageBasis, usageRange, type UsageInstanceInput } from "../src/usage-report.js";
import { CacheService } from "../src/cache-service.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { humanBodyHash, nativeHumanOrigin } from "../src/human-delivery-receipts.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { handleWebRequest } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { guestRouteDecision } from "../src/web-guest-access.js";
import { PRICES_CHECKED, ratesFor } from "../src/cache-prices.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";

const HOUR = 3_600_000, DAY = 86_400_000;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-2122-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.useRealTimers(); vi.restoreAllMocks(); });

const turn = (t: number, model = "claude-opus-4-5", o: Partial<{ uncached: number; read: number; write5m: number; write1h: number; write: number | null; output: number }> = {}) =>
  ({ t, model, prompt: 1000, uncached: o.uncached ?? 100, read: o.read ?? 800, write5m: o.write5m ?? 50, write1h: o.write1h ?? 50, write: o.write ?? null, output: o.output ?? 20 });
const cursor = (kind: "claude" | "codex" = "claude"): FileCursor => ({ kind, ino: 1, offset: 0 });
function ledgerWith(hours: number[], profile?: string, model?: string): Ledger {
  const l = emptyLedger(), c = cursor();
  for (const h of hours) addTurn(l, c, turn(h + 60_000, model), 0, profile);
  return l;
}
const sumRows = (rows: { m: Record<string, number[]> }[]) => rows.reduce((n, r) => n + Object.values(r.m).reduce((a, t) => a + t[0]!, 0), 0);

describe("§5.1 an hour carries the profile it was read from", () => {
  it("one profile, then a second one in the same hour reads mixed; hours from before #2122 have none", () => {
    const l = emptyLedger(), c = cursor(), h = 1_800_000 * HOUR;
    addTurn(l, c, turn(h), 0, "work");
    expect(l.hours[String(h)]!.pf).toBe("work");
    addTurn(l, c, turn(h + 1000), 0, "home");
    expect(l.hours[String(h)]!.pf).toBe("mixed");
    addTurn(l, c, turn(h + HOUR), 0);
    expect(l.hours[String(h + HOUR)]!.pf).toBeUndefined();
  });
  it("a folded hour without a profile is unknown, never today's setting", () => {
    const h = 1_800_000 * HOUR, l = ledgerWith([h]), d = emptyDays();
    foldHours(d, l, h + 2 * HOUR, "UTC");
    expect(d.rows[0]!.pf).toBe("unknown");
  });
});

describe("§5.2 fold, then prune: each hour once", () => {
  const base = 1_800_000 * HOUR;
  it("folds only hours past the checkpoint; a second fold adds nothing", () => {
    const l = ledgerWith([base, base + HOUR, base + 2 * HOUR], "default"), d = emptyDays();
    expect(foldHours(d, l, base + 2 * HOUR, "UTC")).toBe(true);           // the first two hours are past the cutoff
    expect([d.checkpoint, sumRows(d.rows)]).toEqual([base + HOUR, 2]);
    expect(foldHours(d, l, base + 2 * HOUR, "UTC")).toBe(false);
    expect(sumRows(d.rows)).toBe(2);
  });
  it("the ledger never prunes past the durable checkpoint", () => {
    const l = ledgerWith([base, base + HOUR, base + 2 * HOUR]);
    pruneLedger(l, base + 10 * HOUR, base);                                 // only the first is durably folded
    expect(Object.keys(l.hours).map(Number)).toEqual([base + HOUR, base + 2 * HOUR]);
    pruneLedger(l, base + 10 * HOUR, -1);
    expect(Object.keys(l.hours)).toHaveLength(2);
  });
  it("a crash after the rollup is written and before the prune: the next fold adds nothing, the prune finishes", () => {
    const l = ledgerWith([base, base + HOUR]), d = emptyDays();
    foldHours(d, l, base + 5 * HOUR, "UTC");                                // written … and the process dies here
    expect(foldHours(d, l, base + 5 * HOUR, "UTC")).toBe(false);            // restart: the same hours, already held
    pruneLedger(l, base + 5 * HOUR, d.checkpoint);
    expect([Object.keys(l.hours).length, sumRows(d.rows)]).toEqual([0, 2]);
  });
  it("a crash before the rollup is written: nothing moved, the next pass folds it once", () => {
    const l = ledgerWith([base]), d = emptyDays();
    const lost = structuredClone(d); foldHours(lost, l, base + 5 * HOUR, "UTC");   // the copy never reached the disk
    pruneLedger(l, base + 5 * HOUR, d.checkpoint);                          // durable checkpoint: none — nothing pruned
    expect(Object.keys(l.hours)).toHaveLength(1);
    foldHours(d, l, base + 5 * HOUR, "UTC");
    expect(sumRows(d.rows)).toBe(1);
  });
  it("CacheService: an unwritable rollup keeps every old hour in the ledger; once writable they fold and leave", async () => {
    const root = tmp(), dir = join(root, "instances", "a"); mkdirSync(dir, { recursive: true });
    const now = Date.UTC(2026, 9, 18, 12), old = now - 40 * DAY - (now % HOUR);
    writeFileSync(join(dir, "cache-ledger.json"), JSON.stringify(ledgerWith([old, old + HOUR], "default")));
    mkdirSync(join(dir, "usage-days.json"));                                // a directory: the rollup cannot be written
    const svc = new CacheService({
      instances: () => [{ name: "a", backend: "claude-code", workingDirectory: join(root, "wd"), ledgerPath: join(dir, "cache-ledger.json"), claudeConfigDir: join(root, "claude"), profile: "default" }],
      claudeProjectsDir: () => join(root, "claude", "projects"), claudeKey: () => "k", codexSessionsDir: () => join(root, "codex"), listRollouts: () => [],
      metaPath: join(root, "meta.json"), now: () => now, zone: () => "UTC",
    });
    await svc.pass();
    const before = (await svc.usageData()).instances[0]!;
    expect(Object.keys(before.ledger!.hours).length).toBe(2);
    expect(before.days!.checkpoint).toBe(-1);
    rmSync(join(dir, "usage-days.json"), { recursive: true });
    await svc.pass();
    const after = (await svc.usageData()).instances[0]!;
    expect(Object.keys(after.ledger!.hours)).toHaveLength(0);
    expect([after.days!.checkpoint, sumRows(after.days!.rows)]).toEqual([old + HOUR, 2]);
    expect((await readDays(join(dir, "usage-days.json"))).checkpoint).toBe(old + HOUR);
    await svc.stop();
  });
});

describe("§5.3 days at hour granularity, each row with its zone", () => {
  it("an hour belongs to the date its start falls on; a half-hour zone's edge falls on the hour holding midnight", () => {
    const h = Date.UTC(2026, 9, 18, 18);                                    // 23:30 in Kolkata: the hour 18:00–19:00 UTC
    expect(localDate(h, "Asia/Kolkata")).toBe("2026-10-18");
    expect(localDate(h + HOUR, "Asia/Kolkata")).toBe("2026-10-19");
    expect(localDate(h, "Not/AZone")).toBe("2026-10-18");                   // an unknown zone is UTC
  });
  it("rows record the zone they were folded in", () => {
    const h = Date.UTC(2026, 9, 18, 10), d = emptyDays();
    foldHours(d, ledgerWith([h], "default"), h + 2 * HOUR, "Asia/Taipei");
    expect(d.rows.map(r => [r.date, r.zone])).toEqual([["2026-10-18", "Asia/Taipei"]]);
  });
});

describe("§5.5 coverage is what the scanner read", () => {
  it("intervals merge; an hour inside is covered (a real zero when idle); at most COVERAGE_MAX are kept", () => {
    const d = emptyDays(), t = Date.UTC(2026, 9, 18, 9);
    addCoverage(d, t, t + 8 * HOUR);                                        // a fleet running 09:00–17:00, used at 09 and 17
    addCoverage(d, t + 8 * HOUR, t + 9 * HOUR);
    expect(d.coverage).toEqual([[t, t + 9 * HOUR]]);
    expect(covered(d, t + 4 * HOUR)).toBe(true);                            // 13:00 — idle, read: a real zero
    expect(covered(d, t - 2 * HOUR)).toBe(false);                           // before the first pass: not collected
    for (let i = 0; i < COVERAGE_MAX + 10; i++) addCoverage(d, t + (20 + i * 3) * HOUR, t + (21 + i * 3) * HOUR);
    expect(d.coverage.length).toBeLessThanOrEqual(COVERAGE_MAX);
  });
  it("a finished catch-up records [now − 31 days, now]", async () => {
    const root = tmp(), dir = join(root, "instances", "a"), now = Date.UTC(2026, 9, 18, 12);
    const svc = new CacheService({
      instances: () => [{ name: "a", backend: "claude-code", workingDirectory: join(root, "wd"), ledgerPath: join(dir, "cache-ledger.json"), profile: "default" }],
      claudeProjectsDir: () => join(root, "claude", "projects"), claudeKey: () => "k", codexSessionsDir: () => join(root, "codex"), listRollouts: () => [],
      metaPath: join(root, "meta.json"), now: () => now, zone: () => "UTC",
    });
    await svc.kick();
    expect((await readDays(join(dir, "usage-days.json"))).coverage).toEqual([[now - 31 * DAY, now]]);
    await svc.stop();
  });
});

describe("§5.4 delivered messages, once per receipt", () => {
  const person = nativeHumanOrigin("telegram", "bot-one", "42", "person", false, "900")!;
  function receipt(outbox: DeliveryOutbox) {
    const row = outbox.createHumanReceipt({ targetInstance: "leader", originalBody: "original", origin: person, inputKind: "fleet_inbound", managerBootId: "manager" });
    const wire = "[agend-human-id:" + row.message_id + "]\nhi";
    outbox.bindHumanReceipt(row.receipt_id, "leader", "owned", wire, "manager");
    return { row, proof: { receipt_id: row.receipt_id, verification_id: row.message_id, wire_sha256: humanBodyHash(wire), owner_key: "owned", mode: "idle_submit", tag: "unique-id-pane" } };
  }
  it("queued → delivered counts 1; queued → uncertain → delivered counts 1; a repeated settle and an uncertain one count 0", () => {
    const root = tmp(), outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager");
    try {
      const a = receipt(outbox), b = receipt(outbox), c = receipt(outbox);
      expect(outbox.settleHumanReceipt(a.row.receipt_id, "leader", "owned", a.proof, "owned")).toBe(true);
      expect(outbox.settleHumanReceipt(b.row.receipt_id, "leader", "owned", { ...b.proof, tag: "output-edge" }, "owned")).toBe(false);   // uncertain
      expect(outbox.settleHumanReceipt(b.row.receipt_id, "leader", "owned", b.proof, "owned")).toBe(true);                           // then delivered
      expect(outbox.settleHumanReceipt(a.row.receipt_id, "leader", "owned", a.proof, "owned")).toBe(false);                          // again: nothing
      expect(outbox.settleHumanReceipt(c.row.receipt_id, "leader", "owned", { ...c.proof, tag: "output-edge" }, "owned")).toBe(false); // stays uncertain
      const hours = outbox.deliveredMessageHours(0, Date.now() + HOUR);
      expect(hours.map(h => [h.instance, h.count])).toEqual([["leader", 2]]);
      const delivered = outbox.getHumanReceipt(b.row.receipt_id)!.delivered_at!;
      expect(hours[0]!.hour).toBe(Math.floor(Date.parse(delivered) / HOUR) * HOUR);                                                  // its real delivered_at
    } finally { outbox.close(); }
  });
});

describe("the report: honest by construction", () => {
  const now = Date.UTC(2026, 9, 18, 12), h = Date.UTC(2026, 9, 18, 9);
  const ok = (name: string, backend: string, ledger: Ledger, extra: Partial<UsageInstanceInput> = {}): UsageInstanceInput =>
    ({ name, backend, team: null, status: "ok", ledger, days: emptyDays(), ...extra });
  const codexLedger = () => { const l = emptyLedger(); addTurn(l, cursor("codex"), turn(h, "gpt-5.6-sol", { write5m: 0, write1h: 0, write: 0 }), 0, "unrecorded"); return l; };
  const input = (instances: UsageInstanceInput[], o: Record<string, unknown> = {}) => buildUsageReport({ now, zone: "UTC", range: { kind: "today" }, group: "instance", instances,
    messages: [{ instance: "a", hour: h, count: 3 }, { instance: "k", hour: h, count: 2 }], scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 }, ...o } as never);
  it("every amount is the API-equivalent at list price, never spent", () => {
    expect(usageBasis()).toBe(`API-equivalent at list price (checked ${PRICES_CHECKED}) — not money spent`);
    expect(input([]).basis).toBe(usageBasis());
  });
  it("prices a Claude row at list price; Codex writes are not reported and never priced as uncached", () => {
    const r = input([ok("a", "claude-code", ledgerWith([h], "default")), ok("b", "codex", codexLedger())]);
    const a = r.rows.find(x => x.key === "a")!, b = r.rows.find(x => x.key === "b")!;
    const rc = ratesFor("claude-opus-4-5")!;
    expect(a.amount).toBeCloseTo((100 * rc.input + 800 * rc.read + 50 * rc.write5m + 50 * rc.write1h + 20 * rc.output) / 1e6, 10);
    expect([a.priced, a.flags, a.messages]).toEqual(["all", [], 3]);
    const ro = ratesFor("gpt-5.6-sol")!;
    expect(b.amount).toBeCloseTo((100 * ro.input + 800 * ro.read + 20 * ro.output) / 1e6, 10);
    expect(b.flags).toContain("cache_write_not_reported");
  });
  it("an unpriced model: tokens shown, amount null, the instance's sum partial", () => {
    const l = ledgerWith([h], "default", "mystery-model-1");
    addTurn(l, cursor(), turn(h + 1000), 0, "default");
    const r = input([ok("c", "claude-code", l)]);
    expect(r.rows[0]).toMatchObject({ key: "c", priced: "partial", unpriced: ["mystery-model-1"] });
    expect(r.rows[0]!.flags).toContain("not_priced");
    const only = input([ok("d", "claude-code", ledgerWith([h], "default", "mystery-model-1"))]);
    expect([only.rows[0]!.amount, only.rows[0]!.priced, only.rows[0]!.total]).toEqual([null, "none", 1020]);
  });
  it("backends AgEnD cannot measure are listed with their reason, never as a $0 row; shared ones say with whom", () => {
    const r = input([{ name: "k", backend: "kiro-cli", team: null, status: "credit_billed" }, { name: "g", backend: "grok", team: null, status: "unsupported" },
      { name: "s", backend: "claude-code", team: null, status: "shared", with: ["t"] }]);
    expect(r.notMeasured).toEqual([{ name: "k", backend: "kiro-cli", reason: "credit_billed" }, { name: "g", backend: "grok", reason: "unsupported" }]);
    expect(r.shared).toEqual([{ name: "s", backend: "claude-code", with: ["t"] }]);
    // k has delivered messages: a row with its messages, no tokens and no amount — not "$0, cheapest".
    expect(r.rows.find(x => x.key === "k")).toMatchObject({ messages: 2, amount: null, total: 0, priced: "none" });
  });
  it("an hour in both the rollup and the ledger (a crash leftover) counts once", () => {
    const l = ledgerWith([h], "default"), days = emptyDays();
    foldHours(days, l, h + 2 * HOUR, "UTC");                                 // folded, not yet pruned
    const r = input([ok("a", "claude-code", l, { days })]);
    expect(r.rows.find(x => x.key === "a")!.requests).toBe(1);
  });
  it("group by model has no messages; by profile and team as recorded / as configured now", () => {
    const r = input([ok("a", "claude-code", ledgerWith([h], "work"), { team: "core" }), ok("b", "codex", codexLedger(), { team: "core" })], { group: "model" });
    expect(r.rows.map(x => [x.key, x.messages])).toEqual(expect.arrayContaining([["claude-opus-4-5", null], ["gpt-5.6-sol", null]]));
    const p = input([ok("a", "claude-code", ledgerWith([h], "work")), ok("b", "codex", codexLedger())], { group: "profile" });
    expect(p.rows.map(x => x.key).sort()).toEqual(["unrecorded", "work"]);
    const t = input([ok("a", "claude-code", ledgerWith([h], "work"), { team: "core" }), ok("b", "codex", codexLedger(), { team: "core" })], { group: "team" });
    expect(t.rows.find(x => x.key === "core")!.instances.sort()).toEqual(["a", "b"]);
    expect(t.rows.find(x => x.key === "")).toMatchObject({ instances: ["k"], messages: 2 });     // in no team: its own row
  });
  it("ranges are local dates; custom is checked; anything else is 7 days", () => {
    expect(rangeDates({ kind: "today" }, now, "UTC")).toEqual({ from: "2026-10-18", to: "2026-10-18" });
    expect(rangeDates({ kind: "7d" }, now, "UTC")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(rangeDates({ kind: "month" }, now, "UTC")).toEqual({ from: "2026-10-01", to: "2026-10-18" });
    expect(usageRange("custom", "2026-10-01", "2026-10-05")).toEqual({ kind: "custom", from: "2026-10-01", to: "2026-10-05" });
    expect(usageRange("custom", "2026-10-05", "2026-10-01")).toEqual({ kind: "7d" });
    expect(usageRange("forever")).toEqual({ kind: "7d" });
  });
});

describe("get_usage_report: scope and words", () => {
  const report = buildUsageReport({ now: Date.UTC(2026, 9, 18, 12), zone: "UTC", range: { kind: "today" }, group: "instance", messages: [], scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 },
    instances: [{ name: "cheap", backend: "claude-code", team: null, status: "ok", ledger: ledgerWith([Date.UTC(2026, 9, 18, 9)], "default"), days: emptyDays() }] });
  const ask = (ctx: any, caller: string, args: Record<string, unknown>) => new Promise<{ result: any; error: string | null }>((resolve) => {
    void outboundHandlers.get("get_usage_report")!(ctx, args, (result: unknown, error?: string) => resolve({ result, error: error ?? null }), { instanceName: caller } as any);
  });
  it("an ordinary instance reads only its own row, and may not name another; General reads the fleet", async () => {
    const usageReport = vi.fn(async () => report);
    const ctx = { fleetConfig: { instances: { cheap: {}, gt: { general_topic: true } } }, usageReport };
    const own = await ask(ctx, "cheap", { group: "model" });
    expect(own.error).toBeNull();
    expect(usageReport).toHaveBeenLastCalledWith({ range: { kind: "7d" }, group: "instance", only: "cheap" });
    expect((await ask(ctx, "cheap", { instance: "gt" })).error).toMatch(/only its own row/);
    await ask(ctx, "gt", { range: "month", group: "model" });
    expect(usageReport).toHaveBeenLastCalledWith({ range: { kind: "month" }, group: "model" });
  });
  it("every row and the totals carry the basis in words", async () => {
    const r = await ask({ fleetConfig: { instances: {} }, usageReport: async () => report }, "general", {});
    expect(r.result.basis).toBe(usageBasis());
    expect(r.result.rows.every((x: any) => x.basis === usageBasis())).toBe(true);
    expect(r.result.totals.basis).toBe(usageBasis());
  });
});

describe("GET /ui/usage-report: who gets it", () => {
  const X = "a".repeat(32), ORIGIN = "https://sample.trycloudflare.com", TOKEN = "c".repeat(48);
  function get(web: Record<string, unknown> | undefined, publicLink: boolean) {
    const sessions = new WebSessionStore();
    const sid = sessions.create({ tier: "admin", surface: publicLink ? "gateway" : "local", label: "phone", tokenEpoch: tokenEpoch(TOKEN), ...(publicLink ? { exposureId: X } : {}) }).sessionId as string;
    const cookie = publicLink ? `__Host-agend_session=${sid}` : `agend_session=${sid}`;
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/usage-report?range=today", headers: { host: publicLink ? "sample.trycloudflare.com" : "127.0.0.1:19280", cookie } as Record<string, string>, destroy: vi.fn() });
    let status = 0, body = "";
    const res = { destroyed: false, headersSent: false, setHeader: () => {}, writeHead: (code: number) => { status = code; }, end: (text = "") => { body = String(text); }, destroy: vi.fn() };
    if (publicLink) bindGatewayRequest(req, { surface: "gateway", exposureId: X, expectedOrigin: ORIGIN, isCurrent: () => true });
    const usageReport = vi.fn(async () => ({ ok: true }));
    const ctx = { webToken: TOKEN, webSessions: sessions, fleetConfig: { instances: {}, ...(web ? { web } : {}) }, usageReport, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
    expect(handleWebRequest(req as never, res as never, new URL(req.url, publicLink ? ORIGIN : "http://127.0.0.1:19280"), ctx as never)).toBe(true);
    return { status: () => status, body: () => body, usageReport };
  }
  const settle = () => new Promise(r => setTimeout(r, 0));
  it("the local dashboard: yes; web.usage_panel: false: not available", async () => {
    const a = get(undefined, false); await settle();
    expect([a.status(), a.usageReport.mock.calls.length]).toEqual([200, 1]);
    const off = get({ usage_panel: false }, false); await settle();
    expect([off.status(), off.usageReport.mock.calls.length]).toEqual([404, 0]);
  });
  it("the public link: refused unless web.usage_report_on_public_link is true", async () => {
    const no = get(undefined, true); await settle();
    expect([no.status(), JSON.parse(no.body()).error, no.usageReport.mock.calls.length]).toEqual([403, "usage_report_not_over_public_link", 0]);
    const yes = get({ usage_report_on_public_link: true }, true); await settle();
    expect(yes.status()).toBe(200);
  });
  it("a guest: never — the route is not on GUEST_ROUTES (the gate every web request passes before any handler)", () => {
    for (const q of ["/ui/usage-report", "/ui/usage-report?range=today&instance=a"]) {
      expect(guestRouteDecision("GET", new URL(q, ORIGIN), new Set(["a"]))).toEqual({ kind: "deny", status: 403, error: "guest_forbidden" });
    }
  });
});
