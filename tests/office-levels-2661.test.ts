/**
 * #2661: Office levels — what counts as work (no cache reads), the level curve, each hour counted once across the
 * rollup and the ledger, the lifetime file that carries pruned days (written before the prune; a crash between the
 * two writes never counts a day twice or loses one), and who reads what: GET /ui/office-levels (the numbers only where
 * the usage report is served), a share link (the level of its own people only), office_view (the level).
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addTurn, emptyLedger, type HourTotals, type Ledger } from "../src/cache-ledger.js";
import { LEVEL, levelOf, levelsFor, officeLevels, workOf, type OfficeLevel } from "../src/office-levels.js";
import { ROLLUP_KEEP_DAYS, carryPruned, emptyDays, emptyLifetime, foldHours, localDate, pruneDays, readDays, readLifetime, reviveLifetime, type UsageDays } from "../src/usage-rollup.js";
import { CacheService } from "../src/cache-service.js";
import { handleWebRequest } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { guestRouteDecision } from "../src/web-guest-access.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { OfficeShareView, OfficeShares, createOfficeShareGateway, type OfficeShareSource } from "../src/office-share.js";
import { OfficeActs, OfficeActLimiter } from "../src/web-office-acts.js";
import { validateFleetConfig } from "../src/config-validator.js";

const HOUR = 3_600_000, DAY = 86_400_000;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-2661-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

/** [requests, uncached, read, write5m, write1h, write, output] */
const T = (requests: number, uncached: number, read: number, w5: number, w1h: number, w: number, out: number): HourTotals => [requests, uncached, read, w5, w1h, w, out];
const row = (date: string, be: string, t: HourTotals) => ({ date, zone: "UTC", be, pf: "default", m: { "claude-opus-4-5|0": t } });
const turnAt = (t: number) => ({ t, model: "claude-opus-4-5", prompt: 1000, uncached: 100, read: 800_000, write5m: 50, write1h: 50, write: null, output: 20 });
function ledgerWith(hours: number[]): Ledger {
  const l = emptyLedger();
  for (const h of hours) addTurn(l, { kind: "claude", ino: 1, offset: 0 }, turnAt(h + 60_000), 0, "default");
  return l;
}

describe("work and level", () => {
  it("work is everything but cache reads; the level is floor(√(work ÷ 100,000)), uncapped", () => {
    expect(workOf(T(9, 1, 1_000_000, 2, 3, 4, 5))).toBe(15);
    expect(LEVEL.UNIT).toBe(100_000);
    expect([0, 99_999, 100_000, 1_000_000, 260_000_000, 1_000_000_000, 4_000_000_000].map(levelOf)).toEqual([0, 0, 1, 3, 50, 100, 200]);
    expect(levelOf(-5)).toBe(0);
  });
});

describe("officeLevels: lifetime from the usage store", () => {
  const now = Date.UTC(2026, 9, 27, 12), today = "2026-10-27";
  it("rollup days + ledger hours after the checkpoint, each hour once; today and first seen; reads never count", () => {
    const h = now - 2 * HOUR - (now % HOUR);
    const ledger = ledgerWith([h - 30 * HOUR, h]);                       // the first is folded below, the second is not
    const days = emptyDays();
    foldHours(days, ledger, h, "UTC");                                    // checkpoint = the first hour
    days.rows.push(row("2026-09-01", "claude-code", T(3, 1000, 9_000_000, 0, 0, 0, 500)));
    const l = officeLevels({ now, zone: "UTC", instances: [{ name: "a", ledger, days, life: emptyLifetime() }] })["a"]!;
    expect(l.workTokens).toBe(220 + 220 + 1500);                          // one turn's work is 100+50+50+20; reads (800k) left out
    expect(l.today).toEqual({ workTokens: 220, requests: 1 });
    expect(l.firstSeen).toBe("2026-09-01");
    expect([l.level, l.estimated]).toEqual([0, false]);
  });
  it("an estimated backend's work counts and is marked; an instance with nothing is level 0, never seen", () => {
    const days = emptyDays();
    days.rows.push(row(today, "kiro-cli", T(1, 400_000, 0, 0, 0, 0, 0)));
    const out = officeLevels({ now, zone: "UTC", instances: [
      { name: "k", ledger: emptyLedger(), days, life: emptyLifetime() },
      { name: "new", ledger: emptyLedger(), days: emptyDays(), life: emptyLifetime() },
    ] });
    expect(out["k"]).toMatchObject({ level: 2, workTokens: 400_000, estimated: true, today: { workTokens: 400_000, requests: 1 }, firstSeen: today });
    expect(out["new"]).toEqual({ level: 0, workTokens: 0, estimated: false, today: { workTokens: 0, requests: 0 }, firstSeen: null });
  });
  it("the lifetime file's carried total counts, and a day row it already carries is not counted again", () => {
    const days = emptyDays();
    days.rows.push(row("2025-01-01", "claude-code", T(1, 1_000_000, 0, 0, 0, 0, 0)));   // carried, not pruned yet (a crash)
    days.rows.push(row("2026-10-01", "claude-code", T(1, 100, 0, 0, 0, 0, 0)));
    const life = { v: 1 as const, through: "2025-01-01", first: "2024-12-01", by: { "claude-code": T(2, 2_000_000, 0, 0, 0, 0, 0), "kiro-cli": T(1, 0, 0, 0, 0, 0, 500) } };
    const l = officeLevels({ now, zone: "UTC", instances: [{ name: "a", ledger: emptyLedger(), days, life }] })["a"]!;
    expect([l.workTokens, l.firstSeen, l.estimated]).toEqual([2_000_600, "2024-12-01", true]);
  });
});

