/**
 * #3708 (hxhsandy's issue; the owner approved it with limits): the public link's (gateway) session limits are
 * configurable — `web.session.public_link.idle_minutes` / `absolute_hours`.
 * - Defaults unchanged: 30 min unused, 8 h in all.
 * - Longer only with a fixed hostname (a named tunnel); on a quick tunnel a value can only shorten them.
 * - Caps: idle ≤ 24 h (1440 min), absolute ≤ 7 days (168 h) — validator, Settings handler and the store's own clamp.
 * - Never longer than the account's own policy: `web.session.local` for an admin, `web.guests.session` for a guest.
 * - Lengthening goes through the settings confirmation; shortening applies at once.
 * - Settings → Access & security shows them; their words are in a new strings file (SKEW: an open tab's old string
 *   modules lack them), in English and zh-TW.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SESSION_POLICY, GUEST_SESSION_POLICY, PUBLIC_LINK_SESSION_BOUNDS, publicLinkSessionPolicy, WebSessionStore, localSessionPolicy, guestSessionPolicy } from "../src/web-session.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { prepareSettingsEffect } from "../src/settings-effect.js";
import { parseWebSettingsBody } from "../src/web-settings-patch.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import { SettingsConfirmationStore } from "../src/settings-confirmation.js";
import { SettingsHttpConfirmation } from "../src/settings-http-confirmation.js";
import { SettingsBaselines } from "../src/settings-baseline.js";
import { handleSettingsRequest, type SettingsApiContext } from "../src/settings-api.js";
import { noteSettingsWrite } from "../src/settings-transaction.js";

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } }),
  rotateLogIfNeeded: () => { throw new Error("log rotation is outside this harness"); },
  rotateLogIfNeededAsync: async () => { throw new Error("log rotation is outside this harness"); },
}));

const H = 3_600_000, M = 60_000, HOST = "agend.example.com";
const roots: string[] = [], stores: SettingsConfirmationStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 5 }); });

describe("the policy (publicLinkSessionPolicy)", () => {
  it("defaults unchanged: 8 h / 30 min, on either kind of link", () => {
    expect(DEFAULT_SESSION_POLICY.gateway).toEqual({ absoluteMs: 8 * H, idleMs: 30 * M });
    expect(publicLinkSessionPolicy(undefined, true)).toEqual({ absoluteMs: 8 * H, idleMs: 30 * M });
    expect(publicLinkSessionPolicy(undefined, false)).toEqual({ absoluteMs: 8 * H, idleMs: 30 * M });
  });
  it("named tunnel: the configured values, up to the caps (7 days, 24 h unused)", () => {
    expect(PUBLIC_LINK_SESSION_BOUNDS).toEqual({ idleMinutes: { min: 5, max: 1440 }, absoluteHours: { min: 1, max: 168 } });
    expect(publicLinkSessionPolicy({ idle_minutes: 240, absolute_hours: 72 }, true)).toEqual({ absoluteMs: 72 * H, idleMs: 240 * M });
    expect(publicLinkSessionPolicy({ idle_minutes: 1440, absolute_hours: 168 }, true)).toEqual({ absoluteMs: 168 * H, idleMs: 1440 * M });
  });
  it("defensive like the local policy: above the cap or not a number is the default, below the minimum is the minimum, idle cut to absolute", () => {
    expect(publicLinkSessionPolicy({ idle_minutes: 1441, absolute_hours: 169 }, true)).toEqual({ absoluteMs: 8 * H, idleMs: 30 * M });
    expect(publicLinkSessionPolicy({ idle_minutes: "600" as unknown as number, absolute_hours: NaN }, true)).toEqual({ absoluteMs: 8 * H, idleMs: 30 * M });
    expect(publicLinkSessionPolicy({ idle_minutes: 1, absolute_hours: 0.25 }, true)).toEqual({ absoluteMs: 1 * H, idleMs: 5 * M });
    expect(publicLinkSessionPolicy({ idle_minutes: 600, absolute_hours: 2 }, true)).toEqual({ absoluteMs: 2 * H, idleMs: 2 * H });
  });
  it("quick tunnel: values can only shorten the defaults, never lengthen them", () => {
    expect(publicLinkSessionPolicy({ idle_minutes: 600, absolute_hours: 72 }, false)).toEqual({ absoluteMs: 8 * H, idleMs: 30 * M });
    expect(publicLinkSessionPolicy({ idle_minutes: 10, absolute_hours: 2 }, false)).toEqual({ absoluteMs: 2 * H, idleMs: 10 * M });
    expect(publicLinkSessionPolicy({ idle_minutes: 600, absolute_hours: 2 }, false)).toEqual({ absoluteMs: 2 * H, idleMs: 30 * M });
  });
});

describe("the store: the public link's policy in force, never longer than the account's own", () => {
  const store = (pl: Parameters<typeof publicLinkSessionPolicy>[0], named: boolean, local?: { absolute_hours?: number; idle_hours?: number }, guest?: { absolute_hours?: number; idle_minutes?: number }) =>
    new WebSessionStore({ gatewayPolicy: () => publicLinkSessionPolicy(pl, named), localPolicy: () => localSessionPolicy(local), guestPolicy: () => guestSessionPolicy(guest) });
  it("an admin on a named tunnel gets the configured idle window; on a quick tunnel 30 min", () => {
    expect(store({ idle_minutes: 240 }, true).idleWindowMs("gateway", "admin")).toBe(240 * M);
    expect(store({ idle_minutes: 240 }, false).idleWindowMs("gateway", "admin")).toBe(30 * M);
    expect(store(undefined, true).idleWindowMs("gateway", "admin")).toBe(30 * M);
  });
  it("an admin's never outlasts web.session.local; a guest's never outlasts web.guests.session", () => {
    expect(store({ idle_minutes: 1440, absolute_hours: 168 }, true, { absolute_hours: 6, idle_hours: 2 }).idleWindowMs("gateway", "admin")).toBe(2 * H);
    expect(store({ idle_minutes: 1440, absolute_hours: 168 }, true).idleWindowMs("gateway", "guest")).toBe(GUEST_SESSION_POLICY.idleMs);
    expect(store({ idle_minutes: 1440, absolute_hours: 168 }, true, undefined, { idle_minutes: 60 }).idleWindowMs("gateway", "guest")).toBe(60 * M);
    // …and the local surface is untouched by the public link's values.
    expect(store({ idle_minutes: 5 }, true).idleWindowMs("local", "admin")).toBe(DEFAULT_SESSION_POLICY.local.idleMs);
  });
  it("a new admin session over a named tunnel ends at the configured absolute limit (capped by the local one)", () => {
    let now = 1_000_000;
    const s = new WebSessionStore({ now: () => now, gatewayPolicy: () => publicLinkSessionPolicy({ absolute_hours: 72, idle_minutes: 1440 }, true), localPolicy: () => localSessionPolicy({ absolute_hours: 96, idle_hours: 96 }) });
    const { record } = s.create({ tier: "admin", surface: "gateway", label: "phone", tokenEpoch: "e".repeat(64), exposureId: "a".repeat(32) });
    expect([record.absoluteExpiry - now, record.idleExpiry - now]).toEqual([72 * H, 24 * H]);
    const capped = new WebSessionStore({ now: () => now, gatewayPolicy: () => publicLinkSessionPolicy({ absolute_hours: 72, idle_minutes: 1440 }, true) });
    const r2 = capped.create({ tier: "admin", surface: "gateway", label: "phone", tokenEpoch: "e".repeat(64), exposureId: "a".repeat(32) }).record;
    expect([r2.absoluteExpiry - now, r2.idleExpiry - now]).toEqual([48 * H, 24 * H]);   // the local default, 48 h
  });
});

describe("the validator", () => {
  const v = (web: Record<string, unknown>) => validateFleetConfig({ defaults: {}, instances: {}, web });
  const at = (r: ReturnType<typeof v>, kind: "errors" | "warnings") => r[kind].filter(e => e.path.startsWith("web.session")).map(e => e.path);
  it("the keys are known; the caps are errors", () => {
    expect(at(v({ session: { public_link: { idle_minutes: 1440, absolute_hours: 168 } }, public_link: { hostname: HOST } }), "errors")).toEqual([]);
    expect(at(v({ session: { public_link: { idle_minutes: 1441 } } }), "errors")).toEqual(["web.session.public_link.idle_minutes"]);
    expect(at(v({ session: { public_link: { idle_minutes: 4 } } }), "errors")).toEqual(["web.session.public_link.idle_minutes"]);
    expect(at(v({ session: { public_link: { absolute_hours: 169 } } }), "errors")).toEqual(["web.session.public_link.absolute_hours"]);
    expect(at(v({ session: { public_link: { absolute_hours: 0.5 } } }), "errors")).toEqual(["web.session.public_link.absolute_hours"]);
    expect(at(v({ session: { public_link: { idle: 60 } } }), "errors")).toEqual(["web.session.public_link.idle"]);
    expect(at(v({ session: { gateway: {} } }), "errors")).toEqual(["web.session.gateway"]);
  });
  it("idle never above absolute (the default 8 h when it is left out)", () => {
    expect(at(v({ session: { public_link: { idle_minutes: 481 } }, public_link: { hostname: HOST } }), "errors")).toEqual(["web.session.public_link.idle_minutes"]);
    expect(at(v({ session: { public_link: { idle_minutes: 600, absolute_hours: 2 } }, public_link: { hostname: HOST } }), "errors")).toEqual(["web.session.public_link.idle_minutes"]);
    expect(at(v({ session: { public_link: { idle_minutes: 480 } }, public_link: { hostname: HOST } }), "errors")).toEqual([]);
  });
  it("longer than 8 h / 30 min without a fixed hostname: a warning that says what applies; shorter or named: none", () => {
    const quick = v({ session: { public_link: { idle_minutes: 240, absolute_hours: 24 } } });
    expect([at(quick, "errors"), at(quick, "warnings")]).toEqual([[], ["web.session.public_link"]]);
    expect(quick.warnings.find(w => w.path === "web.session.public_link")!.message).toContain("web.public_link.hostname");
    expect(at(v({ session: { public_link: { idle_minutes: 10, absolute_hours: 2 } } }), "warnings")).toEqual([]);
    expect(at(v({ session: { public_link: { idle_minutes: 240, absolute_hours: 24 } }, public_link: { hostname: HOST } }), "warnings")).toEqual([]);
  });
});

const WEB = "/api/settings/fleet/web";
const judge = (body: unknown, fleet: Record<string, unknown> = {}) =>
  prepareSettingsEffect("PUT", WEB, body, { config: { defaults: {}, instances: {}, ...fleet } as any, classic: {} }).diff;
const named = { public_link: { hostname: HOST } };

describe("Settings: lengthening is confirmed, shortening applies at once", () => {
  it("the body takes session.public_link beside session.local; nothing else", () => {
    const p = parseWebSettingsBody({ session: { local: { idle_hours: 2 }, public_link: { idle_minutes: 60, absolute_hours: null } } });
    expect("error" in p ? p : [p.session, p.publicLinkSession]).toEqual([{ idle_hours: 2 }, { idle_minutes: 60, absolute_hours: null }]);
    for (const body of [{ session: { public_link: { idle_hours: 1 } } }, { session: { public_link: { idle_minutes: "60" } } }, { session: { public_link: [] } }, { session: { gateway: { idle_minutes: 60 } } }])
      expect("error" in parseWebSettingsBody(body), JSON.stringify(body)).toBe(true);
  });
  it("shorter applies directly", () => {
    expect(judge({ session: { public_link: { idle_minutes: 10 } } }, { web: named })).toBeNull();
    expect(judge({ session: { public_link: { absolute_hours: 2 } } }, { web: named })).toBeNull();
    expect(judge({ session: { public_link: { idle_minutes: 60 } } }, { web: { ...named, session: { public_link: { idle_minutes: 240 } } } })).toBeNull();
  });
  it("longer waits for a General admin, each loosening named, in the access section — even on a quick tunnel (a hostname added later lets it apply)", () => {
    for (const fleet of [{ web: named }, {}]) {
      const diff = judge({ session: { public_link: { idle_minutes: 240, absolute_hours: 24 } } }, fleet);
      expect([diff?.section, diff?.summary.slice(1)]).toEqual(["access", ["fleet.web.session.public\\_link.idle\\_minutes: default → 240", "fleet.web.session.public\\_link.absolute\\_hours: default → 24"]]);
    }
    expect(judge({ session: { public_link: { idle_minutes: null } } }, { web: { ...named, session: { public_link: { idle_minutes: 10 } } } })?.summary.slice(1))
      .toEqual(["fleet.web.session.public\\_link.idle\\_minutes: 10 → default"]);
  });
  it("what the validator refuses is refused before anything is proposed: the caps, idle above absolute", () => {
    for (const body of [{ session: { public_link: { idle_minutes: 1441 } } }, { session: { public_link: { absolute_hours: 169 } } }, { session: { public_link: { idle_minutes: 600, absolute_hours: 2 } } }])
      expect(() => judge(body, { web: named }), JSON.stringify(body)).toThrow("invalid_settings_effect");
  });
  it("the schema says both apply now", () => {
    const impacts = buildSettingsImpactSchema().impacts;
    expect([impacts["web.session.public_link.absolute_hours"], impacts["web.session.public_link.idle_minutes"]]).toEqual(["now", "now"]);
  });
});

function harness(fleet: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "agend-test-3708-")); roots.push(root);
  const path = join(root, "fleet.yaml");
  const config: any = { defaults: {}, instances: {}, ...structuredClone(fleet) };
  writeFileSync(path, yaml.dump(config));
  let revision = 0;
  const save = vi.fn(() => { noteSettingsWrite(path, yaml.load(readFileSync(path, "utf8")), config); writeFileSync(path, yaml.dump(config)); revision++; });
  const ctx = { fleetConfig: config, dataDir: root, configPath: path, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRawFleetConfig: () => config, saveFleetConfig: save, lifecycle: { isPaused: () => false, pause: vi.fn(), wake: vi.fn() } } as unknown as SettingsApiContext;
  const store = new SettingsConfirmationStore({ audit: vi.fn() }); stores.push(store);
  const baselines = new SettingsBaselines({ dataDir: root, configPath: () => path, config: () => config, current: () => revision });
  const gate = new SettingsHttpConfirmation(store, {
    principal: req => req.headers.cookie ? { id: "session-a", label: "browser", source: "web_session", current: () => true } : null,
    baseline: () => baselines.read(), snapshot: () => baselines.snapshot(),
  });
  async function request(body: unknown, opts: { direct?: boolean; key?: string } = {}) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = new EventEmitter() as any;
      req.method = "PUT"; req.url = WEB; req.headers = { "idempotency-key": opts.key ?? "k-1", cookie: "opaque" }; req.destroy = () => undefined;
      let status = 0;
      const res = { headersSent: false, destroyed: false, writeHead(code: number) { status = code; this.headersSent = true; }, setHeader: vi.fn(),
        end(text: string) { resolve({ status, body: JSON.parse(text) }); } } as any;
      const next = (r: any, s: any, u: URL) => handleSettingsRequest(r, s, u, ctx);
      const url = new URL(WEB, "http://localhost");
      try { expect(opts.direct ? next(req, res, url) : gate.handle(req, res, url, next)).toBe(true);
        queueMicrotask(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }); }
      catch (err) { reject(err); }
    });
  }
  return { config, save, store, request, raw: () => yaml.load(readFileSync(path, "utf8")) as any };
}

describe("through the gate and the real handler", () => {
  it("shorter is written at once, beside the local limits", async () => {
    const h = harness({ web: { ...named, session: { local: { absolute_hours: 24 } } } });
    expect((await h.request({ session: { public_link: { idle_minutes: 15 } } })).status).toBe(200);
    expect(h.raw().web.session).toEqual({ local: { absolute_hours: 24 }, public_link: { idle_minutes: 15 } });
    expect(h.config.web.session.public_link.idle_minutes).toBe(15);
  });
  it("longer is proposed, written only when a General admin confirms it", async () => {
    const h = harness({ web: named });
    const r = await h.request({ session: { public_link: { idle_minutes: 240, absolute_hours: 72 } } });
    expect([r.status, r.body.result]).toEqual([202, "pending_confirmation"]);
    expect(h.save).not.toHaveBeenCalled();
    expect((await h.store.decide(r.body.pending_change.id, "confirm", { label: "F", current: () => true })).state).toBe("applied");
    expect(h.raw().web.session.public_link).toEqual({ absolute_hours: 72, idle_minutes: 240 });
  });
  it("null removes a key; the last one removes public_link and leaves local", async () => {
    const h = harness({ web: { ...named, session: { local: { idle_hours: 2 }, public_link: { idle_minutes: 60 } } } });
    expect((await h.request({ session: { public_link: { idle_minutes: null } } }, { direct: true })).status).toBe(200);
    expect(h.raw().web.session).toEqual({ local: { idle_hours: 2 } });
  });
  it("the handler refuses the caps without writing", async () => {
    const h = harness({ web: named });
    expect((await h.request({ session: { public_link: { absolute_hours: 200 } } }, { direct: true })).status).toBe(400);
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe("Settings page words (EN, zh-TW) and SKEW", () => {
  const UI = join(__dirname, "../src/ui"), FILE = "settings-public-session-strings.js";
  const text = readFileSync(join(UI, FILE), "utf8");
  const block = (lang: string) => { const m = new RegExp(`${lang === "en" ? "  en" : '  "zh-TW"'}: \\{([\\s\\S]*?)\\n  \\}`).exec(text)!; return [...m[1]!.matchAll(/^\s+(\w+):/gm)].map(x => x[1]); };
  it("every word in both languages, the same keys", () => {
    expect(block("en").length).toBeGreaterThan(8);
    expect(block("zh-TW")).toEqual(block("en"));
  });
  it("the ⓘ states the trade-off plainly; the quick-tunnel note says why; zh-TW uses the page's own labels", () => {
    expect(text).toContain("whoever holds it can act as you until the session ends");
    expect(text).toContain("needs a fixed hostname");
    expect(text).toContain("拿到它的人在工作階段結束前都能以你的身分操作");
    expect(text).toMatch(/登入時效/); expect(text).toMatch(/閒置後登出/);
  });
  it("SKEW: a file of its own (new in 2.4.0-alpha.2, so no tab holds an old copy); its keys live nowhere else; every reader imports it", () => {
    for (const other of ["settings-strings.js", "settings-layout.js", "settings-access-strings.js"]) {
      const o = readFileSync(join(UI, other), "utf8");
      for (const k of block("en")) expect(new RegExp(`\\b${k}:`).test(o), `${other} ${k}`).toBe(false);
    }
    for (const reader of ["panel-settings.js", "settings-registry.js", "search-dialog.js"])
      expect(readFileSync(join(UI, reader), "utf8"), reader).toContain(`import "./${FILE}"`);
    expect(existsSync(join(UI, FILE))).toBe(true);
  });
});