describe("the lifetime file: carried before the prune, each day once", () => {
  const now = Date.UTC(2026, 9, 27, 12);
  const oldest = localDate(now - ROLLUP_KEEP_DAYS * DAY, "UTC");
  const before = (n: number) => localDate(now - (ROLLUP_KEEP_DAYS + n) * DAY, "UTC");
  function days(): UsageDays {
    const d = emptyDays();
    d.rows.push(row(before(3), "claude-code", T(1, 10, 0, 0, 0, 0, 0)), row(before(1), "codex", T(1, 20, 0, 0, 0, 0, 0)), row(oldest, "claude-code", T(1, 40, 0, 0, 0, 0, 0)));
    return d;
  }
  it("carries the rows about to be pruned, by backend, with the first and last dates; carrying again adds nothing", () => {
    const d = days(), life = emptyLifetime();
    expect(carryPruned(life, d, now, "UTC")).toBe(true);
    expect(life).toEqual({ v: 1, through: before(1), first: before(3), by: { "claude-code": T(1, 10, 0, 0, 0, 0, 0), codex: T(1, 20, 0, 0, 0, 0, 0) } });
    expect(carryPruned(life, d, now, "UTC")).toBe(false);                 // a crash before the prune: nothing twice
    expect(life.by["claude-code"]).toEqual(T(1, 10, 0, 0, 0, 0, 0));
  });
  it("the prune drops only what is carried: nothing while the lifetime file has none", () => {
    const d = days();
    expect(pruneDays(d, now, "UTC", null)).toBe(false);
    expect(d.rows).toHaveLength(3);
    expect(pruneDays(d, now, "UTC", before(2))).toBe(true);               // carried through before(2): before(1) stays
    expect(d.rows.map(r => r.date)).toEqual([before(1), oldest]);
  });
  it("read back: anything that is not a lifetime file is empty; bad entries are dropped", () => {
    expect(reviveLifetime(null)).toEqual(emptyLifetime());
    expect(reviveLifetime({ v: 2, through: "2025-01-01" })).toEqual(emptyLifetime());
    expect(reviveLifetime({ v: 1, through: "nope", first: "2025-01-01", by: { a: [1, 2], b: T(1, 1, 1, 1, 1, 1, 1) } })).toEqual({ v: 1, through: null, first: "2025-01-01", by: { b: T(1, 1, 1, 1, 1, 1, 1) } });
  });

  function service(root: string, dir: string) {
    return new CacheService({
      instances: () => [{ name: "a", backend: "claude-code", workingDirectory: join(root, "wd"), ledgerPath: join(dir, "cache-ledger.json"), claudeConfigDir: join(root, "claude"), profile: "default" }],
      claudeProjectsDir: () => join(root, "claude", "projects"), claudeKey: () => "k", codexSessionsDir: () => join(root, "codex"), listRollouts: () => [],
      metaPath: join(root, "meta.json"), now: () => now, zone: () => "UTC",
    });
  }
  it("CacheService: an unwritable lifetime file prunes nothing; once writable the days are carried, then pruned, and the level holds", async () => {
    const root = tmp(), dir = join(root, "instances", "a"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cache-ledger.json"), JSON.stringify(ledgerWith([now - 40 * DAY - (now % HOUR)])));   // so a pass folds and prunes
    writeFileSync(join(dir, "usage-days.json"), JSON.stringify(days()));
    mkdirSync(join(dir, "usage-lifetime.json"));                          // a directory: it cannot be written
    const svc = service(root, dir);
    await svc.pass();
    expect((await readDays(join(dir, "usage-days.json"))).rows.map(r => r.date)).toContain(before(3));
    const first = (await svc.officeLevels(now))["a"]!;
    rmSync(join(dir, "usage-lifetime.json"), { recursive: true });
    await svc.pass();
    const kept = await readDays(join(dir, "usage-days.json"));
    expect(kept.rows.map(r => r.date)).not.toContain(before(3));
    expect(kept.rows.map(r => r.date)).not.toContain(before(1));
    expect(await readLifetime(join(dir, "usage-lifetime.json"))).toMatchObject({ through: before(1), first: before(3) });
    expect((await svc.officeLevels(now))["a"]).toEqual(first);            // nothing lost, nothing twice
    await svc.stop();
    // A fresh service (a restart) reads the same lifetime back.
    const again = service(root, dir);
    expect((await again.officeLevels(now))["a"]).toEqual(first);
    await again.stop();
  });
});

describe("who reads what", () => {
  const L: Record<string, OfficeLevel> = {
    "dev-a": { level: 12, workTokens: 15_000_000, estimated: false, today: { workTokens: 1000, requests: 3 }, firstSeen: "2026-01-01" },
    "ops-bot": { level: 4, workTokens: 1_700_000, estimated: true, today: { workTokens: 0, requests: 0 }, firstSeen: "2026-05-01" },
  };
  it("levelsFor: the level alone, or the whole entry; only the names asked", () => {
    expect(levelsFor(L, false)).toEqual({ "dev-a": { level: 12 }, "ops-bot": { level: 4 } });
    expect(levelsFor(L, true, new Set(["dev-a"]))).toEqual({ "dev-a": L["dev-a"] });
  });

  const X = "a".repeat(32), ORIGIN = "https://sample.trycloudflare.com", TOKEN = "c".repeat(48);
  function get(web: Record<string, unknown> | undefined, publicLink: boolean, o: { signedIn?: boolean; levels?: () => Promise<Record<string, OfficeLevel> | null> } = {}) {
    const sessions = new WebSessionStore();
    const sid = sessions.create({ tier: "admin", surface: publicLink ? "gateway" : "local", label: "phone", tokenEpoch: tokenEpoch(TOKEN), ...(publicLink ? { exposureId: X } : {}) }).sessionId as string;
    const cookie = o.signedIn === false ? "" : publicLink ? `__Host-agend_session=${sid}` : `agend_session=${sid}`;
    const req = Object.assign(new EventEmitter(), { method: "GET", url: "/ui/office-levels", headers: { host: publicLink ? "sample.trycloudflare.com" : "127.0.0.1:19280", cookie } as Record<string, string>, destroy: vi.fn() });
    let status = 0, body = "";
    const res = { destroyed: false, headersSent: false, setHeader: () => {}, writeHead: (code: number) => { status = code; }, end: (text = "") => { body = String(text); }, destroy: vi.fn() };
    if (publicLink) bindGatewayRequest(req, { surface: "gateway", exposureId: X, expectedOrigin: ORIGIN, isCurrent: () => true });
    const officeLevels = vi.fn(o.levels ?? (async () => L));
    const fleetConfig = { instances: {}, ...(web ? { web } : {}) };
    const ctx = { webToken: TOKEN, webSessions: sessions, fleetConfig, officeLevels, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
    expect(handleWebRequest(req as never, res as never, new URL(req.url, publicLink ? ORIGIN : "http://127.0.0.1:19280"), ctx as never)).toBe(true);
    return { status: () => status, json: () => JSON.parse(body), fleetConfig, signOut: () => sessions.revokeByHandle(sessions.list(undefined, () => true)[0]!.handle) };
  }
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

  it("the dashboard: every level with its numbers; web.usage_panel false: the level only", async () => {
    const a = get(undefined, false); await settle();
    expect([a.status(), a.json()]).toEqual([200, { enabled: true, unit: 100_000, detail: true, levels: L }]);
    const off = get({ usage_panel: false }, false); await settle();
    expect(off.json()).toEqual({ enabled: true, unit: 100_000, detail: false, levels: { "dev-a": { level: 12 }, "ops-bot": { level: 4 } } });
  });
  it("the public link: the level only, unless web.usage_report_on_public_link is true", async () => {
    const no = get(undefined, true); await settle();
    expect([no.status(), no.json().detail, no.json().levels["dev-a"]]).toEqual([200, false, { level: 12 }]);
    const yes = get({ usage_report_on_public_link: true }, true); await settle();
    expect(yes.json().levels["dev-a"]).toEqual(L["dev-a"]);
    expect(isPublicWebRoute("GET", "/ui/office-levels")).toBe(true);
  });
  it("web.office_levels false: no levels; switched off while they were worked out: none either", async () => {
    const off = get({ office_levels: false }, false, { levels: async () => null }); await settle();
    expect(off.json()).toEqual({ enabled: false, unit: 100_000, detail: false, levels: {} });
    let release!: () => void;
    const held = get(undefined, false, { levels: () => new Promise(r => { release = () => r(L); }) });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    (held.fleetConfig as { web?: Record<string, unknown> }).web = { office_levels: false };
    release(); await settle();
    expect(held.json().levels).toEqual({});
  });
  it("not signed in: 401; signed out while worked out: 401; a guest: never routed", async () => {
    const anon = get(undefined, false, { signedIn: false }); await settle();
    expect(anon.status()).toBe(401);
    let release!: () => void;
    const held = get(undefined, false, { levels: () => new Promise(r => { release = () => r(L); }) });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    held.signOut(); release(); await settle();
    expect(held.status()).toBe(401);
    expect(guestRouteDecision("GET", new URL("/ui/office-levels", ORIGIN), new Set(["dev-a"]))).toEqual({ kind: "deny", status: 403, error: "guest_forbidden" });
  });

  function source(levels: Record<string, OfficeLevel> | null): OfficeShareSource {
    const person = (name: string) => ({ name, display_name: name, backend: "claude-code", status: "running", state: "working", model: "opus" });
    return {
      status: () => ({ instances: [person("dev-a"), person("ops-bot"), person("ghost")] }),
      org: () => ({ general: ["ops-bot", "ghost"], teams: [{ name: "dev", members: ["dev-a", "ghost"] }] }),
      offices: () => ({ rev: 1, offices: [{ id: "eng", name: "Eng", skin: "studio", members: ["team:dev"] }] }),
      acts: () => [], traffic: () => ({ now: "t", items: [] }), needs: () => [],
      hidden: n => n === "ghost",
      levels: () => levels,
    };
  }
  it("a share link: the level of its own people only, never the numbers; off: none", () => {
    const L2 = { ...L, ghost: { ...L["dev-a"]!, level: 99 } };
    expect(new OfficeShareView({ office: "eng", text: false }, source(L2)).levels()).toEqual({ enabled: true, unit: 100_000, detail: false, levels: { "dev-a": { level: 12 } } });
    expect(new OfficeShareView({ office: "eng", text: false }, source(null)).levels()).toEqual({ enabled: false, unit: 100_000, detail: false, levels: {} });
  });
  it("a share link's gateway answers /o/<t>/office-levels", async () => {
    const shares = new OfficeShares({ now: () => 1, wall: () => 1, setTimer: () => null, clearTimer: () => {}, changed: () => {} });
    const gw = createOfficeShareGateway({ shares, source: source(L) });
    try {
      const base = await gw.listen();
      gw.setHost("abc.trycloudflare.com");
      const r = shares.create({ office: "eng", owner: "o", exists: () => true });
      if (!r.ok) throw new Error(r.error);
      const body = await new Promise<string>((resolve, reject) => {
        const req = request(new URL(`/o/${r.token}/office-levels`, base), { headers: { host: "abc.trycloudflare.com" } }, res => {
          const c: Buffer[] = []; res.on("data", d => c.push(d)); res.on("end", () => resolve(Buffer.concat(c).toString()));
        });
        req.on("error", reject); req.end();
      });
      expect(JSON.parse(body).levels).toEqual({ "dev-a": { level: 12 } });
    } finally { gw.close(); }
  });

  it("office_view: each member's level, when there is one", () => {
    const a = new OfficeActs({
      offices: () => [{ id: "lab", name: "Lab", skin: "pixel", members: ["alpha", "beta"] }], pack: () => null,
      chart: () => ({ names: ["alpha", "beta"], teams: [] }),
      people: () => ({ stateOf: () => "idle", displayName: () => undefined, level: n => (n === "alpha" ? 7 : undefined) }),
      changed: () => {},
    }, { limiter: new OfficeActLimiter(() => 0) });
    const seen = a.view("alpha", {}) as { offices: Array<{ members: unknown[] }> };
    expect(seen.offices[0]!.members).toEqual([{ name: "alpha", state: "idle", level: 7 }, { name: "beta", state: "idle" }]);
  });

  it("web.office_levels: a boolean", () => {
    expect(validateFleetConfig({ instances: {}, web: { office_levels: false } }).errors).toEqual([]);
    expect(validateFleetConfig({ instances: {}, web: { office_levels: "no" } }).errors.map(e => e.path)).toContain("web.office_levels");
  });
});
